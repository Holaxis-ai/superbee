import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initBundle, writeDoc, readDoc, loadKinds, validateAgainstKind, SUPERBEE_PROGRESS_STATUS_FIELD, type OkfDocument } from "@superbee/core";
import { inferKindCandidate, draftPromotions, collectInstanceStats, warningsAfterApply } from "../src/kind-draft.js";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { promote } from "../src/commands/promote.js";
const metadata = ["generated", "verified", "actor", "timestamp", "superbee_updated_by", "head_version", "superbee_custom"];
for (const presence of ["all", "partial"]) test(`inference excludes ${presence} metadata from declarations, enums and promotions`, () => {
  const docs: OkfDocument[] = Array.from({ length: 10 }, (_, i) => ({ id: `showings/${i}`, frontmatter: { type: "Showing", title: `Showing ${i}`, listing_status: i % 2 ? "open" : "closed", ...(presence === "all" || i < 6 ? Object.fromEntries(metadata.map(key => [key, i % 2 ? "one" : "two"])) : {}) }, body: "# Feedback\n\n# Visitors\n" }));
  const stats = collectInstanceStats(docs); const kind = inferKindCandidate("Showing", docs, stats);
  assert.deepEqual(kind.fields.required, ["listing_status", "title"]); assert.deepEqual(kind.fields.optional, []);
  assert.deepEqual(kind.fields.values, { listing_status: ["closed", "open"] }); assert.deepEqual(kind.sections, ["Feedback", "Visitors"]);
  assert.deepEqual(draftPromotions(kind, stats), []); assert.equal(warningsAfterApply(kind, docs), 0);
});
test("domain inference from doc write, new and promote retains title and sections", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-domain-inference-")); const sink = { stdout: () => {} };
  try {
    const bundle = { root: dir }; await initBundle(dir); const body = "# Feedback\n\n# Visitors\n";
    await doc(["write", "showings/a", "--type", "Showing", "--title", "A", "--body", body, "--actor", "process:test", "--dir", dir], sink);
    await writeDoc(bundle, { id: "conventions/showing", frontmatter: { type: "Convention", governs: "Showing", fields: { required: ["title"] }, sections: ["Feedback", "Visitors"] }, body: "" });
    await newCommand(["Showing", "showings/b", "--title", "B", "--actor", "process:test", "--dir", dir], sink);
    const file = path.join(dir, "import.md"); await writeFile(file, `---\ntype: Showing\ntitle: C\nactor: human:importer\nhead_version: receipt\nsuperbee_custom: value\n---\n${body}`);
    await promote([file, "--doc-key", "showings/c.md", "--dir", dir], sink);
    const docs = await Promise.all(["a", "b", "c"].map(id => readDoc(bundle, `showings/${id}`))); const stats = collectInstanceStats(docs); const candidate = inferKindCandidate("Showing", docs, stats);
    assert.deepEqual(candidate.fields.required, ["title"]); assert.deepEqual(candidate.fields.optional, []); assert.deepEqual(candidate.fields.values, {});
    assert.deepEqual(candidate.sections, ["Feedback", "Visitors"]); assert.deepEqual(draftPromotions(candidate, stats), []); assert.equal(warningsAfterApply(candidate, docs), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const presence of ["all", "partial"] as const) test(`workflow inference preserves ${presence} user-authored progress status`, () => {
  const field = SUPERBEE_PROGRESS_STATUS_FIELD;
  const docs: OkfDocument[] = Array.from({ length: 10 }, (_, i) => ({
    id: `tasks/${i}`,
    frontmatter: { type: "Task", title: `Task ${i}`, ...(presence === "all" || i < 6 ? { [field]: i % 2 ? "todo" : "done" } : {}) },
    body: "",
  }));
  const stats = collectInstanceStats(docs);
  const candidate = inferKindCandidate("Task", docs, stats);
  assert.deepEqual(candidate.fields.required, presence === "all" ? [field, "title"] : ["title"]);
  assert.deepEqual(candidate.fields.optional, presence === "all" ? [] : [field]);
  assert.deepEqual(candidate.fields.values, presence === "all" ? { [field]: ["done", "todo"] } : {});
  assert.deepEqual(candidate.fields.terminal, {});
  assert.deepEqual(draftPromotions(candidate, stats), presence === "all" ? [] : [{
    declaration: `field ${field} (optional -> required)`, present: "6/10", warnings_if_added: 4,
  }]);
  assert.equal(warningsAfterApply(candidate, docs), 0);
});

for (const row of [
  { name: "below minimum count", count: 9, value: (i: number) => i % 2 ? "todo" : "done" },
  { name: "one distinct value", count: 10, value: () => "todo" },
  { name: "too many distinct values", count: 10, value: (i: number) => `state-${i % 7}` },
  { name: "array arity", count: 10, value: (i: number) => [i % 2 ? "todo" : "done"] },
]) test(`workflow enum inference respects ${row.name}`, () => {
  const docs: OkfDocument[] = Array.from({ length: row.count }, (_, i) => ({
    id: `tasks/${i}`, frontmatter: { type: "Task", [SUPERBEE_PROGRESS_STATUS_FIELD]: row.value(i) }, body: "",
  }));
  const candidate = inferKindCandidate("Task", docs);
  assert.deepEqual(candidate.fields.required, [SUPERBEE_PROGRESS_STATUS_FIELD]);
  assert.deepEqual(candidate.fields.values, {});
  assert.deepEqual(candidate.fields.terminal, {});
  assert.equal(warningsAfterApply(candidate, docs), 0);
});

test("built v0.2 kind draft/apply preserves stored workflow and logical progress_status authoring", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-workflow-inference-"));
  const cli = fileURLToPath(new URL("../../superbee/dist/superbee.mjs", import.meta.url));
  const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--dir", dir, "--json"], {
    encoding: "utf8", env: { ...process.env, ASLITE_NO_UPDATE_CHECK: "1", AGENTSTATE_LITE_NO_AUTOPULL: "1" },
  }));
  try {
    await initBundle(dir, { okfVersion: "0.2" });
    for (let i = 0; i < 10; i++) await writeDoc({ root: dir }, {
      id: `tasks/${i}`, frontmatter: { type: "Workflow Task", title: `Task ${i}`, [SUPERBEE_PROGRESS_STATUS_FIELD]: i % 2 ? "todo" : "done" }, body: "",
    });
    const plan = run(["kind", "draft", "Workflow Task"]);
    assert.deepEqual(plan.candidate.required, [SUPERBEE_PROGRESS_STATUS_FIELD, "title"]);
    assert.deepEqual(plan.candidate.values, { [SUPERBEE_PROGRESS_STATUS_FIELD]: ["done", "todo"] });
    assert.equal(plan.warnings_after_apply, 0);
    assert.equal(run(["kind", "draft", "Workflow Task", "--apply", plan.plan_token, "--actor", "process:test"]).warnings_after_apply, 0);
    const governing = (await loadKinds({ root: dir })).kinds.get("Workflow Task");
    assert.ok(governing);
    assert.deepEqual(governing.fields.terminal, {});
    run(["new", "Workflow Task", "added", "--title", "Added", "--progress_status", "todo", "--actor", "process:test"]);
    run(["doc", "update", "tasks/added", "--progress_status", "done", "--actor", "process:test"]);
    for (const id of [...Array.from({ length: 10 }, (_, i) => `tasks/${i}`), "tasks/added"]) {
      const stored = await readDoc({ root: dir }, id);
      assert.equal(stored.frontmatter.progress_status, undefined);
      assert.ok(["done", "todo"].includes(stored.frontmatter[SUPERBEE_PROGRESS_STATUS_FIELD] as string));
      assert.deepEqual(validateAgainstKind(stored, governing), []);
    }
    assert.equal((await readDoc({ root: dir }, "tasks/added")).frontmatter[SUPERBEE_PROGRESS_STATUS_FIELD], "done");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
