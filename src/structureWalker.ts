// ── External Dependencies & Registrations
import { Tokenizer, TokenType } from '@streamparser/json';

// ── DPUse Framework
import type { StructureContainerKindId, StructureKindId, StructurePath } from '@dpuse/dpuse-shared';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Walks the tokens of a JSON or JSON Lines stream and reports its structure as it goes: each list and object as it opens
// and closes, each key and each other value. Index building, browsing and reading rows all share it, so they agree on
// what the structure is.
export interface StructureWalker {
    end: () => void; // Ends the stream. Fails if the JSON is cut off.
    write: (input: Uint8Array) => void; // Fails if the JSON is not valid.
}

export interface StructureWalkerOptions {
    baseOffset: number; // Where the stream starts in the item, so offsets count from the start of the item.
    firstItemIndex: number; // The index of the first item, when the stream starts inside a list.
    isJsonLines: boolean;
    isStartInsideList: boolean; // Whether the stream starts at an item inside a list, at a checkpoint, rather than at a value.
    rootPath: StructurePath; // The path of the value the stream starts at, or of the list it starts inside.
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
    isVirtual: boolean; // Whether the container is the list a stream starts inside, or the lines of JSON Lines, which have no brackets of their own.
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

// What a walker knows while it reads.
interface WalkerState {
    byteOffset: number; // Bytes skipped before the tokenizer, such as a byte order mark, so token offsets still count from the stream's start.
    byteCount: number; // Bytes written, so a stream cut short can say where it ends.
    current: OpenContainer | undefined;
    isFirstWrite: boolean;
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
    const state: WalkerState = { byteCount: 0, byteOffset: 0, current: undefined, isFirstWrite: true, isRootClosed: false, isStarted: false };

    // The lines of JSON Lines, or the list the stream starts inside, have no opening bracket in the stream.
    if (options.isJsonLines || options.isStartInsideList) {
        const container = constructContainer({
            depth: 0,
            isVirtual: true,
            key: undefined,
            kindId: 'list',
            parent: undefined,
            path: options.rootPath,
            startOffset: options.baseOffset
        });
        container.childCount = options.firstItemIndex;
        container.positionId = !options.isJsonLines && options.firstItemIndex > 0 ? 'afterComma' : 'start';
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
        end: (): void => {
            tokenizer.end();
            if (!options.isJsonLines && !state.isStarted) failAt('The JSON is empty', options.baseOffset);
            const isOpen = state.current != null && !(options.isJsonLines && state.current.isVirtual);
            if (isOpen) failAt('The JSON ends before it is complete', options.baseOffset + state.byteCount);
            if (state.current != null) handlers.onContainerEnd?.(state.current, NaN); // Only the lines of JSON Lines are still open. The caller knows where they end.
        },
        write: (input: Uint8Array): void => {
            let bytes = input;
            state.byteCount += input.length;
            if (state.isFirstWrite) {
                state.isFirstWrite = false;
                if (options.baseOffset === 0 && BYTE_ORDER_MARK.every((byte, index) => bytes[index] === byte)) {
                    bytes = bytes.subarray(BYTE_ORDER_MARK.length);
                    state.byteOffset = BYTE_ORDER_MARK.length;
                }
            }
            tokenizer.write(bytes);
        }
    };
}

export function isNumberText(value: unknown): value is NumberText {
    return typeof value === 'object' && value != null && 'numberText' in value;
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

function failAt(message: string, offset: number): never {
    throw new Error(`${message} at byte ${String(offset)}.`);
}

// Takes the place of a new value in the current container, and returns its key there.
function startValue(state: WalkerState, options: StructureWalkerOptions, offset: number): { key: EntryKey } {
    const container = state.current;
    if (container == null) {
        if (state.isRootClosed) failAt('Unexpected content after the end of the JSON', offset);
        return { key: undefined };
    }
    if (container.kindId === 'object') {
        if (container.positionId === 'afterKey') failAt("Expected ':'", offset);
        else if (container.positionId === 'afterValue') failAt("Expected ',' or '}'", offset);
        else if (container.positionId !== 'afterColon') failAt('Expected a key', offset);
        container.positionId = 'afterValue';
        container.childCount++;
        return { key: container.pendingKey };
    }
    // Lines of JSON Lines follow each other with no comma between them.
    const isCommaNeeded = !(container.isVirtual && options.isJsonLines);
    if (isCommaNeeded && container.positionId === 'afterValue') failAt("Expected ','", offset);
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

function closeContainer({ handlers, state }: Walk, kindId: StructureContainerKindId, offset: number): void {
    const container = state.current;
    const bracket = kindId === 'object' ? '}' : ']';
    if (container?.kindId !== kindId) return failAt(`Unexpected '${bracket}'`, offset);
    if (container.positionId !== 'start' && container.positionId !== 'afterValue') return failAt(`Unexpected '${bracket}'`, offset);
    // A list the stream starts inside closes with a bracket from the item the stream was cut from.
    handlers.onContainerEnd?.(container, container.isVirtual ? offset : offset + 1);
    state.current = container.isVirtual ? undefined : container.parent;
    if (state.current == null) state.isRootClosed = true;
}

function takeColon(state: WalkerState, offset: number): void {
    if (state.current?.positionId === 'afterKey') state.current.positionId = 'afterColon';
    else failAt("Unexpected ':'", offset);
}

function takeComma(state: WalkerState, offset: number): void {
    if (state.current?.positionId === 'afterValue') state.current.positionId = 'afterComma';
    else failAt("Unexpected ','", offset);
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
