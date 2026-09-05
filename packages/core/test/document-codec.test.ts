import assert from "node:assert/strict";
import test from "node:test";
import matter from "gray-matter";
import { parseMarkdown, stringifyDoc, stringifyWithData, versionFromBytes } from "../src/document-codec.js";
import * as legacy from "../src/frontmatter.js";
import { blobVersion, contentVersion } from "../src/versioning.js";
import type { Frontmatter } from "../src/types.js";

test("document codec exports the existing parser and serializer identities", () => {
  assert.equal(parseMarkdown, legacy.parseMarkdown);
  assert.equal(stringifyDoc, legacy.stringifyDoc);
  assert.equal(stringifyWithData, legacy.stringifyWithData);
});

test("portable serialization retains gray-matter YAML bytes", () => {
  for (const data of [
    {}, { type: "Note", nested: { date: "2026-09-04", tags: ["a", "b"] } },
    { type: "Note", multiline: "one\ntwo\n", number: 1, truth: true, null: null },
    { type: "Note", timestamp: new Date("2026-09-04T00:00:00.000Z"), infinity: Infinity },
  ]) {
    for (const body of ["", "body", "body\n", "\nbody\r\n"]) {
      assert.equal(stringifyWithData(data, body), matter.stringify(body, data));
    }
  }
});

test("codec bytes have the same versions as Node document and binary backends", async () => {
  const doc = { id: "notes/one", frontmatter: { type: "Note", unknown: "kept" } as Frontmatter, body: "body" };
  assert.equal(await versionFromBytes(new TextEncoder().encode(stringifyDoc(doc.frontmatter, doc.body))), contentVersion(doc));
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 128, 1]), new TextEncoder().encode("🐝")]) {
    assert.equal(await versionFromBytes(bytes), blobVersion(bytes));
  }
});

test("codec preserves BOM, nested dates, body bytes, and malformed-document identity", () => {
  const read = parseMarkdown("\uFEFF---\r\ntype: Note\r\nnested:\r\n  date: 2026-09-04\r\n---\r\nbody\r\n");
  assert.deepEqual(read.frontmatter.nested, { date: "2026-09-04" });
  assert.equal(read.body, "body\r\n");
  assert.throws(() => parseMarkdown("---\ntype: Note", "notes/bad"), legacy.MalformedDocumentError);
});
