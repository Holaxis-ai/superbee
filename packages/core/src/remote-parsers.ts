/**
 * The client side of the wire's heads and snapshot grammar (`docs/WIRE-PROTOCOL.md`, "Heads and
 * snapshot"): what a heads answer must carry before its rows may be diffed as deletions, and
 * how a snapshot body is read so that iterating it to completion is the completeness signal.
 * {@link RemoteBackend.heads} and {@link RemoteBackend.snapshot} are thin callers over these
 * two functions; a host that serves the same grammar through routes of its own validates the
 * answers with the same functions rather than a second parser, since this grammar decides what
 * a working copy deletes locally.
 *
 * Only `TextDecoder` and the Web Streams reader are used, so the same code runs in a browser, a
 * Worker, and Node.
 */

import { headsDigest, isHeadsDigest, type DocumentHead } from "./heads-digest.js";
import { RemoteError, malformed } from "./remote-error.js";
import type { ConceptId, Frontmatter, Version } from "./types.js";

/** A snapshot body that ended, or failed, before its terminator arrived with the announced count. */
export const SNAPSHOT_TRUNCATED = "SNAPSHOT_TRUNCATED";
/**
 * A snapshot whose body arrived whole, with its terminator and the announced count, but whose
 * rows digest to something other than the header announced. Not truncation: re-requesting will
 * not necessarily repair it, since the authority contradicted itself. A consumer discards the
 * documents' claim to the header digest either way.
 */
export const SNAPSHOT_DIGEST_MISMATCH = "SNAPSHOT_DIGEST_MISMATCH";

/** A `200` from `GET /heads`: every document id and version, and the digest over them. */
export interface HeadsResult {
  digest: string;
  heads: DocumentHead[];
}

/** The snapshot's first line: how many documents follow and the digest `heads` would return for this state. */
export interface SnapshotHeader {
  count: number;
  digest: string;
}

/** One `doc` line of a snapshot. */
export interface SnapshotDocument {
  id: ConceptId;
  version: Version;
  frontmatter: Frontmatter;
  body: string;
}

/**
 * A snapshot as {@link readSnapshotStream} hands it over: the header, already parsed, and the
 * documents as they stream. Iterating `docs` to completion is the completeness signal: the
 * loop ends only after the `end` line arrived with the announced count and the digest recomputed
 * over the received `{ id, version }` rows equals the header's, and it throws
 * `SNAPSHOT_TRUNCATED` (the body ended or failed first) or `SNAPSHOT_DIGEST_MISMATCH` (the body
 * was whole but describes a state the header did not announce) otherwise, so a consumer that
 * writes batches as they arrive has one control path and never needs to inspect a terminator
 * or a digest itself. A consumer records the header digest as matched only after the loop
 * ended normally.
 */
export interface RemoteSnapshot {
  header: SnapshotHeader;
  docs: AsyncIterable<SnapshotDocument>;
}

/** Options for {@link readSnapshotStream}. */
export interface ReadSnapshotStreamOptions {
  /**
   * The HTTP status the response carried, reported as `RemoteError.status` by the truncation and
   * digest-mismatch rejections; a caller that has already checked `res.ok` passes `res.status`.
   * Defaults to `200`, the only status a snapshot body is read under.
   */
  status?: number;
}

function isDocumentHead(value: unknown): value is DocumentHead {
  if (typeof value !== "object" || value === null) return false;
  const head = value as { id?: unknown; version?: unknown };
  return typeof head.id === "string" && typeof head.version === "string";
}

/**
 * The `200` body of `GET /heads`, admitted or refused as one: a well-formed digest, a `heads`
 * array of `{ id, version }` rows, a `count` equal to the number of rows, and rows that digest
 * by the documented recipe to the digest served. Anything else rejects as malformed (a
 * {@link MalformedAnswer}, code `MALFORMED_ANSWER`) rather than being trusted. The
 * recomputation is what stops a listing that is whole by its own count but not the state its
 * digest names (a shortened listing under the real digest) from being diffed as a mass
 * deletion. Rows keep the order served: the recipe sorts for itself, so order does not decide
 * admission.
 */
export function parseHeadsAnswer(payload: unknown): HeadsResult {
  const answer = payload as { count?: unknown; digest?: unknown; heads?: unknown } | null;
  if (!isHeadsDigest(answer?.digest)) throw malformed("wire heads answered without a well-formed digest");
  if (!Array.isArray(answer.heads) || !answer.heads.every(isDocumentHead)) {
    throw malformed("wire heads answered without a heads array of { id, version } rows");
  }
  if (answer.count !== answer.heads.length) {
    throw malformed(`wire heads count ${String(answer.count)} disagrees with its ${answer.heads.length} row(s)`);
  }
  const heads = answer.heads.map(({ id, version }) => ({ id, version }));
  const recomputed = headsDigest(heads);
  if (recomputed !== answer.digest) {
    throw malformed(`wire heads served digest ${answer.digest}, but its ${heads.length} row(s) digest to ${recomputed}`);
  }
  return { digest: answer.digest, heads };
}

/**
 * Split a response body into its NDJSON lines as they arrive, decoding UTF-8 across chunk
 * boundaries. A partial trailing line at the end of the body is a cut line and is not yielded; a
 * transport failure while reading is reported as truncation, since either way the terminator
 * never arrived. Leaving the loop early cancels the reader so the connection is released.
 */
async function* ndjsonLines(body: ReadableStream<Uint8Array>, status: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new RemoteError("snapshot body failed before its end line arrived", SNAPSHOT_TRUNCATED, status, cause);
      }
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

function parseSnapshotLine(line: string): { kind?: unknown } & Record<string, unknown> {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    throw malformed("snapshot line is not JSON");
  }
  if (typeof record !== "object" || record === null) throw malformed("snapshot line is not a JSON object");
  return record as { kind?: unknown } & Record<string, unknown>;
}

function parseSnapshotHeader(line: string): SnapshotHeader {
  const record = parseSnapshotLine(line);
  if (record.kind !== "snapshot") throw malformed("snapshot did not begin with its header line");
  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) {
    throw malformed("snapshot header carries no document count");
  }
  if (!isHeadsDigest(record.digest)) throw malformed("snapshot header carries no well-formed digest");
  return { count: record.count, digest: record.digest };
}

/**
 * The document lines of a snapshot, ending normally only at an `end` line whose count equals
 * both the header's announcement and the documents actually seen, and only when the digest
 * recomputed over the received heads equals the header's. Anything else is a rejection: a body
 * that ends first is `SNAPSHOT_TRUNCATED`; a whole body whose heads digest differently is
 * `SNAPSHOT_DIGEST_MISMATCH`; a line the contract does not admit is malformed. The digest is the
 * client's own check of the listing it is about to trust: a count and a terminator say the body
 * is whole, only the recipe says it is the state the header named.
 */
async function* snapshotDocuments(lines: AsyncGenerator<string>, header: SnapshotHeader, status: number): AsyncGenerator<SnapshotDocument> {
  let seen = 0;
  const received: DocumentHead[] = [];
  for await (const line of lines) {
    const record = parseSnapshotLine(line);
    if (record.kind === "doc") {
      if (typeof record.id !== "string" || typeof record.version !== "string" || typeof record.body !== "string") {
        throw malformed("snapshot doc line lacks id, version, or body");
      }
      if (typeof record.frontmatter !== "object" || record.frontmatter === null || Array.isArray(record.frontmatter)) {
        throw malformed("snapshot doc line lacks a frontmatter object");
      }
      seen += 1;
      if (seen > header.count) throw malformed(`snapshot delivered more than the ${header.count} announced document(s)`);
      received.push({ id: record.id, version: record.version });
      yield { id: record.id, version: record.version, frontmatter: record.frontmatter as Frontmatter, body: record.body };
      continue;
    }
    if (record.kind === "end") {
      if (record.count !== seen || seen !== header.count) {
        throw new RemoteError(
          `snapshot end line counts ${String(record.count)} document(s), but ${seen} of ${header.count} announced arrived`,
          SNAPSHOT_TRUNCATED,
          status,
        );
      }
      const recomputed = headsDigest(received);
      if (recomputed !== header.digest) {
        throw new RemoteError(
          `snapshot header announced digest ${header.digest}, but its ${seen} document(s) digest to ${recomputed}`,
          SNAPSHOT_DIGEST_MISMATCH,
          status,
        );
      }
      return;
    }
    throw malformed(`snapshot line has unexpected kind ${JSON.stringify(record.kind)}`);
  }
  throw new RemoteError(
    `snapshot ended after ${seen} of ${header.count} document(s) without its end line`,
    SNAPSHOT_TRUNCATED,
    status,
  );
}

/**
 * Read a `GET /snapshot` body by the documented grammar. The header line is parsed before this
 * resolves, so a body that ends before it rejects here with `SNAPSHOT_TRUNCATED` and a first
 * line that is not the header rejects as malformed; the documents then stream through
 * {@link RemoteSnapshot.docs}, which ends normally only for a whole body whose rows digest to
 * the header's announcement (see {@link RemoteSnapshot}). Obtaining the response, checking its
 * status, and re-requesting a truncated snapshot are the caller's: this function reads one body
 * once and cancels the reader when the iteration is abandoned or fails.
 */
export async function readSnapshotStream(body: ReadableStream<Uint8Array>, options: ReadSnapshotStreamOptions = {}): Promise<RemoteSnapshot> {
  const status = options.status ?? 200;
  const lines = ndjsonLines(body, status);
  const first = await lines.next();
  if (first.done) throw new RemoteError("snapshot ended before its header line", SNAPSHOT_TRUNCATED, status);
  let header: SnapshotHeader;
  try {
    header = parseSnapshotHeader(first.value);
  } catch (err) {
    await lines.return(undefined);
    throw err;
  }
  return { header, docs: snapshotDocuments(lines, header, status) };
}
