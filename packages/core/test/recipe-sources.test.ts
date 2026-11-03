/** `@superbee/core/recipe-sources`: the shared source contract, the index parser and the digest verifier. */
import test from "node:test";
import assert from "node:assert/strict";
import { builtinRecipeFiles, builtinRecipeSource, loadBuiltinRecipe } from "../src/builtin-recipes.js";
import { recipeSourceDigest } from "../src/recipe-lifecycle/stamp.js";
import {
  RECIPE_INDEX_FORMAT,
  createIndexRecipeSource,
  parseRecipeIndex,
  resolveIndexRecipe,
  resolveOffering,
  resolveRecipe,
  type RecipeIndex,
  type RecipeIndexReader,
  type RecipeSource,
} from "../src/recipe-sources.js";

function builtinDigest(name: string): string {
  const loaded = loadBuiltinRecipe(name);
  assert.ok(loaded?.ok);
  return recipeSourceDigest(loaded.recipe);
}

/** A served tree: index-relative path to bytes, plus a log of every path the reader was asked for. */
function servedTree(layout: (name: string) => string, names: readonly string[]) {
  const files = new Map<string, string>();
  const entries = names.map((name) => {
    const recipeFiles = builtinRecipeFiles(name)!;
    for (const file of recipeFiles) files.set(`${layout(name)}/${file.path}`, file.bytes);
    return { id: name, version: "1", source_digest: builtinDigest(name), root: layout(name), files: recipeFiles.map((file) => file.path) };
  });
  const reads: string[] = [];
  const read: RecipeIndexReader = async (path) => {
    reads.push(path);
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error("no such file");
    return bytes;
  };
  return { files, entries, reads, read };
}

function indexOf(source: string, entries: unknown[], offerings: unknown[] = []): RecipeIndex {
  const parsed = parseRecipeIndex({ format: RECIPE_INDEX_FORMAT, source, recipes: entries, offerings });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return parsed.index;
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const ENTRY = { id: "notes", version: "1", source_digest: DIGEST, files: ["recipe.md"] };
const VALID = { format: RECIPE_INDEX_FORMAT, source: "example", title: "Example", recipes: [ENTRY], offerings: [] };

function refusalCode(value: unknown): string {
  const parsed = parseRecipeIndex(value);
  assert.equal(parsed.ok, false, "expected a refusal");
  return parsed.ok ? "" : parsed.error.code;
}

// ── Parser ────────────────────────────────────────────────────────────────────────────────────

test("parseRecipeIndex accepts a valid index as text or value and freezes the result", () => {
  for (const input of [VALID, JSON.stringify(VALID)]) {
    const parsed = parseRecipeIndex(input);
    assert.ok(parsed.ok);
    assert.equal(parsed.index.source, "example");
    assert.equal(parsed.index.title, "Example");
    assert.deepEqual(parsed.index.recipes[0], ENTRY);
    assert.ok(Object.isFrozen(parsed.index.recipes[0]!.files));
  }
});

test("parseRecipeIndex: RECIPE_INDEX_MALFORMED for every shape refusal", () => {
  const cases: unknown[] = [
    "{not json",
    "[]",
    null,
    { ...VALID, extra: true },
    { format: RECIPE_INDEX_FORMAT, source: "example", recipes: [] },
    { ...VALID, source: "has space" },
    { ...VALID, title: "" },
    { ...VALID, recipes: {} },
    { ...VALID, recipes: [{ ...ENTRY, extra: 1 }] },
    { ...VALID, recipes: [{ ...ENTRY, source_digest: "sha256:XYZ" }] },
    { ...VALID, recipes: [{ ...ENTRY, version: "" }] },
    { ...VALID, recipes: [{ ...ENTRY, files: [] }] },
    { ...VALID, recipes: [{ ...ENTRY, id: "../x" }] },
    { ...VALID, recipes: new Array(1) },
    { ...VALID, recipes: Array.from({ length: 257 }, (_, i) => ({ ...ENTRY, id: `r${i}` })) },
    { ...VALID, offerings: [{ id: "o", title: "O", summary: "S", recipes: ["notes"], extra: 1 }] },
    { ...VALID, offerings: [{ id: "o", title: "", summary: "S", recipes: ["notes"] }] },
  ];
  for (const value of cases) assert.equal(refusalCode(value), "RECIPE_INDEX_MALFORMED", JSON.stringify(value)?.slice(0, 120));
});

test("parseRecipeIndex: RECIPE_INDEX_FORMAT_UNSUPPORTED for a missing or different format", () => {
  assert.equal(refusalCode({ ...VALID, format: "recipe-index/v2" }), "RECIPE_INDEX_FORMAT_UNSUPPORTED");
  const { format: _format, ...unformatted } = VALID;
  assert.equal(refusalCode(unformatted), "RECIPE_INDEX_FORMAT_UNSUPPORTED");
});

test("parseRecipeIndex: RECIPE_INDEX_PATH_INVALID for absolute, escaping, backslash and dot paths", () => {
  const files = ["/etc/passwd", "C:/x.md", "../outside.md", "conventions/../../x.md", "conventions\\x.md", ".hidden.md", "conventions/./x.md", "a//b.md", "x?.md"];
  for (const file of files) {
    assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: [file] }] }), "RECIPE_INDEX_PATH_INVALID", file);
  }
  for (const root of ["../recipes", "/abs", "a\\b", ""]) {
    assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, root }] }), "RECIPE_INDEX_PATH_INVALID", root);
  }
});

test("parseRecipeIndex: RECIPE_INDEX_DUPLICATE for repeated recipes, offerings and files", () => {
  assert.equal(refusalCode({ ...VALID, recipes: [ENTRY, ENTRY] }), "RECIPE_INDEX_DUPLICATE");
  assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: ["recipe.md", "recipe.md"] }] }), "RECIPE_INDEX_DUPLICATE");
  assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: ["recipe.md", "Recipe.md"] }] }), "RECIPE_INDEX_DUPLICATE");
  const offering = { id: "o", title: "O", summary: "S", recipes: ["notes"] };
  assert.equal(refusalCode({ ...VALID, offerings: [offering, offering] }), "RECIPE_INDEX_DUPLICATE");
});

test("parseRecipeIndex: RECIPE_INDEX_OFFERING_INVALID for unknown, repeated or missing members", () => {
  const offering = { id: "o", title: "O", summary: "S" };
  assert.equal(refusalCode({ ...VALID, offerings: [{ ...offering, recipes: ["missing"] }] }), "RECIPE_INDEX_OFFERING_INVALID");
  assert.equal(refusalCode({ ...VALID, offerings: [{ ...offering, recipes: ["notes", "notes"] }] }), "RECIPE_INDEX_OFFERING_INVALID");
  assert.equal(refusalCode({ ...VALID, offerings: [{ ...offering, recipes: [] }] }), "RECIPE_INDEX_OFFERING_INVALID");
});

// ── Verifier ──────────────────────────────────────────────────────────────────────────────────

test("resolveIndexRecipe returns a recipe only when Core's source digest matches the pin", async () => {
  const tree = servedTree((name) => `recipes/${name}`, ["context-notes"]);
  const index = indexOf("alpha", tree.entries);
  const result = await resolveIndexRecipe(index, "context-notes", tree.read);
  assert.ok(result.ok);
  assert.equal(result.verified.source_digest, builtinDigest("context-notes"));
  assert.equal(result.verified.recipe.source, "index:alpha");
  assert.deepEqual(tree.reads, tree.entries[0]!.files.map((file) => `recipes/context-notes/${file}`));
});

test("swap: two index sources with different ids and layouts serve the same recipe with the same digest", async () => {
  const a = servedTree((name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
  const b = servedTree((name) => `published/v1/${name}-pkg`, ["context-notes", "work-tracking"]);
  const indexA = indexOf("alpha", a.entries);
  const indexB = indexOf("beta", b.entries.map(({ root: _root, ...entry }) => ({ ...entry, root: `published/v1/${entry.id}-pkg` })));
  for (const id of ["context-notes", "work-tracking"]) {
    const fromA = await resolveIndexRecipe(indexA, id, a.read);
    const fromB = await resolveIndexRecipe(indexB, id, b.read);
    assert.ok(fromA.ok && fromB.ok);
    assert.equal(fromA.verified.source_digest, fromB.verified.source_digest);
    assert.deepEqual(fromA.verified.recipe.docs, fromB.verified.recipe.docs);
    const builtin = loadBuiltinRecipe(id);
    assert.ok(builtin?.ok);
    assert.equal(fromA.verified.source_digest, recipeSourceDigest(builtin.recipe));
  }
});

test("red probe: a changed byte in any listed file that carries installed content is refused", async () => {
  for (const name of ["context-notes", "roadmap", "site"]) {
    for (const file of builtinRecipeFiles(name)!.filter((entry) => entry.path !== "recipe.md")) {
      const tree = servedTree((n) => n, [name]);
      const key = `${name}/${file.path}`;
      tree.files.set(key, tree.files.get(key)!.replace(/\.(\s|$)/, ",$1"));
      assert.notEqual(tree.files.get(key), file.bytes, `${key} was tampered`);
      const result = await resolveIndexRecipe(indexOf("alpha", tree.entries), name, tree.read);
      assert.equal(result.ok ? "" : result.error.code, "RECIPE_INDEX_DIGEST_MISMATCH", key);
      const source = await createIndexRecipeSource(indexOf("alpha", tree.entries), tree.read).resolve(name);
      assert.equal(source?.ok, false, key);
    }
  }
});

test("source_digest scope: manifest identity is pinned, manifest prose is not", async () => {
  // recipeSourceDigest covers id, version and every installable definition, not the manifest's
  // title, summary, offer or body. A change there leaves installed content identical.
  const tree = servedTree((n) => n, ["context-notes"]);
  const manifest = tree.files.get("context-notes/recipe.md")!;
  tree.files.set("context-notes/recipe.md", manifest.replace("title: Context Notes", "title: Something Else"));
  const prose = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", tree.read);
  assert.ok(prose.ok);
  assert.equal(prose.verified.recipe.title, "Something Else");
  const builtin = loadBuiltinRecipe("context-notes");
  assert.ok(builtin?.ok);
  assert.deepEqual(prose.verified.recipe.docs, builtin.recipe.docs);

  tree.files.set("context-notes/recipe.md", manifest.replace("version: '1'", "version: '9'").replace('version: "1"', 'version: "9"'));
  assert.notEqual(tree.files.get("context-notes/recipe.md"), manifest);
  const version = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", tree.read);
  assert.equal(version.ok ? "" : version.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");
});

test("red probe: a file present beside the recipe but not listed is never read", async () => {
  const tree = servedTree((name) => `r/${name}`, ["context-notes"]);
  tree.files.set("r/context-notes/conventions/injected.md", "---\ntype: Convention\ngoverns: Injected\n---\n# Injected\n");
  const result = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", tree.read);
  assert.ok(result.ok);
  assert.ok(!tree.reads.some((path) => path.includes("injected")));
  assert.ok(!result.verified.recipe.docs.some((doc) => doc.id.includes("injected")));
  assert.ok(!result.verified.recipe.governs.includes("Injected"));
});

test("red probe: a listed file that is omitted from the pin's recipe changes the digest", async () => {
  const tree = servedTree((name) => `r/${name}`, ["roadmap"]);
  const entry = { ...tree.entries[0]!, files: tree.entries[0]!.files.filter((file) => file !== "conventions/roadmap-item.md") };
  const result = await resolveIndexRecipe(indexOf("alpha", [entry]), "roadmap", tree.read);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");
});

test("red probe: a path escape in files never reaches the reader", async () => {
  const tree = servedTree((name) => `r/${name}`, ["context-notes"]);
  const parsed = parseRecipeIndex({ format: RECIPE_INDEX_FORMAT, source: "alpha", recipes: [{ ...tree.entries[0], files: ["recipe.md", "../../secret.md"] }], offerings: [] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error.code, "RECIPE_INDEX_PATH_INVALID");
  assert.deepEqual(tree.reads, []);
});

test("resolveIndexRecipe: id or version disagreement, unparseable bytes and reader failures refuse", async () => {
  const tree = servedTree((name) => name, ["context-notes"]);
  const wrongVersion = await resolveIndexRecipe(indexOf("alpha", [{ ...tree.entries[0], version: "2" }]), "context-notes", tree.read);
  assert.equal(wrongVersion.ok ? "" : wrongVersion.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");

  tree.files.set("context-notes/recipe.md", "---\n: [unclosed\n---\n");
  const unparseable = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", tree.read);
  assert.equal(unparseable.ok ? "" : unparseable.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");

  const failing = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", async () => { throw new Error("offline"); });
  assert.equal(failing.ok ? "" : failing.error.code, "RECIPE_INDEX_READ_FAILED");
  assert.match(failing.ok ? "" : failing.error.message, /offline/);

  const missing = await resolveIndexRecipe(indexOf("alpha", tree.entries), "nope", tree.read);
  assert.equal(missing.ok ? "" : missing.error.code, "RECIPE_NOT_FOUND");
});

test("resolveOffering verifies every member in order and returns nothing when one fails", async () => {
  const tree = servedTree((name) => `r/${name}`, ["context-notes", "work-tracking", "roadmap"]);
  const offerings = [{ id: "plan", title: "Plan", summary: "Plan the work.", recipes: ["roadmap", "work-tracking"] }];
  const ok = await resolveOffering(indexOf("alpha", tree.entries, offerings), "plan", tree.read);
  assert.ok(ok.ok);
  assert.deepEqual(ok.recipes.map((entry) => entry.recipe.id), ["roadmap", "work-tracking"]);

  tree.files.set("r/work-tracking/conventions/task.md", `${tree.files.get("r/work-tracking/conventions/task.md")}\nTampered.\n`);
  const bad = await resolveOffering(indexOf("alpha", tree.entries, offerings), "plan", tree.read);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");
  assert.equal(bad.recipe, "work-tracking");
  assert.equal("recipes" in bad, false);

  const unknown = await resolveOffering(indexOf("alpha", tree.entries, offerings), "nope", tree.read);
  assert.equal(unknown.ok ? "" : unknown.error.code, "RECIPE_NOT_FOUND");
});

// ── Source contract ───────────────────────────────────────────────────────────────────────────

test("resolveRecipe asks sources in order, the first non-null answer wins, and misses are RECIPE_NOT_FOUND", async () => {
  const asked: string[] = [];
  const silent = (kind: RecipeSource["kind"]): RecipeSource => ({ kind, async resolve() { asked.push(kind); return null; } });
  const tree = servedTree((name) => name, ["context-notes"]);
  const index = createIndexRecipeSource(indexOf("alpha", tree.entries), tree.read);
  assert.equal(index.kind, "index");
  assert.equal(await index.resolve("work-tracking"), null);

  const hit = await resolveRecipe("context-notes", [silent("files"), index, builtinRecipeSource()]);
  assert.ok(hit.ok);
  assert.equal(hit.recipe.source, "index:alpha");
  assert.deepEqual(asked, ["files"]);

  const builtin = await resolveRecipe("roadmap", [index, builtinRecipeSource()]);
  assert.ok(builtin.ok);
  assert.equal(builtin.recipe.source, "builtin:roadmap");

  const miss = await resolveRecipe("nope", [index], { notFoundMessage: (ref) => `custom ${ref}` });
  assert.deepEqual(miss, { ok: false, error: { code: "RECIPE_NOT_FOUND", message: "custom nope" } });
  const plain = await resolveRecipe("nope", []);
  assert.equal(plain.ok ? "" : plain.error.message, "unknown recipe 'nope'");
});

test("builtinRecipeSource addresses built-in names only", async () => {
  const source = builtinRecipeSource();
  assert.equal(source.kind, "builtin");
  assert.equal(await source.resolve("./context-notes"), null);
  assert.equal(await source.resolve("constructor"), null);
  const result = await source.resolve("context-notes");
  assert.ok(result?.ok);
});
