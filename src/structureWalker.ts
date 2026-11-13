// ── External Dependencies & Registrations
import { Tokenizer, TokenizerError, TokenType } from '@streamparser/json';

// ── DPUse Framework
import type { StructureContainerKindId, StructureKindId, StructurePath } from '@dpuse/dpuse-shared';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Walks the tokens of a JSON or JSON Lines stream and reports its structure as it goes: each list and object as it opens
// and closes, each key and each other value. Index building, browsing and reading rows all share it, so they agree on
// what the structure is.
export interface StructureWalker {
    byteCount: () => number; // Bytes written so far.
    end: () => void; // Ends the stream. Fails with a 'StructureError' if the JSON is cut off.
    write: (input: Uint8Array) => void; // Fails with a 'StructureError' if the JSON is not valid.
}

export interface StructureWalkerOptions {
    baseOffset: number; // Where the stream starts in the item, so offsets count from the start of the item.
    isJsonLines: boolean;
    rootPath: StructurePath; // The path of the value the stream starts at, or of the list or object it starts inside.
    startInside: StartInside | undefined; // Set when the stream starts part way through a list or object, rather than at a value.
}

// Where in a list or object a stream starts, for reading a later page or from a checkpoint. The stream starts at the
// entry, after the comma before it.
export interface StartInside {
    firstIndex: number; // The entries before it, so list items keep their indexes.
    kindId: StructureContainerKindId;
}

export interface StructureWalkerHandlers {
    onContainerEnd?: (container: OpenContainer, endOffset: number) => void;
    onContainerStart?: (container: OpenContainer) => void;
    onKey?: (container: OpenContainer, key: string) => void;
    onScalar?: (scalar: ScalarEntry) => void;
    onTokenStart?: (offset: number) => void; // Called before each token, so a value's end can be taken from where the next token starts.
}

export interface OpenContainer {
    childCount: number;
    depth: number; // 0 for the value the stream starts at.
    isVirtual: boolean; // Whether the container is one the stream starts inside, or the lines of JSON Lines, which have no opening bracket in the stream.
    key: EntryKey; // Its key in its parent.
    kindId: StructureContainerKindId;
    parent: OpenContainer | undefined;
    path: StructurePath;
    pendingKey: string | undefined; // The key the next value in an object takes.
    positionId: PositionId;
    startOffset: number;
}

export type EntryKey = number | string | undefined; // An object entry's key or a list item's index. Undefined for the value the stream starts at.

// Where an open container is in its own grammar, so a token out of place fails rather than skewing the structure.
type PositionId = 'afterColon' | 'afterComma' | 'afterKey' | 'afterValue' | 'start';

export interface ScalarEntry {
    key: EntryKey;
    kindId: Exclude<StructureKindId, StructureContainerKindId>;
    parent: OpenContainer | undefined;
    startOffset: number;
    value: JsonScalar;
}

// A number as written in the item. JavaScript numbers lose digits past about 16 and turn very large exponents into
// 'Infinity', so a number is never converted.
export interface NumberText {
    readonly numberText: string;
}

export type JsonScalar = boolean | NumberText | string | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

// A syntax error, with the byte in the item where it was found, so the caller can say which line and column it is on.
export interface StructureError extends Error {
    offset: number;
}

// What a walker knows while it reads.
interface WalkerState {
    byteCount: number;
    byteOffset: number; // Bytes skipped before the tokenizer, such as a byte order mark, so token offsets still count from the stream's start.
    current: OpenContainer | undefined;
    isRootClosed: boolean;
    isStarted: boolean;
}

// Everything a token taker needs.
interface Walk {
    handlers: StructureWalkerHandlers;
    options: StructureWalkerOptions;
    state: WalkerState;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];

// What each kind of token does to the structure.
const TOKEN_TAKERS: Record<TokenType, (walk: Walk, value: unknown, offset: number) => void> = {
    [TokenType.LEFT_BRACE]: (walk, _value, offset) => {
        openContainer(walk, 'object', offset);
    },
    [TokenType.RIGHT_BRACE]: (walk, _value, offset) => {
        closeContainer(walk, 'object', offset);
    },
    [TokenType.LEFT_BRACKET]: (walk, _value, offset) => {
        openContainer(walk, 'list', offset);
    },
    [TokenType.RIGHT_BRACKET]: (walk, _value, offset) => {
        closeContainer(walk, 'list', offset);
    },
    [TokenType.COLON]: (walk, _value, offset) => {
        takeColon(walk.state, offset);
    },
    [TokenType.COMMA]: (walk, _value, offset) => {
        takeComma(walk.state, offset);
    },
    [TokenType.TRUE]: (walk, _value, offset) => {
        takeScalar(walk, 'boolean', true, offset);
    },
    [TokenType.FALSE]: (walk, _value, offset) => {
        takeScalar(walk, 'boolean', false, offset);
    },
    [TokenType.NULL]: (walk, _value, offset) => {
        takeScalar(walk, 'null', null, offset);
    },
    [TokenType.STRING]: (walk, value, offset) => {
        takeString(walk, value as string, offset);
    },
    [TokenType.NUMBER]: (walk, value, offset) => {
        takeScalar(walk, 'number', value as NumberText, offset);
    },
    [TokenType.SEPARATOR]: () => {
        // A JSON Lines separator carries no structure.
    }
};

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createStructureWalker(options: StructureWalkerOptions, handlers: StructureWalkerHandlers): StructureWalker {
    const tokenizer = new Tokenizer(options.isJsonLines ? { separator: '\n' } : undefined);
    // The tokenizer turns numbers into JavaScript numbers through this method, so replacing it keeps them as written.
    Object.assign(tokenizer, { parseNumber: (numberText: string): NumberText => ({ numberText }) });
    const state: WalkerState = { byteCount: 0, byteOffset: 0, current: undefined, isRootClosed: false, isStarted: false };

    // The lines of JSON Lines, or a list or object the stream starts inside, have no opening bracket in the stream.
    const startInside = options.startInside ?? (options.isJsonLines ? { firstIndex: 0, kindId: 'list' as const } : undefined);
    if (startInside != null) {
        const container = constructContainer({ depth: 0, isVirtual: true, key: undefined, kindId: startInside.kindId, parent: undefined, path: options.rootPath, startOffset: options.baseOffset });
        container.childCount = startInside.firstIndex;
        container.positionId = !options.isJsonLines && startInside.firstIndex > 0 ? 'afterComma' : 'start';
        state.current = container;
        handlers.onContainerStart?.(container);
    }

    const walk: Walk = { handlers, options, state };
    tokenizer.onToken = ({ offset: tokenOffset, token, value }): void => {
        const offset = options.baseOffset + state.byteOffset + tokenOffset;
        state.isStarted = true;
        handlers.onTokenStart?.(offset);
        TOKEN_TAKERS[token](walk, value, offset);
    };

    return {
        byteCount: () => state.byteCount,
        end: (): void => {
            const endOffset = options.baseOffset + state.byteCount;
            runTokenizer(() => {
                tokenizer.end();
            }, options.baseOffset + state.byteOffset);
            if (!options.isJsonLines && !state.isStarted) throw constructStructureError('The JSON is empty', options.baseOffset);
            const isOpen = state.current != null && !(options.isJsonLines && state.current.isVirtual);
            if (isOpen) throw constructStructureError('The JSON ends before it is complete', endOffset);
            if (state.current != null) handlers.onContainerEnd?.(state.current, endOffset); // Only the lines of JSON Lines are still open, and they end with the stream.
        },
        write: (input: Uint8Array): void => {
            let bytes = input;
            const isFirstWrite = state.byteCount === 0;
            state.byteCount += input.length;
            if (isFirstWrite && options.baseOffset === 0 && BYTE_ORDER_MARK.every((byte, index) => bytes[index] === byte)) {
                bytes = bytes.subarray(BYTE_ORDER_MARK.length);
                state.byteOffset = BYTE_ORDER_MARK.length;
            }
            runTokenizer(() => {
                tokenizer.write(bytes);
            }, options.baseOffset + state.byteOffset);
        }
    };
}

export function isNumberText(value: unknown): value is NumberText {
    return typeof value === 'object' && value != null && 'numberText' in value;
}

export function isStructureError(error: unknown): error is StructureError {
    return error instanceof Error && 'offset' in error && typeof error.offset === 'number';
}

// JSON text for a value, writing numbers as they were written in the item.
export function stringifyJsonValue(value: JsonValue): string {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (isNumberText(value)) return value.numberText;
    if (Array.isArray(value)) return `[${value.map((item) => stringifyJsonValue(item)).join(',')}]`;
    return `{${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}:${stringifyJsonValue(item)}`)
        .join(',')}}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function constructContainer(input: Omit<OpenContainer, 'childCount' | 'pendingKey' | 'positionId'>): OpenContainer {
    return { ...input, childCount: 0, pendingKey: undefined, positionId: 'start' };
}

function constructStructureError(message: string, offset: number): StructureError {
    return Object.assign(new Error(`${message}.`), { offset });
}

// The tokenizer reports a character it cannot read with its position in the bytes it was given, in its own wording. It
// is turned into the walker's own error, so every syntax error says where it is the same way. Any other error, such as a
// handler stopping the read on purpose, passes through unchanged.
function runTokenizer(run: () => void, tokenizerBaseOffset: number): void {
    try {
        run();
    } catch (error) {
        if (!(error instanceof TokenizerError)) throw error;
        const match = /^Unexpected "(.*)" at chunk position "\d+" \(absolute position "(\d+)"\)/su.exec(error.message);
        if (match?.[2] == null) throw constructStructureError('The JSON ends before it is complete', tokenizerBaseOffset);
        throw constructStructureError(`Unexpected '${match[1] ?? ''}'`, tokenizerBaseOffset + Number(match[2]));
    }
}

// Takes the place of a new value in the current container, and returns its key there.
function startValue(state: WalkerState, options: StructureWalkerOptions, offset: number): { key: EntryKey } {
    const container = state.current;
    if (container == null) {
        if (state.isRootClosed) throw constructStructureError('Unexpected content after the end of the JSON', offset);
        return { key: undefined };
    }
    if (container.kindId === 'object') {
        if (container.positionId === 'afterKey') throw constructStructureError("Expected ':'", offset);
        if (container.positionId === 'afterValue') throw constructStructureError("Expected ',' or '}'", offset);
        if (container.positionId !== 'afterColon') throw constructStructureError('Expected a key', offset);
        container.positionId = 'afterValue';
        container.childCount++;
        return { key: container.pendingKey };
    }
    // Lines of JSON Lines follow each other with no comma between them.
    const isCommaNeeded = !(container.isVirtual && options.isJsonLines);
    if (isCommaNeeded && container.positionId === 'afterValue') throw constructStructureError("Expected ','", offset);
    container.positionId = 'afterValue';
    return { key: container.childCount++ };
}

function openContainer({ handlers, options, state }: Walk, kindId: StructureContainerKindId, offset: number): void {
    const { key } = startValue(state, options, offset);
    const parent = state.current;
    const path = parent == null ? options.rootPath : [...parent.path, key ?? ''];
    state.current = constructContainer({ depth: parent == null ? 0 : parent.depth + 1, isVirtual: false, key, kindId, parent, path, startOffset: offset });
    handlers.onContainerStart?.(state.current);
}

// A container the stream starts inside closes with a bracket from the item it was cut from, which is not part of it.
function closeContainer({ handlers, state }: Walk, kindId: StructureContainerKindId, offset: number): void {
    const container = state.current;
    const bracket = kindId === 'object' ? '}' : ']';
    if (container?.kindId !== kindId) throw constructStructureError(`Unexpected '${bracket}'`, offset);
    if (container.positionId !== 'start' && container.positionId !== 'afterValue') throw constructStructureError(`Unexpected '${bracket}'`, offset);
    handlers.onContainerEnd?.(container, offset + 1);
    state.current = container.isVirtual ? undefined : container.parent;
    if (state.current == null) state.isRootClosed = true;
}

function takeColon(state: WalkerState, offset: number): void {
    if (state.current?.positionId === 'afterKey') state.current.positionId = 'afterColon';
    else throw constructStructureError("Unexpected ':'", offset);
}

function takeComma(state: WalkerState, offset: number): void {
    if (state.current?.positionId === 'afterValue') state.current.positionId = 'afterComma';
    else throw constructStructureError("Unexpected ','", offset);
}

// A string where an object expects a key is the key.
function takeString(walk: Walk, value: string, offset: number): void {
    const container = walk.state.current;
    if (container?.kindId === 'object' && (container.positionId === 'start' || container.positionId === 'afterComma')) {
        container.pendingKey = value;
        container.positionId = 'afterKey';
        walk.handlers.onKey?.(container, value);
        return;
    }
    takeScalar(walk, 'string', value, offset);
}

function takeScalar({ handlers, options, state }: Walk, kindId: ScalarEntry['kindId'], value: JsonScalar, offset: number): void {
    const parent = state.current;
    const { key } = startValue(state, options, offset);
    handlers.onScalar?.({ key, kindId, parent, startOffset: offset, value });
    if (state.current == null) state.isRootClosed = true;
}
