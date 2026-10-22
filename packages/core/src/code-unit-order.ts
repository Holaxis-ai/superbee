/**
 * The one deterministic order for ids and other strings a protocol or a digest sorts: UTF-16 code
 * unit order, which is what plain `<` on JavaScript strings computes. Every host computes it
 * identically. `localeCompare` does not: its collation depends on the platform's ICU data and
 * locale, so two hosts can order the same ids differently.
 *
 * This differs from {@link compareCodePoints} (`code-point-order.ts`) only for astral characters:
 * a surrogate pair (an emoji, U+D800 to U+DFFF as code units) orders before U+E000 to U+FFFF here
 * and after them there. Use code point order for set-valued lists a connector owns; use this order
 * for ids, tie breaks and anything a wire digest or an existing order already fixed to code units.
 *
 * Dependency-free and pure.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
