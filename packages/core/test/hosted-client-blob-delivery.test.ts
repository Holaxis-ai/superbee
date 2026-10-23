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

test("only validated recorded sends settle; missing marker, a mislabelled unrecorded refusal and malformed evidence stay unknown", async () => {
  const { row, exchange } = retained("blob-replace-200-type-only");
  const raw = JSON.parse(exchange.response.body);
  const backendFailure = { ok: false, operationId: "blobs.replace.v1", error: { code: "backend_unavailable", message: "unavailable", retryable: false, writeState: "not_applied" } };
  for (const answer of [
    { status: 200, row: updateRow("200 backend_unavailable"), result: backendFailure, settled: false },
    { status: 200, row: updateRow("200 other"), result: { ...backendFailure, error: { ...backendFailure.error, code: "insufficient_scope" } }, settled: true },
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

test("a refusal the host never records proves this attempt did not execute: refused with a receipt when every earlier attempt is proven", async () => {
  const backendFailure = { ok: false, operationId: "blobs.replace.v1", error: { code: "insufficient_scope", message: "no grant", retryable: false, writeState: "not_applied" } };
  const rows: [number, string, Record<string, unknown>][] = [
    [200, "200 insufficient_scope", backendFailure],
    [200, "200 bundle_not_found", { ...backendFailure, error: { ...backendFailure.error, code: "bundle_not_found" } }],
    [200, "200 request_capacity", { ...backendFailure, error: { ...backendFailure.error, code: "request_capacity", scope: "bundle" } }],
    [429, "429 request_capacity", { ...backendFailure, error: { ...backendFailure.error, code: "request_capacity", scope: "principal", resetAt: "2026-10-18T00:00:00Z" } }],
  ];
  for (const [status, answerRow, result] of rows) {
    // First attempt, and a resend after a proven not-dispatched prefix: every earlier attempt proven.
    for (const proven of [retained("blob-replace-200-type-only").row, { ...retained("blob-replace-200-type-only", 2).row, notAppliedThrough: 1, notDispatched: { code: "credentials_denied" as const } }]) {
      const selected = await performHostedBlobDelivery(stub({ send: async () => ({ status, row: updateRow(answerRow), result: result as never, settled: false }), lookup: unused }), proven, { start: "submit-claimed" });
      assert.equal(selected.state, "refused", answerRow);
      assert.equal(selected.outcome.kind === "refused" && selected.outcome.code, (result.error as { code: string }).code);
      assert.deepEqual(selected.patch.receipt, blobReceipt(proven.prepared, result));
    }
  }
  // A claim whose earlier attempt is unclear is never submitted at all: it is lookup-only.
  const unclear: BlobIntentRecord = { ...retained("blob-replace-200-type-only", 2).row };
  await assert.rejects(performHostedBlobDelivery(stub({ send: unused, lookup: unused }), unclear, { start: "submit-claimed" }), /non-execution prefix/);
});

test("a create the host refuses as path_collision settles refused with its receipt, after one send and no lookup", async () => {
  const { row, intent } = retained("blob-create-200-ok");
  const body = { ok: false, operationId: "blobs.create.v1", error: { code: "path_collision", message: "Nothing was written; choose a distinct path.", retryable: false, writeState: "not_applied" } };
  let sends = 0, lookups = 0;
  // No settled marker, as hosted answers it: the refusal is not recorded under the identity.
  const carrier: HostedCarrier = { json: async () => { lookups++; return { status: 200, body: { schemaVersion: 1, status: "absent" }, headers: new Headers() }; }, stream: unused, bytes: async () => { sends++; return { status: 200, body, headers: new Headers() }; } };
  for (const proven of [row, { ...retained("blob-create-200-ok", 2).row, notAppliedThrough: 1, notDispatched: { code: "credentials_denied" as const } }]) {
    sends = 0; lookups = 0;
    const selected = await performHostedBlobDelivery(contextFor(carrier), proven, { start: "submit-claimed", maxLookups: 3, lookupDelayMs: 0 });
    assert.equal(sends, 1); assert.equal(lookups, 0);
    assert.equal(selected.state, "refused");
    assert.equal(selected.outcome.kind === "refused" && selected.outcome.code, "path_collision");
    assert.deepEqual(selected.patch.receipt, blobReceipt(proven.prepared, body));
  }
  assert.equal(intent.operationId, "blobs.create.v1");
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

test("strict held delete persists a complete prefix across restart then one confirmed exact-identity submission", async () => {
  const value = retained("blob-delete-428-held"), { row, exchange } = value;
  const directory = await fs.mkdtemp(path.join(tmpdir(), "blob-held-prefix-"));
  const options = { directory, lock: { lockRoot: path.join(directory, "locks") } };
  let backend = await FileJournaledBackend.open(options), sends = 0;
  const holdCarrier: HostedCarrier = { stream: unused, json: async (_route, body, _signal, headers) => { sends++; assert.deepEqual(body, { bundleId: scope.bundleId, ...value.intent }); assert.equal(headers?.acceptDeletes, undefined); return { status: 428, body: JSON.parse(exchange.response.body), headers: new Headers() }; } };
  try {
    const admitted = await backend.admitPreparedBlob(row.prepared, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    let claimed = await backend.updateBlobIntent(admitted.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    const held = await performHostedBlobDelivery(contextFor(holdCarrier), claimed, { start: "submit-claimed" });
    assert.equal(held.outcome.kind, "not-executed"); assert.equal(held.lookups, 0); assert.equal(held.patch.notAppliedThrough, 1); assert.deepEqual(held.patch.deletionHold, { deletions: 3, baseline: 5 }); assert.equal(held.patch.receipt, undefined);
    await backend.updateBlobIntent(claimed.requestId, "in_flight", held.patch, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    await backend.close(); backend = await FileJournaledBackend.open(options);
    const persisted = (await backend.readBlobIntent(row.requestId))!; assert.equal(persisted.prepared, row.prepared);
    const absent = await performHostedBlobDelivery(stub({ send: unused, lookup: async () => ({ status: "absent" }) }), persisted, { start: "lookup" }); assert.equal(absent.outcome.kind, "unknown"); assert.equal(absent.patch.notAppliedThrough, undefined);
    claimed = await backend.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 2 }, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    await assert.rejects(performHostedBlobDelivery(contextFor(holdCarrier), claimed, { start: "submit-claimed" }), /acceptance/);
    await assert.rejects(performHostedBlobDelivery(contextFor(holdCarrier), claimed, { start: "submit-claimed", acceptDeletes: 2 }), /acceptance/);
    const terminal = { ok: true as const, operationId: "blobs.delete.v1" as const, data: { key: value.intent.key, version: value.intent.expectedVersion!, contentType: value.intent.expectedContentType!, deleted: true as const } };
    const successCarrier: HostedCarrier = { stream: unused, json: async (_route, body, _signal, headers) => { sends++; assert.deepEqual(body, { bundleId: scope.bundleId, ...value.intent }); assert.equal(headers?.acceptDeletes, 4); return { status: 200, body: terminal, headers: new Headers() }; } };
    const sent = await performHostedBlobDelivery(contextFor(successCarrier), claimed, { start: "submit-claimed", acceptDeletes: 4 }); assert.equal(sent.state, "acknowledged"); assert.equal(sent.attempts, 2); assert.equal(sends, 2);
    await backend.updateBlobIntent(row.requestId, "in_flight", sent.patch, { guard: (await backend.readBlobWithJournal(row.target)).guard });
    const saved = (await backend.readBlobIntent(row.requestId))!; assert.equal(saved.prepared, row.prepared); assert.equal("head" in saved.receipt! && saved.receipt.head, null); assert.equal(saved.receipt?.result.ok && saved.receipt.result.data.contentType, value.intent.expectedContentType);
    assert.equal(Object.hasOwn(saved, "acceptDeletes"), false);
  } finally { await backend.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test("hold-shaped answers cannot fill uncertainty, lookup proof, wrong status or malformed count gaps", async () => {
  const { row, exchange } = retained("blob-delete-428-held"), raw = JSON.parse(exchange.response.body);
  const result = { ok: false, operationId: "blobs.delete.v1", error: raw.error };
  for (const answer of [
    { status: 200, row: updateRow("200 other"), result, settled: false },
    { status: 428, row: updateRow("428 deletions_held"), result: { ...result, error: { ...result.error, writeState: "unknown" } }, settled: false },
    { status: 428, row: updateRow("428 deletions_held"), result: { ...result, error: { ...result.error, deletions: 0 } }, settled: false },
  ]) {
    const selected = await performHostedBlobDelivery(stub({ send: async () => answer as never, lookup: async () => ({ status: "absent" }) }), row, { start: "submit-claimed", maxLookups: 1 }); assert.equal(selected.outcome.kind, "unknown"); assert.equal(selected.patch.notAppliedThrough, undefined);
  }
  let sends = 0;
  await assert.rejects(performHostedBlobDelivery(stub({ send: async () => { sends++; throw new Error(); }, lookup: unused }), { ...row, attempts: 2 }, { start: "submit-claimed" }), /prefix/); assert.equal(sends, 0);
  const fromLookup = await performHostedBlobDelivery(stub({ send: unused, lookup: async () => ({ status: "refused", result: result as never }) }), row, { start: "lookup" });
  // A lookup cannot mint the attempt witness. Its explicit terminal envelope remains a receipt, not prefix proof.
  assert.equal(fromLookup.patch.notAppliedThrough, undefined);
  let release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  const timed = await performHostedBlobDelivery(stub({ send: async () => { await late; return { status: 428, row: updateRow("428 deletions_held"), result: result as never, settled: false }; }, lookup: async () => ({ status: "absent" }) }), row, { start: "submit-claimed", deadlineMs: 1, maxLookups: 1, sleep: async () => {} });
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(timed.outcome.kind, "unknown"); assert.equal(timed.patch.notAppliedThrough, undefined);
  const controller = new AbortController();
  const cancelled = await performHostedBlobDelivery(stub({ send: async () => { controller.abort(); return { status: 428, row: updateRow("428 deletions_held"), result: result as never, settled: false }; }, lookup: unused }), row, { start: "submit-claimed", signal: controller.signal }); assert.equal(cancelled.outcome.kind, "unknown"); assert.equal(cancelled.patch.notAppliedThrough, undefined);
});


test("held proof retains classifier-captured counts when a supplied row getter mutates port evidence", async () => {
  const { row, exchange } = retained("blob-delete-428-held");
  const raw = JSON.parse(exchange.response.body), result = { ok: false, operationId: "blobs.delete.v1", error: raw.error };
  let reads = 0;
  const answer = { status: 428, result, settled: false, get row() { reads++; result.error.deletions = 99; return updateRow("428 deletions_held"); } };
  const selected = await performHostedBlobDelivery(stub({ send: async () => answer as never, lookup: unused }), row, { start: "submit-claimed" });
  assert.ok(reads > 0); assert.equal(result.error.deletions, 99);
  assert.equal(selected.outcome.kind, "not-executed");
  assert.deepEqual(selected.patch.deletionHold, { deletions: 3, baseline: 5 });
  assert.equal(selected.patch.notAppliedThrough, 1); assert.equal(selected.patch.receipt, undefined);
});


test("terminal send selects captured classifier evidence despite mutable row accessor", async () => {
  const { row } = retained("blob-replace-200-type-only");
  const result = { ok: false, operationId: "blobs.replace.v1", error: { code: "backend_unavailable", message: "captured", retryable: false, writeState: "not_applied" } };
  const answer = { status: 200, result, settled: true, get row() { result.error.message = "changed later"; return updateRow("200 backend_unavailable"); } };
  const selected = await performHostedBlobDelivery(stub({ send: async () => answer as never, lookup: unused }), row, { start: "submit-claimed" });
  assert.equal(result.error.message, "changed later"); assert.equal(selected.outcome.kind, "refused");
  if (selected.outcome.kind !== "refused") assert.fail("refusal expected");
  assert.equal(selected.outcome.message, "captured");
});

test("a not_dispatched prefix without a deletion hold resends on submit-claimed; acceptance belongs only to a held delete", async () => {
  for (const [name, acceptDeletes] of [["blob-create-200-ok", undefined], ["blob-replace-200-type-only", undefined], ["blob-delete-200-ok", undefined], ["blob-delete-200-ok", 100000]] as const) {
    const { row: base, exchange } = retained(name, 2);
    const row: BlobIntentRecord = { ...base, notAppliedThrough: 1, notDispatched: { code: "credentials_denied" } };
    let sent = 0, accepted: string | null = null;
    const carrier = createFetchCarrier({ baseUrl: scope.origin, credentials: async () => ({ Authorization: "Bearer fresh" }), fetch: async (input, init) => {
      sent++; accepted = new Request(input, init).headers.get("x-superbee-accept-deletes");
      return new Response(exchange.response.body, { status: exchange.response.status, headers: exchange.response.headers });
    }});
    const result = await performHostedBlobDelivery(contextFor(carrier), row, { start: "submit-claimed", ...(acceptDeletes === undefined ? {} : { acceptDeletes }) });
    assert.equal(sent, 1, name);
    assert.equal(result.outcome.kind, "committed", name);
    assert.equal(result.attempts, 2);
    assert.equal(accepted, acceptDeletes === undefined ? null : String(acceptDeletes));
  }
  // A held delete still needs this invocation's acceptance of at least its held count, sending nothing otherwise.
  const { row: base } = retained("blob-delete-200-ok", 2);
  const held: BlobIntentRecord = { ...base, notAppliedThrough: 1, deletionHold: { deletions: 3, baseline: 5 } };
  for (const acceptDeletes of [undefined, 2]) {
    await assert.rejects(performHostedBlobDelivery(stub({ send: unused, lookup: unused }), held, { start: "submit-claimed", ...(acceptDeletes === undefined ? {} : { acceptDeletes }) }), /held deletion continuation/);
  }
});
