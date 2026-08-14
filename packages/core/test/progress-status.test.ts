import test from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_STATUS_FIELD,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  kindInputFieldNames,
  progressStatusCoordinate,
  projectLogicalKindFields,
  readKindField,
  resolveKindFieldCoordinate,
  type KindConvention,
} from "../src/kinds.js";

function kind(field: string): KindConvention {
  return {
    id: "conventions/task",
    title: "Task",
    governs: "Task",
    fields: {
      required: ["title", field],
      optional: ["priority"],
      values: { [field]: ["todo", "in_progress", "done"] },
      terminal: { [field]: ["done"] },
      descriptions: {},
    },
  };
}

for (const row of [
  { version: undefined, field: "status" },
  { version: "0.1", field: "status" },
  { version: "0.2", field: SUPERBEE_PROGRESS_STATUS_FIELD },
] as const) {
  test(`progress_status compiles to ${row.field} for OKF ${row.version ?? "default"}`, () => {
    const declared = kind(row.field);
    assert.deepEqual(progressStatusCoordinate(row.version, declared), {
      logicalField: PROGRESS_STATUS_FIELD,
      storageField: row.field,
    });
    assert.deepEqual(resolveKindFieldCoordinate(row.version, declared, PROGRESS_STATUS_FIELD), {
      logicalField: PROGRESS_STATUS_FIELD,
      storageField: row.field,
    });
    assert.equal(readKindField(row.version, declared, { type: "Task", [row.field]: "todo" }, PROGRESS_STATUS_FIELD), "todo");
    assert.deepEqual(projectLogicalKindFields(row.version, declared, { type: "Task", [row.field]: "todo" }), {
      type: "Task",
      [row.field]: "todo",
      progress_status: "todo",
    });
    assert.deepEqual(kindInputFieldNames(row.version, declared), ["title", row.field, "priority", "progress_status"]);
  });
}

test("v0.2 never reclassifies lifecycle status from its value", () => {
  const lifecycleOnly = kind("status");
  assert.equal(progressStatusCoordinate("0.2", lifecycleOnly), undefined);
  assert.equal(resolveKindFieldCoordinate("0.2", lifecycleOnly, PROGRESS_STATUS_FIELD), undefined);
  assert.equal(readKindField("0.2", lifecycleOnly, { type: "Task", status: "todo" }, PROGRESS_STATUS_FIELD), undefined);
  assert.deepEqual(projectLogicalKindFields("0.2", lifecycleOnly, { type: "Task", status: "todo" }), {
    type: "Task",
    status: "todo",
  });
});

test("unknown OKF editions do not receive an inferred progress mapping", () => {
  assert.equal(progressStatusCoordinate("0.3", kind("status")), undefined);
  assert.equal(progressStatusCoordinate("0.3", kind(SUPERBEE_PROGRESS_STATUS_FIELD)), undefined);
});
