/**
 * The one string order for lists Superbee treats as sets (a declared `string-list` or
 * `https-url-list` a connector owns): Unicode code point order. JavaScript's default `sort()`
 * orders UTF-16 code units, which puts an astral character (an emoji, common in labels) before
 * U+E000 to U+FFFF. A lone surrogate orders by its own value. Storage-neutral.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
