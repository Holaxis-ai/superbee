import assert from "node:assert/strict";
import test from "node:test";
import { projectKindValidationWarnings, validateAgainstKind, type KindConvention } from "../src/kinds.js";

for (const edition of ["0.1", "0.2"] as const) {
  const stored = edition === "0.2" ? "superbee_progress_status" : "status";
  for (const governs of ["Task", stored, `Kind '${stored}' label`]) {
  const kind: KindConvention = {
    id: "conventions/task", title: "Task", governs,
    fields: { required: [stored, "other_name"], optional: [],
      values: { [stored]: ["todo", "done"] }, terminal: {}, descriptions: {} },
    sections: [stored],
  };
  for (const row of [
    { name: "missing", value: undefined, code: "KIND_FIELD_MISSING" },
    { name: "literal value", value: stored, code: "KIND_FIELD_VALUE" },
    { name: "arity", value: ["todo", "done"], code: "KIND_FIELD_ARITY" },
  ]) {
    test(`diagnostic coordinate namespaces ${edition} ${governs}: ${row.name}`, () => {
      const raw = validateAgainstKind({ id: "tasks/a", frontmatter: {
        type: governs, ...(row.value === undefined ? {} : { [stored]: row.value }),
      }, body: "" }, kind);
      const original = structuredClone(raw);
      const projected = projectKindValidationWarnings(edition, kind, raw);
      const field = projected.find(w => w.code === row.code && w.field === "progress_status");
      assert.ok(field);
      const expected = row.code === "KIND_FIELD_MISSING"
        ? `'${governs}' requires a non-empty 'progress_status' field (declared by conventions/task).`
        : row.code === "KIND_FIELD_VALUE"
          ? `'progress_status' value '${stored}' is not one of the allowed values for '${governs}': todo, done.`
          : `'progress_status' is enum-restricted and takes exactly ONE value for '${governs}'; got 2 (todo, done).`;
      assert.equal(field.message, expected);
      if (row.name === "literal value") assert.ok(field.message.includes(`'${stored}'`));
      const section = raw.find(w => w.code === "KIND_SECTION_MISSING")!;
      assert.equal(projected.find(w => w.code === "KIND_SECTION_MISSING"), section);
      assert.equal(section.field, stored);
      assert.match(section.message, new RegExp(`# ${stored}`));
      assert.equal(projected.find(w => w.field === "other_name"), raw.find(w => w.field === "other_name"));
      assert.equal(projected.length, raw.length);
      assert.deepEqual(projected.map(w => w.code), raw.map(w => w.code));
      assert.equal(raw.find(w => w.code === row.code)?.field, stored);
      assert.deepEqual(raw, original);
    });
  }
}
}
