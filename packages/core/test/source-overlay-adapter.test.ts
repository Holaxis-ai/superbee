import test from "node:test";
import assert from "node:assert/strict";
import { buildSourceIndex } from "../src/record-overlay/source-index.js";
import { createSourceOverlayAdapter, isSourceOverlaySnapshot, type SourceOverlaySnapshot } from "../src/source-engine/overlay.js";
import type { SourceState } from "../src/source-engine/machine-state.js";
import type { PageCommit } from "../src/source-engine/types.js";
import { ACTOR, event, FEED, overlayWorld, PROVIDER, signalConvention, UID } from "./record-overlay-helpers.js";
const AT = "2026-10-19T12:00:00Z";
const A = { start: "2026-10-20T12:00:00Z", venue_text: "A" };
const B = { ...A, venue_text: "B" };
function state(fields = A): SourceState {
  return { v: 1, profile: { id: "synthetic", version: 1 }, cursor: null, open: false, complete_observations: 1,
    records: { [UID("1")]: { after: fields, digest: "sha256:fixture", missing: 0, seen_at: AT } } };
}
function page(fields = B): PageCommit {
  return { feed: FEED, provider: PROVIDER, observed_at: AT, page: 1, replay: false, baseline: false, complete: true,
    records: {}, changes: [{ external_id: UID("1"), change_kind: "changed", before: A, after: fields,
      changed_fields: ["venue_text"], content_digest: "sha256:fixture" }] };
}
async function adapter(w: Awaited<ReturnType<typeof overlayWorld>>, accepted?: SourceOverlaySnapshot) {
  return createSourceOverlayAdapter({ content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR,
    overlays: await buildSourceIndex(w.content.bundle), accepted });
}
async function adopted() {
  const w = await overlayWorld();
  await w.put("events/one", event("1", { title: "Human", start: A.start }));
  return w;
}
test("cached adoption fills once and relink has an independent tuple", async () => {
  const w = await adopted(); const a = await adapter(w);
  await a.reconcile(state(), AT);
  assert.equal(a.snapshot().entries.length, 0); assert.equal(a.stagedSnapshot()!.entries.length, 1); a.consume();
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "A");
  const version = (await w.read("events/one")).version;
  await a.reconcile(state(), AT); a.consume(); assert.equal((await w.read("events/one")).version, version);
  await w.contentBackend.delete("events/one");
  await w.put("events/two", event("1", { title: "Other human", start: A.start }));
  const relink = await adapter(w, a.snapshot()); assert.equal(relink.snapshot().entries.length, 0);
  await relink.reconcile(state(), AT); relink.consume();
  assert.equal(relink.snapshot().entries[0]!.target, "events/two");
  assert.equal((await w.read("events/two")).doc.frontmatter.venue_text, "A");
});
test("crash before and after joint publication cannot pair accepted B with observed A", async () => {
  const w = await adopted(); const a = await adapter(w); await a.reconcile(state(), AT); a.consume();
  const durable = a.snapshot(); await a.commit(page());
  assert.equal(a.snapshot().entries[0]!.after.venue_text, "A"); assert.equal(a.stagedSnapshot()!.entries[0]!.after.venue_text, "B");
  await assert.rejects(a.applyFindings([], AT), /awaits publication/); a.discard();
  const restarted = await adapter(w, durable); await restarted.reconcile(state(), AT); restarted.consume();
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "B");
  await restarted.commit(page());
  const jointlyPublished = { observed: state(B), accepted: restarted.stagedSnapshot()! }; restarted.consume();
  const afterCrash = await adapter(w, jointlyPublished.accepted); await afterCrash.reconcile(jointlyPublished.observed, AT); afterCrash.consume();
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "B");
});
test("pending owns replay and older cached records are skipped", async () => {
  const w = await adopted(); const a = await adapter(w); const s = state();
  s.pending = { [UID("1")]: { change: page().changes[0]!, entry: state(B).records[UID("1")]!, held_at: AT } };
  const reconciled = await a.reconcile(s, AT); a.consume(); assert.deepEqual(reconciled.changes, []);
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, undefined);
  await a.commit({ ...page(), page: 0, replay: true }); a.consume();
  assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "B");
});
test("HOLD_STORE candidate needs fresh observation and cannot replay from cached 304", async () => {
  const w = await adopted(); const a = await adapter(w); await a.reconcile(state(), AT); a.consume();
  const held = await a.commit(page({ ...B, start: "invalid" })); assert.deepEqual(held.hold, [UID("1")]); a.consume();
  assert.equal(a.snapshot().entries[0]!.after.venue_text, "A");
  await a.reconcile(state(), AT); a.consume(); assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "A");
  await a.commit(page()); a.consume(); assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "B");
});
test("human conflict advances acceptance but stale and duplicate identity do not", async () => {
  const w = await adopted(); const a = await adapter(w); await a.reconcile(state(), AT); a.consume();
  await w.edit("events/one", { venue_text: "Human" }); const fresh = await adapter(w, a.snapshot());
  const partial = await fresh.commit(page()); fresh.consume();
  assert.ok(partial.receipt.refusals.some(r => r.code === "OVERLAY_DOC_CONFLICT"));
  assert.equal(fresh.snapshot().entries[0]!.after.venue_text, "B"); assert.equal((await w.read("events/one")).doc.frontmatter.venue_text, "Human");
  const staleWorld = await adopted(); const stale = await adapter(staleWorld); await staleWorld.edit("events/one", { title: "Changed" });
  const refused = await stale.commit(page()); stale.consume(); assert.ok(refused.receipt.results.some(r => r.code === "STALE_VERSION")); assert.equal(stale.snapshot().entries.length, 0);
  await w.put("events/two", event("1", { title: "Duplicate", start: A.start }));
  const ambiguous = await adapter(w); const dup = await ambiguous.reconcile(state(), AT); ambiguous.consume();
  assert.ok(dup.receipt.refusals.some(r => r.code === "OVERLAY_IDENTITY_AMBIGUOUS")); assert.equal(ambiguous.snapshot().entries.length, 0);
});
test("persisted snapshot validation rejects duplicate tuples and snapshots cannot alias state", async () => {
  const w = await adopted(); const a = await adapter(w); await a.reconcile(state(), AT); a.consume();
  const saved = a.snapshot(); saved.entries[0]!.after.venue_text = "Mutated";
  assert.equal(a.snapshot().entries[0]!.after.venue_text, "A");
  assert.equal(isSourceOverlaySnapshot({ v: 1, entries: [...saved.entries, ...saved.entries] }), false);
});

for (const declaredLink of [false, true]) test(`adapter carries actual feed Kind through change and finding Signal owners (declared link ${declaredLink})`, async () => {
  const w = await overlayWorld({ feed: { type: "Reference" },
    signal: signalConvention("superbee_progress_status", declaredLink ? { links: { "from snapshot": "Reference" } } : {}) });
  const a = createSourceOverlayAdapter({ content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR,
    overlays: await buildSourceIndex(w.content.bundle), signals: { feedKind: "Reference" } });
  const change = { external_id: UID("1"), change_kind: "disappeared", before: A, after: null,
    changed_fields: [], content_digest: "sha256:fixture", missing_count: 2, first_missing_at: AT };
  const committed = await a.commit({ ...page(), changes: [change] });
  a.consume();
  const findings = await a.applyFindings([{ key: "snapshot-input", title: "Input review", facts: { observed: true } }], AT);
  for (const receipt of [committed.receipt, findings]) {
    assert.deepEqual(receipt.refusals, []);
    assert.ok(receipt.results.some(row => row.outcome === "applied"));
    assert.ok(receipt.results.every(row => row.outcome !== "refused"));
  }
  const ids = (await w.opsBackend.list()).filter(id => id.startsWith("signals/"));
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const body = (await w.read(id, "ops")).doc.body;
    assert.equal(body.includes("[from feed]"), false);
    assert.equal(body.includes("[from snapshot]"), declaredLink);
    if (declaredLink) assert.ok(body.includes("../source-feeds/synthetic-library.md"));
  }
});
