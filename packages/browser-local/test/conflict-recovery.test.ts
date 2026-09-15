import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import type { StorageBackend } from "@superbee/core";
import { bootstrap, commitLocal, inspectConflict, resolveConflict, conflictResolutionKey, openLocalBundle, push, syncStatus, type ConflictChoice } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime } from "../src/platform/index.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createRemoteFixture } from "./fixtures/remote-fixture.ts";

const id = "notes/conflict";
const doc = (body: string) => ({ id, frontmatter: { type: "Note", title: "Test" }, body });
const edit = (body: string) => ({ buildCandidate: () => doc(body) });
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };

for (const adapter of ["indexeddb", "memory"]) {
  async function fixture() {
    const remote = await createRemoteFixture();
    await remote.authority.write(id, doc("original\n"));
    const local = openLocalBundle(`recovery-${crypto.randomUUID()}`, adapter === "memory" ? { backend: new MemoryJournaledBackend() } : { indexedDB: new IDBFactory() });
    await bootstrap(remote.remote, local);
    await commitLocal(local, id, edit("my edit\n"));
    await remote.authority.write(id, doc("their edit\n"));
    await push(local, remote.transport, { remote: remote.remote, write: immediate });
    return { remote, local };
  }
  for (const choice of [{ kind: "keep-local" }, { kind: "take-remote" }, { kind: "revise", body: "deliberate combined edit\n" }] as ConflictChoice[]) {
    test(`${adapter}: ${choice.kind} preserves review evidence and unblocks future editing`, async () => {
      const { remote, local } = await fixture();
      try {
        await commitLocal(local, id, edit("my later edit\n"));
        const review = await inspectConflict(local, remote.remote, id);
        assert.equal(review.intents.length, 2);
        assert.match(review.base.content!, /original/);
        assert.match(review.local.content, /my later edit/);
        assert.match(review.remote.content!, /their edit/);
        const result = await resolveConflict(local, remote.remote, review, choice);
        assert.deepEqual((await local.backend.readMeta<any>(conflictResolutionKey(result.receipt.id))).reviewed, review);
        assert.equal((await syncStatus(local)).counts.conflict, 0);
        for (const old of review.intents) assert.equal(await local.backend.readIntent(old.requestId), undefined);
        assert.equal((await remote.authority.read(id)).doc.body, "their edit\n", "resolution sends no write");
        if (choice.kind !== "take-remote") {
          assert.ok(result.intent);
          assert.equal(result.intent.base, review.remote.version);
          assert.equal(result.intent.after, undefined);
          assert.ok(!review.intents.some(row => row.requestId === result.intent!.requestId));
          await push(local, remote.transport, { remote: remote.remote, write: immediate });
        }
        const runtime = createBrowserLocalRuntime({ local, remote: remote.remote, transport: remote.transport });
        assert.equal((await runtime.read(id)).provenance.state, "shared-confirmed");
        await commitLocal(local, id, edit("next edit\n"));
        assert.equal((await syncStatus(local)).counts.pending, 1);
      } finally { local.close(); }
    });
  }
  test(`${adapter}: stale local/remote review and network failure preserve the conflict`, async () => {
    const { remote, local } = await fixture();
    try {
      const review = await inspectConflict(local, remote.remote, id);
      await remote.authority.write(id, doc("new unseen remote\n"));
      await assert.rejects(resolveConflict(local, remote.remote, review, { kind: "take-remote" }));
      const fresh = await inspectConflict(local, remote.remote, id);
      await commitLocal(local, id, edit("new unseen local\n"));
      await assert.rejects(resolveConflict(local, remote.remote, fresh, { kind: "take-remote" }));
      const failing = new Proxy(remote.remote, { get(target, key) {
        if (key === "read") return async () => { throw new Error("offline"); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } }) as StorageBackend;
      await assert.rejects(inspectConflict(local, failing, id), /offline/);
      assert.equal((await syncStatus(local)).counts.conflict, 1);
      assert.equal((await local.backend.read(id)).doc.body, "new unseen local\n");
    } finally { local.close(); }
  });
  test(`${adapter}: reviewed deletion can be taken or recreated without blind overwrite`, async () => {
    const { remote, local } = await fixture();
    try {
      await remote.authority.delete(id);
      const review = await inspectConflict(local, remote.remote, id);
      assert.deepEqual(review.remote, { version: null, content: null });
      const result = await resolveConflict(local, remote.remote, review, { kind: "keep-local" });
      assert.equal(result.intent!.base, null);
      await remote.authority.write(id, doc("someone recreated\n"));
      await push(local, remote.transport, { remote: remote.remote, write: immediate });
      assert.equal((await syncStatus(local)).counts.conflict, 1);
      assert.equal((await remote.authority.read(id)).doc.body, "someone recreated\n");
      await remote.authority.delete(id);
      const deletion = await inspectConflict(local, remote.remote, id);
      const taken = await resolveConflict(local, remote.remote, deletion, { kind: "take-remote" });
      assert.equal(taken.version, null);
      await assert.rejects(local.backend.read(id), { code: "ENOENT" });
      assert.ok(await local.backend.readMeta(conflictResolutionKey(taken.receipt.id)));
    } finally { local.close(); }
  });
  test(`${adapter}: concurrent resolutions accept only one and invalid revision changes nothing`, async () => {
    const { remote, local } = await fixture();
    try {
      const review = await inspectConflict(local, remote.remote, id);
      await assert.rejects(resolveConflict(local, remote.remote, review, { kind: "revise", body: "bad", frontmatter: { type: "Note", title: 42 } }));
      assert.deepEqual(await inspectConflict(local, remote.remote, id), review);
      const results = await Promise.allSettled([resolveConflict(local, remote.remote, review, { kind: "keep-local" }), resolveConflict(local, remote.remote, review, { kind: "take-remote" })]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    } finally { local.close(); }
  });
  test(`${adapter}: a failed recovery receipt write rolls back document and journal together`, async () => {
    const { remote, local } = await fixture();
    try {
      const before = await local.backend.readWithJournal(id);
      const review = await inspectConflict(local, remote.remote, id);
      await assert.rejects(local.backend.writeJournaled(id, doc("must not land\n"), {
        expectedVersion: review.local.version,
        resolveIntents: { expected: review.intents },
        meta: [{ key: "uncloneable", value: () => undefined }],
      }));
      assert.deepEqual(await local.backend.readWithJournal(id), before);
      assert.equal(await local.backend.readMeta("uncloneable"), undefined);
    } finally { local.close(); }
  });
  test(`${adapter}: exact mode keeps a refused head out of conflict recovery; a later edit supersedes it`, async () => {
    const remote = await createRemoteFixture();
    await remote.authority.write(id, doc("original\n"));
    const local = openLocalBundle(`refused-${crypto.randomUUID()}`, adapter === "memory" ? { backend: new MemoryJournaledBackend() } : { indexedDB: new IDBFactory() });
    try {
      await bootstrap(remote.remote, local);
      const committed = await commitLocal(local, id, edit("refused edit\n"));
      await local.backend.updateIntent(committed.intent!.requestId, "pending", { state: "refused", attempts: 1, refusal: { code: "validation_failed", message: "refused by a rule" } });
      const before = await local.backend.readWithJournal(id);
      await assert.rejects(inspectConflict(local, remote.remote, id), { name: "InvalidInputError" });
      assert.deepEqual(await local.backend.readWithJournal(id), before);
      const superseded = await commitLocal(local, id, edit("edited again\n"));
      assert.equal(await local.backend.readIntent(committed.intent!.requestId), undefined);
      assert.equal(superseded.intent!.state, "pending");
      assert.equal((await syncStatus(local)).counts.refused, 0);
    } finally { local.close(); }
  });
  test(`${adapter}: a local edit during remote recheck and attempted descendant refuse resolution`, async () => {
    const { remote, local } = await fixture();
    try {
      const review = await inspectConflict(local, remote.remote, id);
      const racing = new Proxy(remote.remote, { get(target, key) {
        if (key === "read") return async (targetId: string) => { await commitLocal(local, id, edit("racing local\n")); return target.read(targetId); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } }) as StorageBackend;
      await assert.rejects(resolveConflict(local, racing, review, { kind: "take-remote" }));
      const pending = (await local.backend.listIntents("pending"))[0]!;
      await local.backend.updateIntent(pending.requestId, "pending", { attempts: 1 });
      await assert.rejects(inspectConflict(local, remote.remote, id));
      assert.equal((await local.backend.read(id)).doc.body, "racing local\n");
    } finally { local.close(); }
  });
}
