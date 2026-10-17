/**
 * `nonCanonicalDocumentId`: the one spelling a new document id may take, and why an id is outside
 * it. The cases are the host's own (superbee-hosted `test/canonical-document-ids.test.ts`) and the
 * CLI publish preview's refusals.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { nonCanonicalDocumentId } from "../src/paths.js";
import { nonCanonicalDocumentId as fromStorage } from "../src/storage.js";
import { nonCanonicalDocumentId as fromRoot } from "../src/index.js";

test("canonical id: one definition behind the storage and root exports", () => {
  assert.equal(fromStorage, nonCanonicalDocumentId);
  assert.equal(fromRoot, nonCanonicalDocumentId);
});

test("canonical id: whitespace at any segment edge and non-NFC ids are refused; interior spaces are not", () => {
  const whitespace = [
    " notes/space",
    "notes/space ",
    "notes /x",
    "notes/ x",
    "\tnotes/tab",
    "notes/nbsp ",
    "　notes/ideographic",
    "notes/ em",
    "notes/bom﻿",
    " notes/line-separator",
    "notes/nnbsp ",
  ];
  for (const id of whitespace) assert.equal(nonCanonicalDocumentId(id), "segment_whitespace", JSON.stringify(id));
  const nfd = ["notes/café", "notes/Å", "notes/가", "notes/Å", "notes/Ω"];
  for (const id of nfd) assert.equal(nonCanonicalDocumentId(id), "not_nfc", JSON.stringify(id));
  for (const id of ["notes/one", "notes/two words", "notes/café", "notes/가", "Notes/One", "notes/ｎｏｔｅ", "notes/İstanbul", "notes/ıd"]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: format characters are refused at a segment edge and inside a segment, except a joiner between visible characters", () => {
  const edges = [
    "​notes/one",
    "notes/one​",
    "notes​/one",
    "notes/​one",
    "notes/one⁠",
    "notes/­one",
    "notes/one‎",
    "‮notes/one",
    "notes/‍one",
    "notes/one‌",
    "notes/one\u{e0067}",
    "notes/\u{1d173}one",
    "notes/​",
    "notes/one​​",
  ];
  for (const id of edges) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  const inside = ["notes/on​e", "notes/o⁠ne", "notes/o­ne", "notes/a‮cod.exe", "notes/a⁦b⁩c", "notes/o\u{e0067}ne", "notes/o᠎ne"];
  for (const id of inside) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  // U+FEFF is a trimmed space as well as Cf; the whitespace rule names it first.
  assert.equal(nonCanonicalDocumentId("notes/one﻿"), "segment_whitespace");
  for (const id of [
    "notes/می‌خواهم",
    "notes/क्‍ष",
    "notes/\u{1f469}‍\u{1f4bb} work",
    "notes/❤️",
    "notes/one",
  ]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: the publish preview's refused spellings and its accepted joiner", () => {
  assert.deepEqual(
    ["notes/zero​width", "notes/​edge", "notes/edge⁠", "notes/a‮b", "notes/naïve"].map(nonCanonicalDocumentId),
    ["format_character", "format_character", "format_character", "format_character", "not_nfc"],
  );
  assert.equal(nonCanonicalDocumentId("notes/\u{1f469}‍\u{1f4bb}"), null);
});
