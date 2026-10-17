/**
 * Record-overlay cases added after the exact-SHA review: the site `assertCandidate` hook wired
 * through the apply (M1), forged plans refused before any write (M2), the target's work state never
 * ownable (M3), claim coordinates, Signal bodies, mixed editions and multi-entry sources (m1), the
 * shared identity rule (m3), and the bounded Signal update (m4).
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { Frontmatter, OkfDocument, Version } from "../src/types.js";
import { matchesSourceIdentity, sourceIdentityOf } from "../src/query-filter.js";
import {
  applyRecordOverlay,
  HOLD_STORE,
  ownershipGuard,
  OverlayRefusal,
  planFindings,
  planRecordOverlay,
  readOverlayPolicy,
  SourceIndex,
  type ApplyContext,
  type CollapseSignalStep,
  type CreateSignalStep,
  type OverlayHooks,
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
  signalConvention,
  taskConvention,
  UID,
  updatedAtStamp,
  type World,
} from "./record-overlay-helpers.js";

const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const AT = "2026-10-03T14:00:00Z";
const LATER = "2026-10-10T11:00:00-04:00";
const planOf = (steps: OverlayStep[], over: Partial<OverlayPlan> = {}): OverlayPlan => ({ feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps, ...over });
const ctxOf = (w: World, over: Partial<ApplyContext> = {}): ApplyContext => ({ content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR, ...over });
const refusedWith = (code: string) => (e: unknown) => e instanceof OverlayRefusal && e.code === code;
const SIGNAL_FM = { type: "Signal", title: "New: x", superbee_progress_status: "todo", change_kind: "new", observed_at: AT, provider: PROVIDER, external_id: UID("009"), diff_summary: "new record", priority: "low", sources: [{ resource: PROVIDER, id: UID("009") }] };
const line = (text = "changed") => `- ${AT} · changed · ${DIGEST("8")} · ${text}`;

const overlaid = (w: World, fm: Record<string, unknown> = {}): Promise<Version> => w.put("events/story-time", event("001", { ...STORY, ...fm }), EDITOR_BODY);
function ownedStep(version: Version, fields: Record<string, { from?: unknown; to?: unknown }>, over: Record<string, unknown> = {}): OverlayStep {
  return { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), change_kind: "changed", fields, ...over } as OverlayStep;
}
const startStep = (version: Version, over: Record<string, unknown> = {}) => ownedStep(version, { start: { from: STORY.start, to: LATER } }, over);
function createStep(target: string, frontmatter: Record<string, unknown> = SIGNAL_FM): CreateSignalStep {
  return { op: "create-signal", target, external_id: UID("009"), content_digest: DIGEST("9"), reasons: ["test"], candidate: { frontmatter: frontmatter as OkfDocument["frontmatter"], body: `\n\n# Observations\n\n- ${AT} · new · ${DIGEST("9")} · new record\n` } };
}
/** A collapse as the planner renders it: the update carries its observation time and summary, and the line is rendered from them. */
function collapseStep(target: string, version: Version, set: Record<string, unknown>, observation = line(), over: Partial<CollapseSignalStep> = {}): CollapseSignalStep {
  return { op: "collapse-signal", target, expected_version: version, external_id: UID("009"), content_digest: DIGEST("8"), progress_field: "superbee_progress_status", observation_line: observation, set: { observed_at: AT, diff_summary: "changed", ...set }, ...over };
}
const typeViolation = () => new OverlayRefusal("FIELD_TYPE_VIOLATION", "candidate violates declared field types: start (datetime)", { kind: "Event", violations: [{ field: "start", type: "datetime", code: "KIND_FIELD_TYPE" }] });

// ------------------------------------------------------------------------------- M1 the site hook

test("M1 the site hook runs once per write with its step and bundle, after the core guards; a sync or async refusal is a held row", async () => {
  const w = await overlayWorld();
  let version = await overlaid(w);
  const signalVersion = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n\n- first\n", "ops");
  const calls: Array<[string, string, boolean]> = [];
  const recording: OverlayHooks["assertCandidate"] = (existing, _candidate, context) => { calls.push([context.step, context.bundle, existing !== undefined]); };
  const r = await applyRecordOverlay(planOf([startStep(version), createStep("signals/new"), collapseStep("signals/open", signalVersion, { title: "Changed: x" })]), ctxOf(w, { hooks: { assertCandidate: recording } }));
  assert.deepEqual(r.results.map((x) => x.outcome), ["applied", "applied", "applied"]);
  assert.deepEqual(calls, [["apply-owned-fields", "content", true], ["create-signal", "ops", false], ["collapse-signal", "ops", true]]);

  version = (await w.read("events/story-time")).version;
  calls.length = 0;
  const forged = await applyRecordOverlay(planOf([ownedStep(version, { title: { from: STORY.title, to: "Hijacked" } })]), ctxOf(w, { hooks: { assertCandidate: recording } }));
  assert.equal(forged.results[0]!.code, "FIELD_NOT_OWNED");
  assert.deepEqual(calls, [], "a core guard refusal wins and the site hook never runs");

  for (const hook of [() => { throw typeViolation(); }, async () => { await Promise.resolve(); throw typeViolation(); }] as Array<NonNullable<OverlayHooks["assertCandidate"]>>) {
    const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
    const held = await applyRecordOverlay(planOf([ownedStep(version, { start: { from: LATER, to: "2026-10-10T12:00:00-04:00" } }), createStep("signals/held")]), ctxOf(w, { hooks: { assertCandidate: hook } }));
    assert.deepEqual(held.results.map((x) => x.code), ["FIELD_TYPE_VIOLATION", "FIELD_TYPE_VIOLATION"]);
    assert.deepEqual(held.results[0]!.details, { kind: "Event", violations: [{ field: "start", type: "datetime", code: "KIND_FIELD_TYPE" }] });
    assert.ok(HOLD_STORE.has("FIELD_TYPE_VIOLATION"));
    assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before, "bytes and versions unchanged");
  }
});

// ------------------------------------------------------------------------------- M2 forged plans

test("M2 grouped steps naming metadata are refused FIELD_NOT_OWNED on the fresh read, never thrown", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = await w.snapshot();
  for (const field of ["timestamp", "actor", "verified", "superbee_updated_by", "generated", "title"]) {
    const r = await applyRecordOverlay(planOf([ownedStep(version, { [field]: { to: "x" } }, { sources: { revision: "r1" } })]), ctxOf(w, { hooks: { deriveFields: updatedAtStamp(w.content.registry) } }));
    assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { fields: [field], external_id: UID("001") }], field);
  }
  assert.deepEqual(await w.snapshot(), before);
});

test("M2 step sources that are not scalar or name the identity, and non-canonical targets, are refused before any write", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const signalVersion = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n", "ops");
  const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
  const forged: OverlayStep[] = [
    startStep(version, { sources: { revision: ["a"] } }),
    startStep(version, { sources: { revision: { nested: "x" } } }),
    startStep(version, { sources: { revision: null } }),
    startStep(version, { sources: { resource: "https://evil.example" } }),
    startStep(version, { sources: { id: "other" } }),
    startStep(version, { target: "events/../tasks/x" }),
    createStep("signals/../tasks/x"),
    createStep("signals//x"),
    createStep("/signals/x"),
    collapseStep("signals/../tasks/x", signalVersion, { title: "x" }),
    { op: "signal-duplicate", target: "signals/../x", external_id: "x", content_digest: "d" },
  ];
  for (const [index, step] of forged.entries()) {
    // A good step first: the plan is refused as a whole, so even it is not written.
    await assert.rejects(applyRecordOverlay(planOf([startStep(version), step]), ctxOf(w)), (e: unknown) => refusedWith("INVALID_INPUT")(e) && (e as OverlayRefusal).details.step === 1, `case ${index}`);
  }
  assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before, "nothing is written");
});

test("M2 a good step then a forged grouped metadata step: the good write lands, the forged one is a refused row, the receipt is complete", async () => {
  const w = await overlayWorld();
  await w.put("events/market", event("002", { ...STORY, title: "Market" }), EDITOR_BODY);
  const market = (await w.read("events/market")).version;
  const version = await overlaid(w);
  const good = { ...startStep(market), target: "events/market", external_id: UID("002") } as OverlayStep;
  const r = await applyRecordOverlay(planOf([good, ownedStep(version, { timestamp: { to: AT } }, { sources: { revision: "r1" } })]), ctxOf(w));
  assert.deepEqual(r.results.map((x) => [x.target, x.outcome, x.code]), [["events/market", "applied", undefined], ["events/story-time", "refused", "FIELD_NOT_OWNED"]]);
  assert.equal((await w.read("events/story-time")).version, version);
});

// ------------------------------------------------------------------------------- M3 work state

test("M3 readOverlayPolicy refuses the target Kind's progress and claim fields; a presentation feed may still own status", () => {
  const work = { id: "conventions/task", title: "Task", governs: "Task", claim: { ownerField: "assignee", stateField: "progress_status" }, fields: { required: ["title", "superbee_progress_status"], optional: ["assignee", "priority", "claimed_by"] } } as never;
  const read = (owned: string[], kind = work) => readOverlayPolicy({ id: "source-feeds/tasks", frontmatter: { url: PROVIDER, target_kind: "Task", owned_fields: owned } as unknown as Frontmatter }, { targetKind: kind });
  for (const owned of [["superbee_progress_status"], ["assignee"], ["priority", "assignee"]]) {
    assert.throws(() => read(owned), (e: unknown) => refusedWith("POLICY_INVALID")(e) && /work state of Task/.test((e as Error).message), owned.join());
  }
  const otherOwner = { id: "conventions/job", title: "Job", governs: "Job", claim: { ownerField: "claimed_by", stateField: "progress_status" }, fields: { required: ["title", "status"], optional: ["claimed_by", "assignee"] } } as never;
  assert.throws(() => read(["claimed_by"], otherOwner), refusedWith("POLICY_INVALID"));
  assert.deepEqual(read(["assignee"], otherOwner).owned_fields, ["assignee"], "assignee is only work state where the Kind claims through it");
  assert.deepEqual(read(["priority"]).owned_fields, ["priority"]);
  const condition = readOverlayPolicy({ id: "source-feeds/conditions", frontmatter: { url: PROVIDER, owned_fields: ["status", "level"] } as unknown as Frontmatter }, { presentationFields: ["status", "level"] });
  assert.deepEqual(condition.owned_fields, ["status", "level"]);
});

test("M3 the apply entry refuses owning the target's progress or claim fields; the screen runs only for plans with owned-field steps", async () => {
  const w = await overlayWorld({ conventions: { "conventions/task": taskConvention("superbee_progress_status") } });
  const task = await w.put("tasks/write-docs", { type: "Task", title: "Write docs", superbee_progress_status: "todo", sources: [{ resource: PROVIDER, id: UID("001") }] }, "Task body.\n");
  const before = await w.snapshot();
  const taskPolicy = { owned_fields: ["title"], provider: PROVIDER, target_kind: "Task" };
  const step = (fields: Record<string, { from?: unknown; to?: unknown }>) => ownedStep(task, fields, { target: "tasks/write-docs" });
  for (const field of ["superbee_progress_status", "assignee"]) {
    await assert.rejects(
      applyRecordOverlay(planOf([step({ [field]: { to: "done" } })]), ctxOf(w, { policy: { ...taskPolicy, owned_fields: ["title", field] } })),
      (e: unknown) => refusedWith("POLICY_INVALID")(e) && JSON.stringify((e as OverlayRefusal).details) === JSON.stringify({ list: "owned_fields", fields: [field] }),
      field,
    );
  }
  await assert.rejects(applyRecordOverlay(planOf([startStep((await w.read("tasks/write-docs")).version)]), ctxOf(w, { policy: { ...w.policy, owned_fields: ["start", "superbee_progress_status"] } })), refusedWith("POLICY_INVALID"), "the progress storage fields are refused whatever the target Kind");
  await assert.rejects(applyRecordOverlay(planOf([step({ title: { to: "x" } })]), ctxOf(w, { policy: taskPolicy, hooks: { deriveFields: { fields: ["assignee"], derive: () => ({}) } } })), refusedWith("POLICY_INVALID"));
  assert.throws(() => ownershipGuard({ ownedFields: ["superbee_progress_status"], provider: PROVIDER, externalId: "x" }), refusedWith("POLICY_INVALID"));
  assert.deepEqual(await w.snapshot(), before);
  const condition = await applyRecordOverlay(planOf([createStep("signals/condition")]), ctxOf(w, { policy: { owned_fields: ["status", "superbee_progress_status", "assignee", "level"], provider: PROVIDER } }));
  assert.equal(condition.results[0]!.outcome, "applied", "a Condition-style plan of Signal steps alone is not screened");
});

// ------------------------------------------------------------------------------- m1 coordinates, bodies, editions, sources

test("m1 collapse preconditions come from the attention Kind's claim, not from the step", async () => {
  const w = await overlayWorld();
  const claimed = await w.put("signals/claimed", { ...SIGNAL_FM, superbee_progress_status: "in_progress" }, "# Observations\n", "ops");
  const r = await applyRecordOverlay(planOf([collapseStep("signals/claimed", claimed, { title: "x" }, line(), { progress_field: "status" })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["SIGNAL_CLAIMED", { field: "superbee_progress_status" }]);
  const open = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n", "ops");
  const ok = await applyRecordOverlay(planOf([collapseStep("signals/open", open, { title: "Changed: x" }, line(), { progress_field: "bogus" })]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied");
});

test("m1 an attention Kind whose owner field is not assignee: claims and open Signals follow its declared owner", async () => {
  const fields = { required: ["title", "superbee_progress_status", "change_kind", "observed_at"], optional: ["provider", "external_id", "diff_summary", "priority", "claimed_by", "assignee", "content_digest", "about_doc"] };
  const w = await overlayWorld({ signal: signalConvention("superbee_progress_status", { claim: { owner_field: "claimed_by", state_field: "progress_status" }, fields }) });
  const claimed = await w.put("signals/claimed", { ...SIGNAL_FM, external_id: UID("021"), claimed_by: "agent/x" }, `# Observations\n\n- old\n`, "ops");
  await w.put("signals/assigned", { ...SIGNAL_FM, external_id: UID("022"), assignee: "agent/y" }, `# Observations\n\n- old\n`, "ops");
  const p = await planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, observedAt: AT, changes: [
    change(UID("021"), "canceled", { title: "A", event_status: "scheduled" }, { title: "A", event_status: "canceled" }, DIGEST("1")),
    change(UID("022"), "canceled", { title: "B", event_status: "scheduled" }, { title: "B", event_status: "canceled" }, DIGEST("2")),
  ] });
  assert.deepEqual(p.steps.map((s) => [s.op, s.target?.startsWith("signals/") ? (s.op === "create-signal" ? "new" : s.target) : s.target]), [["create-signal", "new"], ["collapse-signal", "signals/assigned"]]);
  const r = await applyRecordOverlay(planOf([collapseStep("signals/claimed", claimed, { title: "x" })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["SIGNAL_CLAIMED", { field: "claimed_by" }]);
});

test("m1 a Signal body ending in blank lines gains exactly one observation line", async () => {
  const w = await overlayWorld();
  const version = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n\n- first\n\n\n", "ops");
  const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, { title: "Changed: x" })]), ctxOf(w));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  assert.equal((await w.read("signals/open", "ops")).doc.body, `# Observations\n\n- first\n${line()}\n`);
});

test("m1 separate ops and content bundles on different editions each write their own edition's shape", async () => {
  const mixed = await overlayWorld({ edition: "0.2", opsEdition: "0.1" });
  await overlaid(mixed);
  const changes = [change(UID("001"), "canceled", STORY, { ...STORY, event_status: "canceled" }, DIGEST("3"))];
  const r = await applyRecordOverlay(await planRecordOverlay({ content: mixed.content, ops: mixed.ops, policy: mixed.policy, changes, observedAt: AT }), ctxOf(mixed));
  assert.deepEqual(r.results.map((x) => x.outcome), ["applied", "applied"]);
  assert.equal(((await mixed.read("events/story-time")).doc.frontmatter.generated as { by: string }).by, ACTOR, "the v0.2 content write carries generated");
  const sig = Object.keys(await mixed.snapshot("ops")).find((id) => id.startsWith("signals/"))!;
  assert.equal((await mixed.read(sig, "ops")).doc.frontmatter.status, "todo", "the v0.1 ops Signal claims through status");

  const reverse = await overlayWorld({ edition: "0.1", opsEdition: "0.2" });
  const version = await overlaid(reverse);
  const grouped = await applyRecordOverlay(planOf([startStep(version, { sources: { revision: "r1" } }), createStep("signals/x")]), ctxOf(reverse));
  assert.deepEqual([grouped.results[0]!.code, grouped.results[0]!.details, grouped.results[1]!.outcome], ["INVALID_INPUT", { reason: "grouped-shape-needs-v0.2", field: "sources" }, "applied"]);
});

test("m1 the grouped shape reads list-valued properties from the identity entry only, among several entries", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/story-time", { ...event("001", STORY), sources: [{ resource: OTHER, id: "o-1", tags: ["x"] }, { resource: PROVIDER, id: UID("001"), title: "feed record" }] }, EDITOR_BODY);
  const ok = await applyRecordOverlay(planOf([startStep(version, { sources: { tags: "b" } })]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied", JSON.stringify(ok.results[0]));
  assert.deepEqual((await w.read("events/story-time")).doc.frontmatter.sources, [{ resource: OTHER, id: "o-1", tags: ["x"] }, { resource: PROVIDER, id: UID("001"), title: "feed record", tags: "b" }]);
  const w2 = await overlayWorld();
  const v2 = await w2.put("events/story-time", { ...event("001", STORY), sources: [{ resource: OTHER, id: "o-1" }, { resource: PROVIDER, id: UID("001"), tags: ["a"] }] }, EDITOR_BODY);
  const listed = await applyRecordOverlay(planOf([startStep(v2, { sources: { tags: "b" } })]), ctxOf(w2));
  assert.deepEqual(listed.results[0]!.details, { reason: "list-valued-source-property", field: "sources" });
});

// ------------------------------------------------------------------------------- m3 one identity rule

test("m3 sourceIdentityOf is the one reading of an entry's identity, shared by matchesSourceIdentity and SourceIndex", () => {
  const entries: unknown[] = [
    { resource: PROVIDER, id: "r" }, { resource: PROVIDER }, { id: "r" }, { resource: PROVIDER, id: 7 }, { resource: 1, id: "r" },
    Object.create({ resource: PROVIDER, id: "r" }), null, "r", [PROVIDER, "r"], {},
  ];
  assert.deepEqual(entries.map(sourceIdentityOf), [{ resource: PROVIDER, id: "r" }, { resource: PROVIDER }, { id: "r" }, { resource: PROVIDER }, { id: "r" }, {}, undefined, undefined, undefined, {}]);
  const index = SourceIndex.fromHeads(entries.map((entry, i) => ({ id: `events/e${i}`, frontmatter: { type: "Event", sources: [entry] } as never, version: `v${i}` })));
  const indexed = entries.map((_, i) => index.lookup(PROVIDER, "r").some((h) => h.id === `events/e${i}`));
  assert.deepEqual(indexed, entries.map((entry) => matchesSourceIdentity(entry, { resource: PROVIDER, id: "r" })));
  assert.deepEqual(indexed, [true, false, false, false, false, false, false, false, false, false]);
});

// ------------------------------------------------------------------------------- m4 the bounded Signal update

test("m4 a collapse needs the run's provider (refused) and an observation line rendered from its update (held otherwise)", async () => {
  const w = await overlayWorld();
  for (const [name, fm, observation, code] of [
    ["another provider", { ...SIGNAL_FM, provider: OTHER }, line(), "FIELD_NOT_OWNED"],
    ["an injected line", SIGNAL_FM, `${line()}\n- injected`, "INVALID_INPUT"],
    ["a carriage return", SIGNAL_FM, `${line()}\r- injected`, "INVALID_INPUT"],
    ["another observation", SIGNAL_FM, `- 2026-01-01T00:00:00Z · changed · ${DIGEST("8")} · changed`, "INVALID_INPUT"],
    ["another digest", SIGNAL_FM, `- ${AT} · changed · ${DIGEST("7")} · changed`, "INVALID_INPUT"],
    ["no prefix", SIGNAL_FM, "free text", "INVALID_INPUT"],
  ] as Array<[string, Record<string, unknown>, string, string]>) {
    const version = await w.put("signals/open", fm, "# Observations\n", "ops");
    const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, { title: "Changed: x" }, observation)]), ctxOf(w));
    assert.equal(r.results[0]!.code, code, name);
    if (code === "INVALID_INPUT") assert.deepEqual(r.results[0]!.details, { reason: "signal-text-not-planned", field: "(body)" }, name);
    assert.equal((await w.read("signals/open", "ops")).version, version, name);
  }
});

test("m4 a findings collapse whose plan carries the unredacted provider still matches its redacted Signal", async () => {
  const w = await overlayWorld();
  const provider = "https://status.example.org/api?token=secret-77";
  const run = async (facts: unknown, observedAt: string) => {
    const steps = await planFindings({ ops: w.ops, provider, slug: "status", observedAt, findings: [{ key: "places/a", title: "Check places/a", facts }] });
    return applyRecordOverlay({ feed: null, provider, observed_at: observedAt, steps, refusals: [] }, { content: w.ops, ops: w.ops, policy: { owned_fields: [], provider }, actor: ACTOR });
  };
  assert.deepEqual((await run({ open: false }, "2026-10-11T02:00:00Z")).results.map((x) => [x.op, x.outcome]), [["create-signal", "applied"]]);
  assert.deepEqual((await run({ open: false, moved: true }, "2026-10-12T02:00:00Z")).results.map((x) => [x.op, x.outcome]), [["collapse-signal", "applied"]]);
});
