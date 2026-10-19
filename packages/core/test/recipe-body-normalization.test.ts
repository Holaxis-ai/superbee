import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBundle } from "../src/bundle.js";
import { readDoc } from "../src/bundle-ops.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { parseRecipeFiles, type LoadedRecipe, type RecipeFile } from "../src/recipes.js";
import {
  applyRecipeEvolution, definitionDigest, installRecipe, installedConventionDocs,
  installedRecipes, installedConnectorDocs, planRecipeEvolution, RecipeEvolutionPlanChanged,
} from "../src/recipe-lifecycle/index.js";

const examples = fileURLToPath(new URL("../../../examples/recipes/", import.meta.url));
async function recipeFiles(dir: string, prefix = ""): Promise<RecipeFile[]> {
  const rows: RecipeFile[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) rows.push(...await recipeFiles(dir, relative));
    else rows.push({ path: relative, bytes: await readFile(path.join(dir, relative), "utf8") });
  }
  return rows;
}
function recipe(body: string, version = "1"): LoadedRecipe {
  return {
    id: "body-lines", title: "Body lines", version, summary: "Body semantics.",
    source: "test:body-lines", offer: "Body lines", governs: ["Widget"], warnings: [], pages: [], references: [],
    docs: [{ id: "conventions/widget", frontmatter: {
      type: "Convention", title: "Widget", governs: "Widget", fields: { required: ["title"] },
    }, body }],
  };
}
async function withBundle(edition: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "recipe-body-lines-"));
  try {
    await initBundle(root, { okfVersion: edition });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("recipe body normalization: shipped examples settle after CRLF checkout in both editions without rewriting bytes", async () => {
  for (const edition of ["0.1", "0.2"]) for (const name of await readdir(examples)) {
    const loaded = parseRecipeFiles(await recipeFiles(path.join(examples, name)), `example:${name}`, { okfVersion: edition });
    assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
    await withBundle(edition, async root => {
      const bundle = { root };
      await installRecipe(bundle, loaded.recipe);
      const before = new Map<string, string>();
      for (const doc of loaded.recipe.docs) {
        const file = path.join(root, doc.id + ".md");
        const crlf = (await readFile(file, "utf8")).replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
        await writeFile(file, crlf); before.set(file, crlf);
      }
      assert.equal(installedRecipes([...(await installedConventionDocs(bundle)).values(), ...(await installedConnectorDocs(bundle)).values()], [loaded.recipe]).rows[0]!.state, "installed");
      const plan = await planRecipeEvolution(bundle, loaded.recipe);
      assert.equal(plan.ready, true, `${edition}/${name}: ${JSON.stringify(plan.blockers)}`);
      assert.equal(plan.writes, 0);
      await installRecipe(bundle, loaded.recipe);
      await applyRecipeEvolution(bundle, loaded.recipe, plan.plan_token);
      for (const [file, bytes] of before) assert.equal(await readFile(file, "utf8"), bytes);
    });
  }
});

test("recipe body normalization: missing final newline and empty bodies share the stamp digest and install/evolve equality", async () => {
  for (const edition of ["0.1", "0.2"]) for (const body of ["First\nSecond", "First\r\nSecond\r\n", ""]) {
    await withBundle(edition, async root => {
      const bundle = { root }, source = recipe(body);
      await installRecipe(bundle, source);
      const written = await readDoc(bundle, "conventions/widget");
      assert.equal(definitionDigest(written), definitionDigest(source.docs[0]!));
      const file = path.join(root, "conventions/widget.md"), bytes = await readFile(file);
      const plan = await planRecipeEvolution(bundle, source);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers)); assert.equal(plan.writes, 0);
      await installRecipe(bundle, source);
      await applyRecipeEvolution(bundle, source, plan.plan_token);
      assert.deepEqual(await readFile(file), bytes);
    });
  }
});

test("recipe body normalization: legacy CRLF stamp backfill preserves body and genuine edits still block", async () => {
  for (const edition of ["0.1", "0.2"]) await withBundle(edition, async root => {
    const bundle = { root }, source = recipe("Original\n");
    await installRecipe(bundle, source);
    const file = path.join(root, "conventions/widget.md"), doc = await readDoc(bundle, "conventions/widget");
    delete doc.frontmatter.x_recipe;
    await writeFile(file, stringifyDoc(doc.frontmatter, doc.body).replaceAll("\n", "\r\n"));
    const beforeBody = (await readDoc(bundle, doc.id)).body;
    const plan = await planRecipeEvolution(bundle, source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers)); assert.equal(plan.writes, 1);
    await applyRecipeEvolution(bundle, source, plan.plan_token);
    assert.equal((await readDoc(bundle, doc.id)).body, beforeBody);
    assert.equal((await planRecipeEvolution(bundle, source)).writes, 0);
    for (const body of ["Original \n", "Original\n\n", "Changed\n"]) {
      const edited = recipe(body, "2"), blocked = await planRecipeEvolution(bundle, edited);
      assert.equal(blocked.ready, false);
      assert.ok(blocked.blockers.some(b => b.code === "RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED"));
    }
  });
});

test("recipe body normalization: normalized empty bodies permit real additions, while byte-only changes fence observed plans", async () => {
  for (const edition of ["0.1", "0.2"]) await withBundle(edition, async root => {
    const bundle = { root }, empty = recipe(""); await installRecipe(bundle, empty);
    const desired = recipe("New guidance\n", "2"), plan = await planRecipeEvolution(bundle, desired);
    assert.equal(plan.ready, true); assert.ok(plan.definitions[0]!.added_paths.includes("/body"));
    const file = path.join(root, "conventions/widget.md");
    const changed = (await readFile(file, "utf8")).replaceAll("\n", "\r\n"); await writeFile(file, changed);
    await assert.rejects(applyRecipeEvolution(bundle, desired, plan.plan_token), RecipeEvolutionPlanChanged);
    assert.equal(await readFile(file, "utf8"), changed);
    const fresh = await planRecipeEvolution(bundle, desired); assert.equal(fresh.ready, true);
    await applyRecipeEvolution(bundle, desired, fresh.plan_token);
    assert.equal((await readDoc(bundle, "conventions/widget")).body, "New guidance\n");
    assert.equal((await planRecipeEvolution(bundle, desired)).writes, 0);
  });
});
