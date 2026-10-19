/**
 * Pins review minor m3 (reviews/core-list-fields-6256888f) end to end, as the orchestrator decided:
 * an owned list field that a person or tool removed while it held `[]` is absent, which differs from
 * `[]` under the set comparison, so the next source addition conflicts. One OVERLAY_DOC_CONFLICT,
 * one Signal, the item is not written and the person's state (no key) is kept. Conservative by
 * design: nothing a person did is overwritten. Recipe guidance should say not to strip `[]`.
 *
 * Real parser, bindSourceFeed (v0.2), mapRecord and changeBetween, then the planner and apply over
 * MemoryBackend. Intended location: packages/core/test/connectors-lists-absent-vs-empty.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bindSourceFeed, changeBetween, mapRecord, parseConnectorDoc, type BoundFeed } from "../src/connectors.js";
import { mutateDocument } from "../src/document-mutation.js";
import { parseMarkdown } from "../src/frontmatter.js";
import { applyRecordOverlay, planRecordOverlay, type RecordChange } from "../src/record-overlay/index.js";
import type { Frontmatter, OkfDocument } from "../src/types.js";
import { ACTOR, EDITOR, overlayWorld, type World } from "./record-overlay-helpers.js";

const WORK_ITEM = {
  type: "Convention", title: "Work Item", governs: "Work Item", path: "work-items/",
  fields: {
    required: ["title"],
    optional: ["state_category", "labels", "notes"],
    values: { state_category: ["todo", "done"] },
    types: { labels: "string-list" },
  },
};
const CONNECTOR = `---
type: Connector
title: Example tracker (synthetic)
auth:
  kind: none
domains:
  - tracker.example.org
record_sources:
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
        values: { open: todo, closed: done }
      labels: labels
    completeness: partial
---
# Example tracker

A synthetic issue tracker.
`;
const URL = "https://tracker.example.org/example-org/widgets";
const FEED = {
  type: "Source Feed", title: "Widgets issues (synthetic)", feed_kind: "connector", connector: "connectors/tracker", source: "issues", url: URL,
  owned_fields: ["title", "state_category", "labels"],
};
const ITEM = "work-items/widgets-42";

interface Tracker { w: World; bound: BoundFeed; store: Map<string, Record<string, unknown>> }

async function tracker(): Promise<Tracker> {
  const w = await overlayWorld({ conventions: { "conventions/work-item": WORK_ITEM } });
  const { frontmatter, body } = parseMarkdown(CONNECTOR);
  const parsed = parseConnectorDoc({ id: "connectors/tracker", frontmatter, body } as OkfDocument, { kinds: w.content.registry });
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.errors));
  const bound = bindSourceFeed(parsed.connector, { id: "source-feeds/widgets-issues", frontmatter: FEED as unknown as Frontmatter }, w.content.registry, { okfVersion: "0.2" });
  return { w, bound, store: new Map() };
}

function observe(t: Tracker, record: Record<string, unknown>): RecordChange {
  const mapped = mapRecord(t.bound.source, record, t.bound.kind);
  assert.equal(mapped.kind, "mapped", JSON.stringify(mapped));
  if (mapped.kind !== "mapped") throw new Error("unreachable");
  return changeBetween(t.store.get(mapped.external_id) ?? {}, mapped, { external_id: mapped.external_id, change_kind: "changed" });
}

async function sync(t: Tracker, change: RecordChange, at: string) {
  t.w.contentBackend.writes = [];
  const plan = await planRecordOverlay({ content: t.w.content, ops: t.w.ops, policy: t.bound.policy, changes: [change], observedAt: at, sameBundle: true });
  const receipt = await applyRecordOverlay(plan, { content: t.w.content, ops: t.w.ops, policy: t.bound.policy, actor: ACTOR });
  if (receipt.results.every((r) => r.outcome !== "refused")) t.store.set(change.external_id, change.after!);
  return { plan, receipt, writes: [...t.w.contentBackend.writes] };
}

test("an owned empty list a person removed is absent, not []: the next source addition conflicts once and keeps the person's state", async () => {
  const t = await tracker();
  await t.w.put(ITEM, { type: "Work Item", title: "Crash on save", sources: [{ resource: URL, id: "42" }] });
  const issue = { number: 42, title: "Crash on save", state_key: "open", labels: [] as string[] };

  // Adoption writes the empty list.
  const adopted = await sync(t, observe(t, issue), "2026-10-11T14:00:00Z");
  assert.equal(adopted.receipt.results[0]!.outcome, "applied", JSON.stringify(adopted.receipt.results));
  assert.deepEqual((await t.w.read(ITEM)).doc.frontmatter.labels, []);

  // A person (or an editor that strips empty keys) drops the empty key.
  await mutateDocument({
    bundle: t.w.content.bundle, id: ITEM, mode: "patch", registry: t.w.content.registry, strict: true, actor: EDITOR,
    expectedVersion: (await t.w.read(ITEM)).version, input: { kind: "field-actions", actions: [{ action: "unset", field: "labels" }] },
  });
  const dropped = await t.w.read(ITEM);
  assert.equal(Object.hasOwn(dropped.doc.frontmatter, "labels"), false);

  // The source adds a member: absent differs from [] (the last accepted value), so this conflicts.
  const relabel = await sync(t, observe(t, { ...issue, labels: ["bug"] }), "2026-10-12T14:00:00Z");
  assert.deepEqual(relabel.plan.refusals.map((r) => [r.code, r.field]), [["OVERLAY_DOC_CONFLICT", "labels"]]);
  assert.deepEqual(relabel.plan.steps.filter((s) => s.op === "apply-owned-fields"), [], "no owned-field write");
  assert.ok(!relabel.writes.includes(ITEM), "the item is not written");
  const kept = await t.w.read(ITEM);
  assert.equal(kept.version, dropped.version, "the person's version stands");
  assert.equal(Object.hasOwn(kept.doc.frontmatter, "labels"), false, "the key stays absent");
  assert.equal((await t.w.contentBackend.list("signals/")).length, 1, "one Signal");
});
