// Records searchRowText over a fixed sample as the row-text golden
// `test/fixtures/search-row-text-v<SEARCH_TEXT_REVISION>.json`. The test `search-row-text.test.ts`
// recomputes every row and compares bytes, so a change to normalize, tokenize or searchRowText fails
// until SEARCH_TEXT_REVISION is bumped and a golden for the new revision is recorded here.
//
//   cd packages/core && node --import ./test/ts-loader.mjs test/fixture-generators/search-row-text-fixture.mjs
//
// The sample keeps to characters whose Unicode properties every supported Node release agrees on;
// runtime drift is the normalizer fingerprint's job, not this golden's.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { searchRowText, SEARCH_ALGORITHM, SEARCH_TEXT_REVISION } from "../../src/search/index.js";

const DOCUMENTS = [
  // Every field, duplicate and non-string tags, an id with separators, repeated body terms.
  {
    id: "notes/Lock-Keeper_2",
    frontmatter: {
      title: "Lock Keeper's Log",
      type: "Field Note",
      tags: ["canal", "Canal", "history", 7, null, "canal"],
      description: "Daily entries, 1890 to 1901.",
    },
    body: "The lock keeper opened the lock.\n\nLock, lock; LOCK!\n",
  },
  // Compatibility characters: ligatures, full-width and half-width forms, fractions, squared and
  // circled forms, roman numerals, superscripts, the micro sign.
  { id: "unicode/compat", frontmatter: { title: "ﬁnal ﬂow" }, body: "ＡＢＣ ½ ℀ ㎃ ① Ⅸ ⁵ µ ㍿ ｶﾞ\n" },
  // Combining sequences: decomposed and precomposed letters, the angstrom sign, conjoining jamo,
  // a nukta.
  {
    id: "unicode/combining",
    frontmatter: { title: "Café" },
    body: "café café Å Å Å ño 가 क़\n",
  },
  // Case pairs across scripts: Greek final sigma, titlecase digraphs, dotted capital I, capital
  // sharp s, Cherokee, Georgian Mtavruli, Cyrillic, an Armenian ligature.
  {
    id: "unicode/case",
    frontmatter: { title: "ΟΔΟΣ", description: "Σίσυφος ǅ Ǆ ǆ" },
    body: "İstanbul ISTANBUL ẞ ß Ꭰ ꭰ Ა ა Москва МОСКВА Երևան\n",
  },
  // Scripts whose marks split tokens, and scripts without spaces.
  {
    id: "unicode/scripts",
    frontmatter: { title: "中文検索", tags: ["البحث", "खोज"] },
    body: "中文 検索 ค้นหา 검색 البحث खोज\n",
  },
  // Digits from several scripts, mixed letters and numbers.
  { id: "notes/digits", frontmatter: { type: "Note" }, body: "Route 66, v2.0, 3rd; ٣ ໓ ½\n" },
  // Symbols and emoji contribute nothing.
  { id: "notes/emoji", frontmatter: { title: "🐝 Bee" }, body: "🐝 ❤️ ★ ✓ bee\n" },
  // The body cap: 30 occurrences keep 20; terms interleaved keep their first 20 each, in order.
  { id: "counts/capped", frontmatter: { title: "Echo" }, body: `${"echo ".repeat(30)}${"delta ".repeat(3)}\n` },
  { id: "counts/interleaved", frontmatter: {}, body: "a b ".repeat(25) },
  // Non-string title, type, tags and description contribute nothing.
  { id: "fields/odd", frontmatter: { title: 42, type: ["Note"], tags: "single", description: null }, body: "odd fields\n" },
  { id: "empty", frontmatter: {}, body: "" },
  { id: "Alpha/Beta.Gamma", frontmatter: { title: "alpha beta gamma" }, body: "" },
].map((document) => ({ id: document.id, version: `v:${document.id}`, frontmatter: document.frontmatter, body: document.body }));

function serializeRowText(row) {
  return { ...row, instances: [...row.instances] };
}

const fixture = {
  algorithm: SEARCH_ALGORITHM,
  revision: SEARCH_TEXT_REVISION,
  rows: DOCUMENTS.map((document) => ({ document, rowText: serializeRowText(searchRowText(document)) })),
};
const out = fileURLToPath(new URL(`../fixtures/search-row-text-v${SEARCH_TEXT_REVISION}.json`, import.meta.url));
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${fixture.rows.length} rows at text revision ${SEARCH_TEXT_REVISION} to ${out}`);
