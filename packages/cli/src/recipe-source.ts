// Stable public façade for recipe acquisition and parsing. Consumers import this module; internal
// source adapters remain replaceable without widening the CLI's recipe API.
export {
  parseRecipeFiles,
  type RecipeFile,
  type RecipePage,
  type RecipeReference,
  type LoadedRecipe,
  type RecipeErrorCode,
  type RecipeError,
  type LoadResult,
  type RecipeSource,
} from "./recipe-parser.js";
export { builtinNames, builtinRecipeSource, CONTEXT_NOTES_RECIPE } from "./recipe-source-builtin.js";
export { filesRecipeSource } from "./recipe-source-filesystem.js";
export { shippedRecipeNames, shippedRecipeSource, SHIPPED_RECIPES_SUBDIR } from "./recipe-source-shipped.js";
export { DEFAULT_SOURCES, DEFAULT_RECIPE_REF, resolveRecipe } from "./recipe-resolver.js";
