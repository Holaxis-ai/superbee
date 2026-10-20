/** One explicitly selected actual-source retirement stage; storage remains the commit authority. */
import { InvalidInputError } from "../errors.js";
import { compareStorageKeys } from "../paths.js";
import { VersionConflict } from "../versioning.js";
import { backendFor } from "../bundle-ops.js";
import { DocumentNotFoundError, mutateDocument } from "../document-mutation.js";
import { INVENTORY_GUARD_DOMAIN, InventoryGuardConflict, InventoryGuardUnsupported, inventoryGuardFor, type InventoryGuardTarget, type InventoryEntry } from "../inventory-guard.js";
import { buildKindRegistry } from "../kinds.js";
import { recipePreflightDigest } from "../recipe-set-preflight.js";
import type { LoadedRecipe } from "../recipes.js";
import type { Bundle, OkfDocument } from "../types.js";
import { prepareRecipeRetirementStage } from "./evolution.js";
import { recipeDocumentForApply, sameInstalledDoc } from "./install.js";
import { definitionDigest } from "./stamp.js";
import { prepareRecipeDeclarationRetirement, type RecipeDeclarationRetirementPlan, type RetirementDeclaration, type RetirementIssue } from "./retirement.js";

export interface RecipeRetirementApplyOptions {
  scope?: typeof INVENTORY_GUARD_DOMAIN;
  definitionId?: string;
  consumerEvidence?: unknown;
}
export interface RecipeDeclarationRetirementApplyPlan {
  recipe: "declaration retirement apply";
  id: string;
  version: string;
  source: string;
  source_digest: string;
  scope: typeof INVENTORY_GUARD_DOMAIN;
  ready_for_next_stage: boolean;
  next_definition: string | null;
  pending_definitions: string[];
  declarations: RetirementDeclaration[];
  blockers: RetirementIssue[];
  target?: InventoryGuardTarget;
  plan_token?: string;
  consumers: RecipeDeclarationRetirementPlan["consumers"];
  external_consumers: RecipeDeclarationRetirementPlan["external_consumers"];
}
export interface RecipeDeclarationRetirementApplyResult {
  recipe: "declaration retirement apply";
  id: string;
  version: string;
  scope: typeof INVENTORY_GUARD_DOMAIN;
  completed: Array<{ id: string; version: string; changed: boolean; stamped: boolean }>;
  pending_definitions: string[];
  complete: boolean;
  refresh_needed: boolean;
  consumers: RecipeDeclarationRetirementPlan["consumers"];
  external_consumers: RecipeDeclarationRetirementPlan["external_consumers"];
}
export class RecipeRetirementApplyError extends Error {
  readonly reason: "plan_changed" | "blocked" | "interrupted" | "outcome_unknown";
  readonly plan: RecipeDeclarationRetirementApplyPlan;
  readonly completed: [] = [];
  readonly failed: { id: string | null; reason: string };
  readonly pending_definitions: string[];
  constructor(reason: RecipeRetirementApplyError["reason"], plan: RecipeDeclarationRetirementApplyPlan, cause?: unknown) {
    super(`Recipe retirement ${reason}; inspect a fresh stage plan before continuing.`, cause === undefined ? undefined : { cause });
    this.name = "RecipeRetirementApplyError";
    this.reason = reason; this.plan = plan;
    this.failed = { id: plan.next_definition, reason };
    this.pending_definitions = [...(plan.next_definition ? [plan.next_definition] : []), ...plan.pending_definitions];
  }
}
interface PreparedStage {
  plan: RecipeDeclarationRetirementApplyPlan;
  bundle: Bundle;
  candidate?: OkfDocument;
  inventory: InventoryEntry[];
  expectedVersion?: string;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
async function prepareStage(bundle: Bundle, source: LoadedRecipe, options: RecipeRetirementApplyOptions): Promise<PreparedStage> {
  source = structuredClone(source);
  options = { ...options };
  if (Object.hasOwn(options, "consumerEvidence")) {
    try { options.consumerEvidence = structuredClone(options.consumerEvidence); }
    catch { /* The owning preflight returns unsupported input as a refusal. */ }
  }
  const bound = { root: bundle.root, backend: backendFor(bundle) };
  let target: InventoryGuardTarget | undefined, guardIssue: string | undefined;
  try { target = await inventoryGuardFor(bound.backend).observeTarget(); }
  catch (error) { guardIssue = error instanceof Error ? error.message : String(error); }
  const prepared = await prepareRecipeDeclarationRetirement(bound, source, options);
  const report = prepared.report;
  const ids = [...new Set(report.declarations.map(row => row.definition))].sort(compareStorageKeys);
  const next = options.definitionId ?? ids[0] ?? null;
  const selected = report.declarations.filter(row => row.definition === next);
  const blockers = [...report.blockers];
  const block = (code: string, message: string) => blockers.push({ code, id: next ?? report.id, message });
  if (options.scope !== INVENTORY_GUARD_DOMAIN) block("RETIREMENT_SCOPE_REQUIRED", "Explicit exact-root cooperating-local-writers-v1, local-only and consumer-unassessed limits are required.");
  if (!next || !selected.length) block("RETIREMENT_NO_ELIGIBLE_STAGE", "No eligible deprecated omission exists in the selected definition.");
  if (!report.local.complete || report.local.issues.length) block("RETIREMENT_LOCAL_UNKNOWN", "Complete readable stable local inventory is required.");
  if (selected.some(row => row.usage.some(usage => usage.unknown || usage.count > 0))) block("RETIREMENT_DECLARATION_USED_OR_UNKNOWN", "The selected definition has used or unknown retired coordinates.");
  if (guardIssue || !target) block("RETIREMENT_GUARD_UNAVAILABLE", guardIssue ?? "The actual backend has no supported guard.");
  if (target && (target.edition !== report.local.okf_version || target.root_version !== report.local.root_index_version)) block("RETIREMENT_TARGET_CHANGED", "Guard target metadata differs from the inspected local scope.");
  const inventory: InventoryEntry[] = report.local.inventory.filter((row): row is InventoryEntry => row.version !== null).sort((a, b) => compareStorageKeys(a.id, b.id));
  let candidate: OkfDocument | undefined;
  if (next && selected.length && report.local.complete) {
    try {
      const stage = await prepareRecipeRetirementStage(bound, prepared.source, next, selected);
      blockers.push(...stage.plan.blockers);
      candidate = stage.writes.get(next);
      if (!candidate) block("RETIREMENT_STAGE_UNCHANGED", "No actual-source retirement write was prepared.");
      if (stage.plan.definitions.some(row => row.id === next && row.expected_version !== prepared.snapshots.get(next)?.version)) block("RETIREMENT_TARGET_CHANGED", "The stage target changed after the scan.");
    } catch (error) { block("RETIREMENT_STAGE_UNAVAILABLE", error instanceof Error ? error.message : String(error)); }
  }
  if (Object.hasOwn(options, "consumerEvidence")) {
    if (report.consumers.status === "partial" || report.consumers.status === "refused" || report.consumers.binding_issues.length || report.consumers.result?.verdict !== "valid") block("RETIREMENT_CONSUMER_EVIDENCE_UNSUPPORTED", "Supplied consumer evidence must be valid and exactly bound; it cannot be downgraded to unassessed.");
    // B assessed the final source. It certifies this stage only when all other owned concepts
    // already match, and this actual evolution-owned candidate matches its assessed projection.
    const owned = prepared.installation ? [...prepared.installation.docs, ...prepared.installation.connectors.map(row => row.doc), ...prepared.installation.references.map(row => row.doc), ...prepared.installation.pages.map(row => row.registry)] : [];
    if (!candidate || !owned.length || owned.some(wanted => {
      const actual = wanted.id === next ? candidate : prepared.snapshots.get(wanted.id)?.doc;
      return !actual || !sameInstalledDoc(actual, wanted, report.local.okf_version);
    })) block("RETIREMENT_STAGE_CONSUMER_UNREPRESENTABLE", "Final-source evidence does not represent this concrete intermediate stage; supply an actual staged source/evidence or inspect a later stage.");
  }
  if (target) {
    try { if (recipePreflightDigest(await inventoryGuardFor(bound.backend).observeTarget()) !== recipePreflightDigest(target)) block("RETIREMENT_TARGET_CHANGED", "Guard target changed while planning."); }
    catch (error) { block("RETIREMENT_GUARD_UNAVAILABLE", error instanceof Error ? error.message : String(error)); }
  }
  blockers.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const plan: RecipeDeclarationRetirementApplyPlan = {
    recipe: "declaration retirement apply", id: report.id, version: report.version, source: report.source, source_digest: report.source_digest,
    scope: INVENTORY_GUARD_DOMAIN, ready_for_next_stage: blockers.length === 0,
    next_definition: next, pending_definitions: ids.filter(id => id !== next), declarations: selected, blockers,
    ...(target ? { target } : {}), consumers: report.consumers, external_consumers: report.external_consumers,
  };
  if (plan.ready_for_next_stage && candidate) {
    plan.plan_token = `retirement-apply/v1:${recipePreflightDigest({ plan, inventory, observation_digest: report.local.observation_digest,
      candidate: definitionDigest(candidate), stamp: candidate.frontmatter.x_recipe })}`;
  }
  return { plan, bundle: bound, candidate, inventory, expectedVersion: next ? prepared.snapshots.get(next)?.version : undefined };
}
export async function planRecipeDeclarationRetirementApply(bundle: Bundle, source: LoadedRecipe, options: RecipeRetirementApplyOptions = {}): Promise<RecipeDeclarationRetirementApplyPlan> {
  return (await prepareStage(bundle, source, options)).plan;
}
export async function applyRecipeDeclarationRetirement(bundle: Bundle, source: LoadedRecipe, expectedApplyToken: string, options: RecipeRetirementApplyOptions & { actor?: string } = {}): Promise<RecipeDeclarationRetirementApplyResult> {
  options = { ...options };
  const stage = await prepareStage(bundle, source, options);
  const { plan } = stage;
  if (!plan.ready_for_next_stage) throw new RecipeRetirementApplyError("blocked", plan);
  if (!/^retirement-apply\/v1:sha256:[0-9a-f]{64}$/.test(expectedApplyToken) || expectedApplyToken !== plan.plan_token) throw new RecipeRetirementApplyError("plan_changed", plan);
  const now = new Date().toISOString();
  const desired = recipeDocumentForApply(stage.candidate!, plan.target!.edition, now);
  try {
    const result = await mutateDocument({ bundle: stage.bundle, id: plan.next_definition!, mode: "replace-document", onAbsent: "fail",
      expectedVersion: stage.expectedVersion!, maxAttempts: 1, registry: buildKindRegistry([], [], { okfVersion: plan.target!.edition }), strict: false,
      seedGenerationClock: false, persistActor: false, actor: options.actor, now: () => now,
      inventoryGuard: { target: plan.target!, domain: plan.scope, inventory: stage.inventory },
      buildCandidate: (_existing, context) => {
        if (context.okfVersion !== plan.target!.edition) throw new InventoryGuardConflict("edition");
        return { frontmatter: desired.frontmatter, body: desired.body };
      },
    });
    return { recipe: "declaration retirement apply", id: plan.id, version: plan.version, scope: plan.scope,
      completed: [{ id: plan.next_definition!, version: result.version, changed: result.changed, stamped: true }],
      pending_definitions: plan.pending_definitions, complete: plan.pending_definitions.length === 0, refresh_needed: plan.pending_definitions.length > 0,
      consumers: plan.consumers, external_consumers: plan.external_consumers };
  } catch (error) {
    // These owning typed refusals establish that publication did not occur. Keep their
    // authority; only an unclassified persistence failure has an uncertain outcome.
    if (error instanceof InventoryGuardUnsupported || error instanceof InvalidInputError || error instanceof VersionConflict || error instanceof DocumentNotFoundError) throw error;
    throw new RecipeRetirementApplyError(error instanceof InventoryGuardConflict ? "interrupted" : "outcome_unknown", plan, error);
  }
}
