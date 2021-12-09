import { DOCUMENT_MODE, NAMESPACES } from '../common/html.js';
import type { Attribute, ElementLocation } from '../common/token.js';

export interface TreeAdapterTypeMap<
    Document = unknown,
    DocumentFragment = unknown,
    Element = unknown,
    CommentNode = unknown,
    TextNode = unknown,
    Template = unknown,
    DocumentType = unknown
> {
    document: Document;
    documentFragment: DocumentFragment;
    element: Element;
    commentNode: CommentNode;
    textNode: TextNode;
    template: Template;
    documentType: DocumentType;
}

export type ParentNode<T extends TreeAdapterTypeMap> =
    | T['document']
    | T['documentFragment']
    | T['element']
    | T['template'];
export type ChildNode<T extends TreeAdapterTypeMap> =
    | T['element']
    | T['template']
    | T['textNode']
    | T['commentNode']
    | T['documentType'];
export type Node<T extends TreeAdapterTypeMap> = ParentNode<T> | ChildNode<T>;

/**
 * Tree adapter is a set of utility functions that provides minimal required abstraction layer beetween parser and a specific AST format.
 * Note that `TreeAdapter` is not designed to be a general purpose AST manipulation library. You can build such library
 * on top of existing `TreeAdapter` or use one of the existing libraries from npm.
 *
 * @see The default implementation {@link parse5.treeAdapters.default}
 */
export interface TreeAdapter<T extends TreeAdapterTypeMap = TreeAdapterTypeMap> {
    /**
     * Copies attributes to the given element. Only attributes that are not yet present in the element are copied.
     *
     * @param recipient - Element to copy attributes into.
     * @param attrs - Attributes to copy.
     */
    adoptAttributes(recipient: T['element'], attrs: Attribute[]): void;

    /**
     * Appends a child node to the given parent node.
     *
     * @param parentNode - Parent node.
     * @param newNode -  Child node.
     */
    appendChild(parentNode: ParentNode<T>, newNode: ChildNode<T>): void;

    /**
     * Creates a comment node.
     *
     * @param data - Comment text.
     */
    createCommentNode(data: string): T['commentNode'];

    /**
     * Creates a document node.
     */
    createDocument(): T['document'];

    /**
     * Creates a document fragment node.
     */
    createDocumentFragment(): T['documentFragment'];

    /**
     * Creates an element node.
     *
     * @param tagName - Tag name of the element.
     * @param namespaceURI - Namespace of the element.
     * @param attrs - Attribute name-value pair array. Foreign attributes may contain `namespace` and `prefix` fields as well.
     */
    createElement(tagName: string, namespaceURI: NAMESPACES, attrs: Attribute[]): T['element'];

    /**
     * Removes a node from its parent.
     *
     * @param node - Node to remove.
     */
    detachNode(node: ChildNode<T>): void;

    /**
     * Returns the given element's attributes in an array, in the form of name-value pairs.
     * Foreign attributes may contain `namespace` and `prefix` fields as well.
     *
     * @param element - Element.
     */
    getAttrList(element: T['element']): Attribute[];

    /**
     * Returns the given node's children in an array.
     *
     * @param node - Node.
     */
    getChildNodes(node: ParentNode<T>): ChildNode<T>[];

    /**
     * Returns the given comment node's content.
     *
     * @param commentNode - Comment node.
     */
    getCommentNodeContent(commentNode: T['commentNode']): string;

    /**
     * Returns [document mode](https://dom.spec.whatwg.org/#concept-document-limited-quirks).
     *
     * @param document - Document node.
     */
    getDocumentMode(document: T['document']): DOCUMENT_MODE;

    /**
     * Returns the given document type node's name.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodeName(doctypeNode: T['documentType']): string;

    /**
     * Returns the given document type node's public identifier.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodePublicId(doctypeNode: T['documentType']): string;

    /**
     * Returns the given document type node's system identifier.
     *
     * @param doctypeNode - Document type node.
     */
    getDocumentTypeNodeSystemId(doctypeNode: T['documentType']): string;

    /**
     * Returns the first child of the given node.
     *
     * @param node - Node.
     */
    getFirstChild(node: ParentNode<T>): ChildNode<T> | null;

    /**
     * Returns the given element's namespace.
     *
     * @param element - Element.
     */
    getNamespaceURI(element: T['element']): NAMESPACES;

    /**
     * Returns the given node's source code location information.
     *
     * @param node - Node.
     */
    getNodeSourceCodeLocation(node: Node<T>): ElementLocation | undefined | null;

    /**
     * Returns the given node's parent.
     *
     * @param node - Node.
     */
    getParentNode(node: Node<T>): ParentNode<T> | null;

    /**
     * Returns the given element's tag name.
     *
     * @param element - Element.
     */
    getTagName(element: T['element']): string;

    /**
     * Returns the given text node's content.
     *
     * @param textNode - Text node.
     */
    getTextNodeContent(textNode: T['textNode']): string;

    /**
     * Returns the `<template>` element content element.
     *
     * @param templateElement - `<template>` element.
     */
    getTemplateContent(templateElement: T['template']): T['documentFragment'];

    /**
     * Inserts a child node to the given parent node before the given reference node.
     *
     * @param parentNode - Parent node.
     * @param newNode -  Child node.
     * @param referenceNode -  Reference node.
     */
    insertBefore(parentNode: ParentNode<T>, newNode: ChildNode<T>, referenceNode: ChildNode<T>): void;

    /**
     * Inserts text into a node. If the last child of the node is a text node, the provided text will be appended to the
     * text node content. Otherwise, inserts a new text node with the given text.
     *
     * @param parentNode - Node to insert text into.
     * @param text - Text to insert.
     */
    insertText(parentNode: ParentNode<T>, text: string): void;

    /**
     * Inserts text into a sibling node that goes before the reference node. If this sibling node is the text node,
     * the provided text will be appended to the text node content. Otherwise, inserts a new sibling text node with
     * the given text before the reference node.
     *
     * @param parentNode - Node to insert text into.
     * @param text - Text to insert.
     * @param referenceNode - Node to insert text before.
     */
    insertTextBefore(parentNode: ParentNode<T>, text: string, referenceNode: ChildNode<T>): void;

    /**
     * Determines if the given node is a comment node.
     *
     * @param node - Node.
     */
    isCommentNode(node: Node<T>): node is T['commentNode'];

    /**
     * Determines if the given node is a document type node.
     *
     * @param node - Node.
     */
    isDocumentTypeNode(node: Node<T>): node is T['documentType'];

    /**
     * Determines if the given node is an element.
     *
     * @param node - Node.
     */
    isElementNode(node: Node<T>): node is T['element'];

    /**
     * Determines if the given node is a text node.
     *
     * @param node - Node.
     */
    isTextNode(node: Node<T>): node is T['textNode'];

    /**
     * Sets the [document mode](https://dom.spec.whatwg.org/#concept-document-limited-quirks).
     *
     * @param document - Document node.
     * @param mode - Document mode.
     */
    setDocumentMode(document: T['document'], mode: DOCUMENT_MODE): void;

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
    setDocumentType(document: T['document'], name: string, publicId: string, systemId: string): void;

    /**
     * Attaches source code location information to the node.
     *
     * @param node - Node.
     */
    setNodeSourceCodeLocation(node: Node<T>, location: ElementLocation | null): void;

    /**
     * Updates the source code location information of the node.
     *
     * @param node - Node.
     */
    updateNodeSourceCodeLocation(node: Node<T>, location: Partial<ElementLocation>): void;

    /**
     * Sets the `<template>` element content element.
     *
     * @param templateElement - `<template>` element.
     * @param contentElement -  Content element.
     */
    setTemplateContent(templateElement: T['template'], contentElement: T['documentFragment']): void;
}
