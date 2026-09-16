import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, RemoteBackend } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootstrap, isComplete, openLocalBundle } from "../src/local-bundle.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";

test("late incompatible snapshot metadata leaves bootstrap incomplete and does not reconcile deletions", async () => {
  const authority = new MemoryBackend();
  for (let index = 0; index < 51; index++) {
    const id = `notes/${String(index).padStart(3, "0")}`;
    await authority.write(id, { id, frontmatter: { type: "Note", extra: index === 50 ? Infinity : index }, body: "hello" });
  }
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "default", fetchImpl: createRouter({ root: "memory://test", backend: authority }), maxRetries: 0 });
  const local = openLocalBundle("response-loss", { backend: new MemoryJournaledBackend() });
  try {
    await local.backend.write("notes/local", { id: "notes/local", frontmatter: { type: "Note" }, body: "keep" });
    let hydrated = 0;
    await assert.rejects(bootstrap(remote, local, { batchSize: 1, onHydrated: () => { hydrated++; } }));
    assert.equal(hydrated, 50, "valid first server batch reaches the working copy");
    assert.equal(await isComplete(local), false);
    assert.equal((await local.backend.readMeta<{ headsDigest?: string }>("bootstrap"))?.headsDigest, undefined);
    assert.equal((await local.backend.read("notes/local")).doc.body.trim(), "keep");
    await authority.write("notes/050", { id: "notes/050", frontmatter: { type: "Note", extra: 50 }, body: "hello" });
    const completed = await bootstrap(remote, local);
    assert.equal(completed.complete, true);
    assert.equal(completed.documentCount, 51);
    assert.ok(completed.headsDigest);
  } finally { local.close(); }
});
