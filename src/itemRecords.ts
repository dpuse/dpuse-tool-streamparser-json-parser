// ── DPUse Framework
import type { ParsedRecord, StructurePath } from '@dpuse/dpuse-shared';

// ── Local Framework
import { isNumberText, stringifyJsonValue } from '@/structureWalker';
import type { JsonValue, OpenContainer, StructureWalkerHandlers } from '@/structureWalker';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Reads the items of the value at a path as they stream past. A list gives one item per entry. Any other value is one
// item on its own.
export interface ItemReader {
    handlers: StructureWalkerHandlers;
    isTargetClosed: () => boolean; // Whether the value has been read through, so the rest of the stream is not needed.
    isTargetFound: () => boolean;
}

// The columns of a table, fixed by the first items read, so every row has the same values in the same places.
export interface TableShape {
    columnIndexes: Map<string, number>;
    columnNames: string[];
}

// A list or object being built, and the container it is built from.
interface ValueFrame {
    container: OpenContainer;
    value: JsonValue[] | Record<string, JsonValue>;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const SCALAR_COLUMN_NAME = 'value'; // The one column of a list whose items are not objects.

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createItemReader(targetPath: StructurePath, onItem: (item: JsonValue) => void): ItemReader {
    const frames: ValueFrame[] = [];
    let targetContainer: OpenContainer | undefined;
    let isTargetFound = false;
    let isTargetClosed = false;

    const addValue = (container: OpenContainer, key: number | string | undefined, value: JsonValue): void => {
        const frame = frames.at(-1);
        if (frame?.container !== container) return;
        if (Array.isArray(frame.value)) frame.value.push(value);
        else frame.value[String(key)] = value;
    };

    const handlers: StructureWalkerHandlers = {
        onContainerEnd: (container) => {
            if (container === targetContainer) {
                isTargetClosed = true;
                targetContainer = undefined;
            }
            const frame = frames.at(-1);
            if (frame?.container !== container) return;
            frames.pop();
            const parentFrame = frames.at(-1);
            if (parentFrame == null) onItem(frame.value);
            else addValue(parentFrame.container, container.key, frame.value);
        },
        onContainerStart: (container) => {
            const isTarget = !isTargetFound && arePathsEqual(container.path, targetPath);
            if (isTarget) {
                isTargetFound = true;
                targetContainer = container;
            }
            // An object at the path is one item. A list's entries are its items.
            const isItem = (isTarget && container.kindId === 'object') || (targetContainer != null && container.parent === targetContainer && targetContainer.kindId === 'list');
            if (isItem || frames.length > 0) frames.push({ container, value: container.kindId === 'list' ? [] : constructRecordObject() });
        },
        onScalar: (scalar) => {
            const parent = scalar.parent;
            if (parent != null && frames.length > 0) {
                addValue(parent, scalar.key, scalar.value);
                return;
            }
            const isListItem = parent?.kindId === 'list' && parent === targetContainer;
            const isTarget = !isTargetFound && arePathsEqual(parent == null ? [] : [...parent.path, scalar.key ?? ''], targetPath);
            if (isTarget) {
                isTargetFound = true;
                isTargetClosed = true;
            }
            if (isListItem || isTarget) onItem(scalar.value);
        }
    };
    return { handlers, isTargetClosed: () => isTargetClosed, isTargetFound: () => isTargetFound };
}

// An item's fields, by column name. Nested objects are flattened into names joined by dots, and a list stays one value,
// because rows cannot hold a variable number of columns.
export function flattenItem(item: JsonValue): Map<string, JsonValue> {
    const fields = new Map<string, JsonValue>();
    if (!isPlainObject(item)) {
        fields.set(SCALAR_COLUMN_NAME, item);
        return fields;
    }
    const addFields = (value: Record<string, JsonValue>, prefix: string): void => {
        for (const [key, fieldValue] of Object.entries(value)) {
            const name = prefix === '' ? key : `${prefix}.${key}`;
            if (isPlainObject(fieldValue) && Object.keys(fieldValue).length > 0) addFields(fieldValue, name);
            else fields.set(name, fieldValue);
        }
    };
    addFields(item, '');
    return fields;
}

// The columns found in the items, in the order first found.
export function constructTableShape(itemFields: Map<string, JsonValue>[]): TableShape {
    const columnIndexes = new Map<string, number>();
    for (const fields of itemFields) {
        for (const name of fields.keys()) if (!columnIndexes.has(name)) columnIndexes.set(name, columnIndexes.size);
    }
    return { columnIndexes, columnNames: columnIndexes.keys().toArray() };
}

export function constructHeaderRecord(shape: TableShape): ParsedRecord {
    return shape.columnNames.map((name) => ({ value: name, valueWasQuoted: true }));
}

// A row in the table's column order. A field the item lacks is null. A field the table has no column for is dropped, and
// reported so the caller can count the item as not uniform.
export function constructRecord(fields: Map<string, JsonValue>, shape: TableShape): { hasUnknownField: boolean; record: ParsedRecord } {
    const record: ParsedRecord = shape.columnNames.map(() => ({ value: null, valueWasQuoted: false }));
    let hasUnknownField = false;
    for (const [name, value] of fields) {
        const columnIndex = shape.columnIndexes.get(name);
        if (columnIndex == null) hasUnknownField = true;
        else record[columnIndex] = constructParsedValue(value);
    }
    return { hasUnknownField, record };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function arePathsEqual(path: StructurePath, otherPath: StructurePath): boolean {
    return path.length === otherPath.length && path.every((segment, index) => segment === otherPath[index]);
}

// An object with no prototype, so a key such as '__proto__' is kept as data rather than changing the object.
function constructRecordObject(): Record<string, JsonValue> {
    return Object.create(null) as Record<string, JsonValue>;
}

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === 'object' && value != null && !Array.isArray(value) && !isNumberText(value);
}

// Text is marked as quoted, as in delimited text, so type inference keeps a string of digits as text.
function constructParsedValue(value: JsonValue): ParsedRecord[number] {
    if (value == null) return { value: null, valueWasQuoted: false };
    if (typeof value === 'string') return { value, valueWasQuoted: true };
    if (typeof value === 'boolean') return { value: String(value), valueWasQuoted: false };
    if (isNumberText(value)) return { value: value.numberText, valueWasQuoted: false };
    return { value: stringifyJsonValue(value), valueWasQuoted: true };
}
