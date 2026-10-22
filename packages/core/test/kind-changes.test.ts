import assert from "node:assert/strict";
import test from "node:test";
import { classifyKindChanges } from "../src/kind-changes.js";
import { parseConventionDoc, type KindConvention } from "../src/kinds.js";

function kind(extra: Record<string, unknown> = {}): KindConvention {
  const parsed = parseConventionDoc({ id: "conventions/task", body: "", frontmatter: {
    type: "Convention", title: "Task", governs: "Task", fields: { required: ["title"], optional: ["status"], values: { status: ["todo", "done"] }, terminal: { status: ["done"] } }, ...extra,
  } }, { okfVersion: "0.2" });
  assert.ok(parsed.ok);
  return parsed.kind;
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const entry of Object.values(value)) freeze(entry);
  Object.freeze(value);
}

test("parsed declaration facts preserve occurrences, desired enum order and independent declaration status", () => {
  const before = kind();
  const after = kind({ fields: { required: ["title", "owner", "owner"], optional: ["status", "new"],
    values: { status: ["done"], owner: ["one"], new: ["yes"], hidden: ["no"] }, terminal: { status: ["done"] } }, sections: ["Why", "Why"] });
  freeze(before); freeze(after);
  const changes = classifyKindChanges(before, after);
  assert.deepEqual(changes.requiredAdded, ["owner", "owner"]);
  assert.deepEqual(changes.sectionsAdded, ["Why", "Why"]);
  assert.deepEqual(changes.enumsNarrowed, [{ field: "status", removedValues: ["todo"] }]);
  assert.deepEqual(changes.enumsAdded, [
    { field: "owner", values: ["one"], currentDeclared: false, desiredDeclared: true },
    { field: "new", values: ["yes"], currentDeclared: false, desiredDeclared: true },
    { field: "hidden", values: ["no"], currentDeclared: false, desiredDeclared: false },
  ]);
  assert.equal(changes.terminalChanged, false);
  assert.equal(changes.terminalOccurrencesChanged, false);
  const unchanged = classifyKindChanges(before, before);
  assert.ok(Object.values(unchanged).every(value => value === false || Array.isArray(value) && value.length === 0));
});

test("parsed relationships distinguish added, removed and retargeted keys including prototype names", () => {
  const before = kind({ links: { "goes ": "Task", removed: "Task", constructor: "Task" }, expects_inbound: { stays: "Task", retarget: "Task" } });
  const after = kind({ links: { goes: "Project", constructor: "Task", toString: "Task" }, expects_inbound: { stays: "Task", retarget: "Project", added: "Task" } });
  const changes = classifyKindChanges(before, after);
  assert.deepEqual(changes.outboundChanged, [{ field: "goes", previous: "Task", next: "Project" }, { field: "removed", previous: "Task" }]);
  assert.deepEqual(changes.outboundAdded, ["toString"]);
  assert.deepEqual(changes.inboundChanged, [{ field: "retarget", previous: "Task", next: "Project" }]);
  assert.deepEqual(changes.inboundAdded, ["added"]);
});

test("type updates interleave additions and changes in desired order before current-order removals", () => {
  const before = kind({ fields: { required: ["title"], optional: ["changed", "removeB", "removeA", "addedA", "addedB"], types: { changed: "number", removeB: "boolean", removeA: "date" } } });
  const after = kind({ fields: { required: ["title"], optional: ["changed", "removeB", "removeA", "addedA", "addedB"], types: { addedA: "date", changed: "string-list", addedB: "boolean" } } });
  const changes = classifyKindChanges(before, after);
  assert.deepEqual(changes.typesUpdated, [
    { change: "added", field: "addedA", nextType: "date" },
    { change: "changed", field: "changed", previousType: "number", nextType: "string-list" },
    { change: "added", field: "addedB", nextType: "boolean" },
  ]);
  assert.deepEqual(changes.typesRemoved, ["removeB", "removeA"]);
});

test("terminal order and duplicate occurrence facts remain distinct without mutating inputs", () => {
  const before = kind(); before.fields.terminal.status = ["done", "todo", "done"];
  const after = kind(); after.fields.terminal.status = ["todo", "done", "done"];
  freeze(before); freeze(after);
  const reordered = classifyKindChanges(before, after);
  assert.equal(reordered.terminalChanged, true);
  assert.equal(reordered.terminalOccurrencesChanged, false);
  const fewer = kind(); fewer.fields.terminal.status = ["done", "todo"];
  assert.equal(classifyKindChanges(before, fewer).terminalOccurrencesChanged, true);
});

test("malformed terminal representations never establish equality or execute accessors", () => {
  const sparse = new Array(1);
  const inherited = Object.setPrototypeOf(new Array(1), { 0: "done" });
  const getter = ["done"];
  Object.defineProperty(getter, 0, { enumerable: true, get() { throw new Error("must not execute"); } });
  const extra = Object.assign(["done"], { extra: "x" });
  for (const value of [sparse, inherited, getter, extra, [NaN], [-0]]) {
    const candidate = kind(); candidate.fields.terminal = { status: value } as KindConvention["fields"]["terminal"];
    const changes = classifyKindChanges(candidate, candidate);
    assert.equal(changes.terminalChanged, true);
    assert.equal(changes.terminalOccurrencesChanged, true);
  }
});
