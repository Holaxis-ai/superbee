import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { initBundle, writeDoc, readDoc, readDocVersioned, loadKinds, type ValidationWarning } from "@superbee/core";
import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";
import { status } from "../src/commands/status.js";
import { recipe } from "../src/commands/recipe.js";
import { CliError } from "../src/errors.js";
import { mutateDoc } from "../src/mutate.js";
import { DOC_WRITE_USAGE, DOC_UPDATE_USAGE } from "../src/commands/doc/common.js";
async function json(command: typeof newCommand | typeof doc | typeof status | typeof recipe, args: string[]) {
  let out = ""; await command([...args, "--json"], { stdout: s => { out += s; } }); return JSON.parse(out);
}
async function blockedEvolution(dir: string) {
  const incoming = await mkdtemp(path.join(tmpdir(), "sb-kind-recipe-"));
  try {
    const convention = await readDoc({ root: dir }, "conventions/task");
    const fields = convention.frontmatter.fields as Record<string, unknown>;
    await writeDoc({ root: incoming }, { ...convention, frontmatter: {
      ...convention.frontmatter, fields: { ...fields, optional: ["superbee_detail"] },
    } });
    await writeFile(path.join(incoming, "recipe.md"), "---\ntype: Recipe\nid: task-feedback\ntitle: Task feedback\nversion: 2.0.0\nsummary: Task diagnostics\n---\n");
    const args = ["evolve", incoming, "--dir", dir];
    const before = await readFile(path.join(dir, "conventions/task.md"));
    const plan = await json(recipe, args);
    assert.equal(plan.ready, false);
    assert.equal(plan.counts.instances_checked, 1);
    assert.deepEqual(plan.definitions[0].added_paths, ["/frontmatter/fields/optional/superbee_detail"]);
    assert.equal((await json(recipe, args)).plan_token, plan.plan_token);
    await assert.rejects(() => json(recipe, [...args, "--apply", plan.plan_token]), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "CONFLICT");
      assert.deepEqual(error.details?.blockers, plan.blockers);
      return true;
    });
    assert.deepEqual(await readFile(path.join(dir, "conventions/task.md")), before);
    return plan.blockers as Array<{ code: string; field: string; message: string }>;
  } finally { await rm(incoming, { recursive: true, force: true }); }
}
async function rejected(command: typeof newCommand | typeof doc | typeof status, args: string[]): Promise<ValidationWarning[]> {
  try { await json(command, args); } catch (error) {
    assert.ok(error instanceof CliError); assert.equal(error.code, "USAGE"); return error.details?.violations as ValidationWarning[];
  }
  assert.fail("expected rejection");
}
for (const edition of ["0.1", "0.2"] as const) {
  const stored = edition === "0.2" ? "superbee_progress_status" : "status";
  for (const row of [
    { name: "missing", value: undefined, code: "KIND_FIELD_MISSING" },
    { name: "literal bad value", value: stored, code: "KIND_FIELD_VALUE" },
    { name: "enum arity", value: ["todo", "done"], code: "KIND_FIELD_ARITY" },
  ]) test(`Kind command agreement ${edition}: ${row.name}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-feedback-")); const bundle = { root: dir };
    try {
      await initBundle(dir, { okfVersion: edition });
      await writeDoc(bundle, { id: "conventions/task", frontmatter: { type: "Convention", governs: "Task", path: "tasks/", fields: { required: ["title", stored], optional: [], values: { [stored]: ["todo", "done"] } } }, body: "" });
      const suffix = ["--dir", dir];
      const fieldArgs = row.value === undefined ? [] : (Array.isArray(row.value) ? row.value : [row.value]).flatMap(v => ["--progress_status", v]);
      const newWarnings = await rejected(newCommand, ["Task", "new", "--title", "A", ...fieldArgs, ...suffix]);
      await assert.rejects(() => readDoc(bundle, "tasks/new"));
      const strictWrite = await rejected(doc, ["write", "tasks/strict", "--type", "Task", "--title", "A", "--body", "hi", "--strict", ...suffix]);
      assert.equal(strictWrite[0]?.field, "progress_status");
      await assert.rejects(() => readDoc(bundle, "tasks/strict"));
      const write = await json(doc, ["write", "tasks/write", "--type", "Task", "--title", "A", "--body", "hi", ...suffix]);
      if (row.value !== undefined) await writeDoc(bundle, { id: "tasks/write", frontmatter: { type: "Task", title: "A", [stored]: row.value }, body: "hi" });
      const before = await readFile(path.join(dir, "tasks/write.md")); const head = await readDocVersioned(bundle, "tasks/write");
      const advisory = await json(doc, ["update", "tasks/write", "--title", "A", ...suffix]);
      const strict = await rejected(doc, ["update", "tasks/write", "--title", "A", "--strict", ...suffix]);
      const registry = await loadKinds(bundle); let hooks = 0;
      const seam = await mutateDoc({ bundle, id: "tasks/write", registry, strict: false, mode: "overwrite", helpOnKindReject: "fix", errors: {}, onPersisted: () => { hooks++; }, buildCandidate: () => ({ frontmatter: structuredClone(head.doc.frontmatter), body: head.doc.body }) });
      const patchSeam = await mutateDoc({ bundle, id: "tasks/write", registry, strict: false, mode: "patch", helpOnKindReject: "fix", errors: {}, onPersisted: () => { hooks++; }, buildCandidate: () => ({ frontmatter: structuredClone(head.doc.frontmatter), body: head.doc.body }) });
      const groups: ValidationWarning[][] = [patchSeam.warnings, newWarnings, advisory.warnings, strict, seam.warnings, ...(row.value === undefined ? [write.warnings] : [])];
      for (const warnings of groups) {
        const warning = warnings.find(w => w.code === row.code); assert.ok(warning, JSON.stringify(warnings));
        assert.equal(warning.field, "progress_status"); assert.match(warning.message, /'progress_status'/);
        if (row.name === "literal bad value") assert.ok(warning.message.includes(`'${stored}'`));
      }
      const health = await json(status, ["--limit", "0", ...suffix]);
      assert.equal(health.kind_lint.total, 1);
      assert.deepEqual(health.kind_lint.rows, [{ id: "tasks/write", field: "progress_status", code: row.code }]);
      assert.equal(health.conformance_debt, 1);
      assert.equal(health.conformance_debt_docs.total, 1);
      const blockers = await blockedEvolution(dir);
      assert.equal(blockers.length, 1);
      assert.equal(blockers[0]?.code, "RECIPE_EVOLUTION_INSTANCE_INVALID");
      assert.equal(blockers[0]?.field, "progress_status");
      assert.equal(blockers[0]?.message, advisory.warnings.find((w: ValidationWarning) => w.code === row.code)?.message);
      assert.equal(advisory.changed, false); assert.equal(seam.changed, false); assert.equal(hooks, 0);
      assert.deepEqual(await readFile(path.join(dir, "tasks/write.md")), before);
      assert.equal((await readDocVersioned(bundle, "tasks/write")).version, head.version);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
test("same-value dynamic update rejects other missing requirements; help gives supported field authoring", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-dynamic-"));
  try {
    const bundle = { root: dir }; await initBundle(dir);
    await writeDoc(bundle, { id: "conventions/listing", frontmatter: { type: "Convention", governs: "Listing", fields: { required: ["title", "listing_status", "owner"], values: { listing_status: ["open", "closed"] } } }, body: "" });
    await writeDoc(bundle, { id: "listings/a", frontmatter: { type: "Listing", title: "A", listing_status: "open" }, body: "hi" });
    const before = await readFile(path.join(dir, "listings/a.md"));
    const warnings = await rejected(doc, ["update", "listings/a", "--listing_status", "open", "--dir", dir]);
    assert.ok(warnings.some(w => w.field === "owner")); assert.deepEqual(await readFile(path.join(dir, "listings/a.md")), before);
    let help = ""; await newCommand(["Listing", "--help", "--dir", dir], { stdout: s => { help += s; } });
    assert.match(help, /kind field Listing add <name>/); assert.doesNotMatch(help, /edit fields.optional/);
    assert.match(DOC_WRITE_USAGE, /advisory/i); assert.match(DOC_UPDATE_USAGE, /dynamic.*strict/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("advisory retyping projects the resulting Kind while core keeps storage coordinates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-retype-"));
  try {
    const bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "conventions/task", frontmatter: { type: "Convention", governs: "Task", fields: { required: ["title", "superbee_progress_status"], values: { superbee_progress_status: ["todo", "done"] } } }, body: "" });
    await writeDoc(bundle, { id: "notes/a", frontmatter: { type: "Note", title: "A" }, body: "hi" });
    const result = await json(doc, ["update", "notes/a", "--type", "Task", "--dir", dir]);
    assert.equal(result.changed, true);
    assert.equal(result.warnings[0].field, "progress_status");
    const { mutateDocument } = await import("@superbee/core");
    const registry = await loadKinds(bundle);
    const core = await mutateDocument({ bundle, id: "notes/a", mode: "patch", registry, strict: false,
      buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: existing!.body }) });
    assert.equal(core.warnings[0]?.field, "superbee_progress_status");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const edition of ["0.1", "0.2"] as const) {
  test(`actual new/write/update title enum agreement ${edition}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-title-agreement-"));
    try {
      const bundle = { root: dir };
      await initBundle(dir, { okfVersion: edition });
      await writeDoc(bundle, {
        id: "conventions/listing",
        frontmatter: { type: "Convention", governs: "Listing", fields: {
          required: ["title"], values: { title: ["Ready", "Done"] },
        } },
        body: "",
      });
      const suffix = ["--dir", dir];
      const groups: ValidationWarning[][] = [];
      groups.push(await rejected(newCommand, ["Listing", "listings/new", "--title", "Started", ...suffix]));
      await assert.rejects(() => readDoc(bundle, "listings/new"));
      const write = await json(doc, ["write", "listings/write", "--type", "Listing", "--title", "Started", "--body", "hi", ...suffix]);
      assert.equal(write.changed, true);
      groups.push(write.warnings);
      groups.push(await rejected(doc, ["write", "listings/strict", "--type", "Listing", "--title", "Started", "--body", "hi", "--strict", ...suffix]));
      await assert.rejects(() => readDoc(bundle, "listings/strict"));
      const writeBytes = await readFile(path.join(dir, "listings/write.md"));
      groups.push(await rejected(doc, ["write", "listings/write", "--type", "Listing", "--title", "Started", "--body", "hi", "--strict", ...suffix]));
      assert.deepEqual(await readFile(path.join(dir, "listings/write.md")), writeBytes);
      await json(doc, ["write", "listings/update", "--type", "Listing", "--title", "Ready", "--body", "hi", ...suffix]);
      const changed = await json(doc, ["update", "listings/update", "--title", "Started", ...suffix]);
      assert.equal(changed.changed, true);
      groups.push(changed.warnings);
      const updateBytes = await readFile(path.join(dir, "listings/update.md"));
      const noop = await json(doc, ["update", "listings/update", "--title", "Started", ...suffix]);
      assert.equal(noop.changed, false);
      groups.push(noop.warnings);
      groups.push(await rejected(doc, ["update", "listings/update", "--title", "Started", "--strict", ...suffix]));
      assert.deepEqual(await readFile(path.join(dir, "listings/update.md")), updateBytes);
      for (const warnings of groups) {
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]?.code, "KIND_FIELD_VALUE");
        assert.equal(warnings[0]?.field, "title");
        assert.match(warnings[0]!.message, /'Started'/);
        assert.equal(warnings[0]?.message, groups[0]![0]!.message);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}


for (const edition of ["0.1", "0.2"] as const) {
  test(`heading identities survive advisory/strict/status presentation ${edition}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-heading-"));
    try {
      const bundle = { root: dir };
      const stored = edition === "0.2" ? "superbee_progress_status" : "status";
      await initBundle(dir, { okfVersion: edition });
      await writeDoc(bundle, { id: "conventions/task", frontmatter: {
        type: "Convention", governs: "Task", fields: {
          required: ["title", stored], optional: [], values: { [stored]: ["todo", "done"] },
        }, sections: [stored, "progress_status"],
      }, body: "" });
      await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "A", [stored]: "todo" }, body: "no headings" });
      const suffix = ["--dir", dir];
      const before = await readFile(path.join(dir, "tasks/a.md"));
      const advisory = await json(doc, ["update", "tasks/a", "--title", "A", ...suffix]);
      assert.equal(advisory.changed, false);
      assert.deepEqual(advisory.warnings.map((w: ValidationWarning) => w.field), [stored, "progress_status"]);
      for (const warning of advisory.warnings) {
        assert.equal(warning.code, "KIND_SECTION_MISSING");
        assert.ok(warning.message.includes(`# ${warning.field}`));
      }
      await assert.rejects(() => json(doc, ["update", "tasks/a", "--title", "A", "--strict", ...suffix]), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.deepEqual(error.details?.violations, advisory.warnings);
        assert.doesNotMatch(error.help ?? "", /--progress_status/);
        return true;
      });
      const health = await json(status, ["--limit", "0", ...suffix]);
      assert.equal(health.conformance_debt, 0);
      assert.equal(health.kind_lint.total, 2);
      assert.deepEqual(health.kind_lint.rows.map((w: { field: string }) => w.field), [stored, "progress_status"]);
      const blockers = await blockedEvolution(dir);
      assert.equal(blockers.length, 2);
      for (const warning of advisory.warnings) {
        const blocker = blockers.find(b => b.field === warning.field);
        assert.ok(blocker);
        assert.equal(blocker.code, "RECIPE_EVOLUTION_INSTANCE_INVALID");
        assert.equal(blocker.message, warning.message);
      }
      await writeDoc(bundle, { id: "conventions/other", frontmatter: { type: "Convention", governs: "Other", fields: { required: ["other_name"] } }, body: "" });
      await writeDoc(bundle, { id: "others/b", frontmatter: { type: "Other" }, body: "" });
      const withUnrelated = await json(status, ["--limit", "0", ...suffix]);
      assert.equal(withUnrelated.conformance_debt, 1);
      assert.equal(withUnrelated.kind_lint.total, 3);
      assert.deepEqual(withUnrelated.kind_lint.rows.find((w: { id: string }) => w.id === "others/b"),
        { id: "others/b", field: "other_name", code: "KIND_FIELD_MISSING" });
      assert.deepEqual(await readFile(path.join(dir, "tasks/a.md")), before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const edition of ["0.1", "0.2"] as const) {
  test(`ready recipe evolution keeps raw definition paths ${edition}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-kind-ready-"));
    const incoming = await mkdtemp(path.join(tmpdir(), "sb-kind-ready-recipe-"));
    try {
      const bundle = { root: dir };
      const stored = edition === "0.2" ? "superbee_progress_status" : "status";
      await initBundle(dir, { okfVersion: edition });
      const convention = { id: "conventions/task", frontmatter: {
        type: "Convention", governs: "Task", fields: { required: ["title"], optional: [] },
      }, body: "" };
      await writeDoc(bundle, convention);
      await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "A", [stored]: "todo" }, body: "hi" });
      await writeDoc({ root: incoming }, { ...convention, frontmatter: {
        ...convention.frontmatter, fields: { required: ["title"], optional: ["progress_status"] },
      } });
      await writeFile(path.join(incoming, "recipe.md"), "---\ntype: Recipe\nid: task-feedback\ntitle: Task feedback\nversion: 2.0.0\nsummary: Task diagnostics\n---\n");
      const args = ["evolve", incoming, "--dir", dir];
      const before = await readFile(path.join(dir, "tasks/a.md"));
      const plan = await json(recipe, args);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      assert.deepEqual(plan.blockers, []);
      assert.deepEqual(plan.definitions[0].added_paths, [`/frontmatter/fields/optional/${stored}`]);
      assert.equal((await json(recipe, args)).plan_token, plan.plan_token);
      assert.equal((await json(recipe, [...args, "--apply", plan.plan_token, "--actor", "process:cli-kind-builder"])).changed, true);
      assert.deepEqual((await loadKinds(bundle)).kinds.get("Task")?.fields.optional, [stored]);
      assert.deepEqual(await readFile(path.join(dir, "tasks/a.md")), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(incoming, { recursive: true, force: true });
    }
  });
}
