/**
 * Parsing runs under a linear pre-scan limit. A document over the limit renders as source text with
 * `bounded` set. The scan uses counts and no clock, so the same document renders the same bytes on
 * every machine.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Root } from "mdast";

/** Sum over blank-line blocks of (ASCII punctuation + 2 per line, `]` counting twice) squared. Real files peak near 3.8e8. */
export const MAX_BLOCK_SCORE = 4.4e8;
/** Emphasis markers in one block, which bounds inline nesting. */
export const MAX_BLOCK_EMPHASIS = 4_000;
/** Sum over blocks of emphasis markers squared. */
export const MAX_EMPHASIS_SCORE = 1e8;
/** Document totals. */
export const MAX_PIPES = 25_000;
export const MAX_LINE_MARKERS = 14_000;
export const MAX_TABLES = 2_500;
/** Container markers on one line, and the characters before the last of them. */
export const MAX_LINE_NESTING = 64;
export const MAX_LINE_PREFIX = 512;

/** One block quote, list or footnote marker at the current position of a line. */
const CONTAINER_MARKER = />|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|\[\^[^\]\s]+\]:/my;

function withinParseLimits(source: string): boolean {
  let emphasisSum = 0, score = 0, block = 0, emphasis = 0, pipes = 0, markers = 0, tables = 0;
  let lineStart = 0, linePipes = 0, lineDashes = 0, blank = true, delimiterRow = true;
  for (let i = 0; i <= source.length; i++) {
    const code = i < source.length ? source.charCodeAt(i) : 10;
    if (code === 13 && source.charCodeAt(i + 1) === 10) continue;
    if (code === 10 || code === 13) {
      let nesting = 0, prefix = 0, position = lineStart;
      for (;;) {
        while (source.charCodeAt(position) === 32 || source.charCodeAt(position) === 9) position++;
        CONTAINER_MARKER.lastIndex = position;
        if (!CONTAINER_MARKER.test(source)) break;
        position = CONTAINER_MARKER.lastIndex;
        prefix = position - lineStart;
        nesting++;
      }
      if (nesting > MAX_LINE_NESTING || prefix > MAX_LINE_PREFIX) return false;
      markers += nesting;
      if (delimiterRow && linePipes > 0 && lineDashes > 0) tables++;
      if (blank) {
        score += block * block;
        emphasisSum += emphasis * emphasis;
        block = 0;
        emphasis = 0;
      } else {
        block += 2;
      }
      lineStart = i + 1;
      linePipes = lineDashes = 0;
      blank = delimiterRow = true;
      continue;
    }
    if (code === 32 || code === 9) continue;
    blank = false;
    if (code === 124) linePipes++, pipes++;
    else if (code === 45) lineDashes++;
    else if (code !== 58 && code !== 62) delimiterRow = false;
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128;
    if (!alphanumeric) block += code === 93 ? 2 : 1;
    if ((code === 42 || code === 95 || code === 126) && ++emphasis > MAX_BLOCK_EMPHASIS) return false;
  }
  // One combined check, so a document can't sit just under every limit at once.
  return (emphasisSum + emphasis * emphasis) / MAX_EMPHASIS_SCORE + (score + block * block) / MAX_BLOCK_SCORE
    + (markers / MAX_LINE_MARKERS) ** 2 + (tables / MAX_TABLES) ** 2 + (pipes / MAX_PIPES) ** 2 <= 1;
}

/** Whether an error means the call stack ran out, as each engine reports it. */
export function isCallStackExhausted(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "RangeError" || error.name === "InternalError")
    && /call stack|recursion/i.test(error.message);
}

/** The parse tree, or null when the document is over the limit. */
export function parseWithinLimits(source: string): Root | null {
  if (!withinParseLimits(source)) return null;
  try {
    return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch (error) {
    // A constrained host degrades the same way. Any other error is a defect and stays visible.
    if (isCallStackExhausted(error)) return null;
    throw error;
  }
}
