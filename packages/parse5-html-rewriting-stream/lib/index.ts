import type { Token, Location } from 'parse5/dist/common/token.js';
import { SAXParser, EndTag, StartTag, Doctype, Text, Comment, SaxToken } from 'parse5-sax-parser';
import { escapeString } from 'parse5/dist/serializer/index.js';

/**
 * Streaming [SAX](https://en.wikipedia.org/wiki/Simple_API_for_XML)-style HTML rewriter.
 * A [transform stream](https://nodejs.org/api/stream.html#stream_class_stream_transform) (which means you can pipe _through_ it, see example).
 *
 * The rewriter uses the raw source representation of tokens if they are not modified by the user. Therefore, the resulting
 * HTML is not affected by parser error-recovery mechanisms as in a classical parsing-serialization roundtrip.
 *
 * @example
 *
 * ```js
 * const RewritingStream = require('parse5-html-rewriting-stream');
 * const http = require('http');
 * const fs = require('fs');
 *
 * const file = fs.createWriteStream('/home/google.com.html');
 * const rewriter = new RewritingStream();
 *
 * // Replace divs with spans
 * rewriter.on('startTag', startTag => {
 *     if (startTag.tagName === 'span') {
 *         startTag.tagName = 'div';
 *     }
 *
 *     rewriter.emitStartTag(startTag);
 * });
 *
 * rewriter.on('endTag', endTag => {
 *     if (endTag.tagName === 'span') {
 *         endTag.tagName = 'div';
 *     }
 *
 *     rewriter.emitEndTag(endTag);
 * });
 *
 * // Wrap all text nodes with <i> tag
 * rewriter.on('text', (_, raw) => {
 *     // Use raw representation of text without HTML entities decoding
 *     rewriter.emitRaw(`<i>${raw}</i>`);
 * });
 *
 * http.get('http://google.com', res => {
 *    // Assumes response is UTF-8.
 *    res.setEncoding('utf8');
 *    // RewritingStream is the Transform stream, which means you can pipe
 *    // through it.
 *    res.pipe(rewriter).pipe(file);
 * });
 * ```
 */
export class RewritingStream extends SAXParser {
    /** Note: The `sourceCodeLocationInfo` is always enabled. */
    constructor() {
        super({ sourceCodeLocationInfo: true });
    }

    override _transformChunk(chunk: string): string {
        // NOTE: ignore upstream return value as we want to push to
        // the Writable part of Transform stream ourselves.
        super._transformChunk(chunk);
        return '';
    }

    private _getRawHtml(location: Location): string {
        const { droppedBufferSize, html } = this.tokenizer.preprocessor;
        const start = location.startOffset - droppedBufferSize;
        const end = location.endOffset - droppedBufferSize;

        return html.slice(start, end);
    }

    // Events
    protected override _handleToken(token: Token): boolean {
        if (!super._handleToken(token)) {
            this.emitRaw(this._getRawHtml(token.location!));
        }

        // NOTE: don't skip new lines after <pre> and other tags,
        // otherwise we'll have incorrect raw data.
        this.parserFeedbackSimulator.skipNextNewLine = false;
        return true;
    }

    // Emitter API
    protected override _emitToken(eventName: string, token: SaxToken): void {
        this.emit(eventName, token, this._getRawHtml(token.sourceCodeLocation!));
    }

    /** Emits serialized document type token into the output stream. */
    public emitDoctype(token: Doctype): void {
        let res = `<!DOCTYPE ${token.name}`;

        if (token.publicId !== null) {
            res += ` PUBLIC "${token.publicId}"`;
        } else if (token.systemId !== null) {
            res += ' SYSTEM';
        }

        if (token.systemId !== null) {
            res += ` "${token.systemId}"`;
        }

        res += '>';

        this.push(res);
    }

    /** Emits serialized start tag token into the output stream. */
    public emitStartTag(token: StartTag): void {
        const res = token.attrs.reduce(
            (res, attr) => `${res} ${attr.name}="${escapeString(attr.value, true)}"`,
            `<${token.tagName}`
        );

        this.push(res + (token.selfClosing ? '/>' : '>'));
    }

    /** Emits serialized end tag token into the output stream. */
    public emitEndTag(token: EndTag): void {
        this.push(`</${token.tagName}>`);
    }

    /** Emits serialized text token into the output stream. */
    public emitText({ text }: Text): void {
        this.push(escapeString(text, false));
    }

    /** Emits serialized comment token into the output stream. */
    public emitComment(token: Comment): void {
        this.push(`<!--${token.text}-->`);
    }

    /** Emits raw HTML string into the output stream. */
    public emitRaw(html: string): void {
        this.push(html);
    }
}
