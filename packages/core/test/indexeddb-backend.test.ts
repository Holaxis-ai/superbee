/**
 * Adversarial rows for the IndexedDB adapter's risky mechanics: single-transaction CAS under a
 * two-peer race, an interrupted (aborted) write, persistence across instances, schema refusal,
 * binary blob fidelity, and byte parity with the filesystem adapter. The contract kit proves the
 * seam; these rows attack the mechanics the kit states only once.
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
