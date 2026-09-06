import { builtinNames, builtinRecipeSource } from "./recipe-source-builtin.js";
import { filesRecipeSource } from "./recipe-source-filesystem.js";
import type { LoadResult } from "@superbee/core/recipes";
import type { RecipeSource } from "./recipe-source-contract.js";

/** The default resolution order: built-in names first, then a filesystem path. */
export const DEFAULT_SOURCES: RecipeSource[] = [builtinRecipeSource(), filesRecipeSource()];

/** The recipe `init` applies when `--recipe` is omitted. */
export const DEFAULT_RECIPE_REF = "context-notes";

export async function resolveRecipe(ref: string, sources: RecipeSource[] = DEFAULT_SOURCES): Promise<LoadResult> {
  for (const source of sources) {
    const result = await source.resolve(ref);
    if (result) return result;
  }
  return {
    ok: false,
    error: {
      code: "RECIPE_NOT_FOUND",
      message: `unknown recipe '${ref}' (built-ins: ${builtinNames().join(", ")}; or a path to a recipe folder)`,
    },
  };
}
