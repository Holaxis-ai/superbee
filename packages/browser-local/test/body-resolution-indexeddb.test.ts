/**
 * Body-mode conflict resolution over real IndexedDB transactions (fake-indexeddb): two
 * connections over one database resolving one review at once, and a resolution whose own
 * transaction aborts, checked before and after the store is reopened on a fresh connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackend, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import { openLocalBundle, bootstrap, push, inspectConflict, resolveConflict, conflictResolutionKey, syncStatus } from "../src/local-bundle.ts";
import { admitBodyMode, bodyRecordKey, bodySnapshot, validateBodyResolutionReceipt } from "../src/body-journal.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import { createBodyAuthority } from "./fixtures/body-authority.ts";
import { exact, immediate, choices } from "./fixtures/body-resolution.ts";

/** Delegate every member to `target` (methods bound to it) except the named overrides. */
function proxied<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    set(inner, prop, value) { Reflect.set(inner, prop, value, inner); return true; },
  });
}
/** A factory whose object-store `put` aborts its own transaction the moment the put succeeds, when armed. */
function abortAfterPutFactory(inner: IDBFactory, armed: { value: boolean; puts: number }): IdbFactoryLike {
  const wrapStore = (store: IDBObjectStore, tx: IDBTransaction) => proxied(store, {
    put(value: unknown) {
      const request = store.put(value);
      if (armed.value) { armed.puts += 1; request.addEventListener("success", () => tx.abort()); }
      return request;
    },
  });
  const wrapTx = (tx: IDBTransaction) => proxied(tx, { objectStore: (name: string) => wrapStore(tx.objectStore(name), tx) });
  const wrapDb = (db: IDBDatabase) => proxied(db, { transaction: (names: string | string[], mode?: IDBTransactionMode) => wrapTx(db.transaction(names, mode)) });
  return { open(name: string, version?: number) { const request = inner.open(name, version); return proxied(request, { get result() { return wrapDb(request.result); } }); } } as IdbFactoryLike;
}

const bodyDelivery = { scope: "fixture", okfVersion: "0.2" as const, dedicated: true as const };
const snapshotOf = async (backend: IndexedDbBackend, id: string, extra: string[]) => {
  const mode = (await admitBodyMode(backend))!;
  const snap = await bodySnapshot(backend, id, mode, extra);
  return { guard: snap.guard, sequence: await backend.readMeta("intents:sequence"), all: await backend.listIntents() };
};

// Two connections over one database resolve one review with different choices at the same time.
for (const head of ["conflict", "refused"] as const) for (const race of ["all", "fresh-only"] as const) test(`${head} head, ${race}: two connections resolving one review with different choices accept exactly one, and the loser's push never resubmits the retired identity`, async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const one = new IndexedDbBackend({ databaseName: name, indexedDB: factory }), two = new IndexedDbBackend({ databaseName: name, indexedDB: factory });
  const localOne = openLocalBundle("shared", { backend: one, bodyDelivery }), localTwo = openLocalBundle("shared", { backend: two, bodyDelivery });
  const authority = await createBodyAuthority();
  try {
    await bootstrap(authority.backend, localOne);
    const runtime = createBrowserLocalRuntime({ local: localOne, remote: authority.backend, transport: exact, bodyTransport: authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate });
    await runtime.commit("notes/example", { body: "Retain this work" });
    if (head === "conflict") { const remote = await authority.backend.read("notes/example"); await authority.backend.write("notes/example", { ...remote.doc, body: "Concurrent authority edit" }); }
    else authority.knobs.contentRefusal = true;
    await push(localOne, exact, { bodyTransport: authority.transport, remote: authority.backend, write: immediate });
    authority.knobs.contentRefusal = false;
    const reviewOne = await inspectConflict(localOne, authority.backend, "notes/example");
    const reviewTwo = await inspectConflict(localTwo, authority.backend, "notes/example");
    assert.deepEqual(reviewTwo, reviewOne);
    const headId = reviewOne.intents[0]!.requestId;
    const submitted = authority.counts.submitted;
    const results = await Promise.allSettled(race === "all" ? [
      resolveConflict(localOne, authority.backend, reviewOne, { kind: "keep-local" }),
      resolveConflict(localTwo, authority.backend, reviewTwo, { kind: "revise", body: "Two revises" }),
      resolveConflict(localOne, authority.backend, reviewOne, { kind: "take-remote" }),
    ] : [
      resolveConflict(localTwo, authority.backend, reviewTwo, { kind: "revise", body: "Two revises" }),
      resolveConflict(localOne, authority.backend, reviewOne, { kind: "keep-local" }),
    ]);
    const winners = results.filter(row => row.status === "fulfilled");
    assert.equal(winners.length, 1, results.map(row => row.status === "rejected" ? (row.reason as Error).name : "ok").join(","));
    for (const row of results) if (row.status === "rejected") {
      assert.ok(["JournalSnapshotConflict", "ConflictReviewStaleError", "VersionConflict", "JournalGuardConflict"].includes((row.reason as Error).name), String(row.reason));
    }
    const receipt = validateBodyResolutionReceipt(await two.readMeta(conflictResolutionKey(headId)));
    assert.equal(await one.readIntent(headId), undefined);
    assert.equal(await two.readMeta(bodyRecordKey(headId)), undefined);
    const unsettled = (await two.listIntents()).filter(row => row.state !== "acknowledged");
    assert.deepEqual(unsettled.map(row => row.requestId), receipt.replacementRequestId === null ? [] : [receipt.replacementRequestId]);
    // The losing connection pushes: only the fresh identity travels, once; the retired identity is never presented again.
    const reportTwo = await push(localTwo, exact, { bodyTransport: authority.transport, remote: authority.backend, write: immediate });
    const reportOne = await push(localOne, exact, { bodyTransport: authority.transport, remote: authority.backend, write: immediate });
    assert.equal(authority.counts.submitted - submitted, receipt.replacementRequestId === null ? 0 : 1);
    assert.deepEqual([...reportTwo.settled, ...reportOne.settled].map(row => row.requestId), receipt.replacementRequestId === null ? [] : [receipt.replacementRequestId]);
    assert.ok(!authority.records.has(receipt.replacementRequestId ?? "none") || authority.records.get(receipt.replacementRequestId!)!.outcome?.kind === "committed");
    assert.equal(authority.records.get(headId)!.outcome!.kind, head === "conflict" ? "conflict" : "refused", "the retired identity's record at the authority is untouched");
    assert.equal((await syncStatus(localTwo)).counts.pending, 0);
    for (const local of [localOne, localTwo]) assert.equal((await createBrowserLocalRuntime({ local, remote: authority.backend, transport: exact, bodyTransport: authority.transport, write: immediate }).read("notes/example")).provenance.state, "shared-confirmed");
  } finally { localOne.close(); localTwo.close(); }
});

// The resolution's own transaction aborts; nothing of it is visible, before and after reopen; the same review then resolves.
for (const served of ["present", "absent"] as const) for (const choice of choices) {
  if (served === "absent" && choice.kind !== "take-remote") continue;
  test(`${choice.kind} over ${served === "absent" ? "an absent" : "a present"} served head: an aborted resolution transaction leaves the working copy exactly as it was, across reopen, and the review still resolves`, async () => {
    const inner = new IDBFactory(), armed = { value: false, puts: 0 }, name = crypto.randomUUID();
    let backend = new IndexedDbBackend({ databaseName: name, indexedDB: abortAfterPutFactory(inner, armed) });
    let local = openLocalBundle("abort", { backend, bodyDelivery });
    const authority = await createBodyAuthority();
    try {
      await bootstrap(authority.backend, local);
      const runtime = createBrowserLocalRuntime({ local, remote: authority.backend, transport: exact, bodyTransport: authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate });
      await runtime.commit("notes/example", { body: "Retain this work" });
      authority.knobs.contentRefusal = true;
      await push(local, exact, { bodyTransport: authority.transport, remote: authority.backend, write: immediate });
      authority.knobs.contentRefusal = false;
      await runtime.commit("notes/example", { body: "Later local edit" });
      if (served === "absent") await authority.backend.delete("notes/example");
      const review = await inspectConflict(local, authority.backend, "notes/example");
      const headId = review.intents[0]!.requestId;
      const extra = [conflictResolutionKey(headId), "base:notes/example"];
      const before = await snapshotOf(backend, "notes/example", extra);
      armed.value = true;
      // The abort surfaces as the adapter's own failure, never as one of the resolution's refusals.
      await assert.rejects(resolveConflict(local, authority.backend, review, choice), (error: Error) => !["JournalSnapshotConflict", "ConflictReviewStaleError", "VersionConflict"].includes(error.name));
      armed.value = false;
      assert.ok(armed.puts >= 1, "the abort fired inside the resolution's transaction");
      assert.deepEqual(await snapshotOf(backend, "notes/example", extra), before, "nothing of the aborted resolution is visible");
      assert.equal(await backend.readMeta(conflictResolutionKey(headId)), undefined);
      // Reopen the store on a fresh connection.
      local.close();
      backend = new IndexedDbBackend({ databaseName: name, indexedDB: inner });
      local = openLocalBundle("abort", { backend, bodyDelivery });
      assert.deepEqual(await snapshotOf(backend, "notes/example", extra), before, "the reopened store shows the pre-resolution state");
      const again = await inspectConflict(local, authority.backend, "notes/example");
      assert.deepEqual(again, review, "the review is still exact after the aborted attempt");
      const result = await resolveConflict(local, authority.backend, again, choice);
      assert.deepEqual(validateBodyResolutionReceipt(await backend.readMeta(conflictResolutionKey(headId))), result.receipt);
      for (const row of review.intents) { assert.equal(await backend.readIntent(row.requestId), undefined); assert.equal(await backend.readMeta(bodyRecordKey(row.requestId)), undefined); }
      if (served === "absent") { assert.deepEqual(await backend.list(), []); return; }
      const report = await push(local, exact, { bodyTransport: authority.transport, remote: authority.backend, write: immediate });
      assert.deepEqual(report.settled.map(row => row.state), choice.kind === "take-remote" ? [] : ["acknowledged"]);
      const reopened = createBrowserLocalRuntime({ local, remote: authority.backend, transport: exact, bodyTransport: authority.transport, write: immediate });
      assert.equal((await reopened.read("notes/example")).provenance.state, "shared-confirmed");
    } finally { local.close(); }
  });
}
