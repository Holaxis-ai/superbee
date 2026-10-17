/**
 * Record-overlay cases added after adversarial QA: owned-field writes reach the target Kind only
 * (B1), a value core's write policy refuses is a held row, never a throw mid-run (M1), Signal writes
 * are bound to the run's provider, not to the plan (M2), plan values are JSON data (m1), and Signal
 * bodies and observation lines keep the planner's shape (m2).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Frontmatter, OkfDocument, Version } from "../src/types.js";
import {
  applyRecordOverlay,
  HOLD_STORE,
  OverlayRefusal,
  planRecordOverlay,
  readOverlayPolicy,
  type ApplyContext,
  type CollapseSignalStep,
  type CreateSignalStep,
  type OverlayPlan,
  type OverlayStep,
} from "../src/record-overlay/index.js";
import {
  ACTOR,
  change,
  DIGEST,
  EDITOR_BODY,
  event,
  FEED,
  OTHER,
  overlayWorld,
  PROVIDER,
  taskConvention,
  UID,
  type World,
} from "./record-overlay-helpers.js";

const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const AT = "2026-10-03T14:00:00Z";
const planOf = (steps: OverlayStep[], over: Partial<OverlayPlan> = {}): OverlayPlan => ({ feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps, ...over });
const ctxOf = (w: World, over: Partial<ApplyContext> = {}): ApplyContext => ({ content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR, ...over });
const refusedWith = (code: string) => (e: unknown) => e instanceof OverlayRefusal && e.code === code;
const progressOf = (edition: "0.1" | "0.2") => (edition === "0.1" ? "status" : "superbee_progress_status");
const signalFm = (edition: "0.1" | "0.2", over: Record<string, unknown> = {}) => ({
  type: "Signal", title: "New: x", [progressOf(edition)]: "todo", change_kind: "new", observed_at: AT, provider: PROVIDER,
  external_id: UID("009"), diff_summary: "new record", priority: "low", sources: [{ resource: PROVIDER, id: UID("009") }], ...over,
});
const obsLine = (kind = "new", digest = DIGEST("9")) => `- ${AT} · ${kind} · ${digest} · new record`;
function createStep(target: string, frontmatter: Record<string, unknown>, body = `[from feed](../source-feeds/synthetic-library.md)\n\n# Observations\n\n${obsLine()}\n`, externalId = UID("009")): CreateSignalStep {
  return { op: "create-signal", target, external_id: externalId, content_digest: DIGEST("9"), reasons: ["test"], candidate: { frontmatter: frontmatter as OkfDocument["frontmatter"], body } };
}
function collapseStep(target: string, version: Version, set: Record<string, unknown>, observation = `- ${AT} · changed · ${DIGEST("8")} · changed`): CollapseSignalStep {
  return { op: "collapse-signal", target, expected_version: version, external_id: UID("009"), content_digest: DIGEST("8"), progress_field: "superbee_progress_status", observation_line: observation, set };
}
function ownedStep(target: string, version: Version, fields: Record<string, { from?: unknown; to?: unknown }>, over: Record<string, unknown> = {}): OverlayStep {
  return { op: "apply-owned-fields", target, expected_version: version, external_id: UID("009"), change_kind: "changed", fields, ...over } as OverlayStep;
}

// ------------------------------------------------------------------------------- B1 target Kind only

for (const edition of ["0.1", "0.2"] as const) {
  test(`B1 (${edition}) a forged owned-field step at a Signal carrying the identity, claimed or not, is refused and the Signal is unchanged`, async () => {
    const w = await overlayWorld({ edition });
    const policy = { ...w.policy, owned_fields: ["title", "start", "end", "event_status", "venue_text"] };
    for (const [id, claim] of [["signals/raised-todo", {}], ["signals/raised-claimed", { [progressOf(edition)]: "in_progress", assignee: "human:triager" }]] as const) {
      const version = await w.put(id, signalFm(edition, claim), `# Observations\n\n${obsLine()}\n`, "ops");
      const r = await applyRecordOverlay(planOf([ownedStep(id, version, { title: { from: "New: x", to: "Rewritten by a feed" }, venue_text: { to: "planted" } })]), ctxOf(w, { policy }));
      assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { field: "type", external_id: UID("009") }], id);
      const after = await w.read(id, "ops");
      assert.equal(after.version, version, id);
      assert.equal(after.doc.frontmatter.title, "New: x", id);
    }
  });

  test(`B1 (${edition}) a forged owned-field step at a Task carrying the identity is refused and its assignee is unchanged`, async () => {
    const w = await overlayWorld({ edition, conventions: { "conventions/task": taskConvention(progressOf(edition)) } });
    const version = await w.put("tasks/review", { type: "Task", title: "Review", [progressOf(edition)]: "todo", sources: [{ resource: PROVIDER, id: UID("009") }] }, "Task body.\n");
    const policy = { ...w.policy, owned_fields: ["start", "assignee"] };
    const r = await applyRecordOverlay(planOf([ownedStep("tasks/review", version, { assignee: { to: "agent/feed" } })]), ctxOf(w, { policy }));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED");
    const after = await w.read("tasks/review");
    assert.deepEqual([after.version, after.doc.frontmatter.assignee], [version, undefined]);
  });
}

test("B1 owned-field plans need a declared target Kind that is not the attention Kind, refused before any write", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/story-time", event("009", STORY), EDITOR_BODY);
  const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
  const step = ownedStep("events/story-time", version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } });
  const { target_kind: _target, ...noTarget } = w.policy;
  for (const policy of [noTarget, { ...w.policy, target_kind: "Unknown Kind" }, { ...w.policy, target_kind: "Signal" }]) {
    await assert.rejects(applyRecordOverlay(planOf([createStep("signals/x", signalFm("0.2")), step]), ctxOf(w, { policy })), refusedWith("POLICY_INVALID"), JSON.stringify(policy.target_kind));
  }
  assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before);
  const honest = await applyRecordOverlay(planOf([step]), ctxOf(w));
  assert.equal(honest.results[0]!.outcome, "applied");
});

// ------------------------------------------------------------------------------- M1 held rows

test("M1 an honest record whose value fails v0.2 typing is a held row between two written rows; the receipt is complete", async () => {
  const w = await overlayWorld({ feed: { owned_fields: ["title", "start", "end", "event_status", "venue_text"] } });
  for (const n of ["101", "102", "103"]) await w.put(`events/e${n}`, event(n, { ...STORY, title: `Event ${n}` }), EDITOR_BODY);
  const before = (await w.read("events/e102")).version;
  const p = await planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, observedAt: AT, changes: [
    change(UID("101"), "changed", { ...STORY, title: "Event 101" }, { ...STORY, title: "Event 101", start: "2026-10-10T11:00:00-04:00" }, DIGEST("1")),
    change(UID("102"), "changed", { ...STORY, title: "Event 102" }, { ...STORY, title: 5 }, DIGEST("2")),
    change(UID("103"), "changed", { ...STORY, title: "Event 103" }, { ...STORY, title: "Event 103", start: "2026-10-10T12:00:00-04:00" }, DIGEST("3")),
  ] });
  assert.deepEqual(p.steps.map((s) => [s.op, s.target]), [["apply-owned-fields", "events/e101"], ["apply-owned-fields", "events/e102"], ["apply-owned-fields", "events/e103"]]);
  const r = await applyRecordOverlay(p, ctxOf(w));
  assert.deepEqual(r.results.map((x) => [x.target, x.outcome, x.code]), [["events/e101", "applied", undefined], ["events/e102", "refused", "INVALID_INPUT"], ["events/e103", "applied", undefined]]);
  assert.deepEqual([r.results[1]!.message, r.results[1]!.details], ["core refused a value in this step", { reason: "invalid-value" }]);
  assert.ok(HOLD_STORE.has("INVALID_INPUT"));
  assert.equal((await w.read("events/e102")).version, before);
  assert.equal((await w.read("events/e103")).doc.frontmatter.start, "2026-10-10T12:00:00-04:00");
});

test("M1 a new record with a numeric title raises its Signal with the title as text in the source entry", async () => {
  const w = await overlayWorld();
  const p = await planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, observedAt: AT, changes: [change(UID("110"), "new", null, { title: 2026, start: "2026-11-01T10:00:00-04:00" }, DIGEST("4"))] });
  const r = await applyRecordOverlay(p, ctxOf(w));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const sig = (await w.read(r.results[0]!.target!, "ops")).doc;
  assert.deepEqual([sig.frontmatter.title, (sig.frontmatter.sources as Array<{ title: unknown }>)[0]!.title], ["New: 2026", "2026"]);
});

test("M1 forged values core refuses on v0.2 are held rows after a good write, never a throw", async () => {
  const w = await overlayWorld();
  await w.put("events/market", event("002", { ...STORY, title: "Market" }), EDITOR_BODY);
  const market = (await w.read("events/market")).version;
  const good = { ...ownedStep("events/market", market, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }), external_id: UID("002") } as OverlayStep;
  const signal = await w.put("signals/open", signalFm("0.2"), `# Observations\n\n${obsLine()}\n`, "ops");
  const story = await w.put("events/story-time", event("009", STORY), EDITOR_BODY);
  const r = await applyRecordOverlay(planOf([
    good,
    createStep("signals/numeric", signalFm("0.2", { title: 5 })),
    createStep("signals/numeric-source", signalFm("0.2", { sources: [{ resource: PROVIDER, id: UID("009"), title: 5 }] })),
    collapseStep("signals/open", signal, { title: 5 }),
    ownedStep("events/story-time", story, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { sources: { usage_count: -1 } }),
  ]), ctxOf(w));
  assert.deepEqual(r.results.map((x) => x.outcome), ["applied", "refused", "refused", "refused", "refused"]);
  assert.deepEqual(r.results.slice(1).map((x) => x.code), ["INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT"]);
  assert.equal((await w.read("signals/open", "ops")).version, signal);
  assert.equal((await w.read("events/story-time")).version, story);
});

// ------------------------------------------------------------------------------- M2 the run's provider

test("M2 a collapse is bound to the run's provider: a forged plan.provider does not reach another provider's Signal", async () => {
  const w = await overlayWorld();
  const version = await w.put("signals/other", signalFm("0.2", { provider: OTHER }), `# Observations\n\n${obsLine()}\n`, "ops");
  const r = await applyRecordOverlay(planOf([collapseStep("signals/other", version, { title: "Changed: hijacked", priority: "urgent" })], { provider: OTHER }), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { field: "provider", external_id: UID("009") }]);
  assert.equal((await w.read("signals/other", "ops")).version, version);
});

test("M2 a create is bound to the run's provider and the step's record", async () => {
  const w = await overlayWorld();
  const before = await w.snapshot("ops");
  for (const [step, field] of [
    [createStep("signals/cross", signalFm("0.2", { provider: OTHER })), "provider"],
    [createStep("signals/cross", signalFm("0.2"), undefined, UID("010")), "external_id"],
  ] as const) {
    const r = await applyRecordOverlay(planOf([step], { provider: OTHER }), ctxOf(w));
    assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { field, external_id: step.external_id }]);
  }
  assert.deepEqual(await w.snapshot("ops"), before);
  await assert.rejects(applyRecordOverlay(planOf([createStep("signals/x", signalFm("0.2"))]), ctxOf(w, { policy: { owned_fields: [], provider: "" } })), refusedWith("POLICY_INVALID"));
});

test("M2 a Signal planted for another provider cannot suppress that provider's real Signal", async () => {
  const w = await overlayWorld();
  const digest = DIGEST("7");
  const planted = createStep("signals/planted", signalFm("0.2", { provider: OTHER, external_id: "o-9" }), `# Observations\n\n- ${AT} · new · ${digest} · new record\n`, "o-9");
  const r = await applyRecordOverlay(planOf([planted]), ctxOf(w));
  assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED");
  const other = readOverlayPolicy({ id: "source-feeds/other", frontmatter: { url: OTHER, target_kind: "Event", owned_fields: ["start"] } as unknown as Frontmatter }, { targetKind: w.content.registry.kinds.get("Event")! });
  const honest = await planRecordOverlay({ content: w.content, ops: w.ops, policy: other, observedAt: AT, changes: [change("o-9", "new", null, { title: "Other record" }, digest)] });
  assert.deepEqual(honest.steps.map((s) => s.op), ["create-signal"], "not a signal-duplicate of a planted Signal");
  assert.equal((await applyRecordOverlay(honest, ctxOf(w, { policy: other }))).results[0]!.outcome, "applied");
});

test("M2 a create whose id another provider's Signal holds is refused outright; this provider's own is the retryable type precondition", async () => {
  const w = await overlayWorld();
  const taken = await w.put("signals/taken", signalFm("0.2", { provider: OTHER }), `# Observations\n\n${obsLine()}\n`, "ops");
  const r = await applyRecordOverlay(planOf([createStep("signals/taken", signalFm("0.2"))]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["FIELD_NOT_OWNED", "create-signal target holds another provider's Signal", { field: "provider", external_id: UID("009") }]);
  assert.equal((await w.read("signals/taken", "ops")).version, taken);
  await w.put("signals/mine", signalFm("0.2"), `# Observations\n\n${obsLine()}\n`, "ops");
  const mine = await applyRecordOverlay(planOf([createStep("signals/mine", signalFm("0.2"))]), ctxOf(w));
  assert.deepEqual([mine.results[0]!.code, mine.results[0]!.message, mine.results[0]!.details], ["STALE_VERSION", "precondition on type no longer holds", { field: "type" }]);
});

// ------------------------------------------------------------------------------- m1 JSON data

test("m1 written plan values must be JSON data with finite numbers and no prototype keys, refused before any write", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/story-time", event("009", STORY), EDITOR_BODY);
  const signal = await w.put("signals/open", signalFm("0.2"), `# Observations\n\n${obsLine()}\n`, "ops");
  const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
  const good = ownedStep("events/story-time", version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } });
  const forged: OverlayStep[] = [
    ...[NaN, Infinity, -Infinity, -0].map((value) => ownedStep("events/story-time", version, { start: { to: "2026-10-10T11:00:00-04:00" } }, { sources: { revision: value } })),
    ownedStep("events/story-time", version, { start: { to: "x" } }, { sources: JSON.parse('{"__proto__": "x"}') }),
    ownedStep("events/story-time", version, { start: { to: "x" } }, { sources: { constructor: "x" } }),
    ...[NaN, () => 1, Symbol("s"), 10n, new Date(0), new Map(), [undefined]].map((to) => ownedStep("events/story-time", version, { venue_text: { to } })),
    ownedStep("events/story-time", version, JSON.parse('{"__proto__": {"to": "x"}}')),
    createStep("signals/y", { ...signalFm("0.2"), priority: () => "low" }),
    createStep("signals/y", JSON.parse(JSON.stringify(signalFm("0.2")).replace('"type"', '"__proto__":{"x":1},"type"'))),
    collapseStep("signals/open", signal, { title: Symbol("t") }),
    collapseStep("signals/open", signal, { priority: NaN }),
  ];
  for (const [index, step] of forged.entries()) {
    await assert.rejects(applyRecordOverlay(planOf([good, step]), ctxOf(w)), (e: unknown) => refusedWith("INVALID_INPUT")(e) && (e as OverlayRefusal).details.step === 1, `case ${index}`);
  }
  assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before, "nothing is written");
  await assert.rejects(planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, observedAt: AT, changes: [change(UID("009"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("1"))], hooks: { sourceProperties: () => ({ revision: NaN }) } }), refusedWith("INVALID_INPUT"));
});

// ------------------------------------------------------------------------------- m2 Signal text bounds

test("m2 observation lines refuse every line break; create bodies keep the planner's shape", async () => {
  const w = await overlayWorld();
  for (const breaker of [" ", " ", "\u0085"]) {
    const version = await w.put("signals/open", signalFm("0.2"), `# Observations\n\n${obsLine()}\n`, "ops");
    const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, { title: "Changed: x" }, `- ${AT} · changed · d · one${breaker}two`)]), ctxOf(w));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED", JSON.stringify(breaker));
    assert.equal((await w.read("signals/open", "ops")).version, version);
  }
  const free = "Free text an attacker wants every triager to read. ".repeat(100);
  const bodies = [
    `${free}\n\n# Observations\n\n${obsLine()}\n`,
    `[from feed](../source-feeds/x.md)\n\n# Observations\n\n${obsLine()}\n- second line\n`,
    `# Observations\n\n- 2020-01-01T00:00:00Z · new · d · old observation\n`,
    `${Array.from({ length: 9 }, (_, i) => `[link ${i}](../tasks/t${i}.md)`).join("\n")}\n\n# Observations\n\n${obsLine()}\n`,
    `[from feed](../source-feeds/x.md) injected\n\n# Observations\n\n${obsLine()}\n`,
    `# Observations\n\n${obsLine()}`,
  ];
  for (const body of bodies) {
    const r = await applyRecordOverlay(planOf([createStep("signals/forged-body", signalFm("0.2"), body)]), ctxOf(w));
    assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { fields: ["(body)"], external_id: UID("009") }], body.slice(0, 60));
  }
  const planned = [
    `[from feed](../source-feeds/synthetic-library.md)\nOverlay document (content bundle): \`events/x\`\nRelated document (content bundle): \`places/y\` (same street address)\n\nTo overlay this record, give a document of Kind "Event" the source entry \`resource: ${PROVIDER}\`, \`id: e-1\`.\n\n# Observations\n\n${obsLine()}\n`,
    `\n\n# Observations\n\n${obsLine()}\n`,
  ];
  for (const [index, body] of planned.entries()) {
    const r = await applyRecordOverlay(planOf([createStep(`signals/planned-${index}`, signalFm("0.2"), body)]), ctxOf(w));
    assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  }
});
