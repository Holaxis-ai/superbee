// Unused-capability offers for session orientation (plan: proactive-onboarding-prompts).
//
// PURE derivation over facts home's ONE scan already produced (the by-type counts and the
// `conventions/` ids) plus the static builtin recipe registry — zero added I/O, so the home
// render's offline guarantee is untouched. The CLI supplies these FACTS; the Agent Skill's
// "Opening a session" section supplies the BEHAVIOR that turns them into an opener.
import { builtinNames, resolveBuiltinSync } from "./recipe-source-builtin.js";
import { isRecipeApplied } from "./recipes.js";

/** One ready-made offer: a builtin capability this bundle is not using, with its exact command. */
export interface OfferRow {
  recipe: string;
  offer: string;
  command: string;
}

/** Rendered next to `offers` rows — the intent guard that keeps offers from becoming pestering. */
export const OFFERS_HELP =
  "capabilities this bundle is not using — when the user is orienting rather than mid-request, " +
  "offer 2-3 as one-line options and ask which first; apply only after they choose";

/** Offers stay a glance, not a catalog; `recipes` remains the full listing. */
const OFFERS_CAP = 3;

/**
 * Derive the offer rows: for each builtin recipe (registry order), offer iff its conventions are
 * NOT applied AND the bundle holds zero docs of any type it governs — both facts from home's
 * existing fold. Governs matching is exact-string by design (a custom convention at a
 * non-standard id still yields the offer; applying it warns, never corrupts).
 */
export function deriveOffers(
  byType: Record<string, number>,
  conventionIds: Iterable<string>,
  invocation: string,
  targetDirSuffix = "",
): OfferRow[] {
  const applied = new Set(conventionIds);
  const rows: OfferRow[] = [];
  for (const name of builtinNames()) {
    if (rows.length >= OFFERS_CAP) break;
    const recipe = resolveBuiltinSync(name);
    if (isRecipeApplied(recipe, applied)) continue;
    if (recipe.governs.some((type) => (byType[type] ?? 0) > 0)) continue;
    rows.push({
      recipe: recipe.id,
      offer: recipe.offer,
      command: `${invocation} recipe add ${recipe.id}${targetDirSuffix}`,
    });
  }
  return rows;
}
