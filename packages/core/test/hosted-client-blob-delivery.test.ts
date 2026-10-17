import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostedClient, performHostedBlobDelivery, type HostedBlobDeliveryContext } from "../src/hosted-client/index.js";
import { prepareBlobIntent, blobReceipt, type BlobIntentRecord, type BlobTargetScope } from "../src/blob-journal.js";
import { FileJournaledBackend } from "../src/file-journaled-backend.js";
import { createHostedBlobWriteAdapter, createFetchCarrier, decodeHostedCapabilities, updateRow, type HostedBlobWriteAdapter, type BlobWriteExpected, type HostedCarrier } from "../src/hosted-transport/index.js";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/hosted-sync-v1/${name}.json`, import.meta.url), "utf8"));
const caps = decodeHostedCapabilities(JSON.parse(fixture("capabilities-200").response.body));
const scope: BlobTargetScope = { origin: "https://example.test", prefix: "/agents/workload/sync/v1", bundleId: "notes.a", workspaceSlug: null };
const now = "2026-10-17T03:20:00.000Z";
function retained(name = "blob-create-200-ok", attempts = 1, targetScope = scope): { row: BlobIntentRecord; exchange: any; intent: BlobWriteExpected; bytes?: Uint8Array } {
  const exchange = fixture(name), h = exchange.request.headers;
  let intent: BlobWriteExpected;
  if (exchange.request.bodyBase64 === undefined) { const {bundleId: _bundle, ...body} = JSON.parse(exchange.request.body); intent = body; }
  else {
    const common = { key: Buffer.from(h["x-superbee-blob-key"], "base64url").toString("utf8"), version: h["x-superbee-blob-version"], contentType: h["x-superbee-content-type"] };
    intent = exchange.route.endsWith("blob-create") ? { ...common, operationId: "blobs.create.v1", expectedVersion: null, expectedContentType: null } : { ...common, operationId: "blobs.replace.v1", expectedVersion: h["x-superbee-expected-version"], expectedContentType: h["x-superbee-expected-content-type"] };
  }
  const bytes = exchange.request.bodyBase64 === undefined ? undefined : new Uint8Array(Buffer.from(exchange.request.bodyBase64, "base64"));
  const identity = { requestId: h["x-superbee-write-request"], binding: h["x-superbee-checkout"], via: "codex" };
  const prepared = prepareBlobIntent({ scope: targetScope, intent, identity, createdAt: now }, bytes);
  return { exchange, intent, bytes, row: { recordFamily: "blob", requestId: identity.requestId, target: intent.key, prepared, sequence: 1, attempts, state: "in_flight", updatedAt: now } };
}
const unused = async (): Promise<never> => assert.fail("unexpected dispatch");
function contextFor(carrier: HostedCarrier, capabilities: () => Promise<typeof caps> = async () => caps): HostedBlobDeliveryContext {
  return { scope: { ...scope }, adapterFor: signal => createHostedBlobWriteAdapter({ carrier, bundleId: scope.bundleId, prefix: scope.prefix, capabilities, signal }) };
}
function stub(adapter: HostedBlobWriteAdapter): HostedBlobDeliveryContext { return { scope: { ...scope }, adapterFor: () => adapter }; }

test("golden byte/MIME create/replace/delete evidence composes into a guarded journal patch", async () => {
  for (const name of ["blob-create-200-ok", "blob-create-200-conflict", "blob-replace-200-noop", "blob-replace-200-type-only", "blob-replace-200-stale-type", "blob-delete-200-ok", "blob-delete-200-absent"]) {
    const { row, exchange, intent } = retained(name);
    let sent = 0;
    const carrier = createFetchCarrier({ baseUrl: scope.origin, credentials: async () => ({ Authorization: "Bearer fresh" }), fetch: async (input, init) => {
      sent++; const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, `/agents/workload${exchange.route}`);
      assert.equal(request.headers.get("authorization"), "Bearer fresh");
      assert.equal(request.headers.get("x-superbee-write-request"), row.requestId);
      assert.equal(request.headers.get("x-superbee-via"), "codex");
      assert.equal(request.headers.get("x-superbee-checkout"), exchange.request.headers["x-superbee-checkout"]);
      if (intent.operationId === "blobs.delete.v1") { assert.equal(request.headers.get("x-superbee-accept-deletes"), "100000"); assert.deepEqual(await request.json(), { bundleId: scope.bundleId, ...intent }); }
      else { assert.equal(request.headers.get("x-superbee-content-type"), intent.contentType); assert.equal(Buffer.from(await request.arrayBuffer()).toString("base64"), exchange.request.bodyBase64); }
      return new Response(exchange.response.body, { status: exchange.response.status, headers: exchange.response.headers });
    }});
    const result = await performHostedBlobDelivery(contextFor(carrier), row, { start: "submit-claimed", ...(intent.operationId === "blobs.delete.v1" ? { acceptDeletes: 100000 } : {}) });
    assert.equal(sent, 1); assert.equal(result.attempts, 1);
    assert.notEqual(result.outcome.kind, "unknown");
    assert.deepEqual(result.patch.receipt, blobReceipt(row.prepared, JSON.parse(exchange.response.body)));
    if (intent.operationId === "blobs.delete.v1" && result.outcome.kind === "committed") { assert.equal(result.outcome.receipt.head, null); assert.equal(result.outcome.receipt.removed?.contentType, intent.expectedContentType); }
    if (name.endsWith("stale-type")) assert.equal(result.state, "conflict");
    assert.equal(Object.isFrozen(result.patch.receipt), true);
  }
  // The returned patch fits the actual optional file journal update, with no fake doc fields.
  const directory = await fs.mkdtemp(path.join(tmpdir(), "blob-composed-journal-"));
  const backend = await FileJournaledBackend.open({ directory, lock: { lockRoot: path.join(directory, "locks") } });
  try {
    const { row, exchange } = retained("blob-delete-200-ok");
    const admitted = await backend.admitPreparedBlob(row.prepared, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    const claimed = await backend.updateBlobIntent(admitted.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    const carrier: HostedCarrier = { json: async () => ({ status: 200, body: JSON.parse(exchange.response.body), headers: new Headers(exchange.response.headers) }), stream: unused };
    const answer = await performHostedBlobDelivery(contextFor(carrier), claimed, { start: "submit-claimed" });
    await backend.updateBlobIntent(claimed.requestId, "in_flight", answer.patch, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    assert.deepEqual((await backend.readBlobIntent(claimed.requestId))?.receipt, answer.patch.receipt);
  } finally { await backend.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("all trusted scope pins and caller-owned options are captured before any factory or await", async () => {
  const { row } = retained(); let factories = 0;
  for (const changed of [{ origin: "https://other.test" }, { prefix: "/different" }, { bundleId: "different" }, { workspaceSlug: "team" }]) {
    const context = { scope: { ...scope, ...changed }, adapterFor: () => { factories++; assert.fail("scope mismatch must not construct adapter"); } };
    await assert.rejects(performHostedBlobDelivery(context, row, { start: "submit-claimed" }), /trusted checkout scope/);
  }
  assert.equal(factories, 0);
  const old = retained("blob-delete-200-ok");
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let originalFactoryCalls = 0;
  const carrier: HostedCarrier = { json: async (_route, body, _signal, options) => { assert.deepEqual(body, { bundleId: scope.bundleId, ...old.intent }); assert.equal(options?.acceptDeletes, 12); return { status: 200, body: JSON.parse(old.exchange.response.body), headers: new Headers(old.exchange.response.headers) }; }, stream: unused };
  const context = contextFor(carrier, async () => { await ready; return caps; });
  const originalFactory = context.adapterFor;
  context.adapterFor = signal => { originalFactoryCalls++; return originalFactory(signal); };
  const options = { start: "submit-claimed" as const, acceptDeletes: 12 };
  const pending = performHostedBlobDelivery(context, old.row, options);
  context.scope.origin = "https://changed.test"; context.adapterFor = () => assert.fail("factory changed after capture"); old.row.prepared = "changed"; options.acceptDeletes = 99;
  release();
  const selected = await pending;
  assert.equal(selected.state, "acknowledged"); assert.equal(originalFactoryCalls, 1);
});

test("only validated recorded sends settle; missing marker, unrecorded refusal and malformed evidence stay unknown", async () => {
  const { row, exchange } = retained("blob-replace-200-type-only");
  const raw = JSON.parse(exchange.response.body);
  const backendFailure = { ok: false, operationId: "blobs.replace.v1", error: { code: "backend_unavailable", message: "unavailable", retryable: false, writeState: "not_applied" } };
  for (const answer of [
    { status: 200, row: updateRow("200 backend_unavailable"), result: backendFailure, settled: false },
    { status: 200, row: updateRow("200 insufficient_scope"), result: { ...backendFailure, error: { ...backendFailure.error, code: "insufficient_scope" } }, settled: true },
    { status: 200, row: updateRow("200 ok"), result: { ...raw, data: { ...raw.data, contentType: "wrong/type" } }, settled: true },
    { status: 200, row: updateRow("200 other"), result: raw, settled: true },
    { status: 503, row: updateRow("200 ok"), result: raw, settled: true },
  ]) {
    let sends = 0, lookups = 0;
    const result = await performHostedBlobDelivery(stub({ send: async () => { sends++; return answer as never; }, lookup: async () => { lookups++; return { status: "absent" }; } }), row, { start: "submit-claimed" });
    assert.equal(sends, 1); assert.equal(lookups, 1); assert.equal(result.state, "unknown"); assert.equal("receipt" in result.patch, false);
  }
  const accepted = await performHostedBlobDelivery(stub({ send: async () => ({ status: 200, row: updateRow("200 backend_unavailable"), result: backendFailure as never, settled: true }), lookup: unused }), row, { start: "submit-claimed" });
  assert.equal(accepted.state, "refused");
});

test("lost ACK selects immutable lookup evidence; absent, failed or contradictory lookup never sends", async () => {
  const { row, exchange } = retained("blob-delete-200-ok");
  const original = JSON.parse(exchange.response.body);
  let sends = 0, lookups = 0;
  const context = stub({ send: async () => { sends++; throw new Error("lost ACK"); }, lookup: async (_intent, identity) => { lookups++; assert.equal("acceptDeletes" in identity, false); return { status: "committed", result: original }; } });
  const delivered = await performHostedBlobDelivery(context, row, { start: "submit-claimed", acceptDeletes: 4 });
  assert.equal(delivered.state, "acknowledged"); assert.equal(sends, 1); assert.equal(lookups, 1);
  assert.deepEqual(delivered.patch.receipt, blobReceipt(row.prepared, original));
  for (const lookup of [async () => ({ status: "absent" as const }), async () => { throw new Error("offline"); }, async () => ({ status: "refused" as const, result: original }), async () => ({ status: "committed" as const, result: { ...original, data: { ...original.data, contentType: "later/head" } } })]) {
    const selected = await performHostedBlobDelivery(stub({ send: async () => { sends++; assert.fail("reopened claim cannot send"); }, lookup: lookup as never }), row, { start: "lookup", maxLookups: 1 });
    assert.equal(selected.state, "unknown"); assert.equal(selected.attempts, 1); assert.equal("receipt" in selected.patch, false);
  }
  assert.equal(sends, 1);
  // Real wire decoding after lost ACK retains the historical MIME even if a later head differs.
  const create = retained(), immutable = fixture("blob-outcome-200-original");
  let deliveries = 0, evidenceReads = 0, laterType = "image/svg+xml; charset=utf-8";
  const carrier = createFetchCarrier({ baseUrl: scope.origin, credentials: async () => ({ Authorization: "Bearer current" }), fetch: async (input, init) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/blob-create")) { deliveries++; laterType = "application/later-head"; throw new Error("ACK lost after mutation"); }
    assert.equal(route, `${scope.prefix}/outcome`); evidenceReads++;
    assert.deepEqual(await request.json(), JSON.parse(immutable.request.body));
    assert.equal(request.headers.get("x-superbee-write-request"), create.row.requestId);
    return new Response(immutable.response.body, { status: 200, headers: immutable.response.headers });
  }});
  const recovered = await performHostedBlobDelivery(contextFor(carrier), create.row, { start: "submit-claimed" });
  assert.equal(deliveries, 1); assert.equal(evidenceReads, 1); assert.equal(laterType, "application/later-head");
  assert.equal(recovered.state, "acknowledged");
  if (recovered.outcome.kind !== "committed") assert.fail("immutable historical commit expected");
  assert.equal(recovered.outcome.receipt.head?.contentType, "image/svg+xml; charset=utf-8");
});

test("caller abort and per-attempt deadline cancel hanging send/lookup without late settlement", async () => {
  const { row, exchange } = retained();
  const terminal = JSON.parse(exchange.response.body);
  for (const start of ["submit-claimed", "lookup"] as const) {
    const controller = new AbortController(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let lifetime!: AbortSignal, late!: (value: any) => void;
    const context: HostedBlobDeliveryContext = { scope, adapterFor(signal) { lifetime = signal; return { send: () => { entered(); return new Promise(resolve => { late = resolve; }); }, lookup: () => { entered(); return new Promise(resolve => { late = resolve; }); } }; } };
    const pending = performHostedBlobDelivery(context, row, { start, signal: controller.signal, maxLookups: 1 });
    await started; controller.abort();
    const answer = await pending;
    assert.equal(lifetime.aborted, true); assert.equal(answer.state, "unknown"); assert.equal("receipt" in answer.patch, false);
    late(start === "lookup" ? { status: "committed", result: terminal } : { status: 200, row: updateRow("200 ok"), result: terminal, settled: true });
    await Promise.resolve(); assert.equal(answer.state, "unknown");
  }
  for (const start of ["submit-claimed", "lookup"] as const) {
    const signals: AbortSignal[] = [];
    const context: HostedBlobDeliveryContext = { scope, adapterFor(signal) { signals.push(signal); return { send: () => new Promise(() => {}), lookup: () => new Promise(() => {}) }; } };
    const result = await performHostedBlobDelivery(context, row, { start, deadlineMs: 5, maxLookups: 1 });
    assert.equal(result.state, "unknown"); assert.equal(signals.every(signal => signal.aborted), true);
    assert.equal(signals.length, start === "lookup" ? 1 : 2);
  }
});

test("terminal records, malformed options, invalid claims and non-delete acknowledgments fail before factory", async () => {
  const { row, exchange } = retained(); let factories = 0;
  const context: HostedBlobDeliveryContext = { scope, adapterFor: () => { factories++; assert.fail("invalid input cannot construct adapter"); } };
  for (const options of [{ start: "submit-claimed", acceptDeletes: 1 }, { start: "lookup", acceptDeletes: 1 }, { start: "lookup", maxLookups: Infinity }]) await assert.rejects(performHostedBlobDelivery(context, row, options as never));
  await assert.rejects(performHostedBlobDelivery(context, { ...row, attempts: 0, state: "pending" }, { start: "submit-claimed" }));
  const receipt = blobReceipt(row.prepared, JSON.parse(exchange.response.body));
  await assert.rejects(performHostedBlobDelivery(context, { ...row, state: "acknowledged", receipt }, { start: "lookup" }), /unsettled/);
  assert.equal(factories, 0);
});


test("actual within clients qualify composed raw creates and replaces without crossing workspaces", async () => {
  let credentials = 0;
  const seen: { path: string; bundle: string | null; body?: unknown; token: string | null }[] = [];
  let active: ReturnType<typeof retained>;
  const client = createHostedClient({ target: { origin: scope.origin, syncPrefix: scope.prefix }, credentials: async () => ({ Authorization: `Bearer fresh-${++credentials}` }), fetch: async (input, init) => {
    const request = new Request(input, init), pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/capabilities")) {
      const body = await request.json() as { bundleId: string };
      seen.push({ path: pathname, bundle: body.bundleId, body, token: request.headers.get("authorization") });
      return new Response(fixture("capabilities-200").response.body, { status: 200, headers: { "content-type": "application/json" } });
    }
    seen.push({ path: pathname, bundle: request.headers.get("x-superbee-bundle"), token: request.headers.get("authorization") });
    assert.equal(Buffer.from(await request.arrayBuffer()).toString("base64"), active.exchange.request.bodyBase64);
    assert.equal(request.headers.get("x-superbee-write-request"), active.row.requestId);
    assert.equal(request.headers.get("x-superbee-checkout"), active.exchange.request.headers["x-superbee-checkout"]);
    assert.equal(request.headers.get("x-superbee-via"), "codex");
    return new Response(active.exchange.response.body, { status: active.exchange.response.status, headers: active.exchange.response.headers });
  }});
  for (const slug of ["south", "north"]) {
    const scoped = client.within(slug), target = { ...scope, workspaceSlug: slug };
    const context: HostedBlobDeliveryContext = { scope: target, adapterFor: signal => createHostedBlobWriteAdapter({ carrier: scoped.carrier, bundleId: target.bundleId, prefix: target.prefix, signal, capabilities: () => scoped.reader(target.bundleId).hostedCapabilities() }) };
    for (const name of ["blob-create-200-ok", "blob-replace-200-type-only"]) {
      active = retained(name, 1, target);
      const result = await performHostedBlobDelivery(context, active.row, { start: "submit-claimed" });
      assert.equal(result.state, "acknowledged");
      assert.deepEqual(result.patch.receipt?.scope, target);
    }
  }
  assert.equal(seen.length, 8); assert.equal(credentials, 8);
  for (const [index, request] of seen.entries()) {
    assert.equal(request.bundle, `${index < 4 ? "south" : "north"}/notes.a`);
    assert.equal(request.token, `Bearer fresh-${index + 1}`);
  }
});
