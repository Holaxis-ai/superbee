/**
 * `@superbee/core/recipe-sources`: the one recipe source contract every host shares.
 *
 * A `RecipeSource` acquires recipe files and hands them to `parseRecipeFiles`; `resolveRecipe` asks
 * an ordered list of sources and the first that addresses a reference answers. Hosts compose the
 * list: built-ins live in `@superbee/core/builtin-recipes`, and sources that need a filesystem or a
 * network stay in their host.
 *
 * A published index (`recipe-index/v1`) lists recipes, each pinned by Core's `recipeSourceDigest`,
 * and offerings that name an ordered set of those recipes. This module parses the index and verifies
 * every recipe against its pin through a reader the host supplies. It performs no I/O of its own.
 */
import { recipeSourceDigest } from "./recipe-lifecycle/stamp.js";
import {
  parseRecipeFiles,
  type LoadedRecipe,
  type LoadResult,
  type RecipeError,
  type RecipeFile,
  type RecipeIndexErrorCode,
} from "./recipes.js";

export type { RecipeIndexErrorCode } from "./recipes.js";

export type RecipeSourceKind = "builtin" | "files" | "index";

/** A source returns null when it does not address a reference, or a failed result when loading fails. */
export interface RecipeSource {
  readonly kind: RecipeSourceKind;
  resolve(ref: string): Promise<LoadResult | null>;
}

export interface ResolveRecipeOptions {
  /** The refusal message when no source addresses the reference. */
  notFoundMessage?: (ref: string) => string;
}

/** Asks each source in order; the first non-null answer wins, success or refusal. */
export async function resolveRecipe(
  ref: string,
  sources: readonly RecipeSource[],
  options: ResolveRecipeOptions = {},
): Promise<LoadResult> {
  for (const source of sources) {
    const result = await source.resolve(ref);
    if (result) return result;
  }
  return {
    ok: false,
    error: { code: "RECIPE_NOT_FOUND", message: options.notFoundMessage?.(ref) ?? `unknown recipe '${ref}'` },
  };
}

// ── Published index ───────────────────────────────────────────────────────────────────────────

export const RECIPE_INDEX_FORMAT = "recipe-index/v1" as const;

/** Count bounds keep a hostile index from asking a reader for unbounded work. */
export const RECIPE_INDEX_LIMITS = Object.freeze({
  recipes: 256,
  offerings: 256,
  filesPerRecipe: 256,
  recipesPerOffering: 32,
});

export interface RecipeIndexRecipe {
  readonly id: string;
  readonly version: string;
  /** Core's `recipeSourceDigest` of the parsed recipe; the same value recipe stamps record. */
  readonly source_digest: string;
  /** Recipe root relative to the index location; absent means the index's own directory. */
  readonly root?: string;
  /** Recipe-relative file paths. A reader fetches exactly these and nothing else. */
  readonly files: readonly string[];
}

export interface RecipeIndexOffering {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Ordered recipe ids, each present in the index's `recipes`. */
  readonly recipes: readonly string[];
}

export interface RecipeIndex {
  readonly format: typeof RECIPE_INDEX_FORMAT;
  /** Stable id of the publishing source. */
  readonly source: string;
  readonly title?: string;
  readonly recipes: readonly RecipeIndexRecipe[];
  readonly offerings: readonly RecipeIndexOffering[];
}

export interface RecipeIndexError {
  code: RecipeIndexErrorCode | "RECIPE_NOT_FOUND";
  message: string;
}

export type RecipeIndexParseResult = { ok: true; index: RecipeIndex } | { ok: false; error: RecipeIndexError };

/**
 * Reads one file named by the index, relative to the index location, as UTF-8 text. The host owns
 * transport, size and time bounds; a throw becomes `RECIPE_INDEX_READ_FAILED`.
 */
export type RecipeIndexReader = (path: string) => Promise<string>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

class IndexRefusal extends Error {
  readonly code: RecipeIndexErrorCode;
  constructor(code: RecipeIndexErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function refuse(code: RecipeIndexErrorCode, message: string): never {
  throw new IndexRefusal(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], where: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) refuse("RECIPE_INDEX_MALFORMED", `${where} is missing '${key}'`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) refuse("RECIPE_INDEX_MALFORMED", `${where} has unknown key '${key}'`);
  }
}

function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    refuse("RECIPE_INDEX_MALFORMED", `${where} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

function id(value: unknown, where: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    refuse("RECIPE_INDEX_MALFORMED", `${where} must match ${ID.source}`);
  }
  return value;
}

function list(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) refuse("RECIPE_INDEX_MALFORMED", `${where} must be an array`);
  if (value.length > max) refuse("RECIPE_INDEX_MALFORMED", `${where} lists more than ${max} entries`);
  for (let i = 0; i < value.length; i += 1) if (!Object.hasOwn(value, i)) refuse("RECIPE_INDEX_MALFORMED", `${where} is sparse`);
  return value;
}

/** A relative POSIX path of plain segments: no absolute form, `..`, `.`, backslash, or dot entry. */
function relativePath(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") refuse("RECIPE_INDEX_PATH_INVALID", `${where} must be a nonempty relative path`);
  if (value.includes("\\")) refuse("RECIPE_INDEX_PATH_INVALID", `${where} '${value}' contains a backslash`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) refuse("RECIPE_INDEX_PATH_INVALID", `${where} '${value}' is absolute`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) refuse("RECIPE_INDEX_PATH_INVALID", `${where} '${value}' escapes its root with '..'`);
  if (segments.length > 16 || !segments.every((segment) => SEGMENT.test(segment))) {
    refuse("RECIPE_INDEX_PATH_INVALID", `${where} '${value}' must be plain segments of letters, digits, '.', '_' or '-', none starting with '.'`);
  }
  return value;
}

function parseRecipeEntry(value: unknown, where: string): RecipeIndexRecipe {
  if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", `${where} must be an object`);
  exactKeys(value, ["id", "version", "source_digest", "files"], ["root"], where);
  const entryId = id(value.id, `${where}.id`);
  const version = text(value.version, `${where}.version`, 64);
  if (typeof value.source_digest !== "string" || !DIGEST.test(value.source_digest)) {
    refuse("RECIPE_INDEX_MALFORMED", `${where}.source_digest must be 'sha256:' and 64 lowercase hex digits`);
  }
  const root = value.root === undefined ? undefined : relativePath(value.root, `${where}.root`);
  const files = list(value.files, `${where}.files`, RECIPE_INDEX_LIMITS.filesPerRecipe).map((file, i) =>
    relativePath(file, `${where}.files[${i}]`),
  );
  if (files.length === 0) refuse("RECIPE_INDEX_MALFORMED", `${where}.files must list at least one file`);
  // Case-folded, so two entries can never land on one file of a case-insensitive host.
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.toLowerCase();
    if (seen.has(key)) refuse("RECIPE_INDEX_DUPLICATE", `${where}.files lists '${file}' more than once`);
    seen.add(key);
  }
  return Object.freeze({
    id: entryId,
    version,
    source_digest: value.source_digest,
    ...(root === undefined ? {} : { root }),
    files: Object.freeze(files),
  });
}

function parseOffering(value: unknown, where: string, recipeIds: ReadonlySet<string>): RecipeIndexOffering {
  if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", `${where} must be an object`);
  exactKeys(value, ["id", "title", "summary", "recipes"], [], where);
  const offeringId = id(value.id, `${where}.id`);
  const title = text(value.title, `${where}.title`, 200);
  const summary = text(value.summary, `${where}.summary`, 1000);
  const members = list(value.recipes, `${where}.recipes`, RECIPE_INDEX_LIMITS.recipesPerOffering).map((member, i) =>
    id(member, `${where}.recipes[${i}]`),
  );
  if (members.length === 0) refuse("RECIPE_INDEX_OFFERING_INVALID", `offering '${offeringId}' names no recipes`);
  const seen = new Set<string>();
  for (const member of members) {
    if (!recipeIds.has(member)) refuse("RECIPE_INDEX_OFFERING_INVALID", `offering '${offeringId}' names recipe '${member}', which the index does not list`);
    if (seen.has(member)) refuse("RECIPE_INDEX_OFFERING_INVALID", `offering '${offeringId}' names recipe '${member}' more than once`);
    seen.add(member);
  }
  return Object.freeze({ id: offeringId, title, summary, recipes: Object.freeze(members) });
}

/**
 * Strict parse of a `recipe-index/v1` document. Accepts the JSON text or an already parsed value;
 * unknown keys, unknown formats and unsafe paths refuse rather than being ignored.
 */
export function parseRecipeIndex(input: unknown): RecipeIndexParseResult {
  try {
    let value = input;
    if (typeof input === "string") {
      try {
        value = JSON.parse(input);
      } catch {
        refuse("RECIPE_INDEX_MALFORMED", "the recipe index is not valid JSON");
      }
    }
    if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", "the recipe index must be a JSON object");
    if (value.format !== RECIPE_INDEX_FORMAT) {
      refuse("RECIPE_INDEX_FORMAT_UNSUPPORTED", `the recipe index format must be '${RECIPE_INDEX_FORMAT}'`);
    }
    exactKeys(value, ["format", "source", "recipes", "offerings"], ["title"], "the recipe index");
    const source = id(value.source, "source");
    const title = value.title === undefined ? undefined : text(value.title, "title", 200);
    const recipes = list(value.recipes, "recipes", RECIPE_INDEX_LIMITS.recipes).map((entry, i) =>
      parseRecipeEntry(entry, `recipes[${i}]`),
    );
    const recipeIds = new Set<string>();
    for (const entry of recipes) {
      if (recipeIds.has(entry.id)) refuse("RECIPE_INDEX_DUPLICATE", `recipe '${entry.id}' is listed more than once`);
      recipeIds.add(entry.id);
    }
    const offerings = list(value.offerings, "offerings", RECIPE_INDEX_LIMITS.offerings).map((entry, i) =>
      parseOffering(entry, `offerings[${i}]`, recipeIds),
    );
    const offeringIds = new Set<string>();
    for (const offering of offerings) {
      if (offeringIds.has(offering.id)) refuse("RECIPE_INDEX_DUPLICATE", `offering '${offering.id}' is listed more than once`);
      offeringIds.add(offering.id);
    }
    return {
      ok: true,
      index: Object.freeze({
        format: RECIPE_INDEX_FORMAT,
        source,
        ...(title === undefined ? {} : { title }),
        recipes: Object.freeze(recipes),
        offerings: Object.freeze(offerings),
      }),
    };
  } catch (error) {
    if (error instanceof IndexRefusal) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}

/** A recipe whose parsed content matched its pinned digest. */
export interface VerifiedIndexRecipe {
  recipe: LoadedRecipe;
  source_digest: string;
}

export type IndexRecipeResult = { ok: true; verified: VerifiedIndexRecipe } | { ok: false; error: RecipeError };

/**
 * Reads exactly the entry's listed files, parses them and compares Core's source digest with the
 * pin. Any difference refuses before a recipe is returned; there is no warning-only mode.
 */
export async function resolveIndexRecipe(index: RecipeIndex, recipeId: string, read: RecipeIndexReader): Promise<IndexRecipeResult> {
  const entry = index.recipes.find((candidate) => candidate.id === recipeId);
  if (!entry) {
    return { ok: false, error: { code: "RECIPE_NOT_FOUND", message: `index '${index.source}' lists no recipe '${recipeId}'` } };
  }
  const files: RecipeFile[] = [];
  for (const file of entry.files) {
    const location = entry.root === undefined ? file : `${entry.root}/${file}`;
    let bytes: string;
    try {
      bytes = await read(location);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: "RECIPE_INDEX_READ_FAILED", message: `could not read '${location}' for recipe '${entry.id}' from index '${index.source}': ${reason}` },
      };
    }
    if (typeof bytes !== "string") {
      return { ok: false, error: { code: "RECIPE_INDEX_READ_FAILED", message: `the reader returned no text for '${location}'` } };
    }
    files.push({ path: file, bytes });
  }
  const mismatch = (detail: string): IndexRecipeResult => ({
    ok: false,
    error: {
      code: "RECIPE_INDEX_DIGEST_MISMATCH",
      message: `recipe '${entry.id}' from index '${index.source}' does not match its pinned source_digest: ${detail}`,
    },
  });
  let parsed: LoadResult;
  try {
    parsed = parseRecipeFiles(files, `index:${index.source}`, { okfVersion: "0.2" });
  } catch (error) {
    // The pin was taken from a recipe that parsed, so bytes that no longer parse are not those bytes.
    return mismatch(`its files no longer parse (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed.ok) return mismatch(`its files no longer parse (${parsed.error.code}: ${parsed.error.message})`);
  const recipe = parsed.recipe;
  if (recipe.id !== entry.id || recipe.version !== entry.version) {
    return mismatch(`the files declare '${recipe.id}' version '${recipe.version}', the index pins '${entry.id}' version '${entry.version}'`);
  }
  const actual = recipeSourceDigest(recipe);
  if (actual !== entry.source_digest) return mismatch(`expected ${entry.source_digest}, computed ${actual}`);
  return { ok: true, verified: { recipe, source_digest: actual } };
}

/** A `RecipeSource` over one parsed index: it addresses exactly the recipe ids the index lists. */
export function createIndexRecipeSource(index: RecipeIndex, read: RecipeIndexReader): RecipeSource {
  return {
    kind: "index",
    async resolve(ref) {
      if (!index.recipes.some((entry) => entry.id === ref)) return null;
      const result = await resolveIndexRecipe(index, ref, read);
      return result.ok ? { ok: true, recipe: result.verified.recipe } : result;
    },
  };
}

export type OfferingResult =
  | { ok: true; offering: RecipeIndexOffering; recipes: VerifiedIndexRecipe[] }
  | { ok: false; error: RecipeError; recipe?: string };

/**
 * Resolves and verifies every member of an offering, in order. One failed member fails the whole
 * offering and nothing is returned, so a caller can verify the full set before writing anything.
 */
export async function resolveOffering(index: RecipeIndex, offeringId: string, read: RecipeIndexReader): Promise<OfferingResult> {
  const offering = index.offerings.find((candidate) => candidate.id === offeringId);
  if (!offering) {
    return { ok: false, error: { code: "RECIPE_NOT_FOUND", message: `index '${index.source}' lists no offering '${offeringId}'` } };
  }
  const recipes: VerifiedIndexRecipe[] = [];
  for (const member of offering.recipes) {
    const result = await resolveIndexRecipe(index, member, read);
    if (!result.ok) return { ok: false, error: result.error, recipe: member };
    recipes.push(result.verified);
  }
  return { ok: true, offering, recipes };
}
