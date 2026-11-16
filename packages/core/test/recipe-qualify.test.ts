import test from "node:test";
import assert from "node:assert/strict";
import { parseRecipeIndex, resolveCookbook } from "../src/recipe-sources.js";
import { createHash } from "node:crypto";
import { qualifyRecipeSet, qualificationRecipeId, parseRecipeQualificationConfig, type RecipeQualificationInput } from "../src/recipes.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { resolveConceptId, extractMarkdownLinks } from "../src/links.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { writeDoc, readDoc } from "../src/bundle-ops.js";
import { installRecipe, planRecipeEvolution, applyRecipeEvolution, readRecipeStamp } from "../src/recipe-lifecycle/index.js";
function input(key: string, kind: string, extra: Record<string, unknown> = {}, body = ""): RecipeQualificationInput {
  return { entry: { key, source: `./${key}`, namespace: `github.com/123/${key}` }, source: `root/${key}`, files: [
    { path: "recipe.md", bytes: stringifyDoc({ type: "Recipe", id: key, title: key, version: "1", summary: "Synthetic fixture" }, "") },
    { path: "conventions/nested/kind.md", bytes: stringifyDoc({ type: "Convention", governs: kind, title: kind, path: "records/", ...extra }, body) },
  ] };
}
const task = { governs: "Task", id: "conventions/task", version: "sha256:" + "a".repeat(64) };
function pair() {
  const a = input("decision", "Decision", { links: { answers: "Question", implements: "Task" } });
  const b = input("research", "Question", { expects_inbound: { answers: "Decision" } });
  a.entry.bindings = { Question: { recipe: "research", kind: "Question" }, Task: { existing: "Task" } };
  b.entry.bindings = { Decision: { recipe: "decision", kind: "Decision" } };
  return [a,b];
}
test("set allocation binds cycles, explicit existing kinds and separate friendly placement without mutation", () => {
  const sources = pair();
  sources[1]!.entry = { key: "research", source: "./research", preserve: true, bindings: sources[1]!.entry.bindings };
  sources[0]!.entry.paths = { Decision: "decisions/" };
  const before = JSON.stringify(sources); const prepared = qualifyRecipeSet(sources, [task]); const [a,b] = prepared.recipes;
  assert.equal(a!.recipe.docs[0]!.frontmatter.governs, "github.com/123/decision/Decision");
  assert.deepEqual(a!.recipe.docs[0]!.frontmatter.links, { answers: "Question", implements: "Task" });
  assert.deepEqual(b!.recipe.docs[0]!.frontmatter.expects_inbound, { answers: "github.com/123/decision/Decision" });
  assert.equal(a!.recipe.docs[0]!.frontmatter.path, "decisions/"); assert.equal(b!.recipe.docs[0]!.id, "conventions/nested/kind");
  assert.deepEqual(prepared.receipt.prerequisites, [task]); assert.equal(JSON.stringify(sources), before);
});
test("namespace identity hashes exact canonical bytes and rejects noncanonical or unbounded names", () => {
  const namespace = "github.com/synthetic-owner/synthetic-repo/decisions";
  assert.equal(qualificationRecipeId(namespace), "ns-" + createHash("sha256").update(namespace).digest("hex"));
  assert.match(qualificationRecipeId("github.com/123/decision"), /^ns-[a-f0-9]{64}$/);
  for (const bad of ["github.com/01/decision", "github.com/0/decision", "github.com/123/Decision", "github.com/123/a--b", "github.com/A/repo/name", "github.com/" + "1".repeat(221) + "/a"]) assert.throws(() => qualificationRecipeId(bad));
  assert.throws(() => qualifyRecipeSet([input("long", "A".repeat(250))]), /256/);
});
test("missing, unused, conflicting and absent bindings refuse instead of guessing", () => {
  assert.throws(() => qualifyRecipeSet(pair()), /not declared/);
  const a = pair(); delete a[0]!.entry.bindings!.Question; assert.throws(() => qualifyRecipeSet(a, [task]), /missing explicit binding/);
  const b = pair(); b[0]!.entry.bindings!.Unused = { existing: "Task" }; assert.throws(() => qualifyRecipeSet(b, [task]), /unused binding/);
  const c = pair(); c[0]!.entry.bindings!.Question = { recipe: "research", kind: "Absent" }; assert.throws(() => qualifyRecipeSet(c, [task]), /absent recipe\/Kind/);
  const d = pair(); d[0]!.entry.bindings!.Decision = { existing: "Task" }; assert.throws(() => qualifyRecipeSet(d, [task]), /unused binding|own Kind/);
  const e = pair(); const retained = input("retained", "Task"); retained.entry = { key: "retained", source: "./retained", preserve: true }; e.push(retained);
  assert.throws(() => qualifyRecipeSet(e, [task]), /existing binding.*collides/);
  const duplicates = [input("a", "Decision"), input("b", "Decision")];
  for (const item of duplicates) item.entry = { key: item.entry.key, source: item.entry.source, preserve: true };
  duplicates[1]!.files = duplicates[1]!.files.map(f => f.path.startsWith("conventions/") ? { ...f, path: "conventions/other.md" } : f);
  assert.throws(() => qualifyRecipeSet(duplicates), /duplicate output governs/);
});
test("nested references, outside bundle links, cross-source links and fragments preserve meaning; code stays exact", () => {
  const a = input("a", "Decision", {}, "[ref](../../references/guide.md#part) [outside](../../tasks/one.md#done) [base](../../../b/conventions/nested/kind.md#x)\n`[code](../../references/guide.md)`\nDecision prose\n");
  a.files = [...a.files, { path: "references/guide.md", bytes: stringifyDoc({ type: "Reference", title: "Guide" }, "[kind](../conventions/nested/kind.md#intro)\n") }];
  a.files[0] = { path: "recipe.md", bytes: stringifyDoc({ type: "Recipe", id: "a", title: "A", summary: "A", version: "1", content_policy: "definitions-only", references: ["references/guide.md"] }, "") };
  const prepared = qualifyRecipeSet([a,input("b", "Asset")]); const doc = prepared.recipes[0]!.recipe.docs[0]!;
  assert.deepEqual(extractMarkdownLinks(doc.body, { skipCode: true }).map(link => resolveConceptId(doc.id, link.href)), [prepared.recipes[0]!.recipe.references[0]!.doc.id, "tasks/one", prepared.recipes[1]!.recipe.docs[0]!.id]);
  assert.match(doc.body, /#part/); assert.ok(doc.body.includes("`[code](../../references/guide.md)`")); assert.match(doc.body, /Decision prose/);
});
test("strict inventory, unsupported relocation, malformed config and reserved fields refuse", () => {
  for (const extra of [{ path: "readme.txt", bytes: "hidden asset" }, { path: "views/app.html", bytes: "<html>" }, { path: "../escape.md", bytes: "x" }]) { const a = input("a", "A"); a.files = [...a.files, extra]; assert.throws(() => qualifyRecipeSet([a])); }
  for (const body of ['<a href="x.md">x</a>', "[x][ref]\n[ref]: x.md", "[x](image.png)", "[x](../../../missing/doc.md)"]) assert.throws(() => qualifyRecipeSet([input("a", "A", {}, body)]));
  for (const entry of [{ key: "x", source: "./x", preserve: true, namespace: "github.com/1/x" }, { key: "x", source: "./x", preserve: true, paths: { X: "x" } }, { key: "x", source: "./x", preserve: true, bindings: { X: { existing: "alias:Kind" } } }]) assert.throws(() => parseRecipeQualificationConfig({ schema: "recipe-qualification/v1", recipes: [entry] }));
  assert.throws(() => qualifyRecipeSet([input("a", "A", { fields: { optional: ["status"], values: { status: ["todo"] } } })]));
});
test("ordinary installation and additive evolution preserve records and independent ownership", async () => {
  const backend = new MemoryBackend(); await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n"); const bundle = { root: "mem://qualification", backend };
  await writeDoc(bundle, { id: "legacy", frontmatter: { type: "Decision", title: "Old" }, body: "Unchanged" }); const before = await readDoc(bundle, "legacy");
  const a = input("a", "Decision", { fields: { optional: ["reason"] } }); const prepared = qualifyRecipeSet([a,input("b", "Decision")]);
  for (const row of prepared.recipes) await installRecipe(bundle, row.recipe, { actor: "process:test" });
  const own = prepared.recipes[0]!; const other = prepared.recipes[1]!;
  await writeDoc(bundle, { id: "records/new", frontmatter: { type: own.recipe.governs[0]!, title: "New" }, body: "Exact" });
  const instance = await readDoc(bundle, "records/new"); const independent = await readDoc(bundle, other.recipe.docs[0]!.id);
  const updated = input("a", "Decision", { fields: { optional: ["reason", "detail"] } });
  updated.files = updated.files.map(f => f.path === "recipe.md" ? { ...f, bytes: stringifyDoc({ type: "Recipe", id: "a", title: "a", version: "2", summary: "Synthetic fixture" }, "") } : f);
  const evolved = qualifyRecipeSet([updated]).recipes[0]!.recipe;
  assert.equal(evolved.version, "2");
  assert.equal(evolved.id, own.recipe.id); assert.equal(evolved.docs[0]!.id, own.recipe.docs[0]!.id);
  const plan = await planRecipeEvolution(bundle, evolved); assert.equal(plan.ready, true);
  await applyRecipeEvolution(bundle, evolved, plan.plan_token, { actor: "process:test" });
  assert.deepEqual(await readDoc(bundle, "legacy"), before); assert.deepEqual(await readDoc(bundle, "records/new"), instance); assert.deepEqual(await readDoc(bundle, other.recipe.docs[0]!.id), independent);
  assert.equal(readRecipeStamp(await readDoc(bundle, own.recipe.docs[0]!.id))?.id, own.recipe.id);
  const incompatible = qualifyRecipeSet([input("a", "Decision", { fields: { required: ["missing"], optional: ["reason", "detail"] } })]).recipes[0]!.recipe;
  assert.equal((await planRecipeEvolution(bundle, incompatible)).ready, false);
});

test("prepared outputs resolve as an ordinary existing-format indexed cookbook with exact pins", async () => {
  const prepared = qualifyRecipeSet(pair(), [task]);
  const entries = prepared.receipt.recipes.map(row => ({ id: row.id, version: row.version, designation: "community", maintainer: "synthetic", root: row.key,
    source_digest: row.output_digest, files_digest: row.output_files_digest, files: prepared.recipes.find(recipe => recipe.key === row.key)!.files.map(file => file.path) }));
  const parsed = parseRecipeIndex({ format: "recipe-index/v1", source: "synthetic", recipes: entries, cookbooks: [{ id: "paired", title: "Paired", summary: "Synthetic", designation: "community", maintainer: "synthetic", recipes: entries.map(entry => entry.id) }] });
  assert.ok(parsed.ok);
  const files = new Map(prepared.recipes.flatMap(recipe => recipe.files.map(file => [`${recipe.key}/${file.path}`, new TextEncoder().encode(file.bytes)] as const)));
  const loaded = await resolveCookbook(parsed.index, "paired", async path => { const bytes = files.get(path); assert.ok(bytes); return bytes; });
  assert.ok(loaded.ok); assert.deepEqual(loaded.recipes.map(row => row.recipe.id), entries.map(row => row.id));
});
