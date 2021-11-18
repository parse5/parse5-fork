import * as assert from 'assert';
import * as fs from 'fs';
import * as parse5 from '../../packages/parse5/lib/index.js';
import type { TreeAdapterTypeMap } from '../../packages/parse5/lib/tree-adapters/interface.js';
import { generateTestsForEachTreeAdapter, getStringDiffMsg } from './common.js';

export function generateSerializerTests(
    name: string,
    prefix: string,
    serialize: (
        document: TreeAdapterTypeMap['document'],
        opts: parse5.SerializerOptions<TreeAdapterTypeMap>
    ) => Promise<string> | string
) {
    const data = fs.readFileSync(new URL('../data/serialization/tests.json', import.meta.url), 'utf-8');
    const tests = JSON.parse(data) as {
        name: string;
        input: string;
        expected: string;
    }[];

    generateTestsForEachTreeAdapter(name, (treeAdapter) => {
        tests.forEach((test, idx) => {
            it(`${prefix} - ${idx}.${test.name}`, async () => {
                const opts = { treeAdapter };
                const document = parse5.parse(test.input, opts);
                const serializedResult = await serialize(document, opts);

                //NOTE: use ok assertion, so output will not be polluted by the whole content of the strings
                assert.ok(serializedResult === test.expected, getStringDiffMsg(serializedResult, test.expected));
            });
        });
    });
}
