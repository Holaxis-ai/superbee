/**
 * `@superbee/core/recipe-lifecycle`: install and evolve a parsed recipe on any bundle.
 *
 * `installRecipe` creates a recipe's conventions, Connectors, View pairs and References
 * create-only, never overwriting what a bundle already holds, after checking every Connector
 * against the Kinds the bundle will hold. `planRecipeEvolution` is a read-only, state-bound
 * preflight of an additive upgrade to installed conventions and of the replacement of Connectors
 * this recipe wrote and nobody changed since, and `applyRecipeEvolution` applies exactly the plan
 * whose token the caller observed, one exact-version CAS write per changed definition. The caller acquires the recipe (`@superbee/core/recipes` parses files into a
 * `LoadedRecipe`) and presents results and typed errors. Storage-neutral: it runs in Node,
 * Workers and browsers over any `StorageBackend`.
 *
 * Every convention and Connector either path writes carries an `x_recipe` stamp in the same write;
 * `installedRecipes` derives each recipe's install state from those stamps alone.
 */
export {
  installRecipe,
  installedConnectorDocs,
  installedConventionDocs,
  isRecipeApplied,
  materializeRecipeForEdition,
  recipeDrifts,
} from "./install.js";
export type {
  RecipeConnectorResult,
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
  ConnectorTargetUnsatisfied,
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
export {
  DEFINITION_DIGEST_RULES,
  RECIPE_STAMP_KEY,
  definitionDigest,
  installedRecipes,
  readRecipeStamp,
  recipeSourceDigest,
} from "./stamp.js";
export type {
  ConventionStampState,
  InstalledRecipeRow,
  RecipeInstallState,
  RecipeStamp,
  RecipeStampState,
} from "./stamp.js";
