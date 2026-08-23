import assert from "node:assert/strict";
import test from "node:test";

import { MemoryBackend } from "@superbee/core";
import { createRouterForBackend, WIRE_ENDPOINTS } from "../src/router.js";

function concretePath(path: string): string {
  return path
    .replace("{bundle}", "default")
    .replace("{id...}", "concepts/a")
    .replace("{name}", "log.md")
    .replace("{key...}", "assets/a.bin");
}

function requestBody(id: string): { body?: string; headers?: Record<string, string> } {
  if (id === "docs-read-many") {
    return { body: JSON.stringify({ ids: [] }), headers: { "content-type": "application/json" } };
  }
  if (id === "doc-write") {
    return {
      body: JSON.stringify({ frontmatter: { type: "Concept" }, body: "A" }),
      headers: { "content-type": "application/json" },
    };
  }
  if (id === "reserved-write") {
    return { body: JSON.stringify({ content: "log" }), headers: { "content-type": "application/json" } };
  }
  if (id === "blob-write") return { body: "blob", headers: { "content-type": "application/octet-stream" } };
  return {};
}

test("every declared wire endpoint reaches runtime dispatch and undeclared method pairs are refused", async () => {
  const router = createRouterForBackend(new MemoryBackend());

  for (const endpoint of WIRE_ENDPOINTS) {
    const response = await router(
      new Request(`http://wire.local${concretePath(endpoint.path)}`, {
        method: endpoint.method,
        ...requestBody(endpoint.id),
      }),
    );
    const body = endpoint.method === "HEAD" ? "" : await response.text();
    assert.doesNotMatch(body, /no route for|unsupported method/, `${endpoint.method} ${endpoint.path} must dispatch`);
  }

  const undeclared = await router(new Request("http://wire.local/v0/capabilities", { method: "POST" }));
  assert.equal(undeclared.status, 400);
  assert.match(await undeclared.text(), /unsupported method POST for \/v0\/capabilities/);
});
