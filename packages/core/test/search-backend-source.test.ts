import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend } from "../src/memory-backend.js";
import { headsDigest } from "../src/heads-digest.js";
import { searchSourceFromBackend, memorySearchSource, searchDocuments, validateSearchRequest, SearchLimitError } from "../src/search/index.js";

async function fixture(count = 3) {
  const backend = new MemoryBackend();
  for (let i = 0; i < count; i++) await backend.write(`notes/${i}`, { id: `notes/${i}`, frontmatter: { type: "Note", tags: ["blue"] }, body: "alpha beta" });
  return backend;
}

test("backend source agrees with memory search and binds actual read versions", async () => {
  const backend = await fixture();
  const documents = (await backend.readMany(await backend.list())).map(({ doc, version }) => ({ ...doc, version }));
  const source = await searchSourceFromBackend(backend);
  assert.equal(source.key, headsDigest(documents));
  const request = { query: "alpha", limit: 1, facets: ["type", "tags"] as const };
  assert.deepEqual(await searchDocuments(source, request), await searchDocuments(memorySearchSource(documents, { key: headsDigest(documents) }), request));
  const first = await searchDocuments(source, request, { scope: "a" });
  assert.ok(first.nextCursor);
  await assert.rejects(searchDocuments(source, { ...request, cursor: first.nextCursor }, { scope: "b" }), { reason: "cursor" });
  await backend.write("notes/2", { id: "notes/2", frontmatter: { type: "Note" }, body: "alpha changed" });
  await assert.rejects(searchDocuments(await searchSourceFromBackend(backend), { ...request, cursor: first.nextCursor }, { scope: "a" }), { reason: "cursor" });
});

test("backend source checks options and count before reads, bytes between batches, and refuses failed reads", async () => {
  const backend = await fixture(129);
  const read = backend.readMany.bind(backend);
  let calls = 0;
  backend.readMany = async (ids) => { calls++; assert.ok(ids.length <= 128); return read(ids); };
  await assert.rejects(searchSourceFromBackend(backend, { maxDocuments: 1 }), SearchLimitError);
  await assert.rejects(searchSourceFromBackend(backend, { maxDocuments: 0 }), TypeError);
  assert.equal(calls, 0);
  await assert.rejects(searchSourceFromBackend(backend, { maxSourceBytes: 1 }), SearchLimitError);
  assert.equal(calls, 1);
  await searchSourceFromBackend(backend);
  assert.equal(calls, 3);
  backend.readMany = async () => { throw new Error("unreadable"); };
  await assert.rejects(searchSourceFromBackend(backend), /unreadable/);
  backend.readMany = async () => [];
  await assert.rejects(searchSourceFromBackend(backend), /incomplete batch/);
});

test("canonical prefixes are literal, root is omitted, aliases refuse before backend access", () => {
  for (const prefix of ["notes/", "notes/a", "notes.md", "café/"])
    assert.equal(validateSearchRequest({ query: "alpha", prefix }).prefix, prefix);
  for (const prefix of ["", "/", "/notes", "../notes", "notes/../", "notes//", "./notes", "a\\b", "a\u0000b", "C:notes", "a.md/b"])
    assert.throws(() => validateSearchRequest({ query: "alpha", prefix }), { reason: "filter" }, prefix);
});
