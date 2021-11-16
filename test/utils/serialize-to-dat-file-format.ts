import { Attribute } from './../../packages/parse5/lib/common/token';
import { TreeAdapter, TreeAdapterTypeMap } from './../../packages/parse5/lib/tree-adapters/interface';
import * as HTML from '../../packages/parse5/lib/common/html.js';

function getSerializedTreeIndent(indent: number) {
    return '|'.padEnd(indent + 2, ' ');
}

function getElementSerializedNamespaceURI<T extends TreeAdapterTypeMap>(
    element: T['element'],
    treeAdapter: TreeAdapter<T>
): string {
    switch (treeAdapter.getNamespaceURI(element)) {
        case HTML.NAMESPACES.SVG:
            return 'svg ';
        case HTML.NAMESPACES.MATHML:
            return 'math ';
        default:
            return '';
    }
}

function serializeNodeList<T extends TreeAdapterTypeMap>(
    nodes: T['node'][],
    indent: number,
    treeAdapter: TreeAdapter<T>
): string {
    let str = '';

    nodes.forEach((node) => {
        str += getSerializedTreeIndent(indent);

        if (treeAdapter.isCommentNode(node)) {
            str += `<!-- ${treeAdapter.getCommentNodeContent(node)} -->\n`;
        } else if (treeAdapter.isTextNode(node)) {
            str += `"${treeAdapter.getTextNodeContent(node)}"\n`;
        } else if (treeAdapter.isDocumentTypeNode(node)) {
            const publicId = treeAdapter.getDocumentTypeNodePublicId(node);
            const systemId = treeAdapter.getDocumentTypeNodeSystemId(node);

            str += `<!DOCTYPE ${treeAdapter.getDocumentTypeNodeName(node) || ''}`;

            if (publicId || systemId) {
                str += ` "${publicId}" "${systemId}"`;
            }

            str += '>\n';
        } else {
            const tn = treeAdapter.getTagName(node);

            str += `<${getElementSerializedNamespaceURI(node, treeAdapter) + tn}>\n`;

            let childrenIndent = indent + 2;
            const serializedAttrs = treeAdapter.getAttrList(node).map((attr: Attribute) => {
                let attrStr = getSerializedTreeIndent(childrenIndent);

                if (attr.prefix) {
                    attrStr += `${attr.prefix} `;
                }

                attrStr += `${attr.name}="${attr.value}"\n`;

                return attrStr;
            });

            str += serializedAttrs.sort().join('');

            if (tn === HTML.TAG_NAMES.TEMPLATE && treeAdapter.getNamespaceURI(node) === HTML.NAMESPACES.HTML) {
                str += `${getSerializedTreeIndent(childrenIndent)}content\n`;
                childrenIndent += 2;
                node = treeAdapter.getTemplateContent(node);
            }

            str += serializeNodeList(treeAdapter.getChildNodes(node), childrenIndent, treeAdapter);
        }
    });

    return str;
}

export function serializeToDatFileFormat<T extends TreeAdapterTypeMap>(
    rootNode: T['parentNode'],
    treeAdapter: TreeAdapter<T>
) {
    return serializeNodeList(treeAdapter.getChildNodes(rootNode), 0, treeAdapter);
}
