import test from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/bundle-ops.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipes.js";
import type { Bundle } from "../src/types.js";
import { applyRecipeEvolution, installedRecipes, installRecipe, planRecipeEvolution } from "../src/recipe-lifecycle/index.js";
import { CONNECTOR_MD, EVENT_CONVENTION_MD } from "./fixtures/connectors/example-calendar.js";

type Artifact = "Convention" | "Connector" | "Reference";
const prefix = { Convention: "conventions/", Connector: "connectors/", Reference: "references/" };
function recipe(type: Artifact, operation: "base" | "drop" | "rename"): LoadedRecipe {
  const name = operation === "rename" ? "replacement" : "old";
  const include = operation !== "drop";
  const files = [
    { path: "recipe.md", bytes: `---\ntype: Recipe\nid: orphan-fixture\ntitle: Orphan fixture\nversion: "${operation === "base" ? "1" : "2"}"\nsummary: Synthetic orphan reporting\ncontent_policy: definitions-only\n${include && type !== "Convention" ? `${type === "Connector" ? "connectors" : "references"}: [${prefix[type]}${name}.md]\n` : ""}---\n` },
    { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
  ];
  if (include) files.push({ path: `${prefix[type]}${name}.md`, bytes: type === "Convention"
    ? `---\ntype: Convention\ntitle: ${name}\ngoverns: ${name}\nfields:\n  required: [title]\n---\n# ${name}\n`
    : type === "Connector" ? CONNECTOR_MD : "---\ntype: Reference\ntitle: Guide\n---\n# Guide\n" });
  const parsed = parseRecipeFiles(files, "test:orphans", { okfVersion: "0.2" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return parsed.recipe;
}
async function bundle(edition: string): Promise<Bundle> {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  return { root: "mem://orphan-reporting", backend };
}
for (const edition of ["0.1", "0.2"]) for (const type of ["Convention", "Connector", "Reference"] as const) {
  for (const operation of ["drop", "rename"] as const) test(`${edition}: ${operation} ${type} reports retained ownership without writes`, async () => {
    const target = await bundle(edition);
    await installRecipe(target, recipe(type, "base"));
    const orphan = `${prefix[type]}old`;
    // A retained rename source remains reportable even when its content changed and its digest
    // rules cannot prove an unchanged baseline. Reporting must never re-baseline it.
    if (operation === "rename") {
      const { doc } = await target.backend.read(orphan);
      await target.backend.write(orphan, { ...doc, body: "A person's local edit.", frontmatter: {
        ...doc.frontmatter, x_recipe: { ...doc.frontmatter.x_recipe as Record<string, unknown>, digest_rules: 999 },
      } });
    }
    const original = await target.backend.read(orphan);
    const next = recipe(type, operation);
    const initial = await planRecipeEvolution(target, next);
    assert.deepEqual(initial.orphaned_definitions, [{ id: orphan, type }]);
    assert.equal(initial.definitions.some(row => row.id === orphan), false);
    assert.equal(initial.reference_assets?.rows.some(row => row.id === orphan) ?? false, false);
    assert.deepEqual(await target.backend.read(orphan), original);
    if (operation === "rename") {
      assert.equal(initial.ready, false);
      await installRecipe(target, next);
    }
    const plan = await planRecipeEvolution(target, next);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    const applied = await applyRecipeEvolution(target, next, plan.plan_token);
    assert.deepEqual(applied.orphaned_definitions, [{ id: orphan, type }]);
    const settled = await planRecipeEvolution(target, next);
    assert.equal(settled.writes, 0);
    assert.equal(settled.changed, false);
    assert.deepEqual(settled.orphaned_definitions, [{ id: orphan, type }]);
    assert.deepEqual(await target.backend.read(orphan), original);
    const docs = await query(target, {});
    const known = installedRecipes(docs, [next]).rows[0]!;
    if (type !== "Reference") {
      assert.deepEqual(known.orphaned_ids, [orphan]);
      assert.equal(known.state, "partial");
    } else {
      assert.equal(known.orphaned_ids, undefined);
      assert.equal(known.state, "installed");
    }
    assert.equal(installedRecipes(docs).rows[0]!.orphaned_ids, undefined);
  });
}

for (const edition of ["0.1", "0.2"]) test(`${edition}: reporting reads ownership only, preserves local changes, and adds no token authority`, async () => {
  const target = await bundle(edition);
  const originalRecipe = recipe("Reference", "base");
  await installRecipe(target, originalRecipe);
  const next = recipe("Reference", "drop");
  const first = await planRecipeEvolution(target, next);
  const original = await target.backend.read("references/old");
  const doc = { ...original.doc, body: "A person's changed content.", frontmatter: { ...original.doc.frontmatter } };
  doc.frontmatter.x_recipe = { ...doc.frontmatter.x_recipe as Record<string, unknown>, digest_rules: 999 };
  await target.backend.write(doc.id, doc);
  const retained = await target.backend.read(doc.id);
  for (const [id, type, stamp] of [
    ["references/a", "Reference", { ...doc.frontmatter.x_recipe as Record<string, unknown>, id: "foreign" }],
    ["references/b", "Reference", { id: next.id }],
    ["references/c", "Reference", undefined],
    ["notes/stamped", "Note", doc.frontmatter.x_recipe],
    ["notes/reference", "Reference", doc.frontmatter.x_recipe],
    ["references/z", "Reference", doc.frontmatter.x_recipe],
    ["references/A", "Reference", doc.frontmatter.x_recipe],
  ] as const) {
    await target.backend.write(id, { id, frontmatter: { type, title: id, ...(stamp ? { x_recipe: stamp } : {}) }, body: "Retained." });
  }
  const before = await query(target, {});
  const observed = await planRecipeEvolution(target, next);
  const expected = ["references/A", "references/old", "references/z"].map(id => ({ id, type: "Reference" }));
  assert.deepEqual(observed.orphaned_definitions, expected);
  assert.equal(observed.plan_token, first.plan_token, "informational orphan changes do not change apply authority");
  assert.equal(observed.writes, first.writes);
  assert.deepEqual(await query(target, {}), before, "planning is read-only");
  // The caller's result object is not accepted as apply authority or trusted for reporting.
  observed.orphaned_definitions!.push({ id: "notes/injected", type: "Reference" });
  const applied = await applyRecipeEvolution(target, next, first.plan_token);
  assert.deepEqual(applied.orphaned_definitions, expected);
  assert.deepEqual(await target.backend.read(doc.id), retained);
  const settled = await planRecipeEvolution(target, next);
  assert.equal(settled.writes, 0);
  assert.deepEqual(settled.orphaned_definitions, expected);
});

test("an unchanged recipe omits empty diagnostics on plan, apply and installed status", async () => {
  const target = await bundle("0.2");
  const source = recipe("Reference", "base");
  await installRecipe(target, source);
  const plan = await planRecipeEvolution(target, source);
  assert.equal(Object.hasOwn(plan, "orphaned_definitions"), false);
  const applied = await applyRecipeEvolution(target, source, plan.plan_token);
  assert.equal(Object.hasOwn(applied, "orphaned_definitions"), false);
  assert.equal(Object.hasOwn(installedRecipes(await query(target, {}), [source]).rows[0]!, "orphaned_ids"), false);
});
