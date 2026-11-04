/** `@superbee/core/recipe-sources`: the shared source contract, the index parser and the digest verifier. */
import test from "node:test";
import assert from "node:assert/strict";
import { builtinRecipeFiles, builtinRecipeSource, loadBuiltinRecipe } from "../src/builtin-recipes.js";
import { recipeSourceDigest } from "../src/recipe-lifecycle/stamp.js";
import { parseRecipeFiles, type LoadedRecipe, type RecipeFile } from "../src/recipes.js";
import { assertRecipeStorable, installRecipe, prepareRecipeInstall } from "../src/recipe-lifecycle/install.js";
import { FRONTMATTER_LIMITS } from "../src/bounded-yaml.js";
import { FrontmatterRefusedError } from "../src/errors.js";
import { stringifyFrontmatter } from "../src/frontmatter.js";
import { MemoryBackend } from "../src/memory-backend.js";
import {
  RECIPE_INDEX_FORMAT,
  createIndexRecipeSource,
  parseRecipeIndex,
  recipeFilesDigest,
  resolveIndexRecipe,
  resolveCookbook,
  resolveRecipe,
  type RecipeIndex,
  type RecipeIndexReader,
  type RecipeSource,
} from "../src/recipe-sources.js";

const HOLAXIS = { designation: "supported", maintainer: "Holaxis-ai" } as const;
const COMMUNITY = { designation: "community", maintainer: "octo-cook" } as const;

function builtinDigest(name: string): string {
  const loaded = loadBuiltinRecipe(name);
  assert.ok(loaded?.ok);
  return recipeSourceDigest(loaded.recipe);
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** files_digest of text files, encoded as UTF-8 the way a publisher writes them. */
function pin(files: ReadonlyArray<{ path: string; bytes: string | Uint8Array }>): string {
  return recipeFilesDigest(files.map((file) => ({ path: file.path, bytes: typeof file.bytes === "string" ? utf8(file.bytes) : file.bytes })));
}

/** A served tree: index-relative path to bytes, plus a log of every path the reader was asked for. */
function servedTree(layout: (name: string) => string, names: readonly string[]) {
  const files = new Map<string, string | Uint8Array>();
  const entries = names.map((name) => {
    const recipeFiles = builtinRecipeFiles(name)!;
    for (const file of recipeFiles) files.set(`${layout(name)}/${file.path}`, file.bytes);
    return { id: name, version: "1", ...HOLAXIS, source_digest: builtinDigest(name), files_digest: pin(recipeFiles), root: layout(name), files: recipeFiles.map((file) => file.path) };
  });
  const reads: string[] = [];
  const read: RecipeIndexReader = async (path) => {
    reads.push(path);
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error("no such file");
    return typeof bytes === "string" ? utf8(bytes) : bytes;
  };
  return { files, entries, reads, read };
}

function indexOf(source: string, entries: unknown[], cookbooks: unknown[] = []): RecipeIndex {
  const parsed = parseRecipeIndex({ format: RECIPE_INDEX_FORMAT, source, recipes: entries, cookbooks });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return parsed.index;
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const ENTRY = { id: "notes", version: "1", ...HOLAXIS, source_digest: DIGEST, files_digest: DIGEST, files: ["recipe.md"] };
const VALID = { format: RECIPE_INDEX_FORMAT, source: "example", title: "Example", recipes: [ENTRY], cookbooks: [] };

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
    { ...VALID, recipes: [{ ...ENTRY, files_digest: "sha256:XYZ" }] },
    (() => { const { files_digest: _pin, ...unpinned } = ENTRY; return { ...VALID, recipes: [unpinned] }; })(),
    { ...VALID, recipes: [{ ...ENTRY, version: "" }] },
    { ...VALID, recipes: [{ ...ENTRY, files: [] }] },
    { ...VALID, recipes: [{ ...ENTRY, id: "../x" }] },
    { ...VALID, recipes: new Array(1) },
    { ...VALID, recipes: Array.from({ length: 257 }, (_, i) => ({ ...ENTRY, id: `r${i}` })) },
    { ...VALID, cookbooks: [{ id: "o", title: "O", summary: "S", ...HOLAXIS, recipes: ["notes"], extra: 1 }] },
    { ...VALID, cookbooks: [{ id: "o", title: "", summary: "S", ...HOLAXIS, recipes: ["notes"] }] },
  ];
  for (const value of cases) assert.equal(refusalCode(value), "RECIPE_INDEX_MALFORMED", JSON.stringify(value)?.slice(0, 120));
});

test("parseRecipeIndex: RECIPE_INDEX_FORMAT_UNSUPPORTED for a missing or different format", () => {
  assert.equal(refusalCode({ ...VALID, format: "recipe-index/v2" }), "RECIPE_INDEX_FORMAT_UNSUPPORTED");
  const { format: _format, ...unformatted } = VALID;
  assert.equal(refusalCode(unformatted), "RECIPE_INDEX_FORMAT_UNSUPPORTED");
});

test("parseRecipeIndex: RECIPE_INDEX_PATH_INVALID for absolute, escaping, backslash and dot paths", () => {
  const files = ["conventions./x.md", "x.md.", "/etc/passwd", "C:/x.md", "../outside.md", "conventions/../../x.md", "conventions\\x.md", ".hidden.md", "conventions/./x.md", "a//b.md", "x?.md"];
  for (const file of files) {
    assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: [file] }] }), "RECIPE_INDEX_PATH_INVALID", file);
  }
  for (const root of ["../recipes", "/abs", "a\\b", ""]) {
    assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, root }] }), "RECIPE_INDEX_PATH_INVALID", root);
  }
});

test("parseRecipeIndex: RECIPE_INDEX_DUPLICATE for repeated recipes, cookbooks and files", () => {
  assert.equal(refusalCode({ ...VALID, recipes: [ENTRY, ENTRY] }), "RECIPE_INDEX_DUPLICATE");
  assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: ["recipe.md", "recipe.md"] }] }), "RECIPE_INDEX_DUPLICATE");
  assert.equal(refusalCode({ ...VALID, recipes: [{ ...ENTRY, files: ["recipe.md", "Recipe.md"] }] }), "RECIPE_INDEX_DUPLICATE");
  const cookbook = { id: "o", title: "O", summary: "S", ...HOLAXIS, recipes: ["notes"] };
  assert.equal(refusalCode({ ...VALID, cookbooks: [cookbook, cookbook] }), "RECIPE_INDEX_DUPLICATE");
});

test("parseRecipeIndex: RECIPE_INDEX_COOKBOOK_INVALID for unknown, repeated or missing members", () => {
  const cookbook = { id: "o", title: "O", summary: "S", ...HOLAXIS };
  assert.equal(refusalCode({ ...VALID, cookbooks: [{ ...cookbook, recipes: ["missing"] }] }), "RECIPE_INDEX_COOKBOOK_INVALID");
  assert.equal(refusalCode({ ...VALID, cookbooks: [{ ...cookbook, recipes: ["notes", "notes"] }] }), "RECIPE_INDEX_COOKBOOK_INVALID");
  assert.equal(refusalCode({ ...VALID, cookbooks: [{ ...cookbook, recipes: [] }] }), "RECIPE_INDEX_COOKBOOK_INVALID");
});

test("designation: required on recipes and cookbooks, closed vocabulary, supported cookbooks hold supported recipes", () => {
  const { designation: _d, ...undesignated } = ENTRY;
  const { maintainer: _m, ...unmaintained } = ENTRY;
  for (const recipe of [undesignated, unmaintained, { ...ENTRY, designation: "official" }, { ...ENTRY, designation: "Supported" }, { ...ENTRY, maintainer: "" }]) {
    assert.equal(refusalCode({ ...VALID, recipes: [recipe] }), "RECIPE_INDEX_MALFORMED", JSON.stringify(recipe));
  }
  const cookbook = { id: "o", title: "O", summary: "S", recipes: ["notes"] };
  assert.equal(refusalCode({ ...VALID, cookbooks: [cookbook] }), "RECIPE_INDEX_MALFORMED");
  assert.equal(refusalCode({ ...VALID, cookbooks: [{ ...cookbook, designation: "verified", maintainer: "x" }] }), "RECIPE_INDEX_MALFORMED");

  const community = { ...ENTRY, id: "pantry", ...COMMUNITY };
  const mixed = { ...cookbook, recipes: ["notes", "pantry"] };
  assert.equal(refusalCode({ ...VALID, recipes: [ENTRY, community], cookbooks: [{ ...mixed, ...HOLAXIS }] }), "RECIPE_INDEX_COOKBOOK_INVALID");
  const parsed = parseRecipeIndex({ ...VALID, recipes: [ENTRY, community], cookbooks: [{ ...mixed, ...COMMUNITY }] });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  assert.deepEqual([parsed.index.recipes[1]!.designation, parsed.index.recipes[1]!.maintainer], ["community", "octo-cook"]);
  assert.deepEqual([parsed.index.cookbooks[0]!.designation, parsed.index.cookbooks[0]!.maintainer], ["community", "octo-cook"]);
});

// ── Verifier ──────────────────────────────────────────────────────────────────────────────────

test("resolveIndexRecipe returns a recipe only when Core's source digest matches the pin", async () => {
  const tree = servedTree((name) => `recipes/${name}`, ["context-notes"]);
  const index = indexOf("alpha", tree.entries);
  const result = await resolveIndexRecipe(index, "context-notes", tree.read);
  assert.ok(result.ok);
  assert.equal(result.verified.source_digest, builtinDigest("context-notes"));
  assert.equal(result.verified.recipe.source, "index:alpha");
  assert.deepEqual([result.verified.designation, result.verified.maintainer], ["supported", "Holaxis-ai"]);
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
      tree.files.set(key, (tree.files.get(key) as string).replace(/\.(\s|$)/, ",$1"));
      assert.notEqual(tree.files.get(key), file.bytes, `${key} was tampered`);
      const result = await resolveIndexRecipe(indexOf("alpha", tree.entries), name, tree.read);
      assert.equal(result.ok ? "" : result.error.code, "RECIPE_INDEX_DIGEST_MISMATCH", key);
      const source = await createIndexRecipeSource(indexOf("alpha", tree.entries), tree.read).resolve(name);
      assert.equal(source?.ok, false, key);
    }
  }
});

test("files_digest pins manifest prose and READMEs that source_digest does not cover", async () => {
  const cases: Array<[string, (bytes: string) => string]> = [
    ["title", (bytes) => bytes.replace("title: Context Notes", "title: Something Else")],
    ["offer", (bytes) => bytes.replace("offer: give agents", "offer: give everyone")],
    ["body", (bytes) => `${bytes}\nAn extra sentence.\n`],
  ];
  for (const [what, change] of cases) {
    const tree = servedTree((n) => n, ["context-notes"]);
    const before = tree.files.get("context-notes/recipe.md") as string;
    tree.files.set("context-notes/recipe.md", change(before));
    assert.notEqual(tree.files.get("context-notes/recipe.md"), before, what);
    const result = await resolveIndexRecipe(indexOf("alpha", tree.entries), "context-notes", tree.read);
    assert.equal(result.ok, false, what);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_INDEX_DIGEST_MISMATCH", what);
    assert.equal(result.error.digest, "files_digest", what);
  }

  // A README is outside source_digest; once listed, files_digest pins it.
  const tree = servedTree((n) => n, ["context-notes"]);
  tree.files.set("context-notes/README.md", "# Context Notes\n\nInstall me.\n");
  const listed = { ...tree.entries[0]!, files: [...tree.entries[0]!.files, "README.md"] };
  const pinned = { ...listed, files_digest: pin([...builtinRecipeFiles("context-notes")!, { path: "README.md", bytes: "# Context Notes\n\nInstall me.\n" }]) };
  const ok = await resolveIndexRecipe(indexOf("alpha", [pinned]), "context-notes", tree.read);
  assert.ok(ok.ok, ok.ok ? "" : ok.error.message);
  assert.equal(ok.verified.source_digest, builtinDigest("context-notes"));
  tree.files.set("context-notes/README.md", "# Context Notes\n\nInstall something else.\n");
  const readme = await resolveIndexRecipe(indexOf("alpha", [pinned]), "context-notes", tree.read);
  assert.equal(readme.ok ? "" : readme.error.digest, "files_digest");
});

test("source_digest still refuses when the byte pin was taken from different definitions", async () => {
  // A publisher error, not an attack: files_digest matches the served bytes but source_digest is stale.
  const tree = servedTree((n) => n, ["context-notes"]);
  const key = "context-notes/conventions/context-note.md";
  tree.files.set(key, (tree.files.get(key) as string).replace("# ", "# Changed "));
  const served = builtinRecipeFiles("context-notes")!.map((file) => ({ path: file.path, bytes: tree.files.get(`context-notes/${file.path}`) as string }));
  const entry = { ...tree.entries[0]!, files_digest: pin(served) };
  const result = await resolveIndexRecipe(indexOf("alpha", [entry]), "context-notes", tree.read);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");
  assert.equal(result.error.digest, "source_digest");
});

test("recipeFilesDigest ignores listing order and separates paths from bytes", async () => {
  const files = builtinRecipeFiles("roadmap")!;
  assert.equal(pin(files), pin([...files].reverse()));
  assert.notEqual(pin([{ path: "a", bytes: "bc" }]), pin([{ path: "ab", bytes: "c" }]));
  assert.notEqual(pin([{ path: "a", bytes: "b" }, { path: "c", bytes: "d" }]), pin([{ path: "a", bytes: "bd" }, { path: "c", bytes: "" }]));
  // Raw bytes, not decoded text: bytes that decode to the same replacement text still differ.
  assert.notEqual(recipeFilesDigest([{ path: "a", bytes: new Uint8Array([0xff]) }]), recipeFilesDigest([{ path: "a", bytes: new Uint8Array([0xfe]) }]));
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("x")]);
  assert.notEqual(recipeFilesDigest([{ path: "a", bytes: bom }]), recipeFilesDigest([{ path: "a", bytes: utf8("x") }]));

  const tree = servedTree((n) => `r/${n}`, ["roadmap"]);
  const reordered = { ...tree.entries[0]!, files: [...tree.entries[0]!.files].reverse() };
  assert.equal(reordered.files_digest, tree.entries[0]!.files_digest);
  const result = await resolveIndexRecipe(indexOf("alpha", [reordered]), "roadmap", tree.read);
  assert.ok(result.ok);
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
  const parsed = parseRecipeIndex({ format: RECIPE_INDEX_FORMAT, source: "alpha", recipes: [{ ...tree.entries[0], files: ["recipe.md", "../../secret.md"] }], cookbooks: [] });
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

test("Core decodes pinned bytes once: one leading BOM is dropped and invalid UTF-8 refuses", async () => {
  const tree = servedTree((n) => n, ["context-notes"]);
  const key = "context-notes/conventions/context-note.md";
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(tree.files.get(key) as string)]);
  tree.files.set(key, withBom);
  const served = builtinRecipeFiles("context-notes")!.map((file) => ({ path: file.path, bytes: tree.files.get(`context-notes/${file.path}`)! }));
  const bomEntry = { ...tree.entries[0]!, files_digest: pin(served) };
  assert.notEqual(bomEntry.files_digest, tree.entries[0]!.files_digest);
  const result = await resolveIndexRecipe(indexOf("alpha", [bomEntry]), "context-notes", tree.read);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.verified.source_digest, builtinDigest("context-notes"));

  const invalid = new Uint8Array([...utf8(tree.files.get("context-notes/recipe.md") as string), 0xff]);
  tree.files.set("context-notes/recipe.md", invalid);
  const pinnedInvalid = { ...tree.entries[0]!, files_digest: pin(builtinRecipeFiles("context-notes")!.map((file) => ({ path: file.path, bytes: tree.files.get(`context-notes/${file.path}`)! }))) };
  const refused = await resolveIndexRecipe(indexOf("alpha", [pinnedInvalid]), "context-notes", tree.read);
  assert.equal(refused.ok ? "" : refused.error.code, "RECIPE_INDEX_ENCODING_INVALID");
});

test("parseRecipeIndex decodes raw index bytes strictly", () => {
  assert.ok(parseRecipeIndex(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(JSON.stringify(VALID))])).ok);
  assert.equal(refusalCode(new Uint8Array([0x7b, 0xff, 0x7d])), "RECIPE_INDEX_ENCODING_INVALID");
});

test("resolveCookbook verifies every member in order and returns nothing when one fails", async () => {
  const tree = servedTree((name) => `r/${name}`, ["context-notes", "work-tracking", "roadmap"]);
  const cookbooks = [{ id: "plan", title: "Plan", summary: "Plan the work.", ...HOLAXIS, recipes: ["roadmap", "work-tracking"] }];
  const ok = await resolveCookbook(indexOf("alpha", tree.entries, cookbooks), "plan", tree.read);
  assert.ok(ok.ok);
  assert.deepEqual(ok.recipes.map((entry) => entry.recipe.id), ["roadmap", "work-tracking"]);

  tree.files.set("r/work-tracking/conventions/task.md", `${tree.files.get("r/work-tracking/conventions/task.md")}\nTampered.\n`);
  const bad = await resolveCookbook(indexOf("alpha", tree.entries, cookbooks), "plan", tree.read);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, "RECIPE_INDEX_DIGEST_MISMATCH");
  assert.equal(bad.recipe, "work-tracking");
  assert.equal("recipes" in bad, false);

  const unknown = await resolveCookbook(indexOf("alpha", tree.entries, cookbooks), "nope", tree.read);
  assert.equal(unknown.ok ? "" : unknown.error.code, "RECIPE_NOT_FOUND");
});

/** A served variant of context-notes under a new id, with `change` applied to its convention body. */
function variantTree(change: (body: string) => string) {
  const tree = servedTree((n) => `r/${n}`, ["context-notes", "work-tracking"]);
  const files = builtinRecipeFiles("context-notes")!.map((file) => ({
    path: file.path,
    bytes: file.path === "recipe.md"
      ? file.bytes.replace("id: context-notes", "id: cn-alt").replace("title: Context Notes", "title: CN Alt")
      : change(file.bytes),
  }));
  for (const file of files) tree.files.set(`r/cn-alt/${file.path}`, file.bytes);
  const parsed = parseRecipeFiles(files, "test", { okfVersion: "0.2" });
  assert.ok(parsed.ok);
  const entry = { id: "cn-alt", version: "1", ...HOLAXIS, source_digest: recipeSourceDigest(parsed.recipe), files_digest: pin(files), root: "r/cn-alt", files: files.map((file) => file.path) };
  return { tree, entries: [...tree.entries, entry] };
}

test("resolveCookbook refuses two members that install the same document, differing or identical", async () => {
  for (const [what, change] of [
    ["different definitions", (body: string) => body.replace("24h", "48h")],
    ["byte-identical definitions", (body: string) => body],
  ] as const) {
    const { tree, entries } = variantTree(change);
    const cookbooks = [{ id: "cb", title: "t", summary: "s", ...HOLAXIS, recipes: ["context-notes", "cn-alt"] }];
    const result = await resolveCookbook(indexOf("alpha", entries, cookbooks), "cb", tree.read);
    assert.equal(result.ok, false, what);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_INDEX_COOKBOOK_CONFLICT", what);
    assert.deepEqual(result.error.conflict, { recipes: ["context-notes", "cn-alt"], ids: ["conventions/context-note"] }, what);
    assert.match(result.error.message, /'conventions\/context-note' from both 'context-notes' and 'cn-alt'/, what);
    assert.equal("recipes" in result, false, what);
  }

  // Members with disjoint targets still resolve.
  const { tree, entries } = variantTree((body) => body);
  const disjoint = [{ id: "ok", title: "t", summary: "s", ...HOLAXIS, recipes: ["cn-alt", "work-tracking"] }];
  assert.ok((await resolveCookbook(indexOf("alpha", entries, disjoint), "ok", tree.read)).ok);
});

/** Serves arbitrary recipes under `r/<id>/`, pinned exactly as a publisher would pin them. */
function customTree(recipes: ReadonlyArray<{ id: string; files: RecipeFile[] }>) {
  const files = new Map<string, Uint8Array>();
  const entries = recipes.map(({ id, files: recipeFiles }) => {
    for (const file of recipeFiles) files.set(`r/${id}/${file.path}`, utf8(file.bytes));
    const parsed = parseRecipeFiles(recipeFiles, "test", { okfVersion: "0.2" });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
    return { id, version: "1", ...HOLAXIS, source_digest: recipeSourceDigest(parsed.recipe), files_digest: pin(recipeFiles), root: `r/${id}`, files: recipeFiles.map((file) => file.path) };
  });
  const read: RecipeIndexReader = async (path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("no such file");
    return bytes;
  };
  return { entries, read };
}

function viewRecipe(id: string, kind: string, registry: string, entry: string): RecipeFile[] {
  return [
    {
      path: "recipe.md",
      bytes: `---\ntype: Recipe\nid: ${id}\ntitle: ${id}\nversion: "1"\nsummary: A board.\ncontent_policy: definitions-only\n` +
        `pages:\n  - registry: ${registry}.md\n    entry: ${entry}\n---\n`,
    },
    { path: `conventions/${kind.toLowerCase()}.md`, bytes: `---\ntype: Convention\ngoverns: ${kind}\n---\n# ${kind}\n\nA ${kind}.\n` },
    { path: `${registry}.md`, bytes: `---\ntype: View\ntitle: Board\nentry: ${entry}\naccess: bundle-read\n---\nA board view (${id}).\n` },
    { path: entry, bytes: `<!doctype html><title>Board ${id}</title>` },
  ];
}

test("cookbook conflict: legacy pages-registry and current views-registry spellings of one View collide", async () => {
  for (const order of [["fresh", "legacy"], ["legacy", "fresh"]] as const) {
    const recipes = {
      fresh: { id: "fresh", files: viewRecipe("fresh", "Alpha", "views-registry/board", "views/board.html") },
      legacy: { id: "legacy", files: viewRecipe("legacy", "Beta", "pages-registry/board", "pages/board.html") },
    };
    const { entries, read } = customTree(order.map((name) => recipes[name]));
    const cookbooks = [{ id: "cb", title: "t", summary: "s", ...HOLAXIS, recipes: [...order] }];
    const result = await resolveCookbook(indexOf("alpha", entries, cookbooks), "cb", read);
    assert.equal(result.ok, false, order.join(","));
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_INDEX_COOKBOOK_CONFLICT");
    assert.deepEqual(result.error.conflict, {
      recipes: [...order],
      ids: ["pages-registry/board", "pages/board.html", "views-registry/board", "views/board.html"],
    });
  }

  // Different View names do not collide.
  const { entries, read } = customTree([
    { id: "fresh", files: viewRecipe("fresh", "Alpha", "views-registry/board", "views/board.html") },
    { id: "other", files: viewRecipe("other", "Beta", "pages-registry/plan", "pages/plan.html") },
  ]);
  const cookbooks = [{ id: "cb", title: "t", summary: "s", ...HOLAXIS, recipes: ["fresh", "other"] }];
  assert.ok((await resolveCookbook(indexOf("alpha", entries, cookbooks), "cb", read)).ok);
});

test("prepared install target ids do not depend on the edition or the preparation time", () => {
  for (const name of ["context-notes", "work-tracking", "roadmap", "site"]) {
    const loaded = loadBuiltinRecipe(name);
    assert.ok(loaded?.ok);
    const ids = (okfVersion: "0.1" | "0.2", now: string) => {
      const prepared = prepareRecipeInstall(loaded.recipe, { okfVersion, now });
      return [...prepared.docs.map((d) => d.id), ...prepared.pages.flatMap((p) => [p.registry.id, p.entry]), ...prepared.references.map((r) => r.doc.id), ...prepared.connectors.map((c) => c.doc.id)];
    };
    const reference = ids("0.2", "1970-01-01T00:00:00.000Z");
    assert.deepEqual(ids("0.1", "2026-11-03T12:00:00.000Z"), reference, name);
    assert.deepEqual(reference, [...loaded.recipe.docs.map((d) => d.id), ...loaded.recipe.pages.flatMap((p) => [p.registry.id, p.entry]), ...loaded.recipe.references.map((r) => r.doc.id)], name);
  }
});

// ── Frontmatter limits: refused honestly, and before any write ────────────────────────────────

const inject = (bytes: string, yaml: string): string => bytes.replace(/^---\n/, `---\n${yaml}\n`);
const EXPANDS_ON_WRITE = `x_s: &s "${"z".repeat(100_000)}"\nx_list: [*s,*s,*s,*s,*s,*s,*s,*s]`;

function withInjected(name: string, victim: string, yaml: string): RecipeFile[] {
  const files = builtinRecipeFiles(name)!.map((file) => (file.path === victim ? { ...file, bytes: inject(file.bytes, yaml) } : file));
  assert.ok(files.some((file) => file.bytes.includes(yaml)), victim);
  return files;
}

test("frontmatter a limit refuses on read is its own refusal, never a digest mismatch", async () => {
  const rows: Array<[string, string]> = [
    ["FRONTMATTER_CYCLE", "loop: &l [*l]"],
    ["FRONTMATTER_MALFORMED", "bad: [unclosed"],
    ["FRONTMATTER_TOO_DEEP", `d: ${"[".repeat(40)}${"]".repeat(40)}`],
    ["FRONTMATTER_TOO_LARGE", `x_big: |\n${`  ${"y".repeat(100)}\n`.repeat(3000)}`],
    ["FRONTMATTER_ALIAS_LIMIT", `x_a: &a [${"1,".repeat(50)}1]\nx_b: [${Array(1200).fill("*a").join(",")}]`],
  ];
  for (const [code, yaml] of rows) {
    for (const victim of ["recipe.md", "conventions/task.md"]) {
      const files = withInjected("work-tracking", victim, yaml);
      const entry = { id: "work-tracking", version: "1", ...HOLAXIS, source_digest: DIGEST, files_digest: pin(files), files: files.map((file) => file.path) };
      const read: RecipeIndexReader = async (path) => utf8(files.find((file) => file.path === path)!.bytes);
      const result = await resolveIndexRecipe(indexOf("alpha", [entry]), "work-tracking", read);
      assert.equal(result.ok, false, code);
      if (result.ok) continue;
      assert.equal(result.error.code, "RECIPE_INDEX_FRONTMATTER_REFUSED", code);
      assert.deepEqual(result.error.frontmatter, { code, document: victim }, code);
      assert.equal(result.error.digest, undefined, code);
    }
  }
});

test("red probe: an alias that only expands past the limit on write is refused before a recipe verifies", async () => {
  // Parses within the read limits, so only the write check can see it, on any document kind.
  const rows: Array<[string, string, string]> = [
    ["roadmap", "conventions/roadmap.md", "conventions/roadmap.md"],
    ["roadmap", "conventions/roadmap-item.md", "conventions/roadmap-item.md"],
    ["site", "references/site-authoring.md", "references/site-authoring.md"],
  ];
  for (const [name, victim, document] of rows) {
    const files = withInjected(name, victim, EXPANDS_ON_WRITE);
    const { entries, read } = customTree([{ id: name, files }]);
    const result = await resolveIndexRecipe(indexOf("alpha", entries), name, read);
    assert.equal(result.ok, false, victim);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_INDEX_FRONTMATTER_REFUSED", victim);
    assert.deepEqual(result.error.frontmatter, { code: "FRONTMATTER_TOO_LARGE", document }, victim);
  }

  const view = viewRecipe("board", "Alpha", "views-registry/board", "views/board.html");
  const expanded = view.map((file) => (file.path === "views-registry/board.md" ? { ...file, bytes: inject(file.bytes, EXPANDS_ON_WRITE) } : file));
  const { entries, read } = customTree([{ id: "board", files: expanded }]);
  const refused = await resolveIndexRecipe(indexOf("alpha", entries), "board", read);
  assert.deepEqual(refused.ok ? null : refused.error.frontmatter, { code: "FRONTMATTER_TOO_LARGE", document: "views-registry/board.md" });
});

test("a cookbook with a member that cannot be stored fails whole, naming that member", async () => {
  const { entries, read } = customTree([
    { id: "context-notes", files: builtinRecipeFiles("context-notes")! },
    { id: "work-tracking", files: withInjected("work-tracking", "conventions/task.md", EXPANDS_ON_WRITE) },
  ]);
  const cookbooks = [{ id: "cb", title: "t", summary: "s", ...HOLAXIS, recipes: ["context-notes", "work-tracking"] }];
  const result = await resolveCookbook(indexOf("alpha", entries, cookbooks), "cb", read);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_INDEX_FRONTMATTER_REFUSED");
  assert.equal(result.recipe, "work-tracking");
  assert.equal("recipes" in result, false);
});

test("the storable check counts what a write adds: a candidate that only overflows with attribution is refused", async () => {
  const base = builtinRecipeFiles("context-notes")!;
  const sized = (padding: number) => base.map((file) => (file.path === "conventions/context-note.md" ? { ...file, bytes: inject(file.bytes, `x_pad: ${"p".repeat(padding)}`) } : file));
  const preparedChars = (padding: number): number => {
    const parsed = parseRecipeFiles(sized(padding), "test", { okfVersion: "0.2" });
    assert.ok(parsed.ok);
    return stringifyFrontmatter(prepareRecipeInstall(parsed.recipe, { okfVersion: "0.2", now: "1970-01-01T00:00:00.000Z" }).docs[0]!.frontmatter).length;
  };
  // Fits on its own and with v0.1's prepared timestamp, but not with the attribution a v0.2 write
  // adds for a long actor, so only the as-written shape can refuse it.
  const padding = 1000 + FRONTMATTER_LIMITS.sourceChars - 60 - preparedChars(1000);
  stringifyFrontmatter(prepareRecipeInstall((parseRecipeFiles(sized(padding), "test", { okfVersion: "0.2" }) as { recipe: LoadedRecipe }).recipe, { okfVersion: "0.2", now: "1970-01-01T00:00:00.000Z" }).docs[0]!.frontmatter);

  const { entries, read } = customTree([{ id: "context-notes", files: sized(padding) }]);
  const result = await resolveIndexRecipe(indexOf("alpha", entries), "context-notes", read);
  assert.deepEqual(result.ok ? null : result.error.frontmatter, { code: "FRONTMATTER_TOO_LARGE", document: "conventions/context-note.md" });

  // The real write refuses the same recipe, which is what the check must predict.
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Probe\n");
  const parsed = parseRecipeFiles(sized(padding), "test", { okfVersion: "0.2" });
  assert.ok(parsed.ok);
  await assert.rejects(installRecipe({ root: "memory://probe", backend }, parsed.recipe, { actor: `process:${"a".repeat(80)}` }), FrontmatterRefusedError);
});

test("assertRecipeStorable passes every built-in on both editions", () => {
  for (const name of ["context-notes", "work-tracking", "roadmap", "site"]) {
    const loaded = loadBuiltinRecipe(name);
    assert.ok(loaded?.ok);
    for (const okfVersion of ["0.1", "0.2"] as const) assertRecipeStorable(loaded.recipe, okfVersion);
  }
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

test("cookbook conflict: targets that differ only by case collide", async () => {
  const { entries, read } = customTree([
    { id: "upper", files: viewRecipe("upper", "Alpha", "views-registry/Board", "views/Board.html") },
    { id: "lower", files: viewRecipe("lower", "Beta", "views-registry/board", "views/board.html") },
  ]);
  const cookbooks = [{ id: "cb", title: "t", summary: "s", ...HOLAXIS, recipes: ["upper", "lower"] }];
  const result = await resolveCookbook(indexOf("alpha", entries, cookbooks), "cb", read);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_INDEX_COOKBOOK_CONFLICT");
  assert.deepEqual(result.error.conflict, {
    recipes: ["upper", "lower"],
    ids: ["views-registry/Board", "views-registry/board", "views/Board.html", "views/board.html"],
  });
});
