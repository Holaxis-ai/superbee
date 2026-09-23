/**
 * The whole-document delete and the "deleted remotely" tombstone in `@superbee/core/hosted-transport`,
 * against the answers superbee-hosted documents for `documents.delete.v1` and the tombstone check
 * on sync creates (PR 606: `docs/documents-delete-operation.md`, `docs/sync-v1-writes.md`). Each
 * fixture under `fixtures/hosted-transport-delete/` is one request and the answer those documents
 * specify, byte for byte in shape.
 *
 * The hard gate on `tasks/extract-transport-neutral-sync-engine`: the "deleted remotely" conflict
 * carries the tombstone; `X-Superbee-Recreate` is sent only when the intent explicitly re-creates;
 * a stale acknowledgement comes back as a conflict again, never as last-writer-wins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyWriteAnswer,
  createFetchCarrier,
  createWholeDocumentTransport,
  decodeOutcomeAnswer,
  HostedOutcomeError,
  RECREATE_HEADER,
  SYNC_WRITE_ROUTES,
  wholeDocumentRequest,
  WholeDocumentInputError,
  type HostedAnswer,
  type HostedCarrier,
  type HostedRequestOptions,
} from "../src/hosted-transport/index.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { DELETION_CONTENT, DELETION_VERSION } from "../src/journaled-backend.js";
import { performUncertainWrite, type OperationIntent } from "../src/uncertain-write.js";
import { versionOfBytes } from "../src/versioning.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-transport-delete");

interface Exchange {
  name: string;
  route: string;
  request: { method: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

const exchanges = new Map<string, Exchange>(
  readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const exchange = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Exchange;
      return [exchange.name, exchange];
    }),
);
const fixture = (name: string): Exchange => exchanges.get(name) ?? assert.fail(`no fixture ${name}`);
const answerOf = (exchange: Exchange): HostedAnswer => ({ status: exchange.response.status, headers: new Headers(exchange.response.headers), body: JSON.parse(exchange.response.body) });

const REQUEST_ID = "4a2f9c1e-8b3d-4e6f-9a1b-2c3d4e5f6a7b";
const BINDING = "sha256:" + "b".repeat(64);
const BASE = "sha256:" + "a".repeat(64);
const TOMBSTONE = "sha256:" + "7".repeat(64);
const NEWER = "sha256:" + "8".repeat(64);
const HEAD = "sha256:" + "d".repeat(64);
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const RETENTION = 2_592_000_000;

function deleteIntent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return { requestId: REQUEST_ID, kind: "document.delete", target: "notes/alpha", base: BASE, local: DELETION_VERSION, content: DELETION_CONTENT, createdAt: new Date(NOW - 60_000).toISOString(), attempts: 0, state: "pending", ...overrides };
}

function createIntent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  const content = stringifyDoc({ type: "Note", title: "Alpha" } as never, "Alpha body changed é\r\n");
  return { requestId: REQUEST_ID, kind: "document.write", target: "notes/alpha", base: null, local: versionOfBytes(content), content, createdAt: new Date(NOW - 60_000).toISOString(), attempts: 0, state: "pending", ...overrides };
}

function over(script: Record<string, (Exchange | (() => HostedAnswer))[]>, intent: OperationIntent, options: { head?: string; now?: number; readFails?: boolean } = {}) {
  const requests: { path: string; input: unknown; options: HostedRequestOptions }[] = [];
  const reads: string[] = [];
  const carrier: HostedCarrier = {
    async json(route, input, _signal, requestOptions) {
      requests.push({ path: route, input, options: requestOptions });
      const queue = script[route];
      if (!queue || queue.length === 0) assert.fail(`unexpected request to ${route}`);
      const entry = queue.shift()!;
      return typeof entry === "function" ? entry() : answerOf(entry);
    },
    stream: async () => assert.fail("no stream"),
  };
  const transport = createWholeDocumentTransport({
    carrier,
    bundleId: "team.knowledge",
    binding: BINDING,
    intentFor: async (id) => (id === intent.requestId ? intent : undefined),
    remote: {
      async read(id) {
        reads.push(id);
        if (options.readFails) throw new Error("offline");
        if (!options.head) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { doc: { id, frontmatter: { type: "Note" }, body: "" }, version: options.head };
      },
      operationsRetentionMs: async () => RETENTION,
    },
    now: () => options.now ?? NOW,
  });
  const deliver = (candidate = intent) => performUncertainWrite(transport, candidate, { settlement: transport.settlement, sleep: async () => {}, lookupDelayMs: 0 });
  return { transport, deliver, requests, reads };
}

// ── the fixtures are the documented answers ────────────────────────────────────────────────

test("fixtures: every documented write answer classifies on its row, and a delete's data admits deletedVersion and deleted only for delete", () => {
  const expected = { operationIds: ["documents.delete.v1"], documentId: "notes/alpha", bundleId: "team.knowledge" };
  assert.equal(classifyWriteAnswer(answerOf(fixture("delete-200-ok")), expected).row.answer, "200 ok");
  assert.equal(classifyWriteAnswer(answerOf(fixture("delete-200-unchanged")), expected).row.answer, "200 ok");
  assert.equal(classifyWriteAnswer(answerOf(fixture("delete-200-version-conflict")), expected).row.answer, "200 version_conflict");
  assert.equal(classifyWriteAnswer(answerOf(fixture("delete-200-document-not-found")), expected).row.answer, "200 document_not_found");
  // The same data under a create or replace is not an envelope the client admits.
  const asReplace = JSON.parse(fixture("delete-200-ok").response.body.replace('"documents.delete.v1"', '"documents.replace.v1"'));
  assert.equal(classifyWriteAnswer({ status: 200, headers: new Headers(), body: asReplace }, { ...expected, operationIds: ["documents.replace.v1"] }).row.answer, "200 other");
  // A delete's success without the keys that say what left is not admitted either.
  const bare = JSON.parse(fixture("delete-200-ok").response.body);
  delete bare.data.deletedVersion;
  assert.equal(classifyWriteAnswer({ status: 200, headers: new Headers(), body: bare }, expected).row.answer, "200 other");
  const create = { operationIds: ["documents.create.v1"], documentId: "notes/alpha", bundleId: "team.knowledge" };
  assert.equal(classifyWriteAnswer(answerOf(fixture("create-200-tombstoned")), create).row.answer, "200 version_conflict");
});

test("fixtures: a committed delete's outcome carries no content, and only a delete's may omit it", () => {
  const expected = { requestId: REQUEST_ID, binding: BINDING, bundleId: "team.knowledge", documentId: "notes/alpha", operationIds: ["documents.delete.v1"] };
  const decoded = decodeOutcomeAnswer(JSON.parse(fixture("delete-outcome-200-committed").response.body), expected);
  assert.equal(decoded.status, "committed");
  assert.equal(decoded.status === "committed" && decoded.content, null);
  // A delete's outcome that carries content is malformed; so is a replace's that carries none.
  const withContent = { ...JSON.parse(fixture("delete-outcome-200-committed").response.body), content: { encoding: "base64", version: TOMBSTONE, bytes: "" } };
  assert.throws(() => decodeOutcomeAnswer(withContent, expected), (error: unknown) => error instanceof HostedOutcomeError && error.reason === "malformed");
  const replaceNoContent = JSON.parse(fixture("delete-outcome-200-committed").response.body.replaceAll('"documents.delete.v1"', '"documents.replace.v1"'));
  delete replaceNoContent.result.data.deletedVersion;
  delete replaceNoContent.result.data.deleted;
  assert.throws(() => decodeOutcomeAnswer(replaceNoContent, { ...expected, operationIds: ["documents.replace.v1"] }), HostedOutcomeError);
});

// ── the delete intent ──────────────────────────────────────────────────────────────────────

test("delete: a document.delete intent is the exact strict kernel input on /sync/v1/delete, its content never read", () => {
  const request = wholeDocumentRequest("team.knowledge", deleteIntent({ content: "not a document at all" }));
  assert.deepEqual(request, { kind: "delete", operationId: "documents.delete.v1", payload: { bundleId: "team.knowledge", documentId: "notes/alpha", expectedVersion: BASE } });
  assert.equal(JSON.stringify(request.payload), fixture("delete-200-ok").request.body);
  assert.equal(SYNC_WRITE_ROUTES.delete, "/sync/v1/delete");
  // Without a base there is nothing to delete at exactly a version: refused, never a create.
  assert.throws(() => wholeDocumentRequest("team.knowledge", deleteIntent({ base: null })), (error: unknown) => error instanceof WholeDocumentInputError && error.code === "unsupported_operation");
});

test("delete: committed at the base answers the tombstone, with one identity and binding and no recreate header", async () => {
  const { deliver, requests } = over({ "/sync/v1/delete": [fixture("delete-200-ok")] }, deleteIntent());
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "committed", version: TOMBSTONE });
  assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/delete"]);
  assert.deepEqual(requests[0]!.options, { maximum: 65536, writeRequest: REQUEST_ID, binding: BINDING });
  assert.deepEqual(requests[0]!.input, JSON.parse(fixture("delete-200-ok").request.body));
});

test("delete: a new identity at a base that already left answers changed: false, and it is the same commit", async () => {
  const { deliver } = over({ "/sync/v1/delete": [fixture("delete-200-unchanged")] }, deleteIntent());
  assert.deepEqual((await deliver()).outcome, { kind: "committed", version: TOMBSTONE });
});

test("delete: strict CAS, a stale base is a conflict against the served version, and nothing is resent", async () => {
  const { deliver, requests, reads } = over({ "/sync/v1/delete": [fixture("delete-200-version-conflict")] }, deleteIntent());
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "conflict", actual: HEAD });
  assert.equal(result.intent.state, "conflict");
  assert.deepEqual(reads, [], "the refusal's current version is a real version and is trusted");
  assert.equal(requests.length, 1);
});

test("delete: absent at another base is a conflict against no document", async () => {
  const { deliver } = over({ "/sync/v1/delete": [fixture("delete-200-document-not-found")] }, deleteIntent());
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: null });
});

test("delete: a lost answer is looked up under the same identity; a committed lookup, changed or not, settles it", async () => {
  for (const name of ["delete-outcome-200-committed", "delete-outcome-200-committed-unchanged"]) {
    const { deliver, requests } = over({ "/sync/v1/delete": [() => ({ status: 503, headers: new Headers(), body: undefined })], "/sync/v1/outcome": [fixture(name)] }, deleteIntent());
    const result = await deliver();
    assert.deepEqual(result.outcome, { kind: "committed", version: TOMBSTONE }, name);
    assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/delete", "/sync/v1/outcome"]);
    assert.deepEqual(requests[1]!.input, requests[0]!.input, "the outcome route takes the write's own body");
    assert.equal(requests[1]!.options.writeRequest, REQUEST_ID);
    assert.equal(requests[1]!.options.recreate, undefined);
  }
});

test("delete: a recorded delete of another base is a contradiction, never a commit", async () => {
  const other = deleteIntent({ base: "sha256:" + "c".repeat(64), attempts: 1 });
  const body = JSON.parse(fixture("delete-outcome-200-committed").response.body);
  const { transport } = over({ "/sync/v1/outcome": [() => ({ status: 200, headers: new Headers(), body })] }, other);
  await assert.rejects(transport.lookup(REQUEST_ID), (error: unknown) => error instanceof HostedOutcomeError && error.reason === "contradiction");
});

test("delete, review S5: absent past retention settles by read-back; absent is removed, present at any version is a conflict", async () => {
  const late = NOW + RETENTION + 86_400_000;
  const absentAnswer = () => ({ status: 200, headers: new Headers(), body: { schemaVersion: 1, requestId: REQUEST_ID, binding: BINDING, status: "absent" } });
  const gone = over({ "/sync/v1/outcome": [absentAnswer] }, deleteIntent({ attempts: 1 }), { now: late });
  assert.deepEqual((await gone.deliver()).outcome, { kind: "committed", version: DELETION_VERSION }, "removed, no tombstone known");
  assert.deepEqual(gone.reads, ["notes/alpha"]);
  // Present, even at exactly the deleted version (a same-bytes re-create): a conflict, never resent.
  const back = over({ "/sync/v1/outcome": [absentAnswer] }, deleteIntent({ attempts: 1 }), { now: late, head: BASE });
  const result = await back.deliver();
  assert.deepEqual(result.outcome, { kind: "conflict", actual: BASE });
  assert.deepEqual(back.requests.map((request) => request.path), ["/sync/v1/outcome"]);
  // An unreadable head stays unknown.
  const offline = over({ "/sync/v1/outcome": [absentAnswer] }, deleteIntent({ attempts: 1 }), { now: late, readFails: true });
  assert.deepEqual((await offline.deliver()).outcome, { kind: "unknown" });
});

// ── the "deleted remotely" tombstone and the explicit re-create ────────────────────────────

test("tombstone: a create refused over a deletion is 'deleted remotely' carrying the tombstone, never a remote version", async () => {
  const intent = createIntent();
  const { deliver, reads, requests } = over({ "/sync/v1/create": [fixture("create-200-tombstoned")] }, intent);
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "conflict", actual: null, tombstone: NEWER });
  assert.deepEqual(reads, ["notes/alpha"], "the served head decides");
  assert.equal(requests[0]!.options.recreate, undefined, "no acknowledgement unless the intent re-creates");
});

test("tombstone: the recreate header is sent only when the intent explicitly re-creates, on the create and on its lookup", async () => {
  const intent = createIntent({ recreates: TOMBSTONE });
  assert.equal(wholeDocumentRequest("team.knowledge", intent).kind === "create" && wholeDocumentRequest("team.knowledge", intent).recreates, TOMBSTONE);
  const { deliver, requests } = over(
    {
      "/sync/v1/create": [() => ({ status: 503, headers: new Headers(), body: undefined })],
      "/sync/v1/outcome": [() => ({ status: 200, headers: new Headers(), body: { schemaVersion: 1, requestId: REQUEST_ID, binding: BINDING, status: "committed", result: { ok: true, operationId: "documents.create.v1", data: { bundleId: "team.knowledge", documentId: "notes/alpha", version: HEAD, changed: true } }, content: { encoding: "base64", version: HEAD, bytes: "" } } })],
    },
    intent,
  );
  await deliver();
  assert.deepEqual(requests.map((request) => [request.path, request.options.recreate]), [["/sync/v1/create", TOMBSTONE], ["/sync/v1/outcome", TOMBSTONE]]);
  assert.equal(fixture("create-200-tombstoned").request.headers["x-superbee-recreate"], TOMBSTONE);
});

test("tombstone: a stale acknowledgement is refused into a fresh conflict naming the newer tombstone, never last-writer-wins", async () => {
  const intent = createIntent({ recreates: TOMBSTONE });
  const { deliver, requests } = over({ "/sync/v1/create": [fixture("create-200-tombstoned")] }, intent);
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "conflict", actual: null, tombstone: NEWER });
  assert.equal(result.intent.state, "conflict");
  assert.equal(requests.length, 1, "never resent under the same identity or silently");
  // Recorded, and found again by lookup: the same conflict.
  const looked = over({ "/sync/v1/outcome": [fixture("create-outcome-200-refused-tombstoned")] }, { ...intent, attempts: 1 });
  assert.deepEqual((await looked.deliver()).outcome, { kind: "conflict", actual: null, tombstone: NEWER });
  assert.equal(looked.requests[0]!.options.recreate, TOMBSTONE);
  // Re-created by someone else meanwhile: a conflict against the served version.
  const present = over({ "/sync/v1/create": [fixture("create-200-tombstoned")] }, intent, { head: HEAD });
  assert.deepEqual((await present.deliver()).outcome, { kind: "conflict", actual: HEAD });
});

test("tombstone: acknowledging a tombstone the id does not have is a conflict without one", async () => {
  const { deliver } = over({ "/sync/v1/create": [fixture("create-200-tombstone-unknown")] }, createIntent({ recreates: TOMBSTONE }));
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: null });
});

test("tombstone: an acknowledgement on anything but a create, or one that is not a version, is refused before sending", async () => {
  for (const intent of [
    createIntent({ base: BASE, recreates: TOMBSTONE }),
    deleteIntent({ recreates: TOMBSTONE }),
    createIntent({ recreates: "sha256:nope" }),
  ]) {
    assert.throws(() => wholeDocumentRequest("team.knowledge", intent), WholeDocumentInputError);
    const { transport, requests } = over({}, intent);
    const outcome = await transport.submit(intent);
    assert.equal(outcome.kind, "refused");
    assert.equal(requests.length, 0);
  }
});

test("fetch carrier: the acknowledgement rides X-Superbee-Recreate, and a malformed one sends nothing", async () => {
  const seen: Headers[] = [];
  const carrier = createFetchCarrier({
    baseUrl: "https://hosted.example",
    credentials: async () => ({ Authorization: "Bearer t" }),
    fetch: (async (_url: URL, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await carrier.json("/sync/v1/create", {}, new AbortController().signal, { maximum: 1024, writeRequest: REQUEST_ID, binding: BINDING, recreate: TOMBSTONE });
  assert.equal(seen[0]!.get(RECREATE_HEADER), TOMBSTONE);
  await carrier.json("/sync/v1/create", {}, new AbortController().signal, { maximum: 1024, writeRequest: REQUEST_ID, binding: BINDING });
  assert.equal(seen[1]!.get(RECREATE_HEADER), null);
  await assert.rejects(carrier.json("/sync/v1/create", {}, new AbortController().signal, { maximum: 1024, recreate: "bad" }));
  assert.equal(seen.length, 2);
});
