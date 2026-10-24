import test from "node:test";
import assert from "node:assert/strict";
import { sourceTargetId, createSourceTargetAdapter, MemoryMachineState, observeSource, fetchIdentity, type SourceTargetAdapterOptions, type PageCommit, type SourceState } from "../src/source-engine/index.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { buildKindRegistry } from "../src/kinds.js";
import { bindSourceFeed } from "../src/connectors.js";
import { buildSourceIndex } from "../src/record-overlay/source-index.js";
import { mutateDocument } from "../src/document-mutation.js";
import { parseMarkdown } from "../src/document-codec.js";
import { VersionConflict } from "../src/versioning.js";
import { InvalidInputError } from "../src/errors.js";
import { signalConvention, SOURCE_FEED_CONVENTION } from "./record-overlay-helpers.js";
import { ticketConnector, TICKET_CONVENTION, FEED_FRONTMATTER, FEED_ID, FEED_URL, SPEC, ticket } from "./fixtures/source-engine/tickets.js";
import { jsonPagesProfile } from "./fixtures/source-engine/json-pages-profile.js";
import type { OperationIntent, Outcome } from "../src/uncertain-write.js";
const AT = "2026-10-24T12:00:00.000Z";
const UUID = "08b763aa-504a-4c60-895f-02c67fd93731";
const namespace = { contract: 1 as const, authority: "synthetic", bundle: "one" };
const limits = { inventory: 10000, establishmentsPerPage: 100, intentBytes: 262144 };
const idInput = { namespace, targetKind: "Ticket", prefix: "tickets/", resource: FEED_URL, externalId: "t1" };
function page(after: Record<string, unknown> = { title: "B", state: "open" }): PageCommit {
  return { feed: FEED_ID, provider: FEED_URL, observed_at: AT, page: 1, replay: false, baseline: true, complete: true, records: { t1: { fields: after } }, changes: [{ external_id: "t1", change_kind: "new", changed_fields: Object.keys(after), before: null, after, content_digest: "fixture" }] };
}
async function world() {
  const backend = new MemoryBackend(); await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const bundle = { root: "/synthetic", backend }, registry = buildKindRegistry([TICKET_CONVENTION, { id: "conventions/signal", body: "", frontmatter: { ...signalConvention("superbee_progress_status"), type: "Convention" } }, { id: "conventions/source-feed", body: "", frontmatter: { ...SOURCE_FEED_CONVENTION, type: "Convention" } }], [], { okfVersion: "0.2" });
  const connector = ticketConnector(), bound = bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED_FRONTMATTER }, registry, { okfVersion: "0.2" });
  let minted = 0, sends = 0, unknown = false;
  // This fixture models durable prepare/read + exclusive claim. Reopened entries only inspect.
  const ledger = new Map<string, { intent: OperationIntent; result?: Outcome }>();
  const creation: SourceTargetAdapterOptions["creation"] = { contract: 1,
    acceptsRequestId: id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    async deliver(intent, input) {
      const old = ledger.get(intent.requestId);
      if (old) { assert.deepEqual(old.intent, intent); return old.result ?? { kind: "unknown" }; }
      if (input.phase === "recovery") return { kind: "unknown" };
      const row: { intent: OperationIntent; result?: Outcome } = { intent: structuredClone(intent) }; ledger.set(intent.requestId, row);
      sends++;
      try {
        const parsed = parseMarkdown(intent.content);
        const result = await mutateDocument({ bundle, registry, strict: true, id: intent.target, mode: "create-only", requestId: intent.requestId, actor: "process:synthetic", now: () => intent.createdAt, buildCandidate: () => parsed });
        row.result = { kind: "committed", version: result.version };
      } catch (error) { if (!(error instanceof VersionConflict)) throw error; row.result = { kind: "conflict", actual: error.actual }; }
      return unknown ? { kind: "unknown" } : row.result;
    } };
  async function adapter(overrides: Partial<SourceTargetAdapterOptions> = {}) {
    return createSourceTargetAdapter({ overlay: { content: { bundle, registry, okfVersion: "0.2" }, policy: bound.policy, actor: "process:synthetic", overlays: await buildSourceIndex(bundle) }, bound, namespace, generation: "v1", intentScope: "run1", limits, creation,
      mintRequestId: () => { minted++; return UUID; }, admit: async () => ({ kind: "admitted" }), ...overrides });
  }
  return { backend, bundle, registry, connector, bound, adapter, ledger, creation, counts: () => ({ minted, sends }), unknown: (v: boolean) => { unknown = v; } };
}
test("stable scalar byte identities agree across independent consumers and isolate tuple boundaries", async () => {
  const a = sourceTargetId(idInput), b = sourceTargetId(JSON.parse(JSON.stringify(idInput)));
  assert.equal(a, "tickets/source-951fdfa3dbe767793fa32aa4ac9f892c9e79da0bfcadceb4567a031b66c15a8e");
  assert.equal(a, b); assert.match(a, /^tickets\/source-[a-f0-9]{64}$/);
  assert.notEqual(a, sourceTargetId({ ...idInput, namespace: { ...namespace, bundle: "two" } }));
  assert.notEqual(sourceTargetId({ ...idInput, namespace: { ...namespace, authority: "a", bundle: "bc" } }), sourceTargetId({ ...idInput, namespace: { ...namespace, authority: "ab", bundle: "c" } }));
  for (const externalId of ["\ud800", "\udfff", "", "x".repeat(2049)]) assert.throws(() => sourceTargetId({ ...idInput, externalId }));
  assert.notEqual(sourceTargetId({ ...idInput, externalId: "é" }), sourceTargetId({ ...idInput, externalId: "e\u0301" }));
});
test("full owned initial projection converges through the existing accepted tuple owner", async () => {
  const w = await world(), a = await w.adapter(), p = page({ title: "B", state: "open", priority: "high", note: "not owned", raw: "provider" });
  const prepared = await a.prepareCommit(p); assert.equal(w.counts().sends, 0);
  const e = prepared.establishments.t1!; assert.equal(e.intent!.requestId, UUID);
  const parsed = parseMarkdown(e.intent!.content); assert.equal(parsed.body.trim(), ""); assert.equal(parsed.frontmatter.note, undefined); assert.equal(parsed.frontmatter.raw, undefined);
  await a.commit({ ...p, establishments: prepared.establishments });
  assert.equal(a.snapshot().entries.length, 0); assert.equal(a.stagedSnapshot()!.entries.length, 1); a.consume();
  const row = await w.backend.read(e.target); assert.equal(row.doc.frontmatter.priority, "high");
  assert.equal((await w.backend.versions(e.target)).length, 1); assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
  await a.commit({ ...p, replay: true, establishments: prepared.establishments }); a.consume(); assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
});
test("required/type/body eligibility and wire UUID refusal precede all effects", async () => {
  const w = await world();
  for (const fields of [{ state: "open" }, { title: "Missing state" }, { title: "Bad state", state: "invalid" }, { title: ["bad"], state: "open" }]) {
    const a = await w.adapter(); await assert.rejects(a.prepareCommit(page(fields)));
  }
  const a = await w.adapter({ mintRequestId: () => "sha256:deadbeef" }); await assert.rejects(a.prepareCommit(page()), /identity refused/);
  const bound = structuredClone(w.bound); bound.kind.sections = ["Required"];
  await assert.rejects(w.adapter({ bound }), /mismatch/); assert.equal(w.counts().sends, 0);
});
test("manual adoption, duplicate identity, unrelated occupant and overlapping updater hold", async () => {
  const w = await world(); const target = sourceTargetId(idInput);
  await w.backend.write(target, { id: target, frontmatter: { type: "Ticket", title: "Manual", state: "open", sources: [{ resource: FEED_URL, id: "t1" }] }, body: "Human notes" });
  const denied = await w.adapter({ admit: async () => ({ kind: "held", code: "overlap_unsupported" }) }); await assert.rejects(denied.prepareCommit(page()), /overlap_unsupported/);
  const a = await w.adapter(), prepared = await a.prepareCommit(page()); assert.equal(prepared.establishments.t1!.kind, "adopt");
  await a.commit({ ...page(), establishments: prepared.establishments }); a.consume(); assert.equal((await w.backend.read(target)).doc.body, "Human notes\n");
  await w.backend.write("tickets/duplicate", { id: "tickets/duplicate", frontmatter: { type: "Ticket", sources: [{ resource: FEED_URL, id: "t1" }] }, body: "" });
  await assert.rejects((await w.adapter()).prepareCommit(page()), /ambiguous/);
  const other = await world(); await other.backend.write(target, { id: target, frontmatter: { type: "Other", title: "Unrelated" }, body: "" });
  await assert.rejects((await other.adapter()).prepareCommit(page()), /identity mismatch/);
});
test("committed B clearing X with failed checkpoint keeps old A skipped until exact replay", async () => {
  const w = await world(), state = new MemoryMachineState();
  const old: SourceState = { v: 1, profile: { id: jsonPagesProfile.id, version: jsonPagesProfile.version }, cursor: null, open: false, complete_observations: 1, records: { t1: { after: { title: "A", state: "open", priority: "high" }, digest: "A", missing: 0, seen_at: AT } } };
  await state.write(FEED_ID, old, null);
  const a = await w.adapter(); let writes = 0;
  const store = { read: state.read.bind(state), async write(...args: Parameters<MemoryMachineState["write"]>) { writes++; if (writes === 2) { a.discard(); throw new Error("checkpoint failed"); } const v = await state.write(...args); if (writes > 1) a.consume(); return v; } };
  const run = (adapter: typeof a, machine = store) => observeSource({ connector: w.connector, bound: w.bound, profile: jsonPagesProfile, spec: SPEC, identity: fetchIdentity("Synthetic/1 (+https://example.org)"), state: machine, now: () => new Date(AT), transport: { async request(req) { return { ok: true as const, status: 200, headers: { "content-type": "application/json" }, body: req.url.includes("robots.txt") ? "" : JSON.stringify({ items: [ticket("t1", "B", "OPEN", { priority: null })] }), bytes: 100 }; } }, prepareCommit: adapter.prepareCommit, commit: adapter.commit });
  const receipt = await run(a); assert.equal(receipt.reason, "state_unwritable");
  const saved = (await state.read(FEED_ID))!.state; assert.equal(saved.records.t1!.after.priority, "high"); assert.ok(saved.pending!.t1!.establishment);
  const target = saved.pending!.t1!.establishment!.target; assert.equal((await w.backend.read(target)).doc.frontmatter.priority, undefined);
  const checkpoint = await state.read(FEED_ID);
  let ordinaryCommits = 0, providerReads = 0, stateWrites = 0;
  for (const prepareCommit of [undefined, a.prepareCommit]) {
    const reopened = await observeSource({ connector: w.connector, bound: w.bound, profile: jsonPagesProfile, spec: SPEC,
      identity: fetchIdentity("Synthetic/1 (+https://example.org)"), now: () => new Date(AT),
      state: { read: state.read.bind(state), async write(...args) { stateWrites++; return state.write(...args); } },
      transport: { async request() { providerReads++; throw new Error("must not fetch"); } },
      prepareCommit, commit: async () => { ordinaryCommits++; } });
    assert.equal(reopened.reason, "establishment_consumer_required");
    assert.deepEqual(await state.read(FEED_ID), checkpoint);
  }
  assert.deepEqual({ ordinaryCommits, providerReads, stateWrites }, { ordinaryCommits: 0, providerReads: 0, stateWrites: 0 });
  let recoveries = 0;
  for (let i = 0; i < 7; i++) {
    const unresolved = await w.adapter({ creation: { ...w.creation, async deliver(intent, input) {
      recoveries++; assert.equal(input.phase, "recovery"); assert.deepEqual(intent, saved.pending!.t1!.establishment!.intent);
      return { kind: "unknown" };
    } } });
    const receipt = await run(unresolved);
    assert.equal(receipt.reason, "establishment_pending"); assert.deepEqual(await state.read(FEED_ID), checkpoint);
  }
  assert.equal(recoveries, 7); assert.equal(w.counts().sends, 1);
  const restarted = await w.adapter(); await restarted.reconcile(saved, AT); restarted.consume(); assert.equal((await w.backend.read(target)).doc.frontmatter.priority, undefined);
  const recoveredStore = { read: state.read.bind(state), async write(...args: Parameters<MemoryMachineState["write"]>) { const v = await state.write(...args); restarted.consume(); return v; } };
  await run(restarted, recoveredStore); const recovered = (await state.read(FEED_ID))!.state;
  assert.equal(recovered.pending, undefined); assert.equal(recovered.records.t1!.after.priority, undefined); assert.equal((await w.backend.read(target)).doc.frontmatter.priority, undefined); assert.equal(w.counts().minted, 1);
});

test("cooperating canonical create race shares a target and never another writer's identity", async () => {
  const w = await world(); let allocator = 0;
  const mintRequestId = () => (++allocator === 1 ? UUID : "a3e9fb74-e33d-42cc-8e18-277983a8ca90");
  const a = await w.adapter({ mintRequestId }), b = await w.adapter({ mintRequestId, intentScope: "other-run" });
  const p = page(), [pa, pb] = await Promise.all([a.prepareCommit(p), b.prepareCommit(p)]);
  assert.equal(pa.establishments.t1!.target, pb.establishments.t1!.target); assert.notEqual(pa.establishments.t1!.intent!.requestId, pb.establishments.t1!.intent!.requestId);
  await Promise.all([a.commit({ ...p, establishments: pa.establishments }), b.commit({ ...p, establishments: pb.establishments })]);
  a.consume(); b.consume(); assert.equal((await w.backend.list()).filter(id => id.startsWith("tickets/")).length, 1);
  assert.equal(w.ledger.size, 2); assert.equal((await w.backend.versions(pa.establishments.t1!.target)).length, 1);
});
test("unknown established effects recover by exact descriptor and never remint or resend", async () => {
  const w = await world(), a = await w.adapter(), p = page(), prepared = await a.prepareCommit(p);
  w.unknown(true); await assert.rejects(a.commit({ ...p, establishments: prepared.establishments }), /unsettled/);
  const b = await w.adapter({ mintRequestId: () => { throw new Error("replay must not mint"); } });
  await b.commit({ ...p, observed_at: "2027-01-01T00:00:00Z", replay: true, establishments: structuredClone(prepared.establishments) }); b.consume();
  assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
  const absent = await world(), c = await absent.adapter({ mintRequestId: () => { throw new Error("no replacement"); } });
  await assert.rejects(c.commit({ ...p, replay: true, establishments: prepared.establishments }), /unsettled/); assert.equal(absent.counts().sends, 0);
});

test("tombstone outcome never causes implicit recreation or acceptance", async () => {
  const w = await world(); let calls = 0;
  const a = await w.adapter({ creation: { contract: 1, acceptsRequestId: () => true, async deliver() { calls++; return { kind: "conflict", actual: null, tombstone: "deleted-version" }; } } });
  const p = page(), prepared = await a.prepareCommit(p);
  await assert.rejects(a.commit({ ...p, establishments: prepared.establishments }), /tombstone/);
  assert.equal(calls, 1); assert.equal((await w.backend.list()).length, 0); assert.equal(a.snapshot().entries.length, 0);
});
test("stored creation bytes or generation drift is held before delivery", async () => {
  const w = await world(), a = await w.adapter(), p = page(), prepared = await a.prepareCommit(p);
  await assert.rejects(a.commit({ ...p, changes: [{ ...p.changes[0]!, after: { title: "Changed", state: "open" } }], establishments: prepared.establishments }), /scope_changed/);
  const changed = await w.adapter({ generation: "v2" }); await assert.rejects(changed.commit({ ...p, replay: true, establishments: prepared.establishments }), /scope_changed/);
  assert.equal(w.counts().sends, 0);
});

for (const externalId of ["__proto__", "constructor", "toString"]) test(`external identity ${externalId} survives durable pending and crash recovery`, async () => {
  const w = await world(), state = new MemoryMachineState();
  const originalCreation = w.creation;
  let deliveryChecks = 0, writes = 0, acquired = 0;
  const creation: typeof originalCreation = { ...originalCreation, async deliver(intent, input) {
    const durable = (await state.read(FEED_ID))!.state;
    assert.ok(Object.hasOwn(durable.pending!, externalId), "pending must survive JSON persistence before delivery");
    assert.equal(durable.pending![externalId]!.establishment!.intent!.requestId, intent.requestId);
    assert.equal(Object.hasOwn(durable.records, externalId), false);
    deliveryChecks++; return originalCreation.deliver(intent, input);
  } };
  const a = await w.adapter({ creation });
  const profile = { ...jsonPagesProfile, async observe() { acquired++; return { records: [ticket(externalId, "B")], nextCursor: null, more: false, complete: false }; } };
  const base = { connector: w.connector, bound: w.bound, profile, spec: SPEC, identity: fetchIdentity("Synthetic/1 (+https://example.org)"), now: () => new Date(AT),
    transport: { async request() { throw new Error("fixture must not use transport"); } } };
  const receipt = await observeSource({ ...base, state: { read: state.read.bind(state), async write(...args) {
    writes++; if (writes === 2) { a.discard(); throw new Error("checkpoint lost"); }
    return state.write(...args);
  } }, prepareCommit: a.prepareCommit, commit: a.commit });
  assert.equal(receipt.reason, "state_unwritable", receipt.detail); assert.equal(deliveryChecks, 1);
  const checkpoint = await state.read(FEED_ID);
  assert.ok(Object.hasOwn(checkpoint!.state.pending!, externalId));
  const original = checkpoint!.state.pending![externalId]!, target = original.establishment!.target;
  assert.equal((await w.backend.read(target)).doc.frontmatter.title, "B");
  const b = await w.adapter({ creation }), controller = new AbortController();
  const recovered = await observeSource({ ...base, signal: controller.signal, state: { read: state.read.bind(state), async write(...args) {
    const v = await state.write(...args); b.consume(); controller.abort(); return v;
  } }, prepareCommit: b.prepareCommit, commit: b.commit });
  assert.equal(recovered.reason, "deadline"); assert.equal(deliveryChecks, 2); assert.equal(acquired, 1);
  const saved = (await state.read(FEED_ID))!.state;
  assert.equal(saved.pending, undefined); assert.ok(Object.hasOwn(saved.records, externalId));
  assert.deepEqual(saved.records[externalId]!.after, original.entry.after);
  assert.equal(b.snapshot().entries[0]!.external_id, externalId);
  assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
  const completeIndex = await buildSourceIndex(w.bundle);
  const linked = completeIndex.lookup(w.bound.resource, externalId);
  assert.ok(linked.some(head => head.frontmatter.type === "Ticket"));
  assert.ok(linked.some(head => head.frontmatter.type === "Signal"), "actual generated Signal shares the source tuple");
  const c = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy, actor: "process:synthetic", overlays: completeIndex, accepted: b.snapshot() } });
  await c.reconcile(saved, AT); c.consume();
  const updated = await observeSource({ ...base, profile: { ...profile, async observe() { return { records: [ticket(externalId, "C")], nextCursor: null, more: false, complete: false }; } },
    state: { read: state.read.bind(state), async write(...args) { const v = await state.write(...args); c.consume(); return v; } }, prepareCommit: c.prepareCommit, commit: c.commit });
  assert.equal(updated.outcome, "observed", updated.detail); assert.equal((await w.backend.read(target)).doc.frontmatter.title, "C");
  assert.ok(Object.hasOwn((await state.read(FEED_ID))!.state.records, externalId)); assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
  const after = (await state.read(FEED_ID))!.state.records[externalId]!.after;
  await c.commit({ ...page(after), establishments: {}, changes: [{ ...page(after).changes[0]!, external_id: externalId }] }); c.consume();
  assert.deepEqual(w.counts(), { minted: 1, sends: 1 });
  const row = (await w.backend.read(target)).doc;
  await w.backend.write("tickets/manual-duplicate", { ...row, id: "tickets/manual-duplicate" });
  const duplicate = await w.adapter();
  await assert.rejects(duplicate.prepareCommit({ ...page(after), changes: [{ ...page(after).changes[0]!, external_id: externalId }] }), /ambiguous identity/);
});

/** The actual paired consumer co-publishes its stage with the supplying state acknowledgment. */
function targetState(state: MemoryMachineState, adapter: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["adapter"]>>) {
  return { read: state.read.bind(state), async write(...args: Parameters<MemoryMachineState["write"]>) {
    const version = await state.write(...args);
    if (!args[1].pending_commit) adapter.consume();
    return version;
  } };
}
function observeTargets(w: Awaited<ReturnType<typeof world>>, adapter: Awaited<ReturnType<typeof w.adapter>>, state: Parameters<typeof observeSource>[0]["state"], records: Record<string, unknown>[],
  input: { at?: string; acquired?: () => void; signal?: AbortSignal; more?: boolean; mode?: "complete" | "incremental" } = {}) {
  return observeSource({ connector: w.connector, bound: w.bound, profile: { ...jsonPagesProfile, async observe() {
    input.acquired?.(); return { records, nextCursor: input.more ? "next" : null, more: input.more ?? false, complete: true, validators: { etag: "new" } };
  } }, spec: SPEC, identity: fetchIdentity("Synthetic/1 (+https://example.org)"), state, now: () => new Date(input.at ?? AT),
  transport: { async request() { throw new Error("profile must not use transport"); } }, signal: input.signal, mode: input.mode,
  prepareCommit: adapter.prepareCommit, commit: adapter.commit });
}

test("qualified create, accepted replacement, Signal and no-op checkpoint every supplying group before effects", async () => {
  const w = await world(), state = new MemoryMachineState(), first = await w.adapter();
  let effects = 0;
  const write = w.backend.write.bind(w.backend);
  w.backend.write = async (...args) => {
    const durable = (await state.read(FEED_ID))!.state;
    assert.deepEqual(durable.pending_commit?.order, ["t1"]);
    effects++; return write(...args);
  };
  assert.equal((await observeTargets(w, first, targetState(state, first), [ticket("t1", "A")])).outcome, "observed");
  const accepted = first.snapshot(), target = accepted.entries[0]!.target;
  const next = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  const before = effects;
  const changed = await observeTargets(w, next, targetState(state, next), [ticket("t1", "B")]);
  assert.equal(changed.outcome, "observed", changed.detail); assert.ok(effects > before);
  assert.equal((await w.backend.read(target)).doc.frontmatter.title, "B");
  assert.ok((await w.backend.list()).some(id => id.startsWith("signals/")), "actual Signal creation/update executes");
  assert.equal((await state.read(FEED_ID))!.state.pending_commit, undefined);
  assert.equal(next.snapshot().entries[0]!.after.title, "B");
  const writesBeforeNoop = effects;
  assert.equal((await observeTargets(w, next, targetState(state, next), [ticket("t1", "B")])).outcome, "observed");
  assert.equal(effects, writesBeforeNoop);
});

for (const persists of [false, true]) test(`a failed qualified supplying checkpoint (${persists ? "lost acknowledgment" : "not stored"}) prevents accepted-target and Signal effects`, async () => {
  const w = await world(), state = new MemoryMachineState(), first = await w.adapter();
  await observeTargets(w, first, targetState(state, first), [ticket("t1", "A")]);
  const original = await state.read(FEED_ID), accepted = first.snapshot();
  const adapter = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  let effects = 0; const write = w.backend.write.bind(w.backend);
  w.backend.write = async (...args) => { effects++; return write(...args); };
  const receipt = await observeTargets(w, adapter, { read: state.read.bind(state), async write(...args) {
    if (persists) await state.write(...args);
    throw new Error("checkpoint acknowledgement lost");
  } }, [ticket("t1", "B")]);
  assert.equal(receipt.reason, "state_unwritable"); assert.equal(effects, 0);
  const saved = await state.read(FEED_ID);
  if (persists) { assert.ok(saved!.state.pending_commit); assert.deepEqual(saved!.state.records, original!.state.records); }
  else assert.deepEqual(saved, original);
  assert.deepEqual(adapter.snapshot(), accepted); assert.equal(adapter.stagedSnapshot(), null);
});

test("whole protected group retains old state and acceptance on retry, then replays original order/time", async () => {
  const w = await world(), state = new MemoryMachineState();
  const order = ["10", "2", "__proto__", "constructor", "toString", "é", "e\u0301"];
  for (const id of order) {
    const target = sourceTargetId({ ...idInput, externalId: id });
    await w.backend.write(target, { id: target, frontmatter: { type: "Ticket", title: "A", state: "open", priority: "low", sources: [{ resource: FEED_URL, id }] }, body: "Editor notes" });
  }
  const initial = await w.adapter();
  const adopted = await observeTargets(w, initial, targetState(state, initial), order.map(id => ticket(id, "A")));
  assert.equal(adopted.outcome, "observed", adopted.detail);
  const old = (await state.read(FEED_ID))!.state, accepted = initial.snapshot();
  let failing = true, effects = 0;
  const seen: string[] = [], planned: string[] = [];
  const write = w.backend.write.bind(w.backend);
  w.backend.write = async (...args) => {
    effects++;
    if (failing && args[0] === sourceTargetId({ ...idInput, externalId: "2" })) throw new VersionConflict(args[0], null, null);
    return write(...args);
  };
  async function fresh() {
    return w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
      actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted,
      hooks: { correlate: { kind: "Ticket", match(_fields, frontmatter, id) {
        if ((frontmatter.sources as Array<{ id: string }>)[0]!.id === order[0]) planned.push(id);
        return null;
      } }, assertCandidate(_existing, candidate, context) {
        const durable = state.read(FEED_ID);
        if (context.bundle === "ops") seen.push(candidate.frontmatter.observed_at as string);
        return durable.then(row => { assert.deepEqual(row!.state.pending_commit?.order, order); });
      } } } });
  }
  let acquired = 0;
  const originalAt = "2026-10-25T12:00:00.000Z", a = await fresh();
  const held = await observeTargets(w, a, targetState(state, a), order.map(id => ticket(id, "B")), { at: originalAt, more: true, acquired: () => acquired++ });
  assert.equal(held.reason, "establishment_pending", held.detail); assert.equal(acquired, 1);
  const checkpoint = await state.read(FEED_ID), pending = checkpoint!.state;
  assert.deepEqual(pending.pending_commit, { v: 1, order, page: 1, baseline: false, complete: false });
  assert.deepEqual(pending.records, old.records); assert.deepEqual(pending.cursor, old.cursor);
  assert.deepEqual(pending.validators, old.validators); assert.equal(pending.complete_observations, old.complete_observations);
  assert.deepEqual(a.snapshot(), accepted); assert.equal(a.stagedSnapshot(), null);
  assert.ok(effects >= 2, "a partial physical effect does not accept any record in the group");
  assert.ok(seen.length > 0 && seen.every(at => at === originalAt), "actual Signal effects use supplying observation time");
  for (let attempt = 0; attempt < 7; attempt++) {
    const b = await fresh();
    const receipt = await observeTargets(w, b, targetState(state, b), [], { at: "2027-01-01T00:00:00Z", acquired: () => assert.fail("unresolved group must not acquire") });
    assert.equal(receipt.reason, "establishment_pending", receipt.detail);
    assert.deepEqual(await state.read(FEED_ID), checkpoint); assert.deepEqual(b.snapshot(), accepted); assert.equal(b.stagedSnapshot(), null);
  }
  // Failures cannot advance the group or generate a newer observation. Actual document state
  // is allowed to contain the earlier partial writes, which replay meets as converged/no-op.
  failing = false; seen.length = 0; planned.length = 0;
  const b = await fresh(), controller = new AbortController();
  const recovered = await observeTargets(w, b, { read: state.read.bind(state), async write(...args) {
    const version = await state.write(...args); b.consume(); controller.abort(); return version;
  } }, [], { at: "2027-01-01T00:00:00Z", signal: controller.signal, acquired: () => assert.fail("recovery checkpoint aborts before acquisition") });
  assert.equal(recovered.reason, "deadline"); assert.equal(recovered.pages, 0); assert.equal(recovered.pass.complete, false);
  const after = (await state.read(FEED_ID))!.state;
  assert.equal(after.pending_commit, undefined); assert.equal(after.pending, undefined);
  assert.deepEqual(after.cursor, old.cursor); assert.deepEqual(after.validators, old.validators);
  assert.equal(after.complete_observations, old.complete_observations);
  assert.ok(seen.every(at => at === originalAt), "Signal replay cannot restamp a new observation time");
  assert.deepEqual(planned, order, "actual overlay planning preserves original numeric, special and Unicode identity order");
  assert.deepEqual(Object.keys(after.records).sort(), [...order].sort());
});

test("converged protected change acknowledges a real zero-effect stage", async () => {
  const w = await world(), state = new MemoryMachineState(), initial = await w.adapter();
  const record = (title: string) => { const { html_url: _url, ...row } = ticket("t1", title); return row; };
  await observeTargets(w, initial, targetState(state, initial), [record("A")]);
  const accepted = initial.snapshot(), id = accepted.entries[0]!.target, row = await w.backend.read(id);
  await w.backend.write(id, { ...row.doc, frontmatter: { ...row.doc.frontmatter, title: "B" } }, { expectedVersion: row.version });
  const adapter = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  let pending = 0, stages = 0, effects = 0;
  const write = w.backend.write.bind(w.backend);
  w.backend.write = async (...args) => { effects++; return write(...args); };
  const receipt = await observeTargets(w, adapter, { read: state.read.bind(state), async write(...args) {
    if (args[1].pending_commit) { pending++; assert.equal(adapter.stagedSnapshot(), null); }
    else { assert.ok(adapter.stagedSnapshot()); stages++; }
    const version = await state.write(...args); if (!args[1].pending_commit) adapter.consume(); return version;
  } }, [record("B")]);
  assert.equal(receipt.outcome, "observed", receipt.detail); assert.deepEqual({ pending, stages, effects }, { pending: 1, stages: 1, effects: 0 });
  assert.equal(adapter.snapshot().entries[0]!.after.title, "B");
});

test("old establishment checkpoints retain protection without inventing mixed page context", async () => {
  const w = await world(), state = new MemoryMachineState(), adapter = await w.adapter();
  w.unknown(true);
  assert.equal((await observeTargets(w, adapter, targetState(state, adapter), [ticket("t1", "A")])).reason, "commit_failed");
  const original = (await state.read(FEED_ID))!;
  const legacy = structuredClone(original.state); delete legacy.pending_commit;
  await state.write(FEED_ID, legacy, original.version);
  const checkpoint = await state.read(FEED_ID), recovered = await w.adapter();
  const controller = new AbortController();
  const result = await observeTargets(w, recovered, { read: state.read.bind(state), async write(...args) {
    const version = await state.write(...args); recovered.consume(); controller.abort(); return version;
  } }, [], { at: "2027-01-01T00:00:00Z", signal: controller.signal, acquired: () => assert.fail("must replay before provider") });
  assert.equal(result.reason, "deadline"); assert.equal((await state.read(FEED_ID))!.state.pending, undefined);
  for (const mix of ["group", "time", "ordinary"] as const) {
    const bad = structuredClone(checkpoint!.state), extra = structuredClone(bad.pending!.t1!);
    extra.change.external_id = "a";
    if (mix === "group") extra.establishment!.group = "different";
    if (mix === "time") extra.held_at = extra.establishment!.observed_at = extra.establishment!.intent!.createdAt = "2027-01-01T00:00:00Z";
    if (mix === "ordinary") delete extra.establishment;
    bad.pending!.a = extra;
    const store = new MemoryMachineState(); await store.write(FEED_ID, bad, null);
    const before = await store.read(FEED_ID), b = await w.adapter();
    const refused = await observeTargets(w, b, targetState(store, b), [], { acquired: () => assert.fail("mixed contexts must hold") });
    assert.equal(refused.reason, "establishment_scope_changed"); assert.deepEqual(await store.read(FEED_ID), before);
  }
});

test("protected accepted-target work survives gone records and profile reset without provider replacement", async () => {
  const w = await world(), state = new MemoryMachineState(), initial = await w.adapter();
  await observeTargets(w, initial, targetState(state, initial), [ticket("t1", "A")]);
  const accepted = initial.snapshot();
  // Each actual paired adapter gets a current Core index; no synthetic consumer is registered.
  const adapter = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  let effects = 0;
  w.backend.write = async () => { effects++; throw new Error("outcome unknown"); };
  const failed = await observeTargets(w, adapter, targetState(state, adapter), [ticket("t1", "B")]);
  assert.equal(failed.reason, "commit_failed");
  const checkpoint = (await state.read(FEED_ID))!, gone = structuredClone(checkpoint.state);
  gone.records.t1!.gone = true;
  await state.write(FEED_ID, gone, checkpoint.version);
  const original = await state.read(FEED_ID);
  const b = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  const before = effects;
  assert.equal((await observeTargets(w, b, targetState(state, b), [], { acquired: () => assert.fail("must not acquire while unknown") })).reason, "establishment_pending");
  assert.ok(effects > before, "protected changed work is not filtered by old gone state");
  assert.deepEqual(await state.read(FEED_ID), original);
  const count = effects;
  const receipt = await observeSource({ connector: w.connector, bound: w.bound, profile: { ...jsonPagesProfile, version: jsonPagesProfile.version + 1,
    async observe() { assert.fail("profile reset cannot replace protected work"); } }, spec: SPEC, identity: fetchIdentity("Synthetic/1 (+https://example.org)"),
    state, transport: { async request() { assert.fail("must not acquire"); } }, prepareCommit: b.prepareCommit, commit: b.commit });
  assert.equal(receipt.reason, "establishment_scope_changed"); assert.equal(effects, count); assert.deepEqual(await state.read(FEED_ID), original);
});

test("disappearance Signal keeps the complete supplying baseline protected until acknowledgment", async () => {
  const w = await world(), state = new MemoryMachineState(), initial = await w.adapter();
  await observeTargets(w, initial, targetState(state, initial), [ticket("t1", "A")], { mode: "complete" });
  const accepted = initial.snapshot();
  const adapter = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  await observeTargets(w, adapter, targetState(state, adapter), [], { mode: "complete" });
  const old = (await state.read(FEED_ID))!.state;
  let effects = 0;
  w.backend.write = async () => {
    const supplying = (await state.read(FEED_ID))!.state;
    assert.equal(supplying.pending!.t1!.change.change_kind, "disappeared");
    assert.equal(supplying.pending_commit!.complete, true);
    assert.deepEqual(supplying.records, old.records); assert.equal(supplying.complete_observations, old.complete_observations);
    effects++; throw new Error("Signal outcome unknown");
  };
  const receipt = await observeTargets(w, adapter, targetState(state, adapter), [], { mode: "complete" });
  assert.equal(receipt.reason, "commit_failed"); assert.equal(effects, 1);
  const saved = (await state.read(FEED_ID))!.state;
  assert.equal(saved.records.t1!.gone, undefined); assert.equal(saved.pending!.t1!.entry.gone, true);
  assert.equal(adapter.stagedSnapshot(), null); assert.deepEqual(adapter.snapshot(), accepted);
});

test("a permanent overlay hold retains the whole qualified group and discards its stage", async () => {
  const w = await world(), state = new MemoryMachineState(), initial = await w.adapter();
  await observeTargets(w, initial, targetState(state, initial), [ticket("t1", "A")]);
  const old = (await state.read(FEED_ID))!.state, accepted = initial.snapshot();
  const adapter = await w.adapter({ overlay: { content: { bundle: w.bundle, registry: w.registry, okfVersion: "0.2" }, policy: w.bound.policy,
    actor: "process:synthetic", overlays: await buildSourceIndex(w.bundle), accepted } });
  w.backend.write = async () => { throw new InvalidInputError("candidate refused"); };
  let acquisitions = 0;
  const receipt = await observeTargets(w, adapter, targetState(state, adapter), [ticket("t1", "B")], { more: true, acquired: () => acquisitions++ });
  assert.equal(receipt.reason, "establishment_pending"); assert.equal(acquisitions, 1);
  const saved = (await state.read(FEED_ID))!.state;
  assert.ok(saved.pending_commit); assert.deepEqual(saved.records, old.records); assert.deepEqual(saved.cursor, old.cursor);
  assert.deepEqual(adapter.snapshot(), accepted); assert.equal(adapter.stagedSnapshot(), null);
});
