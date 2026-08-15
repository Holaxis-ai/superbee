/**
 * The shipped-recipe source: a NAME resolves to a portable recipe folder carried by the running
 * distribution. It is an acquisition adapter only — every ref it does not own returns `null` so the
 * next source in line still gets its turn, and containment refuses a folder that symlinks out of the
 * distribution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SHIPPED_RECIPES_SUBDIR, shippedRecipeNames, shippedRecipeSource } from "../src/recipe-source.js";
import { resolveRecipe } from "../src/recipe-source.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SHIPPED_PACKAGE_ROOT = path.join(REPO_ROOT, "packages/cli");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "superbee-shipped-recipe-test-"));
}

/** A throwaway distribution root carrying one minimal recipe under `references/recipes/<name>/`. */
async function fakeDistribution(name: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await tempDir();
  const dir = path.join(root, SHIPPED_RECIPES_SUBDIR, name);
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await writeFile(
    path.join(dir, "recipe.md"),
    `---\ntype: Recipe\nid: ${name}\ntitle: Fake\nversion: "1"\nsummary: A fake shipped recipe.\n` +
      "content_policy: definitions-only\n---\n# Fake\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "conventions", "widget.md"),
    "---\ntype: Convention\ntitle: Widget\ngoverns: Widget\nfields:\n  required: [title]\n---\n# Widget\n",
    "utf8",
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a shipped name resolves through the same parser every other source uses", async () => {
  const { root, cleanup } = await fakeDistribution("fake-recipe");
  try {
    const result = await shippedRecipeSource(root).resolve("fake-recipe");
    assert.ok(result);
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.recipe.id, "fake-recipe");
    assert.deepEqual(result.recipe.governs, ["Widget"]);
    assert.equal(result.recipe.contentPolicy, "definitions-only");
    assert.deepEqual(await shippedRecipeNames(root), ["fake-recipe"]);
  } finally {
    await cleanup();
  }
});

test("refs this source does not own fall through as null rather than failing the whole resolve", async () => {
  const { root, cleanup } = await fakeDistribution("fake-recipe");
  try {
    const source = shippedRecipeSource(root);
    for (const ref of [
      "./fake-recipe", // path-shaped: the filesystem source owns it
      "~/fake-recipe",
      "some/where/fake-recipe",
      "..", // never reaches a path.join
      ".hidden",
      "Fake-Recipe", // names are lowercase
      "fake_recipe",
      "not-shipped",
      "",
    ]) {
      assert.equal(await source.resolve(ref), null, `expected a fall-through for '${ref}'`);
    }
  } finally {
    await cleanup();
  }
});

test("a distribution carrying no shipped recipes falls through instead of erroring", async () => {
  const root = await tempDir();
  try {
    assert.equal(await shippedRecipeSource(root).resolve("engineering-review"), null);
    assert.deepEqual(await shippedRecipeNames(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recipe folder symlinked out of the distribution is not a shipped recipe", async () => {
  const outside = await fakeDistribution("real-recipe");
  const root = await tempDir();
  try {
    await mkdir(path.join(root, SHIPPED_RECIPES_SUBDIR), { recursive: true });
    await symlink(
      path.join(outside.root, SHIPPED_RECIPES_SUBDIR, "real-recipe"),
      path.join(root, SHIPPED_RECIPES_SUBDIR, "escaped"),
      "dir",
    );
    assert.equal(await shippedRecipeSource(root).resolve("escaped"), null);
  } finally {
    await outside.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a built-in name still wins over a same-named shipped folder", async () => {
  const { root, cleanup } = await fakeDistribution("context-notes");
  try {
    // The shipped source WOULD resolve it, so ordering is what makes the built-in authoritative.
    const shipped = await shippedRecipeSource(root).resolve("context-notes");
    assert.ok(shipped && shipped.ok && shipped.recipe.governs.includes("Widget"));

    const resolved = await resolveRecipe("context-notes");
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.recipe.source, "builtin:context-notes");
  } finally {
    await cleanup();
  }
});

test("this repo's own build ships the portable recipes by name", async () => {
  const names = await shippedRecipeNames(SHIPPED_PACKAGE_ROOT);
  assert.deepEqual(names, ["claims", "engineering-review", "review-workflow"]);
  for (const name of names) {
    const result = await shippedRecipeSource(SHIPPED_PACKAGE_ROOT).resolve(name);
    assert.ok(result, `${name} did not resolve`);
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  }
});

test("an unknown name names every resolvable recipe, shipped ones included", async () => {
  const result = await resolveRecipe("definitely-not-a-recipe");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_NOT_FOUND");
  assert.match(result.error.message, /unknown recipe 'definitely-not-a-recipe'/);
  assert.match(result.error.message, /context-notes/);
  assert.match(result.error.message, /engineering-review/);
});
