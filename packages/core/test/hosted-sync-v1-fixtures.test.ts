/**
 * `@superbee/core/hosted-transport` against the `/sync/v1` golden exchanges: each fixture under
 * `fixtures/hosted-sync-v1/` is one request and the exact answer the real hosted gateway app
 * emitted (see the fixture index's `source` and `capture-sync-v1-exchanges.hosted.txt`). Every
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
  createHostedReadAdapter,
  decodeDocumentRead,
  decodeHostedCapabilities,
  decodeOutcomeAnswer,
  SYNC_READ_ROUTES,
  type HostedAnswer,
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
  const fetch = (async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    const route = (Object.keys(SYNC_READ_ROUTES) as (keyof typeof SYNC_READ_ROUTES)[]).find((key) => SYNC_READ_ROUTES[key] === pathname);
    const name = route && byRoute[route];
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
  assert.equal(index.exchanges.length, 29);
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

test("a malformed heads or capabilities answer names its route", async () => {
  const fetch = (async () => {
    return new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json", "x-superbee-root-version": "none" } });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
  const adapter = createHostedReadAdapter({ carrier, bundleId: BUNDLE, routes: SYNC_READ_ROUTES });
  await assert.rejects(adapter.heads(), (error: unknown) => error instanceof MalformedAnswer && error.route === SYNC_READ_ROUTES.heads);
  await assert.rejects(adapter.hostedCapabilities(), (error: unknown) => error instanceof MalformedAnswer && error.route === SYNC_READ_ROUTES.capabilities);
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
