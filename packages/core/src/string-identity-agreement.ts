/**
 * Agreement rows for the two string identity primitives core owns: {@link foldPath}
 * (`path-fold.ts`) and {@link compareCodeUnits} (`code-unit-order.ts`). Every expected value was
 * written from the definitions, not captured from running the code, so a host that imports or
 * copies these rows checks its own implementation against the definition, not against core.
 *
 * Shipped as a data-only module (no imports) under `@superbee/core/string-identity-agreement`, so a
 * host test can import the rows directly, and a host that cannot depend on core can copy the file
 * and compare its bytes. Strings use `\u` escapes so no editor or checkout can renormalize them.
 */

export interface PathFoldRow {
  /** What the row exercises. */
  readonly note: string;
  readonly input: string;
  /** `input` under NFC, lower, upper, lower, NFC. */
  readonly fold: string;
}

export const PATH_FOLD_ROWS: readonly PathFoldRow[] = Object.freeze([
  { note: "hyphen is not a letter", input: "a-b", fold: "a-b" },
  { note: "dot is not a letter", input: "a.b", fold: "a.b" },
  { note: "underscore is not a letter", input: "a_b", fold: "a_b" },
  { note: "digit is not a letter", input: "a2", fold: "a2" },
  { note: "plain lowercase is fixed", input: "ab", fold: "ab" },
  { note: "ASCII uppercase", input: "REFERENCES", fold: "references" },
  { note: "ASCII lowercase", input: "references", fold: "references" },
  { note: "mixed case", input: "References", fold: "references" },
  { note: "long s uppercases to S", input: "reference\u017F", fold: "references" },
  { note: "long s inside a word", input: "re\u017Fource", fold: "resource" },
  { note: "Kelvin sign meets K", input: "\u212A", fold: "k" },
  { note: "ASCII K", input: "K", fold: "k" },
  { note: "dotless i uppercases to I", input: "\u0131", fold: "i" },
  { note: "ASCII I", input: "I", fold: "i" },
  { note: "dotted capital I keeps its dot", input: "\u0130", fold: "i\u0307" },
  { note: "NFD e acute composes", input: "e\u0301", fold: "\u00E9" },
  { note: "NFC e acute", input: "\u00E9", fold: "\u00E9" },
  { note: "NFC capital E acute", input: "\u00C9", fold: "\u00E9" },
  { note: "NFD capital E acute", input: "E\u0301", fold: "\u00E9" },
  { note: "capital sharp s", input: "\u1E9E", fold: "ss" },
  { note: "sharp s", input: "\u00DF", fold: "ss" },
  { note: "fullwidth r is not compatibility folded", input: "\uFF52", fold: "\uFF52" },
  { note: "emoji has no case", input: "\u{1F41D}", fold: "\u{1F41D}" },
  { note: "astral capital Deseret long I", input: "\u{10400}", fold: "\u{10428}" },
  { note: "slash is untouched across segments", input: "Notes/Reference\u017F/A-B", fold: "notes/references/a-b" },
]);

/**
 * Pairs the fold treats as one file (same fold) or as two. The fold is deliberately wider than any
 * one disk: it also joins pairs some filesystems keep apart (NTFS holds `ß` and `ss` as two names),
 * so a refusal under it means "may merge somewhere", not "merges everywhere".
 */
export interface PathCollisionRow {
  readonly a: string;
  readonly b: string;
  readonly collide: boolean;
}

export const PATH_COLLISION_ROWS: readonly PathCollisionRow[] = Object.freeze([
  { a: "REFERENCES", b: "references", collide: true },
  { a: "reference\u017F", b: "references", collide: true },
  { a: "\u212A", b: "k", collide: true },
  { a: "\u0131", b: "i", collide: true },
  { a: "e\u0301", b: "\u00E9", collide: true },
  { a: "\u1E9E", b: "ss", collide: true },
  { a: "\u0130", b: "i", collide: false },
  { a: "a-b", b: "a_b", collide: false },
  { a: "a.b", b: "ab", collide: false },
  { a: "\uFF52", b: "r", collide: false },
]);

/**
 * Strings in UTF-16 code unit order. The emoji (lead surrogate U+D83D) sorts before U+E000, which
 * code point order and `localeCompare` would both place differently.
 */
export const CODE_UNIT_ORDER: readonly string[] = Object.freeze([
  "K",
  "REFERENCES",
  "a-b",
  "a.b",
  "a2",
  "a_b",
  "ab",
  "e\u0301",
  "i",
  "references",
  "referen\u017Fes",
  "\u00E9",
  "\u0131",
  "\u212A",
  "\u{1F41D}",
  "\uE000",
]);
