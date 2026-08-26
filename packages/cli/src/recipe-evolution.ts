// Explicit, state-bound evolution of recipe-installed conventions.
//
// Recipe installation is create-only and intentionally never overwrites bundle-authored content.
// This module owns the distinct upgrade authority: a read-only compatibility plan followed by an
// exact-token preflight and exact-version CAS apply over each changed target. Since the bundle has
// no cross-document transaction, a postcondition reports concurrent non-target changes honestly.
import {
  CONVENTIONS_PREFIX,
  DocumentNotFoundError,
  InvalidInputError,
  VersionConflict,
  applyV02MutationMetadata,
  blobVersion,
  buildKindRegistry,
  contentVersion,
  mutateDocument,
  parseConventionDoc,
  query,
  readBlob,
  readBundleOkfVersion,
  readDocVersioned,
  resolveContentType,
  validateAgainstKind,
  type Bundle,
  type ConceptId,
  type KindConvention,
  type KindRegistry,
  type OkfDocument,
  type Version,
} from "@superbee/core";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CliError, classifyBundleError } from "./errors.js";
import type { LoadedRecipe } from "./recipe-source.js";
import {
  materializeRecipeForEdition,
  recipeDocumentForApply,
  sameInstalledDoc,
} from "./recipes.js";

const RECIPE_EVOLUTION_WRITE_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface RecipeEvolutionDefinition {
  id: ConceptId;
  governs: string;
  action: "missing" | "unchanged" | "update";
  expected_version: Version | null;
  desired_version: Version;
  /** Exact additive semantic paths this automatic plan will introduce. */
  added_paths: string[];
}

export interface RecipeEvolutionBlocker {
  code: string;
  id: string;
  message: string;
  field?: string;
}

/** Public representation of one read-only, state-bound preflight decision. */
export interface RecipeEvolutionPlan {
  recipe: "evolution plan";
  id: string;
  version: string;
  source: string;
  okf_version: string;
  ready: boolean;
  changed: boolean;
  plan_token: string;
  definitions: RecipeEvolutionDefinition[];
  counts: {
    definitions: number;
    updates: number;
    unchanged: number;
    missing: number;
    instances_checked: number;
    blockers: number;
  };
  blockers: RecipeEvolutionBlocker[];
}

export interface RecipeEvolutionApplyResult {
  recipe: "evolved" | "already current";
  id: string;
  version: string;
  source: string;
  changed: boolean;
  plan_token: string;
  definitions: Array<{ id: ConceptId; changed: boolean; version: Version }>;
  counts: { updated: number; unchanged: number };
}

interface PreparedRecipeEvolution {
  plan: RecipeEvolutionPlan;
  desired: Map<ConceptId, OkfDocument>;
}

interface EvolutionProof {
  kind: "definition" | "instance" | "reference" | "view-registry" | "view-entry";
  id: string;
  current_version: Version | null;
  desired_version?: Version;
}

function comparableRecipeDoc(doc: OkfDocument, okfVersion: string): OkfDocument {
  const { timestamp: _timestamp, ...frontmatter } = doc.frontmatter;
  const generated = plainRecord(frontmatter.generated);
  if (okfVersion === "0.2" && generated) {
    const { at: _at, ...rest } = generated;
    if (Object.keys(rest).length > 0) frontmatter.generated = rest;
    else delete frontmatter.generated;
  }
  return { id: doc.id, frontmatter, body: doc.body };
}

const PRESERVED_ROOT_METADATA = new Set(["timestamp", "actor", "generated", "verified", "superbee_updated_by"]);

interface AdditiveMergeResult {
  candidate: OkfDocument;
  addedPaths: string[];
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Merge recipe declarations into a user-owned convention without deleting or replacing any
 * existing semantic value. Arrays are declaration sets: additions append, while omissions are
 * blockers. Root mutation/provenance metadata is preserved by the shared write policy instead of
 * being treated as recipe-owned schema.
 */
function additiveConventionCandidate(
  existing: OkfDocument,
  desired: OkfDocument,
  blockers: RecipeEvolutionBlocker[],
): AdditiveMergeResult {
  const addedPaths: string[] = [];

  const merge = (current: unknown, next: unknown, pointer: string): unknown => {
    if (current === undefined) {
      addedPaths.push(pointer);
      return next;
    }
    if (next === undefined) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED",
        desired.id,
        `automatic evolution preserves the existing declaration at '${pointer}'; remove it manually after reviewing dependent content`,
        pointer,
      );
      return current;
    }
    if (isDeepStrictEqual(current, next)) return current;
    if (Array.isArray(current) && Array.isArray(next)) {
      const merged = [...current];
      for (const value of current) {
        if (!next.some((candidate) => isDeepStrictEqual(candidate, value))) {
          evolutionBlocker(
            blockers,
            "RECIPE_EVOLUTION_REMOVAL_UNSUPPORTED",
            desired.id,
            `automatic evolution preserves the existing declaration value at '${pointer}'`,
            pointer,
          );
        }
      }
      for (const value of next) {
        if (merged.some((candidate) => isDeepStrictEqual(candidate, value))) continue;
        merged.push(value);
        addedPaths.push(`${pointer}/${pointerSegment(String(value))}`);
      }
      return merged;
    }
    const currentRecord = plainRecord(current);
    const nextRecord = plainRecord(next);
    if (currentRecord && nextRecord) {
      const merged: Record<string, unknown> = { ...currentRecord };
      for (const key of new Set([...Object.keys(currentRecord), ...Object.keys(nextRecord)])) {
        setOwn(merged, key, merge(
          currentRecord[key],
          nextRecord[key],
          `${pointer}/${pointerSegment(key)}`,
        ));
      }
      return merged;
    }
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
      desired.id,
      `automatic evolution will not replace the existing declaration at '${pointer}'`,
      pointer,
    );
    return current;
  };

  const currentFrontmatter = existing.frontmatter;
  const desiredFrontmatter = desired.frontmatter;
  const candidateFrontmatter: Record<string, unknown> = { ...currentFrontmatter };
  for (const key of new Set([...Object.keys(currentFrontmatter), ...Object.keys(desiredFrontmatter)])) {
    // Evolution never imports recipe-authored provenance, verification, or mutation attribution.
    // These coordinates come exclusively from the installed document and the shared write policy.
    if (PRESERVED_ROOT_METADATA.has(key)) continue;
    setOwn(candidateFrontmatter, key, merge(
      currentFrontmatter[key],
      desiredFrontmatter[key],
      `/frontmatter/${pointerSegment(key)}`,
    ));
  }

  let body = existing.body;
  if (existing.body === "" && desired.body !== "") {
    body = desired.body;
    addedPaths.push("/body");
  } else if (existing.body !== desired.body) {
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED",
      desired.id,
      "automatic evolution will not replace an existing convention body; update it manually after review",
      "/body",
    );
  }

  return {
    candidate: { id: desired.id, frontmatter: candidateFrontmatter as OkfDocument["frontmatter"], body },
    addedPaths: [...new Set(addedPaths)].sort(),
  };
}

async function readRecipeDocIfPresent(
  bundle: Bundle,
  id: ConceptId,
): Promise<{ doc: OkfDocument; version: Version } | null> {
  try {
    return await readDocVersioned(bundle, id);
  } catch (error) {
    if (error instanceof DocumentNotFoundError || (error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function evolutionBlocker(
  blockers: RecipeEvolutionBlocker[],
  code: string,
  id: string,
  message: string,
  field?: string,
): void {
  blockers.push({ code, id, message, ...(field ? { field } : {}) });
}

function monotonicEvolutionBlockers(
  current: KindConvention,
  desired: KindConvention,
  blockers: RecipeEvolutionBlocker[],
): void {
  const currentRequired = new Set(current.fields.required);
  for (const field of desired.fields.required) {
    if (!currentRequired.has(field)) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_NON_MONOTONIC",
        desired.id,
        `automatic evolution cannot newly require '${field}' for '${desired.governs}'; migrate instances explicitly first`,
        field,
      );
    }
  }

  for (const [field, desiredValues] of Object.entries(desired.fields.values)) {
    const currentValues = current.fields.values[field];
    if (!currentValues) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_NON_MONOTONIC",
        desired.id,
        `automatic evolution cannot add an enum restriction to '${field}' for '${desired.governs}'`,
        field,
      );
      continue;
    }
    const allowed = new Set(desiredValues);
    const removed = currentValues.filter((value) => !allowed.has(value));
    if (removed.length > 0) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_NON_MONOTONIC",
        desired.id,
        `automatic evolution cannot remove allowed '${field}' value(s) for '${desired.governs}': ${removed.join(", ")}`,
        field,
      );
    }
  }

  const currentSections = new Set(current.sections ?? []);
  for (const section of desired.sections ?? []) {
    if (!currentSections.has(section)) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_NON_MONOTONIC",
        desired.id,
        `automatic evolution cannot newly require the '# ${section}' section for '${desired.governs}'`,
        section,
      );
    }
  }

  if (!isDeepStrictEqual(current.links ?? {}, desired.links ?? {})) {
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_RELATIONSHIP_CHANGE",
      desired.id,
      `automatic evolution does not change the outbound relationship vocabulary for '${desired.governs}'`,
      "links",
    );
  }
  if (!isDeepStrictEqual(current.expectsInbound ?? {}, desired.expectsInbound ?? {})) {
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_RELATIONSHIP_CHANGE",
      desired.id,
      `automatic evolution does not change inbound relationship expectations for '${desired.governs}'`,
      "expects_inbound",
    );
  }
  if (!isDeepStrictEqual(current.fields.terminal, desired.fields.terminal)) {
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_TERMINAL_CHANGE",
      desired.id,
      `automatic evolution does not change terminal workflow values for '${desired.governs}' because open-work visibility can change`,
      "fields.terminal",
    );
  }
}

function evolutionPlanToken(input: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}

async function prepareRecipeEvolution(bundle: Bundle, sourceRecipe: LoadedRecipe): Promise<PreparedRecipeEvolution> {
  const okfVersion = await readBundleOkfVersion(bundle) ?? "0.1";
  const recipe = materializeRecipeForEdition(sourceRecipe, okfVersion);
  const blockers: RecipeEvolutionBlocker[] = recipe.warnings.map((warning) => ({
    code: warning.code,
    id: recipe.id,
    message: warning.message,
    ...(warning.field ? { field: warning.field } : {}),
  }));
  const definitions: RecipeEvolutionDefinition[] = [];
  const desired = new Map<ConceptId, OkfDocument>();
  const proofs: EvolutionProof[] = [];
  const desiredKinds = new Map<string, KindConvention>();

  const skippedConventions: Array<{ id: ConceptId; reason: string }> = [];
  const installedConventions = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: "Convention" }, {
    onSkip: (skipped) => skippedConventions.push(skipped),
  });
  for (const skipped of skippedConventions) {
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_CONVENTION_UNREADABLE",
      skipped.id,
      `cannot prove the prospective registry while convention '${skipped.id}' is unreadable: ${skipped.reason}`,
    );
  }
  const prospectiveById = new Map(installedConventions.map((doc) => [doc.id, doc]));

  for (const authored of recipe.docs) {
    const target = recipeDocumentForApply(authored, okfVersion, "1970-01-01T00:00:00.000Z");
    const parsedDesired = parseConventionDoc(target);
    if (!parsedDesired.ok) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_DEFINITION_INVALID",
        target.id,
        `recipe convention '${target.id}' is malformed: ${parsedDesired.reason}`,
      );
      continue;
    }
    for (const warning of parsedDesired.warnings) {
      evolutionBlocker(blockers, warning.code, target.id, warning.message, warning.field);
    }
    if (parsedDesired.reservedFieldsIgnored.length > 0) {
      evolutionBlocker(
        blockers,
        "KIND_RESERVED_FIELD",
        target.id,
        `recipe convention declares reserved field name(s): ${parsedDesired.reservedFieldsIgnored.join(", ")}`,
        parsedDesired.reservedFieldPaths.join(","),
      );
    }
    if (okfVersion === "0.2") {
      try {
        applyV02MutationMetadata({
          candidate: { frontmatter: target.frontmatter, body: target.body },
          meaningfulChangeAt: "1970-01-01T00:00:00.000Z",
        });
      } catch (error) {
        if (!(error instanceof InvalidInputError)) throw error;
        evolutionBlocker(
          blockers,
          "RECIPE_EVOLUTION_WRITE_POLICY_INVALID",
          target.id,
          `recipe convention cannot satisfy the OKF v0.2 write policy: ${error.message}`,
        );
      }
    }

    const existing = await readRecipeDocIfPresent(bundle, target.id);
    if (!existing) {
      desired.set(target.id, target);
      prospectiveById.set(target.id, target);
      desiredKinds.set(parsedDesired.kind.governs, parsedDesired.kind);
      const desiredVersion = contentVersion(comparableRecipeDoc(target, okfVersion));
      definitions.push({
        id: target.id,
        governs: parsedDesired.kind.governs,
        action: "missing",
        expected_version: null,
        desired_version: desiredVersion,
        added_paths: [],
      });
      proofs.push({ kind: "definition", id: target.id, current_version: null, desired_version: desiredVersion });
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_DEFINITION_MISSING",
        target.id,
        "recipe evolution only updates installed conventions; install the complete recipe with 'recipe add' first",
      );
      continue;
    }

    const parsedCurrent = parseConventionDoc(existing.doc);
    if (
      existing.doc.frontmatter.type !== "Convention"
      || !parsedCurrent.ok
      || parsedCurrent.kind.governs !== parsedDesired.kind.governs
    ) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_IDENTITY_CONFLICT",
        target.id,
        existing.doc.frontmatter.type !== "Convention"
          ? `existing '${target.id}' has type '${String(existing.doc.frontmatter.type)}', not 'Convention'`
          : !parsedCurrent.ok
          ? `existing '${target.id}' is not a valid convention: ${parsedCurrent.reason}`
          : `existing '${target.id}' governs '${parsedCurrent.kind.governs}', not '${parsedDesired.kind.governs}'`,
        "governs",
      );
    }

    const merged = additiveConventionCandidate(existing.doc, target, blockers);
    let candidate = merged.candidate;
    if (okfVersion === "0.2") {
      try {
        const withMetadata = applyV02MutationMetadata({
          existing: existing.doc,
          candidate: { frontmatter: candidate.frontmatter, body: candidate.body },
          meaningfulChangeAt: "1970-01-01T00:00:00.000Z",
        });
        candidate = { id: candidate.id, ...withMetadata };
      } catch (error) {
        if (!(error instanceof InvalidInputError)) throw error;
        evolutionBlocker(
          blockers,
          "RECIPE_EVOLUTION_WRITE_POLICY_INVALID",
          target.id,
          `prospective convention cannot satisfy the OKF v0.2 write policy: ${error.message}`,
        );
      }
    }
    desired.set(target.id, candidate);
    prospectiveById.set(target.id, candidate);
    const parsedCandidate = parseConventionDoc(candidate);
    if (!parsedCandidate.ok) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_DEFINITION_INVALID",
        target.id,
        `prospective convention '${target.id}' is malformed: ${parsedCandidate.reason}`,
      );
    } else {
      desiredKinds.set(parsedCandidate.kind.governs, parsedCandidate.kind);
    }

    const desiredVersion = contentVersion(comparableRecipeDoc(candidate, okfVersion));
    const unchanged = sameInstalledDoc(existing.doc, candidate, okfVersion);
    definitions.push({
      id: target.id,
      governs: parsedDesired.kind.governs,
      action: unchanged ? "unchanged" : "update",
      expected_version: existing.version,
      desired_version: desiredVersion,
      added_paths: unchanged ? [] : merged.addedPaths,
    });
    proofs.push({
      kind: "definition",
      id: target.id,
      current_version: existing.version,
      desired_version: desiredVersion,
    });
    if (
      !unchanged
      && existing.doc.frontmatter.type === "Convention"
      && parsedCurrent.ok
      && parsedCandidate.ok
      && parsedCurrent.kind.governs === parsedCandidate.kind.governs
    ) {
      monotonicEvolutionBlockers(parsedCurrent.kind, parsedCandidate.kind, blockers);
    }
  }

  const prospectiveRegistry = buildKindRegistry([...prospectiveById.values()]);
  for (const warning of prospectiveRegistry.warnings) {
    if (warning.code !== "KIND_DUPLICATE_GOVERNS" || !warning.field || !desiredKinds.has(warning.field)) continue;
    evolutionBlocker(
      blockers,
      "RECIPE_EVOLUTION_DUPLICATE_GOVERNS",
      desiredKinds.get(warning.field)!.id,
      warning.message,
      warning.field,
    );
  }
  for (const [governs, kind] of desiredKinds) {
    if (prospectiveRegistry.kinds.get(governs)?.id !== kind.id) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_DUPLICATE_GOVERNS",
        kind.id,
        `prospective registry keeps '${prospectiveRegistry.kinds.get(governs)?.id ?? "none"}' as the authority for '${governs}', not '${kind.id}'`,
        governs,
      );
    }
  }

  const assetDocProof = async (
    kind: "reference" | "view-registry",
    authored: OkfDocument,
  ): Promise<void> => {
    const target = recipeDocumentForApply(authored, okfVersion, "1970-01-01T00:00:00.000Z");
    const wanted = contentVersion(comparableRecipeDoc(target, okfVersion));
    const existing = await readRecipeDocIfPresent(bundle, target.id);
    proofs.push({ kind, id: target.id, current_version: existing?.version ?? null, desired_version: wanted });
    if (!existing) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_ASSET_MISSING",
        target.id,
        `recipe asset '${target.id}' is not installed; install the complete recipe with 'recipe add' first`,
      );
    } else if (!sameInstalledDoc(existing.doc, target, okfVersion)) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_ASSET_CHANGE_UNSUPPORTED",
        target.id,
        `recipe evolution does not replace an existing ${kind === "reference" ? "Reference" : "View registry"} asset`,
      );
    }
  };

  for (const reference of recipe.references) await assetDocProof("reference", reference.doc);
  for (const page of recipe.pages) {
    await assetDocProof("view-registry", page.registry);
    const existing = await readBlob(bundle, page.entry);
    const wantedBytes = Buffer.from(page.html, "utf8");
    const wanted = blobVersion(wantedBytes);
    proofs.push({ kind: "view-entry", id: page.entry, current_version: existing?.version ?? null, desired_version: wanted });
    if (!existing) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_ASSET_MISSING",
        page.entry,
        `recipe View entry '${page.entry}' is not installed; install the complete recipe with 'recipe add' first`,
      );
    } else if (
      existing.version !== wanted || existing.contentType !== resolveContentType(page.entry)
    ) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_ASSET_CHANGE_UNSUPPORTED",
        page.entry,
        "recipe evolution does not replace an existing active View entry without an atomic pair-update authority",
      );
    }
  }

  const changingKinds = definitions
    .filter((definition) => definition.action === "update")
    .map((definition) => desiredKinds.get(definition.governs))
    .filter((kind): kind is KindConvention => kind !== undefined);
  let instancesChecked = 0;
  const instanceProofs: EvolutionProof[] = [];
  if (changingKinds.length > 0) {
    const skippedInstances: Array<{ id: ConceptId; reason: string }> = [];
    const docs = await query(bundle, {}, { onSkip: (skipped) => skippedInstances.push(skipped) });
    for (const skipped of skippedInstances) {
      evolutionBlocker(
        blockers,
        "RECIPE_EVOLUTION_INSTANCE_UNREADABLE",
        skipped.id,
        `cannot prove instance compatibility while '${skipped.id}' is unreadable: ${skipped.reason}`,
      );
    }
    for (const kind of changingKinds) {
      for (const doc of docs) {
        if (String(doc.frontmatter.type) !== kind.governs) continue;
        instancesChecked += 1;
        instanceProofs.push({
          kind: "instance",
          id: doc.id,
          current_version: contentVersion(doc),
        });
        for (const warning of validateAgainstKind(doc, kind)) {
          evolutionBlocker(
            blockers,
            "RECIPE_EVOLUTION_INSTANCE_INVALID",
            doc.id,
            warning.message,
            warning.field,
          );
        }
      }
    }
  }
  proofs.push(...instanceProofs.sort((a, b) => a.id.localeCompare(b.id)));

  definitions.sort((a, b) => a.id.localeCompare(b.id));
  proofs.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  blockers.sort((a, b) => `${a.code}:${a.id}:${a.field ?? ""}`.localeCompare(`${b.code}:${b.id}:${b.field ?? ""}`));
  const token = evolutionPlanToken({
    recipe: { id: recipe.id, version: recipe.version, source: recipe.source },
    okfVersion,
    definitions,
    proofs,
    blockers,
  });
  const updates = definitions.filter((definition) => definition.action === "update").length;
  const unchanged = definitions.filter((definition) => definition.action === "unchanged").length;
  const missing = definitions.filter((definition) => definition.action === "missing").length;
  return {
    plan: {
      recipe: "evolution plan",
      id: recipe.id,
      version: recipe.version,
      source: recipe.source,
      okf_version: okfVersion,
      ready: blockers.length === 0,
      changed: updates > 0,
      plan_token: token,
      definitions,
      counts: {
        definitions: definitions.length,
        updates,
        unchanged,
        missing,
        instances_checked: instancesChecked,
        blockers: blockers.length,
      },
      blockers,
    },
    desired,
  };
}

/** Build a read-only, state-bound preflight for installed recipe convention evolution. */
export async function planRecipeEvolution(
  bundle: Bundle,
  recipe: LoadedRecipe,
): Promise<RecipeEvolutionPlan> {
  return (await prepareRecipeEvolution(bundle, recipe)).plan;
}

/** Apply only the exact ready plan the caller previously observed. */
export async function applyRecipeEvolution(
  bundle: Bundle,
  recipe: LoadedRecipe,
  expectedPlanToken: string,
  actor?: string,
): Promise<RecipeEvolutionApplyResult> {
  const prepared = await prepareRecipeEvolution(bundle, recipe);
  const { plan } = prepared;
  if (plan.plan_token !== expectedPlanToken) {
    throw new CliError(
      "STALE_HEAD",
      `recipe evolution plan changed (expected ${expectedPlanToken}, current ${plan.plan_token}); inspect a fresh plan before applying`,
      { details: { expected_plan: expectedPlanToken, current_plan: plan.plan_token } },
    );
  }
  if (!plan.ready) {
    throw new CliError(
      "CONFLICT",
      `recipe '${plan.id}' cannot evolve automatically (${plan.counts.blockers} blocker${plan.counts.blockers === 1 ? "" : "s"})`,
      { details: { blocker_count: plan.counts.blockers, blockers: plan.blockers.slice(0, 20) } },
    );
  }

  const completed: Array<{ id: ConceptId; changed: boolean; version: Version }> = [];
  const pending = plan.definitions.filter((definition) => definition.action === "update").map((definition) => definition.id);
  for (const definition of plan.definitions) {
    if (definition.action !== "update") {
      completed.push({ id: definition.id, changed: false, version: definition.expected_version! });
      continue;
    }
    const plannedDesired = prepared.desired.get(definition.id)!;
    const now = new Date().toISOString();
    const desired = recipeDocumentForApply(plannedDesired, plan.okf_version, now);
    try {
      const result = await mutateDocument({
        bundle,
        id: definition.id,
        mode: "patch",
        onAbsent: "fail",
        expectedVersion: definition.expected_version!,
        maxAttempts: 1,
        registry: RECIPE_EVOLUTION_WRITE_REGISTRY,
        strict: false,
        actor,
        now: () => now,
        buildCandidate: (_existing, context) => {
          if (context.okfVersion !== plan.okf_version) {
            throw new CliError(
              "STALE_HEAD",
              `bundle OKF version changed from '${plan.okf_version}' to '${context.okfVersion}' during recipe evolution`,
            );
          }
          return { frontmatter: { ...desired.frontmatter }, body: desired.body };
        },
      });
      completed.push({ id: definition.id, changed: result.changed, version: result.version });
      pending.shift();
    } catch (error) {
      if (error instanceof VersionConflict || error instanceof DocumentNotFoundError) {
        throw new CliError(
          "STALE_HEAD",
          `recipe evolution lost its exact-version race at '${definition.id}'; inspect a fresh plan and resume`,
          { details: { completed, pending } },
        );
      }
      if (error instanceof InvalidInputError) {
        throw new CliError(
          "CONFLICT",
          `recipe evolution write policy rejected '${definition.id}' after preflight: ${error.message}`,
          { details: { completed, pending } },
        );
      }
      const classified = error instanceof CliError ? error : classifyBundleError(error);
      throw new CliError(classified.code, classified.message, {
        details: { ...(classified.details ?? {}), completed, pending },
        ...(classified.help ? { help: classified.help } : {}),
        ...(classified.handled ? { handled: true } : {}),
      });
    }
  }

  const updated = completed.filter((definition) => definition.changed).length;
  let postcondition: PreparedRecipeEvolution;
  try {
    postcondition = await prepareRecipeEvolution(bundle, recipe);
  } catch (error) {
    throw new CliError(
      "RUNTIME",
      `recipe evolution wrote ${updated} definition(s), but its postcondition could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      { details: { completed, pending: [] } },
    );
  }
  if (!postcondition.plan.ready || postcondition.plan.changed) {
    throw new CliError(
      "CONFLICT",
      `recipe evolution wrote ${updated} definition(s), but the prospective registry changed before the postcondition check`,
      {
        details: {
          completed,
          pending: [],
          blockers: postcondition.plan.blockers.slice(0, 20),
          postcondition_plan: postcondition.plan.plan_token,
        },
      },
    );
  }
  return {
    recipe: updated > 0 ? "evolved" : "already current",
    id: plan.id,
    version: plan.version,
    source: plan.source,
    changed: updated > 0,
    plan_token: plan.plan_token,
    definitions: completed,
    counts: { updated, unchanged: completed.length - updated },
  };
}
