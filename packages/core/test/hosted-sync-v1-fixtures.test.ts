/**
 * `@superbee/core/hosted-transport` against the `/sync/v1` golden exchanges: each fixture under
 * `fixtures/hosted-sync-v1/` is one request and the exact answer the real hosted gateway app
 * emitted. The files are generated in superbee-hosted (`test/support/sync-v1-exchanges.ts`) and
 * copied here unchanged, with the index's `source` naming the hosted commit; a hosted CI job fails
 * when these copies and the generator's output differ, so edit them only by copying. Every
 * read, write and outcome answer the CLI checkout depends on must decode, refuse or classify as
 * the row it names, through the real fetch carrier. The CLI's fake host is held to the same
 * exchanges by `packages/cli/test/hosted-fake-contract.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyWriteAnswer,
  createFetchCarrier,
  HostedCarrierError,
  isPageRestart,
  createHostedReadAdapter,
  decodeDocumentRead,
  decodeHostedCapabilities,
  decodeOutcomeAnswer,
  decodeDocumentHistory,
  decodeHistoryAnswer,
  HOSTED_READ_BOUNDS,
  operationRefusal,
  readRefusal,
  SYNC_READ_ROUTES,
  type HostedAnswer,
  type HostedHistoryRequest,
} from "../src/hosted-transport/index.js";
import { MALFORMED_ANSWER, MalformedAnswer, RemoteError } from "../src/remote-error.js";
import { versionOfBytes } from "../src/versioning.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");

interface Exchange {
  name: string;
  route: string;
  rows: string[];
  request: { method: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
}

/** The export route's 200 answer is a zip, recorded as base64 in place of `body`. */
interface BinaryExchange {
  response: { status: number; headers: Record<string, string>; bodyBase64: string };
}

const index = JSON.parse(readFileSync(path.join(FIXTURES, "index.json"), "utf8")) as {
  source: string;
  exchanges: { name: string; file: string; route: string; rows: string[]; status: number }[];
};
const exchanges = new Map<string, Exchange>(index.exchanges.map((entry) => [entry.name, JSON.parse(readFileSync(path.join(FIXTURES, entry.file), "utf8")) as Exchange]));
const fixture = (name: string): Exchange => exchanges.get(name) ?? assert.fail(`no fixture ${name}`);

const BUNDLE = "notes.a";

/** A read adapter whose fetch answers every request with the named exchange's exact bytes. */
function adapterAnswering(byRoute: Partial<Record<keyof typeof SYNC_READ_ROUTES, string>>) {
  return adapterServing((route) => byRoute[route]);
}

/** A read adapter whose fetch answers each request with the exchange `pick` names for its route and input. */
function adapterServing(pick: (route: keyof typeof SYNC_READ_ROUTES, input: Record<string, unknown>) => string | undefined) {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    const route = (Object.keys(SYNC_READ_ROUTES) as (keyof typeof SYNC_READ_ROUTES)[]).find((key) => SYNC_READ_ROUTES[key] === pathname);
    const name = route && pick(route, JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (!name) return assert.fail(`no exchange for ${pathname}`);
    const { response } = fixture(name);
    return new Response(response.status === 304 || response.body === "" ? null : response.body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
  return createHostedReadAdapter({ carrier, bundleId: BUNDLE, routes: SYNC_READ_ROUTES, sleep: async () => {} });
}

function answerOf(exchange: Exchange): HostedAnswer {
  const { body, status, headers } = exchange.response;
  return { status, headers: new Headers(headers), body: body === "" ? undefined : JSON.parse(body) };
}

test(`golden /sync/v1 exchanges (${index.source}) are indexed as recorded`, () => {
  assert.equal(index.exchanges.length, 50);
  for (const entry of index.exchanges) {
    const exchange = fixture(entry.name);
    assert.equal(exchange.route, entry.route);
    assert.equal(exchange.response.status, entry.status);
    assert.deepEqual(exchange.rows, entry.rows);
  }
});

test("export 200 is a complete store-only zip whose last entry is the manifest", () => {
  const { response } = fixture("export-200") as unknown as BinaryExchange;
  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="notes.a-2.zip"');
  const bytes = Buffer.from(response.bodyBase64, "base64");
  // The end record closes the archive (a stopped export has none) and names the entries.
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0, "stored, not compressed");
});

test("export refusals carry the working copy routes' bytes", () => {
  assert.deepEqual(JSON.parse(fixture("export-404-bundle-not-found").response.body).error.code, "bundle_not_found");
  assert.deepEqual(JSON.parse(fixture("export-400-invalid-input").response.body), { error: { code: "invalid_input" } });
  assert.equal(fixture("export-401-unauthenticated").response.body, fixture("read-401-unauthenticated").response.body);
});

// ── reads ──────────────────────────────────────────────────────────────────────────────────

test("read 200 ok: documents.read.v1 decodes to the document at its version", async () => {
  const adapter = adapterAnswering({ read: "read-200-ok" });
  const read = await adapter.read("notes/one");
  const expected = JSON.parse(fixture("read-200-ok").response.body) as { data: { document: { frontmatter: object; body: string }; version: string } };
  assert.deepEqual(read, { doc: { id: "notes/one", frontmatter: expected.data.document.frontmatter, body: expected.data.document.body }, version: expected.data.version });
});

test("read 200 ok: an answer naming another document is malformed, naming the route", () => {
  const body = JSON.parse(fixture("read-200-ok").response.body);
  assert.throws(() => decodeDocumentRead("notes/other", body, "/sync/v1/read"), (error: unknown) => error instanceof MalformedAnswer && error.route === "/sync/v1/read" && error.code === MALFORMED_ANSWER);
});

test("read: the write-result shape (bundleId, documentId beside data) is not documents.read.v1's answer", async () => {
  const real = JSON.parse(fixture("read-200-ok").response.body) as { data: { document: { frontmatter: object; body: string }; version: string } };
  const writeShaped = { ok: true, operationId: "documents.read.v1", data: { bundleId: BUNDLE, documentId: "notes/one", version: real.data.version, document: { frontmatter: real.data.document.frontmatter, body: real.data.document.body } } };
  const error = (() => {
    try {
      decodeDocumentRead("notes/one", writeShaped, "/sync/v1/read");
    } catch (caught) {
      return caught;
    }
    return undefined;
  })();
  assert.ok(error instanceof MalformedAnswer);
  assert.equal(error.route, "/sync/v1/read");
});

test("read 200 document_not_found is the ENOENT every backend answers absence with", async () => {
  const adapter = adapterAnswering({ read: "read-200-document-not-found" });
  await assert.rejects(adapter.read("notes/absent"), (error: unknown) => (error as { code?: unknown }).code === "ENOENT");
});

test("read 200 bundle_not_found is an authority refusal, not a malformed answer", async () => {
  const adapter = adapterAnswering({ read: "read-200-bundle-not-found" });
  await assert.rejects(adapter.read("notes/one"), (error: unknown) => error instanceof RemoteError && !(error instanceof MalformedAnswer) && error.code === "bundle_not_found");
});

test("read 400 and 401 refuse with the host's status", async () => {
  await assert.rejects(adapterAnswering({ read: "read-400-invalid-input" }).read("notes/one"), (error: unknown) => error instanceof RemoteError && error.status === 400 && error.code === "invalid_input");
  // The sync bearer admission answers `{"error":"invalid_token"}`: a string, not `{ code }`.
  await assert.rejects(adapterAnswering({ read: "read-401-unauthenticated" }).read("notes/one"), (error: unknown) => error instanceof RemoteError && error.status === 401 && error.code === "AUTH_REQUIRED");
});

test("capabilities 200 decodes", () => {
  const decoded = decodeHostedCapabilities(JSON.parse(fixture("capabilities-200").response.body));
  assert.equal(decoded.operations, true);
  assert.ok(decoded.root);
  assert.equal(versionOfBytes(decoded.root.content), decoded.root.version);
});

test("heads 200 and 304 decode through the adapter", async () => {
  const listing = await adapterAnswering({ heads: "heads-200" }).heads();
  const expected = JSON.parse(fixture("heads-200").response.body) as { digest: string; heads: unknown[] };
  assert.deepEqual(listing, { digest: expected.digest, heads: expected.heads });
  assert.equal(await adapterAnswering({ heads: "heads-304" }).heads({ ifNoneMatch: expected.digest }), null);
});

test("snapshot 200 decodes whole, and each document's version is its read's", async () => {
  const snapshot = await adapterAnswering({ snapshot: "snapshot-200" }).snapshot();
  const docs = [];
  for await (const doc of snapshot.docs) docs.push(doc);
  assert.equal(docs.length, snapshot.header.count);
  const read = JSON.parse(fixture("read-200-ok").response.body) as { data: { version: string; document: { body: string } } };
  assert.equal(docs[0]!.version, read.data.version);
  assert.equal(docs[0]!.body, read.data.document.body);
});

test("heads 200 no root decodes, with the root version header saying none", async () => {
  const listing = await adapterAnswering({ heads: "heads-200-no-root" }).heads();
  const expected = JSON.parse(fixture("heads-200-no-root").response.body) as { digest: string; heads: unknown[] };
  assert.deepEqual(listing, { digest: expected.digest, heads: expected.heads });
  assert.equal(fixture("heads-200-no-root").response.headers["x-superbee-root-version"], "none");
});

/** The paged exchanges: the first page for a request without a cursor, the last for one with it. */
const byCursor = (first: string, last: string) => (_route: string, input: Record<string, unknown>) => (input.cursor === undefined ? first : last);

test("heads 200 page: the adapter follows the cursor and assembles the whole listing under its digest", async () => {
  const listing = await adapterServing(byCursor("heads-200-page-first", "heads-200-page-last")).heads();
  const [first, last] = ["heads-200-page-first", "heads-200-page-last"].map((name) => JSON.parse(fixture(name).response.body) as { count: number; digest: string; heads: unknown[] });
  assert.deepEqual(listing, { digest: first!.digest, heads: [...first!.heads, ...last!.heads] });
  assert.equal(listing!.heads.length, first!.count);
});

test("snapshot 200 page: the adapter stitches the pages into one snapshot of every document", async () => {
  const snapshot = await adapterServing(byCursor("snapshot-200-page-first", "snapshot-200-page-last")).snapshot();
  const docs = [];
  for await (const doc of snapshot.docs) docs.push(doc);
  const heads = JSON.parse(fixture("heads-200-page-first").response.body) as { count: number; digest: string };
  assert.deepEqual(snapshot.header, { count: heads.count, digest: heads.digest });
  const last = JSON.parse(fixture("heads-200-page-last").response.body) as { heads: { id: string; version: string }[] };
  assert.deepEqual(docs.map((doc) => doc.id).slice(-1), last.heads.map((head) => head.id));
  assert.equal(docs.length, heads.count);
});

test("refusal 409 concurrent_change: a page of a listing that moved restarts, and the refusal stands after the attempts", async () => {
  let firsts = 0;
  const adapter = adapterServing((_route, input) => {
    if (input.cursor !== undefined) return "heads-409-concurrent-change";
    firsts += 1;
    return "heads-200-page-first";
  });
  await assert.rejects(adapter.heads(), (error: unknown) => isPageRestart(error) && (error as RemoteError).status === 409);
  assert.equal(firsts, 3, "the listing started again from the first page");
});

test("refusal 503 backend_unavailable is the carrier's unavailable, not an authority refusal", async () => {
  await assert.rejects(adapterAnswering({ heads: "heads-503-backend-unavailable" }).heads(), (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");
});

test("refusal 403 access_denied (a client without the sync surface) asks for sign-in with the host's status", async () => {
  await assert.rejects(adapterAnswering({ read: "read-403-access-denied" }).read("notes/one"), (error: unknown) => error instanceof RemoteError && error.status === 403 && error.code === "AUTH_REQUIRED");
});

test("a malformed heads or capabilities answer names its route", async () => {
  const fetch = (async () => {
    return new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json", "x-superbee-root-version": "none" } });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
  const adapter = createHostedReadAdapter({ carrier, bundleId: BUNDLE, routes: SYNC_READ_ROUTES });
  await assert.rejects(adapter.heads(), (error: unknown) => error instanceof MalformedAnswer && error.route === SYNC_READ_ROUTES.heads);
  await assert.rejects(adapter.hostedCapabilities(), (error: unknown) => error instanceof MalformedAnswer && error.route === SYNC_READ_ROUTES.capabilities);
});

// ── history ────────────────────────────────────────────────────────────────────────────────

const HISTORY_ROUTE = "/sync/v1/history";

/** The page an exchange's request asks for, as the client states it. */
function historyRequestOf(exchange: Exchange): HostedHistoryRequest {
  const body = JSON.parse(exchange.request.body) as { documentId: string; limit?: number; before?: number; includeContent?: true };
  return { documentId: body.documentId, limit: body.limit ?? 20, ...(body.before === undefined ? {} : { before: body.before }), ...(body.includeContent ? { includeContent: true } : {}) };
}

/** The exchange's answer, through the real fetch carrier under the history bound. */
async function historyAnswer(name: string): Promise<HostedAnswer> {
  const exchange = fixture(name);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, HISTORY_ROUTE);
    assert.deepEqual(JSON.parse(String(init?.body)), JSON.parse(exchange.request.body));
    return new Response(exchange.response.body, { status: exchange.response.status, headers: exchange.response.headers });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
  return carrier.json(HISTORY_ROUTE, JSON.parse(exchange.request.body), new AbortController().signal, { maximum: HOSTED_READ_BOUNDS.historyBytes });
}

test("history 200 ok: documents.history.v1 decodes newest first, with each agent label and the first page's total", async () => {
  const answer = await historyAnswer("history-200-ok");
  assert.equal(answer.status, 200);
  const decoded = decodeHistoryAnswer(historyRequestOf(fixture("history-200-ok")), answer.body, HISTORY_ROUTE);
  assert.ok(decoded.ok);
  const expected = JSON.parse(fixture("history-200-ok").response.body) as { data: { versions: { seq: number; version: string; actor: string; timestamp: string; agent?: string }[]; total: number } };
  assert.deepEqual(decoded.page.versions, expected.data.versions);
  assert.deepEqual(decoded.page.versions.map((row) => row.seq), [2, 1]);
  assert.equal(decoded.page.versions[1]!.agent, "sync/credential:cli;via=claude-code");
  assert.equal(decoded.page.more, false);
  assert.equal(decoded.page.total, 2);
});

test("history 200 content: a page back carries the version's bytes, which hash to its version, and no total", async () => {
  const exchange = fixture("history-200-content");
  const decoded = decodeHistoryAnswer(historyRequestOf(exchange), (await historyAnswer("history-200-content")).body, HISTORY_ROUTE);
  assert.ok(decoded.ok);
  const [version] = decoded.page.versions;
  assert.equal(version!.seq, 1);
  assert.equal(versionOfBytes(version!.content!), version!.version);
  assert.equal(decoded.page.total, undefined);
  // The same row's content, altered by one byte, no longer matches its version.
  const tampered = JSON.parse(exchange.response.body) as { data: { versions: { content: string }[] } };
  tampered.data.versions[0]!.content = tampered.data.versions[0]!.content.replace("via", "vib");
  assert.throws(() => decodeDocumentHistory(historyRequestOf(exchange), tampered, HISTORY_ROUTE), (error: unknown) => error instanceof MalformedAnswer && error.route === HISTORY_ROUTE);
});

test("history 200 document_not_found is the operation's refusal, not a malformed answer", async () => {
  const decoded = decodeHistoryAnswer(historyRequestOf(fixture("history-200-document-not-found")), (await historyAnswer("history-200-document-not-found")).body, HISTORY_ROUTE);
  assert.deepEqual(decoded, { ok: false, refusal: { code: "document_not_found", message: "The document was not found.", retryable: false } });
});

test("history 400 invalid_input refuses with the host's status", async () => {
  const answer = await historyAnswer("history-400-invalid-input");
  const error = readRefusal(answer);
  assert.ok(error instanceof RemoteError && error.status === 400 && error.code === "invalid_input");
});

test("history: an answer that breaks the page asked for is malformed, naming the route", () => {
  const ok = fixture("history-200-ok");
  const request = historyRequestOf(ok);
  const body = () => JSON.parse(ok.response.body) as { operationId: string; data: Record<string, unknown> & { versions: Record<string, unknown>[] } };
  const refuses = (mutate: (value: ReturnType<typeof body>) => void, asked: HostedHistoryRequest = request) => {
    const value = body();
    mutate(value);
    assert.throws(() => decodeDocumentHistory(asked, value, HISTORY_ROUTE), (error: unknown) => error instanceof MalformedAnswer && error.route === HISTORY_ROUTE);
  };
  assert.ok(decodeDocumentHistory(request, body(), HISTORY_ROUTE));
  refuses((value) => void (value.operationId = "documents.read.v1"));
  refuses((value) => void (value.data.documentId = "notes/other"));
  refuses((value) => void value.data.versions.reverse());
  refuses((value) => void (value.data.versions[0]!.seq = 1));
  refuses((value) => void (value.data.versions[0]!.version = "not-a-version"));
  refuses((value) => void (value.data.versions[0]!.content = "---\n"));
  refuses((value) => void delete value.data.total);
  refuses((value) => void (value.data.total = 5));
  refuses((value) => void (value.data.more = "no"));
  refuses(() => {}, { ...request, limit: 1 });
  refuses(() => {}, { ...request, before: 2 });
  refuses((value) => void (value.data.more = true), { ...request, limit: 3 });
  refuses(() => {}, { ...request, includeContent: true });
  // A first page that says more exists lists fewer than the total.
  refuses((value) => void (value.data.more = true), { ...request, limit: 2 });
});

test("operationRefusal: one reading of every operation's refusal, strict about whose it is", () => {
  const body = JSON.parse(fixture("history-200-document-not-found").response.body);
  assert.equal(operationRefusal(JSON.parse(fixture("history-200-ok").response.body), "documents.history.v1"), undefined);
  assert.deepEqual(operationRefusal(body, "documents.history.v1"), { code: "document_not_found", message: "The document was not found.", retryable: false });
  assert.deepEqual(operationRefusal(JSON.parse(fixture("read-200-document-not-found").response.body), "documents.read.v1")?.code, "document_not_found");
  for (const bad of [{ ...body, operationId: "documents.read.v1" }, { ...body, error: { code: "" } }, { ok: false, operationId: "documents.history.v1" }]) {
    assert.throws(() => operationRefusal(bad, "documents.history.v1", HISTORY_ROUTE), (error: unknown) => error instanceof MalformedAnswer && error.route === HISTORY_ROUTE);
  }
});

// ── writes and outcomes ────────────────────────────────────────────────────────────────────

const OPERATION = { "/sync/v1/create": "documents.create.v1", "/sync/v1/replace": "documents.replace.v1", "/sync/v1/delete": "documents.delete.v1" } as Record<string, string>;

for (const entry of index.exchanges.filter((candidate) => OPERATION[candidate.route] !== undefined)) {
  test(`write answer row: ${entry.name} is '${entry.rows.join("' / '")}'`, () => {
    const exchange = fixture(entry.name);
    const request = JSON.parse(exchange.request.body) as { bundleId: string; documentId: string };
    const { row, result } = classifyWriteAnswer(answerOf(exchange), { operationIds: [OPERATION[entry.route]!], documentId: request.documentId, bundleId: request.bundleId });
    assert.ok(entry.rows.includes(row.answer), `classified as '${row.answer}'`);
    if (exchange.response.status === 200) assert.ok(result, "a 200 answer carries its validated envelope");
    if (row.answer === "200 ok") assert.equal(exchange.response.headers["x-superbee-write-settled"], exchange.request.headers["x-superbee-write-request"]);
  });
}

for (const entry of index.exchanges.filter((candidate) => candidate.route === "/sync/v1/outcome")) {
  test(`outcome answer: ${entry.name} decodes as its row`, () => {
    const exchange = fixture(entry.name);
    const request = JSON.parse(exchange.request.body) as { bundleId: string; documentId: string; expectAbsent?: true; expectedVersion?: string; body?: string };
    const operationId = request.expectAbsent ? "documents.create.v1" : request.body === undefined ? "documents.delete.v1" : "documents.replace.v1";
    const decoded = decodeOutcomeAnswer(answerOf(exchange).body, {
      requestId: exchange.request.headers["x-superbee-write-request"]!,
      binding: exchange.request.headers["x-superbee-checkout"]!,
      bundleId: request.bundleId,
      documentId: request.documentId,
      operationIds: [operationId],
    });
    assert.ok(entry.rows.includes(`200 ${decoded.status}`), decoded.status);
    if (decoded.status === "committed" && decoded.content) assert.equal(versionOfBytes(new TextDecoder().decode(decoded.content.bytes)), decoded.content.version);
  });
}
