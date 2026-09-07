import type { LoadResult } from "@superbee/core/recipes";

/** A source returns null when it does not address a reference, or a failed result when loading fails. */
export interface RecipeSource {
  readonly kind: "builtin" | "files";
  resolve(ref: string): Promise<LoadResult | null>;
}
