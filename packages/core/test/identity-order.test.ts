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

test("engine edges order each from, to and text tie-break by shared code-unit rows", async () => {
  const backend = new MemoryBackend();
  const rows = [...CODE_UNIT_ORDER].reverse();
  for (const id of rows) {
    await backend.write(id, {
      id, frontmatter: { type: "Note" },
      body: rows.map(to => rows.map(text => `[${text}](${to}.md)`).join("\n")).join("\n"),
    });
  }
  assert.deepEqual((await queryEdges(backend)).map(({ from, to, text }) => [from, to, text]),
    CODE_UNIT_ORDER.flatMap(from => CODE_UNIT_ORDER.flatMap(to => CODE_UNIT_ORDER.map(text => [from, to, text]))));
});
