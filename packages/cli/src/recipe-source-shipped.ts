// The shipped-recipe acquisition adapter: a NAME resolves to a complete portable recipe folder
// carried by the running distribution (`<package root>/references/recipes/<name>/`). Like every
// other source it only acquires bytes — `parseRecipeFiles` still owns interpretation, and
// `readRecipeDir` still owns traversal and symlink containment.
//
// The package root is `dirname(dirname(executable))`, the same seam `skill install` resolves its
// assets from: `<pkg>/dist/superbee.mjs` in the npm layout and `packages/cli/dist/…` in a repo
// build both land on a root carrying `references/`.
//
// The npm projection is generated from `DISTRIBUTION_RESOURCES`, so the set of name-installable
// recipes is exactly the set of portable recipe folders this distribution ships — there is no
// second registry to keep in sync.
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseRecipeFiles, type RecipeSource } from "./recipe-parser.js";
import { readRecipeDir, RecipeUnsafePathSignal } from "./recipe-source-filesystem.js";
import { looksLikeRecipePath } from "./recipe-ref.js";
import { currentExecutableRealPath } from "./invocation.js";

/** Where a distribution keeps its portable recipe folders, relative to the package root. */
export const SHIPPED_RECIPES_SUBDIR = "references/recipes";

/**
 * A recipe NAME, not a path: one lowercase segment. `looksLikeRecipePath` has already rejected
 * anything containing a separator, so this exists to keep the remaining namespace conservative —
 * `.`/`..` and other filesystem-significant spellings never reach a `path.join`.
 */
const SHIPPED_RECIPE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The running distribution's package root, or undefined when it cannot be resolved. */
function packageRoot(): string | undefined {
  const executable = currentExecutableRealPath();
  return executable === undefined ? undefined : path.dirname(path.dirname(executable));
}

/**
 * Resolve shipped recipes from `root` (defaulting to the running distribution's package root).
 * Returns `null` for any ref this source does not own — a path-shaped ref, an unsafe name, a
 * distribution carrying no shipped recipes, or a name it does not ship — so the next source in
 * line still gets its turn.
 */
export function shippedRecipeSource(root: string | undefined = packageRoot()): RecipeSource {
  return {
    kind: "files",
    async resolve(ref) {
      if (root === undefined) return null;
      if (looksLikeRecipePath(ref) || !SHIPPED_RECIPE_NAME.test(ref)) return null;

      const recipesRoot = await fs.realpath(path.join(root, SHIPPED_RECIPES_SUBDIR)).catch(() => null);
      if (recipesRoot === null) return null;
      const dir = path.join(recipesRoot, ref);
      const real = await fs.realpath(dir).catch(() => null);
      // Containment is re-checked against the resolved recipes root: a symlinked recipe folder
      // pointing outside the distribution is not a shipped recipe.
      if (real === null || !real.startsWith(recipesRoot + path.sep)) return null;
      const stat = await fs.stat(real).catch(() => null);
      if (!stat?.isDirectory()) return null;

      try {
        return parseRecipeFiles(await readRecipeDir(real), real);
      } catch (err) {
        if (err instanceof RecipeUnsafePathSignal) {
          return {
            ok: false,
            error: {
              code: "RECIPE_UNSAFE_PATH",
              message: `shipped recipe '${ref}' contains an unsafe path: '${err.rel}' (${err.reason})`,
            },
          };
        }
        throw err;
      }
    },
  };
}

/** Every recipe name this distribution ships, sorted. Empty when it carries none. */
export async function shippedRecipeNames(root: string | undefined = packageRoot()): Promise<string[]> {
  if (root === undefined) return [];
  const entries = await fs.readdir(path.join(root, SHIPPED_RECIPES_SUBDIR), { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHIPPED_RECIPE_NAME.test(entry.name)) continue;
    const manifest = path.join(root, SHIPPED_RECIPES_SUBDIR, entry.name, "recipe.md");
    if (await fs.stat(manifest).then((s) => s.isFile()).catch(() => false)) names.push(entry.name);
  }
  return names.sort();
}
