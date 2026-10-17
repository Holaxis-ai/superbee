/**
 * The per-run `sources[]` identity index: grouping by the shared identity rule, `replace` after a
 * write, a stale index caught at write time, two feeds sharing one index, and the recorded residual
 * (a second claimant added mid-run is refused on the next run, not this one).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { HeadResult, OkfDocument } from "../src/types.js";
import {
  applyRecordOverlay,
  buildSourceIndex,
  planRecordOverlay,
  readOverlayPolicy,
  SourceIndex,
  type OverlayPlan,
  type OverlayPolicy,
  type RecordChange,
} from "../src/record-overlay/index.js";
import { ACTOR, change, DIGEST, EDITOR_BODY, event, FEED, OTHER, overlayWorld, PROVIDER, UID, type World } from "./record-overlay-helpers.js";

const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const AT = "2026-10-03T14:00:00Z";
const ids = (heads: readonly HeadResult[]): string[] => heads.map((h) => h.id);
const head = (id: string, sources: unknown, type = "Event"): HeadResult => ({ id, frontmatter: { type, sources } as never, version: `v-${id}` });

test("T3 the index groups by (resource, id) with exact comparison, keeps other Kinds apart and returns heads in id order", async () => {
  const w = await overlayWorld();
  const ev = (id: string, sources: unknown) => w.put(id, { type: "Event", title: id, start: STORY.start, sources });
  await ev("events/d", [{ resource: PROVIDER, id: "rec-3" }]);
  await ev("events/a", [{ resource: PROVIDER, id: "rec-1", title: "feed record" }]);
  await ev("events/b", [{ resource: OTHER, id: "rec-1" }, { resource: PROVIDER, id: "rec-2" }]);
  await ev("events/c", [{ resource: PROVIDER, id: "rec-3" }]);
  await ev("events/e", [{ resource: OTHER, id: "rec-4" }]);
  await ev("events/f", [{ resource: PROVIDER.toUpperCase(), id: "rec-5" }]);
  await ev("events/g", [{ resource: PROVIDER }]);
  await w.put("notes/n", { type: "Note", title: "Not an Event", sources: [{ resource: PROVIDER, id: "rec-6" }] });
  const index = await buildSourceIndex(w.content.bundle);
  const lookup = (id: string) => ids(index.lookup(PROVIDER, id, { type: "Event" }));
  assert.deepEqual([lookup("rec-1"), lookup("rec-2"), lookup("rec-3"), lookup("rec-5"), lookup("rec-6")], [["events/a"], ["events/b"], ["events/c", "events/d"], [], []]);
  assert.deepEqual(ids(index.lookup(PROVIDER, "rec-6")), ["notes/n"], "without a type every Kind is returned");
  assert.deepEqual(ids(index.lookup(OTHER, "rec-1")), ["events/b"]);
  const events = await buildSourceIndex(w.content.bundle, { type: "Event" });
  assert.deepEqual(ids(events.lookup(PROVIDER, "rec-6")), []);
  assert.equal(events.size, 6, "events/g carries no record id");
  assert.equal((await buildSourceIndex(w.content.bundle, { prefix: "notes/" })).size, 1);
});

test("T3 a document carrying one identity twice is returned twice; malformed entries are ignored", () => {
  const index = SourceIndex.fromHeads([
    head("events/z", [{ resource: PROVIDER, id: "r" }]),
    head("events/twice", [{ resource: PROVIDER, id: "r" }, { resource: PROVIDER, id: "r", title: "again" }]),
    head("events/bad", [null, "r", { resource: PROVIDER, id: 7 }, { resource: PROVIDER }, [PROVIDER, "r"]]),
    head("events/list", { resource: PROVIDER, id: "r" }),
  ]);
  assert.deepEqual(ids(index.lookup(PROVIDER, "r")), ["events/twice", "events/twice", "events/z"]);
  assert.equal(index.size, 2);
});

test("replace re-derives one document's entries from the written document and version", () => {
  const index = SourceIndex.fromHeads([head("events/a", [{ resource: PROVIDER, id: "r1" }]), head("events/b", [{ resource: PROVIDER, id: "r1" }])]);
  const doc = (sources: unknown): OkfDocument => ({ id: "events/a", frontmatter: { type: "Event", sources } as never, body: "" });
  index.replace(doc([{ resource: PROVIDER, id: "r2" }]), "v2");
  assert.deepEqual(ids(index.lookup(PROVIDER, "r1")), ["events/b"]);
  assert.deepEqual(index.lookup(PROVIDER, "r2").map((h) => [h.id, h.version]), [["events/a", "v2"]]);
  index.replace(doc([{ resource: PROVIDER, id: "r1" }, { resource: PROVIDER, id: "r2" }]), "v3");
  assert.deepEqual(index.lookup(PROVIDER, "r1").map((h) => [h.id, h.version]), [["events/a", "v3"], ["events/b", "v-events/b"]]);
  index.replace(doc([]), "v4");
  assert.deepEqual([ids(index.lookup(PROVIDER, "r1")), ids(index.lookup(PROVIDER, "r2")), index.size], [["events/b"], [], 1]);
});

async function planWith(w: World, policy: OverlayPolicy, changes: RecordChange[], index?: SourceIndex): Promise<OverlayPlan> {
  return planRecordOverlay({ content: w.content, ops: w.ops, policy, changes, observedAt: AT, sameBundle: true, ...(index ? { overlays: index } : {}) });
}
const applyWith = (w: World, policy: OverlayPolicy, plan: OverlayPlan, index?: SourceIndex) =>
  applyRecordOverlay(plan, { content: w.content, ops: w.ops, policy, actor: ACTOR, ...(index ? { overlays: index } : {}) });
const moveStart = (to: string, digest: string) => change(UID("001"), "changed", STORY, { ...STORY, start: to }, digest);

test("a stale index is caught at write time: an edited overlay is STALE_VERSION, a deleted one OVERLAY_IDENTITY_LOST", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", event("001", STORY), EDITOR_BODY);
  const index = await buildSourceIndex(w.content.bundle, { type: "Event" });
  await w.edit("events/story-time", { cost_text: "Free" });
  const stale = await applyWith(w, w.policy, await planWith(w, w.policy, [moveStart("2026-10-10T11:00:00-04:00", DIGEST("1"))], index), index);
  assert.deepEqual(stale.results.map((r) => r.code), ["STALE_VERSION"]);
  await w.contentBackend.delete("events/story-time");
  const lost = await applyWith(w, w.policy, await planWith(w, w.policy, [moveStart("2026-10-10T11:00:00-04:00", DIGEST("1"))], index), index);
  assert.deepEqual(lost.results.map((r) => r.code), ["OVERLAY_IDENTITY_LOST"]);
});

test("two feeds overlaying one document share one index: plan then apply per feed lands both in two versions; planning both first loses the second", async () => {
  const feedB: OverlayPolicy = readOverlayPolicy({ id: "source-feeds/venues", frontmatter: { url: OTHER, target_kind: "Event", owned_fields: ["venue_text"], auto_apply: ["changed"] } as never });
  const doc = { ...event("001", STORY), sources: [{ resource: PROVIDER, id: UID("001") }, { resource: OTHER, id: "venue-1" }] };
  const venueChange = change("venue-1", "changed", { venue_text: "Room A" }, { venue_text: "Room B" }, DIGEST("2"));
  {
    const w = await overlayWorld();
    const v0 = await w.put("events/story-time", { ...doc, venue_text: "Room A" }, EDITOR_BODY);
    const index = await buildSourceIndex(w.content.bundle);
    const a = await applyWith(w, w.policy, await planWith(w, w.policy, [moveStart("2026-10-10T11:00:00-04:00", DIGEST("1"))], index), index);
    const b = await applyWith(w, feedB, await planWith(w, feedB, [venueChange], index), index);
    assert.deepEqual([a.results.map((r) => r.outcome), b.results.map((r) => r.outcome)], [["applied"], ["applied"]]);
    const final = await w.read("events/story-time");
    assert.deepEqual([final.doc.frontmatter.start, final.doc.frontmatter.venue_text], ["2026-10-10T11:00:00-04:00", "Room B"]);
    assert.notEqual(a.results[0]!.version, v0);
    assert.equal(b.results[0]!.version, final.version);
    assert.equal(index.lookup(OTHER, "venue-1")[0]!.version, final.version, "replace kept the index current");
  }
  {
    const w = await overlayWorld();
    await w.put("events/story-time", { ...doc, venue_text: "Room A" }, EDITOR_BODY);
    const index = await buildSourceIndex(w.content.bundle);
    const planA = await planWith(w, w.policy, [moveStart("2026-10-10T11:00:00-04:00", DIGEST("1"))], index);
    const planB = await planWith(w, feedB, [venueChange], index);
    const a = await applyWith(w, w.policy, planA, index);
    const b = await applyWith(w, feedB, planB, index);
    assert.deepEqual([a.results[0]!.outcome, b.results[0]!.code], ["applied", "STALE_VERSION"]);
  }
});

test("the recorded residual: a second claimant added after the index was built is not seen this run; the next run refuses both as ambiguous with one Signal", async () => {
  const w = await overlayWorld();
  await w.put("events/first", event("001", STORY), EDITOR_BODY);
  const index = await buildSourceIndex(w.content.bundle, { type: "Event" });
  const secondVersion = await w.put("events/second", event("001", { ...STORY, title: "Story Time (copy)" }), EDITOR_BODY);
  const before = await w.snapshot();
  const plan = await planWith(w, w.policy, [moveStart("2026-10-10T11:00:00-04:00", DIGEST("1"))], index);
  assert.deepEqual(plan.refusals, []);
  const r = await applyWith(w, w.policy, plan, index);
  assert.deepEqual(r.results.map((x) => [x.op, x.target, x.outcome]), [["apply-owned-fields", "events/first", "applied"]]);
  const after = await w.snapshot();
  assert.deepEqual(Object.keys(after).filter((id) => after[id] !== before[id]), ["events/first"], "the write landed on the first claimant and nothing else changed");
  assert.equal(after["events/second"], secondVersion);

  const next = await planWith(w, w.policy, [moveStart("2026-10-10T12:00:00-04:00", DIGEST("2"))], await buildSourceIndex(w.content.bundle, { type: "Event" }));
  assert.deepEqual(next.refusals.map((x) => [x.code, x.targets]), [["OVERLAY_IDENTITY_AMBIGUOUS", ["events/first", "events/second"]]]);
  assert.ok(!next.steps.some((s) => s.op === "apply-owned-fields"));
  await applyWith(w, w.policy, next);
  const signals = Object.keys(await w.snapshot("ops")).filter((id) => id.startsWith("signals/"));
  assert.equal(signals.length, 1);
  assert.equal((await w.read(signals[0]!, "ops")).doc.frontmatter.priority, "normal");
  const replay = await planWith(w, w.policy, [moveStart("2026-10-10T12:00:00-04:00", DIGEST("2"))]);
  assert.deepEqual(replay.steps.map((s) => s.op), ["signal-duplicate"], "no second Signal on replay");
  assert.equal(replay.feed, FEED);
});
