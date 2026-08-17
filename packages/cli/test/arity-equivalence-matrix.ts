import type { PublicLeafId } from "../src/command-spec.js";

export const BEHAVIOR_DIMENSION_VALUES = {
  parserAuthority: ["ordinary", "selector", "schema-deferred", "dynamic-deferred"],
  selectorLayout: ["none", "leading-navigation", "leading-required", "interposed-action"],
  positionalCount: [0, 1, 2],
  canonicalIdentity: ["canonical", "alias"],
  errorChannel: ["stdout", "stderr"],
  helpPrecedence: ["owned-before-arity", "schema-before-arity", "token-walk-before-arity"],
  terminatorPrecedence: ["parseargs-before-arity", "schema-reparse-before-arity", "token-walk-before-arity"],
  preValidationEffect: ["none", "schema-bundle-read"],
} as const;

export type BehaviorDimensions = {
  readonly [Dimension in keyof typeof BEHAVIOR_DIMENSION_VALUES]:
    (typeof BEHAVIOR_DIMENSION_VALUES)[Dimension][number];
};

export type BehaviorDimension = keyof BehaviorDimensions;

export interface BehaviorAssignment<LeafId extends string = PublicLeafId> {
  readonly leafId: LeafId;
  readonly dimensions: BehaviorDimensions;
}

const ordinary = (
  leafId: PublicLeafId,
  positionalCount: 0 | 1 | 2,
  overrides: Partial<BehaviorDimensions> = {},
): BehaviorAssignment => ({
  leafId,
  dimensions: {
    parserAuthority: "ordinary",
    selectorLayout: "none",
    positionalCount,
    canonicalIdentity: "canonical",
    errorChannel: "stdout",
    helpPrecedence: "owned-before-arity",
    terminatorPrecedence: "parseargs-before-arity",
    preValidationEffect: "none",
    ...overrides,
  },
});

const selector = (
  leafId: PublicLeafId,
  selectorLayout: "leading-navigation" | "leading-required" | "interposed-action",
  positionalCount: 0 | 1 | 2,
  overrides: Partial<BehaviorDimensions> = {},
): BehaviorAssignment => ({
  leafId,
  dimensions: {
    parserAuthority: "selector",
    selectorLayout,
    positionalCount,
    canonicalIdentity: "canonical",
    errorChannel: "stdout",
    helpPrecedence: "owned-before-arity",
    terminatorPrecedence: "parseargs-before-arity",
    preValidationEffect: "none",
    ...overrides,
  },
});

/**
 * Test-owned executable taxonomy. It is deliberately leaf-exhaustive rather than inferred from
 * command spelling: parser authority, raw-channel reservations, and selector layout are runtime
 * properties that must change here when their production boundary changes.
 */
export const BEHAVIOR_ASSIGNMENTS = [
  selector("bundleLocate", "leading-navigation", 0),
  selector("catalogAdd", "leading-navigation", 1),
  selector("catalogList", "leading-navigation", 0),
  selector("catalogResolve", "leading-navigation", 1, { errorChannel: "stderr" }),
  ordinary("init", 0),
  selector("indexGenerate", "leading-navigation", 0),
  ordinary("status", 0),
  ordinary("docWrite", 1),
  {
    leafId: "docUpdate",
    dimensions: {
      parserAuthority: "dynamic-deferred",
      selectorLayout: "none",
      positionalCount: 1,
      canonicalIdentity: "canonical",
      errorChannel: "stdout",
      helpPrecedence: "token-walk-before-arity",
      terminatorPrecedence: "token-walk-before-arity",
      preValidationEffect: "none",
    },
  },
  ordinary("docRead", 1, { errorChannel: "stderr" }),
  ordinary("docOpen", 1),
  ordinary("docHistory", 1),
  ordinary("docDelete", 1),
  ordinary("list", 0),
  ordinary("query", 0, { canonicalIdentity: "alias" }),
  ordinary("linkAdd", 2),
  ordinary("linkShow", 1),
  ordinary("linkList", 0),
  ordinary("artifactCreate", 1),
  ordinary("promote", 1),
  ordinary("pull", 0),
  ordinary("blobs", 0),
  ordinary("delete", 0),
  {
    leafId: "new",
    dimensions: {
      parserAuthority: "schema-deferred",
      selectorLayout: "none",
      positionalCount: 2,
      canonicalIdentity: "canonical",
      errorChannel: "stdout",
      helpPrecedence: "schema-before-arity",
      terminatorPrecedence: "schema-reparse-before-arity",
      preValidationEffect: "schema-bundle-read",
    },
  },
  ordinary("kinds", 0),
  selector("kindFieldAdd", "interposed-action", 2),
  selector("kindFieldRemove", "interposed-action", 2),
  ordinary("recipes", 0),
  ordinary("recipeAdd", 1),
  ordinary("serve", 0),
  ordinary("ui", 0),
  ordinary("mcp", 0, { errorChannel: "stderr" }),
  ordinary("mcpInstall", 0),
  ordinary("mcpStatus", 0),
  ordinary("mcpUninstall", 0),
  selector("viewList", "leading-navigation", 0),
  ordinary("sync", 0),
  ordinary("version", 0),
  ordinary("sessionStart", 0),
  selector("hookInstall", "leading-required", 0),
  selector("hookStatus", "leading-required", 0),
  selector("hookUninstall", "leading-required", 0),
  selector("skillInstall", "leading-required", 0),
  selector("skillStatus", "leading-required", 0),
  selector("skillUninstall", "leading-required", 0),
  ordinary("setup", 0),
] as const satisfies readonly BehaviorAssignment[];

/** One built subprocess row for every real key above. */
export const BUILT_REPRESENTATIVE_IDS = [
  "bundleLocate",
  "catalogAdd",
  "catalogResolve",
  "init",
  "docWrite",
  "docUpdate",
  "docRead",
  "query",
  "linkAdd",
  "new",
  "kindFieldAdd",
  "hookInstall",
  "mcp",
] as const satisfies readonly PublicLeafId[];

export function behaviorKey(dimensions: BehaviorDimensions): string {
  return (Object.keys(BEHAVIOR_DIMENSION_VALUES) as BehaviorDimension[])
    .map((dimension) => `${dimension}=${dimensions[dimension]}`)
    .join("|");
}

export function validateBehaviorCoverage(
  leafIds: readonly string[],
  assignments: readonly BehaviorAssignment<string>[],
  representativeIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const catalog = new Set(leafIds);
  const byLeaf = new Map<string, BehaviorAssignment<string>[]>();
  for (const assignment of assignments) {
    const rows = byLeaf.get(assignment.leafId) ?? [];
    rows.push(assignment);
    byLeaf.set(assignment.leafId, rows);
    if (!catalog.has(assignment.leafId)) errors.push(`mapping names unknown leaf: ${assignment.leafId}`);
  }
  for (const leafId of leafIds) {
    const count = byLeaf.get(leafId)?.length ?? 0;
    if (count === 0) errors.push(`leaf has no behavioral-equivalence key: ${leafId}`);
    if (count > 1) errors.push(`leaf has ${count} behavioral-equivalence keys: ${leafId}`);
  }

  const representatives = new Set(representativeIds);
  if (representatives.size !== representativeIds.length) errors.push("built representative ids are duplicated");
  for (const representative of representatives) {
    if (!catalog.has(representative)) errors.push(`representative names unknown leaf: ${representative}`);
  }

  const assignmentsByKey = new Map<string, BehaviorAssignment<string>[]>();
  for (const assignment of assignments) {
    const key = behaviorKey(assignment.dimensions);
    const rows = assignmentsByKey.get(key) ?? [];
    rows.push(assignment);
    assignmentsByKey.set(key, rows);
  }
  for (const [key, rows] of assignmentsByKey) {
    const owners = rows.filter((row) => representatives.has(row.leafId));
    if (owners.length === 0) errors.push(`behavioral-equivalence key has no built representative: ${key}`);
    if (owners.length > 1) errors.push(`behavioral-equivalence key has ${owners.length} built representatives: ${key}`);
  }
  for (const representative of representatives) {
    const assignment = byLeaf.get(representative)?.[0];
    if (!assignment) continue;
    const key = behaviorKey(assignment.dimensions);
    if ((assignmentsByKey.get(key) ?? []).length === 0) errors.push(`representative has no behavioral-equivalence class: ${representative}`);
  }
  return errors.sort();
}

export function assignmentIndex(): ReadonlyMap<PublicLeafId, BehaviorAssignment> {
  return new Map(BEHAVIOR_ASSIGNMENTS.map((assignment) => [assignment.leafId, assignment]));
}
