import assert from "node:assert/strict";
import { test } from "node:test";

import { KindConformanceError, mutateDocument } from "../src/document-mutation.js";
import { kindValueGuidance } from "../src/kinds.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";
import type { Bundle, Frontmatter } from "../src/types.js";

const DONE = "Done means merged and verified; an open PR is not done.";
const BLOCKED = "Name the blocker in the body.";

const TASK_KIND: KindConvention = {
  id: "conventions/task",
  title: "Task",
  governs: "Task",
  fields: {
    required: ["title", "superbee_progress_status"],
    optional: ["priority"],
    values: { superbee_progress_status: ["todo", "in_progress", "blocked", "done"], priority: ["P1", "P2"] },
    valueDescriptions: { superbee_progress_status: { done: DONE, blocked: BLOCKED } },
    terminal: {},
    descriptions: {},
  },
};
const REGISTRY: KindRegistry = { kinds: new Map([[TASK_KIND.governs, TASK_KIND]]), warnings: [] };

async function v02Bundle(): Promise<Bundle> {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  return { root: "/unused", backend };
}

async function seedTask(bundle: Bundle, status: string): Promise<void> {
  await mutateDocument({
    bundle, id: "tasks/a", mode: "create-only", registry: REGISTRY, strict: true,
    buildCandidate: () => ({ frontmatter: { type: "Task", title: "A", superbee_progress_status: status }, body: "" }),
  });
}

async function assign(bundle: Bundle, assignments: Record<string, unknown>, strict = false) {
  return mutateDocument({
    bundle, id: "tasks/a", mode: "patch", registry: REGISTRY, strict,
    input: { kind: "assign", assignments },
  });
}

test("a patch that changes a described value echoes its description under the logical field name", async () => {
  const bundle = await v02Bundle();
  await seedTask(bundle, "in_progress");
  const result = await assign(bundle, { superbee_progress_status: "done" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.guidance, [{ field: "progress_status", value: "done", description: DONE }]);
});

test("an unchanged described value produces no guidance, on a no-op or alongside another edit", async () => {
  const bundle = await v02Bundle();
  await seedTask(bundle, "done");
  const noop = await assign(bundle, { superbee_progress_status: "done" });
  assert.equal(noop.changed, false);
  assert.deepEqual(noop.guidance, []);
  const other = await assign(bundle, { priority: "P1" });
  assert.equal(other.changed, true);
  assert.deepEqual(other.guidance, []);
});

test("an undescribed value produces no guidance", async () => {
  const bundle = await v02Bundle();
  await seedTask(bundle, "in_progress");
  const result = await assign(bundle, { superbee_progress_status: "todo" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.guidance, []);
});

test("a create that sets a described value echoes its description", async () => {
  const bundle = await v02Bundle();
  const result = await mutateDocument({
    bundle, id: "tasks/b", mode: "create-only", registry: REGISTRY, strict: true,
    buildCandidate: () => ({ frontmatter: { type: "Task", title: "B", superbee_progress_status: "blocked" }, body: "" }),
  });
  assert.deepEqual(result.guidance, [{ field: "progress_status", value: "blocked", description: BLOCKED }]);
});

test("an overwrite compares against the stored document it replaces", async () => {
  const bundle = await v02Bundle();
  await seedTask(bundle, "in_progress");
  const overwrite = (title: string, status: string) => mutateDocument({
    bundle, id: "tasks/a", mode: "overwrite", registry: REGISTRY, strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Task", title, superbee_progress_status: status }, body: "" }),
  });
  assert.deepEqual((await overwrite("A2", "done")).guidance, [{ field: "progress_status", value: "done", description: DONE }]);
  const retitled = await overwrite("A3", "done");
  assert.equal(retitled.changed, true);
  assert.deepEqual(retitled.guidance, []);
});

test("a document without a governing Kind produces no guidance", async () => {
  const bundle = await v02Bundle();
  const result = await mutateDocument({
    bundle, id: "notes/a", mode: "create-only", registry: REGISTRY, strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "N", superbee_progress_status: "done" }, body: "" }),
  });
  assert.deepEqual(result.guidance, []);
});

test("a strict write refused for a violation persists nothing and returns no guidance", async () => {
  const bundle = await v02Bundle();
  await seedTask(bundle, "in_progress");
  await assert.rejects(
    assign(bundle, { superbee_progress_status: "done", priority: "P9" }, true),
    KindConformanceError,
  );
  const stored = await assign(bundle, { superbee_progress_status: "in_progress" });
  assert.equal(stored.changed, false);
  assert.deepEqual(stored.guidance, []);
});

test("kindValueGuidance maps only the edition's progress coordinate and reports newly added list members", () => {
  const after: Frontmatter = { type: "Task", superbee_progress_status: "done" };
  assert.deepEqual(kindValueGuidance("0.2", TASK_KIND, undefined, after), [
    { field: "progress_status", value: "done", description: DONE },
  ]);
  // In v0.1 the progress coordinate is `status`, so the stored key is reported as itself.
  assert.deepEqual(kindValueGuidance("0.1", TASK_KIND, undefined, after), [
    { field: "superbee_progress_status", value: "done", description: DONE },
  ]);
  assert.deepEqual(kindValueGuidance("0.2", undefined, undefined, after), []);

  const tagged: KindConvention = {
    ...TASK_KIND,
    fields: {
      ...TASK_KIND.fields,
      values: { labels: ["urgent", "later"] },
      valueDescriptions: { labels: { urgent: "Page the owner." } },
      types: { labels: "string-list" },
    },
  };
  assert.deepEqual(
    kindValueGuidance("0.2", tagged, { type: "Task", labels: ["later"] }, { type: "Task", labels: ["later", "urgent"] }),
    [{ field: "labels", value: "urgent", description: "Page the owner." }],
  );
  assert.deepEqual(
    kindValueGuidance("0.2", tagged, { type: "Task", labels: ["urgent"] }, { type: "Task", labels: ["urgent", "later"] }),
    [],
  );
});
