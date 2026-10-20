import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle } from "@superbee/core";
import { recipe } from "../src/commands/recipe.js";
import { recipes } from "../src/commands/recipes.js";

async function receipt(argv: string[]): Promise<Record<string, unknown>> {
  let text = "";
  await recipe([...argv, "--json"], { stdout: value => { text += value; } });
  return JSON.parse(text);
}

test("CLI projects Core's retained definitions and truthful guidance through plan, apply and zero-write plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-orphan-cli-"));
  const dir = path.join(root, "bundle");
  const source = path.join(root, "recipe");
  const manifest = (references: boolean) => `---\ntype: Recipe\nid: cli-orphans\ntitle: CLI orphan fixture\nversion: "${references ? "1" : "2"}"\nsummary: Synthetic reporting fixture\ncontent_policy: definitions-only\n${references ? "references: [references/guide.md]\n" : ""}---\n`;
  try {
    await initBundle(dir);
    await mkdir(path.join(source, "conventions"), { recursive: true });
    await mkdir(path.join(source, "references"));
    await writeFile(path.join(source, "recipe.md"), manifest(true));
    await writeFile(path.join(source, "conventions/item.md"), "---\ntype: Convention\ntitle: Item\ngoverns: Item\nfields:\n  required: [title]\n---\n# Item\n");
    await writeFile(path.join(source, "references/guide.md"), "---\ntype: Reference\ntitle: Guide\n---\n# Guide\n");
    await receipt(["add", source, "--dir", dir]);
    const retained = await readFile(path.join(dir, "references/guide.md"));
    await writeFile(path.join(source, "recipe.md"), manifest(false));
    await rm(path.join(source, "references/guide.md"));
    const plan = await receipt(["evolve", source, "--dir", dir]);
    const expected = [{ id: "references/guide", type: "Reference" }];
    assert.deepEqual(plan.orphaned_definitions, expected);
    assert.match(String(plan.orphaned_help), /never changes or removes/);
    assert.match(String(plan.orphaned_help), /zero-write plan does not resolve/);
    const applied = await receipt(["evolve", source, "--dir", dir, "--apply", String(plan.plan_token)]);
    assert.deepEqual(applied.orphaned_definitions, expected);
    assert.equal(applied.orphaned_help, plan.orphaned_help);
    const settled = await receipt(["evolve", source, "--dir", dir]);
    assert.equal(settled.writes, 0);
    assert.deepEqual(settled.orphaned_definitions, expected);
    assert.equal(settled.commands, undefined, "no cleanup action is invented");
    assert.deepEqual(await readFile(path.join(dir, "references/guide.md")), retained);
    await writeFile(path.join(dir, "conventions/leftover.md"), await readFile(path.join(dir, "conventions/item.md")));
    let inventory = "";
    await recipes(["--dir", dir, "--json"], { stdout: value => { inventory += value; } });
    const listed = JSON.parse(inventory);
    assert.match(String(listed.stamp_help), /never changed or removed by evolve/);
    assert.doesNotMatch(String(listed.stamp_help), /converges them/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
