import test from "node:test";
import assert from "node:assert/strict";

import {
  applyQuerySelectionFilters,
  normalizeQuerySelection,
  type HeadResult,
} from "../src/index.js";

const rows: HeadResult[] = [
  { id: "tasks/a", frontmatter: { type: "Task", status: "todo" } },
  { id: "tasks/b", frontmatter: { type: "Task", status: "in_progress" } },
];

test("normalizes whitespace and keeps repeated fields last-one-wins", () => {
  const selection = normalizeQuerySelection({ fields: ["status=done", "status=todo, in_progress"] });
  assert.deepEqual(selection.params.fields, ["status=todo,in_progress"]);
  assert.deepEqual(
    applyQuerySelectionFilters(rows, selection.params).rows.map((row) => row.id),
    ["tasks/a", "tasks/b"],
  );
});

test("rejects malformed field expressions", () => {
  assert.throws(() => normalizeQuerySelection({ field: "status=" }), /empty value/);
  assert.throws(() => normalizeQuerySelection({ field: "status=todo,,done" }), /empty value/);
});
