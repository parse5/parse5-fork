import * as assert from 'node:assert';
import * as parse5 from '@parse5/parse5/lib/index.js';
import { PlainTextConversionStream } from '../lib/index.js';
import { generateTestsForEachTreeAdapter } from '../../../test/utils/common.js';

generateTestsForEachTreeAdapter('plain-test-conversion-stream', (treeAdapter) => {
    it('Plain text conversion stream', function () {
        const converter = new PlainTextConversionStream({ treeAdapter });

        converter.write('Hey');
        converter.write('\r\nyo');
        converter.write('\u0000');
        converter.end('<html><head><body>');

        const result = parse5.serialize(converter.document, { treeAdapter });

        assert.strictEqual(
            result,
            '<html><head></head><body><pre>\nHey\nyo\uFFFD&lt;html&gt;&lt;head&gt;&lt;body&gt;</pre></body></html>'
        );
    });
});

describe('plain-text-conversion-stream', () => {
    it('Should not accept binary input (GH-269)', () => {
        const stream = new PlainTextConversionStream();
        const buf = Buffer.from('test');

        assert.throws(() => stream.write(buf), TypeError);
    });
});
