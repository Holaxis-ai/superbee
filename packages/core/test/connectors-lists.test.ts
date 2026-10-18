/**
 * A connector that owns list fields (`labels`, `assignees`, `code_links`) end to end, no network:
 * the real parser, `bindSourceFeed`, `mapRecord` and `changeBetween`, then record-overlay's planner
 * and apply over MemoryBackend. The adoption change (`changed`, `before: {}`) is
 * `changeBetween({}, mapped)`; the store between observations is test code standing in for a runner.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bindSourceFeed, changeBetween, findingsFor, mapRecord, parseConnectorDoc, type BoundFeed, type Connector } from "../src/connectors.js";
import type { FieldAction } from "../src/document-field-actions.js";
import { mutateDocument } from "../src/document-mutation.js";
import { parseMarkdown } from "../src/frontmatter.js";
import { buildKindRegistry, type KindRegistry } from "../src/kinds.js";
import { applyRecordOverlay, planRecordOverlay, type RecordChange } from "../src/record-overlay/index.js";
import type { Frontmatter, OkfDocument } from "../src/types.js";
import { ACTOR, EDITOR, overlayWorld, type World } from "./record-overlay-helpers.js";

const WORK_ITEM = {
  type: "Convention", title: "Work Item", governs: "Work Item", path: "work-items/",
  fields: {
    required: ["title"],
    optional: ["state_category", "close_reason", "labels", "assignees", "code_links", "notes"],
    values: { state_category: ["todo", "done", "canceled"], close_reason: ["completed", "not_planned"] },
    types: { labels: "string-list", assignees: "string-list", code_links: "https-url-list" },
  },
};
const CONNECTOR = `---
type: Connector
title: Example tracker (synthetic)
auth:
  kind: none
domains:
  - tracker.example.org
sources:
  - name: issues
    profile: issues
    target_kind: Work Item
    identity:
      resource: "https://tracker.example.org/{owner}/{repo}"
      id: "{number}"
    fields:
      title: title
      state_category:
        from: state_key
        values: { open: todo, closed_completed: done, closed_not_planned: canceled }
      close_reason:
        from: reason
        values: { completed: completed, not_planned: not_planned }
      labels: labels
      assignees: assignees
      code_links: pulls
    completeness: partial
---
# Example tracker

A synthetic issue tracker for list-valued owned fields.
`;
const URL = "https://tracker.example.org/example-org/widgets";
const FEED_ID = "source-feeds/widgets-issues";
const FEED = {
  type: "Source Feed", title: "Widgets issues (synthetic)", feed_kind: "connector", connector: "connectors/tracker", source: "issues", url: URL,
  owned_fields: ["title", "state_category", "close_reason", "labels", "assignees", "code_links"],
};
const ITEM = "work-items/widgets-42";
const AT = (n: number): string => `2026-10-1${n}T14:00:00Z`;
const PULL = "https://tracker.example.org/example-org/widgets/pull/7";

function connectorOf(md: string, kinds?: KindRegistry): Connector {
  const { frontmatter, body } = parseMarkdown(md);
  const parsed = parseConnectorDoc({ id: "connectors/tracker", frontmatter, body } as OkfDocument, kinds ? { kinds } : {});
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.errors));
  return parsed.connector;
}

interface Tracker { w: World; bound: BoundFeed; store: Map<string, Record<string, unknown>> }

async function tracker(): Promise<Tracker> {
  const w = await overlayWorld({ conventions: { "conventions/work-item": WORK_ITEM } });
  const connector = connectorOf(CONNECTOR, w.content.registry);
  const bound = bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED as unknown as Frontmatter }, w.content.registry, { okfVersion: "0.2" });
  return { w, bound, store: new Map() };
}

const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 42, title: "Crash on save", state_key: "open", reason: null,
  labels: ["bug", "\u{1F600} triage", "\uFF5Eperf"], assignees: ["github:octocat"], pulls: [PULL], ...over,
});

/** One record through mapRecord and changeBetween: an adoption when the store holds nothing. */
function observe(t: Tracker, record: Record<string, unknown>): RecordChange {
  const mapped = mapRecord(t.bound.source, record, t.bound.kind);
  assert.equal(mapped.kind, "mapped", JSON.stringify(mapped));
  if (mapped.kind !== "mapped") throw new Error("unreachable");
  const previous = t.store.get(mapped.external_id) ?? {};
  return changeBetween(previous, mapped, { external_id: mapped.external_id, change_kind: "changed" });
}

async function sync(t: Tracker, change: RecordChange, at: string) {
  t.w.contentBackend.writes = [];
  const plan = await planRecordOverlay({ content: t.w.content, ops: t.w.ops, policy: t.bound.policy, changes: [change], observedAt: at, sameBundle: true });
  const receipt = await applyRecordOverlay(plan, { content: t.w.content, ops: t.w.ops, policy: t.bound.policy, actor: ACTOR });
  if (receipt.results.every((r) => r.outcome !== "refused")) t.store.set(change.external_id, change.after!);
  return { plan, receipt, writes: [...t.w.contentBackend.writes] };
}

/** A person's edit: field actions on one fresh read (a list is replaced whole), then an optional body edit. */
async function editItem(t: Tracker, actions: FieldAction[], body?: string): Promise<void> {
  const base = { bundle: t.w.content.bundle, id: ITEM, mode: "patch" as const, registry: t.w.content.registry, strict: true, actor: EDITOR };
  await mutateDocument({ ...base, expectedVersion: (await t.w.read(ITEM)).version, input: { kind: "field-actions", actions } });
  if (body !== undefined) await mutateDocument({ ...base, buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body }) });
}

// ------------------------------------------------------------------------------------------ mapping

test("mapRecord writes a list field deduplicated in code point order; null is []; absent is unobserved", async () => {
  const { bound } = await tracker();
  const mapped = mapRecord(bound.source, issue({ labels: ["bug", "\u{1F600} triage", "bug", "\uFF5Eperf", "Bug"] }), bound.kind);
  assert.equal(mapped.kind, "mapped");
  if (mapped.kind !== "mapped") return;
  assert.deepEqual(mapped.fields.labels, ["Bug", "bug", "\uFF5Eperf", "\u{1F600} triage"]);
  assert.deepEqual([mapped.fields.assignees, mapped.fields.code_links, mapped.diagnostics], [["github:octocat"], [PULL], []]);
  assert.deepEqual(mapped.cleared, ["close_reason"], "a null scalar still clears");
  const empty = mapRecord(bound.source, issue({ labels: null, assignees: [] }), bound.kind);
  assert.ok(empty.kind === "mapped");
  assert.deepEqual([empty.fields.labels, empty.fields.assignees, empty.cleared.includes("labels")], [[], [], false], "a declared list is always a list");
  const { labels: _labels, ...withoutLabels } = issue();
  const absent = mapRecord(bound.source, withoutLabels, bound.kind);
  assert.ok(absent.kind === "mapped");
  assert.deepEqual([absent.unobserved, Object.hasOwn(absent.fields, "labels")], [["labels"], false], "a mapping gap never empties a list");
});

test("mapRecord leaves a list field unobserved with VALUE_NOT_LIST for anything but a list of nonblank text, and findingsFor groups by shape", async () => {
  const { bound } = await tracker();
  const shapes: Array<[unknown, string]> = [["bug", "scalar"], [["bug", 7], "list"], [["bug", " "], "list"], [{ name: "bug" }, "mapping"]];
  const diagnostics = [];
  for (const [native, shape] of shapes) {
    const mapped = mapRecord(bound.source, issue({ labels: native }), bound.kind);
    assert.ok(mapped.kind === "mapped", shape);
    assert.deepEqual([mapped.unobserved, Object.hasOwn(mapped.fields, "labels")], [["labels"], false], shape);
    assert.deepEqual(mapped.diagnostics.map((d) => [d.code, d.field]), [["VALUE_NOT_LIST", "labels"]], shape);
    diagnostics.push(...mapped.diagnostics);
  }
  const again = mapRecord(bound.source, issue({ number: 43, labels: "docs" }), bound.kind);
  diagnostics.push(...again.diagnostics);
  const findings = findingsFor(diagnostics, { source: "issues" });
  assert.deepEqual(findings.map((f) => f.key).sort(), ["mapping:issues:labels:VALUE_NOT_LIST:list", "mapping:issues:labels:VALUE_NOT_LIST:mapping", "mapping:issues:labels:VALUE_NOT_LIST:scalar"]);
  const scalar = findings.find((f) => f.key.endsWith(":scalar"))!;
  assert.deepEqual(scalar.facts, { code: "VALUE_NOT_LIST", field: "labels", shape: "scalar" });
  assert.match(scalar.summary!, /2 records \(42, 43\)/);
  assert.doesNotMatch(JSON.stringify(findings), /docs/, "no native value in a shape finding");
});

test("a required list field: empty or null is VALUE_MISSING and unobserved", () => {
  const kinds = buildKindRegistry([{ id: "conventions/work-item", body: "", frontmatter: { ...WORK_ITEM, fields: { ...WORK_ITEM.fields, required: ["title", "labels"], optional: WORK_ITEM.fields.optional.filter((f) => f !== "labels") } } as unknown as Frontmatter }]);
  const connector = connectorOf(CONNECTOR, kinds);
  const kind = kinds.kinds.get("Work Item")!;
  for (const labels of [[], null]) {
    const mapped = mapRecord(connector.sources[0]!, issue({ labels }), kind);
    assert.ok(mapped.kind === "mapped");
    assert.deepEqual([mapped.unobserved, mapped.diagnostics.map((d) => d.code)], [["labels"], ["VALUE_MISSING"]], JSON.stringify(labels));
  }
});

test("a list field maps whole: a values table or a Kind's allowed values on it is CONNECTOR_LIST_FIELD_UNSUPPORTED", () => {
  const kinds = buildKindRegistry([{ id: "conventions/work-item", body: "", frontmatter: { ...WORK_ITEM, fields: { ...WORK_ITEM.fields, optional: [...WORK_ITEM.fields.optional, "topics"], types: { ...WORK_ITEM.fields.types, topics: "string-list" }, values: { ...WORK_ITEM.fields.values, topics: ["a", "b"] } } } as unknown as Frontmatter }]);
  const refused = (md: string, path: string) => {
    const { frontmatter, body } = parseMarkdown(md);
    const parsed = parseConnectorDoc({ id: "connectors/tracker", frontmatter, body } as OkfDocument, { kinds });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.ok ? [] : parsed.errors.map((e) => [e.code, e.path]), [["CONNECTOR_LIST_FIELD_UNSUPPORTED", path]]);
  };
  refused(CONNECTOR.replace("      labels: labels\n", "      labels:\n        from: labels\n        values: { Bug: bug }\n"), "/sources/0/fields/labels");
  refused(CONNECTOR.replace("      labels: labels\n", "      labels: labels\n      topics: topics\n"), "/sources/0/fields/topics");
  assert.ok(connectorOf(CONNECTOR, kinds).sources[0]!.fields.labels, "a plain list mapping parses");
});

// ------------------------------------------------------------------------------------- end to end

test("a connector owning labels and assignees adopts, applies a source change with no false conflict, and a no-op sync writes nothing", async () => {
  const t = await tracker();
  assert.deepEqual(t.bound.policy.list_fields, ["assignees", "code_links", "labels"]);
  const adopted = await t.w.put(ITEM, { type: "Work Item", title: "Crash on save", tags: ["mine"], sources: [{ resource: URL, id: "42" }] }, "Person notes.\n");

  // Adoption: before {}, every mapped owned field, one write, no Signal.
  const adoption = observe(t, issue());
  assert.deepEqual([adoption.before, adoption.changed_fields], [{}, ["assignees", "code_links", "labels", "state_category", "title"]]);
  const first = await sync(t, adoption, AT(1));
  assert.deepEqual(first.plan.steps.map((s) => s.op), ["apply-owned-fields"]);
  assert.equal(first.receipt.results[0]!.outcome, "applied", JSON.stringify(first.receipt.results[0]));
  assert.deepEqual(first.writes, [ITEM]);
  let doc = (await t.w.read(ITEM)).doc.frontmatter as Record<string, unknown>;
  assert.deepEqual([doc.labels, doc.assignees, doc.code_links, doc.state_category, doc.tags], [["bug", "\uFF5Eperf", "\u{1F600} triage"], ["github:octocat"], [PULL], "todo", ["mine"]]);
  assert.notEqual((await t.w.read(ITEM)).version, adopted);
  assert.deepEqual(await t.w.contentBackend.list("signals/"), [], "no Signal");

  // A person edits fields the feed does not own, and reorders an owned list without changing the set.
  await editItem(t, [
    { action: "set", field: "notes", value: "repro on macOS" },
    { action: "add", field: "tags", value: "triaged" },
    { action: "replace-all", field: "labels", value: ["\u{1F600} triage", "bug", "\uFF5Eperf"] },
  ], "Person notes, expanded.\n");
  assert.deepEqual((await t.w.read(ITEM)).doc.frontmatter.labels, ["\u{1F600} triage", "bug", "\uFF5Eperf"], "core keeps the person's order");

  // The source relabels, unassigns and closes the issue: applied over the reordered set, no conflict.
  const closed = observe(t, issue({ state_key: "closed_completed", reason: "completed", labels: ["bug", "regression", "\u{1F600} triage", "\uFF5Eperf"], assignees: [] }));
  assert.deepEqual(closed.changed_fields, ["assignees", "close_reason", "labels", "state_category"]);
  const second = await sync(t, closed, AT(2));
  assert.deepEqual([second.plan.refusals, second.plan.steps.map((s) => s.op)], [[], ["apply-owned-fields"]], "no false conflict");
  assert.equal(second.receipt.results[0]!.outcome, "applied", JSON.stringify(second.receipt.results[0]));
  assert.deepEqual(second.writes, [ITEM], "one write");
  const after = (await t.w.read(ITEM)).doc;
  doc = after.frontmatter as Record<string, unknown>;
  assert.deepEqual([doc.labels, doc.assignees, doc.state_category, doc.close_reason], [["bug", "regression", "\uFF5Eperf", "\u{1F600} triage"], [], "done", "completed"]);
  assert.deepEqual([doc.notes, doc.tags, after.body], ["repro on macOS", ["mine", "triaged"], "Person notes, expanded.\n"], "the person's edits survive");

  // The same issue again, its lists reordered and repeated by the source: nothing changes, nothing is written.
  const quiet = observe(t, issue({ state_key: "closed_completed", reason: "completed", labels: ["\uFF5Eperf", "regression", "bug", "\u{1F600} triage", "bug"], assignees: [] }));
  assert.deepEqual(quiet.changed_fields, []);
  const third = await sync(t, quiet, AT(3));
  assert.deepEqual([third.plan.steps.map((s) => s.op), third.writes], [["record-only"], []]);
  assert.deepEqual(await t.w.contentBackend.list("signals/"), []);

  // The source reopens: close_reason is cleared through unset in the same write as the list.
  const reopened = observe(t, issue({ labels: ["bug"], assignees: [] }));
  const fourth = await sync(t, reopened, AT(4));
  assert.equal(fourth.receipt.results[0]!.outcome, "applied", JSON.stringify(fourth.receipt.results[0]));
  doc = (await t.w.read(ITEM)).doc.frontmatter as Record<string, unknown>;
  assert.deepEqual([doc.state_category, Object.hasOwn(doc, "close_reason"), doc.labels, fourth.writes], ["todo", false, ["bug"], [ITEM]]);
});

test("a member a person adds to an owned list is kept: the next source change conflicts with one Signal", async () => {
  const t = await tracker();
  await t.w.put(ITEM, { type: "Work Item", title: "Crash on save", sources: [{ resource: URL, id: "42" }] });
  await sync(t, observe(t, issue()), AT(1));
  await editItem(t, [{ action: "replace-all", field: "labels", value: ["bug", "mine", "\uFF5Eperf", "\u{1F600} triage"] }]);
  const relabel = await sync(t, observe(t, issue({ labels: ["bug", "p1", "\u{1F600} triage", "\uFF5Eperf"] })), AT(2));
  assert.deepEqual(relabel.plan.refusals.map((r) => [r.code, r.field]), [["OVERLAY_DOC_CONFLICT", "labels"]]);
  assert.deepEqual((await t.w.read(ITEM)).doc.frontmatter.labels, ["bug", "mine", "\uFF5Eperf", "\u{1F600} triage"]);
  assert.equal((await t.w.contentBackend.list("signals/")).length, 1);
});
