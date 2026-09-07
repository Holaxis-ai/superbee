import assert from "node:assert/strict";
import test from "node:test";

import { MemoryBackend } from "@superbee/core";

import { createRouterForBackend } from "../src/legacy-router.js";

test("Node root privately preserves the historical default bundle route and advisory attribution", async () => {
  const backend = new MemoryBackend();
  const router = createRouterForBackend(backend);
  const write = await router(
    new Request("http://wire.local/v0/bundles/default/docs/concepts/legacy", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-actor": "legacy-actor", "x-agent": "legacy-agent" },
      body: JSON.stringify({ frontmatter: { type: "Concept", title: "Legacy" }, body: "same wire" }),
    }),
  );
  assert.equal(write.status, 200);

  const read = await router(new Request("http://wire.local/v0/bundles/default/docs/concepts/legacy"));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    id: "concepts/legacy",
    frontmatter: { type: "Concept", title: "Legacy", timestamp: (await backend.read("concepts/legacy")).doc.frontmatter.timestamp },
    body: "same wire",
  });
  assert.deepEqual(
    (await backend.versions("concepts/legacy")).map(({ actor, agent }) => ({ actor, agent })),
    [{ actor: "legacy-actor", agent: "legacy-agent" }],
  );
});
