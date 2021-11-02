import { readFileSync, createReadStream, readdirSync } from 'node:fs';
import Benchmark from 'benchmark';
import { loadTreeConstructionTestData } from '../../test/utils/generate-parsing-tests.js';
import { loadSAXParserTestData } from '../../test/utils/load-sax-parser-test-data.js';
import { treeAdapters, WritableStreamStub } from '../../test/utils/common.js';
import * as parse5 from '../../packages/parse5/lib/index.js';
import { ParserStream as parse5Stream } from '../../packages/parse5-parser-stream/lib/index.js';
import parse5Upstream from 'parse5';
import path from 'path';

const hugePagePath = new URL('../../test/data/huge-page/huge-page.html', import.meta.url);
const treeConstructionPath = new URL('../../test/data/html5lib-tests/tree-construction', import.meta.url);
const saxPath = new URL('../../test/data/sax/', import.meta.url);

//HACK: https://github.com/bestiejs/benchmark.js/issues/51
/* global workingCopy, WorkingCopyParserStream, upstreamParser, hugePage, microTests, runMicro, runPages, files */
global.workingCopy = parse5;
global.WorkingCopyParserStream = parse5Stream;
global.upstreamParser = parse5Upstream;

// Huge page data
global.hugePage = readFileSync(hugePagePath).toString();

// Micro data
global.microTests = loadTreeConstructionTestData([treeConstructionPath], treeAdapters.default)
    .filter(
        (test) =>
            //NOTE: this test caused stack overflow in parse5 v1.x
            test.input !== '<button><p><button>'
    )
    .map((test) => ({
        html: test.input,
        fragmentContext: test.fragmentContext,
    }));

global.runMicro = function (parser) {
    for (const test of microTests) {
        if (test.fragmentContext) {
            parser.parseFragment(test.fragmentContext, test.html);
        } else {
            parser.parse(test.html);
        }
    }
};

// Pages data
const pages = loadSAXParserTestData().map((test) => test.src);

global.runPages = function (parser) {
    for (let j = 0; j < pages.length; j++) {
        parser.parse(pages[j]);
    }
};

// Stream data
global.files = readdirSync(saxPath).map((dirName) => {
    return new URL(`${dirName}/src.html`, saxPath).pathname;
});

// Utils
function getHz(suite, testName) {
    return suite.find((t) => t.name === testName).hz;
}

function runBench({ name, workingCopyFn, upstreamFn, defer = false }) {
    const suite = new Benchmark.Suite(name);

    suite
        .add('Working copy', workingCopyFn, { defer })
        .add('Upstream', upstreamFn, { defer })
        .on('start', () => console.log(name))
        .on('cycle', (event) => console.log(String(event.target)))
        .on('complete', () => {
            const workingCopyHz = getHz(suite, 'Working copy');
            const upstreamHz = getHz(suite, 'Upstream');

            if (workingCopyHz > upstreamHz) {
                console.log(`Working copy is ${(workingCopyHz / upstreamHz).toFixed(2)}x faster.\n`);
            } else {
                console.log(`Working copy is ${(upstreamHz / workingCopyHz).toFixed(2)}x slower.\n`);
            }
        })
        .run();
}

// Benchmarks
runBench({
    name: 'parse5 regression benchmark - MICRO',
    workingCopyFn: () => runMicro(workingCopy),
    upstreamFn: () => runMicro(upstreamParser),
});

runBench({
    name: 'parse5 regression benchmark - HUGE',
    workingCopyFn: () => workingCopy.parse(hugePage),
    upstreamFn: () => upstreamParser.parse(hugePage),
});

runBench({
    name: 'parse5 regression benchmark - PAGES',
    workingCopyFn: () => runPages(workingCopy),
    upstreamFn: () => runPages(upstreamParser),
});

runBench({
    name: 'parse5 regression benchmark - STREAM',
    defer: true,
    workingCopyFn: async (deferred) => {
        const parsePromises = files.map(
            (fileName) =>
                new Promise((resolve) => {
                    const stream = createReadStream(fileName, 'utf8');
                    const parserStream = new WorkingCopyParserStream();

                    stream.pipe(parserStream);
                    parserStream.on('finish', resolve);
                })
        );

        await Promise.all(parsePromises);
        deferred.resolve();
    },
    upstreamFn: async (deferred) => {
        const parsePromises = files.map(
            (fileName) =>
                new Promise((resolve) => {
                    const stream = createReadStream(fileName, 'utf8');
                    const writable = new WritableStreamStub();

                    writable.on('finish', () => {
                        upstreamParser.parse(writable.writtenData);
                        resolve();
                    });

                    stream.pipe(writable);
                })
        );

        await Promise.all(parsePromises);
        deferred.resolve();
    },
});
