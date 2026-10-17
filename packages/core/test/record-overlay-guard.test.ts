/**
 * The record-overlay guards, one case per clause, each proving the refusal and that no document's
 * bytes or version changed: the ownership guard (G1 to G5, G8), plan validation (G7), the Signal
 * create and update guards (G6, G9, G10, including a claimable Kind that is not an attention
 * record), the apply-entry screen (G11, run only for plans with owned-field steps), the narrowed
 * INVALID_INPUT mapping, a concurrent editor between plan and apply, and never-create/never-delete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OkfDocument, Version } from "../src/types.js";
import { resolveAttentionKind } from "../src/record-overlay/signal-kind.js";
import { signalCreateGuard, signalUpdateGuard } from "../src/record-overlay/apply.js";
import {
  applyRecordOverlay,
  composeGuards,
  HOLD_STORE,
  ownershipGuard,
  OverlayRefusal,
  planRecordOverlay,
  REFUSAL_CODES,
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
  signalConvention,
  statedEndElseThreeHours,
  taskConvention,
  UID,
  updatedAtStamp,
  type World,
} from "./record-overlay-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STORY = { title: "Story Time", start: "2026-10-10T10:00:00-04:00", end: "2026-10-10T11:00:00-04:00", event_status: "scheduled" };
const AT = "2026-10-03T14:00:00Z";
const planOf = (steps: OverlayStep[]): OverlayPlan => ({ feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps });
const ctxOf = (w: World, over: Partial<ApplyContext> = {}): ApplyContext => ({ content: w.content, ops: w.ops, policy: w.policy, actor: ACTOR, ...over });
const refusedWith = (code: string) => (e: unknown) => e instanceof OverlayRefusal && e.code === code;

async function overlaid(w: World, fm: Record<string, unknown> = {}): Promise<Version> {
  return w.put("events/story-time", event("001", { ...STORY, ...fm }), EDITOR_BODY);
}
function ownedStep(version: Version, fields: Record<string, { from: unknown; to: unknown }>, over: Partial<OverlayStep> = {}): OverlayStep {
  return { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), change_kind: "changed", fields, ...over } as OverlayStep;
}
function createStep(target: string, frontmatter: Record<string, unknown>): CreateSignalStep {
  return { op: "create-signal", target, external_id: UID("009"), content_digest: DIGEST("9"), reasons: ["test"], candidate: { frontmatter: frontmatter as OkfDocument["frontmatter"], body: `\n\n# Observations\n\n- ${AT} · new · ${DIGEST("9")} · new record\n` } };
}
const SIGNAL_FM = { type: "Signal", title: "New: x", superbee_progress_status: "todo", change_kind: "new", observed_at: AT, provider: PROVIDER, external_id: UID("009"), diff_summary: "new record", priority: "low", sources: [{ resource: PROVIDER, id: UID("009") }] };
/** A collapse as the planner renders it: the update carries its observation time and summary, and the line is rendered from them. */
function collapseStep(target: string, version: Version, set: Record<string, unknown>, line?: string): CollapseSignalStep {
  const update = { observed_at: AT, diff_summary: "changed", ...set };
  return { op: "collapse-signal", target, expected_version: version, external_id: UID("009"), content_digest: DIGEST("8"), progress_field: "superbee_progress_status", observation_line: line ?? `- ${AT} · changed · ${DIGEST("8")} · ${update.diff_summary}`, set: update };
}

// ------------------------------------------------------------------------------- the ownership guard

test("G1 a non-owned scalar is refused FIELD_NOT_OWNED on the fresh read; bytes and version unchanged", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = await w.snapshot();
  const r = await applyRecordOverlay(planOf([ownedStep(version, { title: { from: STORY.title, to: "Hijacked" } })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["FIELD_NOT_OWNED", "write would change non-owned fields: title", { fields: ["title"], external_id: UID("001") }]);
  assert.deepEqual(await w.snapshot(), before);
});

test("G2 a step that writes status or type is refused FIELD_NOT_OWNED; the overlay never receives status", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = await w.snapshot();
  for (const fields of [{ status: { from: undefined, to: "archived" } }, { type: { from: "Event", to: "Task" } }]) {
    const r = await applyRecordOverlay(planOf([ownedStep(version, fields)]), ctxOf(w));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED");
  }
  assert.deepEqual(await w.snapshot(), before);
  assert.equal((await w.read("events/story-time")).doc.frontmatter.status, undefined);
});

test("G3 the body is never owned: a candidate body change is refused", () => {
  const guard = ownershipGuard({ ownedFields: ["start"], provider: PROVIDER, externalId: "rec-1" });
  const doc = (body: string): OkfDocument => ({ id: "events/x", frontmatter: { type: "Event", start: "x", sources: [{ resource: PROVIDER, id: "rec-1" }] } as never, body });
  assert.throws(() => guard(doc("a\n"), doc("b\n")), (e: unknown) => refusedWith("FIELD_NOT_OWNED")(e) && (e as OverlayRefusal).details.fields!.toString() === "(body)");
  guard(doc("a\n"), doc("a\n"));
});

test("G4 the fresh read must still carry the exact (provider, id) identity, synchronously", () => {
  const guard = ownershipGuard({ ownedFields: ["start"], provider: PROVIDER, externalId: "rec-1" });
  const doc = (sources: unknown): OkfDocument => ({ id: "events/x", frontmatter: { type: "Event", start: "x", sources } as never, body: "" });
  const pass = (sources: unknown) => guard(doc(sources), doc(sources));
  const lost = (sources: unknown) => assert.throws(() => pass(sources), refusedWith(REFUSAL_CODES.OVERLAY_IDENTITY_LOST));
  assert.equal(pass([{ resource: OTHER, id: "x" }, { resource: PROVIDER, id: "rec-1", title: "t" }]), undefined);
  lost([{ resource: OTHER, id: "rec-1" }]);
  lost([{ resource: PROVIDER, id: "rec-2" }]);
  lost([{ resource: PROVIDER }]);
  lost([null, "rec-1"]);
  lost({ resource: PROVIDER, id: "rec-1" });
  lost(undefined);
  assert.throws(() => guard(undefined, doc([])), refusedWith(REFUSAL_CODES.OVERLAY_IDENTITY_LOST));
});

test("G4 an overlay deleted between plan and apply is OVERLAY_IDENTITY_LOST", async () => {
  const w = await overlayWorld();
  await overlaid(w);
  const p = await planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, changes: [change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("1"))], observedAt: AT });
  await w.contentBackend.delete("events/story-time");
  const r = await applyRecordOverlay({ ...p, steps: p.steps.filter((s) => s.op === "apply-owned-fields") }, ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message], ["OVERLAY_IDENTITY_LOST", "document not found"]);
});

test("G5 in the grouped shape sources may change only by the record's own upsert", () => {
  const props = { revision: "r2" };
  const guard = ownershipGuard({ ownedFields: ["start"], provider: PROVIDER, externalId: "rec-1", sourceProperties: props });
  const fresh = [{ resource: OTHER, id: "o" }, { resource: PROVIDER, id: "rec-1", title: "t", revision: "r1" }, { resource: OTHER, id: "p" }];
  const doc = (sources: unknown): OkfDocument => ({ id: "events/x", frontmatter: { type: "Event", start: "x", sources } as never, body: "" });
  const upserted = [fresh[0], { ...fresh[1], revision: "r2" }, fresh[2]];
  guard(doc(fresh), doc(upserted));
  const refused = (next: unknown) => assert.throws(() => guard(doc(fresh), doc(next)), (e: unknown) => refusedWith("FIELD_NOT_OWNED")(e) && String((e as OverlayRefusal).details.fields) === "sources");
  refused([{ resource: OTHER, id: "o", title: "changed" }, upserted[1], fresh[2]]);
  refused([upserted[1], fresh[2]]);
  refused([fresh[0], { ...upserted[1], id: "rec-2" }, fresh[2]]);
  refused([...upserted, { resource: OTHER, id: "q" }]);
  refused([upserted[1], fresh[0], fresh[2]]);
  refused([fresh[0], { ...upserted[1], extra: "x" }, fresh[2]]);
  const twice = [fresh[1], { ...fresh[1], title: "again" }];
  assert.throws(() => guard(doc(twice), doc([{ ...twice[0], revision: "r2" }, twice[1]])), refusedWith("FIELD_NOT_OWNED"), "an identity carried twice is never upserted");
  assert.throws(() => guard(doc({ resource: PROVIDER, id: "rec-1" }), doc(upserted)), refusedWith("FIELD_NOT_OWNED"), "fresh sources not a list");
  assert.throws(() => guard(doc(fresh), doc({ resource: PROVIDER, id: "rec-1", revision: "r2" })), refusedWith("FIELD_NOT_OWNED"), "candidate sources not a list");
  const withTitle = (sources: unknown, title: string): OkfDocument => ({ id: "events/x", frontmatter: { type: "Event", start: "x", title, sources } as never, body: "" });
  assert.throws(() => guard(withTitle(fresh, "T"), withTitle(upserted, "Hijacked")), (e: unknown) => refusedWith("FIELD_NOT_OWNED")(e) && String((e as OverlayRefusal).details.fields) === "title", "an admitted upsert admits nothing else");
  const patchShape = ownershipGuard({ ownedFields: ["start"], provider: PROVIDER, externalId: "rec-1" });
  assert.throws(() => patchShape(doc(fresh), doc(upserted)), refusedWith("FIELD_NOT_OWNED"), "without step properties sources are never admitted");
});

test("G8 a moved owned field behind a forged matching version is OVERLAY_DOC_CONFLICT (a backend wrapper returns the planned token for a changed document)", async () => {
  const w = await overlayWorld();
  const planned = await overlaid(w);
  await w.edit("events/story-time", { start: "2026-10-10T10:30:00-04:00" });
  const moved = await w.snapshot();
  const backend = w.contentBackend;
  const realRead = backend.read.bind(backend);
  backend.read = async (id) => { const r = await realRead(id); return id === "events/story-time" ? { ...r, version: planned } : r; };
  const r = await applyRecordOverlay(planOf([ownedStep(planned, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } })]), ctxOf(w));
  backend.read = realRead;
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["OVERLAY_DOC_CONFLICT", { field: "start", external_id: UID("001") }]);
  assert.deepEqual(await w.snapshot(), moved);
});

// ------------------------------------------------------------------------------- plan validation

test("G7 a plan with an unknown or malformed step is refused before any write", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
  const good = createStep("signals/synthetic-library-x", SIGNAL_FM);
  const bad: unknown[] = [
    { op: "delete-document", target: "events/story-time" },
    { op: "apply-owned-fields", target: "events/story-time", external_id: UID("001"), fields: { start: { from: 1, to: 2 } } },
    { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), fields: {} },
    { op: "create-signal", target: "signals/y" },
    { op: "collapse-signal", target: "signals/y", expected_version: "v", set: {} },
    null,
  ];
  for (const step of bad) {
    await assert.rejects(applyRecordOverlay(planOf([good, step as OverlayStep]), ctxOf(w)), refusedWith("INVALID_INPUT"));
  }
  assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before);
});

test("the actor and the bundle editions are validated once at entry, before any write", async () => {
  const w = await overlayWorld();
  await assert.rejects(applyRecordOverlay(planOf([createStep("signals/x", SIGNAL_FM)]), ctxOf(w, { actor: "not an actor" })), refusedWith("INVALID_INPUT"));
  await w.contentBackend.writeReserved("", "index.md", "---\nokf_version: '0.9'\n---\n# future\n", {});
  await assert.rejects(applyRecordOverlay(planOf([createStep("signals/x", SIGNAL_FM)]), ctxOf(w)), refusedWith("INVALID_INPUT"));
  assert.equal(Object.keys(await w.snapshot()).filter((id) => id.startsWith("signals/")).length, 0);
});

// ------------------------------------------------------------------------------- the Signal guards

test("G6 a create-signal candidate of another Kind is refused and nothing is created", async () => {
  const w = await overlayWorld();
  const before = await w.snapshot("ops");
  const r = await applyRecordOverlay(planOf([createStep("signals/forged", { ...SIGNAL_FM, type: "Event" })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["FIELD_NOT_OWNED", "record-overlay may only create Signal documents", { external_id: UID("009") }]);
  assert.deepEqual(await w.snapshot("ops"), before);
});

test("G9 the update guard: a collapse aimed at an unclaimed todo Task in a shared bundle is refused", async () => {
  const w = await overlayWorld({ conventions: { "conventions/task": taskConvention("superbee_progress_status") } });
  const version = await w.put("tasks/write-docs", { type: "Task", title: "Write docs", superbee_progress_status: "todo" }, "Task body.\n", "ops");
  const before = await w.snapshot("ops");
  const r = await applyRecordOverlay(planOf([collapseStep("tasks/write-docs", version, { status: "done", type: "Signal", title: "Hijacked" })]), ctxOf(w));
  assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED");
  assert.deepEqual(await w.snapshot("ops"), before);
});

test("G9 the update guard: a collapse may set only the attention update fields", async () => {
  const w = await overlayWorld();
  const signal = { ...SIGNAL_FM };
  for (const set of [{ status: "done" }, { type: "Task" }, { title: "x", assignee: "agent/me" }, { superbee_progress_status: "done" }, { sources: [] }]) {
    const version = await w.put("signals/open", signal, "# Observations\n\n- first\n", "ops");
    const before = await w.snapshot("ops");
    const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, set)]), ctxOf(w));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED", JSON.stringify(set));
    assert.deepEqual(await w.snapshot("ops"), before);
  }
  const version = (await w.read("signals/open", "ops")).version;
  const ok = await applyRecordOverlay(planOf([collapseStep("signals/open", version, { title: "Changed: x", change_kind: "changed", priority: "normal", diff_summary: "d", observed_at: AT })]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied");
  assert.match((await w.read("signals/open", "ops")).doc.body, /- first\n- 2026-10-03T14:00:00Z · changed · /);
});

test("G9 the update guard: the body may only gain the one observation line; a Signal outside the path is refused", async () => {
  const w = await overlayWorld();
  const attention = resolveAttentionKind(w.ops.registry, "0.2", "Signal", "Event");
  const line = `- ${AT} · changed · ${DIGEST("8")} · one line`;
  const observation = { observedAt: AT, provider: PROVIDER };
  const step = collapseStep("signals/open", "v", { diff_summary: "one line" }, line);
  const guard = signalUpdateGuard(attention, step, observation);
  const fresh: OkfDocument = { id: "signals/open", frontmatter: { ...SIGNAL_FM } as never, body: "# Observations\n\n- first\n\n" };
  guard(fresh, { frontmatter: fresh.frontmatter, body: fresh.body });
  guard(fresh, { frontmatter: fresh.frontmatter, body: `# Observations\n\n- first\n${line}\n` });
  for (const body of ["rewritten\n", `# Observations\n\n- first\n${line}\n- two\n`, ""]) {
    assert.throws(() => guard(fresh, { frontmatter: fresh.frontmatter, body }), (e: unknown) => refusedWith("FIELD_NOT_OWNED")(e) && String((e as OverlayRefusal).details.fields) === "(body)");
  }
  const outside = signalUpdateGuard(attention, collapseStep("notes/open", "v", {}), observation);
  assert.throws(() => outside({ ...fresh, id: "notes/open" }, { frontmatter: fresh.frontmatter, body: fresh.body }), refusedWith("FIELD_NOT_OWNED"));
});

test("G10 the create guard: target Kind, Kind without claim, path, key set, state, sources and an existing target", async () => {
  const w = await overlayWorld();
  const refusedCreate = async (step: CreateSignalStep, over: Partial<ApplyContext> = {}, world = w) => {
    const before = await world.snapshot("ops");
    const r = await applyRecordOverlay(planOf([step]), ctxOf(world, over));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED", JSON.stringify(r.results[0]));
    assert.deepEqual(await world.snapshot("ops"), before);
  };
  await refusedCreate(createStep("events/new-event", { ...SIGNAL_FM, type: "Event" }), { signals: { kind: "Event" } });
  await refusedCreate(createStep("notes/x", SIGNAL_FM));
  await refusedCreate(createStep("signals/x", { ...SIGNAL_FM, assignee: "agent/me" }));
  await refusedCreate(createStep("signals/x", { ...SIGNAL_FM, status: "draft" }));
  await refusedCreate(createStep("signals/x", { ...SIGNAL_FM, superbee_progress_status: "done" }));
  await refusedCreate(createStep("signals/x", { ...SIGNAL_FM, sources: [{ id: "no-resource" }] }));
  await w.opsBackend.write("signals/untyped", { id: "signals/untyped", frontmatter: { title: "no type" } as never, body: "keep me\n" });
  await refusedCreate(createStep("signals/untyped", SIGNAL_FM));
  const { claim: _claim, ...withoutClaim } = signalConvention("superbee_progress_status");
  const unclaimed = await overlayWorld({ signal: withoutClaim });
  await refusedCreate(createStep("signals/x", SIGNAL_FM), {}, unclaimed);
  const ok = await applyRecordOverlay(planOf([createStep("signals/x", SIGNAL_FM)]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied");
});

test("G10 a claimable Kind that does not declare the attention fields cannot be used for Signal create or update", async () => {
  const w = await overlayWorld({ conventions: { "conventions/task": taskConvention("superbee_progress_status") } });
  assert.deepEqual(resolveAttentionKind(w.ops.registry, "0.2", "Task", "Event"), { ok: false, reason: "the attention Kind Task does not declare change_kind, observed_at, provider, external_id, diff_summary" });
  const proper = resolveAttentionKind(w.ops.registry, "0.2", "Signal", "Event");
  assert.equal(proper.ok, true);
  const version = await w.put("tasks/write-docs", { type: "Task", title: "Write docs", superbee_progress_status: "todo" }, "Task body.\n", "ops");
  const before = await w.snapshot("ops");
  const create = await applyRecordOverlay(planOf([createStep("tasks/new-task", { type: "Task", title: "Created", superbee_progress_status: "todo", priority: "low", sources: [{ resource: PROVIDER }] })]), ctxOf(w, { signals: { kind: "Task" } }));
  const retitle = await applyRecordOverlay(planOf([collapseStep("tasks/write-docs", version, { title: "Retitled" })]), ctxOf(w, { signals: { kind: "Task" } }));
  assert.deepEqual([create.results[0]!.code, retitle.results[0]!.code], ["FIELD_NOT_OWNED", "FIELD_NOT_OWNED"]);
  assert.match(String(create.results[0]!.message), /does not declare change_kind/);
  assert.deepEqual(await w.snapshot("ops"), before);
  await assert.rejects(planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, changes: [], observedAt: AT, signals: { kind: "Task" } }), refusedWith("POLICY_INVALID"));
  const ok = await applyRecordOverlay(planOf([createStep("signals/x", SIGNAL_FM)]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied");
});

test("G10 the Signal create guard checks the attention Kind before anything else", () => {
  const step = createStep("signals/x", SIGNAL_FM);
  const guard = signalCreateGuard({ ok: false, reason: "the attention Kind Signal is not declared in the ops bundle" }, step);
  assert.throws(() => guard(undefined, step.candidate), (e: unknown) => refusedWith("FIELD_NOT_OWNED")(e) && /not declared/.test((e as Error).message));
});

// ------------------------------------------------------------------------------- the entry screen

test("G11 owned_fields or deriveFields naming never-owned fields or managed metadata are refused before any write", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = { content: await w.snapshot(), ops: await w.snapshot("ops") };
  const steps = [createStep("signals/synthetic-library-x", SIGNAL_FM), ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } })];
  for (const field of ["status", "type", "sources", "generated", "timestamp", "verified", "actor", "superbee_updated_by"]) {
    await assert.rejects(applyRecordOverlay(planOf(steps), ctxOf(w, { policy: { ...w.policy, owned_fields: ["start", field] } })), refusedWith("POLICY_INVALID"), field);
    await assert.rejects(applyRecordOverlay(planOf(steps), ctxOf(w, { hooks: { deriveFields: { fields: [field], derive: () => ({}) } } })), refusedWith("POLICY_INVALID"), field);
  }
  assert.throws(() => ownershipGuard({ ownedFields: ["status"], provider: PROVIDER, externalId: "x" }), refusedWith("POLICY_INVALID"));
  assert.throws(() => ownershipGuard({ ownedFields: ["start"], derivedFields: ["generated"], provider: PROVIDER, externalId: "x" }), refusedWith("POLICY_INVALID"));
  assert.deepEqual({ content: await w.snapshot(), ops: await w.snapshot("ops") }, before);
});

test("G11 a step whose fields name timestamp or generated is refused FIELD_NOT_OWNED", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const before = await w.snapshot();
  for (const fields of [{ timestamp: { from: undefined, to: "2026-10-03T00:00:00Z" } }, { generated: { from: undefined, to: { by: "human:forged", at: AT } } }]) {
    const r = await applyRecordOverlay(planOf([ownedStep(version, fields)]), ctxOf(w, { hooks: { deriveFields: updatedAtStamp(w.content.registry) } }));
    assert.equal(r.results[0]!.code, "FIELD_NOT_OWNED", JSON.stringify(fields));
  }
  assert.deepEqual(await w.snapshot(), before);
});

test("G11 the entry screen runs only for plans with owned-field steps: a Condition-style feed owning status applies its Signals", async () => {
  const w = await overlayWorld();
  const conditions = { owned_fields: ["status", "level"], provider: PROVIDER };
  const signals = planOf([createStep("signals/synthetic-library-condition", SIGNAL_FM)]);
  const r = await applyRecordOverlay(signals, ctxOf(w, { policy: conditions }));
  assert.equal(r.results[0]!.outcome, "applied");
  const version = await overlaid(w);
  await assert.rejects(
    applyRecordOverlay(planOf([ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } })]), ctxOf(w, { policy: conditions })),
    refusedWith("POLICY_INVALID"),
  );
  assert.equal((await w.read("events/story-time")).version, version);
});

// ------------------------------------------------------------------------------- INVALID_INPUT, narrowed

test("INVALID_INPUT: a grouped step on a v0.1 bundle is refused, held, and echoes no provider value", async () => {
  const w = await overlayWorld({ edition: "0.1" });
  const version = await overlaid(w);
  const step = ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { sources: { revision: "secret-revision-77" } } as never);
  const r = await applyRecordOverlay(planOf([step]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["INVALID_INPUT", { reason: "grouped-shape-needs-v0.2", field: "sources" }]);
  assert.ok(HOLD_STORE.has(r.results[0]!.code!));
  assert.doesNotMatch(JSON.stringify(r), /secret-revision-77/);
  assert.equal((await w.read("events/story-time")).version, version);
});

test("INVALID_INPUT: core's field-action refusals map with a fixed message and the reason and field only", async () => {
  const w = await overlayWorld();
  const twice = await w.put("events/story-time", { ...event("001", STORY), sources: [{ resource: PROVIDER, id: UID("001") }, { resource: PROVIDER, id: UID("001"), title: "again" }] }, EDITOR_BODY);
  const r = await applyRecordOverlay(planOf([ownedStep(twice, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { sources: { revision: "r1" } } as never)]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["INVALID_INPUT", "core refused the field actions for this step", { reason: "ambiguous-source", field: "sources" }]);
  assert.doesNotMatch(JSON.stringify([r.results[0]!.message, r.results[0]!.details]), /evt-001/, "no candidate identity is echoed");
  const w2 = await overlayWorld();
  const version = await overlaid(w2);
  const policy = { ...w2.policy, owned_fields: ["start", "headline"] };
  const undeclared = await applyRecordOverlay(planOf([ownedStep(version, { headline: { from: undefined, to: "Breaking" } }, { sources: { revision: "r1" } } as never)]), ctxOf(w2, { policy }));
  assert.deepEqual([undeclared.results[0]!.code, undeclared.results[0]!.details], ["INVALID_INPUT", { reason: "unsupported-set-field", field: "headline" }]);
  assert.equal((await w2.read("events/story-time")).version, version);
});

test("INVALID_INPUT: an owned field holding a list is refused by the subpath; a non-owned list field is FIELD_NOT_OWNED", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w, { streets: ["Main St"] });
  const policy = { ...w.policy, owned_fields: ["start", "streets"] };
  const listed = await applyRecordOverlay(planOf([ownedStep(version, { streets: { from: ["Main St"], to: ["Elm St"] } })]), ctxOf(w, { policy }));
  assert.deepEqual([listed.results[0]!.code, listed.results[0]!.details], ["INVALID_INPUT", { reason: "list-valued-field", field: "streets" }]);
  const sources = await applyRecordOverlay(planOf([ownedStep(version, { sources: { from: [], to: [{ resource: "https://evil.example", id: "x" }] } })]), ctxOf(w));
  assert.deepEqual([sources.results[0]!.code, sources.results[0]!.details], ["FIELD_NOT_OWNED", { fields: ["sources"], external_id: UID("001") }]);
  assert.equal((await w.read("events/story-time")).version, version);
});

test("a value core's write policy refuses inside a step is a held, value-free row: a derive hook that returns a list", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const derive = { fields: ["note"], derive: () => ({ note: ["secret-list-value"] }) };
  const r = await applyRecordOverlay(planOf([ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } })]), ctxOf(w, { hooks: { deriveFields: derive } }));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["INVALID_INPUT", "core refused a value in this step", { reason: "invalid-value" }]);
  assert.doesNotMatch(JSON.stringify(r), /secret-list-value/);
  assert.equal((await w.read("events/story-time")).version, version);
});

// ------------------------------------------------------------------------------- races and invariants

test("a concurrent editor on an owned field, a non-owned field or the body between plan and apply: STALE_VERSION, zero writes", async () => {
  for (const edit of [{ start: "2026-10-10T10:15:00-04:00" }, { cost_text: "Free" }, { body: "An editor rewrote this.\n" }]) {
    const w = await overlayWorld();
    await overlaid(w);
    const p = await planRecordOverlay({ content: w.content, ops: w.ops, policy: w.policy, changes: [change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("1"))], observedAt: AT });
    const { body, ...patch } = edit as { body?: string };
    await w.edit("events/story-time", patch, "content", body);
    const after = await w.snapshot();
    w.contentBackend.writes = [];
    const r = await applyRecordOverlay(p, ctxOf(w));
    assert.deepEqual(r.results.map((x) => x.code), ["STALE_VERSION"], JSON.stringify(edit));
    assert.deepEqual(w.contentBackend.writes, []);
    assert.deepEqual(await w.snapshot(), after);
  }
});

test("never create outside the attention Kind, never delete: a run of new, changed, canceled and disappeared records", async () => {
  for (const withOverlays of [true, false]) {
    const w = await overlayWorld();
    if (withOverlays) {
      await overlaid(w);
      await w.put("events/market", event("002", { ...STORY, title: "Market" }), EDITOR_BODY);
    }
    const ids = Object.keys(await w.snapshot());
    const p = await planRecordOverlay({
      content: w.content, ops: w.ops, policy: w.policy, observedAt: "2026-10-05T12:00:00Z", hooks: { interval: statedEndElseThreeHours },
      changes: [
        change(UID("001"), "changed", STORY, { ...STORY, start: "2026-10-10T11:00:00-04:00" }, DIGEST("1")),
        change(UID("002"), "canceled", { ...STORY, title: "Market" }, { ...STORY, title: "Market", event_status: "canceled" }, DIGEST("2")),
        change(UID("003"), "new", null, { title: "Brand New", start: "2026-11-01T10:00:00-04:00" }, DIGEST("3")),
        change(UID("004"), "disappeared", { title: "Gone", start: "2026-10-20T10:00:00-04:00" }, null, DIGEST("4"), { missing_count: 2, first_missing_at: "2026-10-04T12:00:00Z" }),
      ],
    });
    assert.ok(p.steps.every((s) => ["apply-owned-fields", "create-signal", "collapse-signal", "signal-duplicate", "record-only"].includes(s.op)));
    await applyRecordOverlay(p, ctxOf(w, { hooks: { deriveFields: updatedAtStamp(w.content.registry) } }));
    const after = Object.keys(await w.snapshot());
    const created = after.filter((id) => !ids.includes(id));
    assert.ok(created.length > 0 && created.every((id) => id.startsWith("signals/")), created.join(", "));
    for (const id of created) assert.equal((await w.read(id)).doc.frontmatter.type, "Signal");
    assert.ok(ids.every((id) => after.includes(id)));
    assert.deepEqual(w.contentBackend.deletes, []);
  }
});

test("composeGuards: the first refusal wins and asynchronous hooks are awaited after the core guards", async () => {
  const calls: string[] = [];
  const sync = composeGuards(() => { calls.push("a"); }, undefined, () => { calls.push("b"); throw new OverlayRefusal("FIELD_NOT_OWNED", "b"); }, () => { calls.push("c"); });
  assert.throws(() => sync(undefined, { frontmatter: {} as never, body: "" }), refusedWith("FIELD_NOT_OWNED"));
  assert.deepEqual(calls, ["a", "b"]);
  const order: string[] = [];
  const mixed = composeGuards(() => { order.push("core"); }, async () => { await Promise.resolve(); order.push("hook"); }, () => { order.push("after"); });
  await mixed(undefined, { frontmatter: {} as never, body: "" });
  assert.deepEqual(order, ["core", "hook", "after"]);
});

test("the subpath source carries no delete, no node: import and no Buffer", async () => {
  const dir = path.resolve(here, "../src/record-overlay");
  for (const file of await readdir(dir)) {
    const text = await readFile(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /\bdeleteDoc\b|\bdeleteBlob\b|backend\.delete/, file);
    assert.doesNotMatch(text, /from\s+["']node:/, file);
    assert.doesNotMatch(text, /\bBuffer\b/, file);
  }
});

// ------------------------------------------------------------------------------- closing mutation gaps

test("G9 a non-Signal stored under the Signal path, and a missing fresh document, are refused by the update guard", async () => {
  const w = await overlayWorld({ conventions: { "conventions/task": taskConvention("superbee_progress_status") } });
  const version = await w.put("signals/misfiled-task", { type: "Task", title: "Misfiled", superbee_progress_status: "todo" }, "Task body.\n", "ops");
  const before = await w.snapshot("ops");
  const r = await applyRecordOverlay(planOf([collapseStep("signals/misfiled-task", version, { title: "Retitled" })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["FIELD_NOT_OWNED", "collapse-signal target is not a Signal under signals/", { external_id: UID("009") }]);
  assert.deepEqual(await w.snapshot("ops"), before);
  const guard = signalUpdateGuard(resolveAttentionKind(w.ops.registry, "0.2", "Signal", "Event"), collapseStep("signals/gone", "v", {}), { observedAt: AT, provider: PROVIDER });
  assert.throws(() => guard(undefined, { frontmatter: {} as never, body: "" }), refusedWith("FIELD_NOT_OWNED"));
});

test("G9 a collapse may set every attention update field", async () => {
  const w = await overlayWorld();
  const version = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n\n- first\n", "ops");
  const set = { change_kind: "changed", priority: "normal", observed_at: AT, diff_summary: "d", title: "Changed: x", external_id: UID("010"), about_doc: "events/story-time", content_digest: DIGEST("7"), expires_at: "2026-11-01T00:00:00Z" };
  const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, set)]), ctxOf(w));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const doc = (await w.read("signals/open", "ops")).doc;
  for (const [key, value] of Object.entries(set)) assert.equal(doc.frontmatter[key as keyof typeof doc.frontmatter], value, key);
});

test("G9 a collapse whose set turns a field into a list is refused FIELD_NOT_OWNED before core's patch rules", async () => {
  const w = await overlayWorld();
  const version = await w.put("signals/open", { ...SIGNAL_FM }, "# Observations\n", "ops");
  const r = await applyRecordOverlay(planOf([collapseStep("signals/open", version, { title: ["a", "b"] })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["FIELD_NOT_OWNED", "collapse-signal would change fields outside the attention update: title", { fields: ["title"], external_id: UID("009") }]);
  assert.equal((await w.read("signals/open", "ops")).version, version);
});

test("G10 a create onto an existing Signal fails its type precondition (STALE_VERSION); sources must all name a resource", async () => {
  const w = await overlayWorld();
  const version = await w.put("signals/x", { ...SIGNAL_FM, title: "Existing" }, "# Observations\n", "ops");
  const exists = await applyRecordOverlay(planOf([createStep("signals/x", SIGNAL_FM)]), ctxOf(w));
  assert.deepEqual([exists.results[0]!.code, exists.results[0]!.details], ["STALE_VERSION", { field: "type" }]);
  assert.equal((await w.read("signals/x", "ops")).version, version);
  const mixed = await applyRecordOverlay(planOf([createStep("signals/y", { ...SIGNAL_FM, sources: [{ resource: PROVIDER }, { id: "no-resource" }] })]), ctxOf(w));
  assert.deepEqual([mixed.results[0]!.code, mixed.results[0]!.details], ["FIELD_NOT_OWNED", { field: "sources", external_id: UID("009") }]);
  const untyped = await overlayWorld();
  await untyped.opsBackend.write("signals/untyped", { id: "signals/untyped", frontmatter: { title: "no type" } as never, body: "keep me\n" });
  const over = await applyRecordOverlay(planOf([createStep("signals/untyped", SIGNAL_FM)]), ctxOf(untyped));
  assert.deepEqual([over.results[0]!.code, over.results[0]!.message], ["FIELD_NOT_OWNED", "create-signal target already exists"]);
  const outside = await applyRecordOverlay(planOf([createStep("notes/x", SIGNAL_FM)]), ctxOf(w));
  assert.deepEqual([outside.results[0]!.message, outside.results[0]!.details], ["create-signal target is outside signals/", { external_id: UID("009") }]);
  const keys = await applyRecordOverlay(planOf([createStep("signals/z", { ...SIGNAL_FM, assignee: "agent/me" })]), ctxOf(w));
  assert.deepEqual(keys.results[0]!.details, { fields: ["assignee"], external_id: UID("009") });
  const state = await applyRecordOverlay(planOf([createStep("signals/z", { ...SIGNAL_FM, superbee_progress_status: "done" })]), ctxOf(w));
  assert.deepEqual(state.results[0]!.details, { field: "superbee_progress_status", external_id: UID("009") });
});

test("G11 entry checks: owned_fields must be a list of names, deriveFields well formed, and owned-field steps need a provider", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const steps = [ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } })];
  const refuses = async (over: Partial<ApplyContext>, details?: Record<string, unknown>) => {
    await assert.rejects(applyRecordOverlay(planOf(steps), ctxOf(w, over)), (e: unknown) => refusedWith("POLICY_INVALID")(e) && (details === undefined || JSON.stringify((e as OverlayRefusal).details) === JSON.stringify(details)));
  };
  await refuses({ policy: { ...w.policy, owned_fields: ["start", 7 as never] } }, { list: "owned_fields" });
  await refuses({ policy: { ...w.policy, owned_fields: "start" as never } }, { list: "owned_fields" });
  await refuses({ hooks: { deriveFields: { fields: "updated_at" as never, derive: () => ({}) } } }, { list: "deriveFields.fields" });
  await refuses({ hooks: { deriveFields: { fields: ["updated_at"], derive: undefined as never } } }, { list: "deriveFields.fields" });
  await refuses({ policy: { ...w.policy, provider: "" } });
  await refuses({ policy: { ...w.policy, provider: undefined as never } });
  await refuses({ policy: { ...w.policy, owned_fields: ["start", "tags"] } }, { list: "owned_fields", fields: ["tags"] });
  assert.equal((await w.read("events/story-time")).version, version);
});

test("KIND_REJECTED: a candidate core refuses without a type or vocabulary finding is named by code and field only", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  const r = await applyRecordOverlay(planOf([ownedStep(version, { start: { from: STORY.start, to: undefined } })]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.message, r.results[0]!.details], ["KIND_REJECTED", "candidate does not satisfy the Event kind: KIND_FIELD_MISSING:start", { violations: ["KIND_FIELD_MISSING:start"] }]);
  assert.equal((await w.read("events/story-time")).version, version);
});

test("plan validation: a plan must be a mapping with a steps list, and each step's own keys are checked", async () => {
  const w = await overlayWorld();
  const version = await overlaid(w);
  await assert.rejects(applyRecordOverlay(null as never, ctxOf(w)), (e: unknown) => refusedWith("INVALID_INPUT")(e) && (e as Error).message === "a plan needs a steps list");
  await assert.rejects(applyRecordOverlay({ ...planOf([]), steps: "none" as never }, ctxOf(w)), refusedWith("INVALID_INPUT"));
  const bad: unknown[] = [
    { op: "apply-owned-fields", target: "", expected_version: version, external_id: UID("001"), fields: { start: { to: "x" } } },
    { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: 7, fields: { start: { to: "x" } } },
    { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), fields: { start: "x" } },
    { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), fields: { end: { to: "y" }, start: "x" } },
    { op: "apply-owned-fields", target: "events/story-time", expected_version: version, external_id: UID("001"), fields: { start: { to: "x" } }, sources: ["r"] },
    { op: "create-signal", target: "signals/y", candidate: { frontmatter: SIGNAL_FM } },
    { op: "create-signal", target: "signals/y", candidate: { frontmatter: [], body: "" } },
    { op: "collapse-signal", target: "signals/y", expected_version: "v", set: {} },
    { op: "collapse-signal", target: "signals/y", observation_line: "- x", set: {} },
    { op: "signal-duplicate", external_id: "x" },
    { op: 7 },
  ];
  for (const [index, step] of bad.entries()) {
    await assert.rejects(applyRecordOverlay(planOf([step as OverlayStep]), ctxOf(w)), (e: unknown) => refusedWith("INVALID_INPUT")(e) && (e as OverlayRefusal).details.step === 0, `case ${index}`);
  }
  await assert.rejects(applyRecordOverlay(planOf([bad[0] as OverlayStep]), ctxOf(w)), (e: unknown) => (e as Error).message === "plan step 0 is not a well-formed apply-owned-fields step");
  assert.equal((await w.read("events/story-time")).version, version);
});

test("the grouped shape: a removal or a list-valued source property is INVALID_INPUT; scalar to list owned fields too; no derive hook is needed", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/story-time", { ...event("001", STORY), venue_text: "Room A", sources: [{ resource: PROVIDER, id: UID("001"), tags: ["a"] }] }, EDITOR_BODY);
  const grouped = (fields: Record<string, { from: unknown; to: unknown }>, sources: Record<string, unknown>) => ownedStep(version, fields, { sources } as never);
  const removal = await applyRecordOverlay(planOf([grouped({ venue_text: { from: "Room A", to: undefined } }, { revision: "r1" })]), ctxOf(w));
  assert.deepEqual([removal.results[0]!.code, removal.results[0]!.details], ["INVALID_INPUT", { reason: "grouped-shape-removes-field", field: "venue_text" }]);
  const listed = await applyRecordOverlay(planOf([grouped({ start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { tags: "b" })]), ctxOf(w));
  assert.deepEqual([listed.results[0]!.code, listed.results[0]!.details], ["INVALID_INPUT", { reason: "list-valued-source-property", field: "sources" }]);
  const toList = await applyRecordOverlay(planOf([ownedStep(version, { venue_text: { from: "Room A", to: ["Room A", "Room B"] } })]), ctxOf(w));
  assert.deepEqual([toList.results[0]!.code, toList.results[0]!.details], ["INVALID_INPUT", { reason: "list-valued-field", field: "venue_text" }]);
  assert.equal((await w.read("events/story-time")).version, version);
  const ok = await applyRecordOverlay(planOf([grouped({ start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { revision: "r1" })]), ctxOf(w));
  assert.equal(ok.results[0]!.outcome, "applied", JSON.stringify(ok.results[0]));
  const doc = (await w.read("events/story-time")).doc;
  assert.deepEqual([doc.frontmatter.start, doc.frontmatter.updated_at], ["2026-10-10T11:00:00-04:00", undefined]);
});

test("the grouped shape on an overlay that no longer carries the identity is refused: the upsert would add an entry", async () => {
  const w = await overlayWorld();
  const version = await w.put("events/story-time", { ...event("001", STORY), sources: [{ resource: OTHER, id: "o-1" }] }, EDITOR_BODY);
  const r = await applyRecordOverlay(planOf([ownedStep(version, { start: { from: STORY.start, to: "2026-10-10T11:00:00-04:00" } }, { sources: { revision: "r1" } } as never)]), ctxOf(w));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["FIELD_NOT_OWNED", { fields: ["sources"], external_id: UID("001") }]);
  assert.equal((await w.read("events/story-time")).version, version);
});
