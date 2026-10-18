/**
 * List-valued owned fields: the set comparison beside `same()`, the policy's `list_fields`, and the
 * apply's field-actions write for a step that writes a declared `string-list` or `https-url-list`
 * field (replace-all for lists, unset for removals, set for scalars, the upsert when present), with
 * the guard's screens ahead of core's own refusals.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compareCodePoints } from "../src/code-point-order.js";
import { same, sameSet } from "../src/record-overlay/canonical.js";
import {
  applyRecordOverlay,
  decideChange,
  planRecordOverlay,
  readOverlayPolicy,
  type ApplyContext,
  type OverlayPlan,
  type OverlayPolicy,
  type OverlayStep,
  type RecordChange,
} from "../src/record-overlay/index.js";
import type { FieldAction } from "../src/document-field-actions.js";
import { mutateDocument } from "../src/document-mutation.js";
import type { Frontmatter, Version } from "../src/types.js";
import { ACTOR, DIGEST, EDITOR, EVENT_CONVENTION, FEED, overlayWorld, PROVIDER, UID, type World } from "./record-overlay-helpers.js";

const WORK_ITEM = {
  type: "Convention", title: "Work Item", governs: "Work Item", path: "work-items/",
  fields: {
    required: ["title"],
    optional: ["state_category", "close_reason", "labels", "assignees", "code_links", "due_on", "notes", "revision"],
    values: { state_category: ["todo", "done", "canceled"], close_reason: ["completed", "not_planned"] },
    types: { labels: "string-list", assignees: "string-list", code_links: "https-url-list", due_on: "date" },
  },
};
const OWNED = ["title", "state_category", "close_reason", "labels", "assignees", "code_links", "due_on"];
const ITEM = "work-items/widgets-42";
const ID = UID("042");
const AT = "2026-10-17T14:00:00Z";

async function itemWorld(edition: "0.1" | "0.2" = "0.2"): Promise<{ w: World; policy: OverlayPolicy }> {
  const w = await overlayWorld({ edition, conventions: { "conventions/work-item": WORK_ITEM } });
  const kind = w.content.registry.kinds.get("Work Item")!;
  const policy = readOverlayPolicy({ id: FEED, frontmatter: { url: PROVIDER, target_kind: "Work Item", owned_fields: OWNED } as unknown as Frontmatter }, { targetKind: kind });
  return { w, policy };
}
const itemDoc = (fm: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "Work Item", title: "Crash on save", ...fm, sources: [{ resource: PROVIDER, id: ID }] });
const planOf = (steps: OverlayStep[]): OverlayPlan => ({ feed: FEED, provider: PROVIDER, observed_at: AT, refusals: [], steps });
const ctxOf = (w: World, policy: OverlayPolicy, over: Partial<ApplyContext> = {}): ApplyContext => ({ content: w.content, ops: w.ops, policy, actor: ACTOR, ...over });
const ownedStep = (version: Version, fields: Record<string, { from?: unknown; to: unknown }>, over: Partial<OverlayStep> = {}): OverlayStep =>
  ({ op: "apply-owned-fields", target: ITEM, expected_version: version, external_id: ID, change_kind: "changed", fields, ...over }) as OverlayStep;
const changed = (before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): RecordChange =>
  ({ external_id: ID, change_kind: "changed", changed_fields: fields, before, after, content_digest: DIGEST("4") });

// ------------------------------------------------------------------------------- the comparisons

test("sameSet: a reorder is equal, an added or removed member is not, repeats collapse, non-lists compare by same()", () => {
  assert.equal(sameSet(["b", "a"], ["a", "b"]), true);
  assert.equal(sameSet(["a"], ["a", "b"]), false, "added");
  assert.equal(sameSet(["a", "b"], ["a"]), false, "removed");
  assert.equal(sameSet(["a", "b"], ["a", "c"]), false, "replaced");
  assert.equal(sameSet(["a", "a", "b"], ["b", "a"]), true, "repeats collapse");
  assert.equal(sameSet([], []), true);
  assert.equal(sameSet(undefined, []), false, "an absent list is not []");
  assert.equal(sameSet(null, []), false);
  assert.equal(sameSet("a", ["a"]), false);
  assert.equal(sameSet("a", "a"), true);
  assert.equal(sameSet(["\u{1F600}", "\uFF5E"], ["\uFF5E", "\u{1F600}"]), true);
  assert.equal(sameSet([{ a: 1, b: 2 }], [{ b: 2, a: 1 }]), true, "members compare canonically");
  assert.equal(same(["b", "a"], ["a", "b"]), false, "same() still keeps order");
});

test("compareCodePoints orders by code point, not UTF-16 code unit", () => {
  const values = ["\u{1F600} triage", "\uFF5Ewave", "bug", "Bug", "bu"];
  assert.deepEqual([...values].sort(compareCodePoints), ["Bug", "bu", "bug", "\uFF5Ewave", "\u{1F600} triage"]);
  assert.deepEqual([...values].sort(), ["Bug", "bu", "bug", "\u{1F600} triage", "\uFF5Ewave"], "the default sort differs on astral characters");
  assert.equal(compareCodePoints("a", "a"), 0);
  assert.equal(compareCodePoints("\uD800", "\uD800"), 0, "a lone surrogate equals itself");
  assert.equal(compareCodePoints("\uD800", "\u{10000}"), -1, "a lone surrogate orders by its own value");
  assert.deepEqual([compareCodePoints("bug", "bu"), compareCodePoints("bu", "bug")], [1, -1], "a string orders after its own prefix");
});

test("readOverlayPolicy names the target Kind's list fields; a Kind without one adds no key", async () => {
  const { w, policy } = await itemWorld();
  assert.deepEqual(policy.list_fields, ["assignees", "code_links", "labels"]);
  assert.equal("list_fields" in w.policy, false, "Event declares no list type, so its policy is unchanged");
  const noKind = readOverlayPolicy({ id: FEED, frontmatter: { url: PROVIDER, owned_fields: ["labels"] } as unknown as Frontmatter });
  assert.equal("list_fields" in noKind, false);
  assert.equal(EVENT_CONVENTION.fields.types.event_url, "https-url");
});

test("decideChange compares declared list fields as sets: a reorder converges, a source change applies, a person's member conflicts", async () => {
  const { policy } = await itemWorld();
  const decide = (doc: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>, p: OverlayPolicy = policy) =>
    decideChange(p, changed(before, after, Object.keys({ ...before, ...after })), { overlay: { frontmatter: doc } });

  const reordered = decide({ labels: ["b", "a"] }, { labels: ["a"] }, { labels: ["a", "b"] });
  assert.deepEqual([reordered.apply, reordered.conflicts, reordered.signal], [{}, [], null], "the document already holds the new set");
  const { list_fields: _lists, ...withoutLists } = policy;
  assert.deepEqual(decide({ labels: ["b", "a"] }, { labels: ["a"] }, { labels: ["a", "b"] }, withoutLists).conflicts.map((c) => c.field), ["labels"], "whole-value compare would conflict (probe A5)");

  const added = decide({ labels: ["b", "a"] }, { labels: ["a", "b"] }, { labels: ["a", "b", "c"] });
  assert.deepEqual(added.apply, { labels: { from: ["b", "a"], to: ["a", "b", "c"] } }, "the document holds the last accepted set in another order");
  assert.equal(added.signal, null);
  assert.deepEqual(decide({ labels: ["a", "b"] }, { labels: ["a", "b"] }, { labels: ["a"] }).apply, { labels: { from: ["a", "b"], to: ["a"] } }, "a removed member");
  assert.deepEqual(decide({}, {}, { labels: [] }).apply, { labels: { from: undefined, to: [] } }, "adoption writes [] into an empty slot");

  const mine = decide({ labels: ["a", "b", "mine"] }, { labels: ["a", "b"] }, { labels: ["a", "b", "c"] });
  assert.deepEqual([mine.apply, mine.conflicts.map((c) => c.field)], [{}, ["labels"]], "a member a person added conflicts and is kept");
  assert.deepEqual(mine.signal?.reasons, ["OVERLAY_DOC_CONFLICT"]);

  const editorPolicy = { ...policy, owned_fields: ["title"] };
  assert.deepEqual(decide({ labels: ["b", "a"] }, { labels: ["a"] }, { labels: ["a", "b"] }, editorPolicy).editorFields, [], "an editor-owned list that already says the set needs no judgment");
  assert.deepEqual(decide({ labels: ["a"] }, { labels: ["a"] }, { labels: ["a", "b"] }, editorPolicy).editorFields, ["labels"]);
});

// ------------------------------------------------------------------------------- the apply

test("a reopen with a relabel lands in one write: unset, set and replace-all in one version", async () => {
  const { w, policy } = await itemWorld();
  const version = await w.put(ITEM, itemDoc({ state_category: "done", close_reason: "completed", labels: ["bug"], notes: "kept" }), "Person notes.\n");
  w.contentBackend.writes = [];
  const before = { title: "Crash on save", state_category: "done", close_reason: "completed", labels: ["bug"] };
  const after = { title: "Crash on save", state_category: "todo", labels: ["bug", "regression"] };
  const plan = await planRecordOverlay({ content: w.content, ops: w.ops, policy, changes: [changed(before, after, ["close_reason", "labels", "state_category"])], observedAt: AT, sameBundle: true });
  assert.deepEqual(plan.steps.map((s) => s.op), ["apply-owned-fields"]);
  const r = await applyRecordOverlay(plan, ctxOf(w, policy));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const { doc, version: next } = await w.read(ITEM);
  assert.notEqual(next, version);
  assert.deepEqual(w.contentBackend.writes, [ITEM], "one write");
  assert.equal(Object.hasOwn(doc.frontmatter, "close_reason"), false);
  assert.deepEqual([doc.frontmatter.state_category, doc.frontmatter.labels, (doc.frontmatter as Record<string, unknown>).notes, doc.body], ["todo", ["bug", "regression"], "kept", "Person notes.\n"]);
});

test("with entry properties the upsert rides in the same write as the list", async () => {
  const { w, policy } = await itemWorld();
  await w.put(ITEM, itemDoc({ labels: ["bug"] }));
  w.contentBackend.writes = [];
  const plan = await planRecordOverlay({
    content: w.content, ops: w.ops, policy, observedAt: AT, sameBundle: true,
    changes: [changed({ labels: ["bug"] }, { labels: ["bug", "p1"] }, ["labels"])],
    hooks: { sourceProperties: () => ({ number: 42 }) },
  });
  assert.deepEqual((plan.steps[0] as { sources?: unknown }).sources, { number: 42 });
  const r = await applyRecordOverlay(plan, ctxOf(w, policy));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const { doc } = await w.read(ITEM);
  assert.deepEqual([doc.frontmatter.labels, doc.frontmatter.sources], [["bug", "p1"], [{ resource: PROVIDER, id: ID, number: 42 }]]);
  assert.deepEqual(w.contentBackend.writes, [ITEM]);
});

test("an owned list must arrive normalized: out of order, repeated or non-text is held INVALID_INPUT, value-free", async () => {
  const { w, policy } = await itemWorld();
  const version = await w.put(ITEM, itemDoc({ labels: ["a"] }));
  for (const to of [["b", "a"], ["a", "a"], ["a", 1], "a", ["secret-label-9", "a"], [" "], ["", "a"]]) {
    const r = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to } })]), ctxOf(w, policy));
    assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["INVALID_INPUT", { reason: "list-not-normalized", field: "labels" }], JSON.stringify(to));
    assert.doesNotMatch(JSON.stringify(r), /secret-label-9/);
    assert.equal((await w.read(ITEM)).version, version);
  }
  const emptied = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: [] } })]), ctxOf(w, policy));
  assert.equal(emptied.results[0]!.outcome, "applied", "[] is normalized: replace-all empties the list");
  assert.deepEqual((await w.read(ITEM)).doc.frontmatter.labels, []);
});

test("a list step keeps the guard's refusal order: target Kind, unowned field, identity, then the values", async () => {
  const { w, policy } = await itemWorld();
  const signal = await w.put("signals/raised", { type: "Signal", title: "New: x", superbee_progress_status: "todo", change_kind: "new", observed_at: AT, provider: PROVIDER, external_id: ID, sources: [{ resource: PROVIDER, id: ID }] }, "", "ops");
  const atSignal = await applyRecordOverlay(planOf([ownedStep(signal, { labels: { to: ["planted"] }, title: { from: "New: x", to: "Rewritten" } }, { target: "signals/raised" })]), ctxOf(w, policy));
  assert.deepEqual([atSignal.results[0]!.code, atSignal.results[0]!.details], ["FIELD_NOT_OWNED", { field: "type", external_id: ID }]);
  assert.equal((await w.read("signals/raised", "ops")).version, signal);

  const version = await w.put(ITEM, itemDoc({ labels: ["a"] }));
  const unowned = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: ["b", "a"] }, notes: { to: "x" } })]), ctxOf(w, policy));
  assert.deepEqual([unowned.results[0]!.code, unowned.results[0]!.details], ["FIELD_NOT_OWNED", { fields: ["notes"], external_id: ID }]);

  const lost = await w.put("work-items/other", { type: "Work Item", title: "Other", labels: ["a"], sources: [{ resource: PROVIDER, id: "someone-else" }] });
  const identity = await applyRecordOverlay(planOf([ownedStep(lost, { labels: { from: ["a"], to: ["b", "a"] } }, { target: "work-items/other" })]), ctxOf(w, policy));
  assert.equal(identity.results[0]!.code, "OVERLAY_IDENTITY_LOST");

  const untyped = { ...policy, owned_fields: [...OWNED, "notes"] };
  const listed = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: ["a", "b"] }, notes: { to: ["not", "declared"] } })]), ctxOf(w, untyped));
  assert.deepEqual([listed.results[0]!.code, listed.results[0]!.details], ["INVALID_INPUT", { reason: "list-valued-field", field: "notes" }], "a list in a field without a list type is still refused");

  const required = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: ["a", "b"] }, title: { from: "Crash on save", to: undefined } })]), ctxOf(w, policy));
  assert.deepEqual([required.results[0]!.code, required.results[0]!.message], ["KIND_REJECTED", "candidate does not satisfy the Work Item kind: KIND_FIELD_MISSING:title"]);

  const urls = await applyRecordOverlay(planOf([ownedStep(version, { code_links: { to: ["http://insecure.example/pull/1"] } })]), ctxOf(w, policy));
  assert.equal(urls.results[0]!.code, "FIELD_TYPE_VIOLATION", "core's type check holds a bad URL");
  assert.equal((await w.read(ITEM)).version, version);
  assert.deepEqual(w.contentBackend.deletes, []);
});

test("a list step on an OKF v0.1 bundle is held: field actions there restamp timestamp, which no feed owns", async () => {
  const { w, policy } = await itemWorld("0.1");
  const version = await w.put(ITEM, { type: "Work Item", title: "Crash on save", labels: ["a"], sources: [{ resource: PROVIDER, id: ID }] });
  const r = await applyRecordOverlay(planOf([ownedStep(version, { due_on: { to: "2026-11-01" }, labels: { from: ["a"], to: ["a", "b"] } })]), ctxOf(w, policy));
  assert.deepEqual([r.results[0]!.code, r.results[0]!.details], ["INVALID_INPUT", { reason: "grouped-shape-needs-v0.2", field: "labels" }]);
  const grouped = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: ["a", "b"] } }, { sources: { number: 42 } } as never)]), ctxOf(w, policy));
  assert.deepEqual(grouped.results[0]!.details, { reason: "grouped-shape-needs-v0.2", field: "sources" }, "the upsert's refusal is unchanged");
  const scalar = await applyRecordOverlay(planOf([ownedStep(version, { due_on: { to: "2026-11-01" } })]), ctxOf(w, policy));
  assert.equal(scalar.results[0]!.outcome, "applied", "a step without a list keeps the patch shape on v0.1");
  assert.deepEqual((await w.read(ITEM)).doc.frontmatter.labels, ["a"]);
});

// ---------------------------------------------------------------------------- CAS and removal

test("a person's replace-all between plan and apply is never overwritten: STALE_VERSION, with and without the upsert", async () => {
  for (const withProps of [false, true]) {
    const { w, policy } = await itemWorld();
    await w.put(ITEM, itemDoc({ labels: ["a"] }));
    const plan = await planRecordOverlay({
      content: w.content, ops: w.ops, policy, observedAt: AT, sameBundle: true,
      changes: [changed({ labels: ["a"] }, { labels: ["a", "b"] }, ["labels"])],
      ...(withProps ? { hooks: { sourceProperties: () => ({ number: 42 }) } } : {}),
    });
    assert.deepEqual(plan.steps.map((s) => s.op), ["apply-owned-fields"]);
    const actions: FieldAction[] = [{ action: "replace-all", field: "labels", value: ["mine", "a"] }];
    await mutateDocument({
      bundle: w.content.bundle, id: ITEM, mode: "patch", registry: w.content.registry, strict: true, actor: EDITOR,
      expectedVersion: (await w.read(ITEM)).version, input: { kind: "field-actions", actions },
    });
    const personVersion = (await w.read(ITEM)).version;
    w.contentBackend.writes = [];
    const r = await applyRecordOverlay(plan, ctxOf(w, policy));
    assert.equal(r.results[0]!.code, "STALE_VERSION", JSON.stringify(r.results[0]));
    assert.deepEqual(w.contentBackend.writes, []);
    const { doc, version } = await w.read(ITEM);
    assert.deepEqual([version, doc.frontmatter.labels], [personVersion, ["mine", "a"]], `withProps=${withProps}`);
  }
});

test("the guard compares whole values: a fresh version whose list differs from the planned from conflicts, reordered included", async () => {
  const { w, policy } = await itemWorld();
  const version = await w.put(ITEM, itemDoc({ labels: ["a", "mine"] }));
  w.contentBackend.writes = [];
  for (const from of [["a"], ["mine", "a"]]) {
    const r = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from, to: ["a", "b"] } })]), ctxOf(w, policy));
    assert.equal(r.results[0]!.code, "OVERLAY_DOC_CONFLICT", JSON.stringify(from));
  }
  assert.deepEqual(w.contentBackend.writes, []);
});

test("a v0.2 step removing an optional owned list writes unset and the key is gone", async () => {
  const { w, policy } = await itemWorld();
  const version = await w.put(ITEM, itemDoc({ labels: ["a"], assignees: ["sam"] }));
  const r = await applyRecordOverlay(planOf([ownedStep(version, { labels: { from: ["a"], to: undefined }, assignees: { from: ["sam"], to: ["kai", "sam"] } })]), ctxOf(w, policy));
  assert.equal(r.results[0]!.outcome, "applied", JSON.stringify(r.results[0]));
  const fm = (await w.read(ITEM)).doc.frontmatter as Record<string, unknown>;
  assert.deepEqual([Object.hasOwn(fm, "labels"), fm.assignees], [false, ["kai", "sam"]]);
});
