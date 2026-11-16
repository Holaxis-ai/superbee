import test from "node:test";
import assert from "node:assert/strict";
import { list, query, queryHeads, queryEdges } from "../src/engine.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { CODE_UNIT_ORDER } from "../src/string-identity-agreement.js";

test("engine list, query, fallback and pushed-down heads agree on shared code-unit rows", async () => {
  const backend = new MemoryBackend();
  for (const id of [...CODE_UNIT_ORDER].reverse()) {
    await backend.write(id, { id, frontmatter: { type: "Note" }, body: "" });
  }
  for (const read of [list, query]) {
    assert.deepEqual((await read(backend)).map(row => row.id), CODE_UNIT_ORDER);
  }
  assert.deepEqual((await queryHeads(backend)).map(row => row.id), CODE_UNIT_ORDER);
  const pushed = Object.create(backend);
  pushed.queryHeads = async () => Promise.all([...CODE_UNIT_ORDER].reverse().map(async id => {
    const { doc, version } = await backend.read(id);
    return { id, frontmatter: doc.frontmatter, version };
  }));
  assert.deepEqual((await queryHeads(pushed)).map(row => row.id), CODE_UNIT_ORDER);
});

/**
 * Edge rows sort by code points, not code units: the order UTF-8 bytes sort in, so a store that
 * sorts in SQL agrees, and the relationship page's neighbor order. Written from the definition:
 * the code unit rows with U+E000 moved before the astral bee (U+1F41D), the one pair where the two
 * orders differ.
 */
const CODE_POINT_ORDER = [...CODE_UNIT_ORDER.filter(id => id !== "\uE000" && id !== "\u{1F41D}"), "\uE000", "\u{1F41D}"];

test("engine edges order each from, to and text tie-break by code points, so the astral row follows U+E000", async () => {
  assert.notDeepEqual(CODE_POINT_ORDER, CODE_UNIT_ORDER, "the rows exercise the pair where the orders differ");
  const backend = new MemoryBackend();
  const rows = [...CODE_UNIT_ORDER].reverse();
  for (const id of rows) {
    await backend.write(id, {
      id, frontmatter: { type: "Note" },
      body: rows.map(to => rows.map(text => `[${text}](${to}.md)`).join("\n")).join("\n"),
    });
  }
  assert.deepEqual((await queryEdges(backend)).map(({ from, to, text }) => [from, to, text]),
    CODE_POINT_ORDER.flatMap(from => CODE_POINT_ORDER.flatMap(to => CODE_POINT_ORDER.map(text => [from, to, text]))));
});

test("engine edges keep every authored occurrence of one link, in authored order", async () => {
  const backend = new MemoryBackend();
  await backend.write("a", { id: "a", frontmatter: { type: "Note" }, body: "[x](b.md#one) [x](b.md#two) [x](b.md)" });
  assert.deepEqual((await queryEdges(backend, { from: "a" })).map(({ href }) => href), ["b.md#one", "b.md#two", "b.md"]);
});
