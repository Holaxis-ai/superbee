// The ONE pure recipe parse+validate+materialize pipeline. Sources only acquire RecipeFile[];
// everything downstream of that byte boundary is distribution-neutral and branches on content,
// never on whether the files came from built-in constants, a folder, or a future source adapter.
import {
  parseMarkdown,
  parseConventionDoc,
  conceptIdFromPath,
  assertSafeConceptId,
  isReservedFile,
  CONVENTIONS_PREFIX,
  CONVENTION_TYPE,
  type OkfDocument,
  type ValidationWarning,
} from "@superbee/core";
import {
  declaredAccessValue,
  isAnyEntryKey,
  isAnyRegistryId,
  isPageTypeName,
  PAGE_ENTRY_PREFIX,
  PAGE_REGISTRY_PREFIX,
  VIEW_ENTRY_PREFIX,
  VIEW_REGISTRY_PREFIX,
} from "@superbee/core/page";

/** One recipe file: a path relative to the recipe root (posix), with its UTF-8 text. */
export interface RecipeFile {
  path: string;
  bytes: string;
}

/** One portable, content-free View carried by a recipe package. */
export interface RecipePage {
  /** The `type: View` registry document installed under `views-registry/` (or the legacy `pages-registry/` location). */
  registry: OkfDocument;
  /** The self-contained HTML blob key declared by the registry document. */
  entry: string;
  /** UTF-8 HTML bytes written to `entry`. */
  html: string;
}

/** One portable, content-free operating reference carried by a recipe package. */
export interface RecipeReference {
  /** A `type: Reference` document installed under `references/`. */
  doc: OkfDocument;
}

/** The common shape every `RecipeSource` produces and `applyRecipe` (recipes.ts) consumes. */
export interface LoadedRecipe {
  id: string;
  title: string;
  version: string;
  summary: string;
  /** One-line user-outcome phrasing for session offers; the manifest's `offer`, else the title. */
  offer: string;
  /** `"builtin:<name>"` or the resolved absolute directory — for receipts (+ future provenance). */
  source: string;
  /** Convention docs, ids under `conventions/`. `timestamp` is stamped at APPLY, not here. */
  docs: OkfDocument[];
  /** Optional View definitions installed with the conventions; never Kind instances. */
  pages: RecipePage[];
  /** Optional operating references installed with the definitions; never project instances. */
  references: RecipeReference[];
  /** Present only for packages opting into the strict portable definitions-only contract. */
  contentPolicy?: "definitions-only";
  /** The `type` values this recipe's conventions govern (derived at parse, for the receipt). */
  governs: string[];
  /** Non-fatal (skipped-malformed doc / reserved manifest key / etc). Never silently dropped. */
  warnings: ValidationWarning[];
}

export type RecipeErrorCode = "RECIPE_NOT_FOUND" | "RECIPE_MALFORMED" | "RECIPE_EMPTY" | "RECIPE_UNSAFE_PATH";

export interface RecipeError {
  code: RecipeErrorCode;
  message: string;
}

export type LoadResult = { ok: true; recipe: LoadedRecipe } | { ok: false; error: RecipeError };

/** A named- or path-addressed byte source. `resolve` returns `null` when `ref` is not addressed
 * to this source at all (so the next source in line gets a turn) — as opposed to `{ok:false}`,
 * which means "this ref WAS addressed to me, and loading it failed." */
export interface RecipeSource {
  readonly kind: "builtin" | "files";
  resolve(ref: string): Promise<LoadResult | null>;
}

/** Manifest (`recipe.md`) frontmatter keys reserved for a future composition surface (§D
 * non-goals: `composes:`/`seeds:`/`requires:`). Declared-but-unapplied — surfaced as a warning,
 * never silently ignored (approved §B decision 4). */
const RESERVED_MANIFEST_KEYS = ["composes", "seeds", "requires"] as const;

function nonEmptyString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PageDeclaration {
  registry: string;
  registryId: string;
  entry: string;
}

interface ReferenceDeclaration {
  path: string;
  id: string;
}

const REFERENCE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeRecipeReferencePath(value: string): boolean {
  if (!value.startsWith("references/") || !value.endsWith(".md") || /[\\%?#]/.test(value)) return false;
  const segments = value.slice("references/".length).split("/");
  return segments.every((segment) => !segment.startsWith(".") && REFERENCE_SEGMENT.test(segment));
}

function parseReferenceDeclarations(manifest: Record<string, unknown>, recipeId: string, source: string):
  | { ok: true; references: ReferenceDeclaration[] }
  | { ok: false; error: RecipeError } {
  if (manifest.references === undefined) return { ok: true, references: [] };
  if (manifest.content_policy !== "definitions-only") {
    return {
      ok: false,
      error: {
        code: "RECIPE_MALFORMED",
        message:
          `recipe '${recipeId}' at '${source}' declares references but does not declare ` +
          "'content_policy: definitions-only', which is required for portable assets",
      },
    };
  }
  if (!Array.isArray(manifest.references)) {
    return {
      ok: false,
      error: { code: "RECIPE_MALFORMED", message: `recipe '${recipeId}': 'references' must be a list` },
    };
  }

  const references: ReferenceDeclaration[] = [];
  const targets = new Set<string>();
  for (const [index, value] of manifest.references.entries()) {
    if (typeof value !== "string" || value === "") {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${recipeId}': references[${index}] must be a non-empty path`,
        },
      };
    }
    if (!isSafeRecipeReferencePath(value)) {
      return {
        ok: false,
        error: {
          code: "RECIPE_UNSAFE_PATH",
          message: `recipe '${recipeId}': Reference '${value}' must be a .md file under 'references/'`,
        },
      };
    }
    const id = conceptIdFromPath(value);
    try {
      assertSafeConceptId(id);
    } catch {
      return {
        ok: false,
        error: { code: "RECIPE_UNSAFE_PATH", message: `recipe '${recipeId}' contains an unsafe Reference path` },
      };
    }
    if (isReservedFile(value)) {
      return {
        ok: false,
        error: { code: "RECIPE_UNSAFE_PATH", message: `recipe '${recipeId}' contains a reserved filename: '${value}'` },
      };
    }
    const target = id.toLowerCase();
    if (targets.has(target)) {
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${recipeId}' declares duplicate Reference '${value}'` },
      };
    }
    targets.add(target);
    references.push({ path: value, id });
  }
  return { ok: true, references };
}

function parsePageDeclarations(manifest: Record<string, unknown>, recipeId: string, source: string):
  | { ok: true; pages: PageDeclaration[] }
  | { ok: false; error: RecipeError } {
  if (manifest.pages === undefined) return { ok: true, pages: [] };
  if (manifest.content_policy !== "definitions-only") {
    return {
      ok: false,
      error: {
        code: "RECIPE_MALFORMED",
        message:
          `recipe '${recipeId}' at '${source}' declares pages but does not declare ` +
          "'content_policy: definitions-only', which is required for portable assets",
      },
    };
  }
  if (!Array.isArray(manifest.pages)) {
    return {
      ok: false,
      error: { code: "RECIPE_MALFORMED", message: `recipe '${recipeId}': 'pages' must be a list` },
    };
  }

  const pages: PageDeclaration[] = [];
  const registries = new Set<string>();
  const entries = new Set<string>();
  for (const [index, value] of manifest.pages.entries()) {
    if (!isRecord(value)) {
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${recipeId}': pages[${index}] must be a map` },
      };
    }
    const registry = typeof value.registry === "string" ? value.registry : "";
    const entry = typeof value.entry === "string" ? value.entry : "";
    if (!registry || !entry) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${recipeId}': pages[${index}] requires non-empty 'registry' and 'entry' paths`,
        },
      };
    }
    if ((!registry.startsWith(VIEW_REGISTRY_PREFIX) && !registry.startsWith(PAGE_REGISTRY_PREFIX)) || !registry.endsWith(".md")) {
      return {
        ok: false,
        error: {
          code: "RECIPE_UNSAFE_PATH",
          message: `recipe '${recipeId}': View registry '${registry}' must be a .md file under '${VIEW_REGISTRY_PREFIX}' (or legacy '${PAGE_REGISTRY_PREFIX}')`,
        },
      };
    }
    if ((!entry.startsWith(VIEW_ENTRY_PREFIX) && !entry.startsWith(PAGE_ENTRY_PREFIX)) || !entry.endsWith(".html")) {
      return {
        ok: false,
        error: {
          code: "RECIPE_UNSAFE_PATH",
          message: `recipe '${recipeId}': View entry '${entry}' must be a .html file under '${VIEW_ENTRY_PREFIX}' (or legacy '${PAGE_ENTRY_PREFIX}')`,
        },
      };
    }
    const registryId = registry.slice(0, -3);
    if (!isAnyRegistryId(registryId) || !isAnyEntryKey(entry) || isReservedFile(registry)) {
      return {
        ok: false,
        error: { code: "RECIPE_UNSAFE_PATH", message: `recipe '${recipeId}' contains an unsafe View path` },
      };
    }
    const registryTarget = registryId.toLowerCase();
    const entryTarget = entry.toLowerCase();
    if (registries.has(registryTarget) || entries.has(entryTarget)) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${recipeId}' declares a duplicate View registry or entry at pages[${index}]`,
        },
      };
    }
    registries.add(registryTarget);
    entries.add(entryTarget);
    pages.push({ registry, registryId, entry });
  }
  return { ok: true, pages };
}

/**
 * THE one parse+validate+materialize path (approved §B decision 1). Pure — no fs, no network, no
 * awareness of where `files`/`source` came from. Both `builtinRecipeSource` and
 * `filesRecipeSource` call this, unchanged.
 */
export function parseRecipeFiles(files: RecipeFile[], source: string): LoadResult {
  const manifestFile = files.find((f) => f.path === "recipe.md");
  if (!manifestFile) {
    return {
      ok: false,
      error: { code: "RECIPE_MALFORMED", message: `recipe at '${source}' is missing its required recipe.md manifest` },
    };
  }

  const { frontmatter: manifest } = parseMarkdown(manifestFile.bytes);
  if (manifest.type !== "Recipe") {
    return {
      ok: false,
      error: {
        code: "RECIPE_MALFORMED",
        message: `recipe at '${source}': recipe.md must declare 'type: Recipe' (got '${String(manifest.type)}')`,
      },
    };
  }

  const id = nonEmptyString(manifest.id);
  const title = nonEmptyString(manifest.title);
  const version = nonEmptyString(manifest.version);
  const summary = nonEmptyString(manifest.summary);
  const missing = [
    !id && "id",
    !title && "title",
    !version && "version",
    !summary && "summary",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: "RECIPE_MALFORMED",
        message: `recipe at '${source}': recipe.md is missing required non-empty field(s): ${missing.join(", ")}`,
      },
    };
  }

  const contentPolicy = manifest.content_policy;
  if (contentPolicy !== undefined && contentPolicy !== "definitions-only") {
    return {
      ok: false,
      error: {
        code: "RECIPE_MALFORMED",
        message: `recipe '${id}' at '${source}' has unsupported content_policy '${String(contentPolicy)}'`,
      },
    };
  }
  const pageDeclarations = parsePageDeclarations(manifest, id, source);
  if (!pageDeclarations.ok) return pageDeclarations;
  const referenceDeclarations = parseReferenceDeclarations(manifest, id, source);
  if (!referenceDeclarations.ok) return referenceDeclarations;
  const declaredPageFiles = new Set(pageDeclarations.pages.flatMap((page) => [page.registry, page.entry]));
  const declaredReferenceFiles = new Set(referenceDeclarations.references.map((reference) => reference.path));

  const warnings: ValidationWarning[] = [];
  for (const key of RESERVED_MANIFEST_KEYS) {
    if (key in manifest) {
      warnings.push({
        code: "RECIPE_MANIFEST_RESERVED_KEY",
        message: `recipe '${id}' declares '${key}:' in recipe.md, which this version does not apply (reserved for a future composition surface) — it is declared but NOT applied, not silently ignored.`,
        field: key,
        severity: "warning",
      });
    }
  }

  const docs: OkfDocument[] = [];
  const governsSeen = new Map<string, string>(); // governs -> the doc id that first declared it
  const governsList: string[] = [];

  for (const file of files) {
    if (file.path === "recipe.md") continue;

    if (!file.path.startsWith(CONVENTIONS_PREFIX)) {
      if (declaredPageFiles.has(file.path)) continue;
      if (declaredReferenceFiles.has(file.path)) continue;
      if (contentPolicy === "definitions-only") {
        return {
          ok: false,
          error: {
            code: "RECIPE_UNSAFE_PATH",
            message: `recipe '${id}' violates definitions-only policy with undeclared file '${file.path}'`,
          },
        };
      }
      // Backward compatibility: the historical filesystem source never acquired files outside
      // recipe.md + conventions/, so legacy packages may continue carrying ignored README/assets.
      continue;
    }

    const conceptId = conceptIdFromPath(file.path);
    try {
      assertSafeConceptId(conceptId);
    } catch {
      return {
        ok: false,
        error: { code: "RECIPE_UNSAFE_PATH", message: `recipe '${id}' contains an unsafe path '${file.path}'` },
      };
    }
    if (isReservedFile(file.path)) {
      return {
        ok: false,
        error: { code: "RECIPE_UNSAFE_PATH", message: `recipe '${id}' contains a reserved filename: '${file.path}'` },
      };
    }

    const { frontmatter, body } = parseMarkdown(file.bytes);
    const doc: OkfDocument = { id: conceptId, frontmatter, body };

    // Mirror loadKinds' own skip-with-warning semantics (a doc that is not `type: Convention`, or
    // has an empty `governs`, is not a kind declaration at all) WITHOUT seeding a backend.
    if (frontmatter.type !== CONVENTION_TYPE) {
      if (contentPolicy === "definitions-only") {
        return {
          ok: false,
          error: {
            code: "RECIPE_MALFORMED",
            message: `recipe '${id}': '${doc.id}' must declare 'type: ${CONVENTION_TYPE}'`,
          },
        };
      }
      warnings.push({
        code: "KIND_CONVENTION_MALFORMED",
        message: `recipe '${id}': skipped '${doc.id}' (type '${String(frontmatter.type)}', expected '${CONVENTION_TYPE}').`,
        field: doc.id,
        severity: "warning",
      });
      continue;
    }
    const governs = nonEmptyString(frontmatter.governs);
    if (!governs) {
      if (contentPolicy === "definitions-only") {
        return {
          ok: false,
          error: { code: "RECIPE_MALFORMED", message: `recipe '${id}': '${doc.id}' needs a non-empty 'governs'` },
        };
      }
      warnings.push({
        code: "KIND_CONVENTION_MALFORMED",
        message: `recipe '${id}': skipped '${doc.id}' (missing or empty 'governs' field).`,
        field: doc.id,
        severity: "warning",
      });
      continue;
    }

    if (contentPolicy === "definitions-only") {
      const parsed = parseConventionDoc(doc);
      if (!parsed.ok || parsed.warnings.length > 0) {
        const reasons = [!parsed.ok ? parsed.reason : "", ...parsed.warnings.map((warning) => warning.message)].filter(
          Boolean,
        );
        return {
          ok: false,
          error: {
            code: "RECIPE_MALFORMED",
            message: `recipe '${id}': invalid Convention '${doc.id}': ${reasons.join("; ")}`,
          },
        };
      }
    }

    // Self-duplicate governs WITHIN this recipe is a malformed recipe (approved §B decision 8(i)) —
    // NOT a skip-with-warning, since it means the recipe's own conventions disagree about a type
    // it declares governing twice.
    if (governsSeen.has(governs)) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${id}' declares '${governs}' twice ('${governsSeen.get(governs)}' and '${doc.id}')`,
        },
      };
    }
    governsSeen.set(governs, doc.id);
    governsList.push(governs);
    docs.push(doc);
  }

  if (docs.length === 0) {
    return {
      ok: false,
      error: { code: "RECIPE_EMPTY", message: `recipe '${id}' at '${source}' declares zero valid convention docs` },
    };
  }

  const pages: RecipePage[] = [];
  for (const declaration of pageDeclarations.pages) {
    const registryFile = files.find((file) => file.path === declaration.registry);
    const entryFile = files.find((file) => file.path === declaration.entry);
    if (!registryFile || !entryFile) {
      const missingPath = !registryFile ? declaration.registry : declaration.entry;
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${id}' is missing declared View file '${missingPath}'` },
      };
    }
    if (entryFile.bytes.trim() === "") {
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${id}': View entry '${declaration.entry}' is empty` },
      };
    }
    const { frontmatter, body } = parseMarkdown(registryFile.bytes);
    if (!isPageTypeName(frontmatter.type)) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${id}': '${declaration.registry}' must declare 'type: View' (the legacy 'type: Page' no longer registers)`,
        },
      };
    }
    if (!nonEmptyString(frontmatter.title)) {
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${id}': '${declaration.registry}' needs a title` },
      };
    }
    const access = declaredAccessValue(frontmatter);
    if (access !== "none" && access !== "bundle-read" && access !== "bundle-propose") {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${id}': '${declaration.registry}' needs access: none, access: bundle-read, or access: bundle-propose (the legacy 'bridge:' spelling is no longer read)`,
        },
      };
    }
    if (frontmatter.entry !== declaration.entry) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message:
            `recipe '${id}': '${declaration.registry}' entry '${String(frontmatter.entry)}' ` +
            `does not match manifest entry '${declaration.entry}'`,
        },
      };
    }
    pages.push({
      registry: { id: declaration.registryId, frontmatter, body },
      entry: declaration.entry,
      html: entryFile.bytes,
    });
  }

  const references: RecipeReference[] = [];
  for (const declaration of referenceDeclarations.references) {
    const referenceFile = files.find((file) => file.path === declaration.path);
    if (!referenceFile) {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${id}' is missing declared Reference file '${declaration.path}'`,
        },
      };
    }
    const { frontmatter, body } = parseMarkdown(referenceFile.bytes);
    if (frontmatter.type !== "Reference") {
      return {
        ok: false,
        error: {
          code: "RECIPE_MALFORMED",
          message: `recipe '${id}': '${declaration.path}' must declare 'type: Reference'`,
        },
      };
    }
    if (!nonEmptyString(frontmatter.title)) {
      return {
        ok: false,
        error: { code: "RECIPE_MALFORMED", message: `recipe '${id}': '${declaration.path}' needs a title` },
      };
    }
    references.push({ doc: { id: declaration.id, frontmatter, body } });
  }

  const recipe: LoadedRecipe = {
    id,
    title,
    version,
    summary,
    offer: nonEmptyString(manifest.offer) || title,
    source,
    docs,
    pages,
    references,
    governs: governsList,
    warnings,
  };
  if (contentPolicy === "definitions-only") recipe.contentPolicy = contentPolicy;
  return { ok: true, recipe };
}
