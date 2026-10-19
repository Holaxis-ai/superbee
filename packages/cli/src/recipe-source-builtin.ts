// CLI source routing only; optional content and parsing are core-owned.
import { loadBuiltinRecipe, resolveBuiltinSync } from "@superbee/core/builtin-recipes";
import type { RecipeSource } from "./recipe-source-contract.js";
import { looksLikeRecipePath } from "./recipe-ref.js";
export { builtinNames, resolveBuiltinSync } from "@superbee/core/builtin-recipes";
export function builtinRecipeSource(): RecipeSource {
  return { kind: "builtin", async resolve(ref) { return looksLikeRecipePath(ref) ? null : loadBuiltinRecipe(ref); } };
}
export const CONTEXT_NOTES_RECIPE = resolveBuiltinSync("context-notes");
