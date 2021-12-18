import { Tokenizer, TokenizerMode } from '../tokenizer/index.js';
import { OpenElementStack } from './open-element-stack.js';
import { FormattingElementList, ElementEntry, EntryType } from './formatting-element-list.js';
import * as defaultTreeAdapter from '../tree-adapters/default.js';
import * as doctype from '../common/doctype.js';
import * as foreignContent from '../common/foreign-content.js';
import { ERR, ParserErrorHandler } from '../common/error-codes.js';
import * as unicode from '../common/unicode.js';
import {
    TAG_ID as $,
    TAG_NAMES as TN,
    NAMESPACES as NS,
    ATTRS,
    SPECIAL_ELEMENTS,
    DOCUMENT_MODE,
    isNumberedHeader,
    getTagID,
} from '../common/html.js';
import type { TreeAdapter, TreeAdapterTypeMap } from '../tree-adapters/interface.js';
import {
    TokenType,
    getTokenAttr,
    Token,
    CommentToken,
    CharacterToken,
    TagToken,
    DoctypeToken,
    EOFToken,
    LocationWithAttributes,
    ElementLocation,
} from '../common/token.js';

//Misc constants
const HIDDEN_INPUT_TYPE = 'hidden';

//Adoption agency loops iteration count
const AA_OUTER_LOOP_ITER = 8;
const AA_INNER_LOOP_ITER = 3;

//Insertion modes
enum InsertionMode {
    INITIAL,
    BEFORE_HTML,
    BEFORE_HEAD,
    IN_HEAD,
    IN_HEAD_NO_SCRIPT,
    AFTER_HEAD,
    IN_BODY,
    TEXT,
    IN_TABLE,
    IN_TABLE_TEXT,
    IN_CAPTION,
    IN_COLUMN_GROUP,
    IN_TABLE_BODY,
    IN_ROW,
    IN_CELL,
    IN_SELECT,
    IN_SELECT_IN_TABLE,
    IN_TEMPLATE,
    AFTER_BODY,
    IN_FRAMESET,
    AFTER_FRAMESET,
    AFTER_AFTER_BODY,
    AFTER_AFTER_FRAMESET,
}

const BASE_LOC = {
    startLine: -1,
    startCol: -1,
    startOffset: -1,
    endLine: -1,
    endCol: -1,
    endOffset: -1,
};

const TABLE_STRUCTURE_TAGS = new Set([$.TABLE, $.TBODY, $.TFOOT, $.THEAD, $.TR]);

export interface ParserOptions<T extends TreeAdapterTypeMap> {
    /**
     * The [scripting flag](https://html.spec.whatwg.org/multipage/parsing.html#scripting-flag). If set
     * to `true`, `noscript` element content will be parsed as text.
     *
     *  @default `true`
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
     * @default `false`
     */
    sourceCodeLocationInfo?: boolean | undefined;

    /**
     * Specifies the resulting tree format.
     *
     * @default `treeAdapters.default`
     */
    treeAdapter?: TreeAdapter<T> | undefined;

    /**
     * Callback for parse errors.
     *
     * @default `null`
     */
    onParseError?: ParserErrorHandler | null;
}

//Parser
export class Parser<T extends TreeAdapterTypeMap> {
    options: ParserOptions<T>;
    treeAdapter: TreeAdapter<T>;
    private onParseError: ParserErrorHandler | null;
    private currentToken: Token | null = null;

    constructor(options?: ParserOptions<T>) {
        this.options = {
            scriptingEnabled: true,
            sourceCodeLocationInfo: false,
            ...options,
        };

        this.treeAdapter = this.options.treeAdapter ??= defaultTreeAdapter as TreeAdapter<T>;
        this.onParseError = this.options.onParseError ??= null;

        // Always enable location info if we report parse errors.
        if (this.onParseError) {
            this.options.sourceCodeLocationInfo = true;
        }
    }

    // API
    public parse(html: string): T['document'] {
        const document = this.treeAdapter.createDocument();

        this._bootstrap(document, null);
        this.tokenizer.write(html, true);
        this._runParsingLoop(null);

        return document;
    }

    public parseFragment(html: string, fragmentContext?: T['parentNode'] | null): T['documentFragment'] {
        //NOTE: use <template> element as a fragment context if context element was not provided,
        //so we will parse in "forgiving" manner
        fragmentContext ??= this.treeAdapter.createElement(TN.TEMPLATE, NS.HTML, []);

        //NOTE: create fake element which will be used as 'document' for fragment parsing.
        //This is important for jsdom there 'document' can't be recreated, therefore
        //fragment parsing causes messing of the main `document`.
        const documentMock = this.treeAdapter.createElement('documentmock', NS.HTML, []);

        this._bootstrap(documentMock, fragmentContext);

        if (this.fragmentContextID === $.TEMPLATE) {
            this.tmplInsertionModeStack.unshift(InsertionMode.IN_TEMPLATE);
        }

        this._initTokenizerForFragmentParsing();
        this._insertFakeRootElement();
        this._resetInsertionMode();
        this._findFormInFragmentContext();
        this.tokenizer.write(html, true);
        this._runParsingLoop(null);

        const rootElement = this.treeAdapter.getFirstChild(documentMock) as T['parentNode'];
        const fragment = this.treeAdapter.createDocumentFragment();

        this._adoptNodes(rootElement, fragment);

        return fragment;
    }

    tokenizer!: Tokenizer;
    stopped = false;
    insertionMode = InsertionMode.INITIAL;
    originalInsertionMode = InsertionMode.INITIAL;

    document!: T['document'];
    fragmentContext!: T['element'] | null;
    fragmentContextID = $.UNKNOWN;

    headElement: null | T['element'] = null;
    formElement: null | T['element'] = null;
    pendingScript: null | T['element'] = null;

    openElements!: OpenElementStack<T>;
    activeFormattingElements!: FormattingElementList<T>;
    private _considerForeignContent = false;

    /**
     * The template insertion mode stack is maintained from the left.
     * Ie. the topmost element will always have index 0.
     */
    tmplInsertionModeStack: InsertionMode[] = [];

    pendingCharacterTokens: CharacterToken[] = [];
    hasNonWhitespacePendingCharacterToken = false;

    framesetOk = true;
    skipNextNewLine = false;
    fosterParentingEnabled = false;

    //Bootstrap parser
    _bootstrap(document: T['document'], fragmentContext: T['element'] | null): void {
        this.tokenizer = new Tokenizer(this.options);

        this.stopped = false;

        this.insertionMode = InsertionMode.INITIAL;
        this.originalInsertionMode = InsertionMode.INITIAL;

        this.document = document;
        this.fragmentContext = fragmentContext;
        this.fragmentContextID = fragmentContext ? getTagID(this.treeAdapter.getTagName(fragmentContext)) : $.UNKNOWN;
        this._setContextModes(fragmentContext ?? document, this.fragmentContextID);

        this.headElement = null;
        this.formElement = null;
        this.pendingScript = null;
        this.currentToken = null;

        this.openElements = new OpenElementStack(
            this.document,
            this.treeAdapter,
            this.onItemPush.bind(this),
            this.onItemPop.bind(this)
        );

        this.activeFormattingElements = new FormattingElementList(this.treeAdapter);

        this.tmplInsertionModeStack.length = 0;

        this.pendingCharacterTokens.length = 0;
        this.hasNonWhitespacePendingCharacterToken = false;

        this.framesetOk = true;
        this.skipNextNewLine = false;
        this.fosterParentingEnabled = false;
    }

    //Errors
    _err(token: Token, code: ERR, beforeToken?: boolean): void {
        if (!this.onParseError) return;

        const loc = token.location ?? BASE_LOC;
        const err = {
            code,
            startLine: loc.startLine,
            startCol: loc.startCol,
            startOffset: loc.startOffset,
            endLine: beforeToken ? loc.startLine : loc.endLine,
            endCol: beforeToken ? loc.startCol : loc.endCol,
            endOffset: beforeToken ? loc.startOffset : loc.endOffset,
        };

        this.onParseError(err);
    }

    //Parsing loop
    private _runParsingLoop(scriptHandler: null | ((scriptElement: T['element']) => void)): void {
        while (!this.stopped) {
            const token = this.tokenizer.getNextToken();

            if (token.type === TokenType.HIBERNATION) {
                break;
            }

            if (this.skipNextNewLine) {
                this.skipNextNewLine = false;

                if (
                    token.type === TokenType.WHITESPACE_CHARACTER &&
                    token.chars.charCodeAt(0) === unicode.CODE_POINTS.LINE_FEED
                ) {
                    if (token.chars.length === 1) {
                        continue;
                    }

                    token.chars = token.chars.substr(1);
                }
            }

            this.currentToken = token;

            this._processInputToken(token);

            if (scriptHandler !== null && this.pendingScript) {
                break;
            }
        }
    }

    public runParsingLoopForCurrentChunk(
        writeCallback: null | (() => void),
        scriptHandler: (scriptElement: T['element']) => void
    ): void {
        this._runParsingLoop(scriptHandler);

        if (scriptHandler && this.pendingScript) {
            const script = this.pendingScript;

            this.pendingScript = null;

            scriptHandler(script);

            return;
        }

        writeCallback?.();
    }

    //Text parsing
    private onItemPush(node: T['parentNode'], tid: number, isTop: boolean): void {
        if (isTop && this.openElements.stackTop > 0) this._setContextModes(node, tid);
    }

    private onItemPop(node: T['parentNode'], isTop: boolean): void {
        if (this.options.sourceCodeLocationInfo) {
            this._setEndLocation(node, this.currentToken!);
        }

        if (isTop) {
            let current;
            let currentTagId;

            if (this.openElements.stackTop === 0 && this.fragmentContext) {
                current = this.fragmentContext;
                currentTagId = this.fragmentContextID;
            } else {
                ({ current, currentTagId } = this.openElements);
            }

            this._setContextModes(current, currentTagId);
        }
    }

    private _setContextModes(current: T['parentNode'], tid: number): void {
        const isHTML = current === this.document || this.treeAdapter.getNamespaceURI(current) === NS.HTML;

        this._considerForeignContent = !isHTML;
        this.tokenizer.allowCDATA = !isHTML && !this._isIntegrationPoint(tid, current);
    }

    _switchToTextParsing(
        currentToken: TagToken,
        nextTokenizerState: typeof TokenizerMode[keyof typeof TokenizerMode]
    ): void {
        this._insertElement(currentToken, NS.HTML);
        this.tokenizer.state = nextTokenizerState;
        this.originalInsertionMode = this.insertionMode;
        this.insertionMode = InsertionMode.TEXT;
    }

    switchToPlaintextParsing(): void {
        this.insertionMode = InsertionMode.TEXT;
        this.originalInsertionMode = InsertionMode.IN_BODY;
        this.tokenizer.state = TokenizerMode.PLAINTEXT;
    }

    //Fragment parsing
    _getAdjustedCurrentElement(): T['element'] {
        return this.openElements.stackTop === 0 && this.fragmentContext
            ? this.fragmentContext
            : this.openElements.current;
    }

    _findFormInFragmentContext(): void {
        let node = this.fragmentContext;

        while (node) {
            if (this.treeAdapter.getTagName(node) === TN.FORM) {
                this.formElement = node;
                break;
            }

            node = this.treeAdapter.getParentNode(node);
        }
    }

    private _initTokenizerForFragmentParsing(): void {
        if (!this.fragmentContext || this.treeAdapter.getNamespaceURI(this.fragmentContext) !== NS.HTML) {
            return;
        }

        switch (this.fragmentContextID) {
            case $.TITLE:
            case $.TEXTAREA: {
                this.tokenizer.state = TokenizerMode.RCDATA;
                break;
            }
            case $.STYLE:
            case $.XMP:
            case $.IFRAME:
            case $.NOEMBED:
            case $.NOFRAMES:
            case $.NOSCRIPT: {
                this.tokenizer.state = TokenizerMode.RAWTEXT;
                break;
            }
            case $.SCRIPT: {
                this.tokenizer.state = TokenizerMode.SCRIPT_DATA;
                break;
            }
            case $.PLAINTEXT: {
                this.tokenizer.state = TokenizerMode.PLAINTEXT;
                break;
            }
            default:
            // Do nothing
        }
    }

    //Tree mutation
    _setDocumentType(token: DoctypeToken): void {
        const name = token.name || '';
        const publicId = token.publicId || '';
        const systemId = token.systemId || '';

        this.treeAdapter.setDocumentType(this.document, name, publicId, systemId);

        if (token.location) {
            const documentChildren = this.treeAdapter.getChildNodes(this.document);
            const docTypeNode = documentChildren.find((node) => this.treeAdapter.isDocumentTypeNode(node));

            if (docTypeNode) {
                this.treeAdapter.setNodeSourceCodeLocation(docTypeNode, token.location);
            }
        }
    }

    _attachElementToTree(element: T['element'], location: LocationWithAttributes | null): void {
        if (this.options.sourceCodeLocationInfo) {
            const loc = location && {
                ...location,
                startTag: location,
            };

            this.treeAdapter.setNodeSourceCodeLocation(element, loc);
        }

        if (this._shouldFosterParentOnInsertion()) {
            this._fosterParentElement(element);
        } else {
            const parent = this.openElements.currentTmplContentOrNode;

            this.treeAdapter.appendChild(parent, element);
        }
    }

    _appendElement(token: TagToken, namespaceURI: NS): void {
        const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);

        this._attachElementToTree(element, token.location);
    }

    _insertElement(token: TagToken, namespaceURI: NS): void {
        const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);

        this._attachElementToTree(element, token.location);
        this.openElements.push(element, token.tagID);
    }

    _insertFakeElement(tagName: string, tagID: $): void {
        const element = this.treeAdapter.createElement(tagName, NS.HTML, []);

        this._attachElementToTree(element, null);
        this.openElements.push(element, tagID);
    }

    _insertTemplate(token: TagToken): void {
        const tmpl = this.treeAdapter.createElement(token.tagName, NS.HTML, token.attrs);
        const content = this.treeAdapter.createDocumentFragment();

        this.treeAdapter.setTemplateContent(tmpl, content);
        this._attachElementToTree(tmpl, token.location);
        this.openElements.push(tmpl, token.tagID);
        if (this.options.sourceCodeLocationInfo) this.treeAdapter.setNodeSourceCodeLocation(content, null);
    }

    _insertFakeRootElement(): void {
        const element = this.treeAdapter.createElement(TN.HTML, NS.HTML, []);
        if (this.options.sourceCodeLocationInfo) this.treeAdapter.setNodeSourceCodeLocation(element, null);

        this.treeAdapter.appendChild(this.openElements.current, element);
        this.openElements.push(element, $.HTML);
    }

    _appendCommentNode(token: CommentToken, parent: T['parentNode']): void {
        const commentNode = this.treeAdapter.createCommentNode(token.data);

        this.treeAdapter.appendChild(parent, commentNode);
        if (this.options.sourceCodeLocationInfo) {
            this.treeAdapter.setNodeSourceCodeLocation(commentNode, token.location);
        }
    }

    _insertCharacters(token: CharacterToken): void {
        let parent;
        let beforeElement;

        if (this._shouldFosterParentOnInsertion()) {
            ({ parent, beforeElement } = this._findFosterParentingLocation());

            if (beforeElement) {
                this.treeAdapter.insertTextBefore(parent, token.chars, beforeElement);
            } else {
                this.treeAdapter.insertText(parent, token.chars);
            }
        } else {
            parent = this.openElements.currentTmplContentOrNode;

            this.treeAdapter.insertText(parent, token.chars);
        }

        if (!token.location) return;

        const siblings = this.treeAdapter.getChildNodes(parent);
        const textNodeIdx = beforeElement ? siblings.lastIndexOf(beforeElement) : siblings.length;
        const textNode = siblings[textNodeIdx - 1];

        //NOTE: if we have location assigned by another token, then just update end position
        const tnLoc = this.treeAdapter.getNodeSourceCodeLocation(textNode);

        if (tnLoc) {
            const { endLine, endCol, endOffset } = token.location;
            this.treeAdapter.updateNodeSourceCodeLocation(textNode, { endLine, endCol, endOffset });
        } else if (this.options.sourceCodeLocationInfo) {
            this.treeAdapter.setNodeSourceCodeLocation(textNode, token.location);
        }
    }

    _adoptNodes(donor: T['parentNode'], recipient: T['parentNode']): void {
        for (let child = this.treeAdapter.getFirstChild(donor); child; child = this.treeAdapter.getFirstChild(donor)) {
            this.treeAdapter.detachNode(child);
            this.treeAdapter.appendChild(recipient, child);
        }
    }

    _setEndLocation(element: T['element'], closingToken: Token): void {
        if (this.treeAdapter.getNodeSourceCodeLocation(element) && closingToken.location) {
            const ctLoc = closingToken.location;
            const tn = this.treeAdapter.getTagName(element);

            // NOTE: For cases like <p> <p> </p> - First 'p' closes without a closing
            // tag and for cases like <td> <p> </td> - 'p' closes without a closing tag.
            const isClosingEndTag = closingToken.type === TokenType.END_TAG && tn === closingToken.tagName;
            const endLoc: Partial<ElementLocation> = {};
            if (isClosingEndTag) {
                endLoc.endTag = { ...ctLoc };
                endLoc.endLine = ctLoc.endLine;
                endLoc.endCol = ctLoc.endCol;
                endLoc.endOffset = ctLoc.endOffset;
            } else {
                endLoc.endLine = ctLoc.startLine;
                endLoc.endCol = ctLoc.startCol;
                endLoc.endOffset = ctLoc.startOffset;
            }

            this.treeAdapter.updateNodeSourceCodeLocation(element, endLoc);
        }
    }

    //Token processing
    private _shouldProcessTokenInForeignContent(token: Token): boolean {
        let current: T['parentNode'];
        let currentTagId: number;

        if (this.openElements.stackTop === 0 && this.fragmentContext) {
            current = this.fragmentContext;
            currentTagId = this.fragmentContextID;
        } else {
            ({ current, currentTagId } = this.openElements);
        }

        const ns = this.treeAdapter.getNamespaceURI(current);

        //NOTE: We won't get here with current === document, or ns === NS.HTML

        if (
            token.type === TokenType.START_TAG &&
            token.tagID === $.SVG &&
            this.treeAdapter.getTagName(current) === TN.ANNOTATION_XML &&
            ns === NS.MATHML
        ) {
            return false;
        }

        const isCharacterToken =
            token.type === TokenType.CHARACTER ||
            token.type === TokenType.NULL_CHARACTER ||
            token.type === TokenType.WHITESPACE_CHARACTER;

        const isMathMLTextStartTag =
            token.type === TokenType.START_TAG && token.tagID !== $.MGLYPH && token.tagID !== $.MALIGNMARK;

        if ((isMathMLTextStartTag || isCharacterToken) && this._isIntegrationPoint(currentTagId, current, NS.MATHML)) {
            return false;
        }

        if (
            (token.type === TokenType.START_TAG || isCharacterToken) &&
            this._isIntegrationPoint(currentTagId, current, NS.HTML)
        ) {
            return false;
        }

        return token.type !== TokenType.EOF;
    }

    _processToken(token: Token): void {
        switch (this.insertionMode) {
            case InsertionMode.INITIAL: {
                modeInitial(this, token);
                break;
            }
            case InsertionMode.BEFORE_HTML: {
                modeBeforeHtml(this, token);
                break;
            }
            case InsertionMode.BEFORE_HEAD: {
                modeBeforeHead(this, token);
                break;
            }
            case InsertionMode.IN_HEAD: {
                modeInHead(this, token);
                break;
            }
            case InsertionMode.IN_HEAD_NO_SCRIPT: {
                modeInHeadNoScript(this, token);
                break;
            }
            case InsertionMode.AFTER_HEAD: {
                modeAfterHead(this, token);
                break;
            }
            case InsertionMode.IN_BODY: {
                modeInBody(this, token);
                break;
            }
            case InsertionMode.TEXT: {
                modeText(this, token);
                break;
            }
            case InsertionMode.IN_TABLE: {
                modeInTable(this, token);
                break;
            }
            case InsertionMode.IN_TABLE_TEXT: {
                modeInTableText(this, token);
                break;
            }
            case InsertionMode.IN_CAPTION: {
                modeInCaption(this, token);
                break;
            }
            case InsertionMode.IN_COLUMN_GROUP: {
                modeInColumnGroup(this, token);
                break;
            }
            case InsertionMode.IN_TABLE_BODY: {
                modeInTableBody(this, token);
                break;
            }
            case InsertionMode.IN_ROW: {
                modeInRow(this, token);
                break;
            }
            case InsertionMode.IN_CELL: {
                modeInCell(this, token);
                break;
            }
            case InsertionMode.IN_SELECT: {
                modeInSelect(this, token);
                break;
            }
            case InsertionMode.IN_SELECT_IN_TABLE: {
                modeInSelectInTable(this, token);
                break;
            }
            case InsertionMode.IN_TEMPLATE: {
                modeInTemplate(this, token);
                break;
            }
            case InsertionMode.AFTER_BODY: {
                modeAfterBody(this, token);
                break;
            }
            case InsertionMode.IN_FRAMESET: {
                modeInFrameset(this, token);
                break;
            }
            case InsertionMode.AFTER_FRAMESET: {
                modeAfterFrameset(this, token);
                break;
            }
            case InsertionMode.AFTER_AFTER_BODY: {
                modeAfterAfterBody(this, token);
                break;
            }
            case InsertionMode.AFTER_AFTER_FRAMESET: {
                modeAfterAfterFrameset(this, token);
                break;
            }
            default:
            // Do nothing
        }
    }

    _processTokenInForeignContent(token: Token): void {
        switch (token.type) {
            case TokenType.CHARACTER: {
                characterInForeignContent(this, token);
                break;
            }
            case TokenType.NULL_CHARACTER: {
                nullCharacterInForeignContent(this, token);
                break;
            }
            case TokenType.WHITESPACE_CHARACTER: {
                this._insertCharacters(token);
                break;
            }
            case TokenType.COMMENT: {
                appendComment(this, token);
                break;
            }
            case TokenType.START_TAG: {
                startTagInForeignContent(this, token);
                break;
            }
            case TokenType.END_TAG: {
                endTagInForeignContent(this, token);
                break;
            }
            default:
            // Do nothing
        }
    }

    _processInputToken(token: Token): void {
        if (this._considerForeignContent && this._shouldProcessTokenInForeignContent(token)) {
            this._processTokenInForeignContent(token);
        } else {
            this._processToken(token);
        }

        if (token.type === TokenType.START_TAG && token.selfClosing && !token.ackSelfClosing) {
            this._err(token, ERR.nonVoidHtmlElementStartTagWithTrailingSolidus);
        }
    }

    //Integration points
    _isIntegrationPoint(tid: $, element: T['element'], foreignNS?: NS): boolean {
        const ns = this.treeAdapter.getNamespaceURI(element);
        const attrs = this.treeAdapter.getAttrList(element);

        return foreignContent.isIntegrationPoint(tid, ns, attrs, foreignNS);
    }

    //Active formatting elements reconstruction
    _reconstructActiveFormattingElements(): void {
        const listLength = this.activeFormattingElements.entries.length;

        if (listLength) {
            const endIndex = this.activeFormattingElements.entries.findIndex(
                (entry) => entry.type === EntryType.Marker || this.openElements.contains(entry.element)
            );

            const unopenIdx = endIndex < 0 ? listLength - 1 : endIndex - 1;

            for (let i = unopenIdx; i >= 0; i--) {
                const entry = this.activeFormattingElements.entries[i] as ElementEntry<T>;
                this._insertElement(entry.token, this.treeAdapter.getNamespaceURI(entry.element));
                entry.element = this.openElements.current;
            }
        }
    }

    //Close elements
    _closeTableCell(): void {
        this.openElements.generateImpliedEndTags();
        this.openElements.popUntilTableCellPopped();
        this.activeFormattingElements.clearToLastMarker();
        this.insertionMode = InsertionMode.IN_ROW;
    }

    _closePElement(): void {
        this.openElements.generateImpliedEndTagsWithExclusion(TN.P);
        this.openElements.popUntilTagNamePopped($.P);
    }

    //Insertion modes
    _resetInsertionMode(): void {
        for (let i = this.openElements.stackTop; i >= 0; i--) {
            //Insertion mode reset map
            switch (i === 0 && this.fragmentContext ? this.fragmentContextID : this.openElements.tagIDs[i]) {
                case $.TR:
                    this.insertionMode = InsertionMode.IN_ROW;
                    return;
                case $.TBODY:
                case $.THEAD:
                case $.TFOOT:
                    this.insertionMode = InsertionMode.IN_TABLE_BODY;
                    return;
                case $.CAPTION:
                    this.insertionMode = InsertionMode.IN_CAPTION;
                    return;
                case $.COLGROUP:
                    this.insertionMode = InsertionMode.IN_COLUMN_GROUP;
                    return;
                case $.TABLE:
                    this.insertionMode = InsertionMode.IN_TABLE;
                    return;
                case $.BODY:
                    this.insertionMode = InsertionMode.IN_BODY;
                    return;
                case $.FRAMESET:
                    this.insertionMode = InsertionMode.IN_FRAMESET;
                    return;
                case $.SELECT:
                    this._resetInsertionModeForSelect(i);
                    return;
                case $.TEMPLATE:
                    this.insertionMode = this.tmplInsertionModeStack[0];
                    return;
                case $.HTML:
                    this.insertionMode = this.headElement ? InsertionMode.AFTER_HEAD : InsertionMode.BEFORE_HEAD;
                    return;
                case $.TD:
                case $.TH:
                    if (i > 0) {
                        this.insertionMode = InsertionMode.IN_CELL;
                        return;
                    }
                    break;
                case $.HEAD:
                    if (i > 0) {
                        this.insertionMode = InsertionMode.IN_HEAD;
                        return;
                    }
                    break;
            }
        }

        this.insertionMode = InsertionMode.IN_BODY;
    }

    _resetInsertionModeForSelect(selectIdx: number): void {
        if (selectIdx > 0) {
            for (let i = selectIdx - 1; i > 0; i--) {
                const tn = this.openElements.tagIDs[i];

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

    //Foster parenting
    _isElementCausesFosterParenting(tn: $): boolean {
        return TABLE_STRUCTURE_TAGS.has(tn);
    }

    _shouldFosterParentOnInsertion(): boolean {
        return this.fosterParentingEnabled && this._isElementCausesFosterParenting(this.openElements.currentTagId);
    }

    _findFosterParentingLocation(): { parent: T['parentNode']; beforeElement: T['element'] | null } {
        for (let i = this.openElements.stackTop; i >= 0; i--) {
            const openElement = this.openElements.items[i];

            switch (this.openElements.tagIDs[i]) {
                case $.TEMPLATE:
                    if (this.treeAdapter.getNamespaceURI(openElement) === NS.HTML) {
                        return { parent: this.treeAdapter.getTemplateContent(openElement), beforeElement: null };
                    }
                    break;
                case $.TABLE: {
                    const parent = this.treeAdapter.getParentNode(openElement);

                    if (parent) {
                        return { parent, beforeElement: openElement };
                    }

                    return { parent: this.openElements.items[i - 1], beforeElement: null };
                }
                default:
                // Do nothing
            }
        }

        return { parent: this.openElements.items[0], beforeElement: null };
    }

    _fosterParentElement(element: T['element']): void {
        const location = this._findFosterParentingLocation();

        if (location.beforeElement) {
            this.treeAdapter.insertBefore(location.parent, element, location.beforeElement);
        } else {
            this.treeAdapter.appendChild(location.parent, element);
        }
    }

    //Special elements
    _isSpecialElement(element: T['element'], id: $): boolean {
        const ns = this.treeAdapter.getNamespaceURI(element);

        return SPECIAL_ELEMENTS[ns].has(id);
    }
}

//Adoption agency algorithm
//(see: http://www.whatwg.org/specs/web-apps/current-work/multipage/tree-construction.html#adoptionAgency)
//------------------------------------------------------------------

//Steps 5-8 of the algorithm
function aaObtainFormattingElementEntry<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    token: TagToken
): ElementEntry<T> | null {
    let formattingElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName(token.tagName);

    if (formattingElementEntry) {
        if (!p.openElements.contains(formattingElementEntry.element)) {
            p.activeFormattingElements.removeEntry(formattingElementEntry);
            formattingElementEntry = null;
        } else if (!p.openElements.hasInScope(token.tagID)) {
            formattingElementEntry = null;
        }
    } else {
        genericEndTagInBody(p, token);
    }

    return formattingElementEntry;
}

//Steps 9 and 10 of the algorithm
function aaObtainFurthestBlock<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    formattingElementEntry: ElementEntry<T>
): T['parentNode'] | null {
    let furthestBlock = null;
    let idx = p.openElements.stackTop;

    for (; idx >= 0; idx--) {
        const element = p.openElements.items[idx];

        if (element === formattingElementEntry.element) {
            break;
        }

        if (p._isSpecialElement(element, p.openElements.tagIDs[idx])) {
            furthestBlock = element;
        }
    }

    if (!furthestBlock) {
        p.openElements.shortenToLength(idx < 0 ? 0 : idx);
        p.activeFormattingElements.removeEntry(formattingElementEntry);
    }

    return furthestBlock;
}

//Step 13 of the algorithm
function aaInnerLoop<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    furthestBlock: T['element'],
    formattingElement: T['element']
): T['element'] {
    let lastElement = furthestBlock;
    let nextElement = p.openElements.getCommonAncestor(furthestBlock) as T['element'];

    for (let i = 0, element = nextElement; element !== formattingElement; i++, element = nextElement) {
        //NOTE: store next element for the next loop iteration (it may be deleted from the stack by step 9.5)
        nextElement = p.openElements.getCommonAncestor(element) as T['element'];

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
function aaRecreateElementFromEntry<T extends TreeAdapterTypeMap>(
    p: Parser<T>,
    elementEntry: ElementEntry<T>
): T['element'] {
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
): void {
    const tn = p.treeAdapter.getTagName(commonAncestor);
    const tid = getTagID(tn);

    if (p._isElementCausesFosterParenting(tid)) {
        p._fosterParentElement(lastElement);
    } else {
        const ns = p.treeAdapter.getNamespaceURI(commonAncestor);

        if (tid === $.TEMPLATE && ns === NS.HTML) {
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
): void {
    const ns = p.treeAdapter.getNamespaceURI(formattingElementEntry.element);
    const { token } = formattingElementEntry;
    const newElement = p.treeAdapter.createElement(token.tagName, ns, token.attrs);

    p._adoptNodes(furthestBlock, newElement);
    p.treeAdapter.appendChild(furthestBlock, newElement);

    p.activeFormattingElements.insertElementAfterBookmark(newElement, token);
    p.activeFormattingElements.removeEntry(formattingElementEntry);

    p.openElements.remove(formattingElementEntry.element);
    p.openElements.insertAfter(furthestBlock, newElement, token.tagID);
}

//Algorithm entry point
function callAdoptionAgency<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    for (let i = 0; i < AA_OUTER_LOOP_ITER; i++) {
        const formattingElementEntry = aaObtainFormattingElementEntry(p, token);

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
        if (commonAncestor) aaInsertLastNodeInCommonAncestor(p, commonAncestor, lastElement);
        aaReplaceFormattingElement(p, furthestBlock, formattingElementEntry);
    }
}

//Generic token handlers
//------------------------------------------------------------------
function appendComment<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken): void {
    p._appendCommentNode(token, p.openElements.currentTmplContentOrNode);
}

function appendCommentToRootHtmlElement<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken): void {
    p._appendCommentNode(token, p.openElements.items[0]);
}

function appendCommentToDocument<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CommentToken): void {
    p._appendCommentNode(token, p.document);
}

function stopParsing<T extends TreeAdapterTypeMap>(p: Parser<T>, token: EOFToken): void {
    p.stopped = true;

    if (token.location) {
        // NOTE: generate location info for elements
        // that remains on open element stack
        for (let i = p.openElements.stackTop; i >= 0; i--) {
            p._setEndLocation(p.openElements.items[i], token);
        }
    }
}

// The "initial" insertion mode
//------------------------------------------------------------------
function modeInitial<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.DOCTYPE: {
            doctypeInInitialMode(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            // Ignore token
            break;
        }
        default: {
            tokenInInitialMode(p, token);
        }
    }
}

function doctypeInInitialMode<T extends TreeAdapterTypeMap>(p: Parser<T>, token: DoctypeToken): void {
    p._setDocumentType(token);

    const mode = token.forceQuirks ? DOCUMENT_MODE.QUIRKS : doctype.getDocumentMode(token);

    if (!doctype.isConforming(token)) {
        p._err(token, ERR.nonConformingDoctype);
    }

    p.treeAdapter.setDocumentMode(p.document, mode);

    p.insertionMode = InsertionMode.BEFORE_HTML;
}

function tokenInInitialMode<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p._err(token, ERR.missingDoctype, true);
    p.treeAdapter.setDocumentMode(p.document, DOCUMENT_MODE.QUIRKS);
    p.insertionMode = InsertionMode.BEFORE_HTML;
    modeBeforeHtml(p, token);
}

// The "before html" insertion mode
//------------------------------------------------------------------
function modeBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.EOF: {
            tokenBeforeHtml(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagBeforeHtml(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagBeforeHtml(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.HTML) {
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.BEFORE_HEAD;
    } else {
        tokenBeforeHtml(p, token);
    }
}

function endTagBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (tn === $.HTML || tn === $.HEAD || tn === $.BODY || tn === $.BR) {
        tokenBeforeHtml(p, token);
    }
}

function tokenBeforeHtml<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p._insertFakeRootElement();
    p.insertionMode = InsertionMode.BEFORE_HEAD;
    modeBeforeHead(p, token);
}

// The "before head" insertion mode
//------------------------------------------------------------------
function modeBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.EOF: {
            tokenBeforeHead(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.DOCTYPE: {
            p._err(token, ERR.misplacedDoctype);
            break;
        }
        case TokenType.START_TAG: {
            startTagBeforeHead(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagBeforeHead(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.HTML: {
            startTagInBody(p, token);
            break;
        }
        case $.HEAD: {
            p._insertElement(token, NS.HTML);
            p.headElement = p.openElements.current;
            p.insertionMode = InsertionMode.IN_HEAD;
            break;
        }
        default: {
            tokenBeforeHead(p, token);
        }
    }
}

function endTagBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (tn === $.HEAD || tn === $.BODY || tn === $.HTML || tn === $.BR) {
        tokenBeforeHead(p, token);
    } else {
        p._err(token, ERR.endTagWithoutMatchingOpenElement);
    }
}

function tokenBeforeHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p._insertFakeElement(TN.HEAD, $.HEAD);
    p.headElement = p.openElements.current;
    p.insertionMode = InsertionMode.IN_HEAD;
    modeInHead(p, token);
}

// The "in head" insertion mode
//------------------------------------------------------------------
function modeInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.EOF: {
            tokenInHead(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.DOCTYPE: {
            p._err(token, ERR.misplacedDoctype);
            break;
        }
        case TokenType.START_TAG: {
            startTagInHead(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInHead(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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
            p._switchToTextParsing(token, TokenizerMode.RCDATA);
            break;
        }
        case $.NOSCRIPT: {
            if (p.options.scriptingEnabled) {
                p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
            } else {
                p._insertElement(token, NS.HTML);
                p.insertionMode = InsertionMode.IN_HEAD_NO_SCRIPT;
            }
            break;
        }
        case $.NOFRAMES:
        case $.STYLE: {
            p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
            break;
        }
        case $.SCRIPT: {
            p._switchToTextParsing(token, TokenizerMode.SCRIPT_DATA);
            break;
        }
        case $.TEMPLATE: {
            p._insertTemplate(token);
            p.activeFormattingElements.insertMarker();
            p.framesetOk = false;
            p.insertionMode = InsertionMode.IN_TEMPLATE;
            p.tmplInsertionModeStack.unshift(InsertionMode.IN_TEMPLATE);
            break;
        }
        case $.HEAD: {
            p._err(token, ERR.misplacedStartTagForHeadElement);
            break;
        }
        default: {
            tokenInHead(p, token);
        }
    }
}

function endTagInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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

                if (p.openElements.currentTagId !== $.TEMPLATE) {
                    p._err(token, ERR.closingOfElementWithOpenChildElements);
                }

                p.openElements.popUntilTagNamePopped($.TEMPLATE);
                p.activeFormattingElements.clearToLastMarker();
                p.tmplInsertionModeStack.shift();
                p._resetInsertionMode();
            } else {
                p._err(token, ERR.endTagWithoutMatchingOpenElement);
            }
            break;
        }
        default: {
            p._err(token, ERR.endTagWithoutMatchingOpenElement);
        }
    }
}

function tokenInHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p.openElements.pop();
    p.insertionMode = InsertionMode.AFTER_HEAD;
    modeAfterHead(p, token);
}

// The "in head no script" insertion mode
//------------------------------------------------------------------
function modeInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.EOF: {
            tokenInHeadNoScript(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.DOCTYPE: {
            p._err(token, ERR.misplacedDoctype);
            break;
        }
        case TokenType.START_TAG: {
            startTagInHeadNoScript(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInHeadNoScript(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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
            p._err(token, ERR.nestedNoscriptInHead);
            break;
        }
        default: {
            tokenInHeadNoScript(p, token);
        }
    }
}

function endTagInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.NOSCRIPT: {
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_HEAD;
            break;
        }
        case $.BR: {
            tokenInHeadNoScript(p, token);
            break;
        }
        default: {
            p._err(token, ERR.endTagWithoutMatchingOpenElement);
        }
    }
}

function tokenInHeadNoScript<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    const errCode = token.type === TokenType.EOF ? ERR.openElementsLeftAfterEof : ERR.disallowedContentInNoscriptInHead;

    p._err(token, errCode);
    p.openElements.pop();
    p.insertionMode = InsertionMode.IN_HEAD;
    modeInHead(p, token);
}

// The "after head" insertion mode
//------------------------------------------------------------------
function modeAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.EOF: {
            tokenAfterHead(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.DOCTYPE: {
            p._err(token, ERR.misplacedDoctype);
            break;
        }
        case TokenType.START_TAG: {
            startTagAfterHead(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagAfterHead(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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
        case $.BASE:
        case $.BASEFONT:
        case $.BGSOUND:
        case $.LINK:
        case $.META:
        case $.NOFRAMES:
        case $.SCRIPT:
        case $.STYLE:
        case $.TEMPLATE:
        case $.TITLE: {
            p._err(token, ERR.abandonedHeadElementChild);
            p.openElements.push(p.headElement!, $.HEAD);
            startTagInHead(p, token);
            p.openElements.remove(p.headElement!);
            break;
        }
        case $.HEAD: {
            p._err(token, ERR.misplacedStartTagForHeadElement);
            break;
        }
        default: {
            tokenAfterHead(p, token);
        }
    }
}

function endTagAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.BODY:
        case $.HTML:
        case $.BR: {
            tokenAfterHead(p, token);
            break;
        }
        case $.TEMPLATE: {
            endTagInHead(p, token);
            break;
        }
        default: {
            p._err(token, ERR.endTagWithoutMatchingOpenElement);
        }
    }
}

function tokenAfterHead<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p._insertFakeElement(TN.BODY, $.BODY);
    p.insertionMode = InsertionMode.IN_BODY;
    modeInBody(p, token);
}

// The "in body" insertion mode
//------------------------------------------------------------------
function modeInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER: {
            characterInBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInBody(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInBody(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function whitespaceCharacterInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    p._reconstructActiveFormattingElements();
    p._insertCharacters(token);
}

function characterInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    p._reconstructActiveFormattingElements();
    p._insertCharacters(token);
    p.framesetOk = false;
}

function htmlStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.tmplCount === 0) {
        p.treeAdapter.adoptAttributes(p.openElements.items[0], token.attrs);
    }
}

function bodyStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();

    if (bodyElement && p.openElements.tmplCount === 0) {
        p.framesetOk = false;
        p.treeAdapter.adoptAttributes(bodyElement, token.attrs);
    }
}

function framesetStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();

    if (p.framesetOk && bodyElement) {
        p.treeAdapter.detachNode(bodyElement);
        p.openElements.popAllUpToHtmlElement();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_FRAMESET;
    }
}

function addressStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
}

function numberedHeaderStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    if (isNumberedHeader(p.openElements.currentTagId)) {
        p.openElements.pop();
    }

    p._insertElement(token, NS.HTML);
}

function preStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
    //on to the next one. (Newlines at the start of pre blocks are ignored as an authoring convenience.)
    p.skipNextNewLine = true;
    p.framesetOk = false;
}

function formStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
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

function listItemStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.framesetOk = false;

    const tn = token.tagID;

    for (let i = p.openElements.stackTop; i >= 0; i--) {
        const element = p.openElements.items[i];
        const elementTn = p.treeAdapter.getTagName(element);
        let elementId = p.openElements.tagIDs[i];
        let closeTn = null;

        if (tn === $.LI && elementId === $.LI) {
            closeTn = TN.LI;
            elementId = $.LI;
        } else if ((tn === $.DD || tn === $.DT) && (elementId === $.DD || elementId === $.DT)) {
            closeTn = elementTn;
        }

        if (closeTn) {
            p.openElements.generateImpliedEndTagsWithExclusion(closeTn);
            p.openElements.popUntilTagNamePopped(elementId);
            break;
        }

        if (
            elementId !== $.ADDRESS &&
            elementId !== $.DIV &&
            elementId !== $.P &&
            p._isSpecialElement(element, elementId)
        ) {
            break;
        }
    }

    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
}

function plaintextStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    p.tokenizer.state = TokenizerMode.PLAINTEXT;
}

function buttonStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInScope($.BUTTON)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped($.BUTTON);
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.framesetOk = false;
}

function aStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const activeElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName(TN.A);

    if (activeElementEntry) {
        callAdoptionAgency(p, token);
        p.openElements.remove(activeElementEntry.element);
        p.activeFormattingElements.removeEntry(activeElementEntry);
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function bStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function nobrStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();

    if (p.openElements.hasInScope($.NOBR)) {
        callAdoptionAgency(p, token);
        p._reconstructActiveFormattingElements();
    }

    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.pushElement(p.openElements.current, token);
}

function appletStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
    p.activeFormattingElements.insertMarker();
    p.framesetOk = false;
}

function tableStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.treeAdapter.getDocumentMode(p.document) !== DOCUMENT_MODE.QUIRKS && p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._insertElement(token, NS.HTML);
    p.framesetOk = false;
    p.insertionMode = InsertionMode.IN_TABLE;
}

function areaStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();
    p._appendElement(token, NS.HTML);
    p.framesetOk = false;
    token.ackSelfClosing = true;
}

function isHiddenInput(token: TagToken): boolean {
    const inputType = getTokenAttr(token, ATTRS.TYPE);

    return inputType != null && inputType.toLowerCase() === HIDDEN_INPUT_TYPE;
}

function inputStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();
    p._appendElement(token, NS.HTML);

    if (!isHiddenInput(token)) {
        p.framesetOk = false;
    }

    token.ackSelfClosing = true;
}

function paramStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._appendElement(token, NS.HTML);
    token.ackSelfClosing = true;
}

function hrStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._appendElement(token, NS.HTML);
    p.framesetOk = false;
    token.ackSelfClosing = true;
}

function imageStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    token.tagName = TN.IMG;
    token.tagID = $.IMG;
    areaStartTagInBody(p, token);
}

function textareaStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._insertElement(token, NS.HTML);
    //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
    //on to the next one. (Newlines at the start of textarea elements are ignored as an authoring convenience.)
    p.skipNextNewLine = true;
    p.tokenizer.state = TokenizerMode.RCDATA;
    p.originalInsertionMode = p.insertionMode;
    p.framesetOk = false;
    p.insertionMode = InsertionMode.TEXT;
}

function xmpStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInButtonScope($.P)) {
        p._closePElement();
    }

    p._reconstructActiveFormattingElements();
    p.framesetOk = false;
    p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
}

function iframeStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.framesetOk = false;
    p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
}

//NOTE: here we assume that we always act as an user agent with enabled plugins, so we parse
//<noembed> as a rawtext.
function noembedStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
}

function selectStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
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

function optgroupStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.currentTagId === $.OPTION) {
        p.openElements.pop();
    }

    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
}

function rbStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInScope($.RUBY)) {
        p.openElements.generateImpliedEndTags();
    }

    p._insertElement(token, NS.HTML);
}

function rtStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInScope($.RUBY)) {
        p.openElements.generateImpliedEndTagsWithExclusion(TN.RTC);
    }

    p._insertElement(token, NS.HTML);
}

function mathStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
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

function svgStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
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

function genericStartTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p._reconstructActiveFormattingElements();
    p._insertElement(token, NS.HTML);
}

function startTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.I:
        case $.S:
        case $.B:
        case $.U:
        case $.EM:
        case $.TT:
        case $.BIG:
        case $.CODE:
        case $.FONT:
        case $.SMALL:
        case $.STRIKE:
        case $.STRONG: {
            bStartTagInBody(p, token);
            break;
        }
        case $.A: {
            aStartTagInBody(p, token);
            break;
        }
        case $.H1:
        case $.H2:
        case $.H3:
        case $.H4:
        case $.H5:
        case $.H6: {
            numberedHeaderStartTagInBody(p, token);
            break;
        }
        case $.P:
        case $.DL:
        case $.OL:
        case $.UL:
        case $.DIV:
        case $.DIR:
        case $.NAV:
        case $.MAIN:
        case $.MENU:
        case $.ASIDE:
        case $.CENTER:
        case $.FIGURE:
        case $.FOOTER:
        case $.HEADER:
        case $.HGROUP:
        case $.DIALOG:
        case $.DETAILS:
        case $.ADDRESS:
        case $.ARTICLE:
        case $.SECTION:
        case $.SUMMARY:
        case $.FIELDSET:
        case $.BLOCKQUOTE:
        case $.FIGCAPTION: {
            addressStartTagInBody(p, token);
            break;
        }
        case $.LI:
        case $.DD:
        case $.DT: {
            listItemStartTagInBody(p, token);
            break;
        }
        case $.BR:
        case $.IMG:
        case $.WBR:
        case $.AREA:
        case $.EMBED:
        case $.KEYGEN: {
            areaStartTagInBody(p, token);
            break;
        }
        case $.HR: {
            hrStartTagInBody(p, token);
            break;
        }
        case $.RB:
        case $.RTC: {
            rbStartTagInBody(p, token);
            break;
        }
        case $.RT:
        case $.RP: {
            rtStartTagInBody(p, token);
            break;
        }
        case $.PRE:
        case $.LISTING: {
            preStartTagInBody(p, token);
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
        case $.HTML: {
            htmlStartTagInBody(p, token);
            break;
        }
        case $.BASE:
        case $.LINK:
        case $.META:
        case $.STYLE:
        case $.TITLE:
        case $.SCRIPT:
        case $.BGSOUND:
        case $.BASEFONT:
        case $.TEMPLATE: {
            startTagInHead(p, token);
            break;
        }
        case $.BODY: {
            bodyStartTagInBody(p, token);
            break;
        }
        case $.FORM: {
            formStartTagInBody(p, token);
            break;
        }
        case $.NOBR: {
            nobrStartTagInBody(p, token);
            break;
        }
        case $.MATH: {
            mathStartTagInBody(p, token);
            break;
        }
        case $.TABLE: {
            tableStartTagInBody(p, token);
            break;
        }
        case $.INPUT: {
            inputStartTagInBody(p, token);
            break;
        }
        case $.PARAM:
        case $.TRACK:
        case $.SOURCE: {
            paramStartTagInBody(p, token);
            break;
        }
        case $.IMAGE: {
            imageStartTagInBody(p, token);
            break;
        }
        case $.BUTTON: {
            buttonStartTagInBody(p, token);
            break;
        }
        case $.APPLET:
        case $.OBJECT:
        case $.MARQUEE: {
            appletStartTagInBody(p, token);
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
        case $.OPTION:
        case $.OPTGROUP: {
            optgroupStartTagInBody(p, token);
            break;
        }
        case $.NOEMBED: {
            noembedStartTagInBody(p, token);
            break;
        }
        case $.FRAMESET: {
            framesetStartTagInBody(p, token);
            break;
        }
        case $.TEXTAREA: {
            textareaStartTagInBody(p, token);
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
        case $.PLAINTEXT: {
            plaintextStartTagInBody(p, token);
            break;
        }

        case $.COL:
        case $.TH:
        case $.TD:
        case $.TR:
        case $.HEAD:
        case $.FRAME:
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD:
        case $.CAPTION:
        case $.COLGROUP: {
            // Ignore token
            break;
        }
        default: {
            genericStartTagInBody(p, token);
        }
    }
}

function bodyEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInScope($.BODY)) {
        p.insertionMode = InsertionMode.AFTER_BODY;

        //NOTE: <body> is never popped from the stack, so we need to updated
        //the end location explicitly.
        if (p.options.sourceCodeLocationInfo) {
            const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();
            if (bodyElement) {
                p._setEndLocation(bodyElement, token);
            }
        }
    }
}

function htmlEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInScope($.BODY)) {
        p.insertionMode = InsertionMode.AFTER_BODY;
        modeAfterBody(p, token);
    }
}

function addressEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped(tn);
    }
}

function formEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>): void {
    const inTemplate = p.openElements.tmplCount > 0;
    const { formElement } = p;

    if (!inTemplate) {
        p.formElement = null;
    }

    if ((formElement || inTemplate) && p.openElements.hasInScope($.FORM)) {
        p.openElements.generateImpliedEndTags();

        if (inTemplate) {
            p.openElements.popUntilTagNamePopped($.FORM);
        } else if (formElement) {
            p.openElements.remove(formElement);
        }
    }
}

function pEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>): void {
    if (!p.openElements.hasInButtonScope($.P)) {
        p._insertFakeElement(TN.P, $.P);
    }

    p._closePElement();
}

function liEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>): void {
    if (p.openElements.hasInListItemScope($.LI)) {
        p.openElements.generateImpliedEndTagsWithExclusion(TN.LI);
        p.openElements.popUntilTagNamePopped($.LI);
    }
}

function ddEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTagsWithExclusion(token.tagName);
        p.openElements.popUntilTagNamePopped(tn);
    }
}

function numberedHeaderEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>): void {
    if (p.openElements.hasNumberedHeaderInScope()) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilNumberedHeaderPopped();
    }
}

function appletEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (p.openElements.hasInScope(tn)) {
        p.openElements.generateImpliedEndTags();
        p.openElements.popUntilTagNamePopped(tn);
        p.activeFormattingElements.clearToLastMarker();
    }
}

function brEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>): void {
    p._reconstructActiveFormattingElements();
    p._insertFakeElement(TN.BR, $.BR);
    p.openElements.pop();
    p.framesetOk = false;
}

function genericEndTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagName;
    const tid = token.tagID;

    for (let i = p.openElements.stackTop; i > 0; i--) {
        const element = p.openElements.items[i];
        const elementId = p.openElements.tagIDs[i];

        // Compare the tag name here, as the tag might not be a known tag with an ID.
        if (tid === elementId && (tid !== $.UNKNOWN || p.treeAdapter.getTagName(element) === tn)) {
            p.openElements.generateImpliedEndTagsWithExclusion(tn);
            if (p.openElements.stackTop >= i) p.openElements.shortenToLength(i);
            break;
        }

        if (p._isSpecialElement(element, elementId)) {
            break;
        }
    }
}

function endTagInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.A:
        case $.B:
        case $.I:
        case $.S:
        case $.U:
        case $.EM:
        case $.TT:
        case $.BIG:
        case $.CODE:
        case $.FONT:
        case $.NOBR:
        case $.SMALL:
        case $.STRIKE:
        case $.STRONG: {
            callAdoptionAgency(p, token);
            break;
        }
        case $.P: {
            pEndTagInBody(p);
            break;
        }
        case $.DL:
        case $.UL:
        case $.OL:
        case $.DIR:
        case $.DIV:
        case $.NAV:
        case $.PRE:
        case $.MAIN:
        case $.MENU:
        case $.ASIDE:
        case $.CENTER:
        case $.FIGURE:
        case $.FOOTER:
        case $.HEADER:
        case $.HGROUP:
        case $.DIALOG:
        case $.ADDRESS:
        case $.ARTICLE:
        case $.DETAILS:
        case $.SECTION:
        case $.SUMMARY:
        case $.LISTING:
        case $.FIELDSET:
        case $.BLOCKQUOTE:
        case $.FIGCAPTION: {
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
        case $.H1:
        case $.H2:
        case $.H3:
        case $.H4:
        case $.H5:
        case $.H6: {
            numberedHeaderEndTagInBody(p);
            break;
        }
        case $.BR: {
            brEndTagInBody(p);
            break;
        }
        case $.BODY: {
            bodyEndTagInBody(p, token);
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
        case $.APPLET:
        case $.OBJECT:
        case $.MARQUEE: {
            appletEndTagInBody(p, token);
            break;
        }
        case $.TEMPLATE: {
            endTagInHead(p, token);
            break;
        }
        default: {
            genericEndTagInBody(p, token);
        }
    }
}

function eofInBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: EOFToken): void {
    if (p.tmplInsertionModeStack.length > 0) {
        eofInTemplate(p, token);
    } else {
        stopParsing(p, token);
    }
}

// The "text" insertion mode
//------------------------------------------------------------------
function modeText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInText(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInText(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function endTagInText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.SCRIPT) {
        p.pendingScript = p.openElements.current;
    }

    p.openElements.pop();
    p.insertionMode = p.originalInsertionMode;
}

function eofInText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: EOFToken): void {
    p._err(token, ERR.eofInElementThatCanContainOnlyText);
    p.openElements.pop();
    p.insertionMode = p.originalInsertionMode;
    p._processToken(token);
}

// The "in table" insertion mode
//------------------------------------------------------------------
function modeInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            characterInTable(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInTable(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInTable(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function characterInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    if (TABLE_STRUCTURE_TAGS.has(p.openElements.currentTagId)) {
        p.pendingCharacterTokens = [];
        p.hasNonWhitespacePendingCharacterToken = false;
        p.originalInsertionMode = p.insertionMode;
        p.insertionMode = InsertionMode.IN_TABLE_TEXT;
        modeInTableText(p, token);
    } else {
        tokenInTable(p, token);
    }
}

function captionStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.openElements.clearBackToTableContext();
    p.activeFormattingElements.insertMarker();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_CAPTION;
}

function colgroupStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.openElements.clearBackToTableContext();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
}

function colStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.openElements.clearBackToTableContext();
    p._insertFakeElement(TN.COLGROUP, $.COLGROUP);
    p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
    modeInColumnGroup(p, token);
}

function tbodyStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.openElements.clearBackToTableContext();
    p._insertElement(token, NS.HTML);
    p.insertionMode = InsertionMode.IN_TABLE_BODY;
}

function tdStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    p.openElements.clearBackToTableContext();
    p._insertFakeElement(TN.TBODY, $.TBODY);
    p.insertionMode = InsertionMode.IN_TABLE_BODY;
    modeInTableBody(p, token);
}

function tableStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (p.openElements.hasInTableScope($.TABLE)) {
        p.openElements.popUntilTagNamePopped($.TABLE);
        p._resetInsertionMode();
        p._processToken(token);
    }
}

function inputStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (isHiddenInput(token)) {
        p._appendElement(token, NS.HTML);
    } else {
        tokenInTable(p, token);
    }

    token.ackSelfClosing = true;
}

function formStartTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (!p.formElement && p.openElements.tmplCount === 0) {
        p._insertElement(token, NS.HTML);
        p.formElement = p.openElements.current;
        p.openElements.pop();
    }
}

function startTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.TD:
        case $.TH:
        case $.TR: {
            tdStartTagInTable(p, token);
            break;
        }
        case $.STYLE:
        case $.SCRIPT:
        case $.TEMPLATE: {
            startTagInHead(p, token);
            break;
        }
        case $.COL: {
            colStartTagInTable(p, token);
            break;
        }
        case $.FORM: {
            formStartTagInTable(p, token);
            break;
        }
        case $.TABLE: {
            tableStartTagInTable(p, token);
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
        case $.CAPTION: {
            captionStartTagInTable(p, token);
            break;
        }
        case $.COLGROUP: {
            colgroupStartTagInTable(p, token);
            break;
        }
        default: {
            tokenInTable(p, token);
        }
    }
}

function endTagInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.TABLE: {
            if (p.openElements.hasInTableScope($.TABLE)) {
                p.openElements.popUntilTagNamePopped($.TABLE);
                p._resetInsertionMode();
            }
            break;
        }
        case $.TEMPLATE: {
            endTagInHead(p, token);
            break;
        }
        case $.BODY:
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.HTML:
        case $.TBODY:
        case $.TD:
        case $.TFOOT:
        case $.TH:
        case $.THEAD:
        case $.TR: {
            // Ignore token
            break;
        }
        default: {
            tokenInTable(p, token);
        }
    }
}

function tokenInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    const savedFosterParentingState = p.fosterParentingEnabled;

    p.fosterParentingEnabled = true;
    // Process token in `In Body` mode
    modeInBody(p, token);
    p.fosterParentingEnabled = savedFosterParentingState;
}

// The "in table text" insertion mode
//------------------------------------------------------------------
function modeInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER: {
            characterInTableText(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInTableText(p, token);
            break;
        }
        case TokenType.NULL_CHARACTER: {
            // Ignore token
            break;
        }
        default: {
            tokenInTableText(p, token);
        }
    }
}

function whitespaceCharacterInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    p.pendingCharacterTokens.push(token);
}

function characterInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    p.pendingCharacterTokens.push(token);
    p.hasNonWhitespacePendingCharacterToken = true;
}

function tokenInTableText<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
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
function modeInCaption<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER: {
            characterInBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInCaption(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInCaption(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

const TABLE_VOID_ELEMENTS = new Set([$.CAPTION, $.COL, $.COLGROUP, $.TBODY, $.TD, $.TFOOT, $.TH, $.THEAD, $.TR]);

function startTagInCaption<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (TABLE_VOID_ELEMENTS.has(tn)) {
        if (p.openElements.hasInTableScope($.CAPTION)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped($.CAPTION);
            p.activeFormattingElements.clearToLastMarker();
            p.insertionMode = InsertionMode.IN_TABLE;
            modeInTable(p, token);
        }
    } else {
        startTagInBody(p, token);
    }
}

function endTagInCaption<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    switch (tn) {
        case $.CAPTION:
        case $.TABLE: {
            if (p.openElements.hasInTableScope($.CAPTION)) {
                p.openElements.generateImpliedEndTags();
                p.openElements.popUntilTagNamePopped($.CAPTION);
                p.activeFormattingElements.clearToLastMarker();
                p.insertionMode = InsertionMode.IN_TABLE;

                if (tn === $.TABLE) {
                    modeInTable(p, token);
                }
            }
            break;
        }
        case $.BODY:
        case $.COL:
        case $.COLGROUP:
        case $.HTML:
        case $.TBODY:
        case $.TD:
        case $.TFOOT:
        case $.TH:
        case $.THEAD:
        case $.TR: {
            // Ignore token
            break;
        }
        default: {
            endTagInBody(p, token);
        }
    }
}

// The "in column group" insertion mode
//------------------------------------------------------------------
function modeInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER: {
            tokenInColumnGroup(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInColumnGroup(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInColumnGroup(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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

function endTagInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.COLGROUP: {
            if (p.openElements.currentTagId === $.COLGROUP) {
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE;
            }
            break;
        }
        case $.TEMPLATE: {
            endTagInHead(p, token);
            break;
        }
        case $.COL: {
            // Ignore token
            break;
        }
        default: {
            tokenInColumnGroup(p, token);
        }
    }
}

function tokenInColumnGroup<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    if (p.openElements.currentTagId === $.COLGROUP) {
        p.openElements.pop();
        p.insertionMode = InsertionMode.IN_TABLE;
        modeInTable(p, token);
    }
}

// The "in table body" insertion mode
//------------------------------------------------------------------
function modeInTableBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            characterInTable(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInTableBody(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInTableBody(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInTableBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.TR: {
            p.openElements.clearBackToTableBodyContext();
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.IN_ROW;
            break;
        }
        case $.TH:
        case $.TD: {
            p.openElements.clearBackToTableBodyContext();
            p._insertFakeElement(TN.TR, $.TR);
            p.insertionMode = InsertionMode.IN_ROW;
            modeInRow(p, token);
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
                modeInTable(p, token);
            }
            break;
        }
        default: {
            startTagInTable(p, token);
        }
    }
}

function endTagInTableBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    switch (token.tagID) {
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD: {
            if (p.openElements.hasInTableScope(tn)) {
                p.openElements.clearBackToTableBodyContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE;
            }
            break;
        }
        case $.TABLE: {
            if (p.openElements.hasTableBodyContextInTableScope()) {
                p.openElements.clearBackToTableBodyContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE;
                modeInTable(p, token);
            }
            break;
        }
        case $.BODY:
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.HTML:
        case $.TD:
        case $.TH:
        case $.TR: {
            // Ignore token
            break;
        }
        default: {
            endTagInTable(p, token);
        }
    }
}

// The "in row" insertion mode
//------------------------------------------------------------------
function modeInRow<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            characterInTable(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInRow(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInRow(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInRow<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.TH:
        case $.TD: {
            p.openElements.clearBackToTableRowContext();
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.IN_CELL;
            p.activeFormattingElements.insertMarker();
            break;
        }
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD:
        case $.TR: {
            if (p.openElements.hasInTableScope($.TR)) {
                p.openElements.clearBackToTableRowContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
                modeInTableBody(p, token);
            }
            break;
        }
        default: {
            startTagInTable(p, token);
        }
    }
}

function endTagInRow<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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
                modeInTableBody(p, token);
            }
            break;
        }
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD: {
            if (p.openElements.hasInTableScope(token.tagID) || p.openElements.hasInTableScope($.TR)) {
                p.openElements.clearBackToTableRowContext();
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
                modeInTableBody(p, token);
            }
            break;
        }
        case $.BODY:
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.HTML:
        case $.TD:
        case $.TH: {
            // Ignore end tag
            break;
        }
        default:
            endTagInTable(p, token);
    }
}

// The "in cell" insertion mode
//------------------------------------------------------------------
function modeInCell<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER: {
            characterInBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInCell(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInCell(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInCell<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    if (TABLE_VOID_ELEMENTS.has(tn)) {
        if (p.openElements.hasInTableScope($.TD) || p.openElements.hasInTableScope($.TH)) {
            p._closeTableCell();
            p._processToken(token);
        }
    } else {
        startTagInBody(p, token);
    }
}

function endTagInCell<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

    switch (tn) {
        case $.TD:
        case $.TH: {
            if (p.openElements.hasInTableScope(tn)) {
                p.openElements.generateImpliedEndTags();
                p.openElements.popUntilTagNamePopped(tn);
                p.activeFormattingElements.clearToLastMarker();
                p.insertionMode = InsertionMode.IN_ROW;
            }
            break;
        }
        case $.TABLE:
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD:
        case $.TR: {
            if (p.openElements.hasInTableScope(tn)) {
                p._closeTableCell();
                p._processToken(token);
            }
            break;
        }
        case $.BODY:
        case $.CAPTION:
        case $.COL:
        case $.COLGROUP:
        case $.HTML: {
            // Ignore token
            break;
        }
        default: {
            endTagInBody(p, token);
        }
    }
}

// The "in select" insertion mode
//------------------------------------------------------------------
function modeInSelect<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInSelect(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInSelect(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInSelect<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.HTML: {
            startTagInBody(p, token);
            break;
        }
        case $.OPTION: {
            if (p.openElements.currentTagId === $.OPTION) {
                p.openElements.pop();
            }

            p._insertElement(token, NS.HTML);
            break;
        }
        case $.OPTGROUP: {
            if (p.openElements.currentTagId === $.OPTION) {
                p.openElements.pop();
            }

            if (p.openElements.currentTagId === $.OPTGROUP) {
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

                if (token.tagID !== $.SELECT) {
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

function endTagInSelect<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.OPTGROUP: {
            if (
                p.openElements.stackTop > 0 &&
                p.openElements.currentTagId === $.OPTION &&
                p.openElements.tagIDs[p.openElements.stackTop - 1] === $.OPTGROUP
            ) {
                p.openElements.pop();
            }

            if (p.openElements.currentTagId === $.OPTGROUP) {
                p.openElements.pop();
            }
            break;
        }
        case $.OPTION: {
            if (p.openElements.currentTagId === $.OPTION) {
                p.openElements.pop();
            }
            break;
        }
        case $.SELECT: {
            if (p.openElements.hasInSelectScope($.SELECT)) {
                p.openElements.popUntilTagNamePopped($.SELECT);
                p._resetInsertionMode();
            }
            break;
        }
        case $.TEMPLATE: {
            endTagInHead(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

// The "in select in table" insertion mode
//------------------------------------------------------------------
function modeInSelectInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInSelectInTable(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInSelectInTable(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInBody(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInSelectInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

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

function endTagInSelectInTable<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    const tn = token.tagID;

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
function modeInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER: {
            characterInBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInTemplate(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInTemplate(p, token);
            break;
        }
        case TokenType.EOF: {
            eofInTemplate(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        // First, handle tags that can start without a mode change
        case $.BASE:
        case $.BASEFONT:
        case $.BGSOUND:
        case $.LINK:
        case $.META:
        case $.NOFRAMES:
        case $.SCRIPT:
        case $.STYLE:
        case $.TEMPLATE:
        case $.TITLE:
            startTagInHead(p, token);
            break;

        // Re-process the token in the appropriate mode
        case $.CAPTION:
        case $.COLGROUP:
        case $.TBODY:
        case $.TFOOT:
        case $.THEAD:
            p.tmplInsertionModeStack[0] = InsertionMode.IN_TABLE;
            p.insertionMode = InsertionMode.IN_TABLE;
            modeInTable(p, token);
            break;
        case $.COL:
            p.tmplInsertionModeStack[0] = InsertionMode.IN_COLUMN_GROUP;
            p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
            modeInColumnGroup(p, token);
            break;
        case $.TR:
            p.tmplInsertionModeStack[0] = InsertionMode.IN_TABLE_BODY;
            p.insertionMode = InsertionMode.IN_TABLE_BODY;
            modeInTableBody(p, token);
            break;
        case $.TD:
        case $.TH:
            p.tmplInsertionModeStack[0] = InsertionMode.IN_ROW;
            p.insertionMode = InsertionMode.IN_ROW;
            modeInRow(p, token);
            break;
        default:
            p.tmplInsertionModeStack[0] = InsertionMode.IN_BODY;
            p.insertionMode = InsertionMode.IN_BODY;
            modeInBody(p, token);
    }
}

function endTagInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.TEMPLATE) {
        endTagInHead(p, token);
    }
}

function eofInTemplate<T extends TreeAdapterTypeMap>(p: Parser<T>, token: EOFToken): void {
    if (p.openElements.tmplCount > 0) {
        p.openElements.popUntilTagNamePopped($.TEMPLATE);
        p.activeFormattingElements.clearToLastMarker();
        p.tmplInsertionModeStack.shift();
        p._resetInsertionMode();
        p._processToken(token);
    } else {
        stopParsing(p, token);
    }
}

// The "after body" insertion mode
//------------------------------------------------------------------
function modeAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER: {
            tokenAfterBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendCommentToRootHtmlElement(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagAfterBody(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagAfterBody(p, token);
            break;
        }
        case TokenType.EOF: {
            stopParsing(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.HTML) {
        startTagInBody(p, token);
    } else {
        tokenAfterBody(p, token);
    }
}

function endTagAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.HTML) {
        if (!p.fragmentContext) {
            p.insertionMode = InsertionMode.AFTER_AFTER_BODY;
        }

        //NOTE: <html> is never popped from the stack, so we need to updated
        //the end location explicitly.
        if (p.options.sourceCodeLocationInfo && p.openElements.tagIDs[0] === $.HTML) {
            p._setEndLocation(p.openElements.items[0], token);
        }
    } else {
        tokenAfterBody(p, token);
    }
}

function tokenAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p.insertionMode = InsertionMode.IN_BODY;
    modeInBody(p, token);
}

// The "in frameset" insertion mode
//------------------------------------------------------------------
function modeInFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagInFrameset(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagInFrameset(p, token);
            break;
        }
        case TokenType.EOF: {
            stopParsing(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagInFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
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

function endTagInFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.FRAMESET && !p.openElements.isRootHtmlElementCurrent()) {
        p.openElements.pop();

        if (!p.fragmentContext && p.openElements.currentTagId !== $.FRAMESET) {
            p.insertionMode = InsertionMode.AFTER_FRAMESET;
        }
    }
}

// The "after frameset" insertion mode
//------------------------------------------------------------------
function modeAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.WHITESPACE_CHARACTER: {
            p._insertCharacters(token);
            break;
        }
        case TokenType.COMMENT: {
            appendComment(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagAfterFrameset(p, token);
            break;
        }
        case TokenType.END_TAG: {
            endTagAfterFrameset(p, token);
            break;
        }
        case TokenType.EOF: {
            stopParsing(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.HTML: {
            startTagInBody(p, token);
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

function endTagAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.HTML) {
        p.insertionMode = InsertionMode.AFTER_AFTER_FRAMESET;
    }
}

// The "after after body" insertion mode
//------------------------------------------------------------------
function modeAfterAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.CHARACTER:
        case TokenType.NULL_CHARACTER:
        case TokenType.END_TAG: {
            tokenAfterAfterBody(p, token);
            break;
        }
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendCommentToDocument(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagAfterAfterBody(p, token);
            break;
        }
        case TokenType.EOF: {
            stopParsing(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagAfterAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (token.tagID === $.HTML) {
        startTagInBody(p, token);
    } else {
        tokenAfterAfterBody(p, token);
    }
}

function tokenAfterAfterBody<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    p.insertionMode = InsertionMode.IN_BODY;
    modeInBody(p, token);
}

// The "after after frameset" insertion mode
//------------------------------------------------------------------
function modeAfterAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: Token): void {
    switch (token.type) {
        case TokenType.WHITESPACE_CHARACTER: {
            whitespaceCharacterInBody(p, token);
            break;
        }
        case TokenType.COMMENT: {
            appendCommentToDocument(p, token);
            break;
        }
        case TokenType.START_TAG: {
            startTagAfterAfterFrameset(p, token);
            break;
        }
        case TokenType.EOF: {
            stopParsing(p, token);
            break;
        }
        default:
        // Do nothing
    }
}

function startTagAfterAfterFrameset<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    switch (token.tagID) {
        case $.HTML: {
            startTagInBody(p, token);
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

// The rules for parsing tokens in foreign content
//------------------------------------------------------------------
function nullCharacterInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    token.chars = unicode.REPLACEMENT_CHARACTER;
    p._insertCharacters(token);
}

function characterInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: CharacterToken): void {
    p._insertCharacters(token);
    p.framesetOk = false;
}

function startTagInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    if (foreignContent.causesExit(token) && !p.fragmentContext) {
        while (
            p.treeAdapter.getNamespaceURI(p.openElements.current) !== NS.HTML &&
            !p._isIntegrationPoint(p.openElements.currentTagId, p.openElements.current)
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

function endTagInForeignContent<T extends TreeAdapterTypeMap>(p: Parser<T>, token: TagToken): void {
    for (let i = p.openElements.stackTop; i > 0; i--) {
        const element = p.openElements.items[i];

        if (p.treeAdapter.getNamespaceURI(element) === NS.HTML) {
            p._processToken(token);
            break;
        }

        if (p.treeAdapter.getTagName(element).toLowerCase() === token.tagName) {
            p.openElements.shortenToLength(i);
            break;
        }
    }
}
