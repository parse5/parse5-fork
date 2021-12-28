import { DOCUMENT_MODE, NAMESPACES } from '../common/html.js';
import type { Attribute, ElementLocation } from '../common/token.js';

/**
 * Tree adapter is a set of utility functions that provides minimal required abstraction layer beetween parser and a specific AST format.
 * Note that `TreeAdapter` is not designed to be a general purpose AST manipulation library. You can build such library
 * on top of existing `TreeAdapter` or use one of the existing libraries from npm.
 *
 * @see The default implementation {@link parse5.treeAdapters.default}
 */
export interface TreeAdapter<
    TDocument,
    TElement,
    TDocumentType,
    TCommentNode,
    TTextNode,
    TDocumentFragment,
    TTemplate extends TElement
> {
    /**
     * Copies attributes to the given element. Only attributes that are not yet present in the element are copied.
     *
     * @param recipient - Element to copy attributes into.
     * @param attrs - Attributes to copy.
     */
    adoptAttributes(recipient: TElement, attrs: Attribute[]): void;

    /**
     * Appends a child node to the given parent node.
     *
     * @param parentNode - Parent node.
     * @param newNode -  Child node.
     */
    appendChild(
        parentNode: TDocument | TElement | TDocumentFragment,
        newNode: TCommentNode | TDocumentType | TElement | TTextNode
    ): void;

    /**
     * Creates a comment node.
     *
     * @param data - Comment text.
     */
    createCommentNode(data: string): TCommentNode;

    /**
     * Creates a document node.
     */
    createDocument(): TDocument;

    /**
     * Creates a document fragment node.
     */
    createDocumentFragment(): TDocumentFragment;

    /**
     * Creates an element node.
     *
     * @param tagName - Tag name of the element.
     * @param namespaceURI - Namespace of the element.
     * @param attrs - Attribute name-value pair array. Foreign attributes may contain `namespace` and `prefix` fields as well.
     */
    createElement(tagName: string, namespaceURI: NAMESPACES, attrs: Attribute[]): TElement;

    /**
     * Removes a node from its parent.
     *
     * @param node - Node to remove.
     */
    detachNode(node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode): void;

    /**
     * Returns the given element's attributes in an array, in the form of name-value pairs.
     * Foreign attributes may contain `namespace` and `prefix` fields as well.
     *
     * @param element - Element.
     */
    getAttrList(element: TElement): Attribute[];

    /**
     * Returns the given node's children in an array.
     *
     * @param node - Node.
     */
    getChildNodes(
        node: TDocument | TElement | TDocumentFragment
    ): Array<TCommentNode | TDocumentType | TElement | TTextNode>;

    /**
     * Returns the given comment node's content.
     *
     * @param commentNode - Comment node.
     */
    getCommentNodeContent(commentNode: TCommentNode): string;

    /**
     * Returns [document mode](https://dom.spec.whatwg.org/#concept-document-limited-quirks).
     *
     * @param document - Document node.
     */
    getDocumentMode(document: TDocument): DOCUMENT_MODE;

    /**
     * Returns the given document type node's name.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodeName(doctypeNode: TDocumentType): string;

    /**
     * Returns the given document type node's public identifier.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodePublicId(doctypeNode: TDocumentType): string;

    /**
     * Returns the given document type node's system identifier.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodeSystemId(doctypeNode: TDocumentType): string;

    /**
     * Returns the first child of the given node.
     *
     * @param node - Node.
     */
    getFirstChild(
        node: TDocument | TElement | TDocumentFragment
    ): TCommentNode | TDocumentType | TElement | TTextNode | null;

    /**
     * Returns the given element's namespace.
     *
     * @param element - Element.
     */
    getNamespaceURI(element: TElement): NAMESPACES;

    /**
     * Returns the given node's source code location information.
     *
     * @param node - Node.
     */
    getNodeSourceCodeLocation(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): ElementLocation | undefined | null;

    /**
     * Returns the given node's parent.
     *
     * @param node - Node.
     */
    getParentNode(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): TDocument | TElement | TDocumentFragment | null;

    /**
     * Returns the given element's tag name.
     *
     * @param element - Element.
     */
    getTagName(element: TElement): string;

    /**
     * Returns the given text node's content.
     *
     * @param textNode - Text node.
     */
    getTextNodeContent(textNode: TTextNode): string;

    /**
     * Returns the `<template>` element content element.
     *
     * @param templateElement - `<template>` element.
     */
    getTemplateContent(templateElement: TTemplate): TDocumentFragment;

    /**
     * Inserts a child node to the given parent node before the given reference node.
     *
     * @param parentNode - Parent node.
     * @param newNode -  Child node.
     * @param referenceNode -  Reference node.
     */
    insertBefore(
        parentNode: TDocument | TElement | TDocumentFragment,
        newNode: TCommentNode | TDocumentType | TElement | TTextNode,
        referenceNode: TCommentNode | TDocumentType | TElement | TTextNode
    ): void;

    /**
     * Inserts text into a node. If the last child of the node is a text node, the provided text will be appended to the
     * text node content. Otherwise, inserts a new text node with the given text.
     *
     * @param parentNode - Node to insert text into.
     * @param text - Text to insert.
     */
    insertText(parentNode: TDocument | TElement | TDocumentFragment, text: string): void;

    /**
     * Inserts text into a sibling node that goes before the reference node. If this sibling node is the text node,
     * the provided text will be appended to the text node content. Otherwise, inserts a new sibling text node with
     * the given text before the reference node.
     *
     * @param parentNode - Node to insert text into.
     * @param text - Text to insert.
     * @param referenceNode - Node to insert text before.
     */
    insertTextBefore(
        parentNode: TDocument | TElement | TDocumentFragment,
        text: string,
        referenceNode: TCommentNode | TDocumentType | TElement | TTextNode
    ): void;

    /**
     * Determines if the given node is a comment node.
     *
     * @param node - Node.
     */
    isCommentNode(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): node is TCommentNode;

    /**
     * Determines if the given node is a document type node.
     *
     * @param node - Node.
     */
    isDocumentTypeNode(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): node is TDocumentType;

    /**
     * Determines if the given node is an element.
     *
     * @param node - Node.
     */
    isElementNode(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): node is TElement;

    /**
     * Determines if the given node is a text node.
     *
     * @param node - Node.
     */
    isTextNode(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode
    ): node is TTextNode;

    /**
     * Sets the [document mode](https://dom.spec.whatwg.org/#concept-document-limited-quirks).
     *
     * @param document - Document node.
     * @param mode - Document mode.
     */
    setDocumentMode(document: TDocument, mode: DOCUMENT_MODE): void;

    /**
     * Sets the document type. If the `document` already contains a document type node, the `name`, `publicId` and `systemId`
     * properties of this node will be updated with the provided values. Otherwise, creates a new document type node
     * with the given properties and inserts it into the `document`.
     *
     * @param document - Document node.
     * @param name -  Document type name.
     * @param publicId - Document type public identifier.
     * @param systemId - Document type system identifier.
     */
    setDocumentType(document: TDocument, name: string, publicId: string, systemId: string): void;

    /**
     * Attaches source code location information to the node.
     *
     * @param node - Node.
     */
    setNodeSourceCodeLocation(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode,
        location: ElementLocation | null
    ): void;

    /**
     * Updates the source code location information of the node.
     *
     * @param node - Node.
     */
    updateNodeSourceCodeLocation(
        node: TCommentNode | TDocument | TDocumentFragment | TDocumentType | TElement | TTextNode,
        location: Partial<ElementLocation>
    ): void;

    /**
     * Sets the `<template>` element content element.
     *
     * @param templateElement - `<template>` element.
     * @param contentElement -  Content element.
     */
    setTemplateContent(templateElement: TTemplate, contentElement: TDocumentFragment): void;
}
