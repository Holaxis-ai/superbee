import { builtinNames, builtinRecipeSource } from "./recipe-source-builtin.js";
import { filesRecipeSource } from "./recipe-source-filesystem.js";
import { shippedRecipeNames, shippedRecipeSource } from "./recipe-source-shipped.js";
import type { LoadResult, RecipeSource } from "./recipe-parser.js";

/**
 * The default resolution order: built-in names, then this distribution's shipped portable recipe
 * folders, then a filesystem path. Built-ins win a name collision because they are the same bytes
 * in every distribution; the shipped source only ever ADDS names, so a ref that resolved before
 * still resolves to the same recipe.
 */
export const DEFAULT_SOURCES: RecipeSource[] = [builtinRecipeSource(), shippedRecipeSource(), filesRecipeSource()];

/** The recipe `init` applies when `--recipe` is omitted. */
export const DEFAULT_RECIPE_REF = "context-notes";

export async function resolveRecipe(ref: string, sources: RecipeSource[] = DEFAULT_SOURCES): Promise<LoadResult> {
  for (const source of sources) {
    const result = await source.resolve(ref);
    if (result) return result;
  }
  const known = [...builtinNames(), ...(await shippedRecipeNames())].join(", ");
  return {
    ok: false,
    error: {
      code: "RECIPE_NOT_FOUND",
      message: `unknown recipe '${ref}' (known names: ${known}; or a path to a recipe folder)`,
    },
  };
}
