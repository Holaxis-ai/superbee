/** CLI recipe acquisition and resolver agreement; pure parser cases live in core. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseRecipeFiles,
  resolveRecipe,
  builtinRecipeSource,
  filesRecipeSource,
  builtinNames,
  DEFAULT_RECIPE_REF,
  CONTEXT_NOTES_RECIPE,
  type RecipeFile,
} from "../src/recipe-source.js";

const VALID_MANIFEST: RecipeFile = {
  path: "recipe.md",
  bytes: "---\ntype: Recipe\nid: example\ntitle: Example\nversion: \"1\"\nsummary: A trivial test recipe.\n---\nBody.\n",
};

const VALID_TERM: RecipeFile = {
  path: "conventions/term.md",
  bytes: "---\ntype: Convention\ngoverns: Term\n---\n# Term\n\nA glossary entry.\n",
};

const PORTABLE_MANIFEST: RecipeFile = {
  path: "recipe.md",
  bytes:
    "---\ntype: Recipe\nid: portable\ntitle: Portable\nversion: \"1\"\nsummary: Definitions only.\n" +
    "content_policy: definitions-only\npages:\n" +
    "  - registry: pages-registry/reviews.md\n    entry: pages/reviews.html\n---\n",
};

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-recipe-source-test-"));
}

test("CLI recipe facade uses the core parser implementation", async () => {
  const core = await import("@superbee/core/recipes");
  assert.equal(parseRecipeFiles, core.parseRecipeFiles);
});

// ── The built-in source (no special-case downstream of `parseRecipeFiles`) ────────────────────

test("builtinRecipeSource: resolves 'context-notes' through parseRecipeFiles, not a hand-rolled shape", async () => {
  const source = builtinRecipeSource();
  const result = await source.resolve("context-notes");
  assert.ok(result);
  assert.equal(result!.ok, true);
  if (!result!.ok) return;
  assert.equal(result!.recipe.id, "context-notes");
  assert.equal(result!.recipe.docs.length, 1);
  assert.equal(result!.recipe.docs[0]!.id, "conventions/context-note");
});

test("builtinRecipeSource: returns null (not addressed to me) for an unknown name and for anything path-shaped", async () => {
  const source = builtinRecipeSource();
  assert.equal(await source.resolve("bogus-recipe"), null);
  assert.equal(await source.resolve("./context-notes"), null);
});

test("builtinNames / DEFAULT_RECIPE_REF / CONTEXT_NOTES_RECIPE stay consistent", () => {
  assert.deepEqual(builtinNames(), ["context-notes", "work-tracking", "roadmap"]);
  assert.equal(DEFAULT_RECIPE_REF, "context-notes");
  assert.equal(CONTEXT_NOTES_RECIPE.id, "context-notes");
});

// ── The files source: path-safety (row 6) ──────────────────────────────────────────────────────

test("filesRecipeSource: returns null for a bare name (not path-shaped)", async () => {
  const source = filesRecipeSource();
  assert.equal(await source.resolve("context-notes"), null);
});

test("resolveRecipe: an absent path -> RECIPE_NOT_FOUND", async () => {
  const result = await resolveRecipe("./definitely-does-not-exist-anywhere");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_NOT_FOUND");
});

test("resolveRecipe: a path to a FILE, not a directory -> RECIPE_UNSAFE_PATH", async () => {
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, "not-a-dir.md");
    await writeFile(filePath, "hello");
    const result = await resolveRecipe(filePath);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRecipe: an unknown bare name -> RECIPE_NOT_FOUND naming the known built-ins", async () => {
  const result = await resolveRecipe("bogus-recipe-name");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_NOT_FOUND");
  assert.match(result.error.message, /context-notes/);
});

test("resolveRecipe: loads a real external recipe folder end to end (the fixture)", async () => {
  const fixture = path.resolve(import.meta.dirname, "fixtures/example-recipe");
  const result = await resolveRecipe(fixture);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.id, "example");
  assert.equal(result.recipe.docs.length, 1);
  assert.equal(result.recipe.docs[0]!.id, "conventions/example-term");
  assert.deepEqual(result.recipe.governs, ["Term"]);
});

test("resolveRecipe: loads the content-free Review Workflow package with its declared View", async () => {
  const fixture = path.resolve(import.meta.dirname, "../../../examples/recipes/review-workflow");
  const result = await resolveRecipe(fixture);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.id, "review-workflow");
  assert.equal(result.recipe.contentPolicy, "definitions-only");
  assert.deepEqual([...result.recipe.governs].sort(), ["Review Request", "View"]);
  assert.equal(result.recipe.pages.length, 1);
  assert.equal(result.recipe.pages[0]!.registry.id, "views-registry/review-workflow-reviews");
  assert.equal(result.recipe.pages[0]!.entry, "views/review-workflow/reviews.html");
  assert.equal(result.recipe.references.length, 1);
  assert.equal(result.recipe.references[0]!.doc.id, "references/view-authoring-v0");
});

test("resolveRecipe: definitions-only scans the full folder and rejects hidden instance data", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await mkdir(path.join(dir, "review-requests"), { recursive: true });
    await writeFile(
      path.join(dir, "recipe.md"),
      PORTABLE_MANIFEST.bytes.replace(/pages:[\s\S]*?---\n$/, "---\n"),
    );
    await writeFile(path.join(dir, "conventions", "term.md"), VALID_TERM.bytes);
    await writeFile(path.join(dir, "review-requests", "private.md"), "---\ntype: Review Request\n---\nprivate\n");
    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(result.error.message, /review-requests\/private\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// PR #54 review finding 2 (tasks/pr-54-review-followups): the full-inventory walk previously read
// every file BEFORE the parser rejected it as undeclared — a `.git/` dir inside a recipe root was
// read object-by-object as UTF-8. The grammar can never accept a dot-prefixed path, so the walk
// now fails fast, before recursing into (or reading) a dot-prefixed entry.
test("resolveRecipe: definitions-only fails FAST on a dot-prefixed directory — never reads into it", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), PORTABLE_MANIFEST.bytes.replace(/pages:[\s\S]*?---\n$/, "---\n"));
    await writeFile(path.join(dir, "conventions", "term.md"), VALID_TERM.bytes);
    // A `.git/` directory with real content inside it — if the walk ever recursed into it, the
    // rejection would name a file WITHIN `.git/` (e.g. `.git/HEAD`), never `.git` itself.
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(
      result.error.message,
      /'\.git'/,
      `expected the rejection to name the dot-DIRECTORY itself, not a file inside it; got: ${result.error.message}`,
    );
    assert.doesNotMatch(result.error.message, /HEAD/, "the walk must reject '.git' before ever reading its contents");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRecipe: definitions-only rejects a dot-prefixed FILE (.DS_Store) at walk time too — same strictness as before, now with no wasted read", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), PORTABLE_MANIFEST.bytes.replace(/pages:[\s\S]*?---\n$/, "---\n"));
    await writeFile(path.join(dir, "conventions", "term.md"), VALID_TERM.bytes);
    await writeFile(path.join(dir, ".DS_Store"), "binary junk");
    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(result.error.message, /\.DS_Store/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRecipe: definitions-only policy spelling is exact across inventory discovery and parsing", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await mkdir(path.join(dir, "review-requests"), { recursive: true });
    const manifest = PORTABLE_MANIFEST.bytes
      .replace("content_policy: definitions-only", 'content_policy: " definitions-only "')
      .replace(/pages:[\s\S]*?---\n$/, "---\n");
    await writeFile(path.join(dir, "recipe.md"), manifest);
    await writeFile(path.join(dir, "conventions", "term.md"), VALID_TERM.bytes);
    await writeFile(path.join(dir, "review-requests", "private.md"), "---\ntype: Review Request\n---\nprivate\n");
    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_MALFORMED");
    assert.match(result.error.message, /unsupported content_policy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRecipe: a symlink inside conventions/ that escapes the recipe root -> RECIPE_UNSAFE_PATH", async () => {
  const dir = await tempDir();
  const outsideTarget = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), VALID_MANIFEST.bytes);
    const outsideFile = path.join(outsideTarget, "escaped.md");
    await writeFile(outsideFile, VALID_TERM.bytes);
    await symlink(outsideFile, path.join(dir, "conventions", "escaped.md"));

    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});

test("resolveRecipe: a recipe.md symlink escaping the recipe root is rejected", async () => {
  const dir = await tempDir();
  const outsideTarget = await tempDir();
  try {
    const outsideManifest = path.join(outsideTarget, "recipe.md");
    await writeFile(outsideManifest, VALID_MANIFEST.bytes);
    await symlink(outsideManifest, path.join(dir, "recipe.md"));
    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(result.error.message, /recipe\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});

// The three leaf outcomes of reading over one descriptor. The escape cases above pin what must be
// refused; these pin what must NOT be, and keep the two refusals that are not escapes legible.

test("resolveRecipe: a symlink that stays inside the recipe root is read, not refused", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await mkdir(path.join(dir, "shared"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), VALID_MANIFEST.bytes);
    await writeFile(path.join(dir, "shared", "term.md"), VALID_TERM.bytes);
    await symlink(path.join(dir, "shared", "term.md"), path.join(dir, "conventions", "term.md"));

    const result = await resolveRecipe(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.recipe.docs[0]!.id, "conventions/term");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRecipe: an in-root symlink to a directory is refused as a non-regular file, not as an escape", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await mkdir(path.join(dir, "shared"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), VALID_MANIFEST.bytes);
    await symlink(path.join(dir, "shared"), path.join(dir, "conventions", "term.md"));

    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(result.error.message, /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "resolveRecipe: an unreadable file says so instead of blaming a symlink",
  { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions as a non-root user" : false },
  async () => {
    const dir = await tempDir();
    try {
      await mkdir(path.join(dir, "conventions"), { recursive: true });
      await writeFile(path.join(dir, "recipe.md"), VALID_MANIFEST.bytes);
      const term = path.join(dir, "conventions", "term.md");
      await writeFile(term, VALID_TERM.bytes);
      await chmod(term, 0o000);

      const result = await resolveRecipe(dir);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
      assert.match(result.error.message, /permissions/);
      assert.doesNotMatch(result.error.message, /symlink/);
    } finally {
      await chmod(path.join(dir, "conventions", "term.md"), 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("resolveRecipe: a dangling in-root symlink says the path does not resolve, not that it escapes", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "conventions"), { recursive: true });
    await writeFile(path.join(dir, "recipe.md"), VALID_MANIFEST.bytes);
    await symlink(path.join(dir, "gone.md"), path.join(dir, "conventions", "term.md"));

    const result = await resolveRecipe(dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
    assert.match(result.error.message, /does not resolve/);
    assert.doesNotMatch(result.error.message, /escaping/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
