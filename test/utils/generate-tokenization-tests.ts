import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Tokenizer } from '../../packages/parse5/lib/tokenizer/index.js';
import { makeChunks } from './common.js';
import type { Attribute, Token } from './../../packages/parse5/lib/common/token';

type HtmlLibToken = [string, string | null, ...unknown[]];

export function convertTokenToHtml5Lib(token: Token): HtmlLibToken {
    switch (token.type) {
        case Tokenizer.CHARACTER_TOKEN:
        case Tokenizer.NULL_CHARACTER_TOKEN:
        case Tokenizer.WHITESPACE_CHARACTER_TOKEN:
            return ['Character', token.chars];

        case Tokenizer.START_TAG_TOKEN: {
            const reformatedAttrs: Record<string, string> = {};

            token.attrs.forEach((attr: Attribute) => {
                reformatedAttrs[attr.name] = attr.value;
            });

            const startTagEntry: HtmlLibToken = ['StartTag', token.tagName, reformatedAttrs];

            if (token.selfClosing) {
                startTagEntry.push(true);
            }

            return startTagEntry;
        }

        case Tokenizer.END_TAG_TOKEN:
            // NOTE: parser feedback simulator can produce adjusted SVG
            // tag names for end tag tokens so we need to lower case it
            return ['EndTag', token.tagName.toLowerCase()];

        case Tokenizer.COMMENT_TOKEN:
            return ['Comment', token.data];

        case Tokenizer.DOCTYPE_TOKEN:
            return ['DOCTYPE', token.name, token.publicId, token.systemId, !token.forceQuirks];

        default:
            throw new TypeError(`Unrecognized token type: ${token.type}`);
    }
}

function sortErrors(result: { errors: { line: number; col: number }[] }) {
    result.errors.sort((err1, err2) => err1.line - err2.line || err1.col - err2.col);
}

type TokenSourceCreator = (data: { tokens: Token[]; errors: { code: string; line: number; col: number }[] }) => {
    tokenizer: Tokenizer;
    getNextToken: () => Token;
};

function tokenize(
    createTokenSource: TokenSourceCreator,
    chunks: string | string[],
    initialState: Tokenizer['state'],
    lastStartTag: string | null
) {
    const result = { tokens: [], errors: [] };
    const { tokenizer, getNextToken } = createTokenSource(result);
    let token: Token = { type: Tokenizer.HIBERNATION_TOKEN };
    let chunkIdx = 0;

    // NOTE: set small waterline for testing purposes
    tokenizer.preprocessor.bufferWaterline = 8;
    tokenizer.state = initialState;

    if (lastStartTag) {
        tokenizer.lastStartTagName = lastStartTag;
    }

    function writeChunk() {
        const chunk = chunks[chunkIdx];

        tokenizer.write(chunk, ++chunkIdx === chunks.length);
    }

    do {
        if (token.type === Tokenizer.HIBERNATION_TOKEN) {
            writeChunk();
        } else {
            appendTokenEntry(result.tokens, convertTokenToHtml5Lib(token));
        }

        token = getNextToken();
    } while (token.type !== Tokenizer.EOF_TOKEN);

    sortErrors(result);

    return result;
}

function unicodeUnescape(str: string) {
    return str.replace(/\\u([\d\w]{4})/gi, (_match: string, chCodeStr: string) =>
        String.fromCharCode(parseInt(chCodeStr, 16))
    );
}

function unescapeDescrIO(testDescr: TestDescription) {
    testDescr.input = unicodeUnescape(testDescr.input);

    testDescr.output.forEach((tokenEntry) => {
        //NOTE: unescape token tagName (for StartTag and EndTag tokens), comment data (for Comment token),
        //character token data (for Character token).
        if (tokenEntry[1]) {
            tokenEntry[1] = unicodeUnescape(tokenEntry[1]);
        }
    });
}

function appendTokenEntry(result: HtmlLibToken[], tokenEntry: HtmlLibToken) {
    if (tokenEntry[0] === 'Character') {
        const lastEntry = result[result.length - 1];

        if (lastEntry && lastEntry[0] === 'Character') {
            lastEntry[1]! += tokenEntry[1];
            return;
        }
    }

    result.push(tokenEntry);
}

function concatCharacterTokens(tokenEntries: HtmlLibToken[]) {
    const result: HtmlLibToken[] = [];

    tokenEntries.forEach((tokenEntry) => appendTokenEntry(result, tokenEntry));

    return result;
}

function getTokenizerSuitableStateName(testDataStateName: string) {
    const state =
        Tokenizer.MODE[testDataStateName.slice(0, -6).replace(' ', '_').toUpperCase() as keyof typeof Tokenizer.MODE];

    return state;
}

interface TestDescription {
    initialStates: string[];
    doubleEscaped?: boolean;
    output: HtmlLibToken[];
    description: string;
    input: string;
    lastStartTag: string;
    errors?: string[];
}

interface LoadedTest {
    idx: number;
    setName: string;
    name: string;
    input: string;
    expected: HtmlLibToken[];
    initialState: typeof Tokenizer.MODE[keyof typeof Tokenizer.MODE];
    lastStartTag: string;
    expectedErrors: string[];
}

function loadTests(dataDirPath: string): LoadedTest[] {
    const testSetFileNames = fs.readdirSync(dataDirPath);
    const tests: LoadedTest[] = [];
    let testIdx = 0;

    testSetFileNames.forEach((fileName) => {
        if (path.extname(fileName) !== '.test') {
            return;
        }

        const filePath = path.join(dataDirPath, fileName);
        const testSetJson = fs.readFileSync(filePath).toString();
        const testSet = JSON.parse(testSetJson);
        const testDescrs = testSet.tests;

        if (!testDescrs) {
            return;
        }

        const setName = fileName.replace('.test', '');

        testDescrs.forEach((descr: TestDescription) => {
            if (!descr.initialStates) {
                descr.initialStates = ['Data state'];
            }

            if (descr.doubleEscaped) {
                unescapeDescrIO(descr);
            }

            const expected = descr.output;

            descr.initialStates.forEach((initialState: string) => {
                tests.push({
                    idx: ++testIdx,
                    setName,
                    name: descr.description,
                    input: descr.input,
                    expected: concatCharacterTokens(expected),
                    initialState: getTokenizerSuitableStateName(initialState),
                    lastStartTag: descr.lastStartTag,
                    expectedErrors: descr.errors || [],
                });
            });
        });
    });

    return tests;
}

export function generateTokenizationTests(
    _name: string,
    prefix: string,
    testSuite: string,
    createTokenSource: TokenSourceCreator
) {
    loadTests(testSuite).forEach((testData) => {
        const testName = `${prefix} - ${testData.idx}.${testData.setName} - ${testData.name} - Initial state: ${testData.initialState}`;

        it(testName, () => {
            const chunks = makeChunks(testData.input);
            const result = tokenize(
                createTokenSource,
                chunks,
                testData.initialState as typeof Tokenizer.MODE[keyof typeof Tokenizer.MODE],
                testData.lastStartTag
            );

            assert.deepEqual(result.tokens, testData.expected, `Chunks: ${JSON.stringify(chunks)}`);
            assert.deepEqual(result.errors, testData.expectedErrors || []);
        });
    });
}
