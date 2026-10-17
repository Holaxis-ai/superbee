import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHostedBlobWriteAdapter, createFetchCarrier, decodeHostedCapabilities,
  HostedOutcomeError, HostedReadAdapterError,
  type BlobWriteExpected, type HostedBlobWriteIdentity, type HostedCarrier,
} from "../src/hosted-transport/index.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/hosted-sync-v1/${name}.json`, import.meta.url), "utf8"));
const caps = decodeHostedCapabilities(JSON.parse(fixture("capabilities-200").response.body));
const first = fixture("blob-create-200-ok"), binary = new Uint8Array(Buffer.from(first.request.bodyBase64, "base64"));
const bundleId = "notes.a";
function intentFor(exchange: any): BlobWriteExpected {
  if (exchange.request.bodyBase64 === undefined) {
    const {bundleId: _bundle, ...intent} = JSON.parse(exchange.request.body);
    return intent;
  }
  const h = exchange.request.headers;
  const key = Buffer.from(h["x-superbee-blob-key"], "base64url").toString("utf8");
  return exchange.route.endsWith("blob-create")
    ? {operationId: "blobs.create.v1", key, expectedVersion: null, expectedContentType: null, version: h["x-superbee-blob-version"], contentType: h["x-superbee-content-type"]}
    : {operationId: "blobs.replace.v1", key, expectedVersion: h["x-superbee-expected-version"], expectedContentType: h["x-superbee-expected-content-type"], version: h["x-superbee-blob-version"], contentType: h["x-superbee-content-type"]};
}
const identityFor = (exchange: any): HostedBlobWriteIdentity => ({requestId: exchange.request.headers["x-superbee-write-request"], binding: exchange.request.headers["x-superbee-checkout"]});
const intent = intentFor(first), identity = identityFor(first);
const answer = (exchange: any) => ({status: exchange.response.status, body: JSON.parse(exchange.response.body), headers: new Headers(exchange.response.headers)});
const unused = async (): Promise<never> => assert.fail("unexpected carrier dispatch");
const adapter = (carrier: HostedCarrier, overrides: Partial<Parameters<typeof createHostedBlobWriteAdapter>[0]> = {}) => createHostedBlobWriteAdapter({carrier, bundleId, signal: new AbortController().signal, capabilities: async () => caps, ...overrides});

test("golden binary creates/replaces and JSON deletes retain exact identity, prefix, pins and typed evidence", async () => {
  for (const name of ["blob-create-200-ok", "blob-create-200-conflict", "blob-replace-200-noop", "blob-replace-200-type-only", "blob-replace-200-stale-type", "blob-delete-200-ok", "blob-delete-200-absent", "blob-delete-428-held"]) {
    const exchange = fixture(name), expected = intentFor(exchange), id = {...identityFor(exchange), via: "codex"};
    const deletion = expected.operationId === "blobs.delete.v1";
    let requests = 0;
    const carrier = createFetchCarrier({baseUrl: "https://example.test", credentials: async () => ({Authorization: "Bearer current"}), fetch: async (input, init) => {
      const request = new Request(input, init); requests++;
      assert.equal(new URL(request.url).pathname, `/agents/workload${exchange.route}`);
      assert.equal(request.headers.get("authorization"), "Bearer current");
      assert.equal(request.headers.get("x-superbee-write-request"), id.requestId);
      assert.equal(request.headers.get("x-superbee-checkout"), id.binding);
      assert.equal(request.headers.get("x-superbee-via"), "codex");
      assert.equal(request.headers.get("x-superbee-accept-deletes"), deletion ? "100000" : null);
      if (deletion) assert.deepEqual(await request.json(), {bundleId, ...expected});
      else {
        const raw = Buffer.from(await request.arrayBuffer());
        assert.equal(raw.toString("base64"), exchange.request.bodyBase64);
        assert.equal(String(raw.byteLength), exchange.request.headers["content-length"]);
        for (const key of ["x-superbee-bundle", "x-superbee-blob-key", "x-superbee-blob-version", "x-superbee-content-type", "x-superbee-expected-version", "x-superbee-expected-content-type"])
          assert.equal(request.headers.get(key), exchange.request.headers[key] ?? null, `${name}: ${key}`);
      }
      return new Response(exchange.response.body, exchange.response);
    }});
    const result = await adapter(carrier, {prefix: "/agents/workload/sync/v1"}).send(expected, {...id, ...(deletion ? {acceptDeletes: 100000} : {})}, deletion ? undefined : binary);
    assert.deepEqual(result.result, JSON.parse(exchange.response.body).ok === undefined ? {...JSON.parse(exchange.response.body), operationId: expected.operationId, ok: false} : JSON.parse(exchange.response.body));
    assert.equal(result.settled, exchange.response.headers["x-superbee-write-settled"] === id.requestId);
    assert.equal(requests, 1);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.result));
    if (result.result?.ok && result.result.operationId === "blobs.delete.v1") assert.equal(result.result.data.deleted, true);
  }
});

test("send copies intent, identity and raw binary bytes before waiting for capabilities", async () => {
  const original = structuredClone(intent), mutable = structuredClone(intent), id = {...identity}, bytes = new Uint8Array(binary);
  let release!: (value: typeof caps) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const writer = adapter({json: unused, stream: unused, bytes: async (_path, sent, _signal, options) => {
    assert.deepEqual(sent, binary);
    assert.equal(options.writeRequest, identity.requestId); assert.equal(options.binding, identity.binding);
    assert.equal(options.headers?.["X-Superbee-Content-Type"], original.operationId === "blobs.delete.v1" ? "" : original.contentType);
    return answer(first);
  }}, {capabilities: () => {entered(); return new Promise(resolve => {release = resolve;});}});
  const pending = writer.send(mutable, id, bytes);
  await waiting;
  mutable.key = "changed.bin";
  if (mutable.operationId !== "blobs.delete.v1") mutable.contentType = "application/pdf";
  id.requestId = "wrong"; id.binding = "wrong"; bytes.fill(1);
  release(caps);
  assert.deepEqual((await pending).result, JSON.parse(first.response.body));
});

test("malformed local identity, pins, binary hash and size refuse before custom carrier dispatch", async () => {
  const replace = intentFor(fixture("blob-replace-200-noop")), deletion = intentFor(fixture("blob-delete-200-ok"));
  const writer = adapter({json: unused, stream: unused, bytes: unused});
  for (const bad of [
    {...intent, key: "../outside.bin"}, {...intent, key: "a\ud800.bin"}, {...intent, key: "é".repeat(257)},
    {...intent, expectedVersion: undefined}, {...intent, contentType: " image/svg+xml"},
    {...intent, contentType: "image/svg+xml\r\nx-extra: bad"}, {...intent, contentType: "image/非ascii"},
    {...replace, expectedContentType: undefined}, {...replace, expectedVersion: null},
    {...deletion, version: "sha256:" + "a".repeat(64)}, {...intent, operationId: "documents.create.v1"},
  ]) await assert.rejects(writer.send(bad as BlobWriteExpected, identity, binary), TypeError);
  for (const bad of [
    {...identity, requestId: "wrong"}, {...identity, requestId: "11111111-1111-1111-1111-111111111111"},
    {...identity, binding: "wrong"}, {...identity, via: "superbee-cli"}, {...identity, via: "bad label"},
    {...identity, acceptDeletes: 1}, {...identity, recreate: identity.binding},
  ]) await assert.rejects(writer.send(intent, bad, binary), TypeError);
  await assert.rejects(writer.send(intent, identity, new Uint8Array(binary.length)), TypeError);
  await assert.rejects(writer.send(intent, identity), TypeError);
  await assert.rejects(writer.send(intent, identity, new Uint8Array(16 * 1024 * 1024 + 1)), TypeError);
  await assert.rejects(writer.send(deletion, {...identity, acceptDeletes: 0}), TypeError);
  await assert.rejects(writer.send(deletion, identity, new Uint8Array()), TypeError);
  await assert.rejects(adapter({json: unused, stream: unused}).send(intent, identity, binary), HostedReadAdapterError);
});

test("write capability and its own byte bound gate sends and lookups independently of read permission", async () => {
  for (const denied of [
    {...caps, blobWrites: undefined}, {...caps, blobWrites: "refused" as const},
    {...caps, blobWriteBytes: null}, {...caps, blobWriteBytes: Infinity},
  ]) {
    const writer = adapter({json: unused, stream: unused, bytes: unused}, {capabilities: async () => denied});
    await assert.rejects(writer.send(intent, identity, binary), HostedReadAdapterError);
    await assert.rejects(writer.lookup(intent, identity), HostedReadAdapterError);
  }
  await assert.rejects(adapter({json: unused, stream: unused, bytes: unused}, {capabilities: async () => ({...caps, blobWriteBytes: 4})}).send(intent, identity, binary), TypeError);
  const writer = adapter({json: unused, stream: unused, bytes: async () => answer(first)}, {capabilities: async () => ({...caps, blobReads: "refused", blobReadBytes: null})});
  assert.equal((await writer.send(intent, identity, binary)).result?.ok, true);
});

test("settlement markers never override classifier rows or rescue malformed and contradictory typed results", async () => {
  const success = answer(first);
  for (const marker of [undefined, "11111111-1111-4111-8111-111111111111", identity.requestId]) {
    const headers = new Headers(); if (marker) headers.set("X-Superbee-Write-Settled", marker);
    const sent = await adapter({json: unused, stream: unused, bytes: async () => ({...success, headers})}).send(intent, identity, binary);
    assert.equal(sent.settled, marker === identity.requestId);
    assert.equal(sent.row.recorded, "yes"); assert.equal(sent.row.outcome, "committed");
  }
  for (const body of [
    {...success.body, operationId: "blobs.delete.v1"}, {...success.body, data: {...success.body.data, changed: false}},
    {...success.body, data: {...success.body.data, contentType: "application/pdf"}}, {ok: true},
  ]) {
    const sent = await adapter({json: unused, stream: unused, bytes: async () => ({...success, body})}).send(intent, identity, binary);
    assert.equal(sent.settled, false); assert.equal(sent.row.outcome, "unknown"); assert.equal(sent.result, undefined);
  }
  for (const [code, recorded] of [["backend_unavailable", "settled-only"], ["insufficient_scope", "no"]] as const) {
    const result = {ok: false, operationId: intent.operationId, error: {code, message: "Refused", retryable: false, writeState: "not_applied"}};
    for (const headers of [success.headers, new Headers()]) {
      const sent = await adapter({json: unused, stream: unused, bytes: async () => ({...success, headers, body: result})}).send(intent, identity, binary);
      assert.equal(sent.row.recorded, recorded); assert.equal(sent.settled, recorded === "settled-only" && headers.has("x-superbee-write-settled")); assert.deepEqual(sent.result, result);
    }
  }
});

test("loss, server failure and abort after possible dispatch stay unknown without lookup or resend", {timeout: 1000}, async () => {
  for (const response of [async () => {throw new Error("lost acknowledgment");}, async () => ({status: 503, headers: new Headers(), body: {error: {code: "write_outcome_unknown"}}})]) {
    let calls = 0;
    const sent = await adapter({json: unused, stream: unused, bytes: async () => {calls++; return response();}}).send(intent, identity, binary);
    assert.equal(sent.row.outcome, "unknown"); assert.equal(sent.settled, false); assert.equal(calls, 1);
  }
  const controller = new AbortController();
  let entered!: () => void, calls = 0;
  const dispatched = new Promise<void>(resolve => {entered = resolve;});
  const pending = adapter({json: unused, stream: unused, bytes: async () => {calls++; entered(); return new Promise(() => {});}}, {signal: controller.signal}).send(intent, identity, binary);
  await dispatched; controller.abort();
  const sent = await pending;
  assert.equal(sent.status, null); assert.equal(sent.row.answer, "carrier"); assert.equal(sent.row.outcome, "unknown"); assert.equal(calls, 1);
});

test("lookup consumes original immutable MIME/outcome goldens, with identity and no deletion acknowledgment", async () => {
  for (const name of ["blob-outcome-200-original", "blob-outcome-200-refused", "blob-outcome-200-absent"]) {
    const exchange = fixture(name), expected = intentFor(exchange), id = {...identityFor(exchange), via: "codex"};
    let calls = 0;
    const writer = adapter({stream: unused, bytes: unused, json: async (route, input, _signal, options) => {
      calls++;
      assert.equal(route, "/agents/workload/sync/v1/outcome");
      assert.deepEqual(input, {bundleId, ...expected});
      assert.equal(options.writeRequest, id.requestId); assert.equal(options.binding, id.binding); assert.equal(options.via, "codex");
      assert.equal(options.acceptDeletes, undefined);
      return answer(exchange);
    }}, {prefix: "/agents/workload/sync/v1"});
    const result = await writer.lookup(expected, id);
    const body = JSON.parse(exchange.response.body);
    assert.deepEqual(result, body.status === "absent" ? {status: "absent"} : {status: body.status, result: body.result});
    assert.equal(calls, 1);
  }
  const deletion = intentFor(fixture("blob-delete-200-ok")), deleteId = identityFor(fixture("blob-delete-200-ok")), result = JSON.parse(fixture("blob-delete-200-ok").response.body);
  const writer = adapter({stream: unused, bytes: unused, json: async (_route, input, _signal, options) => {
    assert.deepEqual(input, {bundleId, ...deletion}); assert.equal(options.acceptDeletes, undefined);
    return {status: 200, headers: new Headers(), body: {schemaVersion: 1, requestId: deleteId.requestId, binding: deleteId.binding, status: "committed", result}};
  }});
  assert.deepEqual(await writer.lookup(deletion, {...deleteId, acceptDeletes: 100000}), {status: "committed", result});
});

test("failed, pending and contradictory lookup answers never become absence or current-head evidence", async () => {
  const exchange = fixture("blob-outcome-200-original"), expected = intentFor(exchange), id = identityFor(exchange), original = answer(exchange);
  for (const body of [
    {...original.body, requestId: "11111111-1111-4111-8111-111111111111"}, {...original.body, binding: `sha256:${"a".repeat(64)}`},
    {...original.body, status: "pending"}, {...original.body, status: "refused"},
    {...original.body, result: {...original.body.result, data: {...original.body.result.data, contentType: "application/pdf"}}},
    {...original.body, result: {...original.body.result, operationId: "documents.create.v1"}},
  ]) await assert.rejects(adapter({stream: unused, bytes: unused, json: async () => ({...original, body})}).lookup(expected, id), HostedOutcomeError);
  for (const status of [400, 401, 403, 503]) await assert.rejects(adapter({stream: unused, bytes: unused, json: async () => ({...original, status})}).lookup(expected, id), HostedOutcomeError);
  await assert.rejects(adapter({stream: unused, bytes: unused, json: async () => {throw new Error("unavailable");}}).lookup(expected, id), HostedOutcomeError);
  const deletion = intentFor(fixture("blob-delete-200-ok"));
  await assert.rejects(adapter({stream: unused, bytes: unused, json: unused}).lookup({...deletion, expectedContentType: "wrong\r\ntype"}, identity), TypeError);
  const removed = JSON.parse(fixture("blob-delete-200-ok").response.body);
  const writer = adapter({stream: unused, bytes: unused, json: async () => ({status: 200, headers: new Headers(), body: {schemaVersion: 1, requestId: identity.requestId, binding: identity.binding, status: "committed", result: removed}})});
  await assert.rejects(writer.lookup({...deletion, expectedContentType: "application/pdf"}, identity), HostedOutcomeError);
  await assert.rejects(writer.lookup({...deletion, expectedVersion: `sha256:${"a".repeat(64)}`}, identity), HostedOutcomeError);
});

test("lookup snapshots its full original intent and binding before awaiting capabilities", async () => {
  const exchange = fixture("blob-outcome-200-original"), original = intentFor(exchange), mutable = structuredClone(original), id = {...identityFor(exchange)}, originalId = {...id};
  let release!: (value: typeof caps) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const writer = adapter({stream: unused, bytes: unused, json: async (_route, input, _signal, options) => {
    assert.deepEqual(input, {bundleId, ...original}); assert.equal(options.binding, originalId.binding); assert.equal(options.writeRequest, originalId.requestId);
    return answer(exchange);
  }}, {capabilities: () => {entered(); return new Promise(resolve => {release = resolve;});}});
  const pending = writer.lookup(mutable, id);
  await waiting;
  mutable.key = "changed.bin"; id.binding = `sha256:${"a".repeat(64)}`; id.requestId = "wrong";
  if (mutable.operationId !== "blobs.delete.v1") mutable.contentType = "application/pdf";
  release(caps);
  const result = await pending;
  assert.equal(result.status, "committed");
  if (result.status === "committed") assert.deepEqual(result.result, JSON.parse(exchange.response.body).result);
});
