import { Parser, ParserOptions } from './parser/index.js';
import { Serializer, SerializerOptions } from './serializer/index.js';

export { ParserOptions } from './parser/index.js';
export { SerializerOptions } from './serializer/index.js';

// Shorthands

/**
 * Parses an HTML string.
 *
 * @param html Input HTML string.
 * @param options Parsing options.
 * @returns Document
 *
 * @example
 *
 * ```js
 * const parse5 = require('parse5');
 *
 * const document = parse5.parse('<!DOCTYPE html><html><head></head><body>Hi there!</body></html>');
 *
 * console.log(document.childNodes[1].tagName); //> 'html'
 *```
 */
export function parse<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
>(
    html: string,
    options?: ParserOptions<TDocument, TElement, TDocumentType, TCommentNode, TTextNode, TDocumentFragment, TTemplate>
): TDocument {
    const parser = new Parser(options);

    return parser.parse(html);
}

/**
 * Parses an HTML fragment.
 *
 * @example
 *
 * ```js
 * const parse5 = require('parse5');
 *
 * const documentFragment = parse5.parseFragment('<table></table>');
 *
 * console.log(documentFragment.childNodes[0].tagName); //> 'table'
 *
 * // Parses the html fragment in the context of the parsed <table> element.
 * const trFragment = parser.parseFragment(documentFragment.childNodes[0], '<tr><td>Shake it, baby</td></tr>');
 *
 * console.log(trFragment.childNodes[0].childNodes[0].tagName); //> 'td'
 * ```
 *
 * @param fragmentContext Parsing context element. If specified, given fragment will be parsed as if it was set to the context element's `innerHTML` property.
 * @param html Input HTML fragment string.
 * @param options Parsing options.
 * @returns DocumentFragment
 */
export function parseFragment<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
>(
    fragmentContext: TElement | null,
    html: string,
    options: ParserOptions<TDocument, TElement, TDocumentType, TCommentNode, TTextNode, TDocumentFragment, TTemplate>
): TDocumentFragment;
export function parseFragment<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
>(
    html: string,
    options?: ParserOptions<TDocument, TElement, TDocumentType, TCommentNode, TTextNode, TDocumentFragment, TTemplate>
): TDocumentFragment;
export function parseFragment<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
>(
    fragmentContext: TElement | null | string,
    html?:
        | string
        | ParserOptions<TDocument, TElement, TDocumentType, TCommentNode, TTextNode, TDocumentFragment, TTemplate>,
    options?: ParserOptions<TDocument, TElement, TDocumentType, TCommentNode, TTextNode, TDocumentFragment, TTemplate>
): TDocumentFragment {
    if (typeof fragmentContext === 'string') {
        options = html as ParserOptions<
            TDocument,
            TElement,
            TDocumentType,
            TCommentNode,
            TTextNode,
            TDocumentFragment,
            TTemplate
        >;
        html = fragmentContext;
        fragmentContext = null;
    }

    const parser = new Parser(options);

    return parser.parseFragment(html as string, fragmentContext);
}

/**
 * Serializes an AST node to an HTML string.
 *
 * @example
 *
 * ```js
 * const parse5 = require('parse5');
 *
 * const document = parse5.parse('<!DOCTYPE html><html><head></head><body>Hi there!</body></html>');
 *
 * // Serializes a document.
 * const html = parse5.serialize(document);
 *
 * // Serializes the <html> element content.
 * const str = parse5.serialize(document.childNodes[1]);
 *
 * console.log(str); //> '<head></head><body>Hi there!</body>'
 * ```
 *
 * @param node Node to serialize.
 * @param options Serialization options.
 */
export function serialize<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
>(
    node: TDocument | TElement | TDocumentFragment,
    options: SerializerOptions<
        TDocument,
        TElement,
        TDocumentType,
        TCommentNode,
        TTextNode,
        TDocumentFragment,
        TTemplate
    >
): string {
    const serializer = new Serializer(node, options);

    return serializer.serialize();
}
