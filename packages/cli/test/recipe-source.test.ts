/**
 * Recipes Unit B (pluggable recipes) — the seam itself: `parseRecipeFiles` (pure, no fs) and
 * `resolveRecipe`/`filesRecipeSource`/`builtinRecipeSource` (fs-touching, but still no bundle).
 *
 * Covers C.2 test matrix rows 6 (path-safety) and 8 (`parseRecipeFiles` unit table). Command-level
 * integration (built-in re-host, external apply, idempotency, conflict surfacing, malformed ->
 * CliError) lives in `recipes.test.ts`.
 */
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

// A View pair at the LEGACY locations (pages-registry//pages/) — locations stay accepted; the
// legacy `type: Page`/`bridge:` NAMES do not (rejection pinned in recipes.test.ts).
const PAGE_REGISTRY: RecipeFile = {
  path: "pages-registry/reviews.md",
  bytes: "---\ntype: View\ntitle: Reviews\nentry: pages/reviews.html\naccess: bundle-read\n---\nLive reviews.\n",
};

const PAGE_HTML: RecipeFile = {
  path: "pages/reviews.html",
  bytes: "<!doctype html><title>Reviews</title>",
};

const REFERENCE_MANIFEST: RecipeFile = {
  ...PORTABLE_MANIFEST,
  bytes: PORTABLE_MANIFEST.bytes.replace(
    "content_policy: definitions-only\n",
    "content_policy: definitions-only\nreferences:\n  - references/page-authoring-v0.md\n",
  ),
};

const PAGE_REFERENCE: RecipeFile = {
  path: "references/page-authoring-v0.md",
  bytes: "---\ntype: Reference\ntitle: Page authoring v0\nprotocol: v0\n---\n# Page authoring\n",
};

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-recipe-source-test-"));
}

// ── parseRecipeFiles: the pure pipeline (row 8) ────────────────────────────────────────────────

test("parseRecipeFiles: a valid manifest + one convention doc parses to a LoadedRecipe", () => {
  const result = parseRecipeFiles([VALID_MANIFEST, VALID_TERM], "test:valid");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.id, "example");
  assert.equal(result.recipe.title, "Example");
  assert.equal(result.recipe.version, "1");
  assert.equal(result.recipe.summary, "A trivial test recipe.");
  assert.equal(result.recipe.source, "test:valid");
  assert.deepEqual(result.recipe.governs, ["Term"]);
  assert.equal(result.recipe.docs.length, 1);
  assert.equal(result.recipe.docs[0]!.id, "conventions/term");
  assert.deepEqual(result.recipe.pages, []);
  assert.deepEqual(result.recipe.references, []);
  assert.deepEqual(result.recipe.warnings, []);
});

test("parseRecipeFiles: definitions-only package materializes an explicitly declared Page pair", () => {
  const result = parseRecipeFiles([PORTABLE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML], "test:portable");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.contentPolicy, "definitions-only");
  assert.equal(result.recipe.pages.length, 1);
  assert.equal(result.recipe.pages[0]!.registry.id, "pages-registry/reviews");
  assert.equal(result.recipe.pages[0]!.entry, "pages/reviews.html");
  assert.equal(result.recipe.pages[0]!.html, PAGE_HTML.bytes);
  assert.deepEqual(result.recipe.references, []);
});

const VIEW_MANIFEST: RecipeFile = {
  path: "recipe.md",
  bytes:
    "---\ntype: Recipe\nid: portable-view\ntitle: Portable view\nversion: \"1\"\nsummary: Definitions only.\n" +
    "content_policy: definitions-only\npages:\n" +
    "  - registry: views-registry/board.md\n    entry: views/board.html\n---\n",
};

const VIEW_REGISTRY_FILE: RecipeFile = {
  path: "views-registry/board.md",
  bytes: "---\ntype: View\ntitle: Board\nentry: views/board.html\naccess: bundle-read\n---\nA board view.\n",
};

const VIEW_HTML: RecipeFile = {
  path: "views/board.html",
  bytes: "<!doctype html><title>Board</title>",
};

test("parseRecipeFiles: a type View pair under views-registry//views/ materializes alongside the legacy grammar", () => {
  const result = parseRecipeFiles([VIEW_MANIFEST, VALID_TERM, VIEW_REGISTRY_FILE, VIEW_HTML], "test:portable-view");
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.recipe.pages.length, 1);
  assert.equal(result.recipe.pages[0]!.registry.id, "views-registry/board");
  assert.equal(result.recipe.pages[0]!.registry.frontmatter.type, "View");
  assert.equal(result.recipe.pages[0]!.entry, "views/board.html");
  assert.equal(result.recipe.pages[0]!.html, VIEW_HTML.bytes);
});

test("parseRecipeFiles: View paths ride the SAME safe-segment grammar, and error strings teach both accepted forms", () => {
  // Unsafe views-form paths are rejected exactly like their pages-form counterparts.
  for (const [registry, entry] of [
    ["views-registry/has space.md", "views/board.html"],
    ["views-registry/.hidden.md", "views/board.html"],
    ["views-registry/board.md", "views/.hidden.html"],
    ["views-registry/board.md", "views/assets.md/board.html"],
  ] as const) {
    const manifest: RecipeFile = {
      ...VIEW_MANIFEST,
      bytes: VIEW_MANIFEST.bytes.replace("views-registry/board.md", registry).replace("views/board.html", entry),
    };
    const registryFile: RecipeFile = { path: registry, bytes: VIEW_REGISTRY_FILE.bytes.replace("views/board.html", entry) };
    const html: RecipeFile = { path: entry, bytes: VIEW_HTML.bytes };
    const result = parseRecipeFiles([manifest, VALID_TERM, registryFile, html], `test:unsafe-view:${registry}:${entry}`);
    assert.equal(result.ok, false, `${registry} -> ${entry} must be rejected`);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  }

  // An off-namespace registry path names BOTH accepted prefixes in its error.
  const badRegistry = parseRecipeFiles(
    [
      { ...VIEW_MANIFEST, bytes: VIEW_MANIFEST.bytes.replace("views-registry/board.md", "docs/board.md") },
      VALID_TERM,
      { ...VIEW_REGISTRY_FILE, path: "docs/board.md" },
      VIEW_HTML,
    ],
    "test:off-namespace-registry",
  );
  assert.equal(badRegistry.ok, false);
  if (!badRegistry.ok) {
    assert.match(badRegistry.error.message, /views-registry\//);
    assert.match(badRegistry.error.message, /pages-registry\//);
  }

  // An off-namespace entry path names BOTH accepted prefixes in its error.
  const badEntry = parseRecipeFiles(
    [
      { ...VIEW_MANIFEST, bytes: VIEW_MANIFEST.bytes.replace("views/board.html", "assets/board.html") },
      VALID_TERM,
      { ...VIEW_REGISTRY_FILE, bytes: VIEW_REGISTRY_FILE.bytes.replace("views/board.html", "assets/board.html") },
      { ...VIEW_HTML, path: "assets/board.html" },
    ],
    "test:off-namespace-entry",
  );
  assert.equal(badEntry.ok, false);
  if (!badEntry.ok) {
    assert.match(badEntry.error.message, /views\//);
    assert.match(badEntry.error.message, /pages\//);
  }

  // A registry doc that is neither View nor Page fails, and the error teaches both names.
  const badType = parseRecipeFiles(
    [VIEW_MANIFEST, VALID_TERM, { ...VIEW_REGISTRY_FILE, bytes: VIEW_REGISTRY_FILE.bytes.replace("type: View", "type: Design") }, VIEW_HTML],
    "test:bad-view-type",
  );
  assert.equal(badType.ok, false);
  if (!badType.ok) {
    assert.equal(badType.error.code, "RECIPE_MALFORMED");
    assert.match(badType.error.message, /type: View/);
    assert.match(badType.error.message, /type: Page/);
  }
});

test("parseRecipeFiles: definitions-only package materializes an explicitly declared operating Reference", () => {
  const result = parseRecipeFiles(
    [REFERENCE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, PAGE_REFERENCE],
    "test:portable-reference",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.references.length, 1);
  assert.equal(result.recipe.references[0]!.doc.id, "references/page-authoring-v0");
  assert.equal(result.recipe.references[0]!.doc.frontmatter.type, "Reference");
  assert.match(result.recipe.references[0]!.doc.body, /Page authoring/);
});

test("parseRecipeFiles: Reference paths are exact, safe, unique, and definitions-only", () => {
  for (const unsafe of [
    "docs/page-authoring-v0.md",
    "references/has space.md",
    "references/.hidden.md",
    "references/index.md",
    '" references/page-authoring-v0.md "',
  ]) {
    const manifest = {
      ...REFERENCE_MANIFEST,
      bytes: REFERENCE_MANIFEST.bytes.replace("references/page-authoring-v0.md", unsafe),
    };
    const file = { ...PAGE_REFERENCE, path: unsafe.replaceAll('"', "").trim() };
    const result = parseRecipeFiles([manifest, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, file], `test:unsafe-ref:${unsafe}`);
    assert.equal(result.ok, false, `${unsafe} must be rejected`);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  }

  const duplicateManifest = {
    ...REFERENCE_MANIFEST,
    bytes: REFERENCE_MANIFEST.bytes.replace(
      "  - references/page-authoring-v0.md\n",
      "  - references/Page.md\n  - references/page.md\n",
    ),
  };
  const duplicate = parseRecipeFiles(
    [
      duplicateManifest,
      VALID_TERM,
      PAGE_REGISTRY,
      PAGE_HTML,
      { ...PAGE_REFERENCE, path: "references/Page.md" },
      { ...PAGE_REFERENCE, path: "references/page.md" },
    ],
    "test:duplicate-ref",
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "RECIPE_MALFORMED");

  const noPolicy = {
    ...REFERENCE_MANIFEST,
    bytes: REFERENCE_MANIFEST.bytes.replace("content_policy: definitions-only\n", ""),
  };
  const unscoped = parseRecipeFiles(
    [noPolicy, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, PAGE_REFERENCE],
    "test:reference-no-policy",
  );
  assert.equal(unscoped.ok, false);
  if (!unscoped.ok) assert.equal(unscoped.error.code, "RECIPE_MALFORMED");
});

test("parseRecipeFiles: declared References must exist and be typed, titled Reference docs", () => {
  const missing = parseRecipeFiles(
    [REFERENCE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML],
    "test:missing-reference",
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error.message, /missing declared Reference/);

  for (const bytes of [
    "---\ntype: Task\ntitle: Not a reference\n---\n",
    "---\ntype: Reference\n---\nUntitled.\n",
  ]) {
    const malformed = parseRecipeFiles(
      [REFERENCE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, { ...PAGE_REFERENCE, bytes }],
      "test:malformed-reference",
    );
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "RECIPE_MALFORMED");
  }
});

test("parseRecipeFiles: a valid nested Page declaration preserves the exact runtime id and blob key", () => {
  const registry = "pages-registry/reviews/architecture.v2.md";
  const entry = "pages/reviews/architecture.v2.html";
  const manifest: RecipeFile = {
    ...PORTABLE_MANIFEST,
    bytes: PORTABLE_MANIFEST.bytes
      .replace("pages-registry/reviews.md", registry)
      .replace("pages/reviews.html", entry),
  };
  const registryFile: RecipeFile = {
    path: registry,
    bytes: PAGE_REGISTRY.bytes.replace("pages/reviews.html", entry),
  };
  const html: RecipeFile = { path: entry, bytes: PAGE_HTML.bytes };
  const result = parseRecipeFiles([manifest, VALID_TERM, registryFile, html], "test:nested-page");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.pages[0]!.registry.id, "pages-registry/reviews/architecture.v2");
  assert.equal(result.recipe.pages[0]!.entry, entry);
});

test("parseRecipeFiles: rejects Page paths that the runtime cannot discover or load", () => {
  for (const [registry, entry] of [
    ["pages-registry/has space.md", "pages/reviews.html"],
    ["pages-registry/.hidden.md", "pages/reviews.html"],
    ["pages-registry/x.md.md", "pages/reviews.html"],
    ["pages-registry/x\\y.md", "pages/reviews.html"],
    ["pages-registry/reviews.md", "pages/.hidden.html"],
    ["pages-registry/reviews.md", "pages/has space.html"],
    ["pages-registry/reviews.md", "pages/assets.md/reviews.html"],
  ] as const) {
    const manifest: RecipeFile = {
      ...PORTABLE_MANIFEST,
      bytes: PORTABLE_MANIFEST.bytes
        .replace("pages-registry/reviews.md", registry)
        .replace("pages/reviews.html", entry),
    };
    const registryFile: RecipeFile = {
      path: registry,
      bytes: PAGE_REGISTRY.bytes.replace("pages/reviews.html", entry),
    };
    const html: RecipeFile = { path: entry, bytes: PAGE_HTML.bytes };
    const result = parseRecipeFiles([manifest, VALID_TERM, registryFile, html], `test:unsafe:${registry}:${entry}`);
    assert.equal(result.ok, false, `${registry} -> ${entry} must be rejected`);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  }
});

test("parseRecipeFiles: manifest Page paths are exact and reject surrounding whitespace", () => {
  for (const [needle, padded] of [
    ["pages-registry/reviews.md", '" pages-registry/reviews.md "'],
    ["pages/reviews.html", '" pages/reviews.html "'],
  ] as const) {
    const manifest = { ...PORTABLE_MANIFEST, bytes: PORTABLE_MANIFEST.bytes.replace(needle, padded) };
    const result = parseRecipeFiles([manifest, VALID_TERM, PAGE_REGISTRY, PAGE_HTML], `test:padded-manifest:${needle}`);
    assert.equal(result.ok, false, `${needle} must not be whitespace-normalized`);
    if (result.ok) continue;
    assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  }
});

test("parseRecipeFiles: rejects case-folded duplicate Page targets for cross-filesystem portability", () => {
  const manifest: RecipeFile = {
    ...PORTABLE_MANIFEST,
    bytes:
      "---\ntype: Recipe\nid: portable\ntitle: Portable\nversion: \"1\"\nsummary: Definitions only.\n" +
      "content_policy: definitions-only\npages:\n" +
      "  - registry: pages-registry/Foo.md\n    entry: pages/Foo.html\n" +
      "  - registry: pages-registry/foo.md\n    entry: pages/foo.html\n---\n",
  };
  const files: RecipeFile[] = [
    manifest,
    VALID_TERM,
    { path: "pages-registry/Foo.md", bytes: PAGE_REGISTRY.bytes.replaceAll("reviews", "Foo") },
    { path: "pages/Foo.html", bytes: PAGE_HTML.bytes },
    { path: "pages-registry/foo.md", bytes: PAGE_REGISTRY.bytes.replaceAll("reviews", "foo") },
    { path: "pages/foo.html", bytes: PAGE_HTML.bytes },
  ];
  const result = parseRecipeFiles(files, "test:case-folded-duplicates");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /duplicate/i);
});

test("parseRecipeFiles: Page assets require the definitions-only policy", () => {
  const manifest = {
    ...PORTABLE_MANIFEST,
    bytes: PORTABLE_MANIFEST.bytes.replace("content_policy: definitions-only\n", ""),
  };
  const result = parseRecipeFiles([manifest, VALID_TERM, PAGE_REGISTRY, PAGE_HTML], "test:no-policy");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /content_policy/);
});

test("parseRecipeFiles: definitions-only rejects undeclared files before apply", () => {
  const instance: RecipeFile = {
    path: "review-requests/private.md",
    bytes: "---\ntype: Review Request\ntitle: Private\n---\nsecret\n",
  };
  const result = parseRecipeFiles(
    [PORTABLE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, instance],
    "test:contains-data",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
  assert.match(result.error.message, /definitions-only/);
  assert.match(result.error.message, /private\.md/);
});

test("parseRecipeFiles: definitions-only hard-rejects Convention warnings instead of installing a partial model", () => {
  const malformed: RecipeFile = {
    path: "conventions/term.md",
    bytes: "---\ntype: Convention\ngoverns: Term\nfields:\n  mystery: [title]\n---\n",
  };
  const result = parseRecipeFiles([PORTABLE_MANIFEST, malformed, PAGE_REGISTRY, PAGE_HTML], "test:bad-kind");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /fields\.mystery/);
});

test("parseRecipeFiles: Page registry entry must match the manifest entry", () => {
  const mismatch = { ...PAGE_REGISTRY, bytes: PAGE_REGISTRY.bytes.replace("pages/reviews.html", "pages/other.html") };
  const result = parseRecipeFiles([PORTABLE_MANIFEST, VALID_TERM, mismatch, PAGE_HTML], "test:mismatch");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /does not match/);
});

test("parseRecipeFiles: Page registry entry matching is exact, not whitespace-normalized", () => {
  const padded = {
    ...PAGE_REGISTRY,
    bytes: PAGE_REGISTRY.bytes.replace("entry: pages/reviews.html", 'entry: " pages/reviews.html "'),
  };
  const result = parseRecipeFiles([PORTABLE_MANIFEST, VALID_TERM, padded, PAGE_HTML], "test:padded-entry");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /does not match/);
});

test("parseRecipeFiles: a missing recipe.md manifest -> RECIPE_MALFORMED", () => {
  const result = parseRecipeFiles([VALID_TERM], "test:no-manifest");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /recipe\.md/);
});

test("parseRecipeFiles: recipe.md with the wrong type -> RECIPE_MALFORMED", () => {
  const badType: RecipeFile = {
    path: "recipe.md",
    bytes: "---\ntype: NotARecipe\nid: x\ntitle: X\nversion: \"1\"\nsummary: s\n---\n",
  };
  const result = parseRecipeFiles([badType, VALID_TERM], "test:wrong-type");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
});

test("parseRecipeFiles: recipe.md missing id/version -> RECIPE_MALFORMED naming the missing fields", () => {
  const missingFields: RecipeFile = {
    path: "recipe.md",
    bytes: "---\ntype: Recipe\ntitle: X\nsummary: s\n---\n",
  };
  const result = parseRecipeFiles([missingFields, VALID_TERM], "test:missing-fields");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /id/);
  assert.match(result.error.message, /version/);
});

test("parseRecipeFiles: zero valid convention docs -> RECIPE_EMPTY", () => {
  const result = parseRecipeFiles([VALID_MANIFEST], "test:empty");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_EMPTY");
});

test("parseRecipeFiles: a self-duplicate 'governs' within the recipe -> RECIPE_MALFORMED", () => {
  const dup: RecipeFile = {
    path: "conventions/term-2.md",
    bytes: "---\ntype: Convention\ngoverns: Term\n---\n# Term Two\n",
  };
  const result = parseRecipeFiles([VALID_MANIFEST, VALID_TERM, dup], "test:self-dup");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_MALFORMED");
  assert.match(result.error.message, /twice/);
});

test("parseRecipeFiles: definitions-only rejects an unsafe id outside its declared definitions", () => {
  const outside: RecipeFile = { path: "notes/term.md", bytes: VALID_TERM.bytes };
  const result = parseRecipeFiles([PORTABLE_MANIFEST, VALID_TERM, PAGE_REGISTRY, PAGE_HTML, outside], "test:outside");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
});

test("parseRecipeFiles: a reserved filename under conventions/ -> RECIPE_UNSAFE_PATH", () => {
  const reserved: RecipeFile = { path: "conventions/index.md", bytes: "---\ntype: Convention\ngoverns: X\n---\n" };
  const result = parseRecipeFiles([VALID_MANIFEST, reserved], "test:reserved");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RECIPE_UNSAFE_PATH");
});

test("parseRecipeFiles: a non-Convention doc under conventions/ is skipped-with-warning, not fatal", () => {
  const notAConvention: RecipeFile = {
    path: "conventions/other.md",
    bytes: "---\ntype: SomethingElse\n---\nStray file.\n",
  };
  const result = parseRecipeFiles([VALID_MANIFEST, VALID_TERM, notAConvention], "test:skip-warn");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.docs.length, 1); // only the valid Term convention
  assert.equal(result.recipe.warnings.length, 1);
  assert.equal(result.recipe.warnings[0]!.code, "KIND_CONVENTION_MALFORMED");
});

test("parseRecipeFiles: a convention doc with empty 'governs' is skipped-with-warning", () => {
  const noGoverns: RecipeFile = { path: "conventions/other.md", bytes: "---\ntype: Convention\n---\nNo governs.\n" };
  const result = parseRecipeFiles([VALID_MANIFEST, VALID_TERM, noGoverns], "test:no-governs");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.docs.length, 1);
  assert.equal(result.recipe.warnings.length, 1);
});

test("parseRecipeFiles: reserved manifest keys (composes/seeds/requires) are surfaced as warnings, never silently dropped", () => {
  const withReserved: RecipeFile = {
    path: "recipe.md",
    bytes: "---\ntype: Recipe\nid: x\ntitle: X\nversion: \"1\"\nsummary: s\ncomposes: [other]\n---\n",
  };
  const result = parseRecipeFiles([withReserved, VALID_TERM], "test:reserved-key");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.recipe.warnings.length, 1);
  assert.equal(result.recipe.warnings[0]!.code, "RECIPE_MANIFEST_RESERVED_KEY");
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
