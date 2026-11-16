import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stringifyDoc } from "@superbee/core";
import { recipe } from "../src/commands/recipe.js";
import { writeQualifiedRecipeSet } from "../src/commands/recipe-qualify.js";
import { resolveRecipe } from "../src/recipe-source.js";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qualify-set-"));
  const source = path.join(root, "source"); await mkdir(path.join(source, "conventions"), { recursive: true });
  const manifest = stringifyDoc({ type: "Recipe", id: "decision", title: "Decision", version: "1", summary: "Synthetic decisions" }, "");
  const convention = stringifyDoc({ type: "Convention", governs: "Decision", title: "Decision", path: "decisions/" }, "");
  await writeFile(path.join(source, "recipe.md"), manifest); await writeFile(path.join(source, "conventions/decision.md"), convention);
  const config = path.join(root, "config.json"); await writeFile(config, JSON.stringify({ schema: "recipe-qualification/v1", recipes: [{ key: "decisions", source: "./source", namespace: "github.com/123/decisions" }] }));
  return { root, source, config, out: path.join(root, "prepared"), cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function run(config: string, out: string) { let result = ""; await recipe(["qualify", config, "--out", out, "--json"], { stdout: s => { result += s; } }); return JSON.parse(result); }
test("CLI emits ordinary recipe folders, exact receipts and retains source bytes", async () => {
  const f = await fixture(); try {
    const before = await readFile(path.join(f.source, "conventions/decision.md"), "utf8"); const receipt = await run(f.config, f.out);
    assert.equal(receipt.recipe_set, "qualified"); const loaded = await resolveRecipe(path.join(f.out, "decisions")); assert.ok(loaded.ok);
    assert.deepEqual(loaded.recipe.governs, ["github.com/123/decisions/Decision"]);
    assert.equal(loaded.recipe.docs[0]!.frontmatter.path, "decisions/");
    const detail = JSON.parse(await readFile(path.join(f.out, "preparation-receipt.json"), "utf8"));
    assert.match(detail.recipes[0].id, /^ns-[a-f0-9]{64}$/); assert.match(detail.recipes[0].commands.install, /recipe add/);
    assert.equal(await readFile(path.join(f.source, "conventions/decision.md"), "utf8"), before);
    await assert.rejects(run(f.config, f.out), /new folder/);
  } finally { await f.cleanup(); }
});
test("unsupported legacy assets, source symlinks and duplicate JSON keys leave no final output", async () => {
  for (const mode of ["asset", "symlink", "duplicate"]) { const f = await fixture(); try {
    if (mode === "asset") await writeFile(path.join(f.source, "unknown.txt"), "not silently dropped");
    if (mode === "symlink") await symlink(path.join(f.source, "recipe.md"), path.join(f.source, "alias.md"));
    if (mode === "duplicate") await writeFile(f.config, '{"schema":"recipe-qualification/v1","schema":"recipe-qualification/v1","recipes":[]}');
    await assert.rejects(run(f.config, f.out)); assert.ok(!(await readdir(f.root)).includes("prepared")); assert.ok(!(await readdir(f.root)).some(n => n.startsWith(".recipe-qualification-")));
  } finally { await f.cleanup(); } }
});
test("output refuses bundles, source descendants, existing empty targets, symlink aliases and traversal", async () => {
  const f = await fixture(); try {
    await assert.rejects(run(f.config, path.join(f.source, "inside")), /outside every source/);
    await mkdir(f.out); await assert.rejects(run(f.config, f.out), /new folder/); await rm(f.out, { recursive: true });
    await symlink(path.join(f.root, "absent"), f.out); await assert.rejects(run(f.config, f.out), /new folder/); await rm(f.out);
    const bundle = path.join(f.root, "bundle"); await mkdir(bundle); await writeFile(path.join(bundle, "index.md"), "---\nokf_version: '0.2'\n---\n");
    await assert.rejects(run(f.config, path.join(bundle, "output")), /outside any bundle/);
    await assert.rejects(writeQualifiedRecipeSet(f.out, [f.source], [{ path: "../escape.txt", bytes: "bad" }]));
    assert.ok(!(await readdir(f.root)).includes("prepared"));
  } finally { await f.cleanup(); }
});
test("partial publication failure rolls back owned final files and concurrent attempts never clobber", async () => {
  const f = await fixture(); try {
    await assert.rejects(writeQualifiedRecipeSet(f.out, [f.source], [{ path: "a", bytes: "one" }, { path: "a/child", bytes: "two" }]));
    assert.ok(!(await readdir(f.root)).includes("prepared")); assert.ok(!(await readdir(f.root)).some(n => n.startsWith(".recipe-qualification-")));
    const results = await Promise.allSettled([run(f.config, f.out),run(f.config, f.out)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok((await resolveRecipe(path.join(f.out, "decisions"))).ok);
  } finally { await f.cleanup(); }
});

test("a failure after the first final file rolls back only this invocation's output", async t => {
  const f = await fixture();
  const link = fs.link; let calls = 0;
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
    if (++calls === 2) throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
    return link(...args);
  });
  try {
    await assert.rejects(run(f.config, f.out), /Could not publish/);
    assert.equal(calls, 2); assert.ok(!(await readdir(f.root)).includes("prepared"));
    assert.ok(!(await readdir(f.root)).some(name => name.startsWith(".recipe-qualification-")));
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});
