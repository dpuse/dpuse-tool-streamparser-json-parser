// ── DPUse Framework
import type { BuildStructureIndexOptions, DataFormatId, ListStructureEntriesOptions, ListStructureEntriesResult, ParsedRecord } from '@dpuse/dpuse-shared';
import { ignoreErrors, resolveDecoderId } from '@dpuse/dpuse-shared';
import type { ParsedRecordsChunk, ParseStreamOptions, ParseStreamSummary, ParseTextOptions, ParseTextResult, SampleIssue } from '@dpuse/dpuse-shared';
import type { StructuredParserInterface, StructureEntry, StructureIndex, StructureNode } from '@dpuse/dpuse-shared';

// ── Local Framework
import { constructHeaderRecord, constructRecord, constructTableShape, createItemReader, flattenItem, type TableShape } from '@/itemRecords';
import { createStructureWalker, isNumberText, type JsonValue, type OpenContainer, type StructureWalker, type StructureWalkerOptions } from '@/structureWalker';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A node while its list or object is still being read. The set and flag work out its keys and whether it reads as rows.
interface NodeDraft {
    hasNonObjectItem: boolean;
    keySet: Set<string>;
    node: StructureNode;
}

// What a row parse has read and not yet handed over.
interface RowState {
    isHeaderSent: boolean;
    itemFields: Map<string, JsonValue>[];
    nonUniformRecordCount: number;
    recordCount: number;
    shape: TableShape | undefined;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_VALUE_LENGTH = 200;
const DEFAULT_RECORD_BUFFER_SIZE = 10_000;
const CHECKPOINT_ITEM_COUNT = 1000; // A list's items between checkpoints. A page read from a checkpoint skips at most this many items.
const INDEXED_ITEM_COUNT = 1; // A list's items indexed as nodes of their own.
const MAX_KEY_COUNT = 200; // The most keys a node lists, so an object used as a map with millions of keys stays small in the index.
const LINE_FEED_BYTE = 0x0a;

// WebKit hands over a file stream in pieces of about 18 MB, against about 2 MB in Chromium. Each piece is read in slices
// of this size, so rows are handed over and the abort checked often. A slice is a view, not a copy.
const MAX_SLICE_BYTE_COUNT = 1_048_576;

// Thrown to stop reading once enough is known. The tokenizer passes it back out of 'write'.
const STOP_READING = new Error('Reading stopped once enough was known.');

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class Tool implements StructuredParserInterface {
    /**
     * Build structure index. Reads the whole item once and maps its lists and objects down to 'maxDepth', with where
     * each starts and ends, so any of them can be read again on its own. Memory stays small however large the item.
     */
    async buildStructureIndex(stream: ReadableStream<Uint8Array>, options: BuildStructureIndexOptions): Promise<StructureIndex> {
        const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
        const drafts = new Map<OpenContainer, NodeDraft>();
        const nodes: StructureNode[] = [];
        const draftOf = (container: OpenContainer | undefined): NodeDraft | undefined => (container == null ? undefined : drafts.get(container));
        // A list's item: a checkpoint every so many items, and a note when an item is not an object.
        const takeItem = (parent: OpenContainer | undefined, key: number | string | undefined, startOffset: number, isObject: boolean): void => {
            const parentDraft = draftOf(parent);
            if (typeof key !== 'number' || parentDraft?.node.kindId !== 'list') return;
            if (key % CHECKPOINT_ITEM_COUNT === 0) parentDraft.node.checkpoints.push({ itemIndex: key, offset: startOffset });
            if (!isObject) parentDraft.hasNonObjectItem = true;
        };
        // A list's first items show the shape of the rest, which checkpoints locate, so a long list adds little to the
        // index. A list or object inside one not indexed is not indexed either.
        const isIndexed = (container: OpenContainer): boolean => {
            if (container.depth > maxDepth) return false;
            if (container.parent == null) return true;
            const isSampleItem = container.parent.kindId !== 'list' || (typeof container.key === 'number' && container.key < INDEXED_ITEM_COUNT);
            return isSampleItem && drafts.has(container.parent);
        };
        const walker = createStructureWalker(constructWalkerOptions(options.dataFormatId), {
            onContainerEnd: (container, endOffset) => {
                const draft = drafts.get(container);
                if (draft == null) return;
                draft.node.endOffset = endOffset;
                draft.node.childCount = container.childCount;
                draft.node.isTableCandidate = draft.node.kindId === 'list' && container.childCount > 0 && !draft.hasNonObjectItem;
                draft.node.keys = draft.keySet.values().toArray();
                drafts.delete(container);
            },
            onContainerStart: (container) => {
                takeItem(container.parent, container.key, container.startOffset, container.kindId === 'object');
                if (!isIndexed(container)) return;
                const node: StructureNode = {
                    checkpoints: [],
                    childCount: 0,
                    endOffset: NaN,
                    isTableCandidate: false,
                    keys: [],
                    kindId: container.kindId,
                    path: container.path,
                    startOffset: container.startOffset
                };
                nodes.push(node);
                drafts.set(container, { hasNonObjectItem: false, keySet: new Set(), node });
            },
            onKey: (container, key) => {
                addKey(draftOf(container), key);
                const parentDraft = draftOf(container.parent);
                if (parentDraft?.node.kindId === 'list') addKey(parentDraft, key); // A list's keys are those of its object items.
            },
            onScalar: (scalar) => {
                takeItem(scalar.parent, scalar.key, scalar.startOffset, false);
            }
        });
        const byteCount = await readStream(stream, options.abortSignal, walker, options.onProgress);
        // The lines of JSON Lines have no closing bracket, so they end where the item does.
        for (const node of nodes) if (Number.isNaN(node.endOffset)) node.endOffset = byteCount;
        return { byteCount, nodes };
    }

    /**
     * List structure entries. Lists one level of a list or object for a viewer that opens one level at a time. Reading
     * stops as soon as the entries asked for are known, so a page near the start of a large node is quick.
     */
    async listStructureEntries(stream: ReadableStream<Uint8Array>, options: ListStructureEntriesOptions): Promise<ListStructureEntriesResult> {
        const maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
        const entries: StructureEntry[] = [];
        let isMore = false;
        let openScalarEntry: StructureEntry | undefined; // A text, number or other single value only ends where the next token starts.
        const isLines = options.dataFormatId === 'jsonl' && options.path.length === 0;
        const walkerOptions: StructureWalkerOptions = {
            baseOffset: options.startOffset,
            firstItemIndex: options.firstItemIndex ?? 0,
            isJsonLines: isLines,
            isStartInsideList: options.firstItemIndex != null,
            rootPath: options.path
        };
        // Called as an entry starts. Once enough entries are known, one more means there are more, and reading stops.
        const startEntry = (entry: StructureEntry): void => {
            if (entries.length >= options.entryCount) {
                isMore = true;
                throw STOP_READING;
            }
            entries.push(entry);
        };
        const walker = createStructureWalker(walkerOptions, {
            onContainerEnd: (container, endOffset) => {
                if (container.depth === 0) throw STOP_READING;
                if (container.depth !== 1) return;
                const entry = entries.at(-1);
                if (entry == null) return;
                entry.endOffset = endOffset;
                entry.childCount = container.childCount;
            },
            onContainerStart: (container) => {
                if (container.depth !== 1) return;
                startEntry({
                    childCount: 0,
                    endOffset: NaN,
                    isValueCut: false,
                    key: container.key ?? '',
                    kindId: container.kindId,
                    startOffset: container.startOffset,
                    value: undefined
                });
            },
            onScalar: (scalar) => {
                if (scalar.parent?.depth !== 0) return;
                const text = describeScalar(scalar.value);
                const isValueCut = text != null && text.length > maxValueLength;
                openScalarEntry = {
                    childCount: undefined,
                    endOffset: NaN,
                    isValueCut,
                    key: scalar.key ?? '',
                    kindId: scalar.kindId,
                    startOffset: scalar.startOffset,
                    value: isValueCut ? text.slice(0, maxValueLength) : text
                };
                startEntry(openScalarEntry);
            },
            onTokenStart: (offset) => {
                if (openScalarEntry == null) return;
                openScalarEntry.endOffset = offset;
                openScalarEntry = undefined;
            }
        });
        const byteCount = await readStream(stream, options.abortSignal, walker, undefined);
        if (openScalarEntry != null) openScalarEntry.endOffset = options.startOffset + byteCount;
        return { entries, isMore };
    }

    /**
     * Parse stream. Reads the list at 'structurePath', or the whole item when it is not given, as rows: a header of
     * column names, then one row per item. The columns are those found in the first chunk of items. A later item with a
     * field outside them keeps its other fields and counts as not uniform. The caller owns the stream and its fetch.
     */
    async *parseStream(stream: ReadableStream<Uint8Array>, options: ParseStreamOptions): AsyncGenerator<ParsedRecordsChunk, ParseStreamSummary, undefined> {
        options.abortSignal.throwIfAborted();
        const recordsPerChunk = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_RECORD_BUFFER_SIZE));
        const rowState: RowState = { isHeaderSent: false, itemFields: [], nonUniformRecordCount: 0, recordCount: 0, shape: undefined };
        const itemReader = createItemReader(options.structurePath ?? [], (item) => {
            rowState.itemFields.push(flattenItem(item));
        });
        const walker = createStructureWalker(constructWalkerOptions(options.dataFormatId), itemReader.handlers);
        const transcode = constructTranscoder(options.encodingId);
        const reader = stream.getReader();
        const cancelRead = (): void => {
            ignoreErrors(() => void reader.cancel(options.abortSignal.reason));
        };
        options.abortSignal.addEventListener('abort', cancelRead, { once: true });

        let byteCount = 0;
        let lineCount = 0;
        try {
            let result = await reader.read();
            while (!result.done && !itemReader.isTargetClosed()) {
                byteCount += result.value.length;
                lineCount += countLineFeeds(result.value);
                for (let sliceStart = 0; sliceStart < result.value.length && !itemReader.isTargetClosed(); sliceStart += MAX_SLICE_BYTE_COUNT) {
                    options.abortSignal.throwIfAborted();
                    walker.write(transcode(result.value.subarray(sliceStart, sliceStart + MAX_SLICE_BYTE_COUNT), false));
                    yield* takeRows(rowState, recordsPerChunk, false);
                }
                if (!itemReader.isTargetClosed()) result = await reader.read();
            }
            options.abortSignal.throwIfAborted();
            if (!itemReader.isTargetClosed()) {
                walker.write(transcode(new Uint8Array(), true));
                walker.end();
            }
            if (!itemReader.isTargetFound()) throw new Error(`Nothing found at ${describePath(options.structurePath ?? [])}.`);
            yield* takeRows(rowState, recordsPerChunk, true);
            return { byteCount, commentLineCount: 0, emptyLineCount: 0, lineCount, nonUniformRecordCount: rowState.nonUniformRecordCount, recordCount: rowState.recordCount };
        } finally {
            options.abortSignal.removeEventListener('abort', cancelRead);
            ignoreErrors(() => void reader.cancel()); // Releases the item when reading stops before the end. A stream already read through ignores it.
        }
    }

    /**
     * Parse text. Reads a preview the same way as 'parseStream'. A preview cut short ends in the middle of the JSON, so
     * only an error in a complete item is an issue. The items read before the cut are kept.
     */
    parseText(text: string, options: ParseTextOptions): Promise<ParseTextResult> {
        const items: Map<string, JsonValue>[] = [];
        const itemReader = createItemReader(options.structurePath ?? [], (item) => {
            items.push(flattenItem(item));
        });
        const walker = createStructureWalker(constructWalkerOptions(options.dataFormatId), itemReader.handlers);
        const issues: SampleIssue[] = [];
        const bytes = new TextEncoder().encode(text);
        try {
            walker.write(bytes);
            if (options.isComplete) walker.end();
            if (options.isComplete && !itemReader.isTargetFound()) issues.push(constructIssue(`Nothing found at ${describePath(options.structurePath ?? [])}.`, bytes, undefined));
        } catch (error) {
            const isCutOff = !options.isComplete;
            if (!isCutOff) issues.push(constructIssue(error instanceof Error ? error.message : String(error), bytes, findErrorOffset(error)));
        }
        const shape = constructTableShape(items);
        const parsedRecords: ParsedRecord[] = items.length === 0 ? [] : [constructHeaderRecord(shape), ...items.map((fields) => constructRecord(fields, shape).record)];
        return Promise.resolve({ issues, parsedRecords, recordDelimiterId: '\n', valueDelimiterId: undefined }); // Synchronous, but the interface allows a parser that is not.
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

//#region: Reading helpers.

// Options for a walk of the whole item from its start.
function constructWalkerOptions(dataFormatId: DataFormatId): StructureWalkerOptions {
    return { baseOffset: 0, firstItemIndex: 0, isJsonLines: dataFormatId === 'jsonl', isStartInsideList: false, rootPath: [] };
}

// Feeds the stream to the walker a slice at a time, ends the walk, and returns the bytes read. Stops early, without
// error, when a handler has all it needs.
async function readStream(
    stream: ReadableStream<Uint8Array>,
    abortSignal: AbortSignal,
    walker: StructureWalker,
    onProgress: ((byteCount: number) => void) | undefined
): Promise<number> {
    abortSignal.throwIfAborted();
    const reader = stream.getReader();
    const cancelRead = (): void => {
        ignoreErrors(() => void reader.cancel(abortSignal.reason));
    };
    abortSignal.addEventListener('abort', cancelRead, { once: true });
    let byteCount = 0;
    try {
        let result = await reader.read();
        while (!result.done) {
            for (let sliceStart = 0; sliceStart < result.value.length; sliceStart += MAX_SLICE_BYTE_COUNT) {
                abortSignal.throwIfAborted();
                const slice = result.value.subarray(sliceStart, sliceStart + MAX_SLICE_BYTE_COUNT);
                byteCount += slice.length;
                walker.write(slice);
            }
            onProgress?.(byteCount);
            result = await reader.read();
        }
        abortSignal.throwIfAborted();
        walker.end();
        return byteCount;
    } catch (error) {
        if (error === STOP_READING) return byteCount;
        throw error;
    } finally {
        abortSignal.removeEventListener('abort', cancelRead);
        ignoreErrors(() => void reader.cancel());
    }
}

// JSON is UTF-8 by its standard, and the tokenizer reads only UTF-8. An item in another encoding is decoded and written
// again as UTF-8. Its offsets then no longer match the item, which only matters to the index, and an index is only built
// from UTF-8.
function constructTranscoder(encodingId: string): (bytes: Uint8Array, isFinal: boolean) => Uint8Array {
    const decoderId = resolveDecoderId(encodingId);
    if (decoderId === 'utf-8') return (bytes) => bytes;
    const decoder = new TextDecoder(decoderId);
    const encoder = new TextEncoder();
    return (bytes, isFinal) => encoder.encode(decoder.decode(bytes, { stream: !isFinal }));
}

function countLineFeeds(bytes: Uint8Array): number {
    let count = 0;
    for (let index = bytes.indexOf(LINE_FEED_BYTE); index !== -1; index = bytes.indexOf(LINE_FEED_BYTE, index + 1)) count++;
    return count;
}

//#region: Row helpers.

// Hands over the rows read so far, a chunk at a time. The first chunk fixes the columns and starts with the header.
// Only full chunks go until the item has been read, then the rest goes too.
function* takeRows(rowState: RowState, recordsPerChunk: number, isFinal: boolean): Generator<ParsedRecordsChunk> {
    while (rowState.itemFields.length >= recordsPerChunk || (isFinal && rowState.itemFields.length > 0)) {
        const itemFields = rowState.itemFields.splice(0, recordsPerChunk);
        rowState.shape ??= constructTableShape(itemFields);
        const records: ParsedRecord[] = [];
        if (!rowState.isHeaderSent) {
            records.push(constructHeaderRecord(rowState.shape));
            rowState.isHeaderSent = true;
        }
        for (const fields of itemFields) {
            const { hasUnknownField, record } = constructRecord(fields, rowState.shape);
            if (hasUnknownField) rowState.nonUniformRecordCount++;
            records.push(record);
        }
        rowState.recordCount += records.length;
        yield { records, typeId: 'parsingRecordArray' };
    }
}

//#region: Description helpers.

function addKey(draft: NodeDraft | undefined, key: string): void {
    if (draft != null && draft.keySet.size < MAX_KEY_COUNT) draft.keySet.add(key);
}

// A single value as text: a number as written, a string as decoded. Null has no text.
function describeScalar(value: JsonValue): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return String(value);
    return isNumberText(value) ? value.numberText : undefined;
}

function describePath(path: (number | string)[]): string {
    return path.length === 0 ? 'the top of the item' : `'${path.join(' › ')}'`;
}

//#region: Issue helpers.

// The walker names the byte where it found a problem in its message.
function findErrorOffset(error: unknown): number | undefined {
    const match = error instanceof Error ? / at byte (\d+)\.$/u.exec(error.message) : null;
    return match?.[1] == null ? undefined : Number(match[1]);
}

function constructIssue(message: string, bytes: Uint8Array, offset: number | undefined): SampleIssue {
    return {
        endLineNumber: undefined,
        fieldNumber: undefined,
        id: 'JSON_INVALID',
        lineNumber: offset == null ? undefined : countLineFeeds(bytes.subarray(0, offset)) + 1,
        message,
        recordNumber: undefined,
        severityId: 'error',
        value: undefined
    };
}
