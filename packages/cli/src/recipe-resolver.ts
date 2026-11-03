import { MalformedDocumentError } from "@superbee/core";
import { CliError, frontmatterDetails } from "./errors.js";
import { registeredRecipe } from "./source-plugins.js";
import { builtinNames, builtinRecipeSource } from "./recipe-source-builtin.js";
import { filesRecipeSource } from "./recipe-source-filesystem.js";
import type { LoadResult } from "@superbee/core/recipes";
import type { RecipeSource } from "./recipe-source-contract.js";

/** The default resolution order: built-in names first, then a filesystem path. */
export const DEFAULT_SOURCES: RecipeSource[] = [{kind:"files",resolve:registeredRecipe}, builtinRecipeSource(), filesRecipeSource()];

/** The recipe `init` applies when `--recipe` is omitted. */
export const DEFAULT_RECIPE_REF = "context-notes";

export async function resolveRecipe(ref: string, sources: RecipeSource[] = DEFAULT_SOURCES): Promise<LoadResult> {
  for (const source of sources) {
    let result: LoadResult | undefined | null;
    try {
      result = await source.resolve(ref);
    } catch (error) {
      // A recipe folder is caller input, so frontmatter it cannot parse is a usage error.
      if (error instanceof MalformedDocumentError) throw new CliError("USAGE", error.message, { details: frontmatterDetails(error) });
      throw error;
    }
    if (result) return result;
  }
  return {
    ok: false,
    error: {
      code: "RECIPE_NOT_FOUND",
      message: `unknown recipe '${ref}' (built-ins: ${builtinNames().join(", ")}; registered source plugins: <plugin-id>:<recipe-key>; or a path to a recipe folder)`,
    },
  };
}
