// CLI source routing only; optional content, parsing and the built-in source are core-owned.
import { resolveBuiltinSync } from "@superbee/core/builtin-recipes";
export { builtinNames, builtinRecipeSource, resolveBuiltinSync } from "@superbee/core/builtin-recipes";
export const CONTEXT_NOTES_RECIPE = resolveBuiltinSync("context-notes");
