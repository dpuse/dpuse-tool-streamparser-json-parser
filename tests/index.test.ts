// ── External Dependencies & Registrations
import { describe, expect, it, vi } from 'vitest';

// ── DPUse Framework
import type { BuildStructureIndexOptions, ListStructureEntriesOptions, ParsedRecordsChunk, ParseStreamOptions } from '@dpuse/dpuse-shared';
import type { ParseStreamSummary, ParseTextOptions, StructureIndex, StructureLocator, StructurePath } from '@dpuse/dpuse-shared';

// ── Local Framework
import { Tool } from '@/index';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Two, three and four byte characters, escapes, empty containers and numbers JavaScript cannot hold exactly.
const NESTED_JSON = `{"meta":{"title":"Ünïcødé 名前 😀 \\"q\\" \\\\ \\n \\u00e9","empty":{},"none":[],"flags":[true,false,null]},
"orders":[{"id":12345678901234567890,"customer":"Kunde 😀","total":-0.5e-3,"items":[{"sku":"S-é","qty":1}],"address":{"city":"Zürich"}},
  {"id":2,"customer":"Ada","total":1E+400,"items":[],"address":{"city":"Basel"},"note":null}],
"values":[1,"two",[3]]}`;

const ORDER_COUNT = 2500;

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Tool', () => {
    describe('buildStructureIndex', () => {
        // One-byte chunks split every multi-byte character and token across chunks.
        it.each([1, 3, 64 * 1024])('gives each node a byte range that reads back as that node, in %i byte chunks', async (chunkSize) => {
            const bytes = encode(NESTED_JSON);

            const index = await buildIndex(bytes, { maxDepth: 10 }, chunkSize);

            const whole = JSON.parse(NESTED_JSON) as unknown;
            expect(index.byteCount).toBe(bytes.length);
            expect(index.nodes.map((node) => node.path)).toEqual([
                [],
                ['meta'],
                ['meta', 'empty'],
                ['meta', 'none'],
                ['meta', 'flags'],
                ['orders'],
                ['orders', 0],
                ['orders', 0, 'items'],
                ['orders', 0, 'items', 0],
                ['orders', 0, 'address'],
                ['values']
            ]);
            for (const node of index.nodes) expect(readRange(bytes, node.locator)).toEqual(readPath(whole, node.path));
            expect(index).toMatchObject({ isComplete: true, issues: [] });
        });

        it('counts children and lists keys, with a list taking the keys of its object items', async () => {
            const index = await buildIndex(encode(NESTED_JSON), { maxDepth: 10 });

            expect(findNode(index, [])).toMatchObject({ childCount: 3, isTableCandidate: false, keys: ['meta', 'orders', 'values'], kindId: 'object' });
            expect(findNode(index, ['orders'])).toMatchObject({
                childCount: 2,
                isTableCandidate: true,
                keys: ['id', 'customer', 'total', 'items', 'address', 'note'],
                kindId: 'list'
            });
            expect(findNode(index, ['values'])).toMatchObject({ childCount: 3, isTableCandidate: false, keys: [] });
            expect(findNode(index, ['meta', 'none'])).toMatchObject({ childCount: 0, isTableCandidate: false });
        });

        it('leaves out lists and objects nested deeper than the maximum depth', async () => {
            const index = await buildIndex(encode(NESTED_JSON), { maxDepth: 1 });

            expect(index.nodes.map((node) => node.path)).toEqual([[], ['meta'], ['orders'], ['values']]);
            expect(findNode(index, ['orders'])?.childCount).toBe(2);
        });

        // The index stays small however long a list is.
        it('indexes only the first item of a list, with nothing inside the others', async () => {
            const index = await buildIndex(encode('[{"a":[1]},{"b":[2]},[{"c":{}}]]'), { maxDepth: 10 });

            expect(index.nodes.map((node) => node.path)).toEqual([[], [0], [0, 'a']]);
            expect(findNode(index, [])).toMatchObject({ childCount: 3, isTableCandidate: false, keys: ['a', 'b'] });
        });

        it('marks where every thousandth item of a list starts', async () => {
            const bytes = encode(constructOrdersJson());

            const index = await buildIndex(bytes, { maxDepth: 1 });

            const checkpoints = findNode(index, ['orders'])?.checkpoints ?? [];
            expect(checkpoints.map((checkpoint) => checkpoint.itemIndex)).toEqual([0, 1000, 2000]);
            for (const { itemIndex, locator } of checkpoints) {
                const text = decode(bytes.subarray(locator.startOffset, locator.startOffset + 20));
                expect(text.startsWith(`{"id":${String(itemIndex)},`)).toBe(true);
                expect(locator.endOffset).toBe(findNode(index, ['orders'])?.locator.endOffset);
            }
        });

        it('maps JSON Lines as a list of lines that ends with the item', async () => {
            const text = '{"a":1}\n{"a":2,"b":{"c":[1]}}\n\n[3]\n';

            const index = await buildIndex(encode(text), { dataFormatId: 'jsonl', maxDepth: 10 });

            expect(index.nodes.map((node) => node.path)).toEqual([[], [0]]);
            expect(findNode(index, [])).toMatchObject({ childCount: 3, isTableCandidate: false, keys: ['a', 'b'], locator: { endOffset: encode(text).length, startOffset: 0 } });
            expect(index.suggestedStructurePath).toEqual([]);
        });

        it('counts offsets from the start of the item when it begins with a byte order mark', async () => {
            const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('{"a":[1,2]}')]);

            const index = await buildIndex(bytes, {});

            const node = findNode(index, ['a']);
            expect(node == null ? undefined : readRange(bytes, node.locator)).toEqual([1, 2]);
        });

        it('reports progress as bytes are read', async () => {
            const onProgress = vi.fn();

            await buildIndex(encode('[1,2,3]'), { onProgress }, 3);

            expect(onProgress.mock.calls.map(([byteCount]) => byteCount as number)).toEqual([3, 6, 7]);
        });

        it.each([
            ['a closing bracket that does not match', '{"a":[1}', "Unexpected '}' on line 1, column 8.", '{"a":[1}'],
            ['a missing comma', '[1 2]', "Expected ',' on line 1, column 4.", '[1 2]'],
            ['content after the end', '{"a":1} 2', 'Unexpected content after the end of the JSON on line 1, column 9.', '{"a":1} 2'],
            ['JSON cut short', '{"a":[1', 'The JSON ends before it is complete on line 1, column 8.', '{"a":[1'],
            ['an empty item', '', 'The JSON is empty on line 1, column 1.', ''],
            ['a character the tokenizer cannot read', '[1,\n x]', "Unexpected 'x' on line 2, column 2.", ' x]']
        ])('reports %s with its line, column and the text around it, keeping what was read before it', async (_label, text, message, excerpt) => {
            const index = await buildIndex(encode(text), {});

            expect(index.isComplete).toBe(false);
            expect(index.issues).toEqual([expect.objectContaining({ id: 'JSON_INVALID', message, severityId: 'error', value: excerpt })]);
        });

        // A preview stops part way, so lists and objects still open there are kept with what was read of them.
        it('maps the start of an item without an error, marking what it did not see the end of', async () => {
            const index = await buildIndex(encode('{"rows":[{"a":1},{"a":2},{"a'), { isComplete: false });

            expect(index).toMatchObject({ isComplete: false, issues: [], suggestedStructurePath: ['rows'], tableCandidateCount: 1 });
            expect(findNode(index, ['rows'])).toMatchObject({ childCount: 3, isComplete: false, isTableCandidate: true, locator: { endOffset: undefined } });
            expect(findNode(index, ['rows', 0])).toMatchObject({ isComplete: true });
        });

        it.each([
            ['a list of objects at the top', '[{"a":1}]', [], 1],
            ['the only list of objects', '{"meta":{"b":2},"rows":[{"a":1,"items":[{"c":3}]}]}', ['rows'], 1],
            ['nothing when several lists read as rows', '{"orders":[{"a":1}],"customers":[{"b":2}]}', undefined, 2],
            ['nothing when no list reads as rows', '{"values":[1,2]}', undefined, 0]
        ] as const)('suggests %s as the table', async (_label, text, suggestedStructurePath, tableCandidateCount) => {
            const index = await buildIndex(encode(text), { maxDepth: 10 });

            expect(index.suggestedStructurePath).toEqual(suggestedStructurePath);
            expect(index.tableCandidateCount).toBe(tableCandidateCount);
        });

        it('does not read an item in an encoding other than UTF-8', async () => {
            const index = await buildIndex(encode('[]'), { encodingId: 'utf-16le' });

            expect(index).toMatchObject({ isComplete: false, nodes: [], suggestedStructurePath: undefined });
            expect(index.issues).toEqual([expect.objectContaining({ id: 'JSON_ENCODING', message: 'JSON must be encoded as UTF-8.' })]);
        });

        it('stops when the signal is aborted', async () => {
            const controller = new AbortController();
            controller.abort(new Error('Cancelled.'));

            await expect(buildIndex(encode('[1]'), { abortSignal: controller.signal })).rejects.toThrow('Cancelled.');
        });
    });

    describe('listStructureEntries', () => {
        it('lists one level of a node, with byte ranges that read back as each entry', async () => {
            const bytes = encode(NESTED_JSON);
            const index = await buildIndex(bytes, { maxDepth: 10 });
            const order = findNode(index, ['orders', 0]);

            const result = await listEntries(bytes, { locator: order?.locator, path: ['orders', 0] });

            expect(result).toMatchObject({ issues: [], nextLocator: undefined });
            expect(result.entries.map(({ childCount, key, kindId, value }) => ({ childCount, key, kindId, value }))).toEqual([
                { childCount: undefined, key: 'id', kindId: 'number', value: '12345678901234567890' },
                { childCount: undefined, key: 'customer', kindId: 'string', value: 'Kunde 😀' },
                { childCount: undefined, key: 'total', kindId: 'number', value: '-0.5e-3' },
                { childCount: 1, key: 'items', kindId: 'list', value: undefined },
                { childCount: 1, key: 'address', kindId: 'object', value: undefined }
            ]);
            const whole = JSON.parse(NESTED_JSON) as unknown;
            for (const entry of result.entries) expect(readRange(bytes, entry.locator)).toEqual(readPath(whole, ['orders', 0, entry.key]));
        });

        // A connection can drop part way. The caller is told, and nothing is left unhandled, which the browser would log
        // as an uncaught error.
        it('fails with the stream’s own error when the stream fails part way, leaving nothing unhandled', async () => {
            const failure = new TypeError('network error');
            const unhandledRejection = vi.fn();
            process.on('unhandledRejection', unhandledRejection);
            const stream = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    controller.enqueue(encode('{"orders":[{"id":1},'));
                },
                pull: (controller) => {
                    controller.error(failure);
                }
            });

            await expect(
                new Tool().listStructureEntries(stream, {
                    abortSignal: new AbortController().signal,
                    dataFormatId: 'json',
                    entryCount: 100,
                    locator: { endOffset: undefined, startOffset: 0, state: undefined },
                    maxValueLength: undefined,
                    path: []
                })
            ).rejects.toBe(failure);
            await new Promise((resolve) => setTimeout(resolve, 0)); // Lets an unhandled rejection be reported.
            process.off('unhandledRejection', unhandledRejection);

            expect(unhandledRejection).not.toHaveBeenCalled();
        });

        it('lists only the entries asked for, and stops reading once it knows there are more', async () => {
            const bytes = encode(constructOrdersJson());
            const index = await buildIndex(bytes, { maxDepth: 1 });
            const orders = findNode(index, ['orders']);
            let pulledByteCount = 0;

            const result = await listEntries(bytes, { entryCount: 5, locator: orders?.locator, path: ['orders'] }, 1024, (byteCount) => (pulledByteCount += byteCount));

            expect(result.entries.map((entry) => entry.key)).toEqual([0, 1, 2, 3, 4]);
            expect(result.nextLocator).toBeDefined();
            expect(pulledByteCount).toBeLessThan(bytes.length / 10);
        });

        it('reads the next page from where the last one ended, in a list and in an object', async () => {
            const bytes = encode('{"list":[10,11,12,13,14],"object":{"a":1,"b":2,"c":3}}');
            const index = await buildIndex(bytes, {});

            const listPages = await listAllPages(bytes, ['list'], findNode(index, ['list'])?.locator);
            const objectPages = await listAllPages(bytes, ['object'], findNode(index, ['object'])?.locator);

            expect(listPages.map((page) => page.map(({ key, value }) => [key, value]))).toEqual([
                [
                    [0, '10'],
                    [1, '11']
                ],
                [
                    [2, '12'],
                    [3, '13']
                ],
                [[4, '14']]
            ]);
            expect(objectPages.map((page) => page.map(({ key }) => key))).toEqual([['a', 'b'], ['c']]);
        });

        it('lists a later page of a list from a checkpoint, numbering its items from there', async () => {
            const bytes = encode(constructOrdersJson());
            const index = await buildIndex(bytes, { maxDepth: 1 });
            const checkpoint = findNode(index, ['orders'])?.checkpoints.at(-1);

            const result = await listEntries(bytes, { entryCount: 3, locator: checkpoint?.locator, path: ['orders'] });

            expect(result.entries.map((entry) => entry.key)).toEqual([2000, 2001, 2002]);
            const [firstEntry] = result.entries;
            expect(firstEntry == null ? undefined : readRange(bytes, firstEntry.locator)).toMatchObject({ id: 2000 });
        });

        it('reaches the end of a list from a checkpoint near its end', async () => {
            const bytes = encode(constructOrdersJson());
            const index = await buildIndex(bytes, { maxDepth: 1 });
            const checkpoint = findNode(index, ['orders'])?.checkpoints.at(-1);

            const result = await listEntries(bytes, { entryCount: 1000, locator: checkpoint?.locator, path: ['orders'] });

            expect(result.entries).toHaveLength(ORDER_COUNT - 2000);
            expect(result.nextLocator).toBeUndefined();
        });

        it('cuts long text short and says so', async () => {
            const result = await listEntries(encode(`["${'x'.repeat(30)}","short"]`), { maxValueLength: 10, path: [] });

            expect(result.entries.map(({ isValueCut, value }) => ({ isValueCut, value }))).toEqual([
                { isValueCut: true, value: 'xxxxxxxxxx' },
                { isValueCut: false, value: 'short' }
            ]);
        });

        it('lists the lines of JSON Lines at the top, and plain JSON inside a line', async () => {
            const text = '{"a":1}\n{"b":[1,2]}\n7';
            const bytes = encode(text);

            const lines = await listEntries(bytes, { dataFormatId: 'jsonl', path: [] });
            const inner = await listEntries(bytes, { dataFormatId: 'jsonl', locator: { endOffset: undefined, startOffset: text.indexOf('{"b"'), state: undefined }, path: [1] });

            expect(lines.entries.map(({ childCount, key, kindId, value }) => ({ childCount, key, kindId, value }))).toEqual([
                { childCount: 1, key: 0, kindId: 'object', value: undefined },
                { childCount: 1, key: 1, kindId: 'object', value: undefined },
                { childCount: undefined, key: 2, kindId: 'number', value: '7' }
            ]);
            expect(lines.entries[2]?.locator.endOffset).toBe(bytes.length);
            expect(inner.entries.map((entry) => entry.key)).toEqual(['b']);
        });

        it('keeps the entries read before a syntax error and reports it', async () => {
            const result = await listEntries(encode('[1,2,}'), { path: [] });

            expect(result.entries.map((entry) => entry.key)).toEqual([0, 1]);
            expect(result.issues).toEqual([expect.objectContaining({ id: 'JSON_INVALID', lineNumber: 1, message: "Unexpected '}' on line 1, column 6." })]);
        });
    });

    describe('parseStream', () => {
        it('reads the list at the path as a header and one row per item, flattening nested objects', async () => {
            const { chunks, summary } = await readParse(encode(NESTED_JSON), { structurePath: ['orders'] });

            const records = chunks.flatMap((chunk) => chunk.records);
            expect(records).toEqual([
                ['id', 'customer', 'total', 'items', 'address.city', 'note'],
                ['12345678901234567890', 'Kunde 😀', '-0.5e-3', '[{"sku":"S-é","qty":1}]', 'Zürich', null],
                ['2', 'Ada', '1E+400', '[]', 'Basel', null]
            ]);
            expect(summary).toMatchObject({ isComplete: true, nonUniformRecordCount: 0, recordCount: 3 });
        });

        it('reads the whole item when no path is given', async () => {
            const { chunks } = await readParse(encode('[{"a":1},{"a":2}]'), {});

            expect(chunks.flatMap((chunk) => chunk.records)).toEqual([['a'], ['1'], ['2']]);
        });

        it('reads an object at the path as a single row, and a list of plain values as one column', async () => {
            const objectRows = await readParse(encode(NESTED_JSON), { structurePath: ['meta'] });
            const valueRows = await readParse(encode(NESTED_JSON), { structurePath: ['values'] });

            expect(objectRows.chunks.flatMap((chunk) => chunk.records)).toEqual([
                ['title', 'empty', 'none', 'flags'],
                ['Ünïcødé 名前 😀 "q" \\ \n é', '{}', '[]', '[true,false,null]']
            ]);
            expect(valueRows.chunks.flatMap((chunk) => chunk.records)).toEqual([['value'], ['1'], ['two'], ['[3]']]);
        });

        it('fixes the columns from the first chunk, and counts a later item with a new field as not uniform', async () => {
            const { chunks, summary } = await readParse(encode('[{"a":1},{"a":2},{"a":3,"b":4},{"b":5}]'), { chunkSize: 2 });

            expect(chunks.map((chunk) => chunk.records)).toEqual([
                [['a'], ['1'], ['2']],
                [['3'], [null]]
            ]);
            expect(summary).toMatchObject({ nonUniformRecordCount: 2, recordCount: 5 });
        });

        it('reads the lines of JSON Lines as rows', async () => {
            const { chunks } = await readParse(encode('{"a":1}\n{"a":2}\n'), { dataFormatId: 'jsonl' });

            expect(chunks.flatMap((chunk) => chunk.records)).toEqual([['a'], ['1'], ['2']]);
        });

        it('stops reading once the list at the path has been read', async () => {
            const bytes = encode(`{"first":[{"a":1}],"rest":${constructOrdersJson()}}`);
            let pulledByteCount = 0;

            const { summary } = await readParse(bytes, { structurePath: ['first'] }, 1024, (byteCount) => (pulledByteCount += byteCount));

            expect(summary.recordCount).toBe(2);
            expect(pulledByteCount).toBeLessThan(bytes.length / 10);
        });

        it('stops between items once the byte limit is passed, and says it did not finish', async () => {
            const text = '[{"a":1},{"a":2},{"a":3}]';

            const { chunks, summary } = await readParse(encode(text), { byteLimit: text.indexOf('{"a":2}') + 1 });

            expect(chunks.flatMap((chunk) => chunk.records)).toEqual([['a'], ['1'], ['2']]);
            expect(summary).toMatchObject({ isComplete: false, recordCount: 3 });
        });

        it('stops at the end of the next item when the stop signal fires', async () => {
            const controller = new AbortController();
            controller.abort();

            const { summary } = await readParse(encode('[{"a":1},{"a":2}]'), { stopSignal: controller.signal });

            expect(summary).toMatchObject({ isComplete: false, recordCount: 2 });
        });

        it('does not read an item in an encoding other than UTF-8', async () => {
            const bytes = new Uint8Array(Buffer.from('[{"a":"é"}]', 'utf16le'));

            await expect(readParse(bytes, { encodingId: 'utf-16le' })).rejects.toThrow('JSON must be encoded as UTF-8.');
        });

        it('fails when nothing is at the path', async () => {
            await expect(readParse(encode(NESTED_JSON), { structurePath: ['missing'] })).rejects.toThrow("Nothing found at 'missing'.");
        });

        it('fails on JSON that is not valid, naming the line and column', async () => {
            await expect(readParse(encode('[\n{"a":1},]'), {}, 3)).rejects.toThrow("Unexpected ']' on line 2, column 9.");
        });

        it('fails on a line of JSON Lines that is not valid', async () => {
            await expect(readParse(encode('{"a":1}\n{"a":}\n'), { dataFormatId: 'jsonl' })).rejects.toThrow("Unexpected '}' on line 2, column 6.");
        });

        it('stops when the signal is aborted', async () => {
            const controller = new AbortController();
            controller.abort(new Error('Cancelled.'));

            await expect(readParse(encode('[1]'), { abortSignal: controller.signal })).rejects.toThrow('Cancelled.');
        });
    });

    describe('parseText', () => {
        it('reads complete text with no issues', async () => {
            const result = await parseText('[{"a":1},{"a":2}]', { isComplete: true });

            expect(result.parsedRecords).toEqual([['a'], ['1'], ['2']]);
            expect(result).toMatchObject({ hasHeaders: true, issues: [] });
        });

        // A preview is cut wherever its byte limit falls, usually inside an item.
        it('keeps the items before the cut in text cut short, without an issue', async () => {
            const result = await parseText('[{"a":1},{"a":2},{"a":', { isComplete: false });

            expect(result.parsedRecords).toEqual([['a'], ['1'], ['2']]);
            expect(result.issues).toEqual([]);
        });

        it('reports JSON that is not valid with the line it is on', async () => {
            const result = await parseText('[\n{"a":1},\n{"a" 2}]', { isComplete: true });

            expect(result.issues).toEqual([
                expect.objectContaining({
                    columnNumber: 6,
                    id: 'JSON_INVALID',
                    lineNumber: 3,
                    message: "Expected ':' on line 3, column 6.",
                    severityId: 'error',
                    value: '{"a" 2}]'
                })
            ]);
        });

        it('reports a line of JSON Lines that is not valid and reads the lines after it', async () => {
            const result = await parseText('{"a":1}\n{"a":}\n{"a":3}\n', { dataFormatId: 'jsonl' });

            expect(result.parsedRecords).toEqual([['a'], ['1'], ['3']]);
            expect(result.issues).toEqual([expect.objectContaining({ columnNumber: 6, id: 'JSON_INVALID', lineNumber: 2, recordNumber: 2 })]);
        });

        it('does not report the last line of JSON Lines cut short', async () => {
            const result = await parseText('{"a":1}\n{"a":', { dataFormatId: 'jsonl', isComplete: false });

            expect(result.parsedRecords).toEqual([['a'], ['1']]);
            expect(result.issues).toEqual([]);
        });

        it('reads the list at the path', async () => {
            const result = await parseText(NESTED_JSON, { isComplete: true, structurePath: ['values'] });

            expect(result.parsedRecords).toEqual([['value'], ['1'], ['two'], ['[3]']]);
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

// A stream of the bytes from an offset, in chunks of the size given. 'onPull' sees each chunk's size as it is read.
function streamOf(bytes: Uint8Array, chunkSize = 64 * 1024, startOffset = 0, onPull?: (byteCount: number) => void): ReadableStream<Uint8Array> {
    let offset = startOffset;
    return new ReadableStream<Uint8Array>({
        pull(controller): void {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            const chunk = bytes.slice(offset, offset + chunkSize);
            offset += chunk.length;
            onPull?.(chunk.length);
            controller.enqueue(chunk);
        }
    });
}

function constructOrdersJson(): string {
    const orders = Array.from({ length: ORDER_COUNT }, (_, index) => ({ id: index, name: `Kunde ${String(index)} 😀` }));
    return JSON.stringify({ orders });
}

function readPath(value: unknown, path: StructurePath): unknown {
    let current = value;
    for (const segment of path) current = (current as Record<number | string, unknown>)[segment];
    return current;
}

// The JSON a locator's byte range holds.
function readRange(bytes: Uint8Array, locator: StructureLocator): unknown {
    return JSON.parse(decode(bytes.subarray(locator.startOffset, locator.endOffset)));
}

function findNode(index: StructureIndex, path: StructurePath): StructureIndex['nodes'][number] | undefined {
    return index.nodes.find((node) => node.path.length === path.length && node.path.every((segment, segmentIndex) => segment === path[segmentIndex]));
}

function buildIndex(bytes: Uint8Array, overrides: Partial<BuildStructureIndexOptions>, chunkSize?: number): Promise<StructureIndex> {
    const options: BuildStructureIndexOptions = {
        abortSignal: new AbortController().signal,
        dataFormatId: 'json',
        encodingId: 'utf-8',
        isComplete: true,
        maxDepth: undefined,
        onProgress: undefined,
        ...overrides
    };
    return new Tool().buildStructureIndex(streamOf(bytes, chunkSize), options);
}

// Lists a page, reading the bytes the locator names as a connector would. A missing locator starts at the top.
function listEntries(
    bytes: Uint8Array,
    overrides: Partial<Omit<ListStructureEntriesOptions, 'locator'>> & { locator?: StructureLocator | undefined; path: StructurePath },
    chunkSize?: number,
    onPull?: (byteCount: number) => void
): ReturnType<Tool['listStructureEntries']> {
    const options: ListStructureEntriesOptions = {
        abortSignal: new AbortController().signal,
        dataFormatId: 'json',
        entryCount: 100,
        maxValueLength: undefined,
        ...overrides,
        locator: overrides.locator ?? { endOffset: undefined, startOffset: 0, state: undefined }
    };
    const rangeBytes = bytes.subarray(0, options.locator.endOffset ?? bytes.length);
    return new Tool().listStructureEntries(streamOf(rangeBytes, chunkSize, options.locator.startOffset, onPull), options);
}

// Every page of a node, two entries at a time, each read from where the last one said the next starts.
async function listAllPages(
    bytes: Uint8Array,
    path: StructurePath,
    locator: StructureLocator | undefined
): Promise<Awaited<ReturnType<Tool['listStructureEntries']>>['entries'][]> {
    const pages: Awaited<ReturnType<Tool['listStructureEntries']>>['entries'][] = [];
    let nextLocator = locator;
    while (nextLocator != null) {
        const page = await listEntries(bytes, { entryCount: 2, locator: nextLocator, path });
        pages.push(page.entries);
        nextLocator = page.nextLocator;
    }
    return pages;
}

// Reads a parse through, keeping each chunk and the summary it ends with.
async function readParse(
    bytes: Uint8Array,
    overrides: Partial<ParseStreamOptions>,
    chunkSize?: number,
    onPull?: (byteCount: number) => void
): Promise<{ chunks: ParsedRecordsChunk[]; summary: ParseStreamSummary }> {
    const options: ParseStreamOptions = {
        abortSignal: new AbortController().signal,
        chunkSize: undefined,
        dataFormatId: 'json',
        encodingId: 'utf-8',
        valueDelimiterId: '',
        ...overrides
    };
    const parsing = new Tool().parseStream(streamOf(bytes, chunkSize, 0, onPull), options);
    const chunks: ParsedRecordsChunk[] = [];
    let result = await parsing.next();
    while (result.done !== true) {
        chunks.push(result.value);
        result = await parsing.next();
    }
    return { chunks, summary: result.value };
}

function parseText(text: string, overrides: Partial<ParseTextOptions>): ReturnType<Tool['parseText']> {
    return new Tool().parseText(text, { dataFormatId: 'json', isComplete: true, valueDelimiterIds: [], ...overrides });
}
