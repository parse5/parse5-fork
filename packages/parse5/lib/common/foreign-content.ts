import { TAG_NAMES as $, NAMESPACES as NS, ATTRS } from './html.js';
import type { TagToken, Attribute } from './token.js';

//MIME types
const MIME_TYPES = {
    TEXT_HTML: 'text/html',
    APPLICATION_XML: 'application/xhtml+xml',
};

//Attributes
const DEFINITION_URL_ATTR = 'definitionurl';
const ADJUSTED_DEFINITION_URL_ATTR = 'definitionURL';
const SVG_ATTRS_ADJUSTMENT_MAP = new Map([
    ['attributename', 'attributeName'],
    ['attributetype', 'attributeType'],
    ['basefrequency', 'baseFrequency'],
    ['baseprofile', 'baseProfile'],
    ['calcmode', 'calcMode'],
    ['clippathunits', 'clipPathUnits'],
    ['diffuseconstant', 'diffuseConstant'],
    ['edgemode', 'edgeMode'],
    ['filterunits', 'filterUnits'],
    ['glyphref', 'glyphRef'],
    ['gradienttransform', 'gradientTransform'],
    ['gradientunits', 'gradientUnits'],
    ['kernelmatrix', 'kernelMatrix'],
    ['kernelunitlength', 'kernelUnitLength'],
    ['keypoints', 'keyPoints'],
    ['keysplines', 'keySplines'],
    ['keytimes', 'keyTimes'],
    ['lengthadjust', 'lengthAdjust'],
    ['limitingconeangle', 'limitingConeAngle'],
    ['markerheight', 'markerHeight'],
    ['markerunits', 'markerUnits'],
    ['markerwidth', 'markerWidth'],
    ['maskcontentunits', 'maskContentUnits'],
    ['maskunits', 'maskUnits'],
    ['numoctaves', 'numOctaves'],
    ['pathlength', 'pathLength'],
    ['patterncontentunits', 'patternContentUnits'],
    ['patterntransform', 'patternTransform'],
    ['patternunits', 'patternUnits'],
    ['pointsatx', 'pointsAtX'],
    ['pointsaty', 'pointsAtY'],
    ['pointsatz', 'pointsAtZ'],
    ['preservealpha', 'preserveAlpha'],
    ['preserveaspectratio', 'preserveAspectRatio'],
    ['primitiveunits', 'primitiveUnits'],
    ['refx', 'refX'],
    ['refy', 'refY'],
    ['repeatcount', 'repeatCount'],
    ['repeatdur', 'repeatDur'],
    ['requiredextensions', 'requiredExtensions'],
    ['requiredfeatures', 'requiredFeatures'],
    ['specularconstant', 'specularConstant'],
    ['specularexponent', 'specularExponent'],
    ['spreadmethod', 'spreadMethod'],
    ['startoffset', 'startOffset'],
    ['stddeviation', 'stdDeviation'],
    ['stitchtiles', 'stitchTiles'],
    ['surfacescale', 'surfaceScale'],
    ['systemlanguage', 'systemLanguage'],
    ['tablevalues', 'tableValues'],
    ['targetx', 'targetX'],
    ['targety', 'targetY'],
    ['textlength', 'textLength'],
    ['viewbox', 'viewBox'],
    ['viewtarget', 'viewTarget'],
    ['xchannelselector', 'xChannelSelector'],
    ['ychannelselector', 'yChannelSelector'],
    ['zoomandpan', 'zoomAndPan'],
]);

const XML_ATTRS_ADJUSTMENT_MAP = new Map([
    ['xlink:actuate', { prefix: 'xlink', name: 'actuate', namespace: NS.XLINK }],
    ['xlink:arcrole', { prefix: 'xlink', name: 'arcrole', namespace: NS.XLINK }],
    ['xlink:href', { prefix: 'xlink', name: 'href', namespace: NS.XLINK }],
    ['xlink:role', { prefix: 'xlink', name: 'role', namespace: NS.XLINK }],
    ['xlink:show', { prefix: 'xlink', name: 'show', namespace: NS.XLINK }],
    ['xlink:title', { prefix: 'xlink', name: 'title', namespace: NS.XLINK }],
    ['xlink:type', { prefix: 'xlink', name: 'type', namespace: NS.XLINK }],
    ['xml:base', { prefix: 'xml', name: 'base', namespace: NS.XML }],
    ['xml:lang', { prefix: 'xml', name: 'lang', namespace: NS.XML }],
    ['xml:space', { prefix: 'xml', name: 'space', namespace: NS.XML }],
    ['xmlns', { prefix: '', name: 'xmlns', namespace: NS.XMLNS }],
    ['xmlns:xlink', { prefix: 'xmlns', name: 'xlink', namespace: NS.XMLNS }],
]);

//SVG tag names adjustment map
export const SVG_TAG_NAMES_ADJUSTMENT_MAP = new Map([
    ['altglyph', 'altGlyph'],
    ['altglyphdef', 'altGlyphDef'],
    ['altglyphitem', 'altGlyphItem'],
    ['animatecolor', 'animateColor'],
    ['animatemotion', 'animateMotion'],
    ['animatetransform', 'animateTransform'],
    ['clippath', 'clipPath'],
    ['feblend', 'feBlend'],
    ['fecolormatrix', 'feColorMatrix'],
    ['fecomponenttransfer', 'feComponentTransfer'],
    ['fecomposite', 'feComposite'],
    ['feconvolvematrix', 'feConvolveMatrix'],
    ['fediffuselighting', 'feDiffuseLighting'],
    ['fedisplacementmap', 'feDisplacementMap'],
    ['fedistantlight', 'feDistantLight'],
    ['feflood', 'feFlood'],
    ['fefunca', 'feFuncA'],
    ['fefuncb', 'feFuncB'],
    ['fefuncg', 'feFuncG'],
    ['fefuncr', 'feFuncR'],
    ['fegaussianblur', 'feGaussianBlur'],
    ['feimage', 'feImage'],
    ['femerge', 'feMerge'],
    ['femergenode', 'feMergeNode'],
    ['femorphology', 'feMorphology'],
    ['feoffset', 'feOffset'],
    ['fepointlight', 'fePointLight'],
    ['fespecularlighting', 'feSpecularLighting'],
    ['fespotlight', 'feSpotLight'],
    ['fetile', 'feTile'],
    ['feturbulence', 'feTurbulence'],
    ['foreignobject', 'foreignObject'],
    ['glyphref', 'glyphRef'],
    ['lineargradient', 'linearGradient'],
    ['radialgradient', 'radialGradient'],
    ['textpath', 'textPath'],
]);

//Tags that causes exit from foreign content
const EXITS_FOREIGN_CONTENT = new Set<string>([
    $.B,
    $.BIG,
    $.BLOCKQUOTE,
    $.BODY,
    $.BR,
    $.CENTER,
    $.CODE,
    $.DD,
    $.DIV,
    $.DL,
    $.DT,
    $.EM,
    $.EMBED,
    $.H1,
    $.H2,
    $.H3,
    $.H4,
    $.H5,
    $.H6,
    $.HEAD,
    $.HR,
    $.I,
    $.IMG,
    $.LI,
    $.LISTING,
    $.MENU,
    $.META,
    $.NOBR,
    $.OL,
    $.P,
    $.PRE,
    $.RUBY,
    $.S,
    $.SMALL,
    $.SPAN,
    $.STRONG,
    $.STRIKE,
    $.SUB,
    $.SUP,
    $.TABLE,
    $.TT,
    $.U,
    $.UL,
    $.VAR,
]);

//Check exit from foreign content
export function causesExit(startTagToken: TagToken) {
    const tn = startTagToken.tagName;
    const isFontWithAttrs =
        tn === $.FONT &&
        startTagToken.attrs.some(({ name }) => name === ATTRS.COLOR || name === ATTRS.SIZE || name === ATTRS.FACE);

    return isFontWithAttrs || EXITS_FOREIGN_CONTENT.has(tn);
}

//Token adjustments
export function adjustTokenMathMLAttrs(token: TagToken) {
    for (let i = 0; i < token.attrs.length; i++) {
        if (token.attrs[i].name === DEFINITION_URL_ATTR) {
            token.attrs[i].name = ADJUSTED_DEFINITION_URL_ATTR;
            break;
        }
    }
}

export function adjustTokenSVGAttrs(token: TagToken) {
    for (let i = 0; i < token.attrs.length; i++) {
        const adjustedAttrName = SVG_ATTRS_ADJUSTMENT_MAP.get(token.attrs[i].name);

        if (adjustedAttrName) {
            token.attrs[i].name = adjustedAttrName;
        }
    }
}

export function adjustTokenXMLAttrs(token: TagToken) {
    for (let i = 0; i < token.attrs.length; i++) {
        const adjustedAttrEntry = XML_ATTRS_ADJUSTMENT_MAP.get(token.attrs[i].name);

        if (adjustedAttrEntry) {
            token.attrs[i].prefix = adjustedAttrEntry.prefix;
            token.attrs[i].name = adjustedAttrEntry.name;
            token.attrs[i].namespace = adjustedAttrEntry.namespace;
        }
    }
}

export function adjustTokenSVGTagName(token: TagToken) {
    const adjustedTagName = SVG_TAG_NAMES_ADJUSTMENT_MAP.get(token.tagName);

    if (adjustedTagName) {
        token.tagName = adjustedTagName;
    }
}

//Integration points
function isMathMLTextIntegrationPoint(tn: string, ns: string) {
    return ns === NS.MATHML && (tn === $.MI || tn === $.MO || tn === $.MN || tn === $.MS || tn === $.MTEXT);
}

function isHtmlIntegrationPoint(tn: string, ns: string, attrs: Attribute[]) {
    if (ns === NS.MATHML && tn === $.ANNOTATION_XML) {
        for (let i = 0; i < attrs.length; i++) {
            if (attrs[i].name === ATTRS.ENCODING) {
                const value = attrs[i].value.toLowerCase();

                return value === MIME_TYPES.TEXT_HTML || value === MIME_TYPES.APPLICATION_XML;
            }
        }
    }

    return ns === NS.SVG && (tn === $.FOREIGN_OBJECT || tn === $.DESC || tn === $.TITLE);
}

export function isIntegrationPoint(tn: string, ns: string, attrs: Attribute[], foreignNS?: string) {
    if ((!foreignNS || foreignNS === NS.HTML) && isHtmlIntegrationPoint(tn, ns, attrs)) {
        return true;
    }

    if ((!foreignNS || foreignNS === NS.MATHML) && isMathMLTextIntegrationPoint(tn, ns)) {
        return true;
    }

    return false;
}
