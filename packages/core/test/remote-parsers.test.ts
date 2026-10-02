/**
 * The exported heads and snapshot parsers (`remote-parsers.ts`) over hand-built payloads: the
 * grammar `docs/WIRE-PROTOCOL.md` "Heads and snapshot" states, exercised without a router so a
 * host that serves the same grammar through routes of its own can read what the validators
 * admit and refuse. `wire-protocol.test.ts` keeps the same behavior pinned through
 * `RemoteBackend.heads` and `RemoteBackend.snapshot`; one agreement test here proves those are
 * thin callers over these functions.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "@superbee/server";
import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";

import { writeDocVersioned } from "../src/bundle.js";
import { headsDigest, type DocumentHead } from "../src/heads-digest.js";
import { RemoteBackend, RemoteError as BackendRemoteError } from "../src/remote-backend.js";
import { RemoteError } from "../src/remote-error.js";
import {
  parseHeadsAnswer,
  readSnapshotStream,
  SNAPSHOT_DIGEST_MISMATCH,
  SNAPSHOT_TRUNCATED,
  type SnapshotDocument,
} from "../src/remote-parsers.js";
import * as remote from "../src/remote.js";
import type { Bundle } from "../src/types.js";
import { T_DOC } from "./scenario.js";

const VERSION_A = `sha256:${"a".repeat(64)}`;
const VERSION_B = `sha256:${"b".repeat(64)}`;
const VERSION_C = `sha256:${"c".repeat(64)}`;

const DOCS: SnapshotDocument[] = [
  { id: "concepts/alpha", version: VERSION_A, frontmatter: { type: "T", title: "alpha" }, body: "body of alpha" },
  { id: "concepts/beta", version: VERSION_B, frontmatter: { type: "T", title: "beta", tags: ["x"] }, body: "body of beta with a multi-byte character: é\u{1F41D}" },
  { id: "notes/gamma", version: VERSION_C, frontmatter: { type: "N", title: "gamma" }, body: "" },
];

const docLine = (doc: SnapshotDocument): string => JSON.stringify({ kind: "doc", ...doc });

/** A well-formed snapshot body over `docs`, with the header and end lines overridable per test. */
function snapshotText(docs: readonly SnapshotDocument[], overrides: { header?: Record<string, unknown>; end?: Record<string, unknown> | null } = {}): string {
  const header = { kind: "snapshot", count: docs.length, digest: headsDigest(docs), ...overrides.header };
  const end = overrides.end === null ? [] : [JSON.stringify({ kind: "end", count: docs.length, ...overrides.end })];
  return [JSON.stringify(header), ...docs.map(docLine), ...end].map((line) => `${line}\n`).join("");
}

/** `text` as a body delivered in `chunkSize`-byte pieces, so lines and multi-byte characters straddle reads. */
function streamOf(text: string, chunkSize = 7, onCancel?: () => void): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** Read a body to its end, keeping the documents yielded before any rejection. */
async function collect(body: ReadableStream<Uint8Array>, options?: { status?: number }) {
  const snapshot = await readSnapshotStream(body, options);
  const received: SnapshotDocument[] = [];
  let failure: unknown;
  try {
    for await (const doc of snapshot.docs) received.push(doc);
  } catch (err) {
    failure = err;
  }
  return { header: snapshot.header, received, failure };
}

const isRemoteError = (err: unknown, code: string, status: number): err is RemoteError =>
  err instanceof RemoteError && err.code === code && err.status === status;

test("remote parsers: the subpath exports the two parsers, the two codes, and one RemoteError identity", () => {
  assert.equal(remote.parseHeadsAnswer, parseHeadsAnswer);
  assert.equal(remote.readSnapshotStream, readSnapshotStream);
  assert.equal(remote.SNAPSHOT_TRUNCATED, "SNAPSHOT_TRUNCATED");
  assert.equal(remote.SNAPSHOT_DIGEST_MISMATCH, "SNAPSHOT_DIGEST_MISMATCH");
  assert.equal(SNAPSHOT_TRUNCATED, "SNAPSHOT_TRUNCATED");
  assert.equal(SNAPSHOT_DIGEST_MISMATCH, "SNAPSHOT_DIGEST_MISMATCH");
  assert.equal(remote.RemoteError, RemoteError, "the subpath's RemoteError is the parsers' class");
  assert.equal(BackendRemoteError, RemoteError, "the backend re-exports the same class, so instanceof holds either way");
});

test("readSnapshotStream: a valid body resolves once the header is parsed, streams every document across chunk boundaries, and completes", async () => {
  const text = snapshotText(DOCS);
  for (const chunkSize of [1, 3, 7, 64, text.length + 1]) {
    const { header, received, failure } = await collect(streamOf(text, chunkSize));
    assert.deepEqual(header, { count: 3, digest: headsDigest(DOCS) }, `chunk size ${chunkSize}`);
    assert.deepEqual(received, DOCS, `chunk size ${chunkSize}: every document, in order, with its frontmatter and body intact`);
    assert.equal(failure, undefined, `chunk size ${chunkSize}`);
  }

  // The empty snapshot is whole too: no documents, the digest of nothing.
  const empty = await collect(streamOf(snapshotText([])));
  assert.deepEqual(empty.header, { count: 0, digest: headsDigest([]) });
  assert.deepEqual(empty.received, []);
  assert.equal(empty.failure, undefined);
});

test("readSnapshotStream: a body that ends without its end line, or is cut mid-line, or fails while being read, rejects the iteration with SNAPSHOT_TRUNCATED after the whole lines before the cut", async () => {
  const missingEnd = await collect(streamOf(snapshotText(DOCS, { end: null })));
  assert.equal(missingEnd.received.length, 3, "every document line arrived");
  assert.ok(isRemoteError(missingEnd.failure, SNAPSHOT_TRUNCATED, 200), `expected SNAPSHOT_TRUNCATED at status 200, got ${String(missingEnd.failure)}`);

  const whole = snapshotText(DOCS);
  const secondDocEnd = whole.indexOf("\n", whole.indexOf('"concepts/beta"'));
  const midLine = await collect(streamOf(whole.slice(0, secondDocEnd - 10)), { status: 200 });
  assert.deepEqual(midLine.received.map((doc) => doc.id), ["concepts/alpha"], "a partial trailing line is a cut, not a document");
  assert.ok(isRemoteError(midLine.failure, SNAPSHOT_TRUNCATED, 200), `expected SNAPSHOT_TRUNCATED, got ${String(midLine.failure)}`);

  // The status option is what the rejection reports.
  const otherStatus = await collect(streamOf(snapshotText(DOCS, { end: null })), { status: 203 });
  assert.ok(isRemoteError(otherStatus.failure, SNAPSHOT_TRUNCATED, 203));

  const failing = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(whole.split("\n").slice(0, 2).join("\n") + "\n"));
    },
    pull(controller) {
      controller.error(new Error("socket reset"));
    },
  });
  const failed = await collect(failing);
  assert.deepEqual(failed.received.map((doc) => doc.id), ["concepts/alpha"]);
  assert.ok(isRemoteError(failed.failure, SNAPSHOT_TRUNCATED, 200) && (failed.failure.cause as Error).message === "socket reset", "a transport failure mid-body is truncation with its cause");

  // No header at all: the promise itself rejects, since there is nothing to resolve with.
  await assert.rejects(readSnapshotStream(streamOf("")), (err: unknown) => isRemoteError(err, SNAPSHOT_TRUNCATED, 200));
  await assert.rejects(readSnapshotStream(streamOf('{"kind":"snapshot","count":0'), { status: 200 }), (err: unknown) => isRemoteError(err, SNAPSHOT_TRUNCATED, 200), "a header line without its newline is a cut line");
});

test("readSnapshotStream: a whole body whose rows do not digest to the header's announcement yields everything, then rejects with SNAPSHOT_DIGEST_MISMATCH", async () => {
  const otherDigest = `sha256:${"e".repeat(64)}`;
  const mismatched = await collect(streamOf(snapshotText(DOCS, { header: { digest: otherDigest } })));
  assert.equal(mismatched.header.digest, otherDigest);
  assert.deepEqual(mismatched.received, DOCS, "the whole body was yielded before the check");
  assert.ok(isRemoteError(mismatched.failure, SNAPSHOT_DIGEST_MISMATCH, 200), `expected SNAPSHOT_DIGEST_MISMATCH, got ${String(mismatched.failure)}`);

  // Whole by count and terminator, under the digest of a longer listing: only the recipe refuses it.
  const shortened = await collect(streamOf(snapshotText(DOCS.slice(0, 2), { header: { digest: headsDigest(DOCS) } })));
  assert.equal(shortened.received.length, 2);
  assert.ok(isRemoteError(shortened.failure, SNAPSHOT_DIGEST_MISMATCH, 200), "a shortened listing under the real digest is a mismatch, not truncation");

  // The same rows at another version digest differently too.
  const otherVersion = DOCS.map((doc) => ({ ...doc, version: VERSION_C }));
  const changed = await collect(streamOf(snapshotText(otherVersion, { header: { digest: headsDigest(DOCS) } })));
  assert.equal(changed.received.length, 3);
  assert.ok(isRemoteError(changed.failure, SNAPSHOT_DIGEST_MISMATCH, 200));
});

test("readSnapshotStream: a malformed header rejects before any document, as MALFORMED_ANSWER 502, and releases the reader", async () => {
  const rest = DOCS.map(docLine).join("\n") + "\n" + JSON.stringify({ kind: "end", count: DOCS.length }) + "\n";
  const headers: Array<[string, string]> = [
    ["not JSON", "not json at all"],
    ["not an object", "42"],
    ["a doc line first", docLine(DOCS[0]!)],
    ["no count", JSON.stringify({ kind: "snapshot", digest: headsDigest(DOCS) })],
    ["a negative count", JSON.stringify({ kind: "snapshot", count: -1, digest: headsDigest(DOCS) })],
    ["a fractional count", JSON.stringify({ kind: "snapshot", count: 1.5, digest: headsDigest(DOCS) })],
    ["a string count", JSON.stringify({ kind: "snapshot", count: "3", digest: headsDigest(DOCS) })],
    ["no digest", JSON.stringify({ kind: "snapshot", count: 3 })],
    ["a malformed digest", JSON.stringify({ kind: "snapshot", count: 3, digest: "sha256:nope" })],
    ["an uppercase digest", JSON.stringify({ kind: "snapshot", count: 3, digest: `sha256:${"A".repeat(64)}` })],
  ];
  for (const [label, header] of headers) {
    let cancelled = false;
    await assert.rejects(
      readSnapshotStream(streamOf(`${header}\n${rest}`, 7, () => { cancelled = true; })),
      (err: unknown) => isRemoteError(err, "MALFORMED_ANSWER", 502),
      label,
    );
    assert.ok(cancelled, `${label}: the reader is cancelled so the connection is released`);
  }
});

test("readSnapshotStream: counts that disagree with the lines reject; an end line that disagrees is truncation, more lines than announced or an unknown kind is malformed", async () => {
  const endTooLow = await collect(streamOf(snapshotText(DOCS, { end: { count: 2 } })));
  assert.equal(endTooLow.received.length, 3);
  assert.ok(isRemoteError(endTooLow.failure, SNAPSHOT_TRUNCATED, 200), "an end line whose count disagrees with the lines is truncation");

  const headerTooHigh = await collect(streamOf(snapshotText(DOCS, { header: { count: 4 }, end: { count: 3 } })));
  assert.equal(headerTooHigh.received.length, 3);
  assert.ok(isRemoteError(headerTooHigh.failure, SNAPSHOT_TRUNCATED, 200), "fewer lines than the header announced, even with a matching end line, is truncation");

  const headerTooLow = await collect(streamOf(snapshotText(DOCS, { header: { count: 2 } })));
  assert.equal(headerTooLow.received.length, 2, "the announced documents are yielded");
  assert.ok(isRemoteError(headerTooLow.failure, "MALFORMED_ANSWER", 502), "a line beyond the announced count is malformed, not truncation");

  const lines = snapshotText(DOCS).split("\n").filter((line) => line !== "");
  const unknownKind = await collect(streamOf([lines[0], lines[1], '{"kind":"comment","text":"x"}', ...lines.slice(2)].join("\n") + "\n"));
  assert.equal(unknownKind.received.length, 1);
  assert.ok(isRemoteError(unknownKind.failure, "MALFORMED_ANSWER", 502), "a kind the grammar does not name is malformed");

  const badDoc = await collect(streamOf([lines[0], JSON.stringify({ kind: "doc", id: "concepts/alpha", version: VERSION_A, body: "no frontmatter" }), ...lines.slice(2)].join("\n") + "\n"));
  assert.equal(badDoc.received.length, 0);
  assert.ok(isRemoteError(badDoc.failure, "MALFORMED_ANSWER", 502), "a doc line without a frontmatter object is malformed");
});

test("parseHeadsAnswer: a well-formed answer yields its rows and digest; a bad row, a digest that does not recompute, or any other departure from the grammar is MALFORMED_ANSWER 502", () => {
  const heads: DocumentHead[] = [
    { id: "b", version: VERSION_B },
    { id: "a", version: VERSION_A },
  ];
  const digest = headsDigest(heads);
  const answer = parseHeadsAnswer({ count: 2, digest, heads: heads.map((head) => ({ ...head, extra: "ignored" })) });
  assert.deepEqual(answer, { digest, heads }, "rows are copied to id and version, in the order served");
  assert.deepEqual(parseHeadsAnswer({ count: 0, digest: headsDigest([]), heads: [] }), { digest: headsDigest([]), heads: [] });

  const rejects = (label: string, payload: unknown): void => {
    assert.throws(() => parseHeadsAnswer(payload), (err: unknown) => isRemoteError(err, "MALFORMED_ANSWER", 502), label);
  };
  rejects("a bad row (no version)", { count: 2, digest, heads: [heads[0], { id: "a" }] });
  rejects("a bad row (numeric version)", { count: 2, digest, heads: [heads[0], { id: "a", version: 1 }] });
  rejects("a bad row (null)", { count: 2, digest, heads: [heads[0], null] });
  rejects("a digest that does not recompute", { count: 2, digest: headsDigest([heads[0]!]), heads });
  rejects("a digest of another version", { count: 2, digest: headsDigest(heads.map((head) => ({ ...head, version: VERSION_C }))), heads });
  rejects("no digest", { count: 2, heads });
  rejects("a malformed digest", { count: 2, digest: "sha256:nope", heads });
  rejects("missing heads", { count: 2, digest });
  rejects("heads not an array", { count: 2, digest, heads: { a: VERSION_A } });
  rejects("a count that disagrees", { count: 3, digest, heads });
  rejects("a string count", { count: "2", digest, heads });
  rejects("null", null);
  rejects("undefined", undefined);
  rejects("a string", "heads");
  rejects("an array", [heads]);
});

test("remote parsers: RemoteBackend.heads and RemoteBackend.snapshot agree with the parsers over the reference router's own answers", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://remote-parsers", backend: serverBackend };
  const router = createRouter(bundle);
  for (const id of ["b", "a/x", "c"]) {
    await writeDocVersioned(bundle, { id, frontmatter: { type: "T", title: id, timestamp: T_DOC }, body: `body of ${id}` });
  }
  const backend = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: router, maxRetries: 0 });

  const headsRes = await router(new Request("http://wire.local/v0/bundles/test/heads"));
  assert.deepEqual(await backend.heads(), parseHeadsAnswer(await headsRes.json()));

  const snapshotRes = await router(new Request("http://wire.local/v0/bundles/test/snapshot"));
  const parsed = await readSnapshotStream(snapshotRes.body!, { status: snapshotRes.status });
  const viaBackend = await backend.snapshot();
  assert.deepEqual(parsed.header, viaBackend.header);
  const docsOf = async (docs: AsyncIterable<SnapshotDocument>) => {
    const out: SnapshotDocument[] = [];
    for await (const doc of docs) out.push(doc);
    return out;
  };
  const parsedDocs = await docsOf(parsed.docs);
  assert.deepEqual(parsedDocs, await docsOf(viaBackend.docs));
  assert.deepEqual(parsedDocs.map((doc) => doc.id), ["a/x", "b", "c"]);
  assert.equal(parsed.header.digest, (await backend.heads())!.digest, "the snapshot header digest is the heads digest for the same state");
});
