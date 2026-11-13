// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Follows the bytes of a stream as they are read, so a syntax error found at a byte can say which line and column it is
// on and show the text around it. Only the current chunk and the start of the line it is in are kept.
export interface PositionTracker {
    locate: (offset: number) => TextPosition;
    take: (bytes: Uint8Array, startOffset: number) => void; // The next chunk, and where it starts in the item.
}

export interface TextPosition {
    columnNumber: number | undefined; // Counting characters from 1. Undefined when the line is too long to have been kept.
    excerpt: string; // The text just before and after the byte.
    lineNumber: number | undefined; // Counting from 1. Undefined when reading did not start at the top of the item.
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const LINE_FEED_BYTE = 0x0a;
const MAX_LINE_START_BYTE_COUNT = 4096; // The most of a line kept from earlier chunks. A longer line has no column.
const EXCERPT_BEFORE_LENGTH = 40;
const EXCERPT_AFTER_BYTE_COUNT = 20;

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// 'isFromTop' says whether reading starts at the top of the item, so lines can be counted.
export function createPositionTracker(isFromTop: boolean): PositionTracker {
    const decoder = new TextDecoder();
    let chunk: Uint8Array = new Uint8Array();
    let chunkStartOffset = 0;
    let lineFeedCount = 0; // Before the current chunk.
    let lineStart: Uint8Array | undefined = new Uint8Array(); // The current chunk's line, as far as it ran in earlier chunks. Undefined when too long to keep.

    return {
        locate: (offset): TextPosition => {
            const index = Math.min(Math.max(offset - chunkStartOffset, 0), chunk.length);
            const before = chunk.subarray(0, index);
            const lastLineFeedIndex = before.lastIndexOf(LINE_FEED_BYTE);
            const lineBefore = lastLineFeedIndex === -1 ? joinLineStart(lineStart, before) : before.subarray(lastLineFeedIndex + 1);
            const after = chunk.subarray(index, index + EXCERPT_AFTER_BYTE_COUNT);
            const afterLineEnd = after.indexOf(LINE_FEED_BYTE);
            const textBefore = decoder.decode(lineBefore ?? before.subarray(lastLineFeedIndex + 1));
            const textAfter = decoder.decode(afterLineEnd === -1 ? after : after.subarray(0, afterLineEnd));
            return {
                columnNumber: lineBefore == null ? undefined : textBefore.length + 1,
                excerpt: `${textBefore.slice(-EXCERPT_BEFORE_LENGTH)}${textAfter}`,
                lineNumber: isFromTop ? lineFeedCount + countLineFeeds(before) + 1 : undefined
            };
        },
        take: (bytes, startOffset): void => {
            const lastLineFeedIndex = chunk.lastIndexOf(LINE_FEED_BYTE);
            lineFeedCount += countLineFeeds(chunk);
            if (lastLineFeedIndex !== -1) lineStart = new Uint8Array(chunk.subarray(lastLineFeedIndex + 1)); // A copy, because the chunk is let go.
            else if (lineStart != null) lineStart = concatenate(lineStart, chunk);
            if (lineStart != null && lineStart.length > MAX_LINE_START_BYTE_COUNT) lineStart = undefined;
            chunk = bytes;
            chunkStartOffset = startOffset;
        }
    };
}

export function countLineFeeds(bytes: Uint8Array): number {
    let count = 0;
    for (let index = bytes.indexOf(LINE_FEED_BYTE); index !== -1; index = bytes.indexOf(LINE_FEED_BYTE, index + 1)) count++;
    return count;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// The line so far: its start from earlier chunks, then this chunk's part. Undefined when the start was too long to keep.
function joinLineStart(lineStart: Uint8Array | undefined, before: Uint8Array): Uint8Array | undefined {
    return lineStart == null ? undefined : concatenate(lineStart, before);
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    return bytes;
}
