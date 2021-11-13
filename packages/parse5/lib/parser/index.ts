import { Tokenizer } from '../tokenizer/index.js';
import { OpenElementStack } from './open-element-stack.js';
import { FormattingElementList, ElementEntry } from './formatting-element-list.js';
import { LocationInfoParserMixin } from '../extensions/location-info/parser-mixin.js';
import { ErrorReportingParserMixin } from '../extensions/error-reporting/parser-mixin.js';
import { Mixin } from '../utils/mixin.js';
import * as defaultTreeAdapter from '../tree-adapters/default.js';
import * as doctype from '../common/doctype.js';
import * as foreignContent from '../common/foreign-content.js';
import { ERR } from '../common/error-codes.js';
import * as unicode from '../common/unicode.js';
import * as HTML from '../common/html.js';
import type { TreeAdapter, TreeAdapterTypeMap } from './../tree-adapters/interface';
import type { ParserError } from './../extensions/error-reporting/mixin-base';
import { Token, CommentToken, CharacterToken, TagToken, DoctypeToken, EOFToken } from './../common/token';

//Aliases
const $ = HTML.TAG_NAMES;
const NS = HTML.NAMESPACES;
const { ATTRS } = HTML;

//Misc constants
const HIDDEN_INPUT_TYPE = 'hidden';

//Adoption agency loops iteration count
const AA_OUTER_LOOP_ITER = 8;
const AA_INNER_LOOP_ITER = 3;

//Insertion modes
enum InsertionMode {
    INITIAL = 'INITIAL_MODE',
    BEFORE_HTML = 'BEFORE_HTML_MODE',
    BEFORE_HEAD = 'BEFORE_HEAD_MODE',
    IN_HEAD = 'IN_HEAD_MODE',
    IN_HEAD_NO_SCRIPT = 'IN_HEAD_NO_SCRIPT_MODE',
    AFTER_HEAD = 'AFTER_HEAD_MODE',
    IN_BODY = 'IN_BODY_MODE',
    TEXT = 'TEXT_MODE',
    IN_TABLE = 'IN_TABLE_MODE',
    IN_TABLE_TEXT = 'IN_TABLE_TEXT_MODE',
    IN_CAPTION = 'IN_CAPTION_MODE',
    IN_COLUMN_GROUP = 'IN_COLUMN_GROUP_MODE',
    IN_TABLE_BODY = 'IN_TABLE_BODY_MODE',
    IN_ROW = 'IN_ROW_MODE',
    IN_CELL = 'IN_CELL_MODE',
    IN_SELECT = 'IN_SELECT_MODE',
    IN_SELECT_IN_TABLE = 'IN_SELECT_IN_TABLE_MODE',
    IN_TEMPLATE = 'IN_TEMPLATE_MODE',
    AFTER_BODY = 'AFTER_BODY_MODE',
    IN_FRAMESET = 'IN_FRAMESET_MODE',
    AFTER_FRAMESET = 'AFTER_FRAMESET_MODE',
    AFTER_AFTER_BODY = 'AFTER_AFTER_BODY_MODE',
    AFTER_AFTER_FRAMESET = 'AFTER_AFTER_FRAMESET_MODE',
}

//Insertion mode reset map
const INSERTION_MODE_RESET_MAP = new Map([
    [$.TR, InsertionMode.IN_ROW],
    [$.TBODY, InsertionMode.IN_TABLE_BODY],
    [$.THEAD, InsertionMode.IN_TABLE_BODY],
    [$.TFOOT, InsertionMode.IN_TABLE_BODY],
    [$.CAPTION, InsertionMode.IN_CAPTION],
    [$.COLGROUP, InsertionMode.IN_COLUMN_GROUP],
    [$.TABLE, InsertionMode.IN_TABLE],
    [$.BODY, InsertionMode.IN_BODY],
    [$.FRAMESET, InsertionMode.IN_FRAMESET],
]);

//Template insertion mode switch map
const TEMPLATE_INSERTION_MODE_SWITCH_MAP = new Map<string, InsertionMode>([
    [$.CAPTION, InsertionMode.IN_TABLE],
    [$.COLGROUP, InsertionMode.IN_TABLE],
    [$.TBODY, InsertionMode.IN_TABLE],
    [$.TFOOT, InsertionMode.IN_TABLE],
    [$.THEAD, InsertionMode.IN_TABLE],
    [$.COL, InsertionMode.IN_COLUMN_GROUP],
    [$.TR, InsertionMode.IN_TABLE_BODY],
    [$.TD, InsertionMode.IN_ROW],
    [$.TH, InsertionMode.IN_ROW],
]);

//Token handlers map for insertion modes
const TOKEN_HANDLERS = new Map<
    InsertionMode,
    {
        [Tokenizer.CHARACTER_TOKEN]: (p: Parser<any>, token: CharacterToken) => void;
        [Tokenizer.NULL_CHARACTER_TOKEN]: (p: Parser<any>, token: CharacterToken) => void;
        [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: (p: Parser<any>, token: CharacterToken) => void;
        [Tokenizer.COMMENT_TOKEN]: (p: Parser<any>, token: CommentToken) => void;
        [Tokenizer.DOCTYPE_TOKEN]: (p: Parser<any>, token: DoctypeToken) => void;
        [Tokenizer.START_TAG_TOKEN]: (p: Parser<any>, token: TagToken) => void;
        [Tokenizer.END_TAG_TOKEN]: (p: Parser<any>, token: TagToken) => void;
        [Tokenizer.EOF_TOKEN]: (p: Parser<any>, token: EOFToken) => void;
    }
>([
    [
        InsertionMode.INITIAL,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenInInitialMode,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenInInitialMode,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: doctypeInInitialMode,
            [Tokenizer.START_TAG_TOKEN]: tokenInInitialMode,
            [Tokenizer.END_TAG_TOKEN]: tokenInInitialMode,
            [Tokenizer.EOF_TOKEN]: tokenInInitialMode,
        },
    ],
    [
        InsertionMode.BEFORE_HTML,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenBeforeHtml,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenBeforeHtml,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagBeforeHtml,
            [Tokenizer.END_TAG_TOKEN]: endTagBeforeHtml,
            [Tokenizer.EOF_TOKEN]: tokenBeforeHtml,
        },
    ],
    [
        InsertionMode.BEFORE_HEAD,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenBeforeHead,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenBeforeHead,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: misplacedDoctype,
            [Tokenizer.START_TAG_TOKEN]: startTagBeforeHead,
            [Tokenizer.END_TAG_TOKEN]: endTagBeforeHead,
            [Tokenizer.EOF_TOKEN]: tokenBeforeHead,
        },
    ],
    [
        InsertionMode.IN_HEAD,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenInHead,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenInHead,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: misplacedDoctype,
            [Tokenizer.START_TAG_TOKEN]: startTagInHead,
            [Tokenizer.END_TAG_TOKEN]: endTagInHead,
            [Tokenizer.EOF_TOKEN]: tokenInHead,
        },
    ],
    [
        InsertionMode.IN_HEAD_NO_SCRIPT,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenInHeadNoScript,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenInHeadNoScript,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: misplacedDoctype,
            [Tokenizer.START_TAG_TOKEN]: startTagInHeadNoScript,
            [Tokenizer.END_TAG_TOKEN]: endTagInHeadNoScript,
            [Tokenizer.EOF_TOKEN]: tokenInHeadNoScript,
        },
    ],
    [
        InsertionMode.AFTER_HEAD,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenAfterHead,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenAfterHead,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: misplacedDoctype,
            [Tokenizer.START_TAG_TOKEN]: startTagAfterHead,
            [Tokenizer.END_TAG_TOKEN]: endTagAfterHead,
            [Tokenizer.EOF_TOKEN]: tokenAfterHead,
        },
    ],
    [
        InsertionMode.IN_BODY,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInBody,
            [Tokenizer.END_TAG_TOKEN]: endTagInBody,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.TEXT,
        {
            [Tokenizer.CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.NULL_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: ignoreToken,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: ignoreToken,
            [Tokenizer.END_TAG_TOKEN]: endTagInText,
            [Tokenizer.EOF_TOKEN]: eofInText,
        },
    ],
    [
        InsertionMode.IN_TABLE,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.NULL_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInTable,
            [Tokenizer.END_TAG_TOKEN]: endTagInTable,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_TABLE_TEXT,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInTableText,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInTableText,
            [Tokenizer.COMMENT_TOKEN]: tokenInTableText,
            [Tokenizer.DOCTYPE_TOKEN]: tokenInTableText,
            [Tokenizer.START_TAG_TOKEN]: tokenInTableText,
            [Tokenizer.END_TAG_TOKEN]: tokenInTableText,
            [Tokenizer.EOF_TOKEN]: tokenInTableText,
        },
    ],
    [
        InsertionMode.IN_CAPTION,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInCaption,
            [Tokenizer.END_TAG_TOKEN]: endTagInCaption,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_COLUMN_GROUP,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenInColumnGroup,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenInColumnGroup,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInColumnGroup,
            [Tokenizer.END_TAG_TOKEN]: endTagInColumnGroup,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_TABLE_BODY,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.NULL_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInTableBody,
            [Tokenizer.END_TAG_TOKEN]: endTagInTableBody,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_ROW,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.NULL_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: characterInTable,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInRow,
            [Tokenizer.END_TAG_TOKEN]: endTagInRow,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_CELL,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInCell,
            [Tokenizer.END_TAG_TOKEN]: endTagInCell,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_SELECT,
        {
            [Tokenizer.CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInSelect,
            [Tokenizer.END_TAG_TOKEN]: endTagInSelect,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_SELECT_IN_TABLE,
        {
            [Tokenizer.CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInSelectInTable,
            [Tokenizer.END_TAG_TOKEN]: endTagInSelectInTable,
            [Tokenizer.EOF_TOKEN]: eofInBody,
        },
    ],
    [
        InsertionMode.IN_TEMPLATE,
        {
            [Tokenizer.CHARACTER_TOKEN]: characterInBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInTemplate,
            [Tokenizer.END_TAG_TOKEN]: endTagInTemplate,
            [Tokenizer.EOF_TOKEN]: eofInTemplate,
        },
    ],
    [
        InsertionMode.AFTER_BODY,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenAfterBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenAfterBody,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendCommentToRootHtmlElement,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagAfterBody,
            [Tokenizer.END_TAG_TOKEN]: endTagAfterBody,
            [Tokenizer.EOF_TOKEN]: stopParsing,
        },
    ],
    [
        InsertionMode.IN_FRAMESET,
        {
            [Tokenizer.CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagInFrameset,
            [Tokenizer.END_TAG_TOKEN]: endTagInFrameset,
            [Tokenizer.EOF_TOKEN]: stopParsing,
        },
    ],
    [
        InsertionMode.AFTER_FRAMESET,
        {
            [Tokenizer.CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: insertCharacters,
            [Tokenizer.COMMENT_TOKEN]: appendComment,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagAfterFrameset,
            [Tokenizer.END_TAG_TOKEN]: endTagAfterFrameset,
            [Tokenizer.EOF_TOKEN]: stopParsing,
        },
    ],
    [
        InsertionMode.AFTER_AFTER_BODY,
        {
            [Tokenizer.CHARACTER_TOKEN]: tokenAfterAfterBody,
            [Tokenizer.NULL_CHARACTER_TOKEN]: tokenAfterAfterBody,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendCommentToDocument,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagAfterAfterBody,
            [Tokenizer.END_TAG_TOKEN]: tokenAfterAfterBody,
            [Tokenizer.EOF_TOKEN]: stopParsing,
        },
    ],
    [
        InsertionMode.AFTER_AFTER_FRAMESET,
        {
            [Tokenizer.CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.NULL_CHARACTER_TOKEN]: ignoreToken,
            [Tokenizer.WHITESPACE_CHARACTER_TOKEN]: whitespaceCharacterInBody,
            [Tokenizer.COMMENT_TOKEN]: appendCommentToDocument,
            [Tokenizer.DOCTYPE_TOKEN]: ignoreToken,
            [Tokenizer.START_TAG_TOKEN]: startTagAfterAfterFrameset,
            [Tokenizer.END_TAG_TOKEN]: ignoreToken,
            [Tokenizer.EOF_TOKEN]: stopParsing,
        },
    ],
]);

const TOKEN_HANDLER_IN_BODY = TOKEN_HANDLERS.get(InsertionMode.IN_BODY);

const TABLE_STRUCTURE_TAGS = new Set<string>([$.TABLE, $.TBODY, $.TFOOT, $.THEAD, $.TR]);

export interface ParserOptions<T extends TreeAdapterTypeMap> {
    /**
     * The [scripting flag](https://html.spec.whatwg.org/multipage/parsing.html#scripting-flag). If set
     * to `true`, `noscript` element content will be parsed as text.
     *
     *  **Default:** `true`
     */
    scriptingEnabled?: boolean | undefined;

    /**
     * Enables source code location information. When enabled, each node (except the root node)
     * will have a `sourceCodeLocation` property. If the node is not an empty element, `sourceCodeLocation` will
     * be a {@link ElementLocation} object, otherwise it will be {@link Location}.
     * If the element was implicitly created by the parser (as part of
     * [tree correction](https://html.spec.whatwg.org/multipage/syntax.html#an-introduction-to-error-handling-and-strange-cases-in-the-parser)),
     * its `sourceCodeLocation` property will be `undefined`.
     *
     * **Default:** `false`
     */
    sourceCodeLocationInfo?: boolean | undefined;

    /**
     * Specifies the resulting tree format.
     *
     * **Default:** `treeAdapters.default`
     */
    treeAdapter?: TreeAdapter<T> | undefined;
}

interface InternalParserOptions<T extends TreeAdapterTypeMap> extends ParserOptions<T> {
    treeAdapter: TreeAdapter<T>;

    onParseError: ((err: ParserError) => void) | null;
}

//Parser
export class Parser<T extends TreeAdapterTypeMap> {
    options: InternalParserOptions<T>;
    treeAdapter: TreeAdapter<T>;
    pendingScript: null | T['element'];

    constructor(options?: ParserOptions<T>) {
        this.options = {
            scriptingEnabled: true,
            sourceCodeLocationInfo: false,
            onParseError: null,
            treeAdapter: defaultTreeAdapter as TreeAdapter<T>,
            ...options,
        };

        this.treeAdapter = this.options.treeAdapter!;
        this.pendingScript = null;

        if (this.options.sourceCodeLocationInfo) {
            Mixin.install(this, LocationInfoParserMixin);
        }

        if (this.options.onParseError) {
            Mixin.install(this, ErrorReportingParserMixin, { onParseError: this.options.onParseError });
        }
    }

    // API
    parse(html: string) {
        const document = this.treeAdapter.createDocument();

        this._bootstrap(document, null);
        this.tokenizer.write(html, true);
        this._runParsingLoop(null);

        return document;
    }

    parseFragment(html: string, fragmentContext?: T['element']) {
        //NOTE: use <template> element as a fragment context if context element was not provided,
        //so we will parse in "forgiving" manner
        if (!fragmentContext) {
            fragmentContext = this.treeAdapter.createElement($.TEMPLATE, NS.HTML, []);
        }

        //NOTE: create fake element which will be used as 'document' for fragment parsing.
        //This is important for jsdom there 'document' can't be recreated, therefore
        //fragment parsing causes messing of the main `document`.
        const documentMock = this.treeAdapter.createElement('documentmock', NS.HTML, []);

        this._bootstrap(documentMock, fragmentContext);

        if (this.treeAdapter.getTagName(fragmentContext) === $.TEMPLATE) {
            this._pushTmplInsertionMode(InsertionMode.IN_TEMPLATE);
        }

        this._initTokenizerForFragmentParsing();
        this._insertFakeRootElement();
        this._resetInsertionMode();
        this._findFormInFragmentContext();
        this.tokenizer.write(html, true);
        this._runParsingLoop(null);

        const rootElement = this.treeAdapter.getFirstChild(documentMock);
        const fragment = this.treeAdapter.createDocumentFragment();

        this._adoptNodes(rootElement, fragment);

        return fragment;
    }

    tokenizer!: Tokenizer;
    stopped = false;
    insertionMode = InsertionMode.INITIAL;
    originalInsertionMode: InsertionMode = '' as any;

    document!: T['document'];
    fragmentContext!: T['element'] | null;

    headElement: null | T['element'] = null;
    formElement: null | T['element'] = null;

    openElements!: OpenElementStack<T>;
    activeFormattingElements!: FormattingElementList<T>;

    tmplInsertionModeStack: InsertionMode[] = [];
    tmplInsertionModeStackTop = -1;
    currentTmplInsertionMode: InsertionMode | null = null;

    pendingCharacterTokens: CharacterToken[] = [];
    hasNonWhitespacePendingCharacterToken = false;

    framesetOk = true;
    skipNextNewLine = false;
    fosterParentingEnabled = false;

    //Bootstrap parser
    _bootstrap(document: T['document'], fragmentContext: T['element'] | null) {
        this.tokenizer = new Tokenizer();

        this.stopped = false;

        this.insertionMode = InsertionMode.INITIAL;
        this.originalInsertionMode = '' as any;

        this.document = document;
        this.fragmentContext = fragmentContext;

        this.headElement = null;
        this.formElement = null;

        this.openElements = new OpenElementStack(this.document, this.treeAdapter);
        this.activeFormattingElements = new FormattingElementList(this.treeAdapter);

        this.tmplInsertionModeStack = [];
        this.tmplInsertionModeStackTop = -1;
        this.currentTmplInsertionMode = null;

        this.pendingCharacterTokens = [];
        this.hasNonWhitespacePendingCharacterToken = false;

        this.framesetOk = true;
        this.skipNextNewLine = false;
        this.fosterParentingEnabled = false;
    }

    //Errors
    _err(_err: ERR, _opts?: { beforeToken: boolean }) {
        // NOTE: err reporting is noop by default. Enabled by mixin.
    }

    //Parsing loop
    _runParsingLoop(scriptHandler: null | ((scriptElement: T['element']) => void)) {
        while (!this.stopped) {
            this._setupTokenizerCDATAMode();

            const token = this.tokenizer.getNextToken();

            if (token.type === Tokenizer.HIBERNATION_TOKEN) {
                break;
            }

            if (this.skipNextNewLine) {
                this.skipNextNewLine = false;

                if (token.type === Tokenizer.WHITESPACE_CHARACTER_TOKEN && token.chars[0] === '\n') {
                    if (token.chars.length === 1) {
                        continue;
                    }

                    token.chars = token.chars.substr(1);
                }
            }

            this._processInputToken(token);

            if (scriptHandler && this.pendingScript) {
                break;
            }
        }
    }

    runParsingLoopForCurrentChunk(
        writeCallback: null | (() => void),
        scriptHandler: (scriptElement: T['element']) => void
    ) {
        this._runParsingLoop(scriptHandler);

        if (scriptHandler && this.pendingScript) {
            const script = this.pendingScript;

            this.pendingScript = null;

            scriptHandler(script);

            return;
        }

        if (writeCallback) {
            writeCallback();
        }
    }

    //Text parsing
    _setupTokenizerCDATAMode() {
        const current = this._getAdjustedCurrentElement();

        this.tokenizer.allowCDATA =
            current &&
            current !== this.document &&
            this.treeAdapter.getNamespaceURI(current) !== NS.HTML &&
            !this._isIntegrationPoint(current);
    }

    _switchToTextParsing(
        currentToken: TagToken,
        nextTokenizerState: typeof Tokenizer.MODE[keyof typeof Tokenizer.MODE]
    ) {
        this._insertElement(currentToken, NS.HTML);
        this.tokenizer.state = nextTokenizerState;
        this.originalInsertionMode = this.insertionMode;
        this.insertionMode = InsertionMode.TEXT;
    }

    switchToPlaintextParsing() {
        this.insertionMode = InsertionMode.TEXT;
        this.originalInsertionMode = InsertionMode.IN_BODY;
        this.tokenizer.state = Tokenizer.MODE.PLAINTEXT;
    }

    //Fragment parsing
    _getAdjustedCurrentElement() {
        return this.openElements.stackTop === 0 && this.fragmentContext
            ? this.fragmentContext
            : this.openElements.current;
    }

    _findFormInFragmentContext() {
        let node = this.fragmentContext;

        do {
            if (this.treeAdapter.getTagName(node) === $.FORM) {
                this.formElement = node;
                break;
            }

            node = this.treeAdapter.getParentNode(node);
        } while (node);
    }

    _initTokenizerForFragmentParsing() {
        if (this.treeAdapter.getNamespaceURI(this.fragmentContext) === NS.HTML) {
            const tn = this.treeAdapter.getTagName(this.fragmentContext);

            switch (tn) {
                case $.TITLE:
                case $.TEXTAREA: {
                    this.tokenizer.state = Tokenizer.MODE.RCDATA;

                    break;
                }
                case $.STYLE:
                case $.XMP:
                case $.IFRAME:
                case $.NOEMBED:
                case $.NOFRAMES:
                case $.NOSCRIPT: {
                    this.tokenizer.state = Tokenizer.MODE.RAWTEXT;

                    break;
                }
                case $.SCRIPT: {
                    this.tokenizer.state = Tokenizer.MODE.SCRIPT_DATA;

                    break;
                }
                case $.PLAINTEXT: {
                    this.tokenizer.state = Tokenizer.MODE.PLAINTEXT;

                    break;
                }
                default:
                // Do nothing
            }
        }
    }

    //Tree mutation
    _setDocumentType(token: DoctypeToken) {
        const name = token.name || '';
        const publicId = token.publicId || '';
        const systemId = token.systemId || '';

        this.treeAdapter.setDocumentType(this.document, name, publicId, systemId);
    }

    _attachElementToTree(element: T['element']) {
        if (this._shouldFosterParentOnInsertion()) {
            this._fosterParentElement(element);
        } else {
            const parent = this.openElements.currentTmplContent || this.openElements.current;

            this.treeAdapter.appendChild(parent, element);
        }
    }

    _appendElement(token: TagToken, namespaceURI: HTML.NAMESPACES) {
        const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);

        this._attachElementToTree(element);
    }

    _insertElement(token: TagToken, namespaceURI: HTML.NAMESPACES) {
        const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);

        this._attachElementToTree(element);
        this.openElements.push(element);
    }

    _insertFakeElement(tagName: string) {
        const element = this.treeAdapter.createElement(tagName, NS.HTML, []);

        this._attachElementToTree(element);
        this.openElements.push(element);
    }

    _insertTemplate(token: TagToken) {
        const tmpl = this.treeAdapter.createElement(token.tagName, NS.HTML, token.attrs);
        const content = this.treeAdapter.createDocumentFragment();

        this.treeAdapter.setTemplateContent(tmpl, content);
        this._attachElementToTree(tmpl);
        this.openElements.push(tmpl);
    }

    _insertFakeRootElement() {
        const element = this.treeAdapter.createElement($.HTML, NS.HTML, []);

        this.treeAdapter.appendChild(this.openElements.current, element);
        this.openElements.push(element);
    }

    _appendCommentNode(token: CommentToken, parent: T['parentNode']) {
        const commentNode = this.treeAdapter.createCommentNode(token.data);

        this.treeAdapter.appendChild(parent, commentNode);
    }

    _insertCharacters(token: CharacterToken) {
        if (this._shouldFosterParentOnInsertion()) {
            this._fosterParentText(token.chars);
        } else {
            const parent = this.openElements.currentTmplContent || this.openElements.current;

            this.treeAdapter.insertText(parent, token.chars);
        }
    }

    _adoptNodes(donor: T['parentNode'], recipient: T['parentNode']) {
        for (let child = this.treeAdapter.getFirstChild(donor); child; child = this.treeAdapter.getFirstChild(donor)) {
            this.treeAdapter.detachNode(child);
            this.treeAdapter.appendChild(recipient, child);
        }
    }

    //Token processing
    _shouldProcessTokenInForeignContent(token: Token) {
        const current = this._getAdjustedCurrentElement();

        if (!current || current === this.document) {
            return false;
        }

        const ns = this.treeAdapter.getNamespaceURI(current);

        if (ns === NS.HTML) {
            return false;
        }

        if (
            this.treeAdapter.getTagName(current) === $.ANNOTATION_XML &&
            ns === NS.MATHML &&
            token.type === Tokenizer.START_TAG_TOKEN &&
            token.tagName === $.SVG
        ) {
            return false;
        }

        const isCharacterToken =
            token.type === Tokenizer.CHARACTER_TOKEN ||
            token.type === Tokenizer.NULL_CHARACTER_TOKEN ||
            token.type === Tokenizer.WHITESPACE_CHARACTER_TOKEN;

        const isMathMLTextStartTag =
            token.type === Tokenizer.START_TAG_TOKEN && token.tagName !== $.MGLYPH && token.tagName !== $.MALIGNMARK;

        if ((isMathMLTextStartTag || isCharacterToken) && this._isIntegrationPoint(current, NS.MATHML)) {
            return false;
        }

        if (
            (token.type === Tokenizer.START_TAG_TOKEN || isCharacterToken) &&
            this._isIntegrationPoint(current, NS.HTML)
        ) {
            return false;
        }

        return token.type !== Tokenizer.EOF_TOKEN;
    }

    _processToken(token: Token) {
        TOKEN_HANDLERS.get(this.insertionMode)[token.type](this, token);
    }

    _processTokenInBodyMode(token: Token) {
        TOKEN_HANDLER_IN_BODY[token.type](this, token);
    }

    _processTokenInForeignContent(token: Token) {
        switch (token.type) {
            case Tokenizer.CHARACTER_TOKEN: {
                characterInForeignContent(this, token);

                break;
            }
            case Tokenizer.NULL_CHARACTER_TOKEN: {
                nullCharacterInForeignContent(this, token);

                break;
            }
            case Tokenizer.WHITESPACE_CHARACTER_TOKEN: {
                insertCharacters(this, token);

                break;
            }
            case Tokenizer.COMMENT_TOKEN: {
                appendComment(this, token);

                break;
            }
            case Tokenizer.START_TAG_TOKEN: {
                startTagInForeignContent(this, token);

                break;
            }
            case Tokenizer.END_TAG_TOKEN: {
                endTagInForeignContent(this, token);

                break;
            }
            default:
            // Do nothing
        }
    }

    _processInputToken(token: Token) {
        if (this._shouldProcessTokenInForeignContent(token)) {
            this._processTokenInForeignContent(token);
        } else {
            this._processToken(token);
        }

        if (token.type === Tokenizer.START_TAG_TOKEN && token.selfClosing && !token.ackSelfClosing) {
            this._err(ERR.nonVoidHtmlElementStartTagWithTrailingSolidus);
        }
    }

    //Integration points
    _isIntegrationPoint(element: T['element'], foreignNS?: HTML.NAMESPACES): boolean {
        const tn = this.treeAdapter.getTagName(element);
        const ns = this.treeAdapter.getNamespaceURI(element);
        const attrs = this.treeAdapter.getAttrList(element);

        return foreignContent.isIntegrationPoint(tn, ns, attrs, foreignNS);
    }

    //Active formatting elements reconstruction
    _reconstructActiveFormattingElements() {
        const listLength = this.activeFormattingElements.length;

        if (listLength) {
            let unopenIdx = listLength;
            let entry = null;

            do {
                unopenIdx--;
                entry = this.activeFormattingElements.entries[unopenIdx];

                if (entry.type === FormattingElementList.MARKER_ENTRY || this.openElements.contains(entry.element)) {
                    unopenIdx++;
                    break;
                }
            } while (unopenIdx > 0);

            for (let i = unopenIdx; i < listLength; i++) {
                entry = this.activeFormattingElements.entries[i];
                this._insertElement(entry.token, this.treeAdapter.getNamespaceURI(entry.element));
                entry.element = this.openElements.current;
            }
        }
    }

    //Close elements
    _closeTableCell() {
        this.openElements.generateImpliedEndTags();
        this.openElements.popUntilTableCellPopped();
        this.activeFormattingElements.clearToLastMarker();
        this.insertionMode = InsertionMode.IN_ROW;
    }

    _closePElement() {
        this.openElements.generateImpliedEndTagsWithExclusion($.P);
        this.openElements.popUntilTagNamePopped($.P);
    }

    //Insertion modes
    _resetInsertionMode() {
        for (let i = this.openElements.stackTop, last = false; i >= 0; i--) {
            let element = this.openElements.items[i];

            if (i === 0) {
                last = true;

                if (this.fragmentContext) {
                    element = this.fragmentContext;
                }
            }

            const tn = this.treeAdapter.getTagName(element);
            const newInsertionMode = INSERTION_MODE_RESET_MAP.get(tn);

            if (newInsertionMode !== undefined) {
                this.insertionMode = newInsertionMode;
                break;
            } else if (!last && (tn === $.TD || tn === $.TH)) {
                this.insertionMode = InsertionMode.IN_CELL;
                break;
            } else if (!last && tn === $.HEAD) {
                this.insertionMode = InsertionMode.IN_HEAD;
                break;
            } else if (tn === $.SELECT) {
                this._resetInsertionModeForSelect(i);
                break;
            } else if (tn === $.TEMPLATE) {
                this.insertionMode = this.currentTmplInsertionMode!;
                break;
            } else if (tn === $.HTML) {
                this.insertionMode = this.headElement ? InsertionMode.AFTER_HEAD : InsertionMode.BEFORE_HEAD;
                break;
            } else if (last) {
                this.insertionMode = InsertionMode.IN_BODY;
                break;
            }
        }
    }

    _resetInsertionModeForSelect(selectIdx) {
        if (selectIdx > 0) {
            for (let i = selectIdx - 1; i > 0; i--) {
                const ancestor = this.openElements.items[i];
                const tn = this.treeAdapter.getTagName(ancestor);

                if (tn === $.TEMPLATE) {
                    break;
                } else if (tn === $.TABLE) {
                    this.insertionMode = InsertionMode.IN_SELECT_IN_TABLE;
                    return;
                }
            }
        }

        this.insertionMode = InsertionMode.IN_SELECT;
    }

    _pushTmplInsertionMode(mode: InsertionMode) {
        this.tmplInsertionModeStack.push(mode);
        this.tmplInsertionModeStackTop++;
        this.currentTmplInsertionMode = mode;
    }

    _popTmplInsertionMode() {
        this.tmplInsertionModeStack.pop();
        this.tmplInsertionModeStackTop--;
        this.currentTmplInsertionMode = this.tmplInsertionModeStack[this.tmplInsertionModeStackTop];
    }

    //Foster parenting
    _isElementCausesFosterParenting(element: T['element']): boolean {
        const tn = this.treeAdapter.getTagName(element);

        return TABLE_STRUCTURE_TAGS.has(tn);
    }

    _shouldFosterParentOnInsertion() {
        return this.fosterParentingEnabled && this._isElementCausesFosterParenting(this.openElements.current);
    }

    _findFosterParentingLocation() {
        const location: { parent: null | T['parentNode']; beforeElement: null | T['node'] } = {
            parent: null,
            beforeElement: null,
        };

        for (let i = this.openElements.stackTop; i >= 0; i--) {
            const openElement = this.openElements.items[i];
            const tn = this.treeAdapter.getTagName(openElement);
            const ns = this.treeAdapter.getNamespaceURI(openElement);

            if (tn === $.TEMPLATE && ns === NS.HTML) {
                location.parent = this.treeAdapter.getTemplateContent(openElement);
                break;
            } else if (tn === $.TABLE) {
                location.parent = this.treeAdapter.getParentNode(openElement);

                if (location.parent) {
                    location.beforeElement = openElement;
                } else {
                    location.parent = this.openElements.items[i - 1];
                }

                break;
            }
        }

        if (!location.parent) {
            location.parent = this.openElements.items[0];
        }

        return location;
    }

    _fosterParentElement(element: T['element']) {
        const location = this._findFosterParentingLocation();

        if (location.beforeElement) {
            this.treeAdapter.insertBefore(location.parent!, element, location.beforeElement);
        } else {
            this.treeAdapter.appendChild(location.parent!, element);
        }
    }

    _fosterParentText(chars: string) {
        const location = this._findFosterParentingLocation();

        if (location.beforeElement) {
            this.treeAdapter.insertTextBefore(location.parent!, chars, location.beforeElement);
        } else {
            this.treeAdapter.insertText(location.parent!, chars);
        }
    }

    //Special elements
    _isSpecialElement(element: T['element']): boolean {
        const tn = this.treeAdapter.getTagName(element);
        const ns = this.treeAdapter.getNamespaceURI(element);

        return HTML.SPECIAL_ELEMENTS[ns].has(tn);
    }
}

//Adoption agency algorithm
//(see: http://www.whatwg.org/specs/web-apps/current-work/multipage/tree-construction.html#adoptionAgency)
//------------------------------------------------------------------

//Steps 5-8 of the algorithm
function aaObtainFormattingElementEntry<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    let formattingElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName(token.tagName);

    if (formattingElementEntry) {
        if (!p.openElements.contains(formattingElementEntry.element)) {
            p.activeFormattingElements.removeEntry(formattingElementEntry);
            formattingElementEntry = null;
        } else if (!p.openElements.hasInScope(token.tagName)) {
            formattingElementEntry = null;
        }
    } else {
        genericEndTagInBody(p, token);
    }

    return formattingElementEntry;
}

//Steps 9 and 10 of the algorithm
function aaObtainFurthestBlock<T extends TreeAdapterTypeMap>(p: Parser<T>, formattingElementEntry: ElementEntry<T>) {
    let furthestBlock = null;

    for (let i = p.openElements.stackTop; i >= 0; i--) {
        const element = p.openElements.items[i];

        if (element === formattingElementEntry.element) {
            break;
        }

        if (p._isSpecialElement(element)) {
            furthestBlock = element;
        }
    }

    if (!furthestBlock) {
        p.openElements.popUntilElementPopped(formattingElementEntry.element);
        p.activeFormattingElements.removeEntry(formattingElementEntry);
    }

    return furthestBlock;
}

//Step 13 of the algorithm
function aaInnerLoop<T extends TreeAdapterTypeMap>(p: Parser<T>, furthestBlock, formattingElement) {
    let lastElement = furthestBlock;
    let nextElement = p.openElements.getCommonAncestor(furthestBlock);

    for (let i = 0, element = nextElement; element !== formattingElement; i++, element = nextElement) {
        //NOTE: store next element for the next loop iteration (it may be deleted from the stack by step 9.5)
        nextElement = p.openElements.getCommonAncestor(element);

        const elementEntry = p.activeFormattingElements.getElementEntry(element);
        const counterOverflow = elementEntry && i >= AA_INNER_LOOP_ITER;
        const shouldRemoveFromOpenElements = !elementEntry || counterOverflow;

        if (shouldRemoveFromOpenElements) {
            if (counterOverflow) {
                p.activeFormattingElements.removeEntry(elementEntry);
            }

            p.openElements.remove(element);
        } else {
            element = aaRecreateElementFromEntry(p, elementEntry);

            if (lastElement === furthestBlock) {
                p.activeFormattingElements.bookmark = elementEntry;
            }

            p.treeAdapter.detachNode(lastElement);
            p.treeAdapter.appendChild(element, lastElement);
            lastElement = element;
        }
    }

    return lastElement;
}

//Step 13.7 of the algorithm
function aaRecreateElementFromEntry<T extends TreeAdapterTypeMap>(p: Parser<T>, elementEntry: ElementEntry<T>) {
    const ns = p.treeAdapter.getNamespaceURI(elementEntry.element);
    const newElement = p.treeAdapter.createElement(elementEntry.token.tagName, ns, elementEntry.token.attrs);

    p.openElements.replace(elementEntry.element, newElement);
    elementEntry.element = newElement;

    return newElement;
}

//Step 14 of the algorithm
function aaInsertLastNodeInCommonAncestor<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    commonAncestor: T['parentNode'],
    lastElement: T['element']
) {
    if (p._isElementCausesFosterParenting(commonAncestor)) {
        p._fosterParentElement(lastElement);
    } else {
        const tn = p.treeAdapter.getTagName(commonAncestor);
        const ns = p.treeAdapter.getNamespaceURI(commonAncestor);

        if (tn === $.TEMPLATE && ns === NS.HTML) {
            commonAncestor = p.treeAdapter.getTemplateContent(commonAncestor);
        }

        p.treeAdapter.appendChild(commonAncestor, lastElement);
    }
}

//Steps 15-19 of the algorithm
function aaReplaceFormattingElement<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    furthestBlock: T['parentNode'],
    formattingElementEntry: ElementEntry<T>
) {
    const ns = p.treeAdapter.getNamespaceURI(formattingElementEntry.element);
    const { token } = formattingElementEntry;
    const newElement = p.treeAdapter.createElement(token.tagName, ns, token.attrs);

    p._adoptNodes(furthestBlock, newElement);
    p.treeAdapter.appendChild(furthestBlock, newElement);

    p.activeFormattingElements.insertElementAfterBookmark(newElement, formattingElementEntry.token);
    p.activeFormattingElements.removeEntry(formattingElementEntry);

    p.openElements.remove(formattingElementEntry.element);
    p.openElements.insertAfter(furthestBlock, newElement);
}

//Algorithm entry point
function callAdoptionAgency<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    let formattingElementEntry;

    for (let i = 0; i < AA_OUTER_LOOP_ITER; i++) {
        formattingElementEntry = aaObtainFormattingElementEntry(p, token, formattingElementEntry);

        if (!formattingElementEntry) {
            break;
        }

        const furthestBlock = aaObtainFurthestBlock(p, formattingElementEntry);

        if (!furthestBlock) {
            break;
        }

        p.activeFormattingElements.bookmark = formattingElementEntry;

        const lastElement = aaInnerLoop(p, furthestBlock, formattingElementEntry.element);
        const commonAncestor = p.openElements.getCommonAncestor(formattingElementEntry.element);

        p.treeAdapter.detachNode(lastElement);
        aaInsertLastNodeInCommonAncestor(p, commonAncestor, lastElement);
        aaReplaceFormattingElement(p, furthestBlock, formattingElementEntry);
    }
}

//Generic token handlers
//------------------------------------------------------------------
function ignoreToken() {
    //NOTE: do nothing =)
}

function misplacedDoctype<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    p._err(ERR.misplacedDoctype);
}

function appendComment<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken) {
    p._appendCommentNode(token, p.openElements.currentTmplContent || p.openElements.current);
}

function appendCommentToRootHtmlElement<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken) {
    p._appendCommentNode(token, p.openElements.items[0]);
}

function appendCommentToDocument<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken) {
    p._appendCommentNode(token, p.document);
}

function insertCharacters<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p._insertCharacters(token);
}

function stopParsing<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    p.stopped = true;
}

// The "initial" insertion mode
//------------------------------------------------------------------
function doctypeInInitialMode<T extends TreeAdapterTypeMap>(p: Parser<T>, token: DoctypeToken) {
    p._setDocumentType(token);

    const mode = token.forceQuirks ? HTML.DOCUMENT_MODE.QUIRKS : doctype.getDocumentMode(token);

    if (!doctype.isConforming(token)) {
        p._err(ERR.nonConformingDoctype);
    }

    p.treeAdapter.setDocumentMode(p.document, mode);

    p.insertionMode = InsertionMode.BEFORE_HTML;
}

function tokenInInitialMode<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p._err(ERR.missingDoctype, { beforeToken: true });
    p.treeAdapter.setDocumentMode(p.document, HTML.DOCUMENT_MODE.QUIRKS);
    p.insertionMode = InsertionMode.BEFORE_HTML;
    p._processToken(token);
}

// The "before html" insertion mode
//------------------------------------------------------------------
function startTagBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.HTML) {
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.BEFORE_HEAD;
    } else {
        tokenBeforeHtml(p, token);
    }
}

function endTagBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.HTML || tn === $.HEAD || tn === $.BODY || tn === $.BR) {
        tokenBeforeHtml(p, token);
    }
}

function tokenBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p._insertFakeRootElement();
    p.insertionMode = InsertionMode.BEFORE_HEAD;
    p._processToken(token);
}

// The "before head" insertion mode
//------------------------------------------------------------------
function startTagBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.HTML) {
        startTagInBody(p, token);
    } else if (tn === $.HEAD) {
        p._insertElement(token, NS.HTML);
        p.headElement = p.openElements.current;
        p.insertionMode = InsertionMode.IN_HEAD;
    } else {
        tokenBeforeHead(p, token);
    }
}

function endTagBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.HEAD || tn === $.BODY || tn === $.HTML || tn === $.BR) {
        tokenBeforeHead(p, token);
    } else {
        p._err(ERR.endTagWithoutMatchingOpenElement);
    }
}

function tokenBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p._insertFakeElement($.HEAD);
    p.headElement = p.openElements.current;
    p.insertionMode = InsertionMode.IN_HEAD;
    p._processToken(token);
}

// The "in head" insertion mode
//------------------------------------------------------------------
function startTagInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.BASE:
        case $.BASEFONT:
        case $.BGSOUND:
        case $.LINK:
        case $.META: {
            p._appendElement(token, NS.HTML);
            token.ackSelfClosing = true;

            break;
        }
        case $.TITLE: {
            p._switchToTextParsing(token, Tokenizer.MODE.RCDATA);

            break;
        }
        case $.NOSCRIPT: {
            if (p.options.scriptingEnabled) {
                p._switchToTextParsing(token, Tokenizer.MODE.RAWTEXT);
            } else {
                p._insertElement(token, NS.HTML);
                p.insertionMode = InsertionMode.IN_HEAD_NO_SCRIPT;
            }

            break;
        }
        case $.NOFRAMES:
        case $.STYLE: {
            p._switchToTextParsing(token, Tokenizer.MODE.RAWTEXT);

            break;
        }
        case $.SCRIPT: {
            p._switchToTextParsing(token, Tokenizer.MODE.SCRIPT_DATA);

            break;
        }
        case $.TEMPLATE: {
            p._insertTemplate(token);
            p.activeFormattingElements.insertMarker();
            p.framesetOk = false;
            p.insertionMode = InsertionMode.IN_TEMPLATE;
            p._pushTmplInsertionMode(InsertionMode.IN_TEMPLATE);

            break;
        }
        case $.HEAD: {
            p._err(ERR.misplacedStartTagForHeadElement);

            break;
        }
        default: {
            tokenInHead(p, token);
        }
    }
}

function endTagInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HEAD: {
            p.openElements.pop();
            p.insertionMode = InsertionMode.AFTER_HEAD;

            break;
        }
        case $.BODY:
        case $.BR:
        case $.HTML: {
            tokenInHead(p, token);

            break;
        }
        case $.TEMPLATE: {
            if (p.openElements.tmplCount > 0) {
                p.openElements.generateImpliedEndTagsThoroughly();

                if (p.openElements.currentTagName !== $.TEMPLATE) {
                    p._err(ERR.closingOfElementWithOpenChildElements);
                }

                p.openElements.popUntilTagNamePopped($.TEMPLATE);
                p.activeFormattingElements.clearToLastMarker();
                p._popTmplInsertionMode();
                p._resetInsertionMode();
            } else {
                p._err(ERR.endTagWithoutMatchingOpenElement);
            }

            break;
        }
        default: {
            p._err(ERR.endTagWithoutMatchingOpenElement);
        }
    }
}

function tokenInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p.openElements.pop();
    p.insertionMode = InsertionMode.AFTER_HEAD;
    p._processToken(token);
}

// The "in head no script" insertion mode
//------------------------------------------------------------------
function startTagInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.BASEFONT:
        case $.BGSOUND:
        case $.HEAD:
        case $.LINK:
        case $.META:
        case $.NOFRAMES:
        case $.STYLE: {
            startTagInHead(p, token);

            break;
        }
        case $.NOSCRIPT: {
            p._err(ERR.nestedNoscriptInHead);

            break;
        }
        default: {
            tokenInHeadNoScript(p, token);
        }
    }
}

function endTagInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.NOSCRIPT) {
        p.openElements.pop();
        p.insertionMode = InsertionMode.IN_HEAD;
    } else if (tn === $.BR) {
        tokenInHeadNoScript(p, token);
    } else {
        p._err(ERR.endTagWithoutMatchingOpenElement);
    }
}

function tokenInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    const errCode =
        token.type === Tokenizer.EOF_TOKEN ? ERR.openElementsLeftAfterEof : ERR.disallowedContentInNoscriptInHead;

    p._err(errCode);
    p.openElements.pop();
    p.insertionMode = InsertionMode.IN_HEAD;
    p._processToken(token);
}

// The "after head" insertion mode
//------------------------------------------------------------------
const ABANDONED_HEAD_ELEMENT_CHILDS = new Set<string>([
    $.BASE,
    $.BASEFONT,
    $.BGSOUND,
    $.LINK,
    $.META,
    $.NOFRAMES,
    $.SCRIPT,
    $.STYLE,
    $.TEMPLATE,
    $.TITLE,
]);

function startTagAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.BODY: {
            p._insertElement(token, NS.HTML);
            p.framesetOk = false;
            p.insertionMode = InsertionMode.IN_BODY;

            break;
        }
        case $.FRAMESET: {
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.IN_FRAMESET;

            break;
        }
        default:
            if (ABANDONED_HEAD_ELEMENT_CHILDS.has(tn)) {
                p._err(ERR.abandonedHeadElementChild);
                p.openElements.push(p.headElement!);
                startTagInHead(p, token);
                p.openElements.remove(p.headElement!);
            } else if (tn === $.HEAD) {
                p._err(ERR.misplacedStartTagForHeadElement);
            } else {
                tokenAfterHead(p, token);
            }
    }
}

function endTagAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.BODY || tn === $.HTML || tn === $.BR) {
        tokenAfterHead(p, token);
    } else if (tn === $.TEMPLATE) {
        endTagInHead(p, token);
    } else {
        p._err(ERR.endTagWithoutMatchingOpenElement);
    }
}

function tokenAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p._insertFakeElement($.BODY);
    p.insertionMode = InsertionMode.IN_BODY;
    p._processToken(token);
}

// The "in body" insertion mode
//------------------------------------------------------------------
function whitespaceCharacterInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p._reconstructActiveFormattingElements();
    p._insertCharacters(token);
}

function characterInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p._reconstructActiveFormattingElements();
    p._insertCharacters(token);
    p.framesetOk = false;
}

function htmlStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.tmplCount === 0) {
        p.treeAdapter.adoptAttributes(p.openElements.items[0], token.attrs);
    }
}

function bodyStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();

    if (bodyElement && p.openElements.tmplCount === 0) {
        p.framesetOk = false;
        p.treeAdapter.adoptAttributes(bodyElement, token.attrs);
    }
}

function framesetStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();

    if (p.framesetOk && bodyElement) {
        p.treeAdapter.detachNode(bodyElement);
        p.openElements.popAllUpToHtmlElement();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_FRAMESET;
    }
}

function addressStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
}

function numberedHeaderStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    const tn = p.openElements.currentTagName!;

    if (NUMBERED_HEADERS.has(tn)) {
        p.openElements.pop();
    }

    p._insertElement(token, NS.HTML);
}

function preStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
    //on to the next one. (Newlines at the start of pre blocks are ignored as an authoring convenience.)
    p.skipNextNewLine = true;
    p.framesetOk = false;
}

function formStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const inTemplate = p.openElements.tmplCount > 0;

    if (!p.formElement || inTemplate) {
        if (p.openElements.hasInButtonScope($.P)) {
            p._closePElement();
        }

        p._insertElement(token, NS.HTML);

        if (!inTemplate) {
            p.formElement = p.openElements.current;
        }
    }
}

function listItemStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.framesetOk = false;

    const tn = token.tagName;

    for (let i = p.openElements.stackTop; i >= 0; i--) {
        const element = p.openElements.items[i];
        const elementTn = p.treeAdapter.getTagName(element);
        let closeTn = null;

        if (tn === $.LI && elementTn === $.LI) {
            closeTn = $.LI;
        } else if ((tn === $.DD || tn === $.DT) && (elementTn === $.DD || elementTn === $.DT)) {
            closeTn = elementTn;
        }

        if (closeTn) {
            p.openElements.generateImpliedEndTagsWithExclusion(closeTn);
            p.openElements.popUntilTagNamePopped(closeTn);
            break;
        }

        if (elementTn !== $.ADDRESS && elementTn !== $.DIV && elementTn !== $.P && p._isSpecialElement(element)) {
            break;
        }
    }

    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
}

function plaintextStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    p.tokenizer.state = Tokenizer.MODE.PLAINTEXT;
}

function buttonStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInScope($.BUTTON)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped($.BUTTON);
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.framesetOk = false;
}

function aStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const activeElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName($.A);

    if (activeElementEntry) {
        callAdoptionAgency(p, token);
        p.openElements.remove(activeElementEntry.element);
        p.activeFormattingElements.removeEntry(activeElementEntry);
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function bStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function nobrStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();

    if (p.openElements.hasInScope($.NOBR)) {
        callAdoptionAgency(p, token);
        p._reconstructActiveFormattingElements();
    }

    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function appletStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.insertMarker();
    p.framesetOk = false;
}

function tableStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (
        p.treeAdapter.getDocumentMode(p.document) !== HTML.DOCUMENT_MODE.QUIRKS &&
        p.openElements.hasInButtonScope($.P)
    ) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    p.framesetOk = false;
    p.insertionMode = InsertionMode.IN_TABLE;
}

function areaStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._appendElement(token, NS.HTML);
    p.framesetOk = false;
    token.ackSelfClosing = true;
}

function inputStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._appendElement(token, NS.HTML);

    const inputType = Tokenizer.getTokenAttr(token, ATTRS.TYPE);

    if (!inputType || inputType.toLowerCase() !== HIDDEN_INPUT_TYPE) {
        p.framesetOk = false;
    }

    token.ackSelfClosing = true;
}

function paramStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._appendElement(token, NS.HTML);
    token.ackSelfClosing = true;
}

function hrStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._appendElement(token, NS.HTML);
    p.framesetOk = false;
    token.ackSelfClosing = true;
}

function imageStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    token.tagName = $.IMG;
    areaStartTagInBody(p, token);
}

function textareaStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._insertElement(token, NS.HTML);
    //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
    //on to the next one. (Newlines at the start of textarea elements are ignored as an authoring convenience.)
    p.skipNextNewLine = true;
    p.tokenizer.state = Tokenizer.MODE.RCDATA;
    p.originalInsertionMode = p.insertionMode;
    p.framesetOk = false;
    p.insertionMode = InsertionMode.TEXT;
}

function xmpStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._reconstructActiveFormattingElements();
    p.framesetOk = false;
    p._switchToTextParsing(token, Tokenizer.MODE.RAWTEXT);
}

function iframeStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.framesetOk = false;
    p._switchToTextParsing(token, Tokenizer.MODE.RAWTEXT);
}

//NOTE: here we assume that we always act as an user agent with enabled plugins, so we parse
//<noembed> as a rawtext.
function noembedStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._switchToTextParsing(token, Tokenizer.MODE.RAWTEXT);
}

function selectStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.framesetOk = false;

    p.insertionMode =
        p.insertionMode === InsertionMode.IN_TABLE ||
        p.insertionMode === InsertionMode.IN_CAPTION ||
        p.insertionMode === InsertionMode.IN_TABLE_BODY ||
        p.insertionMode === InsertionMode.IN_ROW ||
        p.insertionMode === InsertionMode.IN_CELL
            ? InsertionMode.IN_SELECT_IN_TABLE
            : InsertionMode.IN_SELECT;
}

function optgroupStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.currentTagName === $.OPTION) {
        p.openElements.pop();
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
}

function rbStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInScope($.RUBY)) {
        p.openElements.generateImpliedEndTags();
    }

    p._insertElement(token, NS.HTML);
}

function rtStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInScope($.RUBY)) {
        p.openElements.generateImpliedEndTagsWithExclusion($.RTC);
    }

    p._insertElement(token, NS.HTML);
}

function mathStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();

    foreignContent.adjustTokenMathMLAttrs(token);
    foreignContent.adjustTokenXMLAttrs(token);

    if (token.selfClosing) {
        p._appendElement(token, NS.MATHML);
    } else {
        p._insertElement(token, NS.MATHML);
    }

    token.ackSelfClosing = true;
}

function svgStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();

    foreignContent.adjustTokenSVGAttrs(token);
    foreignContent.adjustTokenXMLAttrs(token);

    if (token.selfClosing) {
        p._appendElement(token, NS.SVG);
    } else {
        p._insertElement(token, NS.SVG);
    }

    token.ackSelfClosing = true;
}

function genericStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
}

const NUMBERED_HEADERS = new Set<string>([$.H1, $.H2, $.H3, $.H4, $.H5, $.H6]);

//OPTIMIZATION: Integer comparisons are low-cost, so we can use very fast tag name length filters here.
//It's faster than using dictionary.
function startTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn.length) {
        case 1:
            switch (tn) {
                case $.I:
                case $.S:
                case $.B:
                case $.U: {
                    bStartTagInBody(p, token);

                    break;
                }
                case $.P: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.A: {
                    aStartTagInBody(p, token);

                    break;
                }
                default: {
                    genericStartTagInBody(p, token);
                }
            }

            break;

        case 2:
            if (tn === $.DL || tn === $.OL || tn === $.UL) {
                addressStartTagInBody(p, token);
            } else if (NUMBERED_HEADERS.has(tn)) {
                numberedHeaderStartTagInBody(p, token);
            } else
                switch (tn) {
                    case $.LI:
                    case $.DD:
                    case $.DT: {
                        listItemStartTagInBody(p, token);

                        break;
                    }
                    case $.EM:
                    case $.TT: {
                        bStartTagInBody(p, token);

                        break;
                    }
                    case $.BR: {
                        areaStartTagInBody(p, token);

                        break;
                    }
                    case $.HR: {
                        hrStartTagInBody(p, token);

                        break;
                    }
                    case $.RB: {
                        rbStartTagInBody(p, token);

                        break;
                    }
                    case $.RT:
                    case $.RP: {
                        rtStartTagInBody(p, token);

                        break;
                    }
                    default:
                        if (tn !== $.TH && tn !== $.TD && tn !== $.TR) {
                            genericStartTagInBody(p, token);
                        }
                }

            break;

        case 3:
            switch (tn) {
                case $.DIV:
                case $.DIR:
                case $.NAV: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.PRE: {
                    preStartTagInBody(p, token);

                    break;
                }
                case $.BIG: {
                    bStartTagInBody(p, token);

                    break;
                }
                case $.IMG:
                case $.WBR: {
                    areaStartTagInBody(p, token);

                    break;
                }
                case $.XMP: {
                    xmpStartTagInBody(p, token);

                    break;
                }
                case $.SVG: {
                    svgStartTagInBody(p, token);

                    break;
                }
                case $.RTC: {
                    rbStartTagInBody(p, token);

                    break;
                }
                default:
                    if (tn !== $.COL) {
                        genericStartTagInBody(p, token);
                    }
            }

            break;

        case 4:
            switch (tn) {
                case $.HTML: {
                    htmlStartTagInBody(p, token);

                    break;
                }
                case $.BASE:
                case $.LINK:
                case $.META: {
                    startTagInHead(p, token);

                    break;
                }
                case $.BODY: {
                    bodyStartTagInBody(p, token);

                    break;
                }
                case $.MAIN:
                case $.MENU: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.FORM: {
                    formStartTagInBody(p, token);

                    break;
                }
                case $.CODE:
                case $.FONT: {
                    bStartTagInBody(p, token);

                    break;
                }
                case $.NOBR: {
                    nobrStartTagInBody(p, token);

                    break;
                }
                case $.AREA: {
                    areaStartTagInBody(p, token);

                    break;
                }
                case $.MATH: {
                    mathStartTagInBody(p, token);

                    break;
                }
                default:
                    if (tn !== $.HEAD) {
                        genericStartTagInBody(p, token);
                    }
            }

            break;

        case 5:
            switch (tn) {
                case $.STYLE:
                case $.TITLE: {
                    startTagInHead(p, token);

                    break;
                }
                case $.ASIDE: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.SMALL: {
                    bStartTagInBody(p, token);

                    break;
                }
                case $.TABLE: {
                    tableStartTagInBody(p, token);

                    break;
                }
                case $.EMBED: {
                    areaStartTagInBody(p, token);

                    break;
                }
                case $.INPUT: {
                    inputStartTagInBody(p, token);

                    break;
                }
                case $.PARAM:
                case $.TRACK: {
                    paramStartTagInBody(p, token);

                    break;
                }
                case $.IMAGE: {
                    imageStartTagInBody(p, token);

                    break;
                }
                default:
                    if (tn !== $.FRAME && tn !== $.TBODY && tn !== $.TFOOT && tn !== $.THEAD) {
                        genericStartTagInBody(p, token);
                    }
            }

            break;

        case 6:
            switch (tn) {
                case $.SCRIPT: {
                    startTagInHead(p, token);

                    break;
                }
                case $.CENTER:
                case $.FIGURE:
                case $.FOOTER:
                case $.HEADER:
                case $.HGROUP:
                case $.DIALOG: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.BUTTON: {
                    buttonStartTagInBody(p, token);

                    break;
                }
                case $.STRIKE:
                case $.STRONG: {
                    bStartTagInBody(p, token);

                    break;
                }
                case $.APPLET:
                case $.OBJECT: {
                    appletStartTagInBody(p, token);

                    break;
                }
                case $.KEYGEN: {
                    areaStartTagInBody(p, token);

                    break;
                }
                case $.SOURCE: {
                    paramStartTagInBody(p, token);

                    break;
                }
                case $.IFRAME: {
                    iframeStartTagInBody(p, token);

                    break;
                }
                case $.SELECT: {
                    selectStartTagInBody(p, token);

                    break;
                }
                case $.OPTION: {
                    optgroupStartTagInBody(p, token);

                    break;
                }
                default: {
                    genericStartTagInBody(p, token);
                }
            }

            break;

        case 7:
            switch (tn) {
                case $.BGSOUND: {
                    startTagInHead(p, token);

                    break;
                }
                case $.DETAILS:
                case $.ADDRESS:
                case $.ARTICLE:
                case $.SECTION:
                case $.SUMMARY: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.LISTING: {
                    preStartTagInBody(p, token);

                    break;
                }
                case $.MARQUEE: {
                    appletStartTagInBody(p, token);

                    break;
                }
                case $.NOEMBED: {
                    noembedStartTagInBody(p, token);

                    break;
                }
                default:
                    if (tn !== $.CAPTION) {
                        genericStartTagInBody(p, token);
                    }
            }

            break;

        case 8:
            switch (tn) {
                case $.BASEFONT: {
                    startTagInHead(p, token);

                    break;
                }
                case $.FRAMESET: {
                    framesetStartTagInBody(p, token);

                    break;
                }
                case $.FIELDSET: {
                    addressStartTagInBody(p, token);

                    break;
                }
                case $.TEXTAREA: {
                    textareaStartTagInBody(p, token);

                    break;
                }
                case $.TEMPLATE: {
                    startTagInHead(p, token);

                    break;
                }
                case $.NOSCRIPT: {
                    if (p.options.scriptingEnabled) {
                        noembedStartTagInBody(p, token);
                    } else {
                        genericStartTagInBody(p, token);
                    }

                    break;
                }
                case $.OPTGROUP: {
                    optgroupStartTagInBody(p, token);

                    break;
                }
                default:
                    if (tn !== $.COLGROUP) {
                        genericStartTagInBody(p, token);
                    }
            }

            break;

        case 9:
            if (tn === $.PLAINTEXT) {
                plaintextStartTagInBody(p, token);
            } else {
                genericStartTagInBody(p, token);
            }

            break;

        case 10:
            if (tn === $.BLOCKQUOTE || tn === $.FIGCAPTION) {
                addressStartTagInBody(p, token);
            } else {
                genericStartTagInBody(p, token);
            }

            break;

        default:
            genericStartTagInBody(p, token);
    }
}

function bodyEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    if (p.openElements.hasInScope($.BODY)) {
        p.insertionMode = InsertionMode.AFTER_BODY;
    }
}

function htmlEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInScope($.BODY)) {
        p.insertionMode = InsertionMode.AFTER_BODY;
        p._processToken(token);
    }
}

function addressEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped(tn);
    }
}

function formEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    const inTemplate = p.openElements.tmplCount > 0;
    const { formElement } = p;

    if (!inTemplate) {
        p.formElement = null;
    }

    if ((formElement || inTemplate) && p.openElements.hasInScope($.FORM)) {
        p.openElements.generateImpliedEndTags();

        if (inTemplate) {
            p.openElements.popUntilTagNamePopped($.FORM);
        } else {
            p.openElements.remove(formElement!);
        }
    }
}

function pEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    if (!p.openElements.hasInButtonScope($.P)) {
        p._insertFakeElement($.P);
    }

    p._closePElement();
}

function liEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    if (p.openElements.hasInListItemScope($.LI)) {
        p.openElements.generateImpliedEndTagsWithExclusion($.LI);
        p.openElements.popUntilTagNamePopped($.LI);
    }
}

function ddEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTagsWithExclusion(tn);
        p.openElements.popUntilTagNamePopped(tn);
    }
}

function numberedHeaderEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    if (p.openElements.hasNumberedHeaderInScope()) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilNumberedHeaderPopped();
    }
}

function appletEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped(tn);
        p.activeFormattingElements.clearToLastMarker();
    }
}

function brEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>) {
    p._reconstructActiveFormattingElements();
    p._insertFakeElement($.BR);
    p.openElements.pop();
    p.framesetOk = false;
}

function genericEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    for (let i = p.openElements.stackTop; i > 0; i--) {
        const element = p.openElements.items[i];

        if (p.treeAdapter.getTagName(element) === tn) {
            p.openElements.generateImpliedEndTagsWithExclusion(tn);
            p.openElements.popUntilElementPopped(element);
            break;
        }

        if (p._isSpecialElement(element)) {
            break;
        }
    }
}

//OPTIMIZATION: Integer comparisons are low-cost, so we can use very fast tag name length filters here.
//It's faster than using dictionary.
function endTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn.length) {
        case 1:
            if (tn === $.A || tn === $.B || tn === $.I || tn === $.S || tn === $.U) {
                callAdoptionAgency(p, token);
            } else if (tn === $.P) {
                pEndTagInBody(p);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        case 2:
            switch (tn) {
                case $.DL:
                case $.UL:
                case $.OL: {
                    addressEndTagInBody(p, token);

                    break;
                }
                case $.LI: {
                    liEndTagInBody(p);

                    break;
                }
                case $.DD:
                case $.DT: {
                    ddEndTagInBody(p, token);

                    break;
                }
                default:
                    if (NUMBERED_HEADERS.has(tn)) {
                        numberedHeaderEndTagInBody(p);
                    } else if (tn === $.BR) {
                        brEndTagInBody(p);
                    } else if (tn === $.EM || tn === $.TT) {
                        callAdoptionAgency(p, token);
                    } else {
                        genericEndTagInBody(p, token);
                    }
            }

            break;

        case 3:
            if (tn === $.BIG) {
                callAdoptionAgency(p, token);
            } else if (tn === $.DIR || tn === $.DIV || tn === $.NAV || tn === $.PRE) {
                addressEndTagInBody(p, token);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        case 4:
            switch (tn) {
                case $.BODY: {
                    bodyEndTagInBody(p);

                    break;
                }
                case $.HTML: {
                    htmlEndTagInBody(p, token);

                    break;
                }
                case $.FORM: {
                    formEndTagInBody(p);

                    break;
                }
                case $.CODE:
                case $.FONT:
                case $.NOBR: {
                    callAdoptionAgency(p, token);

                    break;
                }
                case $.MAIN:
                case $.MENU: {
                    addressEndTagInBody(p, token);

                    break;
                }
                default: {
                    genericEndTagInBody(p, token);
                }
            }

            break;

        case 5:
            if (tn === $.ASIDE) {
                addressEndTagInBody(p, token);
            } else if (tn === $.SMALL) {
                callAdoptionAgency(p, token);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        case 6:
            switch (tn) {
                case $.CENTER:
                case $.FIGURE:
                case $.FOOTER:
                case $.HEADER:
                case $.HGROUP:
                case $.DIALOG: {
                    addressEndTagInBody(p, token);

                    break;
                }
                case $.APPLET:
                case $.OBJECT: {
                    appletEndTagInBody(p, token);

                    break;
                }
                case $.STRIKE:
                case $.STRONG: {
                    callAdoptionAgency(p, token);

                    break;
                }
                default: {
                    genericEndTagInBody(p, token);
                }
            }

            break;

        case 7:
            if (
                tn === $.ADDRESS ||
                tn === $.ARTICLE ||
                tn === $.DETAILS ||
                tn === $.SECTION ||
                tn === $.SUMMARY ||
                tn === $.LISTING
            ) {
                addressEndTagInBody(p, token);
            } else if (tn === $.MARQUEE) {
                appletEndTagInBody(p, token);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        case 8:
            if (tn === $.FIELDSET) {
                addressEndTagInBody(p, token);
            } else if (tn === $.TEMPLATE) {
                endTagInHead(p, token);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        case 10:
            if (tn === $.BLOCKQUOTE || tn === $.FIGCAPTION) {
                addressEndTagInBody(p, token);
            } else {
                genericEndTagInBody(p, token);
            }

            break;

        default:
            genericEndTagInBody(p, token);
    }
}

function eofInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    if (p.tmplInsertionModeStackTop > -1) {
        eofInTemplate(p, token);
    } else {
        p.stopped = true;
    }
}

// The "text" insertion mode
//------------------------------------------------------------------
function endTagInText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.SCRIPT) {
        p.pendingScript = p.openElements.current;
    }

    p.openElements.pop();
    p.insertionMode = p.originalInsertionMode;
}

function eofInText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p._err(ERR.eofInElementThatCanContainOnlyText);
    p.openElements.pop();
    p.insertionMode = p.originalInsertionMode;
    p._processToken(token);
}

// The "in table" insertion mode
//------------------------------------------------------------------
function characterInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    const curTn = p.openElements.currentTagName;

    if (curTn === $.TABLE || curTn === $.TBODY || curTn === $.TFOOT || curTn === $.THEAD || curTn === $.TR) {
        p.pendingCharacterTokens = [];
        p.hasNonWhitespacePendingCharacterToken = false;
        p.originalInsertionMode = p.insertionMode;
        p.insertionMode = InsertionMode.IN_TABLE_TEXT;
        p._processToken(token);
    } else {
        tokenInTable(p, token);
    }
}

function captionStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.openElements.clearBackToTableContext();
    p.activeFormattingElements.insertMarker();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_CAPTION;
}

function colgroupStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.openElements.clearBackToTableContext();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
}

function colStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.openElements.clearBackToTableContext();
    p._insertFakeElement($.COLGROUP);
    p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
    p._processToken(token);
}

function tbodyStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.openElements.clearBackToTableContext();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_TABLE_BODY;
}

function tdStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    p.openElements.clearBackToTableContext();
    p._insertFakeElement($.TBODY);
    p.insertionMode = InsertionMode.IN_TABLE_BODY;
    p._processToken(token);
}

function tableStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (p.openElements.hasInTableScope($.TABLE)) {
        p.openElements.popUntilTagNamePopped($.TABLE);
        p._resetInsertionMode();
        p._processToken(token);
    }
}

function inputStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const inputType = Tokenizer.getTokenAttr(token, ATTRS.TYPE);

    if (inputType && inputType.toLowerCase() === HIDDEN_INPUT_TYPE) {
        p._appendElement(token, NS.HTML);
    } else {
        tokenInTable(p, token);
    }

    token.ackSelfClosing = true;
}

function formStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (!p.formElement && p.openElements.tmplCount === 0) {
        p._insertElement(token, NS.HTML);
        p.formElement = p.openElements.current;
        p.openElements.pop();
    }
}

function startTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn.length) {
        case 2:
            if (tn === $.TD || tn === $.TH || tn === $.TR) {
                tdStartTagInTable(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        case 3:
            if (tn === $.COL) {
                colStartTagInTable(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        case 4:
            if (tn === $.FORM) {
                formStartTagInTable(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        case 5:
            switch (tn) {
                case $.TABLE: {
                    tableStartTagInTable(p, token);

                    break;
                }
                case $.STYLE: {
                    startTagInHead(p, token);

                    break;
                }
                case $.TBODY:
                case $.TFOOT:
                case $.THEAD: {
                    tbodyStartTagInTable(p, token);

                    break;
                }
                case $.INPUT: {
                    inputStartTagInTable(p, token);

                    break;
                }
                default: {
                    tokenInTable(p, token);
                }
            }

            break;

        case 6:
            if (tn === $.SCRIPT) {
                startTagInHead(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        case 7:
            if (tn === $.CAPTION) {
                captionStartTagInTable(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        case 8:
            if (tn === $.COLGROUP) {
                colgroupStartTagInTable(p, token);
            } else if (tn === $.TEMPLATE) {
                startTagInHead(p, token);
            } else {
                tokenInTable(p, token);
            }

            break;

        default:
            tokenInTable(p, token);
    }
}

function endTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.TABLE) {
        if (p.openElements.hasInTableScope($.TABLE)) {
            p.openElements.popUntilTagNamePopped($.TABLE);
            p._resetInsertionMode();
        }
    } else if (tn === $.TEMPLATE) {
        endTagInHead(p, token);
    } else if (
        tn !== $.BODY &&
        tn !== $.CAPTION &&
        tn !== $.COL &&
        tn !== $.COLGROUP &&
        tn !== $.HTML &&
        tn !== $.TBODY &&
        tn !== $.TD &&
        tn !== $.TFOOT &&
        tn !== $.TH &&
        tn !== $.THEAD &&
        tn !== $.TR
    ) {
        tokenInTable(p, token);
    }
}

function tokenInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    const savedFosterParentingState = p.fosterParentingEnabled;

    p.fosterParentingEnabled = true;
    p._processTokenInBodyMode(token);
    p.fosterParentingEnabled = savedFosterParentingState;
}

// The "in table text" insertion mode
//------------------------------------------------------------------
function whitespaceCharacterInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p.pendingCharacterTokens.push(token);
}

function characterInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p.pendingCharacterTokens.push(token);
    p.hasNonWhitespacePendingCharacterToken = true;
}

function tokenInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    let i = 0;

    if (p.hasNonWhitespacePendingCharacterToken) {
        for (; i < p.pendingCharacterTokens.length; i++) {
            tokenInTable(p, p.pendingCharacterTokens[i]);
        }
    } else {
        for (; i < p.pendingCharacterTokens.length; i++) {
            p._insertCharacters(p.pendingCharacterTokens[i]);
        }
    }

    p.insertionMode = p.originalInsertionMode;
    p._processToken(token);
}

// The "in caption" insertion mode
//------------------------------------------------------------------
const TABLE_VOID_ELEMENTS = new Set<string>([
    $.CAPTION,
    $.COL,
    $.COLGROUP,
    $.TBODY,
    $.TD,
    $.TFOOT,
    $.TH,
    $.THEAD,
    $.TR,
]);

function startTagInCaption<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (TABLE_VOID_ELEMENTS.has(tn)) {
        if (p.openElements.hasInTableScope($.CAPTION)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped($.CAPTION);
            p.activeFormattingElements.clearToLastMarker();
            p.insertionMode = InsertionMode.IN_TABLE;
            p._processToken(token);
        }
    } else {
        startTagInBody(p, token);
    }
}

function endTagInCaption<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.CAPTION || tn === $.TABLE) {
        if (p.openElements.hasInTableScope($.CAPTION)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped($.CAPTION);
            p.activeFormattingElements.clearToLastMarker();
            p.insertionMode = InsertionMode.IN_TABLE;

            if (tn === $.TABLE) {
                p._processToken(token);
            }
        }
    } else if (
        tn !== $.BODY &&
        tn !== $.COL &&
        tn !== $.COLGROUP &&
        tn !== $.HTML &&
        tn !== $.TBODY &&
        tn !== $.TD &&
        tn !== $.TFOOT &&
        tn !== $.TH &&
        tn !== $.THEAD &&
        tn !== $.TR
    ) {
        endTagInBody(p, token);
    }
}

// The "in column group" insertion mode
//------------------------------------------------------------------
function startTagInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.COL: {
            p._appendElement(token, NS.HTML);
            token.ackSelfClosing = true;

            break;
        }
        case $.TEMPLATE: {
            startTagInHead(p, token);

            break;
        }
        default: {
            tokenInColumnGroup(p, token);
        }
    }
}

function endTagInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.COLGROUP) {
        if (p.openElements.currentTagName === $.COLGROUP) {
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_TABLE;
        }
    } else if (tn === $.TEMPLATE) {
        endTagInHead(p, token);
    } else if (tn !== $.COL) {
        tokenInColumnGroup(p, token);
    }
}

function tokenInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    if (p.openElements.currentTagName === $.COLGROUP) {
        p.openElements.pop();
        p.insertionMode = InsertionMode.IN_TABLE;
        p._processToken(token);
    }
}

// The "in table body" insertion mode
//------------------------------------------------------------------
function startTagInTableBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.TR: {
            p.openElements.clearBackToTableBodyContext();
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.IN_ROW;

            break;
        }
        case $.TH:
        case $.TD: {
            p.openElements.clearBackToTableBodyContext();
            p._insertFakeElement($.TR);
            p.insertionMode = InsertionMode.IN_ROW;
            p._processToken(token);

            break;
        }
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD: {
            if (p.openElements.hasTableBodyContextInTableScope()) {
                p.openElements.clearBackToTableBodyContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE;
                p._processToken(token);
            }

            break;
        }
        default: {
            startTagInTable(p, token);
        }
    }
}

function endTagInTableBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.TBODY || tn === $.TFOOT || tn === $.THEAD) {
        if (p.openElements.hasInTableScope(tn)) {
            p.openElements.clearBackToTableBodyContext();
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_TABLE;
        }
    } else if (tn === $.TABLE) {
        if (p.openElements.hasTableBodyContextInTableScope()) {
            p.openElements.clearBackToTableBodyContext();
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_TABLE;
            p._processToken(token);
        }
    } else if (
        tn !== $.BODY &&
        tn !== $.CAPTION &&
        tn !== $.COL &&
        tn !== $.COLGROUP &&
        tn !== $.HTML &&
        tn !== $.TD &&
        tn !== $.TH &&
        tn !== $.TR
    ) {
        endTagInTable(p, token);
    }
}

// The "in row" insertion mode
//------------------------------------------------------------------
function startTagInRow<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.TH || tn === $.TD) {
        p.openElements.clearBackToTableRowContext();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_CELL;
        p.activeFormattingElements.insertMarker();
    } else if (
        tn === $.CAPTION ||
        tn === $.COL ||
        tn === $.COLGROUP ||
        tn === $.TBODY ||
        tn === $.TFOOT ||
        tn === $.THEAD ||
        tn === $.TR
    ) {
        if (p.openElements.hasInTableScope($.TR)) {
            p.openElements.clearBackToTableRowContext();
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_TABLE_BODY;
            p._processToken(token);
        }
    } else {
        startTagInTable(p, token);
    }
}

function endTagInRow<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.TR: {
            if (p.openElements.hasInTableScope($.TR)) {
                p.openElements.clearBackToTableRowContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
            }

            break;
        }
        case $.TABLE: {
            if (p.openElements.hasInTableScope($.TR)) {
                p.openElements.clearBackToTableRowContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
                p._processToken(token);
            }

            break;
        }
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD: {
            if (p.openElements.hasInTableScope(tn) || p.openElements.hasInTableScope($.TR)) {
                p.openElements.clearBackToTableRowContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
                p._processToken(token);
            }

            break;
        }
        default:
            if (
                tn !== $.BODY &&
                tn !== $.CAPTION &&
                tn !== $.COL &&
                tn !== $.COLGROUP &&
                tn !== $.HTML &&
                tn !== $.TD &&
                tn !== $.TH
            ) {
                endTagInTable(p, token);
            }
    }
}

// The "in cell" insertion mode
//------------------------------------------------------------------
function startTagInCell<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (TABLE_VOID_ELEMENTS.has(tn)) {
        if (p.openElements.hasInTableScope($.TD) || p.openElements.hasInTableScope($.TH)) {
            p._closeTableCell();
            p._processToken(token);
        }
    } else {
        startTagInBody(p, token);
    }
}

function endTagInCell<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.TD || tn === $.TH) {
        if (p.openElements.hasInTableScope(tn)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped(tn);
            p.activeFormattingElements.clearToLastMarker();
            p.insertionMode = InsertionMode.IN_ROW;
        }
    } else if (TABLE_STRUCTURE_TAGS.has(tn)) {
        if (p.openElements.hasInTableScope(tn)) {
            p._closeTableCell();
            p._processToken(token);
        }
    } else if (tn !== $.BODY && tn !== $.CAPTION && tn !== $.COL && tn !== $.COLGROUP && tn !== $.HTML) {
        endTagInBody(p, token);
    }
}

// The "in select" insertion mode
//------------------------------------------------------------------
function startTagInSelect<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.OPTION: {
            if (p.openElements.currentTagName === $.OPTION) {
                p.openElements.pop();
            }

            p._insertElement(token, NS.HTML);

            break;
        }
        case $.OPTGROUP: {
            if (p.openElements.currentTagName === $.OPTION) {
                p.openElements.pop();
            }

            if (p.openElements.currentTagName === $.OPTGROUP) {
                p.openElements.pop();
            }

            p._insertElement(token, NS.HTML);

            break;
        }
        case $.INPUT:
        case $.KEYGEN:
        case $.TEXTAREA:
        case $.SELECT: {
            if (p.openElements.hasInSelectScope($.SELECT)) {
                p.openElements.popUntilTagNamePopped($.SELECT);
                p._resetInsertionMode();

                if (tn !== $.SELECT) {
                    p._processToken(token);
                }
            }

            break;
        }
        case $.SCRIPT:
        case $.TEMPLATE: {
            startTagInHead(p, token);

            break;
        }
        default:
        // Do nothing
    }
}

function endTagInSelect<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.OPTGROUP) {
        const prevOpenElement = p.openElements.items[p.openElements.stackTop - 1];
        const prevOpenElementTn = prevOpenElement && p.treeAdapter.getTagName(prevOpenElement);

        if (p.openElements.currentTagName === $.OPTION && prevOpenElementTn === $.OPTGROUP) {
            p.openElements.pop();
        }

        if (p.openElements.currentTagName === $.OPTGROUP) {
            p.openElements.pop();
        }
    } else if (tn === $.OPTION) {
        if (p.openElements.currentTagName === $.OPTION) {
            p.openElements.pop();
        }
    } else if (tn === $.SELECT && p.openElements.hasInSelectScope($.SELECT)) {
        p.openElements.popUntilTagNamePopped($.SELECT);
        p._resetInsertionMode();
    } else if (tn === $.TEMPLATE) {
        endTagInHead(p, token);
    }
}

//12.2.5.4.17 The "in select in table" insertion mode
//------------------------------------------------------------------
function startTagInSelectInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (
        tn === $.CAPTION ||
        tn === $.TABLE ||
        tn === $.TBODY ||
        tn === $.TFOOT ||
        tn === $.THEAD ||
        tn === $.TR ||
        tn === $.TD ||
        tn === $.TH
    ) {
        p.openElements.popUntilTagNamePopped($.SELECT);
        p._resetInsertionMode();
        p._processToken(token);
    } else {
        startTagInSelect(p, token);
    }
}

function endTagInSelectInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (
        tn === $.CAPTION ||
        tn === $.TABLE ||
        tn === $.TBODY ||
        tn === $.TFOOT ||
        tn === $.THEAD ||
        tn === $.TR ||
        tn === $.TD ||
        tn === $.TH
    ) {
        if (p.openElements.hasInTableScope(tn)) {
            p.openElements.popUntilTagNamePopped($.SELECT);
            p._resetInsertionMode();
            p._processToken(token);
        }
    } else {
        endTagInSelect(p, token);
    }
}

// The "in template" insertion mode
//------------------------------------------------------------------
const TEMPLATE_START_TAGS = new Set<string>([
    $.BASE,
    $.BASEFONT,
    $.BGSOUND,
    $.LINK,
    $.META,
    $.NOFRAMES,
    $.SCRIPT,
    $.STYLE,
    $.TEMPLATE,
    $.TITLE,
]);

function startTagInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (TEMPLATE_START_TAGS.has(tn)) {
        startTagInHead(p, token);
    } else {
        const newInsertionMode = TEMPLATE_INSERTION_MODE_SWITCH_MAP.get(tn) ?? InsertionMode.IN_BODY;

        p._popTmplInsertionMode();
        p._pushTmplInsertionMode(newInsertionMode);
        p.insertionMode = newInsertionMode;
        p._processToken(token);
    }
}

function endTagInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.TEMPLATE) {
        endTagInHead(p, token);
    }
}

function eofInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    if (p.openElements.tmplCount > 0) {
        p.openElements.popUntilTagNamePopped($.TEMPLATE);
        p.activeFormattingElements.clearToLastMarker();
        p._popTmplInsertionMode();
        p._resetInsertionMode();
        p._processToken(token);
    } else {
        p.stopped = true;
    }
}

// The "after body" insertion mode
//------------------------------------------------------------------
function startTagAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.HTML) {
        startTagInBody(p, token);
    } else {
        tokenAfterBody(p, token);
    }
}

function endTagAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.HTML) {
        if (!p.fragmentContext) {
            p.insertionMode = InsertionMode.AFTER_AFTER_BODY;
        }
    } else {
        tokenAfterBody(p, token);
    }
}

function tokenAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p.insertionMode = InsertionMode.IN_BODY;
    p._processToken(token);
}

// The "in frameset" insertion mode
//------------------------------------------------------------------
function startTagInFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    switch (tn) {
        case $.HTML: {
            startTagInBody(p, token);

            break;
        }
        case $.FRAMESET: {
            p._insertElement(token, NS.HTML);

            break;
        }
        case $.FRAME: {
            p._appendElement(token, NS.HTML);
            token.ackSelfClosing = true;

            break;
        }
        case $.NOFRAMES: {
            startTagInHead(p, token);

            break;
        }
        default:
        // Do nothing
    }
}

function endTagInFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.FRAMESET && !p.openElements.isRootHtmlElementCurrent()) {
        p.openElements.pop();

        if (!p.fragmentContext && p.openElements.currentTagName !== $.FRAMESET) {
            p.insertionMode = InsertionMode.AFTER_FRAMESET;
        }
    }
}

// The "after frameset" insertion mode
//------------------------------------------------------------------
function startTagAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.HTML) {
        startTagInBody(p, token);
    } else if (tn === $.NOFRAMES) {
        startTagInHead(p, token);
    }
}

function endTagAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.HTML) {
        p.insertionMode = InsertionMode.AFTER_AFTER_FRAMESET;
    }
}

// The "after after body" insertion mode
//------------------------------------------------------------------
function startTagAfterAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (token.tagName === $.HTML) {
        startTagInBody(p, token);
    } else {
        tokenAfterAfterBody(p, token);
    }
}

function tokenAfterAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token) {
    p.insertionMode = InsertionMode.IN_BODY;
    p._processToken(token);
}

// The "after after frameset" insertion mode
//------------------------------------------------------------------
function startTagAfterAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    const tn = token.tagName;

    if (tn === $.HTML) {
        startTagInBody(p, token);
    } else if (tn === $.NOFRAMES) {
        startTagInHead(p, token);
    }
}

// The rules for parsing tokens in foreign content
//------------------------------------------------------------------
function nullCharacterInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    token.chars = unicode.REPLACEMENT_CHARACTER;
    p._insertCharacters(token);
}

function characterInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken) {
    p._insertCharacters(token);
    p.framesetOk = false;
}

function startTagInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    if (foreignContent.causesExit(token) && !p.fragmentContext) {
        while (
            p.treeAdapter.getNamespaceURI(p.openElements.current) !== NS.HTML &&
            !p._isIntegrationPoint(p.openElements.current)
        ) {
            p.openElements.pop();
        }

        p._processToken(token);
    } else {
        const current = p._getAdjustedCurrentElement();
        const currentNs = p.treeAdapter.getNamespaceURI(current);

        if (currentNs === NS.MATHML) {
            foreignContent.adjustTokenMathMLAttrs(token);
        } else if (currentNs === NS.SVG) {
            foreignContent.adjustTokenSVGTagName(token);
            foreignContent.adjustTokenSVGAttrs(token);
        }

        foreignContent.adjustTokenXMLAttrs(token);

        if (token.selfClosing) {
            p._appendElement(token, currentNs);
        } else {
            p._insertElement(token, currentNs);
        }

        token.ackSelfClosing = true;
    }
}

function endTagInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken) {
    for (let i = p.openElements.stackTop; i > 0; i--) {
        const element = p.openElements.items[i];

        if (p.treeAdapter.getNamespaceURI(element) === NS.HTML) {
            p._processToken(token);
            break;
        }

        if (p.treeAdapter.getTagName(element).toLowerCase() === token.tagName) {
            p.openElements.popUntilElementPopped(element);
            break;
        }
    }
}
