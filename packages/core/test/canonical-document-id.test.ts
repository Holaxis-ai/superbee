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
    "notes/nbsp\u{a0}",
    "\u{3000}notes/ideographic",
    "notes/\u{2003}em",
    "notes/bom\u{feff}",
    "\u{2028}notes/line-separator",
    "notes/nnbsp\u{202f}",
  ];
  for (const id of whitespace) assert.equal(nonCanonicalDocumentId(id), "segment_whitespace", JSON.stringify(id));
  const nfd = ["notes/cafe\u{301}", "notes/A\u{30a}", "notes/가", "notes/Å", "notes/Ω"];
  for (const id of nfd) assert.equal(nonCanonicalDocumentId(id), "not_nfc", JSON.stringify(id));
  for (const id of ["notes/one", "notes/two words", "notes/café", "notes/가", "Notes/One", "notes/ｎｏｔｅ", "notes/İstanbul", "notes/ıd"]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: format characters are refused at a segment edge and inside a segment, except a joiner between visible characters", () => {
  const edges = [
    "\u{200b}notes/one",
    "notes/one\u{200b}",
    "notes\u{200b}/one",
    "notes/\u{200b}one",
    "notes/one\u{2060}",
    "notes/\u{ad}one",
    "notes/one\u{200e}",
    "\u{202e}notes/one",
    "notes/\u{200d}one",
    "notes/one\u{200c}",
    "notes/one\u{e0067}",
    "notes/\u{1d173}one",
    "notes/\u{200b}",
    "notes/one\u{200b}\u{200b}",
  ];
  for (const id of edges) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  const inside = ["notes/on\u{200b}e", "notes/o\u{2060}ne", "notes/o\u{ad}ne", "notes/a\u{202e}cod.exe", "notes/a\u{2066}b\u{2069}c", "notes/o\u{e0067}ne", "notes/o\u{180e}ne"];
  for (const id of inside) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  // U+FEFF is a trimmed space as well as Cf; the whitespace rule names it first.
  assert.equal(nonCanonicalDocumentId("notes/one\u{feff}"), "segment_whitespace");
  for (const id of [
    "notes/می\u{200c}خواهم",
    "notes/क\u{94d}\u{200d}ष",
    "notes/\u{1f469}\u{200d}\u{1f4bb} work",
    "notes/❤\u{fe0f}",
    "notes/one",
  ]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: the publish preview's refused spellings and its accepted joiner", () => {
  assert.deepEqual(
    ["notes/zero\u{200b}width", "notes/\u{200b}edge", "notes/edge\u{2060}", "notes/a\u{202e}b", "notes/nai\u{308}ve"].map(nonCanonicalDocumentId),
    ["format_character", "format_character", "format_character", "format_character", "not_nfc"],
  );
  assert.equal(nonCanonicalDocumentId("notes/\u{1f469}\u{200d}\u{1f4bb}"), null);
});
