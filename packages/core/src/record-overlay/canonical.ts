import { compareCodePoints } from "../code-point-order.js";

/**
 * The overlay comparison canon: `JSON.stringify` over a recursive copy whose object keys are sorted
 * by the default string order and whose `undefined` members are dropped, with no other handling.
 *
 * Module-private and deliberately distinct from core's other two canonicalizers
 * (`recipe-lifecycle/stamp.ts`, `site-capabilities.ts`). Overlay write decisions depend on its
 * exact semantics: an absent value and `null` differ, a `Date` is `{}`, a function member is
 * dropped, and a top-level `undefined` stays `undefined`. Merging it with either of the others is a
 * behaviour change for the three-value rule and the ownership guard.
 */
export function overlayCanonicalJson(value: unknown): string | undefined {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const source = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(source).sort()) if (source[k] !== undefined) out[k] = sortValue(source[k]);
    return out;
  }
  return v;
}

/** Equality under {@link overlayCanonicalJson}. */
export function same(a: unknown, b: unknown): boolean {
  return overlayCanonicalJson(a) === overlayCanonicalJson(b);
}

/**
 * Equality for a field the target Kind declares as a list type, which an owning feed treats as a
 * set: two lists are equal when they hold the same members, whatever their order and however often
 * a member repeats, each member compared under {@link overlayCanonicalJson}. Anything that is not
 * a list on both sides compares by {@link same}, so an absent list still differs from `[]`. A
 * separate function so `same()`, and with it every digest and the parity golden, never changes.
 */
export function sameSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return same(a, b);
  const members = (list: unknown[]): string[] => [...new Set(list.map((member) => overlayCanonicalJson(member) ?? "undefined"))].sort(compareCodePoints);
  const x = members(a);
  const y = members(b);
  return x.length === y.length && x.every((member, index) => member === y[index]);
}
