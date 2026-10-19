/**
 * The recipe stamp reader as it shipped at b0ab4fcf, before Connectors: `readRecipeStamp`,
 * `recipeStampState`, `conventionStampState` and `installedRecipes`, copied verbatim (types and
 * helpers included). It stands in for a release that predates the optional `connectors` stamp key,
 * so a test can show that such a release reads a connector-carrying recipe's stamps as installed.
 * Never edit it to follow the live reader.
 */
import { CONVENTION_TYPE } from "../../src/kinds.js";
import { DEFINITION_DIGEST_RULES, definitionDigest } from "../../src/recipe-lifecycle/stamp.js";
import type { LoadedRecipe } from "../../src/recipes.js";
import type { ConceptId, OkfDocument } from "../../src/types.js";

const RECIPE_STAMP_KEY = "x_recipe";

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

/** Code-unit order: the same on every platform and locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** How the stamp on `doc` (null: no convention) relates to the recipe `identity` describes. */
export function recipeStampState(doc: Pick<OkfDocument, "frontmatter"> | null, identity: RecipeStampIdentity): RecipeStampState {
  const stamp = doc === null ? null : readRecipeStamp(doc);
  if (stamp === null) return "missing";
  if (stamp.id !== identity.id) return "foreign";
  return stamp.version === identity.version && stamp.of === identity.of && stamp.source_digest === identity.source_digest
    ? "current"
    : "stale";
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
