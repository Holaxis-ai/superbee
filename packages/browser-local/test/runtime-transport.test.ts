/**
 * The runtime's transport rule. A body-mode working copy delivers every intent through
 * `bodyTransport`, so its host may build the runtime without the exact-document transport; any
 * other working copy needs that transport, and a runtime built without it says so at its first
 * sync, before any intent is claimed, instead of delivering nothing. Both cases run over the
 * synthetic body authority, whose exact-document side is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackend } from "@superbee/core/indexeddb-backend";
import { InvalidInputError } from "@superbee/core/storage";
import { openLocalBundle, bootstrap } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createBodyAuthority } from "./fixtures/body-authority.ts";

const immediate = { sleep: async () => {}, lookupDelayMs: 0, maxLookups: 1 };
const now = () => "2026-09-15T00:30:00.000Z";

for (const adapter of ["memory", "indexeddb"] as const) {
  test(`${adapter}: a body-mode runtime built with bodyTransport alone delivers its body intents and confirms them`, async () => {
    const backend = adapter === "memory" ? new MemoryJournaledBackend() : new IndexedDbBackend({ databaseName: crypto.randomUUID(), indexedDB: new IDBFactory() });
    const local = openLocalBundle("body-only-transport", { backend, bodyDelivery: { scope: "fixture", okfVersion: "0.2", dedicated: true } });
    const authority = await createBodyAuthority();
    try {
      await bootstrap(authority.backend, local);
      const runtime = createBrowserLocalRuntime({ local, remote: authority.backend, bodyTransport: authority.transport, actor: "process:local", now, write: immediate });
      const before = await runtime.read("notes/example");
      await runtime.commit("notes/example", { body: "Edited without an exact-document transport", expectedVersion: before.provenance.version });
      assert.equal((await runtime.read("notes/example")).provenance.state, "local-pending");
      const status = await runtime.sync();
      assert.equal(status.pending, 0);
      assert.equal(status.lastSync?.ok, true);
      assert.equal((await runtime.read("notes/example")).provenance.state, "shared-confirmed");
      assert.equal(authority.counts.applied, 1);
      assert.equal((await authority.backend.read("notes/example")).doc.body, "Edited without an exact-document transport\n");
    } finally { local.close(); }
  });
}

test("a working copy outside body mode built without the exact-document transport rejects its first sync, claims nothing, and delivers nothing", async () => {
  const local = openLocalBundle("exact-transport-missing", { indexedDB: new IDBFactory() });
  const authority = await createBodyAuthority();
  try {
    await bootstrap(authority.backend, local);
    const runtime = createBrowserLocalRuntime({ local, remote: authority.backend, bodyTransport: authority.transport, actor: "process:local", now, write: immediate });
    const before = await runtime.read("notes/example");
    await runtime.commit("notes/example", { body: "Edited in exact-document mode", expectedVersion: before.provenance.version });
    await assert.rejects(
      runtime.sync(),
      (err: unknown) => err instanceof InvalidInputError && /not in body mode/.test(err.message) && /exact-document transport/.test(err.message),
      "the rejection names the mode and the missing transport",
    );
    const intents = await local.backend.listIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.state, "pending", "nothing was claimed");
    assert.equal(intents[0]!.attempts, 0, "nothing was attempted");
    assert.deepEqual(authority.counts, { submitted: 0, lookedUp: 0, applied: 0 }, "nothing reached the authority");
    assert.equal((await authority.backend.read("notes/example")).doc.body, "Original body\n");
    const status = await runtime.syncStatus();
    assert.equal(status.pending, 1);
    assert.equal(status.lastSync?.ok, false);
    assert.match(status.lastSync?.error ?? "", /^InvalidInputError: /);
    assert.equal((await runtime.read("notes/example")).provenance.state, "local-pending");
  } finally { local.close(); }
});

test("a runtime built with neither transport is refused at construction", async () => {
  const local = openLocalBundle("no-transport", { indexedDB: new IDBFactory() });
  const authority = await createBodyAuthority();
  try {
    assert.throws(
      () => createBrowserLocalRuntime({ local, remote: authority.backend }),
      (err: unknown) => err instanceof InvalidInputError && /needs a transport/.test(err.message),
    );
  } finally { local.close(); }
});
