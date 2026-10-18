import test from "node:test";
import assert from "node:assert/strict";
import { BodyReplaceError } from "@superbee/core";
import { bootstrap, openLocalBundle, commitLocal, push, inspectConflict, resolveConflict } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime, createRequestDrivenRuntime } from "../src/platform/index.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createRemoteFixture } from "./fixtures/remote-fixture.ts";
import { setup, contested, immediate } from "./fixtures/body-resolution.ts";
const id = "notes/example";
const candidate = (body: string) => ({ id, frontmatter: { type: "Note" }, body });

test("person-authored editor saves permit link removal in request-driven and exact-document local modes", async () => {
  for (const mode of ["request-driven", "browser-local"] as const) {
    const remote = await createRemoteFixture();
    await remote.authority.write(id, candidate("[edge](target.md)"));
    const local = openLocalBundle("guard-test", { backend: new MemoryJournaledBackend() });
    try {
      await bootstrap(remote.remote, local);
      const runtime = mode === "request-driven" ? await createRequestDrivenRuntime({ remote: remote.remote }) : createBrowserLocalRuntime({ local, remote: remote.remote, transport: remote.transport });
      const observed = await runtime.read(id);
      const committed = await runtime.commit(id, { body: "deliberate removal", expectedVersion: observed.provenance.version });
      assert.equal(committed.changed, true);
      assert.equal((await runtime.read(id)).doc.body.trim(), "deliberate removal");
    } finally { local.close(); }
  }
});

test("body editor save and reviewed body conflict revision permit deliberate link removal", async () => {
  const s = await setup("memory");
  try {
    await s.runtime.commit(id, { body: "[edge](target.md)" });
    await s.runtime.commit(id, { body: "deliberate removal" });
    assert.equal((await s.runtime.read(id)).doc.body.trim(), "deliberate removal");
    await s.runtime.sync();
    await contested(s, "conflict", "local [edge](target.md)");
    const review = await inspectConflict(s.local, s.authority.backend, id);
    await resolveConflict(s.local, s.authority.backend, review, { kind: "revise", body: "reviewed removal" });
    assert.equal((await s.runtime.read(id)).doc.body.trim(), "reviewed removal");
  } finally { s.close(); }
});

test("reviewed exact-document conflict revision permits deliberate link removal", async () => {
  const remote = await createRemoteFixture();
  await remote.authority.write(id, candidate("original"));
  const local = openLocalBundle("guard-conflict", { backend: new MemoryJournaledBackend() });
  try {
    await bootstrap(remote.remote, local);
    await commitLocal(local, id, { buildCandidate: () => candidate("local [edge](target.md)") });
    await remote.authority.write(id, candidate("remote"));
    await push(local, remote.transport, { remote: remote.remote, write: immediate });
    const review = await inspectConflict(local, remote.remote, id);
    await resolveConflict(local, remote.remote, review, { kind: "revise", body: "reviewed removal" });
    assert.equal((await local.backend.read(id)).doc.body.trim(), "reviewed removal");
  } finally { local.close(); }
});

test("person-authored saves still refuse preview loss", async () => {
  const s = await setup("memory");
  try {
    await s.runtime.commit(id, { body: "x".repeat(1200) });
    await assert.rejects(() => s.runtime.commit(id, { body: "x".repeat(1000) }), BodyReplaceError);
    assert.equal((await s.runtime.read(id)).doc.body.trim().length, 1200);
  } finally { s.close(); }
});
