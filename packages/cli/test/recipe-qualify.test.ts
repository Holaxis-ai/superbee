import { boundaryFixture, runCli } from "./support/private-state-fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stringifyDoc, initBundle, writeDoc } from "@superbee/core";
import { parseRecipeFiles, type RecipeFile } from "@superbee/core/recipes";
import { recipe } from "../src/commands/recipe.js";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qualify-set-"));
  const source = path.join(root, "source"); await mkdir(path.join(source, "conventions"), { recursive: true });
  const manifest = stringifyDoc({ type: "Recipe", id: "decision", title: "Decision", version: "1", summary: "Synthetic decisions" }, "");
  const convention = stringifyDoc({ type: "Convention", governs: "Decision", title: "Decision", path: "decisions/" }, "");
  await writeFile(path.join(source, "recipe.md"), manifest); await writeFile(path.join(source, "conventions/decision.md"), convention);
  const config = path.join(root, "config.json"); await writeFile(config, JSON.stringify({ schema: "recipe-qualification/v1", recipes: [{ key: "decisions", source: "./source", namespace: "github.com/123/decisions" }] }));
  return { root, source, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function snapshot(root: string): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  async function walk(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute); else if (entry.isFile()) files[path.relative(root, absolute)] = await readFile(absolute, "utf8");
  } }
  await walk(root); return files;
}
async function run(config: string, flags: string[] = []) { const chunks: string[] = []; await recipe(["qualify", config, ...flags], { stdout: s => { chunks.push(s); } }); assert.equal(chunks.length, 1); return JSON.parse(chunks[0]!); }
test("one JSON stdout artifact roundtrips ordinary recipes without creating files or changing inputs", async () => {
  const f = await fixture(); try {
    const before = await snapshot(f.root); const entries = await readdir(f.root); const output = await run(f.config);
    assert.equal(output.schema, "recipe-qualification-output/v1");
    const files = (output.files as RecipeFile[]).map(file => { assert.ok(file.path.startsWith("decisions/")); return { ...file, path: file.path.slice("decisions/".length) }; });
    const loaded = parseRecipeFiles(files, "stdout artifact", { okfVersion: "0.2" }); assert.ok(loaded.ok);
    assert.deepEqual(loaded.recipe.governs, ["github.com/123/decisions/Decision"]); assert.equal(loaded.recipe.docs[0]!.frontmatter.path, "decisions/");
    assert.match(output.receipt.recipes[0].id, /^ns-[a-f0-9]{64}$/);
    assert.match(output.receipt.recipes[0].commands.install, /recipe add \.\/decisions$/);
    assert.equal(output.receipt.materialization.required, true); assert.equal(output.receipt.materialization.commands_working_directory, "the external materialization root");
    assert.deepEqual(await run(f.config, ["--json"]), output);
    assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await readdir(f.root), entries);
  } finally { await f.cleanup(); }
});
test("explicit existing prerequisites are observed without changing source or bundle bytes", async () => {
  const f = await fixture(); try {
    const bundle = path.join(f.root, "bundle"); await initBundle(bundle, { okfVersion: "0.2" });
    await writeDoc({ root: bundle }, { id: "conventions/task", frontmatter: { type: "Convention", governs: "Task" }, body: "" });
    await writeDoc({ root: bundle }, { id: "tasks/old", frontmatter: { type: "Task", title: "Old" }, body: "Unchanged" });
    await writeFile(path.join(f.source, "conventions/decision.md"), stringifyDoc({ type: "Convention", governs: "Decision", links: { implements: "Task" } }, ""));
    const config = JSON.parse(await readFile(f.config, "utf8")); config.recipes[0].bindings = { Task: { existing: "Task" } }; await writeFile(f.config, JSON.stringify(config));
    const before = await snapshot(f.root); const output = await run(f.config, ["--dir", bundle]);
    assert.equal(output.receipt.prerequisites[0].governs, "Task"); assert.match(output.receipt.prerequisites[0].version, /^sha256:/);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { await f.cleanup(); }
});
test("unsupported legacy assets, source symlinks, duplicate JSON and --out produce no success artifact", async () => {
  for (const mode of ["asset", "symlink", "root-symlink", "duplicate", "out"]) { const f = await fixture(); try {
    if (mode === "asset") await writeFile(path.join(f.source, "unknown.txt"), "not silently dropped");
    if (mode === "symlink") await symlink(path.join(f.source, "recipe.md"), path.join(f.source, "alias.md"));
    if (mode === "root-symlink") {
      await symlink(f.source, path.join(f.root, "source-alias"));
      const config = JSON.parse(await readFile(f.config, "utf8"));
      config.recipes[0].source = "./source-alias";
      await writeFile(f.config, JSON.stringify(config));
    }
    if (mode === "duplicate") await writeFile(f.config, '{"schema":"recipe-qualification/v1","schema":"recipe-qualification/v1","recipes":[]}');
    const before = await snapshot(f.root); const entries = await readdir(f.root); let stdout = "";
    await assert.rejects(recipe(["qualify", f.config, ...(mode === "out" ? ["--out", path.join(f.root, "output")] : [])], { stdout: s => { stdout += s; } }));
    assert.equal(stdout, ""); assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await readdir(f.root), entries);
  } finally { await f.cleanup(); } }
});
test("serialized output is bounded before any success byte is emitted", async () => {
  const f = await fixture(); try {
    const references = Array.from({ length: 4 }, (_, i) => `references/part-${i}.md`);
    await mkdir(path.join(f.source, "references"));
    for (const name of references) await writeFile(path.join(f.source, name), stringifyDoc({ type: "Reference", title: "Bounded fixture" }, "\u0001".repeat(750_000)));
    await writeFile(path.join(f.source, "recipe.md"), stringifyDoc({ type: "Recipe", id: "decision", title: "Decision", version: "1", summary: "Synthetic", content_policy: "definitions-only", references }, ""));
    let stdout = ""; await assert.rejects(recipe(["qualify", f.config], { stdout: s => { stdout += s; } }), /Serialized qualification output exceeds/);
    assert.equal(stdout, "");
  } finally { await f.cleanup(); }
});

test("selected source-root aliases into private state refuse before acquisition", async () => {
  const f = await boundaryFixture();
  try {
    await symlink(f.stateRoot, path.join(f.outside, "source-alias"));
    const config = path.join(f.outside, "config.json");
    await writeFile(config, JSON.stringify({ schema: "recipe-qualification/v1", recipes: [
      { key: "private", source: "./source-alias", namespace: "github.com/123/private" },
    ] }));
    const before = await snapshot(f.root);
    const result = runCli(["recipe", "qualify", config, "--json"], { cwd: f.outside, home: f.home });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /recipe-qualification-output/);
    assert.match(result.stderr + result.stdout, /CONFLICT|private.*state/i);
    assert.deepEqual(await snapshot(f.root), before);
  } finally { f.cleanup(); }
});
