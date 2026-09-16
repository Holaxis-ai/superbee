/**
 * The heads listing behind `query` and the status's unconfirmed count, over both adapters. Its
 * rows equal what a read of each document reports, field for field, for every journal shape a
 * document can be in and in both delivery modes; it is one transaction beyond admission
 * whatever the working copy's size; and a record whose leading block does not parse refuses
 * the listing as it refuses a read. The reference is the per-document derivation `read` still
 * makes, expressed through the public verbs, so the table states the agreement the listing
 * must keep instead of restating the provenance rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import type { OkfDocument, QueryFilter } from "@superbee/core";
import { IndexedDbBackend, INDEXEDDB_SCHEMA_VERSION, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import type { JournaledBackend, NewIntentRecord } from "@superbee/core/journaled-backend";
import { MemoryBackend } from "@superbee/core/memory-backend";
import type { PlatformQueryRow, PlatformRuntime, Provenance } from "@superbee/core/platform";
import { matchesFilter } from "@superbee/core/query-filter";
import { versionOfBytes } from "@superbee/core/versioning";

import { admitBodyMode, bodyRecordKey } from "../src/body-journal.ts";
import { baseKey, bootstrap, openLocalBundle, syncStatus as localSyncStatus } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime, UnconfirmedWorkingCopyError } from "../src/platform/browser-local.ts";
import { ADAPTERS, contested, setup as setupBody, type Adapter } from "./fixtures/body-resolution.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createRemoteFixture } from "./fixtures/remote-fixture.ts";
import { seedSyntheticBundle } from "./platform-contract.ts";

const NOW = "2026-09-15T00:30:00.000Z";
const STALE = `sha256:${"0".repeat(64)}`;
/** A token an authority might mint for bytes the working copy hashes differently. */
const OTHER_TOKEN = `sha256:${"f".repeat(64)}`;
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Heads listing\n";
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };
const FILTERS: QueryFilter[] = [{}, { type: "Note" }, { tags: ["proof"] }, { prefix: "notes/" }, { fields: { status: "draft" } }, { type: "Task", prefix: "tasks/" }];

function note(id: string, title: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title, status: "draft", tags: ["proof"] }, body };
}

/** An intent with a chosen request id, where a commit would mint one: the order of ids against sequences is then the test's to set. */
function newIntent(requestId: string, target: string, base: string | null, after?: string): NewIntentRecord {
  return { requestId, kind: "document.write", target, base, baseContent: null, createdAt: NOW, ...(after === undefined ? {} : { after }) };
}

function requestIdOf(provenance: Provenance): string {
  assert.notEqual(provenance.state, "shared-confirmed", "a local edit names its intent");
  return (provenance as Extract<Provenance, { state: "local-pending" }>).requestId;
}

/**
 * The per-document derivation through the public verbs, as `query` was built before the
 * listing: one read per stored id, the rows under the engine's filter and order, an
 * unconfirmed document omitted from the rows and counted over the whole working copy.
 */
async function readEach(runtime: PlatformRuntime, backend: JournaledBackend, filter: QueryFilter): Promise<{ rows: PlatformQueryRow[]; unconfirmed: number }> {
  const rows: PlatformQueryRow[] = [];
  let unconfirmed = 0;
  for (const id of await backend.list()) {
    try {
      const { doc, provenance } = await runtime.read(id);
      if (matchesFilter({ id, frontmatter: doc.frontmatter }, filter)) rows.push({ id, version: provenance.version, frontmatter: doc.frontmatter, provenance });
    } catch (error) {
      if (!(error instanceof UnconfirmedWorkingCopyError)) throw error;
      unconfirmed += 1;
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, unconfirmed };
}

async function assertAgreement(runtime: PlatformRuntime, backend: JournaledBackend, label: string): Promise<void> {
  for (const filter of FILTERS) {
    const reference = await readEach(runtime, backend, filter);
    assert.deepEqual(await runtime.query(filter), reference.rows, `${label}: query ${JSON.stringify(filter)}`);
    assert.equal((await runtime.syncStatus()).unconfirmed, reference.unconfirmed, `${label}: unconfirmed count`);
  }
}

/** A plain-mode working copy of the synthetic bundle over `adapter`, with the store reachable for planting bytes. */
async function plainSession(adapter: Adapter) {
  const fixture = await createRemoteFixture();
  await seedSyntheticBundle(fixture.authority);
  const factory = new IDBFactory();
  const name = `heads-listing-${adapter}`;
  const backend = adapter === "memory" ? new MemoryJournaledBackend() : new IndexedDbBackend({ databaseName: name, indexedDB: factory });
  const local = openLocalBundle(name, { backend });
  await bootstrap(fixture.remote, local);
  const runtime = createBrowserLocalRuntime({ local, remote: fixture.remote, transport: fixture.transport, actor: "process:listing", now: () => NOW, write: immediate });
  /** Store exact bytes as a document's record, bypassing the serializer: bytes the seam would never write, parsing or not. */
  const plant = (id: string, raw: string): Promise<void> => {
    if (backend instanceof MemoryJournaledBackend) return backend.storeRaw(id, raw);
    return new Promise((resolve, reject) => {
      const request = factory.open(name, INDEXEDDB_SCHEMA_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("documents", "readwrite");
        tx.objectStore("documents").put({ id, raw, version: versionOfBytes(raw), updatedBy: "process:listing", updatedAt: NOW });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  };
  return { fixture, backend, local, runtime, plant, close: () => local.close() };
}

for (const adapter of ADAPTERS) {
  test(`${adapter}: the listing equals the per-document reads across every journal shape, in plain mode`, async () => {
    const s = await plainSession(adapter);
    try {
      const { runtime, backend } = s;
      await assertAgreement(runtime, backend, "bootstrapped");

      // Every unsettled state, one per document: pending, in flight, a conflict with an edit
      // chained behind it, refused, and unknown.
      await runtime.commit("notes/alpha", { body: "alpha local\n" });
      const beta = await runtime.commit("notes/beta", { body: "beta local\n" });
      await backend.updateIntent(requestIdOf(beta.provenance), "pending", { state: "in_flight", attempts: 1 });
      const two = await runtime.commit("tasks/two", { body: "two local\n" });
      await backend.updateIntent(requestIdOf(two.provenance), "pending", { state: "conflict", attempts: 1, remote: { version: STALE, content: null } });
      await runtime.commit("tasks/two", { body: "two local again\n" });
      const one = await runtime.commit("tasks/one", { body: "one local\n" });
      await backend.updateIntent(requestIdOf(one.provenance), "pending", { state: "refused", attempts: 1, refusal: { code: "AUTH_REQUIRED", message: "refused" } });
      const convention = await runtime.commit("conventions/note", { body: "note local\n" });
      await backend.updateIntent(requestIdOf(convention.provenance), "pending", { state: "unknown", attempts: 1 });
      // An in-flight edit with a pending edit chained behind it, no conflict, whose request ids
      // sort against their sequence: the latest intent by sequence names the row.
      const chained = await backend.writeJournaled("notes/chain", note("notes/chain", "Chain", "chain one\n"), { intent: newIntent("req-zz-first", "notes/chain", null) });
      await backend.updateIntent("req-zz-first", "pending", { state: "in_flight", attempts: 1 });
      await backend.writeJournaled("notes/chain", note("notes/chain", "Chain", "chain two\n"), { expectedVersion: chained.version, intent: newIntent("req-aa-second", "notes/chain", chained.version, "req-zz-first") });
      await assertAgreement(runtime, backend, "every unsettled state");

      // An acknowledged edit whose base names its bytes; a base whose token differs while its
      // content matches; two unconfirmed records; and a document removed with its base.
      const task = await runtime.commit("conventions/task", { body: "task local\n" });
      const taskRead = await backend.readWithJournal("conventions/task");
      await backend.updateIntent(requestIdOf(task.provenance), "pending", { state: "acknowledged", attempts: 1, acknowledgedVersion: taskRead.document!.version }, { meta: [{ key: baseKey("conventions/task"), value: { version: taskRead.document!.version, content: taskRead.raw } }] });
      await backend.writeJournaled("notes/gamma", note("notes/gamma", "Gamma", "gamma\n"), { meta: ({ raw }) => [{ key: baseKey("notes/gamma"), value: { version: OTHER_TOKEN, content: raw } }] });
      await backend.writeJournaled("notes/orphan", note("notes/orphan", "Orphan", "orphan\n"));
      await backend.writeJournaled("notes/absent-base", note("notes/absent-base", "Absent", "absent\n"), { meta: [{ key: baseKey("notes/absent-base"), value: { version: null, content: null } }] });
      await backend.writeJournaled("notes/delta", note("notes/delta", "Delta", "delta\n"), { meta: ({ version, raw }) => [{ key: baseKey("notes/delta"), value: { version, content: raw } }] });
      await backend.deleteJournaled("notes/delta", { removeMeta: [baseKey("notes/delta")] });
      // Bytes the serializer never writes, an unquoted timestamp scalar, with a base naming
      // them: the listing decodes them under the working copy's v0.2 root as the read does.
      const stamped = "---\ntype: Note\ntitle: Stamp\nstatus: draft\ntags:\n  - proof\ntimestamp: 2026-07-01T12:05:00Z\n---\nstamped\n";
      await s.plant("notes/stamp", stamped);
      await backend.writeMeta(baseKey("notes/stamp"), { version: versionOfBytes(stamped), content: stamped });
      await assertAgreement(runtime, backend, "settled, differing token, unconfirmed, removed and planted");

      const rows = await runtime.query();
      assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.provenance.state])), {
        "conventions/note": "local-pending",
        "conventions/task": "shared-confirmed",
        "notes/alpha": "local-pending",
        "notes/beta": "local-pending",
        "notes/chain": "local-pending",
        "notes/gamma": "shared-confirmed",
        "notes/stamp": "shared-confirmed",
        "tasks/one": "local-pending",
        "tasks/two": "local-conflict",
      }, "unconfirmed and removed documents have no row");
      assert.equal(rows.find((row) => row.id === "notes/stamp")!.frontmatter.timestamp, "2026-07-01T12:05:00Z", "the source scalar survives, as the v0.2 root requires");
      const gamma = rows.find((row) => row.id === "notes/gamma")!;
      assert.deepEqual(gamma.provenance, { state: "shared-confirmed", version: gamma.version, acknowledged: OTHER_TOKEN }, "the base's token is reported beside the working copy's");
      const conflicted = rows.find((row) => row.id === "tasks/two")!;
      assert.equal(conflicted.provenance.state === "local-conflict" && conflicted.provenance.requestId, requestIdOf(two.provenance), "the conflict intent names the row, not the edit chained behind it");
      const chain = rows.find((row) => row.id === "notes/chain")!;
      assert.equal(requestIdOf(chain.provenance), "req-aa-second", "the latest intent by sequence names the row, whatever order the request ids sort in");
      assert.equal(requestIdOf(chain.provenance), requestIdOf((await runtime.read("notes/chain")).provenance), "the row and the read name the same intent");
      assert.equal((await runtime.syncStatus()).unconfirmed, 2);
      assert.deepEqual((await runtime.query({ prefix: "notes/" })).map((row) => row.id), ["notes/alpha", "notes/beta", "notes/chain", "notes/gamma", "notes/stamp"]);
    } finally {
      s.close();
    }
  });

  test(`${adapter}: the listing equals the per-document reads in body mode and refuses the evidence a read refuses`, async () => {
    for (const head of ["conflict", "refused"] as const) {
      const s = await setupBody(adapter);
      try {
        await assertAgreement(s.runtime, s.backend, `${head}: bootstrapped`);
        await s.runtime.commit("notes/example", { body: "Pending body" });
        await assertAgreement(s.runtime, s.backend, `${head}: pending`);
        const row = await contested(s, head, "Contested body");
        await assertAgreement(s.runtime, s.backend, `${head}: contested`);
        const [listed] = await s.runtime.query();
        assert.equal(listed?.provenance.state, head === "conflict" ? "local-conflict" : "local-pending");
        // A descriptor gone from under its intent refuses a read; the listing and the count refuse the same way.
        await s.backend.writeMeta(bodyRecordKey(row.requestId), undefined);
        const refusal = await s.runtime.read("notes/example").then(() => null, (error: unknown) => (error as Error).name);
        assert.ok(refusal, "the read refuses the corrupted evidence");
        await assert.rejects(s.runtime.query(), { name: refusal });
        await assert.rejects(s.runtime.syncStatus(), { name: refusal });
      } finally {
        s.close();
      }
    }
  });

  test(`${adapter}: a record whose leading block does not parse refuses the listing and the count as it refuses a read, naming the document`, async () => {
    const s = await plainSession(adapter);
    try {
      await s.plant("notes/alpha", "---\ntitle: [unclosed\n---\nbody\n");
      for (const verb of [() => s.runtime.query(), () => s.runtime.query({ type: "Task" }), () => s.runtime.syncStatus(), () => s.runtime.read("notes/alpha")]) {
        await assert.rejects(verb, (error: unknown) => {
          const err = error as { name?: unknown; context?: unknown };
          assert.equal(err.name, "MalformedDocumentError");
          assert.equal(err.context, "notes/alpha.md");
          return true;
        });
      }
      assert.equal((await s.runtime.read("notes/beta")).provenance.state, "shared-confirmed", "the other documents still read");
    } finally {
      s.close();
    }
  });
}

/** Delegate every member to `target` (methods bound to it) except the named overrides. */
function proxied<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

/** A factory that records every transaction opened through it: the stores it spans and its mode. */
function recordingFactory(inner: IDBFactory, log: Array<{ stores: string[]; mode: string }>): IdbFactoryLike {
  const wrapDb = (db: any) =>
    proxied(db, {
      transaction: (names: string | string[], mode?: string) => {
        log.push({ stores: [...(typeof names === "string" ? [names] : names)].sort(), mode: mode ?? "readonly" });
        return db.transaction(names, mode);
      },
    });
  return {
    open(name: string, version?: number) {
      const request = inner.open(name, version);
      return proxied(request, {
        get result() {
          return wrapDb(request.result);
        },
      });
    },
  };
}

test("indexeddb: the listing behind query and the count is one readonly transaction beyond admission, whatever the working copy's size", async () => {
  const listingTransactions: number[] = [];
  for (const size of [2, 40]) {
    const log: Array<{ stores: string[]; mode: string }> = [];
    const backend = new IndexedDbBackend({ databaseName: `heads-size-${size}`, indexedDB: recordingFactory(new IDBFactory(), log) });
    const local = openLocalBundle(`heads-size-${size}`, { backend });
    try {
      await backend.writeReserved("", "index.md", ROOT_INDEX);
      for (let index = 0; index < size; index += 1) {
        const id = `notes/note-${String(index).padStart(3, "0")}`;
        await backend.writeJournaled(id, note(id, `Note ${index}`, `body ${index}\n`), { meta: ({ version, raw }) => [{ key: baseKey(id), value: { version, content: raw } }] });
      }
      const runtime = createBrowserLocalRuntime({ local, remote: new MemoryBackend(), transport: {
        submit: async () => { throw new Error("the listing never submits"); },
        lookup: async () => { throw new Error("the listing never looks up"); },
      } });

      log.length = 0;
      await admitBodyMode(backend);
      const admission = log.length;
      log.length = 0;
      assert.equal((await runtime.query()).length, size);
      assert.equal(log.length - admission, 1, `query at ${size} documents: one transaction beyond admission`);
      assert.deepEqual(log[log.length - 1], { stores: ["documents", "intents", "meta", "reserved"], mode: "readonly" });
      listingTransactions.push(log.length);

      log.length = 0;
      await localSyncStatus(backend);
      const statusAlone = log.length;
      log.length = 0;
      assert.equal((await runtime.syncStatus()).unconfirmed, 0);
      assert.equal(log.length - statusAlone - admission, 1, `syncStatus at ${size} documents: one transaction beyond the journal status and admission`);
    } finally {
      local.close();
    }
  }
  assert.equal(listingTransactions[0], listingTransactions[1], "the transaction count does not grow with the working copy");
});
