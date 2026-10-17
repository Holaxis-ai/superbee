// Recipe install stamps. Every convention a recipe installs or evolves carries one `x_recipe`
// record, written in the same compare-and-swap write as the convention, so the stamp exists
// exactly when the convention does. A stamp holds only deterministic facts: two clones that apply
// the same evolve write identical stamps. The read side derives each recipe's state from the
// stamps alone, without the recipe source. Storage-neutral: no Node globals or builtins.
import { normalizeDocumentBodyForStorage } from "../frontmatter.js";
import { CONVENTION_TYPE } from "../kinds.js";
import type { LoadedRecipe } from "../recipes.js";
import type { ConceptId, OkfDocument } from "../types.js";
import { sha256Hex } from "../versioning.js";

/** The frontmatter key that carries a convention's recipe stamp. */
export const RECIPE_STAMP_KEY = "x_recipe";

/** The version of the digest rules this release writes and reads. */
export const DEFINITION_DIGEST_RULES = 1;

/** One convention's record of the recipe that last wrote it. */
export interface RecipeStamp {
  id: string;
  version: string;
  /** How many conventions the recipe declares. */
  of: number;
  /** {@link recipeSourceDigest} of the recipe that wrote the convention. */
  source_digest: string;
  /** {@link definitionDigest} of the convention as that recipe wrote it. */
  definition: string;
  /** The rules version that produced `definition`. */
  digest_rules: number;
}

/**
 * How an existing convention's stamp relates to a recipe: `current` (this recipe's id, version,
 * declared count and source digest), `stale` (this recipe's id, anything else different),
 * `foreign` (another recipe's id) or `missing` (no well-formed stamp, or no convention).
 */
export type RecipeStampState = "current" | "stale" | "foreign" | "missing";

/** One stamped convention: unchanged since its recipe wrote it, changed, or unreadable rules. */
export type ConventionStampState = "current" | "diverged" | "unknown";

/** One recipe's state across the conventions that carry its stamp. */
export type RecipeInstallState = "installed" | "partial" | "diverged" | "unknown";

export interface InstalledRecipeRow {
  id: string;
  state: RecipeInstallState;
  version: string | null;
  source_digest: string | null;
  /** How many conventions carry this recipe's stamp. */
  conventions: number;
  of: number | null;
  convention_ids: ConceptId[];
  records?: Array<{ version: string; source_digest: string; conventions: number }>;
  missing?: number;
  missing_ids?: ConceptId[];
  diverged?: ConceptId[];
  unknown_rules?: ConceptId[];
}

/** The recipe-level facts every stamp a recipe writes shares; `definition` is per convention. */
export interface RecipeStampIdentity {
  id: string;
  version: string;
  of: number;
  source_digest: string;
}

/**
 * Keys rules version 1 leaves out of a definition digest: the stamp itself, the clocks and
 * attribution the write policy maintains, the hosted managed fields, and bundle-local `order`.
 */
const DIGEST_STRIPPED_KEYS: readonly string[] = [
  RECIPE_STAMP_KEY,
  "timestamp",
  "actor",
  "generated",
  "verified",
  "superbee_updated_by",
  "okf_version",
  "order",
];

const STAMP_STATE_SEVERITY: readonly RecipeStampState[] = ["current", "stale", "foreign", "missing"];

function lf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** Code-unit order: the same on every platform and locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * JSON with object keys sorted at every depth, `Date` values as ISO strings and `undefined`
 * members omitted, so equal values hash equally whatever their key order or YAML spelling.
 */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(byCodeUnit)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * The definitions-digest canon, for core's other definitions digest (the Connector pin). Named apart
 * from `site-capabilities`' canonical JSON, whose semantics differ; the subpath entry does not
 * re-export it.
 */
export { canonicalJson as definitionCanonicalJson };

function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/**
 * Digest of a recipe's parsed content, taken before edition materialization: its id, version,
 * conventions, View pairs and References, each sorted by id, bodies with CRLF read as LF. Equal
 * across editions, independent of how the recipe was acquired, and blind to README files.
 */
export function recipeSourceDigest(recipe: LoadedRecipe): string {
  const docs = [...recipe.docs]
    .sort((a, b) => byCodeUnit(a.id, b.id))
    .map((doc) => [doc.id, doc.frontmatter, lf(doc.body)]);
  const pages = [...recipe.pages]
    .sort((a, b) => byCodeUnit(a.registry.id, b.registry.id))
    .map((page) => [page.registry.id, page.registry.frontmatter, lf(page.registry.body), page.entry, lf(page.html)]);
  const references = [...recipe.references]
    .sort((a, b) => byCodeUnit(a.doc.id, b.doc.id))
    .map((reference) => [reference.doc.id, reference.doc.frontmatter, lf(reference.doc.body)]);
  return digest({ id: recipe.id, version: recipe.version, docs, pages, references });
}

/**
 * Digest of a convention as written, rules version 1: its frontmatter without the stripped keys
 * and its body with CRLF read as LF and the storage newline applied. The digest of a candidate
 * before the write equals the digest of the document read back from any backend.
 */
export function definitionDigest(doc: Pick<OkfDocument, "frontmatter" | "body">): string {
  const frontmatter: Record<string, unknown> = { ...doc.frontmatter };
  for (const key of DIGEST_STRIPPED_KEYS) delete frontmatter[key];
  return digest({ frontmatter, body: normalizeDocumentBodyForStorage(lf(doc.body ?? "")) });
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The convention's stamp, or null unless it is a mapping whose every field has its type. */
export function readRecipeStamp(doc: Pick<OkfDocument, "frontmatter">): RecipeStamp | null {
  const value = doc.frontmatter[RECIPE_STAMP_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const stamp = value as Record<string, unknown>;
  if (
    typeof stamp.id !== "string" || stamp.id === ""
    || typeof stamp.version !== "string"
    || !nonNegativeInteger(stamp.of)
    || typeof stamp.source_digest !== "string"
    || typeof stamp.definition !== "string"
    || !nonNegativeInteger(stamp.digest_rules) || stamp.digest_rules === 0
  ) return null;
  return {
    id: stamp.id,
    version: stamp.version,
    of: stamp.of,
    source_digest: stamp.source_digest,
    definition: stamp.definition,
    digest_rules: stamp.digest_rules,
  };
}

/** The recipe-level stamp facts for `recipe`; `materialized` supplies the declared count. */
export function recipeStampIdentity(recipe: LoadedRecipe, materialized: LoadedRecipe): RecipeStampIdentity {
  return {
    id: recipe.id,
    version: recipe.version,
    of: materialized.docs.length,
    source_digest: recipeSourceDigest(recipe),
  };
}

/** `doc` with its stamp replaced by this recipe's, whose `definition` is the digest of `doc`. */
export function withRecipeStamp<T extends Pick<OkfDocument, "frontmatter" | "body">>(doc: T, identity: RecipeStampIdentity): T {
  const { [RECIPE_STAMP_KEY]: _previous, ...frontmatter } = doc.frontmatter;
  const stamp: RecipeStamp = {
    id: identity.id,
    version: identity.version,
    of: identity.of,
    source_digest: identity.source_digest,
    definition: definitionDigest({ frontmatter: frontmatter as OkfDocument["frontmatter"], body: doc.body }),
    digest_rules: DEFINITION_DIGEST_RULES,
  };
  return { ...doc, frontmatter: { ...frontmatter, [RECIPE_STAMP_KEY]: stamp } };
}

/** How the stamp on `doc` (null: no convention) relates to the recipe `identity` describes. */
export function recipeStampState(doc: Pick<OkfDocument, "frontmatter"> | null, identity: RecipeStampIdentity): RecipeStampState {
  const stamp = doc === null ? null : readRecipeStamp(doc);
  if (stamp === null) return "missing";
  if (stamp.id !== identity.id) return "foreign";
  return stamp.version === identity.version && stamp.of === identity.of && stamp.source_digest === identity.source_digest
    ? "current"
    : "stale";
}

/** The worst of `states` in the order current, stale, foreign, missing; `current` when empty. */
export function worstRecipeStampState(states: Iterable<RecipeStampState>): RecipeStampState {
  let worst = 0;
  for (const state of states) worst = Math.max(worst, STAMP_STATE_SEVERITY.indexOf(state));
  return STAMP_STATE_SEVERITY[worst]!;
}

/** One stamped convention's state: rules this release reads, and whether its digest still matches. */
export function conventionStampState(doc: Pick<OkfDocument, "frontmatter" | "body">): ConventionStampState {
  const stamp = readRecipeStamp(doc);
  if (stamp === null || stamp.digest_rules !== DEFINITION_DIGEST_RULES) return "unknown";
  return definitionDigest(doc) === stamp.definition ? "current" : "diverged";
}

/** A convention that declares nothing a recipe would own: what `kind dismiss` writes. */
function declarationFree(doc: OkfDocument): boolean {
  return !["fields", "sections", "links", "expects_inbound"].some((key) => Object.hasOwn(doc.frontmatter, key));
}

/**
 * Each recipe's install state, derived from the stamps on `conventions` (documents of any other
 * type are ignored), and the conventions no recipe stamped. `known` recipes (their declared ids
 * are visible to the caller) also report a declared id that does not carry their stamp, and get
 * a row when an unstamped convention that declares something sits at one of their ids: a bundle
 * written before stamps. A declined Kind (a declaration-free record) or another recipe's stamp
 * at their ids alone is no evidence they were installed.
 *
 * States, the first match winning: `unknown` when no convention carries the recipe's stamp;
 * `partial` when the stamps record more than one version or source digest, disagree on the
 * declared count, fall short of it, or (known recipes) a declared id is present without this
 * recipe's stamp; `diverged` when a stamped convention changed since the recipe wrote it;
 * `unknown` when a stamp uses digest rules this release does not read; otherwise `installed`.
 */
export function installedRecipes(
  conventions: Iterable<OkfDocument>,
  known: readonly LoadedRecipe[] = [],
): { rows: InstalledRecipeRow[]; unstamped: ConceptId[] } {
  const present = new Map<ConceptId, OkfDocument>();
  const stampedByRecipe = new Map<string, Array<{ doc: OkfDocument; stamp: RecipeStamp }>>();
  const unstamped: ConceptId[] = [];
  for (const doc of conventions) {
    if (doc.frontmatter.type !== CONVENTION_TYPE) continue;
    present.set(doc.id, doc);
    const stamp = readRecipeStamp(doc);
    if (stamp === null) {
      if (!declarationFree(doc)) unstamped.push(doc.id);
      continue;
    }
    const group = stampedByRecipe.get(stamp.id) ?? [];
    group.push({ doc, stamp });
    stampedByRecipe.set(stamp.id, group);
  }

  const knownById = new Map(known.map((recipe) => [recipe.id, recipe]));
  const ids = new Set(stampedByRecipe.keys());
  const unstampedIds = new Set(unstamped);
  for (const recipe of known) {
    if (recipe.docs.some((declared) => unstampedIds.has(declared.id))) ids.add(recipe.id);
  }

  const rows = [...ids].sort(byCodeUnit).map((id): InstalledRecipeRow => {
    const stamped = (stampedByRecipe.get(id) ?? []).sort((a, b) => byCodeUnit(a.doc.id, b.doc.id));
    const recipe = knownById.get(id);
    const conventionIds = stamped.map(({ doc }) => doc.id);
    const stampedIds = new Set(conventionIds);

    const records = new Map<string, { version: string; source_digest: string; conventions: number }>();
    for (const { stamp } of stamped) {
      const key = `${stamp.version}\u0000${stamp.source_digest}`;
      const record = records.get(key) ?? { version: stamp.version, source_digest: stamp.source_digest, conventions: 0 };
      record.conventions += 1;
      records.set(key, record);
    }
    const recordRows = [...records.values()].sort((a, b) =>
      byCodeUnit(a.version, b.version) || byCodeUnit(a.source_digest, b.source_digest));
    const declaredCounts = new Set(stamped.map(({ stamp }) => stamp.of));
    const of = declaredCounts.size === 1 ? [...declaredCounts][0]! : recipe ? recipe.docs.length : null;

    const diverged = stamped.filter(({ doc }) => conventionStampState(doc) === "diverged").map(({ doc }) => doc.id);
    const unknownRules = stamped.filter(({ stamp }) => stamp.digest_rules !== DEFINITION_DIGEST_RULES).map(({ doc }) => doc.id);
    const declaredIds = recipe ? recipe.docs.map((doc) => doc.id).sort(byCodeUnit) : [];
    const missingIds = declaredIds.filter((declared) => !stampedIds.has(declared));
    const presentWithoutStamp = missingIds.filter((declared) => present.has(declared));

    let state: RecipeInstallState;
    if (stamped.length === 0) state = "unknown";
    else if (
      recordRows.length > 1
      || declaredCounts.size > 1
      || stamped.length !== of
      || presentWithoutStamp.length > 0
      || (recipe !== undefined && missingIds.length > 0)
    ) state = "partial";
    else if (diverged.length > 0) state = "diverged";
    else if (unknownRules.length > 0) state = "unknown";
    else state = "installed";

    const single = state === "installed" || state === "diverged" ? recordRows[0]! : null;
    const row: InstalledRecipeRow = {
      id,
      state,
      version: single?.version ?? null,
      source_digest: single?.source_digest ?? null,
      conventions: stamped.length,
      of,
      convention_ids: conventionIds,
    };
    if (state === "partial") {
      row.records = recordRows;
      const missing = recipe ? missingIds.length : of === null ? 0 : Math.max(0, of - stamped.length);
      if (missing > 0) row.missing = missing;
      if (recipe && missingIds.length > 0) row.missing_ids = missingIds;
    }
    if (diverged.length > 0) row.diverged = diverged;
    if (unknownRules.length > 0) row.unknown_rules = unknownRules;
    return row;
  });

  return { rows, unstamped: unstamped.sort(byCodeUnit) };
}
