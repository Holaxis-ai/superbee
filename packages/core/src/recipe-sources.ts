/**
 * `@superbee/core/recipe-sources`: the one recipe source contract every host shares.
 *
 * A `RecipeSource` acquires recipe files and hands them to `parseRecipeFiles`; `resolveRecipe` asks
 * an ordered list of sources and the first that addresses a reference answers. Hosts compose the
 * list: built-ins live in `@superbee/core/builtin-recipes`, and sources that need a filesystem or a
 * network stay in their host.
 *
 * A published index (`recipe-index/v1`) lists recipes, each pinned twice: `files_digest` over the
 * exact listed bytes and Core's `recipeSourceDigest` over the parsed definitions. It also lists cookbooks that name an ordered set of those recipes. This module parses the index and verifies
 * every recipe against its pin through a reader the host supplies. It performs no I/O of its own.
 */
import { recipeSourceDigest } from "./recipe-lifecycle/stamp.js";
import { sha256HexOfBytes } from "./sha256.js";
import { sha256Hex } from "./versioning.js";
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
  cookbooks: 256,
  filesPerRecipe: 256,
  recipesPerCookbook: 32,
});

export interface RecipeIndexRecipe {
  readonly id: string;
  readonly version: string;
  /** Core's `recipeSourceDigest` of the parsed recipe; the same value recipe stamps record. */
  readonly source_digest: string;
  /** `recipeFilesDigest` of the exact listed files, so presentation text and READMEs are pinned too. */
  readonly files_digest: string;
  /** Recipe root relative to the index location; absent means the index's own directory. */
  readonly root?: string;
  /** Recipe-relative file paths. A reader fetches exactly these and nothing else. */
  readonly files: readonly string[];
  readonly designation: RecipeDesignation;
  /** Who maintains the recipe, for example a GitHub org or handle. */
  readonly maintainer: string;
}

/**
 * Who stands behind an entry, as the index publisher states it: `supported` (maintained by Holaxis)
 * or `community`. Discovery metadata only. Core does not verify it and it carries no trust; the
 * digests are the only integrity guarantee.
 */
export type RecipeDesignation = "supported" | "community";

export const RECIPE_DESIGNATIONS: readonly RecipeDesignation[] = Object.freeze(["supported", "community"]);

export interface RecipeIndexCookbook {
  readonly id: string;
  readonly designation: RecipeDesignation;
  /** Who maintains the cookbook, for example a GitHub org or handle. */
  readonly maintainer: string;
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
  readonly cookbooks: readonly RecipeIndexCookbook[];
}

export interface RecipeIndexError {
  code: RecipeIndexErrorCode | "RECIPE_NOT_FOUND";
  message: string;
}

export type RecipeIndexParseResult = { ok: true; index: RecipeIndex } | { ok: false; error: RecipeIndexError };

/**
 * Reads one file named by the index, relative to the index location, as raw bytes. Readers never
 * decode: Core pins and decodes the bytes itself, so every transport yields the same result. The host
 * owns transport, size and time bounds; a throw becomes `RECIPE_INDEX_READ_FAILED`.
 */
export type RecipeIndexReader = (path: string) => Promise<Uint8Array>;

/** One file as fetched, before decoding: a recipe-relative path and its exact bytes. */
export interface RecipeIndexFileBytes {
  path: string;
  bytes: Uint8Array;
}

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
  // A trailing dot is dropped by Windows path normalization, so `a.` and `a` would alias one file.
  if (segments.length > 16 || !segments.every((segment) => SEGMENT.test(segment) && !segment.endsWith("."))) {
    refuse("RECIPE_INDEX_PATH_INVALID", `${where} '${value}' must be plain segments of letters, digits, '.', '_' or '-', none starting or ending with '.'`);
  }
  return value;
}

function parseRecipeEntry(value: unknown, where: string): RecipeIndexRecipe {
  if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", `${where} must be an object`);
  exactKeys(value, ["id", "version", "designation", "maintainer", "source_digest", "files_digest", "files"], ["root"], where);
  const entryId = id(value.id, `${where}.id`);
  const version = text(value.version, `${where}.version`, 64);
  const designation = designationOf(value.designation, where);
  const maintainer = text(value.maintainer, `${where}.maintainer`, 200);
  if (typeof value.source_digest !== "string" || !DIGEST.test(value.source_digest)) {
    refuse("RECIPE_INDEX_MALFORMED", `${where}.source_digest must be 'sha256:' and 64 lowercase hex digits`);
  }
  if (typeof value.files_digest !== "string" || !DIGEST.test(value.files_digest)) {
    refuse("RECIPE_INDEX_MALFORMED", `${where}.files_digest must be 'sha256:' and 64 lowercase hex digits`);
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
    files_digest: value.files_digest,
    ...(root === undefined ? {} : { root }),
    files: Object.freeze(files),
    designation,
    maintainer,
  });
}

function designationOf(value: unknown, where: string): RecipeDesignation {
  if (typeof value !== "string" || !(RECIPE_DESIGNATIONS as readonly string[]).includes(value)) {
    refuse("RECIPE_INDEX_MALFORMED", `${where}.designation must be one of ${RECIPE_DESIGNATIONS.join(", ")}`);
  }
  return value as RecipeDesignation;
}

function parseCookbook(value: unknown, where: string, recipes: ReadonlyMap<string, RecipeIndexRecipe>): RecipeIndexCookbook {
  if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", `${where} must be an object`);
  exactKeys(value, ["id", "title", "summary", "designation", "maintainer", "recipes"], [], where);
  const cookbookId = id(value.id, `${where}.id`);
  const designation = designationOf(value.designation, where);
  const maintainer = text(value.maintainer, `${where}.maintainer`, 200);
  const title = text(value.title, `${where}.title`, 200);
  const summary = text(value.summary, `${where}.summary`, 1000);
  const members = list(value.recipes, `${where}.recipes`, RECIPE_INDEX_LIMITS.recipesPerCookbook).map((member, i) =>
    id(member, `${where}.recipes[${i}]`),
  );
  if (members.length === 0) refuse("RECIPE_INDEX_COOKBOOK_INVALID", `cookbook '${cookbookId}' names no recipes`);
  const seen = new Set<string>();
  for (const member of members) {
    const recipe = recipes.get(member);
    if (!recipe) refuse("RECIPE_INDEX_COOKBOOK_INVALID", `cookbook '${cookbookId}' names recipe '${member}', which the index does not list`);
    if (designation === "supported" && recipe.designation !== "supported") {
      refuse("RECIPE_INDEX_COOKBOOK_INVALID", `supported cookbook '${cookbookId}' names community recipe '${member}'; a supported cookbook holds supported recipes only`);
    }
    if (seen.has(member)) refuse("RECIPE_INDEX_COOKBOOK_INVALID", `cookbook '${cookbookId}' names recipe '${member}' more than once`);
    seen.add(member);
  }
  return Object.freeze({ id: cookbookId, title, summary, designation, maintainer, recipes: Object.freeze(members) });
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Strict UTF-8, with one leading BOM dropped; null when the bytes are not UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Strict parse of a `recipe-index/v1` document. Accepts raw bytes (decoded as strict UTF-8), JSON
 * text, or an already parsed value; unknown keys, unknown formats and unsafe paths refuse rather than
 * being ignored.
 */
export function parseRecipeIndex(input: unknown): RecipeIndexParseResult {
  try {
    let value = input;
    if (input instanceof Uint8Array) {
      const decoded = decodeUtf8(input);
      if (decoded === null) refuse("RECIPE_INDEX_ENCODING_INVALID", "the recipe index is not valid UTF-8");
      value = decoded;
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        refuse("RECIPE_INDEX_MALFORMED", "the recipe index is not valid JSON");
      }
    }
    if (!isRecord(value)) refuse("RECIPE_INDEX_MALFORMED", "the recipe index must be a JSON object");
    if (value.format !== RECIPE_INDEX_FORMAT) {
      refuse("RECIPE_INDEX_FORMAT_UNSUPPORTED", `the recipe index format must be '${RECIPE_INDEX_FORMAT}'`);
    }
    exactKeys(value, ["format", "source", "recipes", "cookbooks"], ["title"], "the recipe index");
    const source = id(value.source, "source");
    const title = value.title === undefined ? undefined : text(value.title, "title", 200);
    const recipes = list(value.recipes, "recipes", RECIPE_INDEX_LIMITS.recipes).map((entry, i) =>
      parseRecipeEntry(entry, `recipes[${i}]`),
    );
    const recipeIds = new Map<string, RecipeIndexRecipe>();
    for (const entry of recipes) {
      if (recipeIds.has(entry.id)) refuse("RECIPE_INDEX_DUPLICATE", `recipe '${entry.id}' is listed more than once`);
      recipeIds.set(entry.id, entry);
    }
    const cookbooks = list(value.cookbooks, "cookbooks", RECIPE_INDEX_LIMITS.cookbooks).map((entry, i) =>
      parseCookbook(entry, `cookbooks[${i}]`, recipeIds),
    );
    const cookbookIds = new Set<string>();
    for (const cookbook of cookbooks) {
      if (cookbookIds.has(cookbook.id)) refuse("RECIPE_INDEX_DUPLICATE", `cookbook '${cookbook.id}' is listed more than once`);
      cookbookIds.add(cookbook.id);
    }
    return {
      ok: true,
      index: Object.freeze({
        format: RECIPE_INDEX_FORMAT,
        source,
        ...(title === undefined ? {} : { title }),
        recipes: Object.freeze(recipes),
        cookbooks: Object.freeze(cookbooks),
      }),
    };
  } catch (error) {
    if (error instanceof IndexRefusal) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}

/**
 * Byte digest of a recipe's files. Each file becomes a row `{digest, path}`, where `digest` is
 * `sha256:` and the hex SHA-256 of its exact bytes (the row shape the CLI reports for source plugin
 * files). Rows are sorted by path in code-unit order; the digest is `sha256:` and the hex SHA-256 of
 * the UTF-8 JSON array of rows with keys in that order. JSON string quoting delimits every path, and
 * each file is fixed-length hashed first, so no two file sets share an encoding.
 */
export function recipeFilesDigest(files: readonly RecipeIndexFileBytes[]): string {
  const rows = files
    .map((file) => ({ digest: `sha256:${sha256HexOfBytes(file.bytes)}`, path: file.path }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${sha256Hex(JSON.stringify(rows))}`;
}

/** A recipe whose bytes and parsed content matched both pins. */
export interface VerifiedIndexRecipe {
  recipe: LoadedRecipe;
  source_digest: string;
  /** The index's statement about the recipe, carried for display; never verified. */
  designation: RecipeDesignation;
  maintainer: string;
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
  const raw: RecipeIndexFileBytes[] = [];
  for (const file of entry.files) {
    const location = entry.root === undefined ? file : `${entry.root}/${file}`;
    let bytes: Uint8Array;
    try {
      bytes = await read(location);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: "RECIPE_INDEX_READ_FAILED", message: `could not read '${location}' for recipe '${entry.id}' from index '${index.source}': ${reason}` },
      };
    }
    if (!(bytes instanceof Uint8Array)) {
      return { ok: false, error: { code: "RECIPE_INDEX_READ_FAILED", message: `the reader returned no bytes for '${location}'` } };
    }
    raw.push({ path: file, bytes });
  }
  const mismatch = (digest: "files_digest" | "source_digest", detail: string): IndexRecipeResult => ({
    ok: false,
    error: {
      code: "RECIPE_INDEX_DIGEST_MISMATCH",
      message: `recipe '${entry.id}' from index '${index.source}' does not match its pinned ${digest}: ${detail}`,
      digest,
    },
  });
  // Bytes first: nothing unpinned reaches the parser.
  const filesDigest = recipeFilesDigest(raw);
  if (filesDigest !== entry.files_digest) return mismatch("files_digest", `expected ${entry.files_digest}, computed ${filesDigest}`);
  const files: RecipeFile[] = [];
  for (const file of raw) {
    const decoded = decodeUtf8(file.bytes);
    if (decoded === null) {
      return {
        ok: false,
        error: { code: "RECIPE_INDEX_ENCODING_INVALID", message: `recipe '${entry.id}' from index '${index.source}' has '${file.path}', which is not valid UTF-8` },
      };
    }
    files.push({ path: file.path, bytes: decoded });
  }
  let parsed: LoadResult;
  try {
    parsed = parseRecipeFiles(files, `index:${index.source}`, { okfVersion: "0.2" });
  } catch (error) {
    // A source_digest is only ever taken from a recipe that parsed, so pinned bytes that do not parse cannot match it.
    return mismatch("source_digest", `its files do not parse (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed.ok) return mismatch("source_digest", `its files do not parse (${parsed.error.code}: ${parsed.error.message})`);
  const recipe = parsed.recipe;
  if (recipe.id !== entry.id || recipe.version !== entry.version) {
    return mismatch("source_digest", `the files declare '${recipe.id}' version '${recipe.version}', the index pins '${entry.id}' version '${entry.version}'`);
  }
  const actual = recipeSourceDigest(recipe);
  if (actual !== entry.source_digest) return mismatch("source_digest", `expected ${entry.source_digest}, computed ${actual}`);
  return { ok: true, verified: { recipe, source_digest: actual, designation: entry.designation, maintainer: entry.maintainer } };
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

export type CookbookResult =
  | { ok: true; cookbook: RecipeIndexCookbook; recipes: VerifiedIndexRecipe[] }
  | { ok: false; error: RecipeError; recipe?: string };

/**
 * Resolves and verifies every member of a cookbook, in order. One failed member fails the whole
 * cookbook and nothing is returned, so a caller can verify the full set before writing anything. Two
 * members that install the same target are `RECIPE_INDEX_COOKBOOK_CONFLICT`.
 */
export async function resolveCookbook(index: RecipeIndex, cookbookId: string, read: RecipeIndexReader): Promise<CookbookResult> {
  const cookbook = index.cookbooks.find((candidate) => candidate.id === cookbookId);
  if (!cookbook) {
    return { ok: false, error: { code: "RECIPE_NOT_FOUND", message: `index '${index.source}' lists no cookbook '${cookbookId}'` } };
  }
  const recipes: VerifiedIndexRecipe[] = [];
  for (const member of cookbook.recipes) {
    const result = await resolveIndexRecipe(index, member, read);
    if (!result.ok) return { ok: false, error: result.error, recipe: member };
    recipes.push(result.verified);
  }
  const conflict = firstSharedTargets(recipes);
  if (conflict) {
    return {
      ok: false,
      error: {
        code: "RECIPE_INDEX_COOKBOOK_CONFLICT",
        message:
          `cookbook '${cookbook.id}' installs ${conflict.ids.map((id) => `'${id}'`).join(", ")} from both ` +
          `'${conflict.recipes[0]}' and '${conflict.recipes[1]}'; create-only installs would keep the first and never converge on the second`,
        conflict,
      },
      recipe: conflict.recipes[1],
    };
  }
  return { ok: true, cookbook, recipes };
}

/**
 * Every document id and View entry key a recipe installs. Install is create-only per target, so two
 * members writing one target cannot both land; identical bytes count too, since ownership would
 * still go to whichever member wrote first.
 */
function installTargets(recipe: LoadedRecipe): string[] {
  return [
    ...recipe.docs.map((doc) => doc.id),
    ...recipe.pages.flatMap((page) => [page.registry.id, `blob:${page.entry}`]),
    ...recipe.references.map((reference) => reference.doc.id),
    ...(recipe.connectors ?? []).map((connector) => connector.doc.id),
  ];
}

function firstSharedTargets(recipes: readonly VerifiedIndexRecipe[]): { recipes: [string, string]; ids: string[] } | null {
  const owners = new Map<string, string>();
  for (const { recipe } of recipes) {
    const targets = [...new Set(installTargets(recipe))];
    const clash = targets.filter((target) => owners.has(target));
    if (clash.length > 0) {
      const first = owners.get(clash[0]!)!;
      return { recipes: [first, recipe.id], ids: clash.filter((target) => owners.get(target) === first).sort() };
    }
    for (const target of targets) owners.set(target, recipe.id);
  }
  return null;
}
