/**
 * Acknowledged body history retires, so a large document stays editable for as long as it is
 * edited: consecutive saves of a 900 KiB body, saves made while the previous one is in flight
 * (a chain), a page that dies at each await of a save, and two tabs over one working copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { BODY_DELIVERY_LIMITS } from "@superbee/core/governed-body-write";
import { IndexedDbBackend } from "@superbee/core/indexeddb-backend";
import type { JournaledBackend } from "@superbee/core/journaled-backend";
import { openLocalBundle, push, reclaimInFlight, commitBodyLocal } from "../src/local-bundle.ts";
import { admitBodyMode, bodyRecordKey, bodySnapshot, retireAcknowledgedBody, validateBodyEvidence, bodyEvidenceKeys } from "../src/body-journal.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import { ADAPTERS, exact, immediate, makeBackend, setup as setupBody, type Adapter, type Setup } from "./fixtures/body-resolution.ts";

const ID = "notes/example";

/**
 * fake-indexeddb keeps every finished transaction, with its requests' results, for the life of
 * the database (a browser does not), so a long run of large saves exhausts the test process's
 * heap through the fake alone. Each run drops finished transactions after every save.
 */
function pruneFinished(factory: IDBFactory): void {
  for (const db of (factory as unknown as { _databases: Map<string, { transactions: { _state: string }[] }> })._databases.values()) {
    db.transactions = db.transactions.filter(tx => tx._state !== "finished");
  }
}
async function setup(adapter: Adapter, factory = new IDBFactory(), name: string = crypto.randomUUID()) {
  const s = await setupBody(adapter, "0.2", makeBackend(adapter, factory, name));
  return Object.assign(s, { factory, name, prune: () => pruneFinished(factory) });
}
const KIB = 1024;

/** Realistic Markdown of about `bytes` UTF-8 bytes, distinct per `label`. */
function largeBody(label: string, bytes = 900 * KIB): string {
  const line = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n";
  const head = `# ${label}\n\n`;
  return head + line.repeat(Math.floor((bytes - head.length) / line.length));
}
const utf8 = (text: string) => new TextEncoder().encode(text).length;

async function journal(s: Pick<Setup, "backend">) {
  const mode = (await admitBodyMode(s.backend))!;
  return bodySnapshot(s.backend, ID, mode);
}

/** Every request descriptor in the store, whatever its target. */
async function descriptorKeys(backend: JournaledBackend, ids: readonly string[]): Promise<string[]> {
  const present: string[] = [];
  for (const id of ids) if (await backend.readMeta(bodyRecordKey(id)) !== undefined) present.push(id);
  return present;
}

for (const adapter of ADAPTERS) {
  test(`${adapter}: twenty-five consecutive saves of a 900 KiB document all land and keep one acknowledged row`, async () => {
    const s = await setup(adapter);
    try {
      const seen: string[] = [];
      for (let save = 1; save <= 25; save++) {
        const body = largeBody(`Save ${save}`);
        assert.ok(utf8(body) > 899 * KIB && utf8(body) <= BODY_DELIVERY_LIMITS.bodyBytes);
        await s.runtime.commit(ID, { body });
        const status = await s.runtime.sync();
        s.prune();
        assert.equal(status.pending, 0, `save ${save} settled`);
        const snap = await journal(s);
        assert.deepEqual(snap.read.intents.map(row => row.state), ["acknowledged"], `save ${save} keeps one acknowledged row`);
        seen.push(snap.read.intents[0]!.requestId);
        assert.equal((await s.runtime.read(ID)).provenance.state, "shared-confirmed");
      }
      assert.equal(s.authority.counts.applied, 25);
      assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("Save 25"));
      // Only the newest row keeps its descriptor; every retired row's evidence left with it.
      assert.deepEqual(await descriptorKeys(s.backend, seen), [seen.at(-1)]);
    } finally { s.close(); }
  });

  test(`${adapter}: twenty-two saves each made while the previous one is in flight keep chaining and retiring`, async () => {
    const s = await setup(adapter);
    try {
      await s.runtime.commit(ID, { body: largeBody("Chain 0") });
      for (let save = 1; save <= 22; save++) {
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
        const delivering = push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
        await reached;
        await s.runtime.commit(ID, { body: largeBody(`Chain ${save}`) });
        s.authority.knobs.delay = undefined;
        release(); await delivering;
        s.prune();
        const rows = (await journal(s)).read.intents;
        // The delivered row is the newest acknowledged one; the new save waits on it as its successor.
        assert.deepEqual(rows.map(row => row.state), ["acknowledged", "pending"], `chain save ${save}`);
        assert.equal(rows[1]!.after, rows[0]!.requestId);
      }
      await s.runtime.sync();
      const rows = (await journal(s)).read.intents;
      assert.deepEqual(rows.map(row => row.state), ["acknowledged"]);
      // The last acknowledged row names a predecessor that has retired.
      assert.ok(rows[0]!.after);
      assert.equal(await s.backend.readIntent(rows[0]!.after!), undefined);
      assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("Chain 22"));
      assert.equal(s.authority.counts.applied, 23);
    } finally { s.close(); }
  });

  test(`${adapter}: two unsettled maximum-size intents are admitted beside an acknowledged one`, async () => {
    // A body at the bound whose every byte JSON escapes to two (newlines) beside realistic Markdown.
    for (const fill of ["realistic", "escaped"] as const) {
      const s = await setup(adapter);
      try {
        const max = (label: string) => fill === "escaped" ? `${label}\n` + "\n".repeat(BODY_DELIVERY_LIMITS.bodyBytes - utf8(label) - 1) : largeBody(label, BODY_DELIVERY_LIMITS.bodyBytes);
        await s.runtime.commit(ID, { body: max("A") });
        await s.runtime.sync();
        await s.runtime.commit(ID, { body: max("B") });
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
        const delivering = push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
        await reached;
        await s.runtime.commit(ID, { body: max("C") });
        const held = (await journal(s)).read.intents;
        assert.deepEqual(held.map(row => row.state), ["acknowledged", "in_flight", "pending"], fill);
        assert.ok(held.every(row => utf8(row.content) > BODY_DELIVERY_LIMITS.bodyBytes - KIB));
        s.authority.knobs.delay = undefined;
        release(); await delivering;
        await s.runtime.sync();
        assert.deepEqual((await journal(s)).read.intents.map(row => row.state), ["acknowledged"], fill);
        assert.equal((await s.authority.backend.read(ID)).doc.body, max("C"));
      } finally { s.close(); }
    }
  });

  test(`${adapter}: retirement never touches unsettled work and refuses an older unsettled row`, async () => {
    const s = await setup(adapter);
    try {
      const mode = (await admitBodyMode(s.backend))!;
      await s.runtime.commit(ID, { body: "One" }); await s.runtime.sync();
      await s.runtime.commit(ID, { body: "Two" });
      const before = await journal(s);
      // Nothing older than the newest acknowledged row: nothing to retire, nothing written.
      assert.equal(await retireAcknowledgedBody(s.backend, mode, ID), 0);
      assert.deepEqual((await journal(s)).guard, before.guard);
      await s.runtime.sync();
      // An unsettled successor never loses its predecessor: evidence without it is refused.
      await s.runtime.commit(ID, { body: "Three" });
      let release!: () => void, started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
      const delivering = push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
      await reached;
      await s.runtime.commit(ID, { body: "Four" });
      s.authority.knobs.delay = undefined;
      release(); await delivering;
      const chained = await journal(s);
      const [acked, successor] = chained.read.intents;
      assert.equal(successor!.after, acked!.requestId);
      const without = chained.read.intents.filter(row => row !== acked);
      assert.throws(() => validateBodyEvidence({ target: ID, document: chained.guard.document, intents: without, meta: chained.read.meta, keys: bodyEvidenceKeys(ID, without) }, mode), /original history/);
      await s.runtime.sync();
      // Once acknowledged, the same row names a retired predecessor and validates, but only with
      // the predecessor's own bytes as its premise.
      const settled = await journal(s);
      const row = settled.read.intents[0]!;
      assert.equal(row.requestId, successor!.requestId);
      assert.equal(await s.backend.readIntent(acked!.requestId), undefined);
      const tampered = [{ ...row, baseContent: row.baseContent + "x" }];
      assert.throws(() => validateBodyEvidence({ target: ID, document: settled.guard.document, intents: tampered, meta: settled.read.meta, keys: bodyEvidenceKeys(ID, tampered) }, mode), /original history/);
    } finally { s.close(); }
  });
}

test("indexeddb: a page that dies at each await of a large save loses no edit and its next save retires the backlog", async () => {
  const s = await setup("indexeddb");
  const options = { scope: "fixture", okfVersion: "0.2" as const, dedicated: true as const };
  const open = () => new IndexedDbBackend({ databaseName: s.name, indexedDB: s.factory });
  const tab = (backend: IndexedDbBackend) => {
    const local = openLocalBundle("body-test", { backend, bodyDelivery: options });
    const runtime = createBrowserLocalRuntime({ local, remote: s.authority.backend, transport: exact, bodyTransport: s.authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate });
    return { local, runtime, backend };
  };
  try {
    // 1. Dies after the commit, before any delivery: the reloaded page delivers the edit.
    await s.runtime.commit(ID, { body: largeBody("Before crash") });
    s.close();
    let page = tab(open());
    await page.runtime.sync();
    assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("Before crash"));

    // 2. Dies while the save is in flight with its answer lost: reclaim, lookup, no second apply.
    await page.runtime.commit(ID, { body: largeBody("Lost answer") });
    s.authority.knobs.dropNextResponse = true; s.authority.knobs.lookupUnavailable = true;
    await push(page.local, exact, { bodyTransport: s.authority.transport, write: immediate });
    page.local.close();
    s.authority.knobs.lookupUnavailable = false;
    page = tab(open());
    await reclaimInFlight(page.local);
    const applied = s.authority.counts.applied;
    await page.runtime.sync();
    assert.equal(s.authority.counts.applied, applied, "the lost answer was looked up, not applied twice");
    assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("Lost answer"));

    // 3. Dies between each acknowledgment and its retirement until the history fills the
    //    target's capacity: the next save is refused with the edit kept out of the journal.
    page.local.close();
    const backend = open();
    backend.retireAcknowledged = async () => { throw new DOMException("page closed", "AbortError"); };
    page = tab(backend);
    let unretired = 0;
    for (;;) {
      try { await page.runtime.commit(ID, { body: largeBody(`Unretired ${unretired + 1}`) }); }
      catch (error) { assert.equal((error as Error).name, "BodyCapacityError"); break; }
      unretired++;
      // The settle is durable; the failed retirement leaves its history for a later save.
      assert.equal((await page.runtime.sync()).pending, 0);
      s.prune();
      assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody(`Unretired ${unretired}`));
      assert.ok(unretired < 20, "history without retirement reaches capacity");
    }
    page.local.close();
    page = tab(open());
    const backlog = (await bodySnapshot(page.backend, ID, (await admitBodyMode(page.backend))!)).read.intents;
    assert.ok(backlog.length >= 3 && backlog.every(row => row.state === "acknowledged"));
    // The same save, refused at capacity a moment ago, fits because the commit retires first.
    await page.runtime.commit(ID, { body: largeBody("After reload 0") });
    assert.deepEqual((await bodySnapshot(page.backend, ID, (await admitBodyMode(page.backend))!)).read.intents.map(row => row.state), ["acknowledged", "pending"]);
    await page.runtime.sync();
    // 4. The next save after reload retires the whole backlog before reserving its own room.
    for (let save = 1; save <= 20; save++) {
      await page.runtime.commit(ID, { body: largeBody(`After reload ${save}`) });
      await page.runtime.sync();
      s.prune();
    }
    const rows = (await bodySnapshot(page.backend, ID, (await admitBodyMode(page.backend))!)).read.intents;
    assert.deepEqual(rows.map(row => row.state), ["acknowledged"]);
    assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("After reload 20"));
    page.local.close();
  } finally { s.close(); }
});

// Two tabs are two realms with their own connections to one database; only the IndexedDB
// adapter can be shared that way.
for (const adapter of ["indexeddb"] as const) {
  test(`${adapter}: two tabs saving one large document interleave without losing an edit`, async () => {
    const s = await setup(adapter);
    const backendFor = (): JournaledBackend => new IndexedDbBackend({ databaseName: s.name, indexedDB: s.factory });
    const options = { scope: "fixture", okfVersion: "0.2" as const, dedicated: true as const };
    const local = openLocalBundle("body-test", { backend: backendFor(), bodyDelivery: options });
    const other = { local, runtime: createBrowserLocalRuntime({ local, remote: s.authority.backend, transport: exact, bodyTransport: s.authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate }) };
    try {
      const tabs = [{ local: s.local, runtime: s.runtime }, other];
      let last = "";
      for (let round = 0; round < 12; round++) {
        const [a, b] = round % 2 ? [tabs[1]!, tabs[0]!] : [tabs[0]!, tabs[1]!];
        // Tab A delivers while tab B saves a newer edit: B's save chains on A's in-flight row.
        await a.runtime.commit(ID, { body: largeBody(`Round ${round} A`) });
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
        const delivering = push(a.local, exact, { bodyTransport: s.authority.transport, write: immediate });
        await reached;
        last = largeBody(`Round ${round} B`);
        await b.runtime.commit(ID, { body: last });
        s.authority.knobs.delay = undefined;
        // Both tabs push at once; the role and the guards serialize them.
        const racing = Promise.allSettled([b.runtime.sync(), a.runtime.sync()]);
        release(); await delivering; await racing;
        await a.runtime.sync(); await b.runtime.sync();
        s.prune();
        assert.equal((await s.authority.backend.read(ID)).doc.body, last, `round ${round}`);
        const rows = (await journal(s)).read.intents;
        assert.deepEqual(rows.map(row => row.state), ["acknowledged"], `round ${round}`);
      }
      // Two tabs, one store: both read the same retired journal and the last edit.
      assert.equal((await other.runtime.read(ID)).doc.body, last);
      assert.equal((await s.runtime.read(ID)).doc.body, last);
    } finally { s.close(); local.close(); }
  });
}

test("commitBodyLocal still refuses a body over the library ceiling before any journal read", async () => {
  const s = await setup("memory");
  try {
    await assert.rejects(commitBodyLocal(s.local, ID, { body: "x".repeat(BODY_DELIVERY_LIMITS.bodyBytes + 1) }), { name: "BodyRuntimeError" });
  } finally { s.close(); }
});

for (const adapter of ADAPTERS) {
  test(`${adapter}: a body within the byte ceiling whose escaped envelope is over its bound is refused before it is journaled`, async () => {
    // A control character is one byte and six once JSON-escaped; the envelope carries the body twice.
    const s = await setup(adapter);
    try {
      const before = await journal(s);
      const body = "# x\n" + "\u0001".repeat(450_000);
      assert.ok(utf8(body) <= BODY_DELIVERY_LIMITS.bodyBytes);
      await assert.rejects(s.runtime.commit(ID, { body }), { name: "BodyRuntimeError" });
      assert.deepEqual((await journal(s)).guard, before.guard);
      assert.deepEqual(await s.backend.listIntents(), []);
      await s.runtime.commit(ID, { body: largeBody("Still editable") });
      assert.equal((await s.runtime.sync()).pending, 0);
      assert.equal((await s.authority.backend.read(ID)).doc.body, largeBody("Still editable"));
    } finally { s.close(); }
  });
}
