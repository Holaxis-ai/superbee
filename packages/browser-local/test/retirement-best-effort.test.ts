/**
 * Retiring acknowledged body history is best effort: whatever retirement throws, the commit and
 * the settle that triggered it succeed, the next commit or settle retries it, and a target whose
 * retirement keeps failing is reported by `syncStatus` instead of thrown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import type { IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import { syncStatus, RETIREMENT_DIAGNOSTIC_FAILURES } from "../src/local-bundle.ts";
import { admitBodyMode, bodySnapshot } from "../src/body-journal.ts";
import { ADAPTERS, makeBackend, setup, type Adapter, type Setup } from "./fixtures/body-resolution.ts";

const ID = "notes/example";

async function states(s: Pick<Setup, "backend">): Promise<string[]> {
  return (await bodySnapshot(s.backend, ID, (await admitBodyMode(s.backend))!)).read.intents.map(row => row.state);
}

/** One save: a local commit, then a sync that settles it. Either throwing fails the test. */
async function save(s: Setup, label: string): Promise<void> {
  const body = `${label}\n`;
  await s.runtime.commit(ID, { body });
  assert.equal((await s.runtime.sync()).pending, 0, `${label} settled`);
  assert.equal((await s.authority.backend.read(ID)).doc.body, body);
}

const FAILURES: ReadonlyArray<{ label: string; make: () => unknown; name: string }> = [
  { label: "a plain Error", make: () => new Error("disk said no"), name: "Error" },
  { label: "a QuotaExceededError", make: () => new DOMException("quota", "QuotaExceededError"), name: "QuotaExceededError" },
  { label: "a NotFoundError", make: () => new DOMException("store gone", "NotFoundError"), name: "NotFoundError" },
  { label: "an AbortError", make: () => new DOMException("page closed", "AbortError"), name: "AbortError" },
  { label: "a TypeError from an adapter defect", make: () => new TypeError("cannot read properties of undefined"), name: "TypeError" },
  { label: "a thrown non-Error value", make: () => "bare string", name: "Error" },
];

/**
 * Saves until retirement has failed on enough consecutive attempts to be reported, checking every
 * commit and settle succeeds, then lets retirement work again and checks the next save retires the
 * whole backlog and clears the report.
 */
async function exercise(s: Setup, fail: { restore: () => void }, expectName: string, expectMessage?: RegExp): Promise<void> {
  // The first save leaves one acknowledged row, which needs no retirement.
  await save(s, "Save 1");
  assert.equal((await syncStatus(s.local)).retirementFailures, undefined);
  // Save 2's settle fails to retire (1); save 3's commit (2) and settle (3) fail again.
  await save(s, "Save 2");
  assert.equal((await syncStatus(s.local)).retirementFailures, undefined, "one failure is not yet persistent");
  await save(s, "Save 3");
  assert.deepEqual(await states(s), ["acknowledged", "acknowledged", "acknowledged"], "the history stays for a later retry");
  const reported = (await syncStatus(s.local)).retirementFailures;
  assert.equal(reported?.length, 1);
  assert.equal(reported![0]!.target, ID);
  assert.equal(reported![0]!.failures, RETIREMENT_DIAGNOSTIC_FAILURES);
  assert.equal(reported![0]!.error.name, expectName);
  if (expectMessage) assert.match(reported![0]!.error.message, expectMessage);
  assert.ok(!Number.isNaN(Date.parse(reported![0]!.since)));
  // Still failing: commits keep landing and the count keeps rising.
  await save(s, "Save 4");
  assert.equal((await syncStatus(s.local)).retirementFailures?.[0]?.failures, RETIREMENT_DIAGNOSTIC_FAILURES + 2);

  fail.restore();
  // The next commit retires the backlog before reserving its own room.
  await s.runtime.commit(ID, { body: "Save 5\n" });
  assert.deepEqual(await states(s), ["acknowledged", "pending"]);
  assert.equal((await syncStatus(s.local)).retirementFailures, undefined, "a successful retirement clears the report");
  await s.runtime.sync();
  assert.deepEqual(await states(s), ["acknowledged"]);
  assert.equal((await s.authority.backend.read(ID)).doc.body, "Save 5\n");
}

for (const adapter of ADAPTERS) {
  for (const failure of FAILURES) {
    test(`${adapter}: retirement failing with ${failure.label} never reaches commit or settle`, async () => {
      const s = await setup(adapter);
      try {
        const original = s.backend.retireAcknowledged!.bind(s.backend);
        let calls = 0;
        s.backend.retireAcknowledged = async () => { calls++; throw failure.make(); };
        await exercise(s, { restore: () => { s.backend.retireAcknowledged = original; } }, failure.name);
        assert.equal(calls, RETIREMENT_DIAGNOSTIC_FAILURES + 2);
      } finally { s.close(); }
    });
  }

  test(`${adapter}: a failed retirement is retried by the next save and succeeds`, async () => {
    const s = await setup(adapter);
    try {
      const original = s.backend.retireAcknowledged!.bind(s.backend);
      await save(s, "Save 1");
      let failOnce = true;
      s.backend.retireAcknowledged = async (...args) => {
        if (failOnce) { failOnce = false; throw new Error("transient"); }
        return original(...args);
      };
      await save(s, "Save 2");
      assert.deepEqual(await states(s), ["acknowledged", "acknowledged"]);
      await save(s, "Save 3");
      assert.deepEqual(await states(s), ["acknowledged"]);
      assert.equal((await syncStatus(s.local)).retirementFailures, undefined);
    } finally { s.close(); }
  });
}

/**
 * Core's IndexedDB adapter rejects a transaction aborted without an error object (a host abort)
 * with a plain `Error`. This factory aborts the retirement transaction that way: once its guard
 * reads pass and its deletes are queued, it aborts the transaction and hides the deletes' own
 * abort errors, so the adapter sees an abort with no recorded failure.
 */
function abortingRetirementFactory(): { factory: IdbFactoryLike; arm: (on: boolean) => void } {
  const real = new IDBFactory();
  let armed = false;
  const bindAll = <T extends object>(target: T, override: (prop: PropertyKey) => unknown, ignoreSet: PropertyKey | null = null): T => new Proxy(target, {
    get(t, prop) {
      const replaced = override(prop);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
    set(t, prop, value) { return prop === ignoreSet ? true : Reflect.set(t, prop, value, t); },
  });
  const wrapTx = (tx: IDBTransaction): IDBTransaction => {
    let aborting = false;
    return bindAll(tx, prop => prop !== "objectStore" ? undefined : (name: string) => {
      const store = tx.objectStore(name);
      return bindAll(store, inner => inner !== "delete" ? undefined : (key: IDBValidKey) => {
        const request = store.delete(key);
        if (!aborting) { aborting = true; queueMicrotask(() => tx.abort()); }
        // The adapter's onerror would record the abort as its failure; drop it.
        return bindAll(request, () => undefined, "onerror");
      });
    });
  };
  const wrapDb = (db: IDBDatabase): IDBDatabase => bindAll(db, prop => prop !== "transaction" ? undefined
    : (stores: string | string[], mode?: IDBTransactionMode) => {
      const tx = db.transaction(stores, mode);
      return armed && mode === "readwrite" ? wrapTx(tx) : tx;
    });
  const factory = {
    open(name: string, version?: number) {
      const request = real.open(name, version);
      return bindAll(request, prop => prop === "result" && request.readyState === "done" && request.result ? wrapDb(request.result) : undefined);
    },
  } as unknown as IdbFactoryLike;
  return { factory, arm: on => { armed = on; } };
}

test("indexeddb: a host abort the adapter reports as a plain Error never reaches commit or settle", async () => {
  const { factory, arm } = abortingRetirementFactory();
  const s = await setup("indexeddb" as Adapter, "0.2", makeBackend("indexeddb", factory));
  try {
    const original = s.backend.retireAcknowledged!.bind(s.backend);
    const seen: unknown[] = [];
    s.backend.retireAcknowledged = async (...args) => {
      arm(true);
      try { return await original(...args); }
      catch (error) { seen.push(error); throw error; }
      finally { arm(false); }
    };
    await exercise(s, { restore: () => { s.backend.retireAcknowledged = original; } }, "Error", /aborted before commit/);
    assert.ok(seen.length >= RETIREMENT_DIAGNOSTIC_FAILURES);
    for (const error of seen) {
      assert.equal(Object.getPrototypeOf(error), Error.prototype, "the adapter's own plain Error, not a DOMException");
      assert.match((error as Error).message, /IndexedDB transaction aborted before commit/);
    }
  } finally { s.close(); }
});
