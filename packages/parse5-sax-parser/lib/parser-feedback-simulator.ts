import { Tokenizer } from 'parse5/lib/tokenizer/index.js';
import type { Token, TagToken } from 'parse5/lib/common/token.js';
import * as foreignContent from 'parse5/lib/common/foreign-content.js';
import * as unicode from 'parse5/lib/common/unicode.js';
import * as HTML from 'parse5/lib/common/html.js';

//Aliases
const $ = HTML.TAG_NAMES;
const NS = HTML.NAMESPACES;

//ParserFeedbackSimulator
//Simulates adjustment of the Tokenizer which performed by standard parser during tree construction.
export class ParserFeedbackSimulator {
    namespaceStack: string[] = [];
    namespaceStackTop = -1;
    inForeignContent = false;
    currentNamespace = '';
    skipNextNewLine = false;

    constructor(private tokenizer: Tokenizer) {
        this._enterNamespace(NS.HTML);
    }

    getNextToken(): Token {
        const token = this.tokenizer.getNextToken();

        if (token.type === Tokenizer.START_TAG_TOKEN) {
            this._handleStartTagToken(token);
        } else if (token.type === Tokenizer.END_TAG_TOKEN) {
            this._handleEndTagToken(token);
        } else if (token.type === Tokenizer.NULL_CHARACTER_TOKEN && this.inForeignContent) {
            token.type = Tokenizer.CHARACTER_TOKEN;
            token.chars = unicode.REPLACEMENT_CHARACTER;
        } else if (this.skipNextNewLine) {
            if (token.type !== Tokenizer.HIBERNATION_TOKEN) {
                this.skipNextNewLine = false;
            }

            if (token.type === Tokenizer.WHITESPACE_CHARACTER_TOKEN && token.chars[0] === '\n') {
                if (token.chars.length === 1) {
                    return this.getNextToken();
                }

                token.chars = token.chars.substr(1);
            }
        }

        return token;
    }

    //Namespace stack mutations
    _enterNamespace(namespace: string) {
        this.namespaceStackTop++;
        this.namespaceStack.push(namespace);

        this.inForeignContent = namespace !== NS.HTML;
        this.currentNamespace = namespace;
        this.tokenizer.allowCDATA = this.inForeignContent;
    }

    _leaveCurrentNamespace() {
        this.namespaceStackTop--;
        this.namespaceStack.pop();

        this.currentNamespace = this.namespaceStack[this.namespaceStackTop];
        this.inForeignContent = this.currentNamespace !== NS.HTML;
        this.tokenizer.allowCDATA = this.inForeignContent;
    }

    //Token handlers
    _ensureTokenizerMode(tn: string) {
        if (tn === $.TEXTAREA || tn === $.TITLE) {
            this.tokenizer.state = Tokenizer.MODE.RCDATA;
        } else if (tn === $.PLAINTEXT) {
            this.tokenizer.state = Tokenizer.MODE.PLAINTEXT;
        } else if (tn === $.SCRIPT) {
            this.tokenizer.state = Tokenizer.MODE.SCRIPT_DATA;
        } else if (
            tn === $.STYLE ||
            tn === $.IFRAME ||
            tn === $.XMP ||
            tn === $.NOEMBED ||
            tn === $.NOFRAMES ||
            tn === $.NOSCRIPT
        ) {
            this.tokenizer.state = Tokenizer.MODE.RAWTEXT;
        }
    }

    _handleStartTagToken(token: TagToken) {
        let tn = token.tagName;

        if (tn === $.SVG) {
            this._enterNamespace(NS.SVG);
        } else if (tn === $.MATH) {
            this._enterNamespace(NS.MATHML);
        }

        if (this.inForeignContent) {
            if (foreignContent.causesExit(token)) {
                this._leaveCurrentNamespace();
                return;
            }

            const currentNs = this.currentNamespace;

            if (currentNs === NS.MATHML) {
                foreignContent.adjustTokenMathMLAttrs(token);
            } else if (currentNs === NS.SVG) {
                foreignContent.adjustTokenSVGTagName(token);
                foreignContent.adjustTokenSVGAttrs(token);
            }

            foreignContent.adjustTokenXMLAttrs(token);

            tn = token.tagName;

            if (!token.selfClosing && foreignContent.isIntegrationPoint(tn, currentNs, token.attrs)) {
                this._enterNamespace(NS.HTML);
            }
        } else {
            if (tn === $.PRE || tn === $.TEXTAREA || tn === $.LISTING) {
                this.skipNextNewLine = true;
            } else if (tn === $.IMAGE) {
                token.tagName = $.IMG;
            }

            this._ensureTokenizerMode(tn);
        }
    }

    _handleEndTagToken(token: TagToken) {
        let tn = token.tagName;

        if (!this.inForeignContent) {
            const previousNs = this.namespaceStack[this.namespaceStackTop - 1];

            if (previousNs === NS.SVG) {
                const adjustedTagName = foreignContent.SVG_TAG_NAMES_ADJUSTMENT_MAP.get(token.tagName);

                if (adjustedTagName) {
                    tn = adjustedTagName;
                }
            }

            //NOTE: check for exit from integration point
            if (foreignContent.isIntegrationPoint(tn, previousNs, token.attrs)) {
                this._leaveCurrentNamespace();
            }
        } else if (
            (tn === $.SVG && this.currentNamespace === NS.SVG) ||
            (tn === $.MATH && this.currentNamespace === NS.MATHML)
        ) {
            this._leaveCurrentNamespace();
        }

        // NOTE: adjust end tag name as well for consistency
        if (this.currentNamespace === NS.SVG) {
            foreignContent.adjustTokenSVGTagName(token);
        }
    }
}
