import test from "node:test";
import assert from "node:assert/strict";
import { bindSnapshotSource, decodeSnapshot, admitSnapshot, observeSnapshot, MemoryMachineState, SnapshotRefusal,
  type SnapshotAdmissionOptions, type BoundSnapshotSource, type DecodedSnapshot, type SourceState, type SnapshotCapacityInput, type PageCommit, type CommitResult } from "../src/source-engine/index.js";
import { buildKindRegistry } from "../src/kinds.js";
import { SourceIndex, buildSourceIndex, readOverlayPolicyForResource, decideChange } from "../src/record-overlay/index.js";
import { createSourceOverlayAdapter, type SourceOverlaySnapshot } from "../src/source-engine/overlay.js";
import { overlayWorld, ACTOR, FEED } from "./record-overlay-helpers.js";
import { blobVersion } from "../src/versioning.js";
import type { Frontmatter, OkfDocument } from "../src/types.js";

const RESOURCE = "urn:example:results", AT = "2026-10-20T12:00:00.000Z";
const CONVENTION: OkfDocument = { id: "conventions/result", body: "", frontmatter: { type: "Convention", title: "Result", governs: "Result", path: "results/",
  fields: { required: ["title"], optional: ["score", "labels", "note", "phase"], types: { score: "number", labels: "string-list" }, values: { phase: ["good", "bad"] } } } };
const registry = buildKindRegistry([CONVENTION], [], { okfVersion: "0.2" });
const declaration = (patch: Record<string, unknown> = {}): { id: string; frontmatter: Frontmatter } => ({ id: "snapshots/benchmark", frontmatter: {
  type: "Reference", title: "Benchmark snapshot", resource: RESOURCE, target_kind: "Result", identity: { id: "{key}" },
  fields: { title: "result.label", score: "result.score", labels: "result.labels", phase: { from: "result.phase", values: { OK: "good", FAIL: "bad" } } },
  owned_fields: ["title", "score", "labels", "phase"], auto_apply: ["new", "changed"], needs_review: ["disappeared"], completeness: "partial", ...patch,
} as unknown as Frontmatter });
const bind = (patch: Record<string, unknown> = {}): BoundSnapshotSource => bindSnapshotSource(declaration(patch), registry, { okfVersion: "0.2" });
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const input = (generation = 1, records: unknown[] = [{ key: "stable-1", result: { label: "A", score: 1, labels: ["b", "a", "a"], phase: "OK" } }], patch: Record<string, unknown> = {}): DecodedSnapshot =>
  decodeSnapshot(encode({ v: 1, resource: RESOURCE, generation, complete: false, records, ...patch }));
const capacity = (patch: Partial<SnapshotCapacityInput> = {}): SnapshotCapacityInput => ({ accepted: { v: 1, entries: [] }, overlays: SourceIndex.fromHeads([]), envelopeOverheadBytes: 1024, maxEnvelopeBytes: 4 * 1024 * 1024, ...patch });
const options = (patch: Partial<SnapshotAdmissionOptions> = {}): SnapshotAdmissionOptions => ({ bound: bind(), snapshot: input(), state: null, previousBindingDigest: null, capacity: capacity(), ...patch });
const code = (expected: string) => (e: unknown): boolean => e instanceof SnapshotRefusal && e.code === expected;
const run = (bound: BoundSnapshotSource, snapshot: DecodedSnapshot, state: MemoryMachineState, commit: (p: PageCommit) => Promise<CommitResult | void> = async () => {}) =>
  observeSnapshot({ bound, snapshot, state, previousBindingDigest: bound.bindingDigest, capacity: capacity(), now: () => new Date(AT), commit });

test("ordinary declaration reuses mapping/Kind/policy checks and explicit resource coordinate", () => {
  const b = bind(); assert.equal(b.resource, RESOURCE); assert.equal(b.policy.provider, RESOURCE); assert.equal(b.source.identity.id, "{key}");
  assert.equal(readOverlayPolicyForResource(declaration(), RESOURCE, { targetKind: b.kind }).provider, RESOURCE);
  for (const patch of [{ resource: "/tmp/a" }, { resource: "https://example.org/data" }, { url: "https://example.org" }, { completeness: "complete" },
    { fields: { title: "key" } }, { fields: { score: { from: "a", surprise: true } } }, { fields: { missing: "x" } }, { fields: { body: "x" } },
    { fields: { phase: "phase" } }, { fields: { labels: { from: "x", values: { a: "b" } } } }, { owned_fields: ["note"] }]) {
    assert.throws(() => bind(patch), code("SNAPSHOT_DECLARATION_INVALID"), JSON.stringify(patch));
  }
  assert.throws(() => bindSnapshotSource(declaration(), registry), code("SNAPSHOT_DECLARATION_INVALID"));
  assert.notEqual(bind({ missing_threshold: 3 }).bindingDigest, b.bindingDigest);
});

test("decoder bounds exact bytes, finite JSON, depth and closed envelope/evidence", () => {
  const ordinary = input(); assert.equal(ordinary.sha256, blobVersion(ordinary.bytes));
  const bom = decodeSnapshot(new Uint8Array([239, 187, 191, ...ordinary.bytes]));
  assert.equal(bom.sha256, blobVersion(bom.bytes)); assert.notEqual(bom.sha256, ordinary.sha256); assert.deepEqual(bom.data, ordinary.data);
  const newline = decodeSnapshot(new Uint8Array([...ordinary.bytes, 10])); assert.notEqual(newline.sha256, ordinary.sha256);
  assert.throws(() => decodeSnapshot(new Uint8Array(2 * 1024 * 1024 + 1)), code("SNAPSHOT_TOO_LARGE"));
  assert.throws(() => decodeSnapshot(new Uint8Array([255])), code("SNAPSHOT_INPUT_INVALID"));
  for (const patch of [{ executable: "x" }, { v: 2 }, { generation: 0 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { records: [null] },
    { records: new Array(10_001).fill({ key: "x" }) }, { diagnostics: [{ code: "A", message: "x", path: "private" }] }, { diagnostics: [{ code: "A", message: "x".repeat(513) }] }]) {
    assert.throws(() => input(1, [], patch), code("SNAPSHOT_INPUT_INVALID"));
  }
  let deep: unknown = 0; for (let i = 0; i < 33; i++) deep = { x: deep };
  assert.throws(() => input(1, [{ key: "x", deep }]), code("SNAPSHOT_INPUT_INVALID"));
  assert.throws(() => decodeSnapshot(new TextEncoder().encode('{"v":1,"resource":"urn:example:r","generation":1,"complete":false,"records":[{"key":"x","x":1e999}]}')), code("SNAPSHOT_INPUT_INVALID"));
  assert.throws(() => input(1, [], { evidence: { v: 2 } }), { code: "SNAPSHOT_EVIDENCE_INVALID" });
});

test("admission refuses all invalid and duplicate rendered identities before any write", async () => {
  const b = bind(), state = new MemoryMachineState(); let commits = 0;
  for (const records of [[{ key: "x" }, { key: "x" }], [{ key: "" }], [{}], [{ key: true }], [{ key: "x".repeat(2049) }], [{ key: "__proto__" }], [{ key: "constructor" }], [{ key: "prototype" }], [{ key: "a\nb" }]]) {
    await assert.rejects(run(b, input(1, records), state, async () => { commits++; }), code(records.length === 2 ? "SNAPSHOT_IDENTITY_DUPLICATE" : "SNAPSHOT_IDENTITY_INVALID"));
  }
  assert.equal(commits, 0); assert.deepEqual(state.keys(), []);
});

test("generation rollback/collision, exact replay and new-A use one checkpoint without fresh replay clocks", async () => {
  const bound = bind({ completeness: "complete", scope: "all-results" }), state = new MemoryMachineState(), commits: PageCommit[] = [];
  const a = input(7, undefined, { complete: true, scope: "all-results" });
  const record = async (p: PageCommit) => { commits.push(p); };
  await run(bound, a, state, record);
  const first = (await state.read(bound.policy.feed))!;
  assert.deepEqual(first.state.cursor, { v: 1, generation: 7, sha256: a.sha256 });
  const replay = await run(bound, a, state, record);
  assert.equal(replay.observation, "replay"); assert.equal(replay.pages, 0); assert.equal(replay.pass.complete, false);
  assert.deepEqual(await state.read(bound.policy.feed), first); assert.equal(commits.length, 1);
  await assert.rejects(run(bound, input(6), state, record), code("SNAPSHOT_GENERATION_ROLLBACK"));
  await assert.rejects(run(bound, decodeSnapshot(new Uint8Array([...a.bytes, 10])), state, record), code("SNAPSHOT_GENERATION_COLLISION"));
  assert.deepEqual(await state.read(bound.policy.feed), first); assert.equal(commits.length, 1);
  await run(bound, input(8, [{ key: "stable-1", result: { label: "B", score: 2 } }]), state, record);
  const newA = await run(bound, input(9, undefined, { complete: true, scope: "all-results" }), state, record);
  assert.equal(newA.observation, "new"); assert.equal(newA.pages, 1); assert.equal(newA.changes.changed, 1);
  assert.equal((await state.read(bound.policy.feed))!.state.complete_observations, 2);
});

test("changed binding, malformed checkpoint and wrong profile refuse before pending replay", async () => {
  const bound = bind(), state = new MemoryMachineState(); await run(bound, input(), state);
  const original = (await state.read(bound.policy.feed))!.state;
  const changed = bind({ owned_fields: ["title"] }); let commits = 0;
  await assert.rejects(observeSnapshot({ bound: changed, snapshot: input(2), state, previousBindingDigest: bound.bindingDigest, capacity: capacity(), commit: async () => { commits++; } }), code("SNAPSHOT_BINDING_CHANGED"));
  for (const patch of [{ profile: { id: "https-json", version: 1 } }, { profile: { id: "local-snapshot", version: 2 } }, { cursor: null }, { open: true },
    { cursor: { v: 1, generation: 1, sha256: input().sha256, extra: true } }]) {
    const bad = { ...original, ...patch } as SourceState;
    assert.throws(() => admitSnapshot(options({ state: bad, previousBindingDigest: bound.bindingDigest })), code("SNAPSHOT_STATE_INVALID"));
  }
  assert.equal(commits, 0);
});

test("complete scope and partial snapshots preserve missing semantics and unmappable present IDs", async () => {
  const bound = bind({ completeness: "complete", scope: "all-results", missing_threshold: 2 }), state = new MemoryMachineState();
  for (const snapshot of [input(1, [], { complete: true }), input(1, [], { complete: true, scope: "selected" })]) {
    await assert.rejects(run(bound, snapshot, state), code("SNAPSHOT_SCOPE_MISMATCH"));
  }
  await assert.rejects(run(bind(), input(1, [], { complete: true, scope: "all-results" }), state), code("SNAPSHOT_SCOPE_MISMATCH"));
  const all = (generation: number, records: unknown[]) => input(generation, records, { complete: true, scope: "all-results" });
  await run(bound, all(1, [{ key: "stable-1", result: { label: "A" } }]), state);
  await run(bound, input(2, []), state); assert.equal((await state.read(bound.policy.feed))!.state.records["stable-1"]!.missing, 0);
  const empty = all(3, []); await run(bound, empty, state); await run(bound, empty, state);
  assert.equal((await state.read(bound.policy.feed))!.state.records["stable-1"]!.missing, 1);
  const disappeared = await run(bound, all(4, []), state); assert.equal(disappeared.changes.disappeared, 1);
  assert.equal((await state.read(bound.policy.feed))!.state.records["stable-1"]!.gone, true);
  const refusingBound = bind({ completeness: "complete", scope: "all-results", fields: { title: "result.label", phase: { from: "result.phase", values: { OK: "good" }, unmapped: "refuse" } }, owned_fields: ["title", "phase"] });
  const otherState = new MemoryMachineState(); await run(refusingBound, all(1, [{ key: "x", result: { label: "A", phase: "OK" } }]), otherState);
  await run(refusingBound, all(2, [{ key: "x", result: { phase: "UNKNOWN" } }]), otherState);
  assert.equal((await otherState.read(refusingBound.policy.feed))!.state.records.x!.missing, 0);
});

test("mapping keeps absent and bad values, clears optional null and canonicalizes whole lists", async () => {
  const bound = bind(), state = new MemoryMachineState(); const pages: PageCommit[] = [];
  const commit = async (p: PageCommit) => { pages.push(p); };
  await run(bound, input(), state, commit);
  assert.deepEqual((await state.read(bound.policy.feed))!.state.records["stable-1"]!.after.labels, ["a", "b"]);
  await run(bound, input(2, [{ key: "stable-1", result: { label: "Renamed", score: null, labels: null } }]), state, commit);
  const change = pages[1]!.changes[0]!; assert.equal(change.external_id, "stable-1"); assert.equal(change.after!.score, undefined); assert.deepEqual(change.after!.labels, []);
  await run(bound, input(3, [{ key: "stable-1", result: { label: {}, labels: [1] } }]), state, commit);
  assert.equal((await state.read(bound.policy.feed))!.state.records["stable-1"]!.after.title, "Renamed");
  const decision = decideChange(bound.policy, { ...change, before: { title: "A" }, after: { title: "Renamed" }, changed_fields: ["title"] }, { overlay: { frontmatter: { title: "Human", note: "measurement" } } });
  assert.equal(decision.conflicts.length, 1); assert.deepEqual(decision.apply, {});
});

test("replay retries pending but permanent hold creates no pending and new page stays absent", async () => {
  const b = bind(), state = new MemoryMachineState(), snapshot = input(); let calls = 0;
  await run(b, snapshot, state, async () => { calls++; return { retry: ["stable-1"] }; });
  assert.equal(Object.keys((await state.read(b.policy.feed))!.state.pending!).length, 1);
  const replay = await run(b, snapshot, state, async p => { calls++; assert.equal(p.page, 0); assert.equal(p.replay, true); });
  assert.equal(replay.pages, 0); assert.equal(calls, 2); assert.equal((await state.read(b.policy.feed))!.state.pending, undefined);
  assert.equal((await state.read(b.policy.feed))!.state.records["stable-1"]!.after.title, "A");
  const heldState = new MemoryMachineState(); await run(b, snapshot, heldState, async () => ({ hold: ["stable-1"] }));
  const held = await run(b, snapshot, heldState, async () => { throw new Error("must not replay permanent hold"); });
  assert.equal(held.pages, 0); assert.equal((await heldState.read(b.policy.feed))!.state.pending, undefined);
});

test("failed state publication stops before a later phase and retains old checkpoint for convergence", async () => {
  const b = bind(), state = new MemoryMachineState(); await run(b, input(), state);
  const old = await state.read(b.policy.feed); let commits = 0, writes = 0;
  const receipt = await observeSnapshot({ bound: b, snapshot: input(2), previousBindingDigest: b.bindingDigest, capacity: capacity(),
    state: { read: k => state.read(k), write: async () => { writes++; throw new Error("publication failed"); } },
    commit: async () => { commits++; }, now: () => new Date(AT) });
  assert.equal(receipt.outcome, "failed"); assert.equal(receipt.reason, "state_unwritable"); assert.equal(receipt.pages, 0);
  assert.equal(commits, 1); assert.equal(writes, 1); assert.deepEqual(await state.read(b.policy.feed), old);
});

test("derived decode fields cannot substitute different input bytes", () => {
  const decoded = input(); decoded.data.resource = "urn:example:other"; decoded.data.generation = 999; decoded.sha256 = "forged";
  const admitted = admitSnapshot(options({ snapshot: decoded })); assert.equal(admitted.generation, 1); assert.equal(admitted.sha256, blobVersion(decoded.bytes));
});

test("capacity counts mapping fanout, retry duplication and accumulated partial IDs before commit", async () => {
  const huge = "x".repeat(1_100_000), snapshot = input(1, [{ key: "x", result: { label: huge } }]);
  assert.ok(snapshot.byteLength < 2 * 1024 * 1024);
  const bound = bind({ fields: { title: "result.label", note: "result.label", score: "result.label" }, owned_fields: ["title", "note", "score"] });
  const state = new MemoryMachineState(); let commits = 0;
  await assert.rejects(run(bound, snapshot, state, async () => { commits++; }), code("SNAPSHOT_CAPACITY_EXCEEDED"));
  assert.equal(commits, 0); assert.deepEqual(state.keys(), []);
  // One large field alone fits the snapshot, but not before/after/entry plus record duplication.
  assert.throws(() => admitSnapshot(options({ snapshot })), code("SNAPSHOT_CAPACITY_EXCEEDED"));
  const b = bind(); await run(b, input(), state);
  const stored = (await state.read(b.policy.feed))!.state;
  const many = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`old-${i}`, { after: {}, digest: stored.records["stable-1"]!.digest, missing: 0, seen_at: AT }]));
  const cumulative = { ...stored, records: many };
  assert.throws(() => admitSnapshot(options({ state: cumulative, previousBindingDigest: b.bindingDigest })), code("SNAPSHOT_CAPACITY_EXCEEDED"));
  const ordinary = options(); const facts = admitSnapshot(ordinary).capacity;
  assert.throws(() => admitSnapshot({ ...ordinary, capacity: capacity({ maxEnvelopeBytes: facts.upperBoundBytes - 1 }) }), code("SNAPSHOT_CAPACITY_EXCEEDED"));
  assert.equal(admitSnapshot({ ...ordinary, capacity: capacity({ maxEnvelopeBytes: facts.upperBoundBytes }) }).capacity.upperBoundBytes, facts.upperBoundBytes);
});

test("accepted tuples and fresh target candidate growth are budgeted even on replay reconciliation", async () => {
  const b = bind(), state = new MemoryMachineState(); await run(b, input(), state); const stored = (await state.read(b.policy.feed))!.state;
  const accepted: SourceOverlaySnapshot = { v: 1, entries: [{ feed: b.policy.feed, resource: RESOURCE, external_id: "stable-1", target: "results/old", after: { title: "x".repeat(300_000) } }] };
  const overlays = SourceIndex.fromHeads([{ id: "results/new", version: "sha256:x", frontmatter: { type: "Result", title: "Human", sources: [{ resource: RESOURCE, id: "stable-1" }] } }]);
  const facts = admitSnapshot(options({ state: stored, previousBindingDigest: b.bindingDigest, capacity: capacity({ accepted, overlays, maxEnvelopeBytes: 20_000_000 }) })).capacity;
  assert.equal(facts.acceptedTuples, 2); assert.ok(facts.upperBoundBytes > 1_800_000);
  assert.throws(() => admitSnapshot(options({ state: stored, previousBindingDigest: b.bindingDigest, capacity: capacity({ accepted, overlays, maxEnvelopeBytes: 1_800_000 }) })), code("SNAPSHOT_CAPACITY_EXCEEDED"));
});

test("existing adapter links new target, preserves human fields and publishes accepted tuples with observation", async () => {
  const w = await overlayWorld(); const resource = "urn:example:events";
  const b = bindSnapshotSource({ id: FEED, frontmatter: { type: "Reference", title: "Snapshot", resource, target_kind: "Event", identity: { id: "{key}" },
    fields: { venue_text: "location", start: "start" }, owned_fields: ["venue_text", "start"], auto_apply: ["new", "changed"], needs_review: [], completeness: "partial" } as unknown as Frontmatter }, w.content.registry, { okfVersion: "0.2" });
  const state = new MemoryMachineState(); let accepted: SourceOverlaySnapshot = { v: 1, entries: [] };
  async function apply(generation: number, location: string) {
    const snapshot = decodeSnapshot(encode({ v: 1, resource, generation, complete: false, records: [{ key: "one", location, start: AT }] }));
    const overlays = await buildSourceIndex(w.content.bundle), cap = capacity({ accepted, overlays });
    const adapter = createSourceOverlayAdapter({ content: w.content, ops: w.ops, policy: b.policy, actor: ACTOR, overlays, accepted });
    const stored = await state.read(FEED);
    const gate = admitSnapshot({ bound: b, snapshot, state: stored?.state ?? null, previousBindingDigest: b.bindingDigest, capacity: cap });
    cap.maxEnvelopeBytes = gate.capacity.upperBoundBytes;
    if (stored) { await adapter.reconcile(stored.state, AT); accepted = adapter.stagedSnapshot()!; adapter.consume(); }
    const receipt = await observeSnapshot({ bound: b, snapshot, previousBindingDigest: b.bindingDigest, capacity: cap, now: () => new Date(AT),
      state: { read: k => state.read(k), write: async (k, next, expected) => { const version = await state.write(k, next, expected); accepted = adapter.stagedSnapshot() ?? adapter.snapshot(); adapter.consume(); return version; } }, commit: adapter.commit });
    assert.equal(receipt.outcome, "observed"); assert.equal(receipt.capacity.upperBoundBytes, gate.capacity.upperBoundBytes);
    assert.ok(encode({ observation: (await state.read(FEED))!.state, accepted }).byteLength + cap.envelopeOverheadBytes < gate.capacity.upperBoundBytes);
    return receipt;
  }
  await apply(1, "A"); assert.equal((await w.content.bundle.backend.list()).filter(id => id.startsWith("events/")).length, 0);
  await w.put("events/one", { type: "Event", title: "Human title", note: "Human measurement", sources: [{ resource, id: "one" }] }, "Human conclusion.");
  await apply(2, "B"); let target = (await w.read("events/one")).doc;
  assert.equal(target.frontmatter.venue_text, "B"); assert.equal(target.frontmatter.note, "Human measurement"); assert.equal(target.body, "Human conclusion.\n"); assert.equal(accepted.entries.length, 1);
  await w.edit("events/one", { venue_text: "Human edit" }); await apply(3, "C"); target = (await w.read("events/one")).doc;
  assert.equal(target.frontmatter.venue_text, "Human edit"); assert.equal(target.frontmatter.title, "Human title");
});

test("malformed pending data, resource mismatch and pending-capacity overflow refuse before commit", async () => {
  const b = bind(), state = new MemoryMachineState(); await run(b, input(), state, async () => ({ retry: ["stable-1"] }));
  const stored = (await state.read(b.policy.feed))!.state;
  const malformed = structuredClone(stored); (malformed.pending!["stable-1"]!.change as unknown as Record<string, unknown>).changed_fields = null;
  let commits = 0;
  await assert.rejects(observeSnapshot({ bound: b, snapshot: input(), previousBindingDigest: b.bindingDigest, capacity: capacity(),
    state: { read: async () => ({ state: malformed, version: "1" }), write: async () => { throw new Error("must not write"); } },
    commit: async () => { commits++; } }), code("SNAPSHOT_STATE_INVALID"));
  await assert.rejects(run(b, input(2, [], { resource: "urn:example:other" }), state, async () => { commits++; }), code("SNAPSHOT_RESOURCE_MISMATCH"));
  await assert.rejects(observeSnapshot({ bound: b, snapshot: input(), previousBindingDigest: b.bindingDigest, capacity: capacity({ maxEnvelopeBytes: 1 }), state,
    commit: async () => { commits++; } }), code("SNAPSHOT_CAPACITY_EXCEEDED"));
  assert.equal(commits, 0); assert.deepEqual((await state.read(b.policy.feed))!.state, stored);
});

test("snapshot publication failure discards staged tuples; the same generation converges after target writes", async () => {
  const w = await overlayWorld(), resource = "urn:example:recovery";
  await w.put("events/one", { type: "Event", title: "Human", start: AT, sources: [{ resource, id: "one" }] });
  const b = bindSnapshotSource({ id: FEED, frontmatter: { type: "Reference", title: "Snapshot", resource, target_kind: "Event", identity: { id: "{key}" },
    fields: { venue_text: "location" }, owned_fields: ["venue_text"], auto_apply: ["new", "changed"], needs_review: [], completeness: "partial" } as unknown as Frontmatter }, w.content.registry, { okfVersion: "0.2" });
  const snapshot = decodeSnapshot(encode({ v: 1, resource, generation: 5, complete: false, records: [{ key: "one", location: "Observed" }] }));
  const state = new MemoryMachineState(); let accepted: SourceOverlaySnapshot = { v: 1, entries: [] };
  async function attempt(fail: boolean) {
    const overlays = await buildSourceIndex(w.content.bundle);
    const adapter = createSourceOverlayAdapter({ content: w.content, ops: w.ops, policy: b.policy, actor: ACTOR, overlays, accepted });
    const receipt = await observeSnapshot({ bound: b, snapshot, previousBindingDigest: b.bindingDigest, capacity: capacity({ accepted, overlays }), now: () => new Date(AT),
      commit: adapter.commit, state: { read: key => state.read(key), write: async (key, next, expected) => {
        if (fail) { adapter.discard(); throw new Error("publication unavailable"); }
        const version = await state.write(key, next, expected); accepted = adapter.stagedSnapshot() ?? adapter.snapshot(); adapter.consume(); return version;
      } } });
    assert.equal(adapter.stagedSnapshot(), null); return receipt;
  }
  const failed = await attempt(true); assert.equal(failed.outcome, "failed"); assert.equal(failed.reason, "state_unwritable");
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "Observed"); assert.equal(accepted.entries.length, 0); assert.equal(await state.read(FEED), null);
  const recovered = await attempt(false); assert.equal(recovered.outcome, "observed"); assert.equal(recovered.observation, "new");
  assert.equal(accepted.entries.length, 1); assert.deepEqual((await state.read(FEED))!.state.cursor, { v: 1, generation: 5, sha256: snapshot.sha256 });
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "Observed");
});


test("snapshot consumer cannot erase protected establishment replay through an ordinary commit", async () => {
  const bound = bind(), state = new MemoryMachineState();
  await run(bound, input(), state);
  const stored = (await state.read(bound.policy.feed))!;
  const entry = stored.state.records["stable-1"]!;
  stored.state.pending = { "stable-1": { entry: structuredClone(entry), held_at: AT,
    change: { external_id: "stable-1", change_kind: "changed", before: null, after: entry.after, changed_fields: Object.keys(entry.after), content_digest: entry.digest },
    establishment: { contract: 1, generation: "original", group: "original-group", target: "results/one", kind: "adopt", expectedVersion: "approved", observed_at: AT } } };
  await state.write(bound.policy.feed, stored.state, stored.version);
  const checkpoint = await state.read(bound.policy.feed); let commits = 0, writes = 0;
  const receipt = await observeSnapshot({ bound, snapshot: input(), previousBindingDigest: bound.bindingDigest, capacity: capacity(),
    state: { read: state.read.bind(state), async write(...args) { writes++; return state.write(...args); } }, commit: async () => { commits++; } });
  assert.equal(receipt.reason, "establishment_consumer_required"); assert.equal(commits, 0); assert.equal(writes, 0);
  assert.deepEqual(await state.read(bound.policy.feed), checkpoint);
});
