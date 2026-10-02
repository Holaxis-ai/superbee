// Pages of a document body for agents (`doc read --offset/--max-bytes`), the same contract the
// hosted MCP gateway's `read_document` answers (design `document-size-cap` on the superbee-dev
// board, section 4): offsets in UTF-16 code units, a page bound in UTF-8 bytes, never a split
// character, and a page that ends just after a line where one is near its cut.

/** A page's body bound when the caller names none, in UTF-8 bytes. */
export const PAGE_DEFAULT_BYTES = 32_768;
/** The smallest and largest page `doc read` serves, in UTF-8 bytes. */
export const PAGE_MIN_BYTES = 1_024;
export const PAGE_MAX_BYTES = 983_040;
/** How far back from a page's byte cut a newline still ends the page, in UTF-16 code units. */
const LINE_WINDOW = 4_096;

export interface BodyPage {
  readonly body: string;
  readonly range: {
    readonly offset: number;
    readonly end: number;
    readonly total_chars: number;
    readonly total_bytes: number;
    readonly complete: boolean;
    readonly next_offset?: number;
  };
}

function pageEnd(body: string, offset: number, maxBytes: number): number {
  let bytes = 0;
  let end = offset;
  while (end < body.length) {
    const code = body.codePointAt(end)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += code >= 0x10000 ? 2 : 1;
  }
  if (end === offset && end < body.length) end += body.codePointAt(end)! >= 0x10000 ? 2 : 1;
  if (end < body.length) {
    const newline = body.lastIndexOf("\n", end - 1);
    if (newline + 1 > offset && end - (newline + 1) <= LINE_WINDOW) end = newline + 1;
  }
  return end;
}

/** The page of `body` at `offset`, or null when `offset` is not a page start (past the end, or
 * inside a surrogate pair). */
export function bodyPage(body: string, offset: number, maxBytes: number): BodyPage | null {
  const low = (index: number) => {
    const code = body.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (offset > body.length || (offset === body.length && body.length > 0) || (offset > 0 && low(offset) && !low(offset - 1))) return null;
  const end = pageEnd(body, offset, maxBytes);
  return {
    body: body.slice(offset, end),
    range: {
      offset,
      end,
      total_chars: body.length,
      total_bytes: Buffer.byteLength(body, "utf8"),
      complete: offset === 0 && end === body.length,
      ...(end < body.length ? { next_offset: end } : {}),
    },
  };
}
