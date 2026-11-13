import { MalformedDocumentError } from "@superbee/core";
import { resolveRecipe as resolveFromSources } from "@superbee/core/recipe-sources";
import type { LoadResult } from "@superbee/core/recipes";
import { CliError, frontmatterDetails } from "./errors.js";
import { registeredRecipe } from "./source-plugins.js";
import { builtinNames, builtinRecipeSource } from "./recipe-source-builtin.js";
import { filesRecipeSource } from "./recipe-source-filesystem.js";
import type { RecipeSource } from "./recipe-source-contract.js";

/** The default resolution order: registered source plugins, built-in names, then a filesystem path. */
export const DEFAULT_SOURCES: RecipeSource[] = [{kind:"files",resolve:registeredRecipe}, builtinRecipeSource(), filesRecipeSource()];

/** The recipe `init` applies when `--recipe` is omitted. */
export const DEFAULT_RECIPE_REF = "context-notes";

export async function resolveRecipe(ref: string, sources: RecipeSource[] = DEFAULT_SOURCES): Promise<LoadResult> {
  try {
    return await resolveFromSources(ref, sources, {
      notFoundMessage: (missing) =>
        `unknown recipe '${missing}' (built-ins: ${builtinNames().join(", ")}; registered source plugins: <plugin-id>:<recipe-key>; or a path to a recipe folder)`,
    });
  } catch (error) {
    // A recipe folder is caller input, so frontmatter it cannot parse is a usage error.
    if (error instanceof MalformedDocumentError) throw new CliError("USAGE", error.message, { details: frontmatterDetails(error) });
    throw error;
  }
}
