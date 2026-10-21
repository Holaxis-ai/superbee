import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeDoc } from "@superbee/core";
import { recipe } from "../src/commands/recipe.js";
import { CliError } from "../src/errors.js";
import { CLI_LEAVES } from "../src/command-spec.js";
import { retirementFiles, parsedRetirementSource } from "../../core/test/fixtures/recipe-retirement.js";

async function run(args: string[]): Promise<any> { let output = ""; await recipe([...args, "--json"], { stdout: s => { output += s; } }); return JSON.parse(output); }
async function source(dir: string, version: string, retired: boolean): Promise<void> {
  for (const file of retirementFiles(parsedRetirementSource(version, retired))) { await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true }); await writeFile(path.join(dir, file.path), file.bytes); }
}
test("CLI retirement inspection is read-only, full-inventory and never advertises apply", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-retirement-"));
  try {
    const bundle = path.join(dir, "bundle"), recipeDir = path.join(dir, "recipe"); await initBundle(bundle, { okfVersion: "0.2" });
    await source(recipeDir, "1", false); await run(["add", recipeDir, "--dir", bundle]);
    await source(recipeDir, "2", true);
    const before = await readFile(path.join(bundle, "conventions/widget.md"), "utf8");
    const clean = await run(["evolve", recipeDir, "--retirement-scan", "--dir", bundle]);
    assert.equal(clean.local.verdict, "complete-clean"); assert.equal(clean.declarations.length, 3);
    assert.equal(clean.can_apply, false); assert.equal(clean.consumers.status, "unassessed");
    assert.equal(Object.hasOwn(clean, "commands"), false); assert.equal(Object.hasOwn(clean, "plan_token"), false);
    await writeDoc({ root: bundle }, { id: "widgets/one", frontmatter: { type: "Widget", title: "One", legacy: null }, body: "" });
    const used = await run(["evolve", recipeDir, "--retirement-scan", "--dir", bundle]);
    assert.equal(used.local.verdict, "used"); assert.equal(used.local.inventory.length, 2);
    await writeFile(path.join(bundle, "widgets/broken.md"), "---\ntitle: [bad\n---\n");
    const unknown = await run(["evolve", recipeDir, "--retirement-scan", "--dir", bundle]);
    assert.equal(unknown.local.complete, false); assert.notEqual(unknown.local.verdict, "complete-clean");
    assert.equal(await readFile(path.join(bundle, "conventions/widget.md"), "utf8"), before);
    for (const args of [ ["--retirement-scan", "--apply", "bogus"], ["--retirement-evidence", "missing.json"] ]) {
      await assert.rejects(run(["evolve", recipeDir, ...args, "--dir", bundle]), (error: unknown) => error instanceof CliError && error.code === "USAGE");
    }
    const json = path.join(dir, "invalid.json"); await writeFile(json, "{bad");
    await assert.rejects(run(["evolve", recipeDir, "--retirement-scan", "--retirement-evidence", json, "--dir", bundle]), /invalid JSON/);
    await writeFile(json, "null");
    const refused = await run(["evolve", recipeDir, "--retirement-scan", "--retirement-evidence", json, "--dir", bundle]);
    assert.equal(refused.consumers.status, "refused"); assert.equal(refused.can_apply, false);
    assert.ok(CLI_LEAVES.recipeEvolve.pathFlags.some(flag => flag.flag === "retirement-evidence" && flag.role === "ingress"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
