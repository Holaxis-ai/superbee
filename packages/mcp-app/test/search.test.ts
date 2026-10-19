import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend, versionOfBytes, type Bundle } from "@superbee/core";
import { searchSourceFromBackend, searchDocuments } from "@superbee/core/search";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpAppServer } from "../src/index.js";

async function bundle(root: string, word: string): Promise<Bundle> {
  const backend = new MemoryBackend();
  for (let i = 0; i < 3; i++) await backend.write(`notes/${i}`, { id: `notes/${i}`, frontmatter: { type: "Note", tags: ["blue"] }, body: word });
  return { root, backend };
}
async function clientFor(options: Parameters<typeof createMcpAppServer>[0], t: { after(fn: () => Promise<void>): void }) {
  const server = createMcpAppServer(options);
  const client = new Client({ name: "search-test", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("MCP search preserves workspace selection, early validation and core result parity", async (t) => {
  const a = await bundle("mem://a", "alpha"); const b = await bundle("mem://b", "beta");
  const opened: string[] = [];
  const client = await clientFor({ workspaceResolver: {
    list: async () => [],
    open: async (selector) => { opened.push(selector); if (selector === "a") return { bundle: a, name: "a" }; if (selector === "b") return { bundle: b, name: "b" }; throw new Error("/private/local/path"); },
  } }, t);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "search_documents", arguments: args });
  for (const args of [{ query: "alpha" }, { query: "!!!", workspace: "a" }, { query: "alpha", workspace: "a", cursor: "!" }, { query: "alpha", workspace: "a", prefix: "../" }, { query: "alpha", workspace: "a", dir: "/tmp" }, { query: "alpha", workspace: "a", limit: 51 }])
    assert.equal((await call(args)).isError, true);
  assert.deepEqual(opened, []);
  const request = { query: "alpha", limit: 1, facets: ["type", "tags"] as const };
  const first = await call({ ...request, workspace: "a" });
  const expected = await searchDocuments(await searchSourceFromBackend(a.backend!), request, { scope: versionOfBytes(a.root) });
  assert.deepEqual(first.structuredContent, expected);
  assert.equal(JSON.stringify(first).includes(a.root), false);
  assert.equal((await call({ ...request, workspace: "b" })).structuredContent?.total, 0);
  assert.equal((await call({ ...request, workspace: "b", cursor: expected.nextCursor })).isError, true);
  const missing = await call({ ...request, workspace: "unknown" });
  assert.equal(missing.isError, true); assert.equal(JSON.stringify(missing).includes("/private/local/path"), false);
});

test("fixed MCP searches only configured bundle and rejects workspace or arbitrary path inputs", async (t) => {
  const selected = await bundle("mem://fixed", "alpha");
  const client = await clientFor({ bundle: selected }, t);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "search_documents", arguments: args });
  assert.equal((await call({ query: "alpha" })).structuredContent?.total, 3);
  assert.equal((await call({ query: "alpha", workspace: "other" })).isError, true);
  assert.equal((await call({ query: "alpha", dir: "/tmp" })).isError, true);
  await selected.backend!.write("notes/0", { id: "notes/0", frontmatter: { type: "Note" }, body: "unsentneedle" });
  assert.equal((await call({ query: "unsentneedle" })).structuredContent?.total, 1);
  await selected.backend!.write("large", { id: "large", frontmatter: { type: "Note", title: "x".repeat(70_000) }, body: "oversizedneedle" });
  const oversized = await call({ query: "oversizedneedle" });
  assert.equal(oversized.isError, true);
  assert.ok(JSON.stringify(oversized).length < 1000);
});
