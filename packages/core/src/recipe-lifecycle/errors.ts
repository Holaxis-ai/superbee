// Typed failures of recipe installation and evolution. Each carries the facts a presenting
// boundary needs (the CLI maps them to its codes and exits in `classifyBundleError`) without
// prose matching; messages are the user-facing wording.
import type { ConceptId, Version } from "../types.js";
import type { RecipeEvolutionBlocker } from "./evolution.js";

/**
 * One definition the evolution apply has handled, in plan order: `changed` when its content was
 * updated, `stamped` when this apply wrote it (a content update or a stamp alone).
 */
export interface RecipeEvolutionCompletedDefinition {
  id: ConceptId;
  changed: boolean;
  stamped: boolean;
  version: Version;
}

/** The common base: every recipe lifecycle failure is one of the subclasses below. */
export class RecipeLifecycleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecipeLifecycleError";
  }
}

/** The recipe itself cannot target this bundle: an unsupported edition or a contradictory field declaration. */
export class RecipeInputError extends RecipeLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = "RecipeInputError";
  }
}

/** A recipe asset (View entry, View registry or Reference) differs from what the bundle already holds there. */
export class RecipeAssetConflict extends RecipeLifecycleError {
  readonly recipe: string;
  readonly key: string;

  constructor(recipe: string, key: string) {
    super(
      `recipe '${recipe}' cannot install '${key}' because a different target already exists; ` +
        "the existing bundle content was left untouched",
    );
    this.name = "RecipeAssetConflict";
    this.recipe = recipe;
    this.key = key;
  }
}

/** The bundle's OKF edition changed between the lifecycle's read of it and a write. */
export class RecipeEditionChanged extends RecipeLifecycleError {
  readonly from: string;
  readonly to: string;
  readonly operation: "installation" | "evolution";

  constructor(from: string, to: string, operation: "installation" | "evolution") {
    super(
      `bundle OKF version changed from '${from}' to '${to}' during recipe ${operation}` +
        (operation === "installation" ? "; retry" : ""),
    );
    this.name = "RecipeEditionChanged";
    this.from = from;
    this.to = to;
    this.operation = operation;
  }
}

/** The plan token the caller observed no longer matches the bundle's current plan. */
export class RecipeEvolutionPlanChanged extends RecipeLifecycleError {
  readonly expected: string;
  readonly current: string;

  constructor(expected: string, current: string) {
    super(
      `recipe evolution plan changed (expected ${expected}, current ${current}); inspect a fresh plan before applying`,
    );
    this.name = "RecipeEvolutionPlanChanged";
    this.expected = expected;
    this.current = current;
  }
}

/** The observed plan is not ready: it carries blockers, so nothing was written. */
export class RecipeEvolutionBlocked extends RecipeLifecycleError {
  readonly recipe: string;
  readonly blockers: readonly RecipeEvolutionBlocker[];

  constructor(recipe: string, blockers: readonly RecipeEvolutionBlocker[]) {
    super(
      `recipe '${recipe}' cannot evolve automatically (${blockers.length} blocker${blockers.length === 1 ? "" : "s"})`,
    );
    this.name = "RecipeEvolutionBlocked";
    this.recipe = recipe;
    this.blockers = blockers;
  }
}

/**
 * Why a write loop stopped part way. `race`: a target's exact-version CAS failed or the target
 * disappeared. `write_policy`: the write policy rejected a candidate after preflight.
 * `edition_changed`: the bundle edition moved during the loop. `other`: any other failure, kept
 * as `cause` for the presenting boundary to classify.
 */
export type RecipeEvolutionInterruptionReason = "race" | "write_policy" | "edition_changed" | "other";

/** The evolution apply stopped after writing `completed`; `pending` names the targets still unwritten. */
export class RecipeEvolutionInterrupted extends RecipeLifecycleError {
  readonly reason: RecipeEvolutionInterruptionReason;
  readonly completed: RecipeEvolutionCompletedDefinition[];
  readonly pending: ConceptId[];

  constructor(
    reason: RecipeEvolutionInterruptionReason,
    message: string,
    completed: RecipeEvolutionCompletedDefinition[],
    pending: ConceptId[],
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "RecipeEvolutionInterrupted";
    this.reason = reason;
    this.completed = completed;
    this.pending = pending;
  }
}

/**
 * Every write succeeded, but the re-plan after the loop could not run (`unverifiable`) or no longer
 * reads ready and unchanged (`changed`), because the bundle has no cross-document transaction.
 */
export class RecipeEvolutionPostcondition extends RecipeLifecycleError {
  readonly reason: "unverifiable" | "changed";
  readonly completed: RecipeEvolutionCompletedDefinition[];
  readonly blockers?: readonly RecipeEvolutionBlocker[];
  readonly postcondition_plan?: string;

  constructor(
    reason: "unverifiable" | "changed",
    message: string,
    completed: RecipeEvolutionCompletedDefinition[],
    details: { blockers?: readonly RecipeEvolutionBlocker[]; postcondition_plan?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RecipeEvolutionPostcondition";
    this.reason = reason;
    this.completed = completed;
    if (details.blockers !== undefined) this.blockers = details.blockers;
    if (details.postcondition_plan !== undefined) this.postcondition_plan = details.postcondition_plan;
  }
}
