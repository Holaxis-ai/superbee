/**
 * The one fold for "would these two paths land on the same file?". The portable export's
 * collision check uses it here, the filesystem backend's lock keys and spelling checks and the
 * document transfer's collision checks derive from it (`identity-fold.ts`), and hosts that fence
 * writes or gate pushes import it from `@superbee/core/path-fold`, so the checks cannot drift apart.
 *
 * One definition: NFD, then `toLowerCase()`, `toUpperCase()`, `toLowerCase()`, then NFC.
 *
 * - NFD first: macOS filesystems, ext4 casefold and Git checkouts treat canonically equivalent
 *   spellings (`é` and `e` + U+0301) as one name, and APFS, HFS+ and ext4 casefold all decompose
 *   before they compare case. Folding the decomposed form keeps every combining mark in the
 *   canonical order those filesystems compare in. That matters for the iota subscript (U+0345,
 *   and the precomposed Greek letters that carry it): it sorts after the other marks on its
 *   base, and its case mapping is a spacing iota, so folding a composed letter would put a
 *   following mark after the iota while the decomposing filesystems keep it before. `ᾩ` + U+034D
 *   and `ὡ` + U+034D + `ι` are one name on those filesystems and fold together here.
 * - The uppercase step: case-insensitive filesystems compare through an uppercase table (NTFS's
 *   `$UpCase`), so any character whose uppercase is an ASCII letter meets that letter. `ſ` (U+017F,
 *   long s) uppercases to `S`, so `referenceſ` is `REFERENCES` to Windows; `toLowerCase()` alone
 *   leaves it distinct. `ı` (U+0131, dotless i) likewise meets `i` only through the uppercase step.
 * - The leading lowercase step: a capital with no single-character uppercase partner must reach
 *   the same form as its lowercase. `ẞ` (U+1E9E, capital sharp s) is its own uppercase and
 *   lowercases to `ß`, whose uppercase is `SS`; uppercasing first would stop at `ß` while `ß`
 *   itself folds to `ss`. Lowercasing first sends `ẞ`, `ß`, `SS` and `ss` to one `ss`.
 * - The trailing NFC: the result is one canonical spelling, so equal folds are equal strings and
 *   the fold is idempotent.
 *
 * Every code point then meets its own uppercase and lowercase, and `foldPath(foldPath(p))` is
 * `foldPath(p)`. The case mapping of the iota subscript still leaves one pair apart: a subscript
 * followed by another mark and a spacing iota followed by that mark. The decomposing filesystems
 * keep that pair apart too. Turkish `İ` (U+0130) lowercases to `i` + U+0307 and keeps its dot, so
 * it never meets ASCII `i`; that matches every filesystem, none of which applies Turkish casing.
 * Folding more than a filesystem does only refuses more, which is the safe direction for a fence,
 * a lock key and the export's collision check.
 *
 * Compatibility decomposition (NFKD, NFKC) is deliberately not used. No supported filesystem
 * applies it: APFS and HFS+ store and compare canonical decompositions, ext4 casefold builds its
 * tables from canonical decompositions only and skips the compatibility-tagged ones, and NTFS
 * applies no normalization. Fullwidth `ｒ` and circled `①` stay names distinct from `r` and `1`
 * everywhere, and a compatibility fold would make the export refuse archives that extract cleanly.
 *
 * Not covered: case-insensitive HFS+ also ignores some code points inside a name (U+200C, U+200D,
 * U+FEFF, U+206A and their kind), so it joins `a` + U+200D + `b` with `ab`. This fold keeps
 * those apart.
 *
 * `/` has no case mapping and no decomposition, so folding a whole path equals folding each segment.
 * The agreement rows in `string-identity-agreement.ts` pin this definition for every host.
 *
 * Dependency-free on purpose, so pure modules and browser bundles can import it.
 */
export function foldPath(path: string): string {
  return path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}
