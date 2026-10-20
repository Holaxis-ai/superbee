/**
 * `@superbee/core/recipe-lifecycle`: install and evolve a parsed recipe on any bundle.
 *
 * `prepareRecipeInstall` materializes the same stamped candidates without target reads or writes;
 * `inspectRecipeInstallTarget` separates target content, recipe identity and stamp integrity.
 * Neither confers readiness, authority or a new persistent apply path.
 * `installRecipe` creates a recipe's conventions, Connectors, View pairs and References
 * create-only, never overwriting what a bundle already holds, after checking every Connector
 * against the Kinds the bundle will hold. `planRecipeEvolution` is a read-only, state-bound
 * preflight of an additive upgrade to installed conventions and of the replacement of Connectors and References
 * this recipe wrote and nobody changed since, and `applyRecipeEvolution` applies exactly the plan
 * whose token the caller observed, one exact-version CAS write per changed target. The caller acquires the recipe (`@superbee/core/recipes` parses files into a
 * `LoadedRecipe`) and presents results and typed errors. Storage-neutral: it runs in Node,
 * Workers and browsers over any `StorageBackend`.
 *
 * Every convention, Connector and Reference either path writes carries an `x_recipe` stamp in the
 * same write. Exact-source unstamped References may be explicitly adopted without replacing content.
 * `installedRecipes` retains its convention/Connector projection; Reference ownership is inspected
 * through evolution's optional `reference_assets` rows. `recipeOrphanedDefinitions` reports retained
 * ownership absent from an explicit recipe, without deletion or restamping authority.
 */
export {
  installRecipe,
  prepareRecipeInstall,
  inspectRecipeInstallTarget,
  installedConnectorDocs,
  installedConventionDocs,
  isRecipeApplied,
  materializeRecipeForEdition,
  recipeDrifts,
} from "./install.js";
export type {
  PreparedRecipeInstall,
  RecipeInstallTargetInspection,
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
  RecipeEvolutionReference,
  RecipeEvolutionReferenceAssets,
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
  recipeOrphanedDefinitions,
  readRecipeStamp,
  recipeSourceDigest,
} from "./stamp.js";
export type {
  ConventionStampState,
  RecipeStampIdentity,
  InstalledRecipeRow,
  RecipeOrphanedDefinition,
  RecipeInstallState,
  RecipeStamp,
  RecipeStampState,
} from "./stamp.js";

export { planRecipeDeclarationRetirement } from "./retirement.js";
export type { RecipeDeclarationRetirementPlan, RetirementDeclaration, RetirementIssue } from "./retirement.js";
