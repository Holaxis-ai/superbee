/**
 * Adversarial rows for the IndexedDB adapter's risky mechanics: single-transaction CAS under a
 * two-peer race, an interrupted (aborted) write, persistence across instances, schema refusal,
 * binary blob fidelity, byte parity with the filesystem adapter, a close() that lands while an
 * open is in flight, a decide callback that throws inside the transaction, and the intent
 * journal: a document write and its intent commit or abort together, settling an intent is a
 * compare-and-swap two peers over one database cannot both win, the plain write path records
 * nothing, and a journaled snapshot is one readonly transaction. The contract kit (its storage
 * rows and its journal rows) proves the seam; these rows attack the mechanics the kit states
 * only once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IDBFactory } from "fake-indexeddb";

import { FilesystemBackend } from "../src/backend.js";
import { mutateDocument } from "../src/document-mutation.js";
import { IndexedDbBackend, IndexedDbSchemaError, INDEXEDDB_SCHEMA_VERSION, type IdbFactoryLike } from "../src/indexeddb-backend.js";
import { IntentStateConflict, type NewIntentRecord } from "../src/journaled-backend.js";
import type { KindRegistry } from "../src/kinds.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { OkfDocument, StorageBackend, Version } from "../src/types.js";
import { blobVersion, VersionConflict } from "../src/versioning.js";

const DB = "adversarial";
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Parity\n";

function doc(id: string, body: string, extra: Record<string, unknown> = {}): OkfDocument {
  return { id, frontmatter: { type: "Adversarial", timestamp: "2026-07-01T00:00:00.000Z", ...extra }, body };
}

function open(factory: IDBFactory, name: string): IndexedDbBackend {
  return new IndexedDbBackend({ databaseName: name, indexedDB: factory });
}

/** Delegate every member to `target` (methods bound to it) except the named overrides. */
function proxied<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    set(inner, prop, value) {
      Reflect.set(inner, prop, value, inner);
      return true;
    },
  });
}

/**
 * A factory whose object-store `put` aborts its own transaction the moment the put succeeds, when
 * armed: the row-level write happened, the commit never did. Everything else passes through.
 */
function abortAfterPutFactory(inner: IDBFactory, armed: { value: boolean }): IdbFactoryLike {
  const wrapStore = (store: any, tx: any) =>
    proxied(store, {
      put(value: unknown) {
        const request = store.put(value);
        if (armed.value) request.addEventListener("success", () => tx.abort());
        return request;
      },
    });
  const wrapTx = (tx: any) => proxied(tx, { objectStore: (name: string) => wrapStore(tx.objectStore(name), tx) });
  const wrapDb = (db: any) =>
    proxied(db, { transaction: (names: string | string[], mode?: string) => wrapTx(db.transaction(names, mode)) });
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

/**
 * A factory whose object-store `get` hands back a record whose `contentType` getter throws, when
 * armed. `writeBlob`'s decide reads that field once the stored version matches, so the throw
 * happens inside the decide callback, inside the read request's success handler.
 */
function throwingDecideFactory(inner: IDBFactory, armed: { value: boolean }, message: string): IdbFactoryLike {
  const wrapStore = (store: any) =>
    proxied(store, {
      get(key: string) {
        const request = store.get(key);
        return proxied(request, {
          get result() {
            const record = request.result;
            if (!armed.value || !record) return record;
            return {
              ...record,
              get contentType(): string {
                throw new Error(message);
              },
            };
          },
        });
      },
    });
  const wrapTx = (tx: any) => proxied(tx, { objectStore: (name: string) => wrapStore(tx.objectStore(name)) });
  const wrapDb = (db: any) =>
    proxied(db, { transaction: (names: string | string[], mode?: string) => wrapTx(db.transaction(names, mode)) });
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

/**
 * A pass-through factory that records every database handle an open request hands out, so a test
 * can close a handle the adapter leaked and let the harness exit even when the row fails.
 */
function handleTrackingFactory(inner: IDBFactory, handles: IDBDatabase[]): IdbFactoryLike {
  return {
    open(name: string, version?: number) {
      const request = inner.open(name, version);
      return proxied(request, {
        get result() {
          const db = request.result;
          if (db && !handles.includes(db)) handles.push(db);
          return db;
        },
      });
    },
  };
}

/**
 * Delete a database through the raw factory and report which event settled the request first. A
 * connection that survives `versionchange` fires `blocked`; the request then waits for it, so the
 * wait is bounded and a timeout counts as blocked too.
 */
async function deleteRaw(factory: IDBFactory, name: string, timeoutMs = 2000): Promise<"success" | "blocked" | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    const request = factory.deleteDatabase(name);
    request.onblocked = () => {
      clearTimeout(timer);
      resolve("blocked");
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve("success");
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

/** Create a database through the raw factory with the given version and object stores. */
async function createRaw(factory: IDBFactory, name: string, version: number, stores: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      for (const store of stores) request.result.createObjectStore(store);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

/** Observe a database's version and store names through the raw factory without upgrading it. */
async function describeRaw(factory: IDBFactory, name: string): Promise<{ version: number; stores: string[] }> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = Array.from({ length: db.objectStoreNames.length }, (_, i) => db.objectStoreNames.item(i)!);
      db.close();
      resolve({ version: db.version, stores });
    };
  });
}

test("IndexedDbBackend.available reports a usable factory and nothing else", () => {
  assert.equal(IndexedDbBackend.available(new IDBFactory()), true);
  assert.equal(IndexedDbBackend.available({} as unknown as IdbFactoryLike), false);
  // Node has no global indexedDB, so the default lookup reports false here.
  assert.equal(IndexedDbBackend.available(), false);
});

test("two peers racing 100 CAS rounds on one document: exactly one winner per round, loser sees the winner's version", async () => {
  const factory = new IDBFactory();
  const peers = [open(factory, DB), open(factory, DB)];
  try {
    const id = "race/document";
    let head = await peers[0]!.write(id, doc(id, "round-0"), { expectedVersion: null });
    for (let round = 1; round <= 100; round++) {
      const results = await Promise.allSettled(
        peers.map((peer, index) => peer.write(id, doc(id, `round-${round}-peer-${index}`), { expectedVersion: head })),
      );
      const wins = results.filter((r): r is PromiseFulfilledResult<Version> => r.status === "fulfilled");
      const losses = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(wins.length, 1, `round ${round}: expected one winner`);
      assert.equal(losses.length, 1, `round ${round}: expected one loser`);
      const winner = wins[0]!.value;
      const loss = losses[0]!.reason;
      assert.ok(loss instanceof VersionConflict, `round ${round}: loser must see VersionConflict`);
      assert.equal(loss.expected, head);
      assert.equal(loss.actual, winner);
      assert.notEqual(winner, head);
      const current = await peers[round % 2]!.read(id);
      assert.equal(current.version, winner);
      head = winner;
    }
  } finally {
    for (const peer of peers) peer.close();
  }
});

test("an aborted write transaction leaves the previous version readable and the token unchanged", async () => {
  const inner = new IDBFactory();
  const armed = { value: false };
  const backend = new IndexedDbBackend({ databaseName: DB, indexedDB: abortAfterPutFactory(inner, armed) });
  try {
    const id = "interrupted/document";
    const before = await backend.write(id, doc(id, "committed"));
    const reservedBefore = await backend.writeReserved("dir", "index.md", "# committed\n");
    const blobBefore = await backend.writeBlob("artifacts/a.bin", new Uint8Array([1, 2, 3]));

    armed.value = true;
    await assert.rejects(backend.write(id, doc(id, "interrupted"), { expectedVersion: before }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.name, "VersionConflict");
      assert.match(error.message, /aborted before commit/);
      return true;
    });
    await assert.rejects(backend.writeReserved("dir", "index.md", "# interrupted\n"));
    await assert.rejects(backend.writeBlob("artifacts/a.bin", new Uint8Array([9])));
    armed.value = false;

    const after = await backend.read(id);
    assert.equal(after.version, before);
    assert.equal(after.doc.body, "committed\n");
    assert.equal((await backend.readReserved("dir", "index.md"))?.version, reservedBefore);
    assert.equal((await backend.readBlob("artifacts/a.bin"))?.version, blobBefore);
    // The store is still usable and the previous token is still the CAS baseline.
    const next = await backend.write(id, doc(id, "after"), { expectedVersion: before });
    assert.equal((await backend.read(id)).version, next);
  } finally {
    backend.close();
  }
});

test("committed data survives close() and is visible to a fresh instance on the same database", async () => {
  const factory = new IDBFactory();
  const first = open(factory, DB);
  const id = "persist/document";
  const version = await first.write(id, doc(id, "persisted"), { actor: "alpha" });
  const reserved = await first.writeReserved("", "index.md", ROOT_INDEX);
  const blob = await first.writeBlob("artifacts/keep.bin", new Uint8Array([7, 8, 9]), "application/x-keep");
  first.close();
  // The closed instance reopens lazily rather than failing.
  assert.equal((await first.read(id)).version, version);
  first.close();

  const second = open(factory, DB);
  try {
    const read = await second.read(id);
    assert.equal(read.version, version);
    assert.equal(read.doc.body, "persisted\n");
    assert.deepEqual(await second.list(), [id]);
    assert.equal((await second.readReserved("", "index.md"))?.version, reserved);
    const bytes = await second.readBlob("artifacts/keep.bin");
    assert.deepEqual([...bytes!.bytes], [7, 8, 9]);
    assert.equal(bytes!.version, blob);
    assert.equal(bytes!.contentType, "application/x-keep");
    // Recorded writer is the actor fallback when the document carries no portable attribution.
    const [head] = await second.versions(id);
    assert.equal(head?.version, version);
    assert.equal(head?.actor, "alpha");
    assert.equal(head?.timestamp, "2026-07-01T00:00:00.000Z");
    // CAS across the reopen boundary: the persisted token is the baseline.
    await assert.rejects(second.write(id, doc(id, "stale"), { expectedVersion: "sha256:" + "0".repeat(64) }), VersionConflict);
    await second.write(id, doc(id, "advanced"), { expectedVersion: version });
  } finally {
    second.close();
  }
});

test("a database with a foreign layout or a newer schema version is refused, and left untouched", async () => {
  const factory = new IDBFactory();
  assert.equal(INDEXEDDB_SCHEMA_VERSION, 1);

  await createRaw(factory, "foreign", INDEXEDDB_SCHEMA_VERSION, ["somebody-elses-store"]);
  const foreign = open(factory, "foreign");
  await assert.rejects(foreign.list(), (error: unknown) => {
    assert.ok(error instanceof IndexedDbSchemaError);
    assert.match(error.message, /missing: documents, reserved, blobs/);
    return true;
  });
  assert.deepEqual(await describeRaw(factory, "foreign"), { version: 1, stores: ["somebody-elses-store"] });

  await createRaw(factory, "newer", INDEXEDDB_SCHEMA_VERSION + 1, ["documents", "reserved", "blobs"]);
  const newer = open(factory, "newer");
  await assert.rejects(newer.list(), (error: unknown) => {
    assert.ok(error instanceof IndexedDbSchemaError);
    assert.match(error.message, /newer schema version/);
    return true;
  });
  assert.deepEqual(await describeRaw(factory, "newer"), { version: 2, stores: ["blobs", "documents", "reserved"] });

  // The refusal is not sticky: a good database on the same factory opens normally.
  const good = open(factory, "good");
  await good.write("a/b", doc("a/b", "x"));
  assert.deepEqual(await good.list(), ["a/b"]);
  good.close();
  assert.deepEqual(await describeRaw(factory, "good"), { version: 1, stores: ["blobs", "documents", "intents", "meta", "reserved"] });
});

test("invalid UTF-8 blob bytes round-trip byte-identical with MemoryBackend's token", async () => {
  const factory = new IDBFactory();
  const backend = open(factory, DB);
  const memory = new MemoryBackend();
  try {
    const bytes = new Uint8Array([0x80, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x90, 0x28, 0xbc]);
    const key = "artifacts/invalid-utf8.bin";
    const idb = await backend.writeBlob(key, bytes);
    const mem = await memory.writeBlob(key, bytes);
    assert.equal(idb, mem);
    assert.equal(idb, blobVersion(bytes));
    const read = await backend.readBlob(key);
    assert.deepEqual([...read!.bytes], [...bytes]);
    assert.equal(read!.version, idb);
    // The stored bytes never alias the caller's buffer in either direction.
    bytes[0] = 0x00;
    assert.equal((await backend.readBlob(key))!.bytes[0], 0x80);
    read!.bytes[1] = 0x00;
    assert.equal((await backend.readBlob(key))!.bytes[1], 0xff);
  } finally {
    backend.close();
  }
});

test("filesystem parity: the same documents carry equal tokens and read bodies on disk and in IndexedDB, before and after one mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-idb-parity-"));
  const factory = new IDBFactory();
  const disk = new FilesystemBackend(root);
  const idb = open(factory, DB);
  try {
    const bodies: Array<[string, string]> = [
      ["parity/no-trailing-newline", "no trailing newline"],
      ["parity/crlf", "line one\r\nline two\r\n"],
      ["parity/cjk", "日本語の本文\n"],
      ["parity/emoji", "bee 🐝 and family 👨‍👩‍👧\n"],
      ["parity/bom", "\uFEFFbody starting with a byte order mark\n"],
      ["parity/literal-rule", "before\n---\nafter\n"],
    ];
    for (const backend of [disk, idb] as StorageBackend[]) {
      await backend.writeReserved("", "index.md", ROOT_INDEX);
    }

    const before = new Map<string, { diskVersion: Version; idbVersion: Version }>();
    for (const [id, body] of bodies) {
      const value = doc(id, body, { title: `Parity ${id}` });
      const diskVersion = await disk.write(id, value);
      const idbVersion = await idb.write(id, value);
      assert.equal(idbVersion, diskVersion, `${id}: write tokens differ`);
      const onDisk = await disk.read(id);
      const inIdb = await idb.read(id);
      assert.deepEqual(inIdb, onDisk, `${id}: read results differ`);
      before.set(id, { diskVersion, idbVersion });
    }
    assert.deepEqual(await idb.list(), await disk.list());
    assert.deepEqual(await idb.readMany(bodies.map(([id]) => id)), await disk.readMany(bodies.map(([id]) => id)));

    const now = () => "2026-07-02T00:00:00.000Z";
    for (const [id] of bodies) {
      const results = [];
      for (const backend of [disk, idb] as StorageBackend[]) {
        results.push(
          await mutateDocument({
            bundle: { root, backend },
            id,
            mode: "patch",
            registry: EMPTY_REGISTRY,
            strict: false,
            now,
            buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body: `${existing!.body}appended 追加 🐝` }),
          }),
        );
      }
      const [onDisk, inIdb] = results;
      assert.equal(inIdb!.version, onDisk!.version, `${id}: mutated tokens differ`);
      assert.notEqual(inIdb!.version, before.get(id)!.idbVersion);
      assert.deepEqual(inIdb!.doc, onDisk!.doc, `${id}: mutated documents differ`);
      assert.deepEqual(await idb.read(id), await disk.read(id), `${id}: post-mutation reads differ`);
    }
  } finally {
    idb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close() while the first open is in flight leaks no connection: a later deleteDatabase succeeds instead of blocking", async () => {
  const factory = new IDBFactory();
  const name = "close-during-open";
  const handles: IDBDatabase[] = [];
  const backend = new IndexedDbBackend({ databaseName: name, indexedDB: handleTrackingFactory(factory, handles) });
  try {
    // The first call starts the open; close() lands before it settles; the next call starts another.
    const first = backend.list();
    backend.close();
    const second = backend.list();
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, []);
    // The instance still works after the interleaving.
    await backend.write("a/b", doc("a/b", "after"));
    assert.deepEqual(await backend.list(), ["a/b"]);
    backend.close();
    // With every handle closed, deletion proceeds. A leaked first handle would answer its
    // versionchange by closing the instance's current handle (already gone) and keep blocking.
    assert.equal(await deleteRaw(factory, name), "success");
  } finally {
    // Closing an already-closed handle is a no-op; closing a leaked one unblocks the pending delete.
    for (const db of handles) db.close();
  }
});

test("when the reopen also fails, the retry's error surfaces and the first one is kept as its cause", async () => {
  const inner = new IDBFactory();
  // Every attempt to start a transaction throws, with a distinct error each time, so the retry
  // fails too. A persistent non-close failure such as a bad store name behaves this way.
  const thrown: Error[] = [];
  const factory: IdbFactoryLike = {
    open(name: string, version?: number) {
      const request = inner.open(name, version);
      return proxied(request, {
        get result() {
          const db = request.result;
          return db
            ? proxied(db, {
                transaction() {
                  const error = new Error(`transaction refused (attempt ${thrown.length + 1})`);
                  error.name = "NotFoundError";
                  thrown.push(error);
                  throw error;
                },
              })
            : db;
        },
      });
    },
  };

  const backend = new IndexedDbBackend({ databaseName: "reopen-also-fails", indexedDB: factory });
  const failure = await backend.list().then(
    () => null,
    (error: Error) => error,
  );
  assert.ok(failure, "the call must reject when both attempts fail");
  // Exactly two attempts: one retry, not a loop.
  assert.equal(thrown.length, 2);
  // The caller acts on the retry's error, and the first is reachable rather than discarded.
  assert.equal(failure.message, "transaction refused (attempt 2)");
  assert.equal(failure.cause, thrown[0]);
  backend.close();
});

test("close() in the same turn as an in-flight call on a warm instance reopens instead of surfacing the host's error", async () => {
  const factory = new IDBFactory();
  const backend = open(factory, "warm-close");
  // Warm the instance so the open resolves without suspending and the handle is held.
  const seedVersion = await backend.write("a/b", doc("a/b", "seed"));

  // The call is issued first, then close() lands in the same synchronous turn, before the call's
  // microtask reaches the point where it starts its transaction. `close()` documents that the
  // next operation reopens lazily; the cold path already joins the next open under exactly this
  // interleaving, and the warm path must not instead surface a raw InvalidStateError.
  const inFlight = backend.list();
  backend.close();
  assert.deepEqual(await inFlight, ["a/b"]);

  // The same holds for a write, which commits exactly once at the version it returned.
  const pendingWrite = backend.write("c/d", doc("c/d", "written across a close"));
  backend.close();
  const version = await pendingWrite;
  assert.deepEqual(await backend.list(), ["a/b", "c/d"]);
  const readBack = await backend.read("c/d");
  assert.equal(readBack.version, version);
  assert.equal(readBack.doc.body, "written across a close\n");

  // Conditional writes keep their meaning across the retry: the stale token is still refused, and
  // the current one still wins. A retry that resolved against a re-read would lose this.
  await assert.rejects(
    (async () => {
      const stale = backend.write("c/d", doc("c/d", "from a stale token"), { expectedVersion: seedVersion });
      backend.close();
      await stale;
    })(),
    VersionConflict,
  );
  const conditional = backend.write("c/d", doc("c/d", "from the current token"), { expectedVersion: version });
  backend.close();
  await conditional;
  assert.equal((await backend.read("c/d")).doc.body, "from the current token\n");
  backend.close();
});

test("a synchronous open() failure is not cached: the next call retries and succeeds once the condition clears", async () => {
  const inner = new IDBFactory();
  const denied = { value: true };
  // A host that denies storage synchronously rather than through `onerror`: an opaque origin, or
  // storage partitioned for this context. The condition then clears, as it does when a page moves
  // out of that context or the user grants storage.
  const factory: IdbFactoryLike = {
    open(name: string, version?: number) {
      if (denied.value) {
        const error = new Error("storage is denied in this context");
        error.name = "InvalidStateError";
        throw error;
      }
      return inner.open(name, version) as unknown as ReturnType<IdbFactoryLike["open"]>;
    },
  };
  const backend = new IndexedDbBackend({ databaseName: "open-denied", indexedDB: factory });

  await assert.rejects(backend.list(), /storage is denied in this context/);
  // Still denied: the failure repeats because the host still refuses, not because it was cached.
  await assert.rejects(backend.list(), /storage is denied in this context/);

  denied.value = false;
  // The instance must recover on its own. Caching the first rejection in the open slot would
  // replay it here forever, which is how the asynchronous `onerror` path already behaves.
  assert.deepEqual(await backend.list(), []);
  await backend.write("a/b", doc("a/b", "after recovery"));
  assert.deepEqual(await backend.list(), ["a/b"]);
  backend.close();
});

test("a decide callback that throws rejects the write with its own error and leaves the previous record readable", async () => {
  const inner = new IDBFactory();
  const armed = { value: false };
  const backend = new IndexedDbBackend({ databaseName: DB, indexedDB: throwingDecideFactory(inner, armed, "decide exploded") });
  try {
    const key = "artifacts/decided.bin";
    const bytes = new Uint8Array([4, 5, 6]);
    const before = await backend.writeBlob(key, bytes, "application/x-before");
    armed.value = true;
    // Same bytes, so decide compares content types and the armed getter throws inside it.
    await assert.rejects(backend.writeBlob(key, bytes, "application/x-after", { expectedVersion: before }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "decide exploded");
      assert.notEqual(error.name, "AbortError");
      return true;
    });
    armed.value = false;
    const after = await backend.readBlob(key);
    assert.equal(after?.version, before);
    assert.equal(after?.contentType, "application/x-before");
    assert.deepEqual([...after!.bytes], [4, 5, 6]);
    // The store is still usable after the aborted transaction.
    await backend.writeBlob(key, new Uint8Array([7]), undefined, { expectedVersion: before });
  } finally {
    backend.close();
  }
});

function newIntent(requestId: string, target: string, base: string | null): NewIntentRecord {
  return { requestId, kind: "document.write", target, base, baseContent: null, createdAt: "2026-09-10T00:00:00.000Z" };
}

test("writeJournaled commits the document and its intent together: an aborted transaction leaves neither", async () => {
  const inner = new IDBFactory();
  const armed = { value: false };
  const backend = new IndexedDbBackend({ databaseName: DB, indexedDB: abortAfterPutFactory(inner, armed) });
  try {
    const id = "journal/document";
    armed.value = true;
    await assert.rejects(
      backend.writeJournaled(id, doc(id, "never"), { expectedVersion: null, intent: newIntent("req-aborted", id, null) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.name, "VersionConflict");
        assert.notEqual(error.name, "IntentStateConflict");
        return true;
      },
    );
    armed.value = false;
    assert.equal(await backend.exists(id), false);
    assert.deepEqual(await backend.listIntents(), []);
    assert.equal(await backend.readMeta("intents:sequence"), undefined);

    const { version, intent } = await backend.writeJournaled(id, doc(id, "committed"), {
      expectedVersion: null,
      intent: newIntent("req-1", id, null),
      meta: [{ key: "base:" + id, value: { version: null, content: null } }],
    });
    assert.ok(intent);
    assert.equal(intent.local, version);
    assert.equal(intent.state, "pending");
    assert.equal(intent.attempts, 0);
    assert.equal(intent.sequence, 1);
    assert.equal((await backend.read(id)).version, version);
    assert.deepEqual((await backend.listIntents("pending")).map((row) => row.requestId), ["req-1"]);
    assert.deepEqual(await backend.readMeta("base:" + id), { version: null, content: null });

    // A failed document CAS records no intent and consumes no sequence number.
    await assert.rejects(
      backend.writeJournaled(id, doc(id, "stale"), { expectedVersion: "sha256:" + "0".repeat(64), intent: newIntent("req-stale", id, null) }),
      VersionConflict,
    );
    assert.equal(await backend.readIntent("req-stale"), undefined);
    assert.equal(await backend.readMeta("intents:sequence"), 1);

    // Superseding requires the old intent's state and attempts to match; a moved intent fails the whole write.
    await backend.updateIntent("req-1", "pending", { state: "in_flight", attempts: 1 });
    await assert.rejects(
      backend.writeJournaled(id, doc(id, "composed"), {
        expectedVersion: version,
        intent: newIntent("req-2", id, null),
        supersede: { requestId: "req-1", expectedState: "pending", expectedAttempts: 0 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof IntentStateConflict);
        assert.equal(error.actual, "in_flight");
        return true;
      },
    );
    assert.equal((await backend.read(id)).version, version);
    assert.equal(await backend.readIntent("req-2"), undefined);
    assert.equal((await backend.readIntent("req-1"))?.state, "in_flight");

    // With matching expectations the old intent is deleted and the new one recorded, atomically.
    await backend.updateIntent("req-1", "in_flight", { state: "pending", attempts: 0 });
    const composed = await backend.writeJournaled(id, doc(id, "composed"), {
      expectedVersion: version,
      intent: newIntent("req-2", id, null),
      supersede: { requestId: "req-1", expectedState: "pending", expectedAttempts: 0 },
    });
    assert.equal(await backend.readIntent("req-1"), undefined);
    assert.equal(composed.intent?.sequence, 2);
    assert.deepEqual((await backend.listIntents()).map((row) => row.requestId), ["req-2"]);
  } finally {
    backend.close();
  }
});

test("two peers racing to settle one intent: exactly one wins, the loser sees IntentStateConflict and changes nothing", async () => {
  const factory = new IDBFactory();
  const peers = [open(factory, DB), open(factory, DB)];
  try {
    const id = "settle/document";
    await peers[0]!.writeJournaled(id, doc(id, "edit"), { expectedVersion: null, intent: newIntent("req-race", id, null) });
    await peers[0]!.updateIntent("req-race", "pending", { state: "in_flight", attempts: 1 });
    const results = await Promise.allSettled(
      peers.map((peer, index) =>
        peer.updateIntent(
          "req-race",
          "in_flight",
          { state: "acknowledged", acknowledgedVersion: `sha256:${String(index).repeat(64)}` },
          { meta: [{ key: "base:" + id, value: { peer: index } }] },
        ),
      ),
    );
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.ok(losses[0]!.reason instanceof IntentStateConflict);
    assert.equal(losses[0]!.reason.actual, "acknowledged");
    const winner = peers.indexOf(peers[results.findIndex((r) => r.status === "fulfilled")]!);
    const settled = await peers[1]!.readIntent("req-race");
    assert.equal(settled?.state, "acknowledged");
    assert.equal(settled?.acknowledgedVersion, `sha256:${String(winner).repeat(64)}`);
    // The loser's meta row never landed: the meta put rides the same transaction as the CAS.
    assert.deepEqual(await peers[0]!.readMeta("base:" + id), { peer: winner });
    // A missing intent is the same refusal.
    await assert.rejects(peers[0]!.updateIntent("req-missing", "pending", { state: "in_flight" }), (error: unknown) => {
      assert.ok(error instanceof IntentStateConflict);
      assert.equal(error.actual, null);
      return true;
    });
  } finally {
    for (const peer of peers) peer.close();
  }
});

test("a plain write records no intent, and the journal survives a reopen on the same database", async () => {
  const factory = new IDBFactory();
  const first = open(factory, DB);
  const id = "plain/document";
  await first.write(id, doc(id, "engine path"));
  assert.deepEqual(await first.listIntents(), []);
  const journaled = await first.writeJournaled("journaled/document", doc("journaled/document", "sync path"), {
    expectedVersion: null,
    intent: newIntent("req-keep", "journaled/document", null),
  });
  await first.writeMeta("bootstrap", { generation: 1, complete: true });
  first.close();

  const second = open(factory, DB);
  try {
    const rows = await second.listIntents("pending");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.requestId, "req-keep");
    assert.equal(rows[0]!.local, journaled.version);
    assert.equal(rows[0]!.content, (await second.read("journaled/document")).version === journaled.version ? rows[0]!.content : "");
    assert.deepEqual(await second.readMeta("bootstrap"), { generation: 1, complete: true });
    assert.deepEqual(await second.list(), ["journaled/document", id]);
  } finally {
    second.close();
  }
});

/** A pass-through factory that records every `transaction(stores, mode)` the adapter opens. */
function transactionRecordingFactory(inner: IDBFactory, log: Array<{ stores: string[]; mode: string }>): IdbFactoryLike {
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

test("readWithJournal reads the document, its intents, and the named meta rows in one readonly transaction, consistent under a concurrent writeJournaled", async () => {
  const log: Array<{ stores: string[]; mode: string }> = [];
  const backend = new IndexedDbBackend({ databaseName: DB, indexedDB: transactionRecordingFactory(new IDBFactory(), log) });
  const id = "journal/snapshot";
  const base = `base:${id}`;
  try {
    await backend.writeReserved("", "index.md", ROOT_INDEX);
    const first = await backend.writeJournaled(id, doc(id, "v1"), { expectedVersion: null, meta: [{ key: base, value: { version: "shared-1", content: null } }] });

    log.length = 0;
    const snapshot = await backend.readWithJournal(id, { meta: [base, "absent:key"] });
    assert.deepEqual(log, [{ stores: ["documents", "intents", "meta", "reserved"], mode: "readonly" }], "one readonly transaction over the four stores");
    assert.equal(snapshot.document?.version, first.version);
    assert.equal(snapshot.document?.doc.body, "v1\n", "the read body carries the serializer normalization");
    assert.equal(snapshot.raw, first.raw);
    assert.deepEqual(snapshot.intents, []);
    assert.deepEqual([...snapshot.meta.entries()], [[base, { version: "shared-1", content: null }]], "an absent key has no entry");

    // Race the snapshot against a journaled write that moves the document, the journal, and the
    // base together; whichever the database serializes first, the snapshot is one moment or the other.
    const consistent = (snap: Awaited<ReturnType<typeof backend.readWithJournal>>, before: { version: string }, after: { version: string } | null): "before" | "after" => {
      if (after && snap.document?.version === after.version) {
        assert.equal(snap.intents.length, 1, "after the write, the intent is in the snapshot");
        assert.equal(snap.intents[0]!.local, after.version);
        assert.deepEqual(snap.meta.get(base), { version: "shared-2", content: null });
        return "after";
      }
      assert.equal(snap.document?.version, before.version);
      assert.deepEqual(snap.intents, [], "before the write, no intent");
      assert.deepEqual(snap.meta.get(base), { version: "shared-1", content: null });
      return "before";
    };
    const readFirst = backend.readWithJournal(id, { meta: [base] });
    const write = backend.writeJournaled(id, doc(id, "v2"), {
      expectedVersion: first.version,
      intent: newIntent("req-snapshot", id, "shared-1"),
      meta: [{ key: base, value: { version: "shared-2", content: null } }],
    });
    const readSecond = backend.readWithJournal(id, { meta: [base] });
    const [early, written, late] = await Promise.all([readFirst, write, readSecond]);
    const moments = [consistent(early, first, written), consistent(late, first, written)];
    assert.ok(!(moments[0] === "after" && moments[1] === "before"), "a snapshot started after the write cannot predate one started before it");
    const settled = await backend.readWithJournal(id, { meta: [base] });
    assert.equal(consistent(settled, first, written), "after");
    assert.deepEqual(await backend.readWithJournal("journal/absent"), { document: null, raw: null, intents: [], meta: new Map() });
  } finally {
    backend.close();
  }
});
