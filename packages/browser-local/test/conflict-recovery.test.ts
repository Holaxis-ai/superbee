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
  // Exact mode keeps its rule and its refusal class: a chain with no conflict row is not a recovery case, whatever the head's refusal code; a later edit supersedes a refused request.
  for (const shape of ["refused", "refused+successor", "auth-refused", "conflict+refused-successor"] as const) {
    test(`${adapter}: exact mode over a ${shape} chain: inspect and every verb keep their answer without mutation`, async () => {
      const remote = await createRemoteFixture();
      await remote.authority.write(id, doc("original\n"));
      const local = openLocalBundle(`exact-${crypto.randomUUID()}`, adapter === "memory" ? { backend: new MemoryJournaledBackend() } : { indexedDB: new IDBFactory() });
      try {
        await bootstrap(remote.remote, local);
        const first = await commitLocal(local, id, edit("first edit\n"));
        const code = shape === "auth-refused" ? "PERMISSION_DENIED" : "validation_failed";
        if (shape === "conflict+refused-successor") {
          await local.backend.updateIntent(first.intent!.requestId, "pending", { state: "conflict", attempts: 1, remote: { version: null, content: null } });
          const second = await commitLocal(local, id, edit("second edit\n"));
          await local.backend.updateIntent(second.intent!.requestId, "pending", { state: "refused", attempts: 1, refusal: { code, message: "refused by a rule" } });
        } else {
          await local.backend.updateIntent(first.intent!.requestId, "pending", { state: "refused", attempts: 1, refusal: { code, message: "refused by a rule" } });
          if (shape === "refused+successor") {
            // Exact mode's later commit supersedes a refused request; keep the chain by journaling the successor directly.
            const before = await local.backend.readWithJournal(id);
            await local.backend.writeJournaled(id, doc("second edit\n"), { expectedVersion: before.document!.version, intent: { requestId: "successor", kind: "document.write", target: id, base: before.intents[0]!.local, baseContent: before.raw, createdAt: "2026-09-15T00:00:00.000Z", after: before.intents[0]!.requestId } });
          }
        }
        const snapshot = await local.backend.readWithJournal(id);
        const intents = snapshot.intents.filter(row => row.state !== "acknowledged");
        const before = { snapshot, base: await local.backend.readMeta(`base:${id}`), receipt: await local.backend.readMeta(conflictResolutionKey(intents[0]!.requestId)) };
        const forged = { id, local: { version: snapshot.document!.version, content: snapshot.raw! }, base: { version: intents[0]!.base, content: intents[0]!.baseContent }, remote: { version: (await remote.remote.read(id)).version, content: null }, intents };
        const choices = [{ kind: "keep-local" }, { kind: "take-remote" }, { kind: "revise", body: "revised\n" }] as ConflictChoice[];
        if (shape === "conflict+refused-successor") {
          // A conflicted head with a refused successor was resolvable before this slice and stays so; the forged review's remote content makes every verb report it stale.
          assert.equal((await inspectConflict(local, remote.remote, id)).intents.length, 2);
          for (const choice of choices) await assert.rejects(resolveConflict(local, remote.remote, forged, choice), { name: "ConflictReviewStaleError" });
        } else {
          await assert.rejects(inspectConflict(local, remote.remote, id), { name: "JournalSnapshotConflict" });
          for (const choice of choices) await assert.rejects(resolveConflict(local, remote.remote, forged, choice), { name: "JournalSnapshotConflict" });
        }
        assert.deepEqual({ snapshot: await local.backend.readWithJournal(id), base: await local.backend.readMeta(`base:${id}`), receipt: await local.backend.readMeta(conflictResolutionKey(intents[0]!.requestId)) }, before, "nothing was written");
        assert.equal((await syncStatus(local)).counts.refused, 1);
        if (shape === "refused") {
          const superseded = await commitLocal(local, id, edit("edited again\n"));
          assert.equal(await local.backend.readIntent(first.intent!.requestId), undefined);
          assert.equal(superseded.intent!.state, "pending");
          assert.equal((await syncStatus(local)).counts.refused, 0);
        }
      } finally { local.close(); }
    });
  }
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
