// searchRowText, SEARCH_TEXT_REVISION and the text version. The row-text golden for the running
// revision (fixtures/search-row-text-v<revision>.json, recorded by fixture-generators/search-row-text-fixture.mjs)
// must hold byte for byte: changing normalize, tokenize or searchRowText without bumping the revision
// fails here, and bumping it without recording a golden finds no fixture.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { createHash } from "node:crypto";

import { FINGERPRINT_SAMPLE } from "../src/search/row-text.js";
import {
  BODY_OCCURRENCE_CAP,
  memorySearchSource,
  normalizerFingerprint,
  phrase,
  searchRowText,
  textVersion,
  SEARCH_ALGORITHM,
  SEARCH_LIMITS,
  SEARCH_TEXT_REVISION,
  type SearchDocumentV1,
  type SearchRowTextV1,
} from "../src/search/index.js";

const fixtureUrl = new URL(`./fixtures/search-row-text-v${SEARCH_TEXT_REVISION}.json`, import.meta.url);
const serialize = (row: SearchRowTextV1) => ({ ...row, instances: [...row.instances] });

test("the row-text golden for the running SEARCH_TEXT_REVISION holds byte for byte", () => {
  assert.ok(existsSync(fixtureUrl), `no row-text golden for revision ${SEARCH_TEXT_REVISION}`);
  const golden = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
    algorithm: string;
    revision: number;
    rows: { document: SearchDocumentV1; rowText: ReturnType<typeof serialize> }[];
  };
  assert.equal(golden.algorithm, SEARCH_ALGORITHM);
  assert.equal(golden.revision, SEARCH_TEXT_REVISION);
  assert.equal(golden.rows.length, 12);
  for (const { document, rowText } of golden.rows) {
    const computed = serialize(searchRowText(document));
    assert.deepEqual(computed, rowText, document.id);
    assert.equal(JSON.stringify(computed), JSON.stringify(rowText), document.id);
  }
});

test("row text is each field's tokens in order, the body capped per term, and instances count exactly that text", () => {
  const golden = JSON.parse(readFileSync(fixtureUrl, "utf8")) as { rows: { document: SearchDocumentV1 }[] };
  const documents = golden.rows.map((row) => row.document);
  for (const document of documents) {
    const row = searchRowText(document);
    assert.equal(row.idPhrase, phrase(document.id));
    assert.equal(row.titlePhrase, phrase(typeof document.frontmatter.title === "string" ? document.frontmatter.title : ""));
    const columns = [row.idTerms, row.titleTerms, row.typeTerms, row.tagTerms, row.descriptionTerms, row.bodyTerms];
    const counted = new Map<string, number>();
    for (const term of columns.flatMap((column) => (column === "" ? [] : column.split(" "))))
      counted.set(term, (counted.get(term) ?? 0) + 1);
    assert.deepEqual([...row.instances].sort(), [...counted].sort(), document.id);
    const body = new Map<string, number>();
    for (const term of row.bodyTerms === "" ? [] : row.bodyTerms.split(" ")) body.set(term, (body.get(term) ?? 0) + 1);
    assert.ok([...body.values()].every((count) => count <= BODY_OCCURRENCE_CAP), document.id);
  }
  // The memory source's volume is the same count: the two owners of a document's text agree.
  const source = memorySearchSource(documents, { key: "row-text" });
  const terms = new Set(documents.flatMap((document) => [...searchRowText(document).instances.keys()]));
  return Promise.all(
    [...terms].map(async (term) => {
      const expected = documents.reduce((total, document) => total + (searchRowText(document).instances.get(term) ?? 0), 0);
      const batch = await source.evidence([term], {}, { maxInstances: SEARCH_LIMITS.maxEvidenceInstances });
      assert.equal(batch.volume, expected, term);
    }),
  );
});

test("bodyTermCount counts every body token before the cap, so a host can skip what the index cannot hold", () => {
  const row = searchRowText({ id: "long", version: "v", frontmatter: {}, body: "w ".repeat(SEARCH_LIMITS.maxTermsPerDocument + 1) });
  assert.equal(row.bodyTermCount, SEARCH_LIMITS.maxTermsPerDocument + 1);
  assert.equal(row.bodyTerms, Array(BODY_OCCURRENCE_CAP).fill("w").join(" "));
  assert.equal(row.instances.get("w"), BODY_OCCURRENCE_CAP);
});

test("the text version names the algorithm, the text revision and this runtime's normalizer fingerprint", () => {
  const fingerprint = normalizerFingerprint();
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(normalizerFingerprint(), fingerprint);
  assert.equal(textVersion(), `${SEARCH_ALGORITHM}/${SEARCH_TEXT_REVISION}/${fingerprint}`);
  assert.equal(SEARCH_TEXT_REVISION, 1);
});

test("the fingerprint sample's text is pinned", () => {
  // The input text, not its normalized form, so a runtime whose Unicode tables differ still prints
  // another fingerprint. Changing the sample changes textVersion() everywhere and marks every stored
  // index row for re-derivation: change it only together with a planned backfill.
  assert.equal(
    createHash("sha256").update(JSON.stringify(FINGERPRINT_SAMPLE)).digest("hex"),
    "ecbed22daf459e266fbfc97831264eab6af6814cb0eec93d4434696cb56bbad1",
  );
});
