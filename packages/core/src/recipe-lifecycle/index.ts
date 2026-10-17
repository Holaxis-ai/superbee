/**
 * `@superbee/core/recipe-lifecycle`: install and evolve a parsed recipe on any bundle.
 *
 * `installRecipe` creates a recipe's conventions, View pairs and References create-only, never
 * overwriting what a bundle already holds. `planRecipeEvolution` is a read-only, state-bound
 * preflight of an additive upgrade to installed conventions, and `applyRecipeEvolution` applies
 * exactly the plan whose token the caller observed, one exact-version CAS write per changed
 * convention. The caller acquires the recipe (`@superbee/core/recipes` parses files into a
 * `LoadedRecipe`) and presents results and typed errors. Storage-neutral: it runs in Node,
 * Workers and browsers over any `StorageBackend`.
 */
export {
  installRecipe,
  installedConventionDocs,
  isRecipeApplied,
  materializeRecipeForEdition,
  recipeDrifts,
} from "./install.js";
export type {
  RecipeDocResult,
  RecipeInstallCounts,
  RecipeInstallResult,
  RecipePageResult,
  RecipeReferenceResult,
} from "./install.js";
export { applyRecipeEvolution, planRecipeEvolution } from "./evolution.js";
export type {
  RecipeEvolutionApplyResult,
  RecipeEvolutionBlocker,
  RecipeEvolutionDefinition,
  RecipeEvolutionPlan,
} from "./evolution.js";
export {
  RecipeAssetConflict,
  RecipeEditionChanged,
  RecipeEvolutionBlocked,
  RecipeEvolutionInterrupted,
  RecipeEvolutionPlanChanged,
  RecipeEvolutionPostcondition,
  RecipeInputError,
  RecipeLifecycleError,
} from "./errors.js";
export type { RecipeEvolutionCompletedDefinition, RecipeEvolutionInterruptionReason } from "./errors.js";
