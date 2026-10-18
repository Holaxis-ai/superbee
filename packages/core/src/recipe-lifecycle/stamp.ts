// Recipe install stamps. Every convention and Connector a recipe installs or evolves carries one
// `x_recipe` record, written in the same compare-and-swap write as the document, so the stamp
// exists exactly when the document does. A stamp holds only deterministic facts: two clones that apply
// the same evolve write identical stamps. The read side derives each recipe's state from the
// stamps alone, without the recipe source. Storage-neutral: no Node globals or builtins.
import { CONNECTOR_TYPE, CONNECTORS_PREFIX } from "../connectors.js";
import { normalizeDocumentBodyForStorage } from "../frontmatter.js";
import { CONVENTION_TYPE } from "../kinds.js";
import type { LoadedRecipe } from "../recipes.js";
import type { ConceptId, OkfDocument } from "../types.js";
import { sha256Hex } from "../versioning.js";

/** The frontmatter key that carries a convention's recipe stamp. */
export const RECIPE_STAMP_KEY = "x_recipe";

/** The version of the digest rules this release writes and reads. */
export const DEFINITION_DIGEST_RULES = 1;

/** One convention's (or Connector's) record of the recipe that last wrote it. */
export interface RecipeStamp {
  id: string;
  version: string;
  /** How many conventions the recipe declares. */
  of: number;
  /**
   * How many Connectors the recipe declares; written only by a recipe that carries connectors, so
   * a reader that predates the key ignores it and every other stamp keeps its bytes.
   */
  connectors?: number;
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
  /** Present for a recipe that carries connectors: how many Connectors carry its stamp. */
  connectors?: number;
  /** The declared Connector count the stamps record (the stamp's `connectors`). */
  connectors_of?: number | null;
  connector_ids?: ConceptId[];
  records?: Array<{ version: string; source_digest: string; conventions: number; connectors?: number }>;
  missing?: number;
  missing_ids?: ConceptId[];
  diverged?: ConceptId[];
  unknown_rules?: ConceptId[];
}

/** The recipe-level facts every stamp a recipe writes shares; `definition` is per document. */
export interface RecipeStampIdentity {
  id: string;
  version: string;
  of: number;
  /** Present exactly when the recipe carries connectors. */
  connectors?: number;
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
 * conventions, View pairs, References and (only when it carries any) Connectors, each sorted by id,
 * bodies with CRLF read as LF. Equal across editions, independent of how the recipe was acquired,
 * and blind to README files. A recipe without connectors digests exactly as it did before
 * connectors existed, so every stamp written earlier stays current.
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
  const connectors = [...(recipe.connectors ?? [])]
    .sort((a, b) => byCodeUnit(a.doc.id, b.doc.id))
    .map((connector) => [connector.doc.id, connector.doc.frontmatter, lf(connector.doc.body)]);
  return digest({
    id: recipe.id,
    version: recipe.version,
    docs,
    pages,
    references,
    ...(connectors.length > 0 ? { connectors } : {}),
  });
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

/**
 * The document's stamp, or null unless it is a mapping whose every required field has its type.
 * The optional `connectors` count is kept when it is a non-negative integer and otherwise read as
 * absent.
 */
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
    ...(nonNegativeInteger(stamp.connectors) ? { connectors: stamp.connectors } : {}),
    source_digest: stamp.source_digest,
    definition: stamp.definition,
    digest_rules: stamp.digest_rules,
  };
}

/** The recipe-level stamp facts for `recipe`; `materialized` supplies the declared count. */
export function recipeStampIdentity(recipe: LoadedRecipe, materialized: LoadedRecipe): RecipeStampIdentity {
  const connectors = (recipe.connectors ?? []).length;
  return {
    id: recipe.id,
    version: recipe.version,
    of: materialized.docs.length,
    ...(connectors > 0 ? { connectors } : {}),
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
    ...(identity.connectors !== undefined ? { connectors: identity.connectors } : {}),
    source_digest: identity.source_digest,
    definition: definitionDigest({ frontmatter: frontmatter as OkfDocument["frontmatter"], body: doc.body }),
    digest_rules: DEFINITION_DIGEST_RULES,
  };
  return { ...doc, frontmatter: { ...frontmatter, [RECIPE_STAMP_KEY]: stamp } };
}

/**
 * How the stamp on `doc` (null: no document) relates to the recipe `identity` describes. The
 * Connector count must match too: for a recipe that carries connectors a stamp without it is
 * `stale`, and since no release writes the key for a recipe without connectors, every stamp such a
 * recipe wrote reads as it did before the key existed.
 */
export function recipeStampState(doc: Pick<OkfDocument, "frontmatter"> | null, identity: RecipeStampIdentity): RecipeStampState {
  const stamp = doc === null ? null : readRecipeStamp(doc);
  if (stamp === null) return "missing";
  if (stamp.id !== identity.id) return "foreign";
  return stamp.version === identity.version
    && stamp.of === identity.of
    && stamp.source_digest === identity.source_digest
    && stamp.connectors === identity.connectors
    ? "current"
    : "stale";
}

/** The worst of `states` in the order current, stale, foreign, missing; `current` when empty. */
export function worstRecipeStampState(states: Iterable<RecipeStampState>): RecipeStampState {
  let worst = 0;
  for (const state of states) worst = Math.max(worst, STAMP_STATE_SEVERITY.indexOf(state));
  return STAMP_STATE_SEVERITY[worst]!;
}

/** One stamped document's state: rules this release reads, and whether its digest still matches. */
export function conventionStampState(doc: Pick<OkfDocument, "frontmatter" | "body">): ConventionStampState {
  const stamp = readRecipeStamp(doc);
  if (stamp === null || stamp.digest_rules !== DEFINITION_DIGEST_RULES) return "unknown";
  return definitionDigest(doc) === stamp.definition ? "current" : "diverged";
}

/** A convention that declares nothing a recipe would own: what `kind dismiss` writes. */
function declarationFree(doc: OkfDocument): boolean {
  return !["fields", "sections", "links", "expects_inbound"].some((key) => Object.hasOwn(doc.frontmatter, key));
}

/** A Connector declaration: the type core's connector parser owns, at the one place it reads it. */
function isConnectorDoc(doc: OkfDocument): boolean {
  return doc.frontmatter.type === CONNECTOR_TYPE && doc.id.startsWith(CONNECTORS_PREFIX);
}

interface StampedDoc {
  doc: OkfDocument;
  stamp: RecipeStamp;
  connector: boolean;
}

/**
 * Each recipe's install state, derived from the stamps on `docs` (conventions, and Connector
 * documents under `connectors/`; documents of any other type are ignored), and the documents no
 * recipe stamped. `known` recipes (their declared ids are visible to the caller) also report a
 * declared id that does not carry their stamp, and get a row when an unstamped convention that
 * declares something, or an unstamped Connector, sits at one of their ids: a bundle written before
 * stamps. A declined Kind (a declaration-free record) or another recipe's stamp at their ids alone
 * is no evidence they were installed.
 *
 * States, the first match winning: `unknown` when no document carries the recipe's stamp;
 * `partial` when the stamps record more than one version or source digest, disagree on a declared
 * count, fall short of the convention or Connector count, or (known recipes) a declared id is
 * present without this recipe's stamp; `diverged` when a stamped document changed since the recipe
 * wrote it; `unknown` when a stamp uses digest rules this release does not read; otherwise
 * `installed`. A row carries the Connector keys only for a recipe whose stamps record connectors,
 * so every other row reads as it did before connectors existed.
 */
export function installedRecipes(
  docs: Iterable<OkfDocument>,
  known: readonly LoadedRecipe[] = [],
): { rows: InstalledRecipeRow[]; unstamped: ConceptId[] } {
  const present = new Map<ConceptId, OkfDocument>();
  const stampedByRecipe = new Map<string, StampedDoc[]>();
  const unstamped: ConceptId[] = [];
  for (const doc of docs) {
    const connector = isConnectorDoc(doc);
    if (doc.frontmatter.type !== CONVENTION_TYPE && !connector) continue;
    present.set(doc.id, doc);
    const stamp = readRecipeStamp(doc);
    if (stamp === null) {
      if (connector || !declarationFree(doc)) unstamped.push(doc.id);
      continue;
    }
    const group = stampedByRecipe.get(stamp.id) ?? [];
    group.push({ doc, stamp, connector });
    stampedByRecipe.set(stamp.id, group);
  }

  const knownById = new Map(known.map((recipe) => [recipe.id, recipe]));
  const declaredDocs = (recipe: LoadedRecipe): OkfDocument[] => [...recipe.docs, ...(recipe.connectors ?? []).map((connector) => connector.doc)];
  const ids = new Set(stampedByRecipe.keys());
  const unstampedIds = new Set(unstamped);
  for (const recipe of known) {
    if (declaredDocs(recipe).some((declared) => unstampedIds.has(declared.id))) ids.add(recipe.id);
  }

  const rows = [...ids].sort(byCodeUnit).map((id): InstalledRecipeRow => {
    const all = (stampedByRecipe.get(id) ?? []).sort((a, b) => byCodeUnit(a.doc.id, b.doc.id));
    const stamped = all.filter((entry) => !entry.connector);
    const stampedConnectors = all.filter((entry) => entry.connector);
    const recipe = knownById.get(id);
    const conventionIds = stamped.map(({ doc }) => doc.id);
    const stampedIds = new Set(all.map(({ doc }) => doc.id));

    const records = new Map<string, { version: string; source_digest: string; conventions: number; connectors?: number }>();
    for (const { stamp, connector } of all) {
      const key = `${stamp.version}\u0000${stamp.source_digest}`;
      const record = records.get(key) ?? { version: stamp.version, source_digest: stamp.source_digest, conventions: 0 };
      if (connector) record.connectors = (record.connectors ?? 0) + 1;
      else record.conventions += 1;
      records.set(key, record);
    }
    const recordRows = [...records.values()].sort((a, b) =>
      byCodeUnit(a.version, b.version) || byCodeUnit(a.source_digest, b.source_digest));
    const declaredCounts = new Set(all.map(({ stamp }) => stamp.of));
    const of = declaredCounts.size === 1 ? [...declaredCounts][0]! : recipe ? recipe.docs.length : null;
    // A stamp without the key records no connectors; a disagreement among stamps is partial.
    const connectorCounts = new Set(all.map(({ stamp }) => stamp.connectors));
    const declaredConnectors = recipe && (recipe.connectors ?? []).length > 0 ? recipe.connectors!.length : undefined;
    const connectorsOf = connectorCounts.size === 1
      ? [...connectorCounts][0]
      : connectorCounts.size === 0 ? declaredConnectors : declaredConnectors ?? null;
    const carriesConnectors = stampedConnectors.length > 0 || connectorsOf !== undefined;

    const diverged = all.filter(({ doc }) => conventionStampState(doc) === "diverged").map(({ doc }) => doc.id);
    const unknownRules = all.filter(({ stamp }) => stamp.digest_rules !== DEFINITION_DIGEST_RULES).map(({ doc }) => doc.id);
    const declaredIds = recipe ? declaredDocs(recipe).map((doc) => doc.id).sort(byCodeUnit) : [];
    const missingIds = declaredIds.filter((declared) => !stampedIds.has(declared));
    const presentWithoutStamp = missingIds.filter((declared) => present.has(declared));

    let state: RecipeInstallState;
    if (all.length === 0) state = "unknown";
    else if (
      recordRows.length > 1
      || declaredCounts.size > 1
      || connectorCounts.size > 1
      || stamped.length !== of
      || stampedConnectors.length !== (connectorsOf ?? 0)
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
    if (carriesConnectors) {
      row.connectors = stampedConnectors.length;
      row.connectors_of = connectorsOf ?? null;
      row.connector_ids = stampedConnectors.map(({ doc }) => doc.id);
    }
    if (state === "partial") {
      row.records = recordRows;
      const missing = recipe
        ? missingIds.length
        : (of === null ? 0 : Math.max(0, of - stamped.length))
          + (typeof connectorsOf === "number" ? Math.max(0, connectorsOf - stampedConnectors.length) : 0);
      if (missing > 0) row.missing = missing;
      if (recipe && missingIds.length > 0) row.missing_ids = missingIds;
    }
    if (diverged.length > 0) row.diverged = diverged;
    if (unknownRules.length > 0) row.unknown_rules = unknownRules;
    return row;
  });

  return { rows, unstamped: unstamped.sort(byCodeUnit) };
}
