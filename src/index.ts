// ── DPUse Framework
import { resolveDecoderId } from '@dpuse/dpuse-shared';
import type { BuildStructureIndexOptions, DataFormatId, ListStructureEntriesOptions, ListStructureEntriesResult, ParsedRecord } from '@dpuse/dpuse-shared';
import type { ParsedRecordsChunk, ParseStreamOptions, ParseStreamSummary, ParseTextOptions, ParseTextResult, SampleIssue } from '@dpuse/dpuse-shared';
import type { StructuredParserInterface, StructureEntry, StructureIndex, StructureLocator, StructureNode, StructurePath } from '@dpuse/dpuse-shared';

// ── Local Framework
import { constructHeaderRecord, constructRecord, constructTableShape, createItemReader, flattenItem, type TableShape } from '@/itemRecords';
import { countLineFeeds, createPositionTracker, type PositionTracker } from '@/textPosition';
import { createStructureWalker, isNumberText, isStructureError, type JsonValue, type OpenContainer, type StartInside } from '@/structureWalker';
import type { StructureError, StructureWalker, StructureWalkerHandlers, StructureWalkerOptions } from '@/structureWalker';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A node while its list or object is still being read. The set and flag work out its keys and whether it reads as rows.
interface NodeDraft {
    container: OpenContainer;
    hasNonObjectItem: boolean;
    keySet: Set<string>;
    node: StructureNode;
}

// How far a read got, and why it ended early.
interface ReadOutcome {
    byteCount: number;
    error: StructureError | undefined;
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

const ENCODING_MESSAGE = 'JSON must be encoded as UTF-8.';

// WebKit hands over a file stream in pieces of about 18 MB, against about 2 MB in Chromium. Each piece is read in slices
// of this size, so rows are handed over and the abort checked often. A slice is a view, not a copy.
const MAX_SLICE_BYTE_COUNT = 1_048_576;

// Thrown by a handler to stop reading once enough is known. The walker passes it back out of 'write'.
const STOP_READING = new Error('Reading stopped once enough was known.');

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class Tool implements StructuredParserInterface {
    /**
     * Build structure index. Maps the lists and objects of the item, or of its start for a preview, with a locator for
     * each, so any of them can be read again on its own. Suggests the list to read as the table when there is only one.
     * A syntax error ends the map early and is reported in it. Memory stays small however large the item.
     */
    async buildStructureIndex(stream: ReadableStream<Uint8Array>, options: BuildStructureIndexOptions): Promise<StructureIndex> {
        if (!isUtf8(options.encodingId)) {
            await stream.cancel();
            return {
                byteCount: 0,
                isComplete: false,
                issues: [constructIssue('JSON_ENCODING', ENCODING_MESSAGE, undefined)],
                nodes: [],
                suggestedStructurePath: undefined,
                tableCandidateCount: 0
            };
        }
        const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
        const drafts = new Map<OpenContainer, NodeDraft>();
        const nodes: StructureNode[] = [];
        // A list's first items show the shape of the rest, which checkpoints locate, so a long list adds little to the
        // index. A list or object inside one not indexed is not indexed either.
        const isIndexed = (container: OpenContainer): boolean => {
            if (container.depth > maxDepth) return false;
            if (container.parent == null) return true;
            const isSampleItem = container.parent.kindId !== 'list' || (typeof container.key === 'number' && container.key < INDEXED_ITEM_COUNT);
            return isSampleItem && drafts.has(container.parent);
        };
        // A list's item: a checkpoint every so many items, and a note when an item is not an object.
        const takeItem = (parent: OpenContainer | undefined, key: number | string | undefined, startOffset: number, isObject: boolean): void => {
            const parentDraft = parent == null ? undefined : drafts.get(parent);
            if (typeof key !== 'number' || parentDraft?.node.kindId !== 'list') return;
            if (key % CHECKPOINT_ITEM_COUNT === 0) parentDraft.node.checkpoints.push({ itemIndex: key, locator: constructInsideLocator(startOffset, 'list', key) });
            if (!isObject) parentDraft.hasNonObjectItem = true;
        };
        const handlers: StructureWalkerHandlers = {
            onContainerEnd: (container, endOffset) => {
                const draft = drafts.get(container);
                if (draft == null) return;
                draft.node.locator.endOffset = endOffset;
                draft.node.isComplete = true;
                completeNode(draft);
                drafts.delete(container);
            },
            onContainerStart: (container) => {
                takeItem(container.parent, container.key, container.startOffset, container.kindId === 'object');
                if (!isIndexed(container)) return;
                const node: StructureNode = {
                    checkpoints: [],
                    childCount: 0,
                    isComplete: false,
                    isTableCandidate: false,
                    keys: [],
                    kindId: container.kindId,
                    locator: { endOffset: undefined, startOffset: container.startOffset, state: undefined },
                    path: container.path
                };
                nodes.push(node);
                drafts.set(container, { container, hasNonObjectItem: false, keySet: new Set(), node });
            },
            onKey: (container, key) => {
                addKey(drafts.get(container), key);
                const parentDraft = container.parent == null ? undefined : drafts.get(container.parent);
                if (parentDraft?.node.kindId === 'list') addKey(parentDraft, key); // A list's keys are those of its object items.
            },
            onScalar: (scalar) => {
                takeItem(scalar.parent, scalar.key, scalar.startOffset, false);
            }
        };
        const tracker = createPositionTracker(true);
        const walker = createStructureWalker(constructWalkerOptions(options.dataFormatId), handlers);
        const outcome = await readStream(stream, { abortSignal: options.abortSignal, isEnded: options.isComplete, onProgress: options.onProgress, tracker, walker });
        // Lists and objects still open where reading stopped are kept with what was read of them. A checkpoint carries
        // on to the end of its list, so it takes the list's end once known.
        for (const draft of drafts.values()) completeNode(draft);
        for (const node of nodes) for (const checkpoint of node.checkpoints) checkpoint.locator.endOffset = node.locator.endOffset;
        const issues = outcome.error == null ? [] : [constructSyntaxIssue(outcome.error, tracker)];
        return { byteCount: outcome.byteCount, isComplete: options.isComplete && outcome.error == null, issues, nodes, ...suggestStructurePath(nodes, options.dataFormatId) };
    }

    /**
     * List structure entries. Lists one page of a list or object for a viewer that opens one level at a time, and says
     * where the next page starts. Reading stops as soon as the page is known, so a page near the start of a large node is
     * quick.
     */
    async listStructureEntries(stream: ReadableStream<Uint8Array>, options: ListStructureEntriesOptions): Promise<ListStructureEntriesResult> {
        const maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
        const { locator } = options;
        const entries: StructureEntry[] = [];
        let nextLocator: StructureLocator | undefined;
        let openScalarEntry: StructureEntry | undefined; // A text, number or other single value only ends where the next token starts.
        let tokenOffset = 0; // Where the latest token started.
        let keyOffset = 0; // Where the latest key started, because the next page of an object starts at a key, before its value.
        // Called as an entry starts. Once the page is full, the next entry is where the next page starts.
        const startEntry = (entry: StructureEntry, parent: OpenContainer | undefined): void => {
            if (entries.length >= options.entryCount) {
                const isObjectEntry = parent?.kindId === 'object';
                const firstIndex = typeof entry.key === 'number' ? entry.key : (parent?.childCount ?? 1) - 1;
                const startOffset = isObjectEntry ? keyOffset : entry.locator.startOffset;
                nextLocator = { ...constructInsideLocator(startOffset, isObjectEntry ? 'object' : 'list', firstIndex), endOffset: locator.endOffset };
                throw STOP_READING;
            }
            entries.push(entry);
        };
        const walkerOptions: StructureWalkerOptions = {
            baseOffset: locator.startOffset,
            isJsonLines: options.dataFormatId === 'jsonl' && options.path.length === 0,
            rootPath: options.path,
            startInside: readStartInside(locator.state)
        };
        const walker = createStructureWalker(walkerOptions, {
            onContainerEnd: (container, endOffset) => {
                if (container.depth === 0) throw STOP_READING;
                if (container.depth !== 1) return;
                const entry = entries.at(-1);
                if (entry == null) return;
                entry.locator.endOffset = endOffset;
                entry.childCount = container.childCount;
            },
            onContainerStart: (container) => {
                if (container.depth !== 1) return;
                const entryLocator = { endOffset: undefined, startOffset: container.startOffset, state: undefined };
                startEntry({ childCount: 0, isValueCut: false, key: container.key ?? '', kindId: container.kindId, locator: entryLocator, value: undefined }, container.parent);
            },
            onKey: (container) => {
                if (container.depth === 0) keyOffset = tokenOffset;
            },
            onScalar: (scalar) => {
                if (scalar.parent?.depth !== 0) return;
                const text = describeScalar(scalar.value);
                const isValueCut = text != null && text.length > maxValueLength;
                const entry: StructureEntry = {
                    childCount: undefined,
                    isValueCut,
                    key: scalar.key ?? '',
                    kindId: scalar.kindId,
                    locator: { endOffset: undefined, startOffset: scalar.startOffset, state: undefined },
                    value: isValueCut ? text.slice(0, maxValueLength) : text
                };
                startEntry(entry, scalar.parent);
                openScalarEntry = entry;
            },
            onTokenStart: (offset) => {
                tokenOffset = offset;
                if (openScalarEntry == null) return;
                openScalarEntry.locator.endOffset = offset;
                openScalarEntry = undefined;
            }
        });
        const tracker = createPositionTracker(locator.startOffset === 0);
        const outcome = await readStream(stream, { abortSignal: options.abortSignal, isEnded: true, onProgress: undefined, tracker, walker });
        if (openScalarEntry != null) openScalarEntry.locator.endOffset = locator.startOffset + outcome.byteCount;
        const issues = outcome.error == null ? [] : [constructSyntaxIssue(outcome.error, tracker)];
        return { entries, issues, nextLocator };
    }

    /**
     * Parse stream. Reads the list at 'structurePath', or at the top of the item when it is not given, as rows: a header
     * of column names, then one row per item. The columns are those found in the first chunk of items. A later item with
     * a field outside them keeps its other fields and counts as not uniform. Stops between items at 'byteLimit' or when
     * 'stopSignal' fires. Fails on a syntax error, naming its line and column. The caller owns the stream and its fetch.
     */
    async *parseStream(stream: ReadableStream<Uint8Array>, options: ParseStreamOptions): AsyncGenerator<ParsedRecordsChunk, ParseStreamSummary, undefined> {
        options.abortSignal.throwIfAborted();
        if (!isUtf8(options.encodingId)) throw new Error(ENCODING_MESSAGE);
        const recordsPerChunk = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_RECORD_BUFFER_SIZE));
        const rowState: RowState = { isHeaderSent: false, itemFields: [], nonUniformRecordCount: 0, recordCount: 0, shape: undefined };
        const progress = { isStopped: false };
        const itemReader = createItemReader(options.structurePath ?? [], (item, endOffset) => {
            rowState.itemFields.push(flattenItem(item));
            const isLimitReached = options.byteLimit != null && endOffset >= options.byteLimit;
            if (!isLimitReached && options.stopSignal?.aborted !== true) return;
            progress.isStopped = true;
            throw STOP_READING;
        });
        const isReading = (): boolean => !progress.isStopped && !itemReader.isTargetClosed();
        const walker = createStructureWalker(constructWalkerOptions(options.dataFormatId), itemReader.handlers);
        const tracker = createPositionTracker(true);
        const reader = stream.getReader();
        const cancelRead = (): void => {
            void cancelReader(reader, options.abortSignal.reason);
        };
        options.abortSignal.addEventListener('abort', cancelRead, { once: true });

        let lineCount = 0;
        try {
            let result = await reader.read();
            while (!result.done && isReading()) {
                lineCount += countLineFeeds(result.value);
                for (let sliceStart = 0; sliceStart < result.value.length && isReading(); sliceStart += MAX_SLICE_BYTE_COUNT) {
                    options.abortSignal.throwIfAborted();
                    writeSlice(walker, tracker, result.value.subarray(sliceStart, sliceStart + MAX_SLICE_BYTE_COUNT));
                    yield* takeRows(rowState, recordsPerChunk, false);
                }
                if (isReading()) result = await reader.read();
            }
            options.abortSignal.throwIfAborted();
            if (isReading()) {
                runWalker(() => {
                    walker.end();
                }, tracker);
            }
            if (!itemReader.isTargetFound()) throw new Error(`Nothing found at ${describePath(options.structurePath ?? [])}.`);
            yield* takeRows(rowState, recordsPerChunk, true);
            return {
                byteCount: walker.byteCount(),
                commentLineCount: 0,
                emptyLineCount: 0,
                isComplete: !progress.isStopped,
                lineCount,
                nonUniformRecordCount: rowState.nonUniformRecordCount,
                recordCount: rowState.recordCount
            };
        } finally {
            options.abortSignal.removeEventListener('abort', cancelRead);
            void cancelReader(reader); // Releases the item when reading stops before the end. A stream already read through ignores it.
        }
    }

    /**
     * Parse text. Reads a preview the same way as 'parseStream'. A preview cut short ends in the middle of the JSON, so
     * only an error in what was read is an issue, and the items read before the cut are kept. In JSON Lines each line is
     * read on its own, so a line that cannot be read is an issue and the lines after it are still read.
     */
    parseText(text: string, options: ParseTextOptions): Promise<ParseTextResult> {
        const items: Map<string, JsonValue>[] = [];
        const issues = options.dataFormatId === 'jsonl' ? parseLines(text, options.isComplete, items) : parseDocument(text, options, items);
        const shape = constructTableShape(items);
        const parsedRecords: ParsedRecord[] = items.length === 0 ? [] : [constructHeaderRecord(shape), ...items.map((fields) => constructRecord(fields, shape).record)];
        const hasHeaders = items.length === 0 ? undefined : true; // Column names are taken from keys, so the first record is always a header.
        return Promise.resolve({ hasHeaders, issues, parsedRecords, recordDelimiterId: '\n', valueDelimiterId: undefined }); // Synchronous, but the interface allows a parser that is not.
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

//#region: Reading helpers.

// Options for a walk of the whole item from its start.
function constructWalkerOptions(dataFormatId: DataFormatId): StructureWalkerOptions {
    return { baseOffset: 0, isJsonLines: dataFormatId === 'jsonl', rootPath: [], startInside: undefined };
}

// JSON is UTF-8 by its standard, and an index counts bytes of the item itself, so other encodings are not read.
function isUtf8(encodingId: string): boolean {
    return resolveDecoderId(encodingId) === 'utf-8';
}

// Feeds the stream to the walker a slice at a time, and ends the walk when 'isEnded'. A preview is not ended, because it
// stops part way. Stops early, without error, when a handler has all it needs. A syntax error stops it too, and is
// returned rather than thrown, so the caller keeps what was read before it.
async function readStream(
    stream: ReadableStream<Uint8Array>,
    input: { abortSignal: AbortSignal; isEnded: boolean; onProgress: ((byteCount: number) => void) | undefined; tracker: PositionTracker; walker: StructureWalker }
): Promise<ReadOutcome> {
    const { abortSignal, isEnded, onProgress, tracker, walker } = input;
    abortSignal.throwIfAborted();
    const reader = stream.getReader();
    const cancelRead = (): void => {
        void cancelReader(reader, abortSignal.reason);
    };
    abortSignal.addEventListener('abort', cancelRead, { once: true });
    try {
        let result = await reader.read();
        while (!result.done) {
            for (let sliceStart = 0; sliceStart < result.value.length; sliceStart += MAX_SLICE_BYTE_COUNT) {
                abortSignal.throwIfAborted();
                const slice = result.value.subarray(sliceStart, sliceStart + MAX_SLICE_BYTE_COUNT);
                tracker.take(slice, walker.byteCount());
                walker.write(slice);
            }
            onProgress?.(walker.byteCount());
            result = await reader.read();
        }
        abortSignal.throwIfAborted();
        if (isEnded) walker.end();
        return { byteCount: walker.byteCount(), error: undefined };
    } catch (error) {
        if (error === STOP_READING) return { byteCount: walker.byteCount(), error: undefined };
        if (isStructureError(error)) return { byteCount: walker.byteCount(), error };
        throw error;
    } finally {
        abortSignal.removeEventListener('abort', cancelRead);
        void cancelReader(reader);
    }
}

// Cancels a read without waiting for it. Cancelling a stream that has already failed rejects with its failure, which the
// read itself has already thrown, so the rejection is dropped rather than left unhandled.
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): Promise<void> {
    try {
        await reader.cancel(reason);
    } catch {
        // The read has already thrown this failure.
    }
}

function writeSlice(walker: StructureWalker, tracker: PositionTracker, slice: Uint8Array): void {
    tracker.take(slice, walker.byteCount());
    runWalker(() => {
        walker.write(slice);
    }, tracker);
}

// Runs a step of a row parse. A syntax error fails the parse with its line and column. A stop ends the step quietly,
// because the handler that stopped it has already recorded why.
function runWalker(run: () => void, tracker: PositionTracker): void {
    try {
        run();
    } catch (error) {
        if (error === STOP_READING) return;
        if (!isStructureError(error)) throw error;
        throw new Error(describeSyntaxError(error, tracker), { cause: error });
    }
}

//#region: Text helpers.

// Reads a whole JSON document, or the start of one, into items, and returns the issues found.
function parseDocument(text: string, options: ParseTextOptions, items: Map<string, JsonValue>[]): SampleIssue[] {
    const itemReader = createItemReader(options.structurePath ?? [], (item) => {
        items.push(flattenItem(item));
    });
    const walker = createStructureWalker(constructWalkerOptions('json'), itemReader.handlers);
    const tracker = createPositionTracker(true);
    const bytes = new TextEncoder().encode(text);
    tracker.take(bytes, 0);
    try {
        walker.write(bytes);
        if (options.isComplete) walker.end();
    } catch (error) {
        if (!isStructureError(error)) throw error;
        return [constructSyntaxIssue(error, tracker)];
    }
    const isMissing = options.isComplete && !itemReader.isTargetFound();
    return isMissing ? [constructIssue('JSON_NOT_FOUND', `Nothing found at ${describePath(options.structurePath ?? [])}.`, undefined)] : [];
}

// Reads each line of JSON Lines on its own, so one that cannot be read is an issue and the rest are still read. The last
// line of a preview cut short is where the cut fell, so it is not an issue.
function parseLines(text: string, isComplete: boolean, items: Map<string, JsonValue>[]): SampleIssue[] {
    const issues: SampleIssue[] = [];
    const lines = text.split('\n');
    for (const [lineIndex, line] of lines.entries()) {
        if (line.trim() === '') continue;
        const lineItems: JsonValue[] = [];
        const itemReader = createItemReader([], (item) => {
            lineItems.push(item);
        });
        const walker = createStructureWalker(constructWalkerOptions('json'), itemReader.handlers);
        const bytes = new TextEncoder().encode(line);
        try {
            walker.write(bytes);
            walker.end();
            for (const item of lineItems) items.push(flattenItem(item));
        } catch (error) {
            if (!isStructureError(error)) throw error;
            const isCutOff = !isComplete && lineIndex === lines.length - 1;
            if (!isCutOff) issues.push(constructLineIssue(error, bytes, lineIndex + 1));
        }
    }
    return issues;
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

//#region: Structure helpers.

function addKey(draft: NodeDraft | undefined, key: string): void {
    if (draft != null && draft.keySet.size < MAX_KEY_COUNT) draft.keySet.add(key);
}

// Fills in what a node's list or object showed, as far as it was read.
function completeNode(draft: NodeDraft): void {
    draft.node.childCount = draft.container.childCount;
    draft.node.isTableCandidate = draft.node.kindId === 'list' && draft.container.childCount > 0 && !draft.hasNonObjectItem;
    draft.node.keys = draft.keySet.values().toArray();
}

// A list is suggested as the table when it is the only one that reads as rows. A list inside a list's item, such as the
// lines of one order, is one item's detail, so it is not counted. JSON Lines is always read line by line.
function suggestStructurePath(nodes: StructureNode[], dataFormatId: DataFormatId): Pick<StructureIndex, 'suggestedStructurePath' | 'tableCandidateCount'> {
    const candidates = nodes.filter((node) => node.isTableCandidate && node.path.every((segment) => typeof segment === 'string'));
    if (dataFormatId === 'jsonl') return { suggestedStructurePath: nodes.length > 0 ? [] : undefined, tableCandidateCount: candidates.length };
    return { suggestedStructurePath: candidates.length === 1 ? candidates[0]?.path : undefined, tableCandidateCount: candidates.length };
}

// A locator for reading from an entry part way through a list or object. Its state says where, so the walker starts
// inside the container rather than expecting it to open. It reads on to the end of the item until the end is known.
function constructInsideLocator(startOffset: number, kindId: StartInside['kindId'], firstIndex: number): StructureLocator {
    const startInside: StartInside = { firstIndex, kindId };
    return { endOffset: undefined, startOffset, state: JSON.stringify(startInside) };
}

function readStartInside(state: string | undefined): StartInside | undefined {
    if (state == null) return undefined;
    const startInside = JSON.parse(state) as StartInside;
    return { firstIndex: startInside.firstIndex, kindId: startInside.kindId };
}

// A single value as text: a number as written, a string as decoded. Null has no text.
function describeScalar(value: JsonValue): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return String(value);
    return isNumberText(value) ? value.numberText : undefined;
}

function describePath(path: StructurePath): string {
    return path.length === 0 ? 'the top of the item' : `'${path.join(' › ')}'`;
}

//#region: Issue helpers.

function describeSyntaxError(error: StructureError, tracker: PositionTracker): string {
    const { columnNumber, lineNumber } = tracker.locate(error.offset);
    const message = error.message.replace(/\.$/u, '');
    if (lineNumber == null) return `${message} at byte ${String(error.offset)}.`;
    return columnNumber == null ? `${message} on line ${String(lineNumber)}.` : `${message} on line ${String(lineNumber)}, column ${String(columnNumber)}.`;
}

function constructSyntaxIssue(error: StructureError, tracker: PositionTracker): SampleIssue {
    const { columnNumber, excerpt, lineNumber } = tracker.locate(error.offset);
    return { ...constructIssue('JSON_INVALID', describeSyntaxError(error, tracker), excerpt), columnNumber, lineNumber };
}

// A line of JSON Lines that cannot be read. The line is its record, so both numbers are the line's.
function constructLineIssue(error: StructureError, bytes: Uint8Array, lineNumber: number): SampleIssue {
    const tracker = createPositionTracker(true);
    tracker.take(bytes, 0);
    const { columnNumber, excerpt } = tracker.locate(error.offset);
    const message = columnNumber == null ? `${error.message.replace(/\.$/u, '')} on line ${String(lineNumber)}.` : describeLineError(error, lineNumber, columnNumber);
    return { ...constructIssue('JSON_INVALID', message, excerpt), columnNumber, lineNumber, recordNumber: lineNumber };
}

function describeLineError(error: StructureError, lineNumber: number, columnNumber: number): string {
    return `${error.message.replace(/\.$/u, '')} on line ${String(lineNumber)}, column ${String(columnNumber)}.`;
}

function constructIssue(id: string, message: string, value: string | undefined): SampleIssue {
    return { columnNumber: undefined, endLineNumber: undefined, fieldNumber: undefined, id, lineNumber: undefined, message, recordNumber: undefined, severityId: 'error', value };
}
