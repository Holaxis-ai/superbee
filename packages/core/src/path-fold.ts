/**
 * The one fold for "would these two paths land on the same file?". The portable export's
 * collision check uses it here, and hosts that fence writes or gate pushes import it from
 * `@superbee/core/path-fold`, so the checks cannot drift apart.
 *
 * One definition: NFC, then `toLowerCase()`, `toUpperCase()`, `toLowerCase()`, then NFC again.
 *
 * - NFC first: macOS filesystems and Git checkouts treat canonically equivalent spellings (`é` and
 *   `e` + U+0301) as one name.
 * - The uppercase step: case-insensitive filesystems compare through an uppercase table (NTFS's
 *   `$UpCase`), so any character whose uppercase is an ASCII letter meets that letter. `ſ` (U+017F,
 *   long s) uppercases to `S`, so `referenceſ` is `REFERENCES` to Windows; `toLowerCase()` alone
 *   leaves it distinct. The Kelvin sign (U+212A) and `ı` (U+0131, dotless i) meet `k` and `i`.
 * - The leading lowercase step: a capital with no single-character uppercase partner must reach
 *   the same form as its lowercase. `ẞ` (U+1E9E, capital sharp s) is its own uppercase and
 *   lowercases to `ß`, whose uppercase is `SS`; uppercasing first would stop at `ß` while `ß`
 *   itself folds to `ss`. Lowercasing first sends `ẞ`, `ß`, `SS` and `ss` to one `ss`.
 * - The trailing NFC: a case mapping can leave a sequence NFC would compose (the uppercase of `ΐ`,
 *   U+0390, is decomposed), so the result is recomposed and the fold is idempotent.
 *
 * Every code point then meets its own uppercase and lowercase, and `foldPath(foldPath(p))` is
 * `foldPath(p)`. The one exception Unicode itself leaves open is the combining iota subscript
 * (U+0345, and the precomposed Greek letters that carry it): uppercasing turns it into a spacing
 * capital iota at a different place in the canonical order, so a few spellings of it stay apart.
 * No filesystem equates those either. Turkish `İ` (U+0130) lowercases to `i` + U+0307 and keeps its
 * dot, so it never meets ASCII `i`; that matches every filesystem, none of which applies Turkish
 * casing. Folding more than a filesystem does only refuses more, which is the safe direction for a
 * fence and for the export's collision check.
 *
 * NFKC is deliberately not used. No filesystem applies compatibility folding (fullwidth `ｒ` stays a
 * distinct name everywhere), and NFKC would make the export refuse archives that extract cleanly.
 *
 * `/` has no case mapping and no decomposition, so folding a whole path equals folding each segment.
 * The agreement rows in `string-identity-agreement.ts` pin this definition for every host.
 *
 * Dependency-free on purpose, so pure modules and browser bundles can import it.
 */
export function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}
