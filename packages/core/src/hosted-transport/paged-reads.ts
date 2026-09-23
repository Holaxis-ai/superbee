/**
 * Following the host's page cursor for heads and snapshot. The host serves both a page at a
 * time: a request without `cursor` is the first page, and each page that is not the last names
 * the `next` cursor. Every page is served under the one bundle revision the first page pinned
 * and states the whole listing's `count` and `digest`; a write between pages makes the next page
 * refuse with `409 concurrent_change` rather than mix two states, and the reader starts again.
 *
 * A bundle that fits in one page gets the answer it got before paging, so these helpers only
 * stitch pages together: the assembled heads go through {@link parseHeadsAnswer} and the
 * stitched snapshot body through {@link readSnapshotStream}, which keep deciding what a working
 * copy may trust (the count, the terminator, the digest).
 */

import { isHeadsDigest, type DocumentHead } from "../heads-digest.js";
import { RemoteError } from "../remote-error.js";

/** The refusal a page answers when the bundle moved since the first page pinned it. */
export const PAGE_RESTART_CODE = "concurrent_change";
/** How many times a heads listing starts again from the first page before the refusal stands. */
export const HEADS_PAGE_ATTEMPTS = 3;
/** The longest cursor a reader passes back; the host's are far shorter. */
export const MAXIMUM_CURSOR_LENGTH = 4096;

const malformed = (message: string) => new RemoteError(message, "RUNTIME", 502);

/** True when `error` is the host's refusal of a page because the bundle moved since the first. */
export function isPageRestart(error: unknown): boolean {
  return error instanceof RemoteError && error.status === 409 && error.code === PAGE_RESTART_CODE;
}

/** One page of a paged heads answer, shape-checked; the whole listing is checked once assembled. */
export interface HeadsPage {
  readonly count: number;
  readonly digest: string;
  readonly heads: readonly DocumentHead[];
  readonly next?: string;
}

function isCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAXIMUM_CURSOR_LENGTH;
}

export function decodeHeadsPage(value: unknown): HeadsPage {
  const body = value as { count?: unknown; digest?: unknown; heads?: unknown; next?: unknown } | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw malformed("heads page is not a JSON object");
  if (typeof body.count !== "number" || !Number.isSafeInteger(body.count) || body.count < 0) throw malformed("heads page carries no listing count");
  if (!isHeadsDigest(body.digest)) throw malformed("heads page carries no well-formed digest");
  if (!Array.isArray(body.heads)) throw malformed("heads page carries no heads array");
  const heads = body.heads.map((row: unknown) => {
    const head = row as { id?: unknown; version?: unknown } | null;
    if (typeof head !== "object" || head === null || typeof head.id !== "string" || typeof head.version !== "string")
      throw malformed("heads page carries a row that is not { id, version }");
    return { id: head.id, version: head.version };
  });
  if (body.next !== undefined && !isCursor(body.next)) throw malformed("heads page carries a malformed next cursor");
  return { count: body.count, digest: body.digest, heads, ...(body.next === undefined ? {} : { next: body.next }) };
}

/**
 * Collects paged heads into the one listing they page. Every page must state the first page's
 * count and digest, rows must strictly ascend by id across pages (so no row repeats), a page that
 * names a next cursor must carry rows, and the rows may never outnumber the count. The caller
 * hands the assembled `{ count, digest, heads }` to the shared heads parser.
 */
export class HeadsPages {
  #first: HeadsPage | undefined;
  readonly #rows: DocumentHead[] = [];

  /** Adds a page; answers the cursor of the next page, or undefined once the listing is whole. */
  add(page: HeadsPage): string | undefined {
    const first = (this.#first ??= page);
    if (page.count !== first.count || page.digest !== first.digest) throw malformed("heads pages disagree on the listing they page");
    for (const head of page.heads) {
      const last = this.#rows.at(-1);
      if (last !== undefined && !(last.id < head.id)) throw malformed("heads pages repeat or reorder a row");
      this.#rows.push(head);
    }
    if (this.#rows.length > first.count) throw malformed(`heads pages carry more than the ${first.count} row(s) they announce`);
    if (page.next !== undefined && page.heads.length === 0) throw malformed("a heads page names a next page but carries no rows");
    return page.next;
  }

  /** The assembled answer, in the unpaged answer's shape. */
  whole(): { count: number; digest: string; heads: DocumentHead[] } {
    if (!this.#first) throw malformed("no heads page arrived");
    return { count: this.#first.count, digest: this.#first.digest, heads: [...this.#rows] };
  }
}

/** Complete lines of one NDJSON body as they arrive; a partial trailing line is not yielded. */
async function* bodyLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      buffered += decoder.decode(chunk.value, { stream: !chunk.done });
      let start = 0;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n", start)) {
        yield buffered.slice(start, newline);
        start = newline + 1;
      }
      buffered = buffered.slice(start);
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function lineRecord(line: string): Record<string, unknown> | undefined {
  try {
    const record: unknown = JSON.parse(line);
    return typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The prefix every document line the host writes begins with; any other line is parsed here. */
const DOC_LINE = '{"kind":"doc",';

/**
 * One snapshot body stitched from its pages, in the unpaged grammar: the first page's header,
 * every page's document lines in order, and the last page's `end` terminator. A later page's
 * header must state the first page's count and digest and is dropped; a `page` terminator must
 * count the document lines its page carried and names the cursor `open` fetches next. Anything
 * else passes through verbatim for the snapshot parser to judge, and a page that fails to open
 * or ends early ends the stitched body without its terminator, which the parser reports as
 * truncation. Cancelling the stitched body cancels the page being read.
 */
export function stitchSnapshotPages(
  first: ReadableStream<Uint8Array>,
  open: (cursor: string) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  async function* lines(): AsyncGenerator<string> {
    let body = first;
    let header: { count: unknown; digest: unknown } | undefined;
    for (;;) {
      let index = 0;
      let documents = 0;
      let next: string | undefined;
      for await (const line of bodyLines(body)) {
        if (index++ === 0 && header !== undefined) {
          const record = lineRecord(line);
          if (record?.kind !== "snapshot" || record.count !== header.count || record.digest !== header.digest)
            throw malformed("snapshot pages disagree on the header");
          continue;
        }
        if (line.startsWith(DOC_LINE)) {
          documents += 1;
          yield `${line}\n`;
          continue;
        }
        const record = lineRecord(line);
        if (header === undefined && record?.kind === "snapshot") header = { count: record.count, digest: record.digest };
        if (record?.kind === "page") {
          if (record.count !== documents || documents === 0 || !isCursor(record.next))
            throw malformed("snapshot page terminator disagrees with its page");
          next = record.next;
          break;
        }
        yield `${line}\n`;
      }
      if (next === undefined) return;
      body = await open(next);
    }
  }
  const produced = lines();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await produced.next();
        if (step.done) controller.close();
        else controller.enqueue(encoder.encode(step.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await produced.return(undefined);
    },
  });
}
