// Recipe installation: create-only, expect-absent CAS per artifact through the shared document
// mutation boundary, so a built-in and an external recipe install through the same function and
// an existing document is never overwritten. Storage-neutral: no Node globals or builtins.
import { query, readBlob, readBundleOkfVersion, readDoc, writeBlob } from "../bundle-ops.js";
import { checkConnectorAgainstKinds, CONNECTORS_PREFIX } from "../connectors.js";
import { resolveContentType } from "../content-type.js";
import { mutateDocument } from "../document-mutation.js";
import { InvalidInputError, OkfActorError } from "../errors.js";
import { isOkfActor } from "../okf-actor.js";
import {
  CONVENTION_TYPE,
  CONVENTIONS_PREFIX,
  PROGRESS_STATUS_FIELD,
  buildKindRegistry,
  progressStatusStorageField,
  type KindRegistry,
} from "../kinds.js";
import { okfValuesEqual, type OkfRecord } from "../okf-authored-values.js";
import { assertAuthoredOkfStandardFields } from "../okf-standard-fields.js";
import { PAGE_REGISTRY_PREFIX, parseRegistration, VIEW_REGISTRY_PREFIX } from "../page.js";
import { RECIPE_PROGRESS_STATUS_TOKEN, type LoadedRecipe } from "../recipes.js";
import type { Bundle, ConceptId, OkfDocument } from "../types.js";
import type { ValidationWarning } from "../validation.js";
import { VersionConflict } from "../versioning.js";
import { ConnectorTargetUnsatisfied, RecipeAssetConflict, RecipeEditionChanged, RecipeInputError } from "./errors.js";
import {
  RECIPE_STAMP_KEY,
  recipeStampIdentity,
  recipeStampState,
  withRecipeStamp,
  worstRecipeStampState,
  type RecipeStampIdentity,
  type RecipeStampState,
} from "./stamp.js";
import {
  findLegacyViewConvention,
  governsKind,
  legacyEntryAlias,
  legacyRegistryAlias,
  VIEW_KIND_NAME,
} from "./legacy-aliases.js";

function materializeRecipeBody(body: string, storageField: string): string {
  return body.replaceAll(RECIPE_PROGRESS_STATUS_TOKEN, storageField);
}

/** Per-doc apply outcome: `changed: false` means the doc already existed (idempotent no-op), or —
 * when `legacy_present`/`migration_required` names a doc — that a legacy-LOCATED counterpart
 * already occupies the artifact's slot (working, or awaiting migration, respectively). */
export interface RecipeDocResult {
  id: ConceptId;
  changed: boolean;
  /** The existing doc was preserved, but its definition differs from this recipe's source. */
  source_differs?: true;
  /** Set when creation was skipped because this existing legacy-located doc satisfies the artifact. */
  legacy_present?: ConceptId;
  /** NON-SUCCESS skip: the counterpart still carries the RETIRED legacy names, so it
   * no longer works at runtime — the bundle needs the migration script before this artifact is
   * genuinely satisfied. Named alongside a receipt-level warning carrying the remedy. */
  migration_required?: ConceptId;
}

export interface RecipePageResult {
  registry_id: ConceptId;
  entry: string;
  registry_changed: boolean;
  entry_changed: boolean;
  changed: boolean;
  /** Set when creation was skipped because a COMPLETE, still-REGISTERING legacy-located pair satisfies the artifact. */
  legacy_present?: { registry: ConceptId; entry: string };
  /** See {@link RecipeDocResult.migration_required} — the page-pair variant. */
  migration_required?: { registry: ConceptId; entry: string };
}

export interface RecipeReferenceResult {
  id: ConceptId;
  changed: boolean;
}

/** One Connector's install outcome: created, or left as it was (`source_differs` when it differs). */
export interface RecipeConnectorResult {
  id: ConceptId;
  changed: boolean;
  /** The existing document was preserved, but it differs from this recipe's Connector. */
  source_differs?: true;
}

/** Per-artifact tally (docs + connectors + pages + references; a page's registry/entry pair is ONE artifact). */
export interface RecipeInstallCounts {
  created: number;
  existing: number;
  legacy_present: number;
  /** Existing convention or Connector docs whose definitions do not match the recipe source. */
  source_differs?: number;
  /** Artifacts whose slot is held by RETIRED-name content (see `migration_required` fields). */
  migration_required: number;
}

/** The receipt `installRecipe` returns: identity, per-doc outcomes, an overall `changed` (any doc
 * changed), the worst stamp state among the recipe's conventions, and any non-fatal warnings
 * collected at LOAD time (recipe.md reserved keys, skipped malformed convention docs).
 * Duplicate-`governs` against the TARGET bundle is a separate, POST-install check
 * (`loadKinds(bundle)`) — the caller's job, not this function's. */
export interface RecipeInstallResult {
  id: string;
  version: string;
  source: string;
  docs: RecipeDocResult[];
  /** One row per Connector the recipe carries; empty for a recipe without connectors. */
  connectors: RecipeConnectorResult[];
  pages: RecipePageResult[];
  references: RecipeReferenceResult[];
  counts: RecipeInstallCounts;
  changed: boolean;
  /**
   * The worst stamp among the recipe's conventions and Connectors after the install, in the order
   * current, stale, foreign, missing: a created document is `current`; an existing one keeps its
   * stamp, since install never rewrites it. A `stale` or `missing` stamp is converged by
   * `recipe evolve`.
   */
  stamp: RecipeStampState;
  /** Existing conventions and Connectors whose stamp is `stale` or `missing`: what an evolve plan would look at. */
  restamp_ids: string[];
  /** Existing conventions and Connectors another recipe's stamp owns; they stay with that recipe. */
  foreign_ids: string[];
  warnings: ValidationWarning[];
}

const RECIPE_WRITE_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function renameLogicalFieldMap(
  value: unknown,
  storageField: string,
  recipeId: string,
  docId: ConceptId,
): unknown {
  const record = plainRecord(value);
  if (!record || !Object.prototype.hasOwnProperty.call(record, PROGRESS_STATUS_FIELD)) return value;
  if (
    storageField !== PROGRESS_STATUS_FIELD
    && Object.prototype.hasOwnProperty.call(record, storageField)
  ) {
    throw new RecipeInputError(
      `recipe '${recipeId}' convention '${docId}' declares both logical '${PROGRESS_STATUS_FIELD}' and storage field '${storageField}'`,
    );
  }
  return Object.fromEntries(
    Object.entries(record).map(([field, fieldValue]) => [
      field === PROGRESS_STATUS_FIELD ? storageField : field,
      fieldValue,
    ]),
  );
}

/** Materialize explicit logical recipe fields into the target edition's physical convention keys. */
export function materializeRecipeForEdition(
  recipe: LoadedRecipe,
  okfVersion: string,
): LoadedRecipe {
  const storageField = progressStatusStorageField(okfVersion);
  if (!storageField) {
    throw new RecipeInputError(
      `recipe '${recipe.id}' cannot target unsupported OKF mutation version '${okfVersion}'`,
    );
  }
  const docs = recipe.docs.map((doc) => {
    const fields = plainRecord(doc.frontmatter.fields);
    if (!fields) return doc;
    const listField = (value: unknown): unknown => {
      if (!Array.isArray(value) || !value.includes(PROGRESS_STATUS_FIELD)) return value;
      if (value.includes(storageField)) {
        throw new RecipeInputError(
          `recipe '${recipe.id}' convention '${doc.id}' declares both logical '${PROGRESS_STATUS_FIELD}' and storage field '${storageField}'`,
        );
      }
      return value.map((field) => field === PROGRESS_STATUS_FIELD ? storageField : field);
    };
    const materializedFields: Record<string, unknown> = { ...fields };
    for (const key of ["required", "optional"]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        materializedFields[key] = listField(fields[key]);
      }
    }
    for (const key of ["values", "value_descriptions", "terminal", "descriptions", "types"]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        materializedFields[key] = renameLogicalFieldMap(fields[key], storageField, recipe.id, doc.id);
      }
    }
    return {
      ...doc,
      frontmatter: { ...doc.frontmatter, fields: materializedFields },
      body: materializeRecipeBody(doc.body, storageField),
    };
  });
  return { ...recipe, docs };
}

export function recipeDocumentForApply(
  doc: OkfDocument,
  okfVersion: string,
  now: string,
): OkfDocument {
  return okfVersion === "0.1"
    ? { ...doc, frontmatter: { ...doc.frontmatter, timestamp: now } }
    : { ...doc, frontmatter: { ...doc.frontmatter } };
}

async function createRecipeDocument(
  bundle: Bundle,
  doc: OkfDocument,
  okfVersion: string,
  now: string,
  actor?: string,
): Promise<OkfDocument> {
  const result = await mutateDocument({
    bundle,
    id: doc.id,
    mode: "create-only",
    registry: RECIPE_WRITE_REGISTRY,
    strict: false,
    actor,
    // Installed definitions must stay byte-comparable to their recipe source (sameInstalledDoc
    // preserves upstream generated.by). Record the installer separately as mutation attribution,
    // without manufacturing content provenance or replacing the recipe producer.
    seedGenerationClock: false,
    now: () => now,
    buildCandidate: (_existing, context) => {
      if (context.okfVersion !== okfVersion) {
        throw new RecipeEditionChanged(okfVersion, context.okfVersion, "installation");
      }
      return { frontmatter: { ...doc.frontmatter }, body: doc.body };
    },
  });
  return result.doc;
}

/**
 * Install `recipe` through the shared document-mutation boundary using expect-absent CAS. Recipe
 * conventions may declare Superbee's logical `progress_status`; this installer materializes the
 * concrete field for the bundle edition before any write. V0.1 retains the historical install-time
 * `timestamp` (`options.now`, default the current time); v0.2 preserves explicitly supplied legacy
 * fields but does not invent them. A `VersionConflict` remains an idempotent existing-doc result,
 * never a clobber.
 */
export async function installRecipe(
  bundle: Bundle,
  recipe: LoadedRecipe,
  options: { now?: string; actor?: string } = {},
): Promise<RecipeInstallResult> {
  const now = options.now ?? new Date().toISOString();
  const okfVersion = await readBundleOkfVersion(bundle) ?? "0.1";
  // Validate before any artifact write, including recipes whose first artifact is a blob.
  if (okfVersion === "0.2" && options.actor !== undefined && !isOkfActor(options.actor)) {
    throw new OkfActorError(options.actor, `OKF v0.2 mutation actor '${options.actor}' must be human:<id>, process:<id>, or <producer>/<version>`);
  }
  const source = recipe;
  recipe = materializeRecipeForEdition(recipe, okfVersion);
  const identity: RecipeStampIdentity = recipeStampIdentity(source, recipe);
  assertConnectorsWritable(recipe, identity, okfVersion, now);
  await assertConnectorTargets(bundle, recipe, okfVersion);
  await assertPortableTargetsCompatible(bundle, recipe, now, okfVersion);

  // Legacy-alias probes (see the module comment above the alias helpers): resolved lazily, once.
  const legacyConventionId = recipe.docs.some((d) => governsKind(d, VIEW_KIND_NAME))
    ? await findLegacyViewConvention(bundle)
    : null;
  let legacyRegistryDocs: Map<ConceptId, OkfDocument> | null = null;
  const legacyRegistryDoc = async (id: ConceptId): Promise<OkfDocument | undefined> => {
    legacyRegistryDocs ??= new Map(
      (await query(bundle, { prefix: PAGE_REGISTRY_PREFIX })).map((doc) => [doc.id, doc]),
    );
    return legacyRegistryDocs.get(id);
  };
  const migrationWarnings: ValidationWarning[] = [];
  const migrationHelp =
    "run `node scripts/migrate-legacy-view-names.mjs --dir <bundle-root>` from the Superbee repository root to migrate it in place";

  const docs: RecipeDocResult[] = [];
  const stamps: RecipeStampState[] = [];
  const restampIds: string[] = [];
  const foreignIds: string[] = [];
  for (const d of recipe.docs) {
    if (legacyConventionId !== null && governsKind(d, VIEW_KIND_NAME)) {
      // A convention still governing the RETIRED legacy name is unmigrated state: skip creating
      // the current-name convention (never two conventions for one kind), but as an explicit
      // NON-SUCCESS — not a satisfied-looking skip.
      docs.push({ id: d.id, changed: false, migration_required: legacyConventionId });
      stamps.push("missing");
      migrationWarnings.push({
        code: "MIGRATION_REQUIRED",
        message:
          `'${legacyConventionId}' still governs the retired legacy 'Page' kind name — ` +
          `'${d.id}' was not installed; ${migrationHelp}`,
        severity: "warning",
      });
      continue;
    }
    // The stamp lands in the convention's own create: it exists exactly when the convention does.
    let doc = withRecipeStamp(recipeDocumentForApply(d, okfVersion, now), identity);
    let changed = true;
    let sourceDiffers = false;
    try {
      doc = await createRecipeDocument(bundle, doc, okfVersion, now, options.actor);
      stamps.push("current");
    } catch (err) {
      if (err instanceof VersionConflict) {
        const existing = await readDoc(bundle, doc.id);
        const existingStamp = recipeStampState(existing, identity);
        stamps.push(existingStamp);
        if (existingStamp === "stale" || existingStamp === "missing") restampIds.push(doc.id);
        else if (existingStamp === "foreign") foreignIds.push(doc.id);
        if (!sameInstalledDoc(existing, doc, okfVersion)) {
          sourceDiffers = true;
          migrationWarnings.push({
            code: "RECIPE_SOURCE_DIFFERS",
            message:
              `recipe '${recipe.id}' source for '${doc.id}.md' differs from the existing convention; ` +
              "the existing bundle content was left untouched — run 'recipe evolve <same-name-or-path>' to inspect a safe additive upgrade plan",
            severity: "warning",
          });
        }
        changed = false;
      } else {
        throw err;
      }
    }
    docs.push({ id: doc.id, changed, ...(sourceDiffers ? { source_differs: true as const } : {}) });
  }

  // After the conventions, so a Kind the recipe declares exists before the Connector that maps onto it.
  const connectors: RecipeConnectorResult[] = [];
  for (const { doc: authored } of recipe.connectors ?? []) {
    const doc = withRecipeStamp(recipeDocumentForApply(authored, okfVersion, now), identity);
    let changed = true;
    let sourceDiffers = false;
    try {
      await createRecipeDocument(bundle, doc, okfVersion, now, options.actor);
      stamps.push("current");
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readDoc(bundle, doc.id);
      const existingStamp = recipeStampState(existing, identity);
      stamps.push(existingStamp);
      if (existingStamp === "stale" || existingStamp === "missing") restampIds.push(doc.id);
      else if (existingStamp === "foreign") foreignIds.push(doc.id);
      if (!sameInstalledDoc(existing, doc, okfVersion)) {
        sourceDiffers = true;
        migrationWarnings.push({
          code: "RECIPE_SOURCE_DIFFERS",
          message:
            `recipe '${recipe.id}' source for '${doc.id}.md' differs from the existing Connector; ` +
            "the existing bundle content was left untouched; run 'recipe evolve <same-name-or-path>' to inspect the plan, which never replaces a Connector a person changed",
          severity: "warning",
        });
      }
      changed = false;
    }
    connectors.push({ id: doc.id, changed, ...(sourceDiffers ? { source_differs: true as const } : {}) });
  }

  const pages: RecipePageResult[] = [];
  for (const page of recipe.pages) {
    const registryAlias = legacyRegistryAlias(page.registry.id);
    const entryAlias = legacyEntryAlias(page.entry);
    const aliasDoc = registryAlias !== null && entryAlias !== null ? await legacyRegistryDoc(registryAlias) : undefined;
    if (registryAlias !== null && entryAlias !== null && aliasDoc !== undefined) {
      // Skip ONLY on a COMPLETE legacy pair: a partial legacy leftover (registry doc without its
      // blob) must not suppress the new install — that would leave no working card at all.
      // Creating under the new ids is always safe (expect-absent CAS; ids never collide across
      // prefixes), and the leftover is the audit's business, not the installer's.
      const legacyBlob = await readBlob(bundle, entryAlias);
      if (legacyBlob !== null) {
        // The counterpart's KIND decides the outcome: a registering View at the
        // legacy location genuinely satisfies the artifact; a RETIRED-name (Page-typed or
        // otherwise non-registering) counterpart holds the slot but no longer works — an
        // explicit non-success naming the remedy, never a satisfied-looking skip.
        const registers = parseRegistration(aliasDoc.id, aliasDoc.frontmatter) !== null;
        if (registers) {
          pages.push({
            registry_id: page.registry.id,
            entry: page.entry,
            registry_changed: false,
            entry_changed: false,
            changed: false,
            legacy_present: { registry: registryAlias, entry: entryAlias },
          });
        } else {
          pages.push({
            registry_id: page.registry.id,
            entry: page.entry,
            registry_changed: false,
            entry_changed: false,
            changed: false,
            migration_required: { registry: registryAlias, entry: entryAlias },
          });
          migrationWarnings.push({
            code: "MIGRATION_REQUIRED",
            message:
              `'${registryAlias}' holds this artifact's slot but still carries the retired legacy names ` +
              `and does not register — '${page.registry.id}' was not installed; ${migrationHelp}`,
            severity: "warning",
          });
        }
        continue;
      }
    }
    const desiredBytes = new TextEncoder().encode(page.html);
    let entryChanged = true;
    try {
      await writeBlob(bundle, page.entry, desiredBytes, undefined, { expectedVersion: null });
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readBlob(bundle, page.entry);
      const bytesMatch = existing !== null && sameBytes(existing.bytes, desiredBytes);
      const sameContentType = existing?.contentType === resolveContentType(page.entry);
      if (!bytesMatch || !sameContentType) throw new RecipeAssetConflict(recipe.id, page.entry);
      entryChanged = false;
    }

    let registry = recipeDocumentForApply(page.registry, okfVersion, now);
    let registryChanged = true;
    try {
      registry = await createRecipeDocument(bundle, registry, okfVersion, now, options.actor);
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readDoc(bundle, registry.id);
      if (!sameInstalledDoc(existing, registry, okfVersion)) throw new RecipeAssetConflict(recipe.id, `${registry.id}.md`);
      registryChanged = false;
    }

    pages.push({
      registry_id: registry.id,
      entry: page.entry,
      registry_changed: registryChanged,
      entry_changed: entryChanged,
      changed: registryChanged || entryChanged,
    });
  }

  const references: RecipeReferenceResult[] = [];
  for (const reference of recipe.references) {
    let desired = withRecipeStamp(recipeDocumentForApply(reference.doc, okfVersion, now), identity);
    let changed = true;
    try {
      desired = await createRecipeDocument(bundle, desired, okfVersion, now, options.actor);
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      const existing = await readDoc(bundle, desired.id);
      if (!sameInstalledDoc(existing, desired, okfVersion)) throw new RecipeAssetConflict(recipe.id, `${desired.id}.md`);
      changed = false;
    }
    references.push({ id: desired.id, changed });
  }

  const artifacts: Array<{ changed: boolean; legacy_present?: unknown; migration_required?: unknown }> = [
    ...docs,
    ...connectors,
    ...pages,
    ...references,
  ];
  const sourceDiffers = [...docs, ...connectors].filter((doc) => doc.source_differs).length;
  const counts: RecipeInstallCounts = {
    created: artifacts.filter((a) => a.changed).length,
    existing: artifacts.filter((a) =>
      !a.changed && a.legacy_present === undefined && a.migration_required === undefined &&
      !("source_differs" in a && a.source_differs === true)
    )
      .length,
    legacy_present: artifacts.filter((a) => a.legacy_present !== undefined).length,
    migration_required: artifacts.filter((a) => a.migration_required !== undefined).length,
    ...(sourceDiffers > 0 ? { source_differs: sourceDiffers } : {}),
  };

  return {
    id: recipe.id,
    version: recipe.version,
    source: recipe.source,
    docs,
    connectors,
    pages,
    references,
    counts,
    changed:
      docs.some((d) => d.changed) ||
      connectors.some((connector) => connector.changed) ||
      pages.some((page) => page.changed) ||
      references.some((reference) => reference.changed),
    stamp: worstRecipeStampState(stamps),
    restamp_ids: restampIds.sort(),
    foreign_ids: foreignIds.sort(),
    warnings: [...recipe.warnings, ...migrationWarnings],
  };
}

/**
 * Every Connector as install will write it, against the authoring rules the engine applies on this
 * edition. The parser tolerates unknown top-level keys, so one OKF v0.2 owns (a `tags` that is not
 * a list, say) would otherwise be refused at the Connector's create, after the conventions.
 */
function assertConnectorsWritable(recipe: LoadedRecipe, identity: RecipeStampIdentity, okfVersion: string, now: string): void {
  if (okfVersion !== "0.2") return;
  for (const { doc } of recipe.connectors ?? []) {
    const candidate = withRecipeStamp(recipeDocumentForApply(doc, okfVersion, now), identity);
    try {
      assertAuthoredOkfStandardFields(candidate.frontmatter as unknown as OkfRecord, undefined, { phase: "input" });
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      throw new RecipeInputError(`recipe '${recipe.id}' cannot install Connector '${doc.id}': ${error.message}; nothing was written`);
    }
  }
}

/**
 * Every Connector's sources against the Kinds the bundle will hold once this install is done: its
 * conventions, plus the recipe's own at ids the bundle does not hold yet (install never rewrites an
 * existing convention). Runs before the first write of any artifact.
 */
async function assertConnectorTargets(bundle: Bundle, recipe: LoadedRecipe, okfVersion: string): Promise<void> {
  const connectors = recipe.connectors ?? [];
  if (connectors.length === 0) return;
  const conventions = new Map(
    (await query(bundle, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE })).map((doc) => [doc.id, doc]),
  );
  for (const doc of recipe.docs) if (!conventions.has(doc.id)) conventions.set(doc.id, doc);
  const registry = buildKindRegistry([...conventions.values()], [], { okfVersion });
  // Each refusal points at /<sources key>/<index>/target_kind or /<sources key>/<index>/fields/<field>.
  const segments = (pointer: string): string[] => pointer.split("/").slice(1).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const { connector } of connectors) {
    const errors = checkConnectorAgainstKinds(connector, registry);
    if (errors.length === 0) continue;
    const index = segments(errors[0]!.path)[1]!;
    const source = connector.sources[Number(index)]!;
    const ofSource = errors.filter((error) => segments(error.path)[1] === index);
    const fields = [...new Set(ofSource.flatMap((error) => {
      const [, , block, field] = segments(error.path);
      return block === "fields" && field !== undefined ? [field] : [];
    }))];
    throw new ConnectorTargetUnsatisfied(
      recipe.id,
      connector.id,
      source.name,
      source.target_kind,
      errors[0]!.code,
      fields,
      ofSource.map((error) => error.message).join("; "),
    );
  }
}

async function assertPortableTargetsCompatible(
  bundle: Bundle,
  recipe: LoadedRecipe,
  now: string,
  okfVersion: string,
): Promise<void> {
  const registries = new Map<ConceptId, OkfDocument>();
  if (recipe.pages.length > 0) {
    // Both accepted registry prefixes (views-registry/ current, pages-registry/ legacy) — the
    // query takes ONE prefix, so run it per prefix and merge (ids never collide across prefixes).
    for (const prefix of [PAGE_REGISTRY_PREFIX, VIEW_REGISTRY_PREFIX]) {
      const registryDocs = await query(bundle, { prefix });
      for (const doc of registryDocs) registries.set(doc.id, doc);
    }
  }
  for (const page of recipe.pages) {
    const existingBlob = await readBlob(bundle, page.entry);
    if (existingBlob) {
      const desiredBytes = new TextEncoder().encode(page.html);
      const bytesMatch = sameBytes(existingBlob.bytes, desiredBytes);
      const sameContentType = existingBlob.contentType === resolveContentType(page.entry);
      if (!bytesMatch || !sameContentType) throw new RecipeAssetConflict(recipe.id, page.entry);
    }

    const existingRegistry = registries.get(page.registry.id);
    if (existingRegistry) {
      const desiredRegistry = recipeDocumentForApply(page.registry, okfVersion, now);
      if (!sameInstalledDoc(existingRegistry, desiredRegistry, okfVersion)) {
        throw new RecipeAssetConflict(recipe.id, `${page.registry.id}.md`);
      }
    }
  }

  const installedReferences = new Map<ConceptId, OkfDocument>();
  if (recipe.references.length > 0) {
    const referenceDocs = await query(bundle, { prefix: "references/" });
    for (const doc of referenceDocs) installedReferences.set(doc.id, doc);
  }
  for (const reference of recipe.references) {
    if (reference.doc.frontmatter.type !== "Reference") {
      throw new RecipeInputError(`recipe '${recipe.id}' asset '${reference.doc.id}' must have type 'Reference'`);
    }
    const existing = installedReferences.get(reference.doc.id);
    if (!existing) continue;
    const desired = recipeDocumentForApply(reference.doc, okfVersion, now);
    if (!sameInstalledDoc(existing, desired, okfVersion)) {
      throw new RecipeAssetConflict(recipe.id, `${reference.doc.id}.md`);
    }
  }
}

/** Byte equality of two blob payloads. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function sameInstalledDoc(existing: OkfDocument, desired: OkfDocument, okfVersion: string): boolean {
  // The recipe stamp is install metadata, never definition content.
  const { timestamp: _existingTimestamp, [RECIPE_STAMP_KEY]: _existingStamp, ...existingFrontmatter } = existing.frontmatter;
  const { timestamp: _desiredTimestamp, [RECIPE_STAMP_KEY]: _desiredStamp, ...desiredFrontmatter } = desired.frontmatter;
  // The installer is the latest mutation actor, not part of the upstream definition. Its
  // edition-specific coordinate may change without changing source-authored generated.by.
  const actorField = okfVersion === "0.2" ? "superbee_updated_by" : "actor";
  delete existingFrontmatter[actorField];
  delete desiredFrontmatter[actorField];
  // A reading-order placement the bundle added to an installed convention is not drift: the
  // recipe declares none, and evolution keeps it (BUNDLE_LOCAL_PLACEMENT in evolution.ts).
  if (desiredFrontmatter.order === undefined) delete existingFrontmatter.order;
  if (okfVersion === "0.2") {
    for (const frontmatter of [existingFrontmatter, desiredFrontmatter]) {
      const generated = plainRecord(frontmatter.generated);
      if (!generated) continue;
      const { at: _at, ...rest } = generated;
      frontmatter.generated = rest;
    }
  }
  return okfValuesEqual(existingFrontmatter, desiredFrontmatter) && existing.body === desired.body;
}

/**
 * The convention docs currently present under `conventions/`, by id — ONE round-trip
 * (backend-agnostic, works over `--remote`), used by `recipes` to report whether a built-in is
 * already applied to `bundle` (every one of its docs' ids present) AND whether any installed
 * doc's content differs from the recipe source (the listing's `drift` bit). The query was always
 * a full read; returning the docs instead of discarding their content costs zero added I/O.
 */
export async function installedConventionDocs(bundle: Bundle): Promise<Map<ConceptId, OkfDocument>> {
  const docs = await query(bundle, { prefix: CONVENTIONS_PREFIX });
  return new Map(docs.map((d) => [d.id, d]));
}

/**
 * The documents under `connectors/`, by id: the Connector documents `installedRecipes` reads beside
 * the conventions, in one round-trip.
 */
export async function installedConnectorDocs(bundle: Bundle): Promise<Map<ConceptId, OkfDocument>> {
  const docs = await query(bundle, { prefix: CONNECTORS_PREFIX });
  return new Map(docs.map((d) => [d.id, d]));
}

/**
 * True when at least one of `recipe`'s installed docs differs in content from the recipe source
 * (the same `sameInstalledDoc` comparison `installRecipe` makes; timestamp-insensitive). Honest at
 * the literal level only: drift can be DELIBERATE — a dismissal record occupying the canonical
 * id, or a kind legitimately evolved via `kind field add` / `recipe evolve`. The listing pairs
 * the bit with descriptive help and NO fixing command (design appendix O2): a proactive "fix"
 * pointer here would re-propose exactly what a `kind dismiss` recorded declining.
 */
export function recipeDrifts(
  recipe: LoadedRecipe,
  installed: Map<ConceptId, OkfDocument>,
  okfVersion: string,
  now: string,
): boolean {
  const materialized = materializeRecipeForEdition(recipe, okfVersion);
  return materialized.docs.some((doc) => {
    const existing = installed.get(doc.id);
    return existing !== undefined && !sameInstalledDoc(existing, recipeDocumentForApply(doc, okfVersion, now), okfVersion);
  });
}

/** True when every convention doc `recipe` installs is already present in `appliedIds`. */
export function isRecipeApplied(recipe: LoadedRecipe, appliedIds: Set<ConceptId>): boolean {
  return recipe.docs.every((doc) => appliedIds.has(doc.id));
}
