import { Writable } from 'stream';
import * as assert from 'assert';
import type { TreeAdapter, TreeAdapterTypeMap } from './../../packages/parse5/lib/tree-adapters/interface';
import * as defaultTreeAdapter from '../../packages/parse5/lib/tree-adapters/default.js';
import * as htmlTreeAdapter from '../../packages/parse5-htmlparser2-tree-adapter/lib/index.js';
import type { Location } from './../../packages/parse5/lib/common/token';

// Ensure the default tree adapter matches the expected type.
defaultTreeAdapter as TreeAdapter<
    TreeAdapterTypeMap<
        defaultTreeAdapter.Node,
        defaultTreeAdapter.NodeWithChildren,
        defaultTreeAdapter.NodeWithParent,
        defaultTreeAdapter.Document,
        defaultTreeAdapter.DocumentFragment,
        defaultTreeAdapter.Element,
        defaultTreeAdapter.CommentNode,
        defaultTreeAdapter.TextNode,
        defaultTreeAdapter.Template,
        defaultTreeAdapter.DocumentType
    >
>;

export const treeAdapters = {
    default: defaultTreeAdapter,
    htmlparser2: htmlTreeAdapter,
} as const;

export function addSlashes(str: string) {
    return str
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\f/g, '\\f')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\u0000');
}

function createDiffMarker(markerPosition: number) {
    return '^\n'.padStart(markerPosition + 1, ' ');
}

function getRandomChunkSize(min = 1, max = 10) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

export function makeChunks(str: string, minSize?: number, maxSize?: number) {
    if (!str.length) {
        return [''];
    }

    const chunks = [];
    let start = 0;

    // NOTE: add 1 as well, so we avoid situation when we have just one huge chunk
    let end = Math.min(getRandomChunkSize(minSize, maxSize), str.length, 1);

    while (start < str.length) {
        chunks.push(str.substring(start, end));
        start = end;
        end = Math.min(end + getRandomChunkSize(minSize, maxSize), str.length);
    }

    return chunks;
}

export class WritableStreamStub extends Writable {
    writtenData = '';

    constructor() {
        super({ decodeStrings: false });
    }

    override _write(chunk: string, _encoding: string, callback: () => void) {
        assert.strictEqual(typeof chunk, 'string', 'Expected output to be a string stream');
        this.writtenData += chunk;
        callback();
    }
}

export function normalizeNewLine(str: string) {
    return str.replace(/\r\n/g, '\n');
}

export function removeNewLines(str: string) {
    return str.replace(/\r/g, '').replace(/\n/g, '');
}

export function writeChunkedToStream(str: string, stream: Writable) {
    const chunks = makeChunks(str);
    const lastChunkIdx = chunks.length - 1;

    chunks.forEach((chunk, idx) => {
        if (idx === lastChunkIdx) {
            stream.end(chunk);
        } else {
            stream.write(chunk);
        }
    });
}

export function generateTestsForEachTreeAdapter(
    name: string,
    ctor: (tests: Record<string, () => void>, adapter: any) => void
) {
    describe(name, () => {
        Object.keys(treeAdapters).forEach((adapterName) => {
            const tests = {};
            const adapter = treeAdapters[adapterName as keyof typeof treeAdapters];

            ctor(tests, adapter);

            Object.keys(tests).forEach((testName) => {
                it(`Tree adapter: ${adapterName} - ${testName}`, tests[testName as keyof typeof tests]);
            });
        });
    });
}

export function getStringDiffMsg(actual: string, expected: string) {
    for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
            let diffMsg = `\nString differ at index ${i}\n`;

            const expectedStr = `Expected: ${addSlashes(expected.substring(i - 100, i + 1))}`;
            const expectedDiffMarker = createDiffMarker(expectedStr.length);

            diffMsg += `${expectedStr}${addSlashes(expected.substring(i + 1, i + 20))}\n${expectedDiffMarker}`;

            const actualStr = `Actual:   ${addSlashes(actual.substring(i - 100, i + 1))}`;
            const actualDiffMarker = createDiffMarker(actualStr.length);

            diffMsg += `${actualStr}${addSlashes(actual.substring(i + 1, i + 20))}\n${actualDiffMarker}`;

            return diffMsg;
        }
    }

    return '';
}

export function getSubstringByLineCol(lines: string[], loc: Location) {
    lines = lines.slice(loc.startLine - 1, loc.endLine);

    const last = lines.length - 1;

    lines[last] = lines[last].substring(0, loc.endCol - 1);
    lines[0] = lines[0].substring(loc.startCol - 1);

    return lines.join('\n');
}
