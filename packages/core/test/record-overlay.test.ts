/**
 * `@superbee/core/record-overlay` scenarios over MemoryBackend with inline Kinds: the generic
 * record-bridge tests (policy, three-value rule, plan, apply, disappearance, typed refusals, text
 * gate, findings) rewritten against hand-built record changes, plus the grouped `sources` write and
 * a v0.1 ops bundle.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { docVersions } from "../src/bundle-ops.js";
import type { Frontmatter } from "../src/types.js";
import {
  applyRecordOverlay,
  decideChange,
  DEFAULT_AUTO_APPLY,
  DEFAULT_NEEDS_REVIEW,
  disappearedPhase,
  findingDigest,
  gateSafeValue,
  HOLD_STORE,
  isExcludedRecord,
  NEVER_OWNED,
  OverlayRefusal,
  planFindings,
  planRecordOverlay,
  readOverlayPolicy,
  REFUSAL_CODES,
  RETRYABLE,
  summarizeChange,
  type OverlayHooks,
  type OverlayPlan,
  type RecordChange,
} from "../src/record-overlay/index.js";
import {
  ACTOR,
  change,
  dashGate,
  DIGEST,
  EDITOR_BODY,
  event,
  FEED,
  overlayWorld,
  PROVIDER,
  statedEndElseThreeHours,
  UID,
  updatedAtStamp,
  type World,
} from "./record-overlay-helpers.js";

const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const MARKET = { title: "Harvest Market", start: "2026-10-11T09:00:00-04:00", end: "2026-10-11T13:00:00-04:00", event_status: "scheduled" };
const AT = "2026-10-03T14:00:00Z";

async function plan(w: World, changes: RecordChange[], extra: { observedAt?: string; hooks?: OverlayHooks; policy?: World["policy"] } = {}): Promise<OverlayPlan> {
  return planRecordOverlay({
    content: w.content, ops: w.ops, policy: extra.policy ?? w.policy, changes, observedAt: extra.observedAt ?? AT,
    sameBundle: w.content.bundle === w.ops.bundle, hooks: { interval: statedEndElseThreeHours, ...extra.hooks },
  });
}
const apply = (w: World, p: OverlayPlan, hooks: OverlayHooks = { deriveFields: updatedAtStamp(w.content.registry) }) =>
  applyRecordOverlay(p, { content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR, hooks });
const signals = async (w: World) => {
  const snap = await w.snapshot("ops");
  const out = [];
  for (const id of Object.keys(snap).filter((id) => id.startsWith("signals/"))) out.push((await w.read(id, "ops")).doc);
  return out;
};

// ------------------------------------------------------------------------------- T1 policy and decisions

const policy = readOverlayPolicy({ id: "source-feeds/x", frontmatter: { url: "https://p.example/f.ics", target_kind: "Event", owned_fields: ["start", "event_status"], auto_apply: ["changed", "canceled"], needs_review: ["new", "canceled", "disappeared"] } as unknown as Frontmatter });
const A = { title: "A", start: "2026-10-10T10:00:00-04:00", event_status: "scheduled" };

test("T1 decideChange: owned fields apply when the document matches the baseline; diverged is a conflict; editor-owned never applies", () => {
  const c = { external_id: "a", change_kind: "changed", changed_fields: ["start", "title"], before: { ...A }, after: { ...A, title: "A2", start: "S2" }, content_digest: "d" };
  const ok = decideChange(policy, c, { overlay: { frontmatter: { ...A } } });
  assert.deepEqual(ok.apply, { start: { from: A.start, to: "S2" } });
  assert.deepEqual(ok.editorFields, ["title"]);
  assert.ok(ok.signal && ok.signal.reasons.includes("editor-owned-field-changed"));
  const diverged = decideChange(policy, c, { overlay: { frontmatter: { ...A, start: "EDITED" } } });
  assert.deepEqual(diverged.apply, {});
  assert.equal(diverged.conflicts[0]!.field, "start");
  assert.ok(diverged.signal!.reasons.includes(REFUSAL_CODES.OVERLAY_DOC_CONFLICT));
  const converged = decideChange(policy, { ...c, changed_fields: ["start"] }, { overlay: { frontmatter: { ...A, start: "S2" } } });
  assert.deepEqual([converged.apply, converged.signal], [{}, null]);
  assert.equal(decideChange(policy, { ...c, changed_fields: ["start"] }).signal, null, "changes without an overlay are record-only");
});

test("T1 decideChange: an editor-owned change the document already says needs no judgment", () => {
  const c = { external_id: "a", change_kind: "changed", changed_fields: ["event_types"], before: { ...A }, after: { ...A, event_types: ["school-closed"] }, content_digest: "d" };
  const agreed = decideChange(policy, c, { overlay: { frontmatter: { ...A, event_types: ["school-closed"] } } });
  assert.deepEqual([agreed.editorFields, agreed.signal], [[], null]);
  const differs = decideChange(policy, c, { overlay: { frontmatter: { ...A, event_types: ["civic"] } } });
  assert.deepEqual(differs.editorFields, ["event_types"]);
});

test("T1 decideChange priorities: cancel of an overlaid or featured record is urgent; new is low", () => {
  const cancel = { external_id: "a", change_kind: "canceled", changed_fields: ["event_status"], before: A, after: { ...A, event_status: "canceled" }, content_digest: "d" };
  assert.equal(decideChange(policy, cancel, { overlay: { frontmatter: A } }).signal!.priority, "urgent");
  assert.equal(decideChange(policy, cancel).signal!.priority, "normal");
  assert.equal(decideChange(policy, cancel, { featured: true }).signal!.priority, "urgent");
  assert.equal(decideChange(policy, { external_id: "n", change_kind: "new", changed_fields: ["title"], before: null, after: A, content_digest: "d" }).signal!.priority, "low");
});

test("T1 decideChange: an absent document value is not a feed null (conflict), while a document null is (write)", () => {
  const c = { external_id: "a", change_kind: "changed", changed_fields: ["start"], before: { ...A, start: null }, after: { ...A, start: "S2" }, content_digest: "d" };
  const absent = decideChange(policy, c, { overlay: { frontmatter: { title: "A", event_status: "scheduled" } } });
  assert.deepEqual(absent.apply, {});
  assert.deepEqual(absent.conflicts.map((x) => x.field), ["start"]);
  const explicitNull = decideChange(policy, c, { overlay: { frontmatter: { ...A, start: null } } });
  assert.deepEqual(explicitNull.apply, { start: { from: null, to: "S2" } });
});

test("T1 Source Feed policy validation", () => {
  const refuse = (fm: Record<string, unknown>, ctx = {}) => assert.throws(() => readOverlayPolicy({ id: "x", frontmatter: fm as unknown as Frontmatter }, ctx), (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID");
  refuse({ url: "https://p", owned_fields: [] });
  for (const field of NEVER_OWNED) refuse({ url: "https://p", owned_fields: [field] });
  const kind = { id: "conventions/event", title: "Event", governs: "Event", fields: { required: ["title", "start"], optional: ["end"] } } as never;
  refuse({ url: "https://p", owned_fields: ["nope"] }, { targetKind: kind });
  refuse({ owned_fields: ["start"] });
  refuse({ url: "https://p", owned_fields: ["start"], missing_threshold: 0 });
  refuse({ url: "https://p", owned_fields: ["start"], exclude_pattern: "(" });
  refuse({ url: "https://p", owned_fields: ["start"] }, { targetKind: kind, presentationFields: ["start"] });
  assert.deepEqual(policy.auto_apply, ["changed", "canceled"]);
  const defaults = readOverlayPolicy({ id: "x", frontmatter: { url: "https://p", owned_fields: "start, end", wall_time_zone: " America/New_York ", missing_threshold: "2", completeness: "complete" } as unknown as Frontmatter });
  assert.deepEqual([defaults.owned_fields, defaults.auto_apply, defaults.needs_review], [["start", "end"], [...DEFAULT_AUTO_APPLY], [...DEFAULT_NEEDS_REVIEW]]);
  assert.deepEqual([defaults.time_zone, defaults.missing_threshold, defaults.completeness, defaults.target_kind], ["America/New_York", 2, "complete", undefined]);
});

test("T1 a presentation-only policy may own record fields named like reserved ones and carries no target Kind", () => {
  const p = readOverlayPolicy({ id: "source-feeds/conditions", frontmatter: { url: "https://p", target_kind: "Condition", owned_fields: ["status", "level"] } as unknown as Frontmatter }, { presentationFields: ["status", "level", "observed_at"] });
  assert.deepEqual(p.owned_fields, ["status", "level"]);
  assert.equal(p.target_kind, undefined);
  assert.throws(() => readOverlayPolicy({ id: "x", frontmatter: { url: "https://p", owned_fields: ["other"] } as unknown as Frontmatter }, { presentationFields: ["status"] }), { code: "POLICY_INVALID" });
});

test("T1 isExcludedRecord: title pattern, source id and a recurrence occurrence's series id", () => {
  const p = { ...policy, exclude: /\bclosed\b/i, exclude_ids: new Set(["80"]) };
  assert.equal(isExcludedRecord(p, "1", "Library Closed"), true);
  assert.equal(isExcludedRecord(p, "80", "Story"), true);
  assert.equal(isExcludedRecord(p, "80#2026-10-05", "Story"), true);
  assert.equal(isExcludedRecord(p, "81", "Story"), false);
});

// ------------------------------------------------------------------------------- T4 to T11 plan and apply

test("T4 a new record raises one low Signal with the feed link and adoption hint; a replay dedupes", async () => {
  const w = await overlayWorld();
  const c = change(UID("006"), "new", null, { title: "Pumpkin Carving", start: "2026-10-25T14:00:00-04:00" }, DIGEST("1"));
  const p = await plan(w, [c]);
  assert.deepEqual(p.steps.map((s) => [s.op, s.external_id]), [["create-signal", UID("006")]]);
  const r = await apply(w, p);
  assert.equal(r.results[0]!.outcome, "applied");
  const [sig] = await signals(w);
  assert.equal(sig!.frontmatter.superbee_progress_status, "todo");
  assert.equal(sig!.frontmatter.change_kind, "new");
  assert.equal(sig!.frontmatter.priority, "low");
  assert.equal(sig!.frontmatter.external_id, UID("006"));
  assert.equal((sig!.frontmatter.generated as { by: string }).by, ACTOR);
  assert.equal(sig!.frontmatter.superbee_updated_by, ACTOR);
  assert.match(sig!.body, /\[from feed\]\(\.\.\/source-feeds\/synthetic-library\.md\)/);
  assert.match(sig!.body, /id: evt-006@calendar\.example\.org/);
  const again = await plan(w, [c], { observedAt: "2026-10-03T14:30:00Z" });
  assert.deepEqual(again.steps.map((s) => s.op), ["signal-duplicate"]);
  assert.equal((await signals(w)).length, 1);
});

test("T5 a change applies only owned fields with updated_at in the same write; the editor's title and body are untouched", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", event("001", { ...STORY, title: "Story Time (editor title)" }), EDITOR_BODY);
  await w.put("events/harvest-market", event("002", MARKET), EDITOR_BODY);
  const before = await docVersions(w.content.bundle, "events/story-time");
  const p = await plan(w, [
    change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00", end: "2026-10-10T12:00:00-04:00" }, DIGEST("2")),
    change(UID("002"), "changed", MARKET, { ...MARKET, title: "Harvest Market and Craft Fair" }, DIGEST("3")),
  ]);
  const step = p.steps.find((s) => s.op === "apply-owned-fields")!;
  assert.equal(step.target, "events/story-time");
  assert.deepEqual(Object.keys((step as { fields: object }).fields).sort(), ["end", "start"]);
  await apply(w, p);
  const story = (await w.read("events/story-time")).doc;
  assert.equal(story.frontmatter.start, "2026-10-10T11:00:00-04:00");
  assert.equal(story.frontmatter.title, "Story Time (editor title)");
  assert.equal(story.body, EDITOR_BODY);
  assert.ok(Date.parse(String(story.frontmatter.updated_at)) > 0);
  assert.equal(story.frontmatter.superbee_updated_by, ACTOR);
  assert.equal((await docVersions(w.content.bundle, "events/story-time")).length, before.length + 1, "owned fields and updated_at land in one version");
  assert.equal((await w.read("events/harvest-market")).doc.frontmatter.title, "Harvest Market");
  const sig = (await signals(w)).find((s) => s.frontmatter.external_id === UID("002"))!;
  assert.match(String(sig.frontmatter.diff_summary), /not applied \(editor-owned\): title/);
  assert.match(sig.body, /\[about event\]\(\.\.\/events\/harvest-market\.md\)/);
});

test("T6 a concurrent editor write between plan and apply is refused STALE_VERSION, retryable, and nothing is written", async () => {
  const w = await overlayWorld();
  await w.put("events/trail-cleanup", event("005", { ...STORY, title: "Trail Cleanup" }), EDITOR_BODY);
  const p = await plan(w, [change(UID("005"), "canceled", STORY, { ...STORY, event_status: "canceled" }, DIGEST("4"))]);
  const edited = await w.edit("events/trail-cleanup", { cost_text: "Free" });
  const r = await apply(w, { ...p, steps: p.steps.filter((s) => s.op === "apply-owned-fields") });
  assert.equal(r.results[0]!.code, "STALE_VERSION");
  assert.ok(RETRYABLE.has("STALE_VERSION") && RETRYABLE.has("SIGNAL_CLAIMED"));
  const after = await w.read("events/trail-cleanup");
  assert.equal(after.version, edited);
  assert.equal(after.doc.frontmatter.event_status, "scheduled");
});

test("T7 a cancellation of an overlaid record applies the owned status and raises an urgent Signal", async () => {
  const w = await overlayWorld();
  await w.put("events/trail-cleanup", event("005", { ...STORY, title: "Trail Cleanup" }), EDITOR_BODY);
  const r = await apply(w, await plan(w, [change(UID("005"), "canceled", STORY, { ...STORY, event_status: "canceled" }, DIGEST("4"))]));
  assert.equal(r.results.find((x) => x.op === "apply-owned-fields")!.outcome, "applied");
  assert.equal((await w.read("events/trail-cleanup")).doc.frontmatter.event_status, "canceled");
  const sig = (await signals(w)).find((s) => s.frontmatter.external_id === UID("005"))!;
  assert.deepEqual([sig.frontmatter.change_kind, sig.frontmatter.priority], ["canceled", "urgent"]);
});

test("T8 a crash between bundle writes and the store commit replays as signal-duplicate", async () => {
  const w = await overlayWorld();
  const c = change(UID("006"), "changed", { title: "Pumpkin Carving" }, { title: "Pumpkin Carving Night" }, DIGEST("5"), { signal_priority: "normal" });
  const first = await plan(w, [{ ...c, change_kind: "canceled" }]);
  await apply(w, first);
  const count = (await signals(w)).length;
  const replay = await plan(w, [{ ...c, change_kind: "canceled" }], { observedAt: "2026-10-03T16:05:00Z" });
  assert.deepEqual(replay.steps.map((s) => s.op), ["signal-duplicate"]);
  await apply(w, replay);
  assert.equal((await signals(w)).length, count);
});

test("T9 repeated changes before a claim collapse into one Signal; after the claim a new Signal is raised", async () => {
  const w = await overlayWorld();
  await apply(w, await plan(w, [change(UID("006"), "new", null, { title: "Pumpkin Carving" }, DIGEST("6"))]));
  const v2 = await plan(w, [change(UID("006"), "changed", { title: "Pumpkin Carving" }, { title: "Pumpkin Carving Night" }, DIGEST("7"))], { observedAt: "2026-10-03T17:00:00Z" });
  assert.deepEqual(v2.steps.map((s) => s.op), ["collapse-signal"]);
  await apply(w, v2);
  const [sig] = await signals(w);
  assert.deepEqual([sig!.frontmatter.change_kind, sig!.frontmatter.priority], ["changed", "low"]);
  assert.equal(sig!.body.match(/^- 2026/gm)!.length, 2);
  await w.edit(sig!.id, { superbee_progress_status: "in_progress", assignee: "agent/claimant" }, "ops");
  const v3 = await plan(w, [change(UID("006"), "changed", { title: "Pumpkin Carving Night" }, { title: "Pumpkin Carving Party" }, DIGEST("8"))], { observedAt: "2026-10-03T18:00:00Z" });
  assert.deepEqual(v3.steps.map((s) => s.op), ["record-only"]);
  const v4 = await plan(w, [change(UID("006"), "canceled", { title: "Pumpkin Carving Party", event_status: "scheduled" }, { title: "Pumpkin Carving Party", event_status: "canceled" }, DIGEST("9"))], { observedAt: "2026-10-03T18:30:00Z" });
  assert.deepEqual(v4.steps.map((s) => s.op), ["create-signal"]);
  assert.equal((v4.steps[0] as { candidate: { frontmatter: Frontmatter } }).candidate.frontmatter.priority, "normal");
  await apply(w, v4);
  assert.equal((await signals(w)).length, 2);
});

test("T10 an editor's edit of an owned field makes the next change a conflict; the document keeps the editor's value", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", event("001", { ...STORY, start: "2026-10-10T11:15:00-04:00" }), EDITOR_BODY);
  const p = await plan(w, [change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:30:00-04:00" }, DIGEST("a"))]);
  assert.deepEqual(p.refusals.map((x) => [x.code, x.target, x.field]), [["OVERLAY_DOC_CONFLICT", "events/story-time", "start"]]);
  assert.ok(!p.steps.some((s) => s.op === "apply-owned-fields"));
  await apply(w, p);
  assert.equal((await w.read("events/story-time")).doc.frontmatter.start, "2026-10-10T11:15:00-04:00");
  assert.match(String((await signals(w))[0]!.frontmatter.diff_summary), /CONFLICT start/);
});

test("T11 a forged step writing a non-owned field is refused FIELD_NOT_OWNED and the document is unchanged", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/harvest-market", event("002", MARKET), EDITOR_BODY);
  const r = await apply(w, { feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps: [
    { op: "apply-owned-fields", target: "events/harvest-market", expected_version: version, external_id: UID("002"), change_kind: "changed", fields: { title: { from: MARKET.title, to: "Hijacked" } } },
  ] });
  assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED");
  assert.equal((await w.read("events/harvest-market")).version, version);
});

test("T11 a disappeared record raises a disappearance Signal and deletes nothing", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", event("003", STORY), EDITOR_BODY);
  const p = await plan(w, [change(UID("003"), "disappeared", STORY, null, DIGEST("b"), { missing_count: 2 })]);
  assert.deepEqual(p.steps.map((s) => s.op), ["create-signal"]);
  await apply(w, p);
  assert.equal((await signals(w))[0]!.frontmatter.change_kind, "disappeared");
  assert.deepEqual([w.contentBackend.deletes, w.opsBackend.deletes], [[], []]);
  assert.ok((await w.snapshot())["events/story-time"]);
});

// ------------------------------------------------------------------------------- T12 to T14 disappearance phases

test("T12 disappearedPhase: a stated end, else start plus three hours; unknown without an interval hook", () => {
  const at = "2026-10-03T23:30:00Z";
  const phase = (fields: Record<string, unknown>) => disappearedPhase(fields, at, undefined, statedEndElseThreeHours);
  assert.equal(phase({ start: "2026-10-03T14:00:00-04:00", end: "2026-10-03T16:00:00-04:00" }), "ended");
  assert.equal(phase({ start: "2026-10-03T16:00:00-04:00" }), "ended");
  assert.equal(phase({ start: "2026-10-03T17:00:00-04:00" }), "ongoing");
  assert.equal(phase({ start: "2026-10-05T19:00:00-04:00" }), "before-start");
  assert.equal(phase({ title: "undated" }), null);
  assert.equal(disappearedPhase({ start: "2026-10-03T14:00:00-04:00" }, at, undefined, undefined), null, "no interval hook: unknown, so the record is raised");
  assert.equal(disappearedPhase({ start: "2026-10-03T14:00:00-04:00" }, "not an instant", undefined, statedEndElseThreeHours), null);
});

test("T13 summarizeChange: a disappearance names the last known title, start and end", () => {
  const c = { change_kind: "disappeared", missing_count: 2, before: { title: "Fall Fair", start: "2026-10-20T10:00:00-04:00" } } as unknown as RecordChange;
  assert.equal(summarizeChange(c, null, [], { phase: "before-start" }),
    "missing from 2 consecutive complete observations; vanished before its start: possibly canceled, check the organizer's page; last title: Fall Fair; last start: 2026-10-20T10:00:00-04:00; last end: ∅");
  assert.equal(summarizeChange(c, null),
    "missing from 2 consecutive complete observations; last title: Fall Fair; last start: 2026-10-20T10:00:00-04:00; last end: ∅");
});

test("T14 disappearances: ended retires with a receipt reason, before its start is raised, a missing first-miss time is raised, an open Signal is told", async () => {
  const w = await overlayWorld({ feed: { completeness: "complete", missing_threshold: 2 } });
  await w.put("signals/synthetic-library-evening", { type: "Signal", superbee_progress_status: "todo", priority: "low", provider: PROVIDER, title: "New: Evening Concert", change_kind: "new", observed_at: "2026-10-02T16:00:00Z", external_id: "evening@x.example", diff_summary: "new record" },
    `# Observations\n\n- 2026-10-02T16:00:00Z · new · ${DIGEST("c")} · new record\n`, "ops");
  const miss = { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" };
  const p = await plan(w, [
    change("ended@x.example", "disappeared", { title: "Afternoon Matinee", start: "2026-10-03T14:00:00-04:00", end: "2026-10-03T16:00:00-04:00" }, null, DIGEST("d"), miss),
    change("future@x.example", "disappeared", { title: "Fall Fair", start: "2026-10-20T10:00:00-04:00", end: "2026-10-20T15:00:00-04:00" }, null, DIGEST("e"), miss),
    change("unknown@x.example", "disappeared", { title: "Old Entry", start: "2026-10-02T10:00:00-04:00" }, null, DIGEST("f"), { missing_count: 2 }),
    change("evening@x.example", "disappeared", { title: "Evening Concert", start: "2026-10-03T19:00:00-04:00", end: "2026-10-03T21:00:00-04:00" }, null, DIGEST("c"), miss),
  ], { observedAt: "2026-10-05T12:00:00Z" });
  const r = await apply(w, p);
  assert.deepEqual(r.results.filter((x) => x.reason === "ended").map((x) => [x.external_id, x.op, x.outcome, x.last_known_end]), [["ended@x.example", "record-only", "skipped", "2026-10-03T20:00:00.000Z"]]);
  const raised = (await signals(w)).filter((s) => s.frontmatter.change_kind === "disappeared");
  assert.deepEqual(raised.map((s) => s.frontmatter.external_id).sort(), ["future@x.example", "unknown@x.example"]);
  assert.match(String(raised.find((s) => s.frontmatter.external_id === "future@x.example")!.frontmatter.diff_summary), /vanished before its start: possibly canceled/);
  const evening = (await w.read("signals/synthetic-library-evening", "ops")).doc;
  assert.deepEqual([evening.frontmatter.change_kind, evening.frontmatter.title, evening.frontmatter.priority], ["new", "New: Evening Concert", "low"]);
  assert.match(String(evening.frontmatter.diff_summary), /ended: gone after its last known end/);
});

// ------------------------------------------------------------------------------- T15 typed refusals

test("T15 a core type refusal with another Kind finding is FIELD_TYPE_VIOLATION, held, value-free, with the other finding named", async () => {
  const w = await overlayWorld();
  const GOOD = { title: "Typed", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_url: "https://calendar.example.org/e/1" };
  const version = await w.put("events/typed", event("x1", GOOD), "Editor text.\n");
  const before = { start: GOOD.start, end: GOOD.end, event_url: GOOD.event_url };
  const r = await apply(w, await plan(w, [change(UID("x1"), "changed", before, { end: GOOD.end, event_url: "http://calendar.example.org/e/1?token=secret456" }, DIGEST("1"))]));
  const step = r.results.find((x) => x.op === "apply-owned-fields")!;
  assert.deepEqual([step.outcome, step.code, step.message], ["refused", "FIELD_TYPE_VIOLATION", "candidate violates declared field types: event_url (https-url)"]);
  const details = step.details as { violations: Array<{ field: string; type: string }>; also: string[] };
  assert.deepEqual(details.violations.map((v) => [v.field, v.type]), [["event_url", "https-url"]]);
  assert.deepEqual(details.also, ["KIND_FIELD_MISSING:start"]);
  assert.doesNotMatch(JSON.stringify(r), /secret456/, "the refused value is not echoed");
  assert.ok(HOLD_STORE.has("FIELD_TYPE_VIOLATION") && HOLD_STORE.has("INVALID_INPUT"));
  assert.equal((await w.read("events/typed")).version, version);
});

// ------------------------------------------------------------------------------- T16 text gate

test("T16 gateSafeValue and decideChange with a text gate: normalized writes, held prose, and a normalized document converges", () => {
  const p = readOverlayPolicy({ id: "source-feeds/x", frontmatter: { url: PROVIDER, target_kind: "Event", owned_fields: ["title", "start", "venue_text"], auto_apply: ["changed"] } as unknown as Frontmatter });
  assert.deepEqual(gateSafeValue("Trivia Night \u2014 Round 2", "title", "Event", dashGate), { value: "Trivia Night: Round 2", ok: true, tells: [] });
  assert.equal(gateSafeValue("nestled by the canal", "venue_text", "Event", dashGate).ok, false);
  assert.deepEqual(gateSafeValue(42, "capacity", "Event", dashGate), { value: 42, ok: true, tells: [] });
  assert.equal(gateSafeValue(["Main St - North"], "streets", "Event", dashGate).ok, false, "nested text is never rewritten, only held");
  assert.deepEqual(gateSafeValue("Trivia Night \u2014 Round 2", "title", "Event"), { value: "Trivia Night \u2014 Round 2", ok: true, tells: [] }, "the default gate is the identity");
  const B = { title: "Trivia Night", start: "2026-10-20T19:00:00-04:00", venue_text: "The Club" };
  const ch = (after: Record<string, unknown>, before: Record<string, unknown> = B) => ({ external_id: "a", change_kind: "changed", changed_fields: Object.keys(after).filter((k) => after[k] !== before[k]), before, after, content_digest: "d" });
  const dash = decideChange(p, ch({ ...B, title: "Trivia Night \u2014 Round 2" }), { overlay: { frontmatter: { ...B } }, textGate: dashGate });
  assert.deepEqual([dash.apply, dash.wording, dash.signal], [{ title: { from: "Trivia Night", to: "Trivia Night: Round 2" } }, [], null]);
  const prose = decideChange(p, ch({ ...B, venue_text: "Nestled by the canal - upstairs", start: "2026-10-20T20:00:00-04:00" }), { overlay: { frontmatter: { ...B } }, textGate: dashGate });
  assert.deepEqual(prose.apply, { start: { from: B.start, to: "2026-10-20T20:00:00-04:00" } });
  assert.deepEqual(prose.signal, { priority: "low", reasons: ["needs-human-safe-wording"] });
  const raw = "Trivia Night \u2014 Round 2", safe = "Trivia Night: Round 2";
  const same = decideChange(p, ch({ ...B, title: raw, start: "2026-10-20T20:00:00-04:00" }, { ...B, title: "Old" }), { overlay: { frontmatter: { ...B, title: safe } }, textGate: dashGate });
  assert.deepEqual([same.apply, same.conflicts], [{ start: { from: B.start, to: "2026-10-20T20:00:00-04:00" } }, []]);
  const next = decideChange(p, ch({ ...B, title: "Trivia Night \u2014 Round 3" }, { ...B, title: raw }), { overlay: { frontmatter: { ...B, title: safe } }, textGate: dashGate });
  assert.deepEqual([next.apply, next.conflicts], [{ title: { from: safe, to: "Trivia Night: Round 3" } }, []]);
  const edited = decideChange(p, ch({ ...B, title: "Trivia Night \u2014 Round 3" }, { ...B, title: raw }), { overlay: { frontmatter: { ...B, title: "Pub Trivia" } }, textGate: dashGate });
  assert.equal(edited.conflicts[0]!.field, "title");
});

// ------------------------------------------------------------------------------- T17 to T19 findings

test("T17 to T19 findings: dedupe by key and facts (a dismissed finding stays dismissed), collapse into an open Signal, re-raise after expiry", async () => {
  const w = await overlayWorld();
  const finding = (key: string, facts: unknown, over = {}) => ({ key, title: `Check ${key}`, facts, ...over });
  const ops = w.ops;
  const seedSignal = (id: string, fm: Record<string, unknown>) => w.put(id, { type: "Signal", title: "t", change_kind: "status-check", observed_at: "2026-10-04T02:00:00Z", provider: "process:review", diff_summary: "s", priority: "normal", ...fm }, "# Observations\n", "ops");
  await seedSignal("signals/review-dismissed", { superbee_progress_status: "dismissed", external_id: "places/a", content_digest: findingDigest(finding("places/a", { open: false })) });
  await seedSignal("signals/review-open", { superbee_progress_status: "todo", external_id: "places/b", content_digest: DIGEST("2"), priority: "low" });
  await seedSignal("signals/review-expired", { superbee_progress_status: "dismissed", external_id: "places/c", expires_at: "2026-10-10T02:00:00Z", content_digest: findingDigest(finding("places/c", { open: false })) });
  const observedAt = "2026-10-11T02:00:00Z";
  const steps = await planFindings({ ops, provider: "process:review", slug: "review", observedAt, findings: [
    finding("places/a", { open: false }),
    finding("places/b", { open: false, moved: true }, { priority: "urgent" }),
    finding("places/c", { open: false }, { expires_at: "2026-11-10T02:00:00Z" }),
    finding("places/a", { open: true }),
    finding("places/d", { open: false }),
  ] });
  assert.deepEqual(steps.map((s) => [s.op, s.external_id]), [
    ["signal-duplicate", "places/a"], ["collapse-signal", "places/b"], ["create-signal", "places/c"], ["create-signal", "places/d"],
  ]);
  assert.match(steps[2]!.target!, /^signals\/review-[0-9a-f]{12}$/);
  const r = await applyRecordOverlay({ feed: null, provider: "process:review", observed_at: observedAt, steps, refusals: [] }, { content: ops, ops, policy: { owned_fields: [], provider: "process:review" }, actor: ACTOR });
  assert.deepEqual(r.results.map((x) => x.outcome), ["skipped", "applied", "applied", "applied"]);
  assert.equal((await w.read("signals/review-open", "ops")).doc.frontmatter.priority, "urgent");
  assert.equal(findingDigest({ key: "k", facts: { b: 1, a: 2 } }), findingDigest({ key: "k", facts: { a: 2, b: 1 } }));
});

// ------------------------------------------------------------------------------- T20 grouped sources write

test("T20 the grouped shape lands the owned fields, the sources upsert and updated_at in one version", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", { ...event("001", STORY), sources: [{ resource: "https://other.example.org", id: "o-1" }, { resource: PROVIDER, id: UID("001"), title: "feed record" }] }, EDITOR_BODY);
  const history = (await docVersions(w.content.bundle, "events/story-time")).length;
  const p = await plan(w, [change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("3"))], { hooks: { sourceProperties: () => ({ revision: "r42", checked: true }) } });
  const step = p.steps[0] as { op: string; sources?: Record<string, unknown> };
  assert.deepEqual([step.op, step.sources], ["apply-owned-fields", { revision: "r42", checked: true }]);
  const r = await apply(w, p);
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const doc = (await w.read("events/story-time")).doc;
  assert.equal(doc.frontmatter.start, "2026-10-10T11:00:00-04:00");
  assert.ok(Date.parse(String(doc.frontmatter.updated_at)) > 0);
  assert.deepEqual(doc.frontmatter.sources, [{ resource: "https://other.example.org", id: "o-1" }, { resource: PROVIDER, id: UID("001"), title: "feed record", revision: "r42", checked: true }]);
  assert.equal(doc.body, EDITOR_BODY);
  assert.equal((await docVersions(w.content.bundle, "events/story-time")).length, history + 1, "one CAS write");
});

test("T20 sourceProperties naming the identity or holding a list is refused at plan time; a removal keeps the patch shape and survives serialization", async () => {
  const w = await overlayWorld();
  await w.put("events/story-time", event("001", { ...STORY, venue_text: "Room A" }), EDITOR_BODY);
  const c = change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("4"));
  for (const props of [{ resource: "https://evil.example" }, { id: "other" }, { list: ["a"] as unknown as string }]) {
    await assert.rejects(plan(w, [c], { hooks: { sourceProperties: () => props } }), (e: unknown) => e instanceof OverlayRefusal && e.code === "INVALID_INPUT");
  }
  const removal = change(UID("001"), "changed", { ...STORY, venue_text: "Room A" }, STORY, DIGEST("5"));
  const p = await plan(w, [removal], { hooks: { sourceProperties: () => ({ revision: "r1" }) } });
  assert.equal((p.steps[0] as { sources?: unknown }).sources, undefined);
  const serialized = JSON.parse(JSON.stringify(p)) as OverlayPlan;
  assert.deepEqual((serialized.steps[0] as { fields: object }).fields, { venue_text: { from: "Room A" } }, "a serialized removal has no `to`");
  await apply(w, serialized);
  assert.equal((await w.read("events/story-time")).doc.frontmatter.venue_text, undefined);
});

// ------------------------------------------------------------------------------- T21 v0.1 ops bundle

test("T21 a v0.1 ops bundle creates Signals with status todo, collapses only while status is todo, and overlay writes never carry status", async () => {
  const w = await overlayWorld({ edition: "0.1" });
  await w.put("events/story-time", event("001", STORY), EDITOR_BODY);
  const p = await plan(w, [
    change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("6")),
    change(UID("012"), "new", null, { title: "Leaf Pickup" }, DIGEST("7")),
  ]);
  const create = p.steps.find((s) => s.op === "create-signal") as { target: string; candidate: { frontmatter: Record<string, unknown> } };
  assert.equal(create.candidate.frontmatter.status, "todo");
  assert.equal(create.candidate.frontmatter.superbee_progress_status, undefined);
  const r = await apply(w, p);
  assert.deepEqual(r.results.map((x) => x.outcome), ["applied", "applied"]);
  assert.equal((await w.read("events/story-time")).doc.frontmatter.status, undefined, "the overlay write carries no status");
  await w.edit(create.target, { status: "in_progress" }, "ops");
  const collapse = await plan(w, [change(UID("012"), "changed", { title: "Leaf Pickup" }, { title: "Leaf Pickup Week" }, DIGEST("8"))]);
  assert.deepEqual(collapse.steps.map((s) => s.op), ["record-only"], "a claimed Signal is not open");
  const signalVersion = (await w.read(create.target, "ops")).version;
  const forced = await applyRecordOverlay({ feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps: [
    { op: "collapse-signal", target: create.target, expected_version: signalVersion, external_id: UID("012"), content_digest: DIGEST("8"), progress_field: "status", observation_line: "- line", set: { title: "x" } },
  ] }, { content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR });
  assert.deepEqual([forced.results[0]!.code, forced.results[0]!.details], ["SIGNAL_CLAIMED", { field: "status" }]);
});
