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
