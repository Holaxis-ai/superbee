import test from "node:test";
import { deletionBound, acceptsRefusal } from "@superbee/core/platform";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, symlink, writeFile, truncate, readFile, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// Existing lower-only test seam; use built module to share the package backend's symbol.
import { STORE_BYTE_LIMIT } from "../../core/dist/file-journaled-backend-internal.js";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { prepareBlobIntent, decodePreparedBlobIntent, blobReceipt, compareStorageKeys, type BlobTargetScope } from "@superbee/core/storage";
import { decodeHostedCapabilities, type HostedCarrier } from "@superbee/core/hosted-transport";
import { createHash, randomUUID } from "node:crypto";
import { refreshBlobCheckout, blobHostDeletionsToken, BLOB_SYNC_META_KEY, captureBlobSyncMap, encodeBlobSyncMap, decodeBlobSyncMap, changeBlobSyncEntry, blobSyncDirty, seedBlobSyncEntry, readBlobSyncState, settleBlobSyncReceipt, seedInitialBlobBaselines, captureTrackedBlobChanges, stageBlobPlacement, recoverBlobPlacements, type BlobSyncMap } from "../src/hosted/blob-sync.js";
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const scope: BlobTargetScope = { origin: "https://example.test", prefix: "/sync/v1", bundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceSlug: "team" };
const empty = (): BlobSyncMap => ({ schemaVersion: 1 as const, scope, entries: [] });
test("canonical scoped baselines preserve unknown versus absent and explicit offline MIME", () => {
  const map = changeBlobSyncEntry(empty(), { key: "a.bin", placedDigest: null, desiredContentType: "image/svg+xml" });
  const recovered = decodeBlobSyncMap(encodeBlobSyncMap(map), scope);
  assert.equal(Object.hasOwn(recovered.entries[0]!, "head"), false);
  assert.equal(blobSyncDirty(recovered.entries[0]!, null), true);
  const absent = { key: "a.bin", head: null, placedDigest: null };
  assert.equal(blobSyncDirty(absent, null), false);
  assert.equal(blobSyncDirty(absent, digest("recreated")), true);
  assert.throws(() => decodeBlobSyncMap(encodeBlobSyncMap(map), { ...scope, workspaceSlug: "other" }));
  assert.throws(() => seedBlobSyncEntry({ key: "a.bin", version: digest("remote"), contentType: "x/y" }, digest("local")));
  assert.throws(() => captureBlobSyncMap({ ...empty(), entries: [absent, absent] }, scope));
  assert.throws(() => decodeBlobSyncMap(' ' + encodeBlobSyncMap(map), scope));
});
test("map bounds reject actual escaped UTF8 metadata, invalid pins, and excess entries", () => {
  const entries = Array.from({ length: 10_000 }, (_, i) => ({ key: `${i}/` + '"'.repeat(490), placedDigest: null, head: { key: `${i}/` + '"'.repeat(490), version: digest("x"), contentType: '"'.repeat(1024) }, desiredContentType: '"'.repeat(1024) }));
  assert.throws(() => captureBlobSyncMap({ ...empty(), entries }, scope), /byte bound/);
  assert.throws(() => captureBlobSyncMap({ ...empty(), entries: Array.from({ length: 10_001 }, (_, i) => ({ key: `${i}`, placedDigest: null })) }, scope));
  assert.throws(() => changeBlobSyncEntry(empty(), { key: "../bad", placedDigest: null }));
  assert.throws(() => changeBlobSyncEntry(empty(), { key: "good", placedDigest: null, desiredContentType: " x/y" }));
});
test("selected receipt and whole map settle atomically; newer bytes and later MIME stay dirty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-sync-"));
  const backend = await FileJournaledBackend.open({ directory: dir, lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  try {
    const bytes = Buffer.from("sent");
    const intent = { operationId: "blobs.create.v1" as const, key: "a.bin", expectedVersion: null, expectedContentType: null, version: digest("sent"), contentType: "x/original" };
    const prepared = prepareBlobIntent({ scope, intent, identity: { requestId: randomUUID(), binding: digest("checkout") }, createdAt: new Date().toISOString() }, bytes);
    let read = await backend.readBlobWithJournal("a.bin", { meta: [BLOB_SYNC_META_KEY] });
    const map = changeBlobSyncEntry(empty(), { key: "a.bin", placedDigest: digest("old"), desiredContentType: "x/later" });
    const row = await backend.admitPreparedBlob(prepared, { guard: read.guard, meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(map) }] });
    const snapshot = await readBlobSyncState(backend, "a.bin", scope);
    const receipt = blobReceipt(prepared, { ok: true, operationId: intent.operationId, data: { key: intent.key, version: intent.version, contentType: intent.contentType, changed: true } });
    await backend.writeMeta("unrelated", true);
    const settled = await settleBlobSyncReceipt(backend, snapshot, row, { state: "acknowledged", receipt });
    assert.equal(settled.state, "acknowledged");
    const after = await readBlobSyncState(backend, "a.bin", scope);
    const entry = after.map.entries[0]!;
    assert.equal(entry.placedDigest, digest("sent"));
    assert.equal(entry.desiredContentType, "x/later");
    assert.equal(blobSyncDirty(entry, digest("newer")), true);
    assert.equal(blobSyncDirty(entry, digest("old")), true);
    assert.equal(blobSyncDirty(entry, digest("sent")), true); // later MIME still unapplied
    await assert.rejects(settleBlobSyncReceipt(backend, snapshot, row, { state: "acknowledged", receipt }));
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
test("whole-map CAS protects another key; selected delete leaves physical recreation dirty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-sync-delete-"));
  const backend = await FileJournaledBackend.open({ directory: dir, lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  try {
    const intent = { operationId: "blobs.delete.v1" as const, key: "a.bin", expectedVersion: digest("old"), expectedContentType: "x/old" };
    const prepared = prepareBlobIntent({ scope, intent, identity: { requestId: randomUUID(), binding: digest("checkout") }, createdAt: new Date().toISOString() });
    const initial = await backend.readBlobWithJournal("a.bin", { meta: [BLOB_SYNC_META_KEY] });
    const row = await backend.admitPreparedBlob(prepared, { guard: initial.guard });
    const stale = await readBlobSyncState(backend, "a.bin", scope);
    await backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(changeBlobSyncEntry(empty(), { key: "other.bin", placedDigest: null, desiredContentType: "x/offline" })));
    const receipt = blobReceipt(prepared, { ok: true, operationId: intent.operationId, data: { key: intent.key, version: intent.expectedVersion, contentType: intent.expectedContentType, deleted: true } });
    await assert.rejects(settleBlobSyncReceipt(backend, stale, row, { state: "acknowledged", receipt }));
    assert.equal((await backend.readBlobIntent(row.requestId))!.state, "pending");
    await settleBlobSyncReceipt(backend, await readBlobSyncState(backend, "a.bin", scope), row, { state: "acknowledged", receipt });
    const after = await readBlobSyncState(backend, "a.bin", scope);
    assert.equal(after.map.entries.length, 2);
    const entry = after.map.entries.find(row => row.key === "a.bin")!;
    assert.equal(entry.head, null);
    assert.equal(entry.placedDigest, null);
    assert.equal(blobSyncDirty(entry, digest("recreated")), true);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
test("initial baselines refuse unsafe/oversize/protected files and retain existing journal evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-seed-"));
  const backend = await FileJournaledBackend.open({ directory: path.join(dir, "store"), lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  const folder = path.join(dir, "folder");
  await mkdir(folder);
  try {
    await writeFile(path.join(dir, "outside"), "small");
    await symlink(path.join(dir, "outside"), path.join(folder, "leaf.bin"));
    await mkdir(path.join(dir, "outside-dir"));
    await writeFile(path.join(dir, "outside-dir", "x.bin"), "small");
    await symlink(path.join(dir, "outside-dir"), path.join(folder, "ancestor"));
    await writeFile(path.join(folder, "big.bin"), "");
    await truncate(path.join(folder, "big.bin"), 16 * 1024 * 1024 + 1); // sparse; no large allocation/read
    await writeFile(path.join(folder, "a.bin"), "small");
    await mkdir(path.join(folder, "References"));
    await writeFile(path.join(folder, "References", "x.bin"), "small");
    const keys = ["References/x.bin", "a.bin", "ancestor/x.bin", "big.bin", "leaf.bin"];
    keys.sort(compareStorageKeys);
    const heads = keys.map(key => ({ key, version: digest("small"), contentType: "x/binary" }));
    const carrier: HostedCarrier = { stream: async () => { throw new Error("no blob content read expected"); }, json: async () => ({ status: 200, headers: new Headers(), body: { schemaVersion: 1, bundleId: scope.bundleId, revision: 1, digest: digest(JSON.stringify([1, heads.map(row => [row.key, row.version, row.contentType])])), total: heads.length, heads, next: null } }) };
    const options = { folder, scope, exported: Object.fromEntries(keys.map(key => [key, digest("small")])), store: backend, carrier, capabilities: async () => decodeHostedCapabilities({ heads: true, snapshot: true, operations: true, root: null, bound: { documents: 10000, bytes: 1000000 }, blobReads: "allowed", limits: { blobReadBytes: 16 * 1024 * 1024 } }) };
    const capacityStore = { readMeta: backend.readMeta.bind(backend), writeMeta: async () => { throw new RangeError("a projected snapshot of 999 bytes exceeds the store's 100 byte bound"); } };
    assert.equal((await seedInitialBlobBaselines({ ...options, store: capacityStore })).state, "capacity");
    assert.equal(await backend.readMeta(BLOB_SYNC_META_KEY), undefined);
    assert.deepEqual(await seedInitialBlobBaselines(options), { state: "seeded", count: 1 });
    const saved = await backend.readMeta(BLOB_SYNC_META_KEY);
    const prepared = prepareBlobIntent({ scope, intent: { operationId: "blobs.delete.v1", key: "a.bin", expectedVersion: digest("small"), expectedContentType: "x/binary" }, identity: { requestId: randomUUID(), binding: digest("checkout") }, createdAt: new Date().toISOString() });
    const row = await backend.admitPreparedBlob(prepared, { guard: (await backend.readBlobWithJournal("a.bin")).guard });
    assert.equal((await seedInitialBlobBaselines({ ...options, carrier: { ...carrier, json: async () => { throw new Error("retained map must not request heads"); } } })).state, "retained");
    assert.deepEqual(await backend.readMeta(BLOB_SYNC_META_KEY), saved);
    assert.deepEqual(await backend.readBlobIntent(row.requestId), row);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
test("capture distinguishes absent, unsafe and UNKNOWN; whole-map races refuse fresh intent atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-capture-")), folder = path.join(dir, "files");
  await mkdir(folder);
  const backend = await FileJournaledBackend.open({ directory: path.join(dir, "store"), lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  try {
    await writeFile(path.join(dir, "outside"), "secret");
    await symlink(path.join(dir, "outside"), path.join(folder, "b.bin"));
    let map = empty();
    for (const key of ["a.bin", "b.bin"]) map = changeBlobSyncEntry(map, seedBlobSyncEntry({ key, version: digest("old"), contentType: "image/svg+xml" }, digest("old")));
    map = changeBlobSyncEntry(map, { key: "c.bin", placedDigest: null, desiredContentType: "x/offline" });
    await writeFile(path.join(folder, "c.bin"), "untracked");
    await backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(map));
    const context = { store: backend, scope, binding: digest("checkout"), via: "capture-owner", createdAt: new Date().toISOString(), allowed: true };
    const first = await captureTrackedBlobChanges(folder, context);
    assert.equal(first.held.length, 3);
    const records = await backend.listBlobIntents();
    assert.equal(records.length, 1);
    const prepared = decodePreparedBlobIntent(records[0]!.prepared);
    assert.equal(prepared.intent.operationId, "blobs.delete.v1");
    assert.equal(prepared.intent.expectedContentType, "image/svg+xml");
    assert.equal(prepared.bytesBase64, undefined);
    assert.equal(prepared.identity.via, "capture-owner");
    assert.deepEqual(await backend.readMeta(BLOB_SYNC_META_KEY), encodeBlobSyncMap(map));
    await captureTrackedBlobChanges(folder, context);
    assert.equal((await backend.listBlobIntents()).length, 1);
    map = changeBlobSyncEntry(map, seedBlobSyncEntry({ key: "z.bin", version: digest("base"), contentType: "x/observed" }, digest("base")));
    await backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(map));
    await writeFile(path.join(folder, "z.bin"), "changed");
    const racing = new Proxy(backend, { get(target, key) {
      if (key === "admitPreparedBlob") return async (payload: string, options: Parameters<typeof backend.admitPreparedBlob>[1]) => {
        await backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(changeBlobSyncEntry(map, { key: "other.bin", placedDigest: null })));
        return target.admitPreparedBlob(payload, options);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const refused = await captureTrackedBlobChanges(folder, { ...context, store: racing });
    assert.match(refused.held.find(row => row.key === "z.bin")!.message, /could not be captured/);
    assert.equal((await backend.listBlobIntents()).length, 1);
    assert.equal((decodeBlobSyncMap(await backend.readMeta(BLOB_SYNC_META_KEY), scope)).entries.some(row => row.key === "other.bin"), true);
    assert.equal(await readFile(path.join(folder, "z.bin"), "utf8"), "changed");
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
test("corrupt .md blob metadata is rejected by capture before any file or journal mutation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-md-"));
  const backend = await FileJournaledBackend.open({ directory: path.join(dir, "store"), lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  try {
    const file = path.join(dir, "opaque.md");
    await writeFile(file, "preserve me");
    const corrupt = JSON.stringify({ schemaVersion: 1, scope, entries: [{ key: "opaque.md", head: { key: "opaque.md", version: digest("old"), contentType: "x/binary" }, placedDigest: digest("old") }] });
    await backend.writeMeta(BLOB_SYNC_META_KEY, corrupt);
    await assert.rejects(captureTrackedBlobChanges(dir, { store: backend, scope, binding: digest("checkout"), createdAt: new Date().toISOString(), allowed: true }), /unsafe blob key/);
    assert.equal((await backend.listBlobIntents()).length, 0);
    assert.equal(await readFile(file, "utf8"), "preserve me");
    assert.equal(await backend.readMeta(BLOB_SYNC_META_KEY), corrupt);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});

async function placementFixture(operation: "create" | "replace" | "delete", key = "opaque.bin") {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-placement-")), folder = path.join(dir, "files");
  await mkdir(folder);
  const options = { directory: path.join(dir, "store"), lock: { lockRoot: path.join(dir, "locks"), waitMs: 2000 } };
  const store = await FileJournaledBackend.open(options);
  let map = empty();
  if (operation !== "create") {
    await writeFile(path.join(folder, key), "old");
    map = changeBlobSyncEntry(map, { ...seedBlobSyncEntry({ key, version: digest("old"), contentType: "x/old" }, digest("old")), desiredContentType: "x/old" });
  }
  await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(map));
  await store.close();
  return { dir, folder, options, key, map, async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}
function placementCrash(f: Awaited<ReturnType<typeof placementFixture>>, operation: "create" | "replace" | "delete", cut: "prepare" | "installed" | "committed" | "cleanup") {
  const script = `
    import { promises as fs } from 'node:fs';
import { FileJournaledBackend } from '@superbee/core/file-journaled-backend';
    const m = await import(${JSON.stringify(new URL("../src/hosted/blob-sync.ts", import.meta.url).href)});
    const store = await FileJournaledBackend.open(${JSON.stringify(f.options)});
    const original = store.writeBlobMeta.bind(store); let calls = 0, committed = false;
    const stop = () => process.kill(process.pid, 'SIGKILL');
    store.writeBlobMeta = async (...args) => {
      calls++;
      if (${JSON.stringify(cut)} === 'installed' && calls === 3) stop();
      await original(...args);
      if (calls === 3) committed = true;
      if (${JSON.stringify(cut)} === 'prepare' && calls === 1 || ${JSON.stringify(cut)} === 'committed' && calls === 3) stop();
    };
    const unlink = fs.unlink;
    fs.unlink = async file => { await unlink(file); if (${JSON.stringify(cut)} === 'cleanup' && committed && String(file).includes('.superbee-bp-')) stop(); };
    const head = ${operation === "delete" ? "null" : JSON.stringify({ key: f.key, version: digest("new"), contentType: "x/new" })};
    await m.stageBlobPlacement(${JSON.stringify(f.folder)}, store, await m.readBlobSyncState(store, ${JSON.stringify(f.key)}, ${JSON.stringify(scope)}), { key: ${JSON.stringify(f.key)}, head, ...(head ? { bytes: Buffer.from('new') } : {}) });
    process.exit(99);
  `;
  try { execFileSync(process.execPath, ["--import", new URL("./ts-loader.mjs", import.meta.url).pathname, "--input-type=module", "-e", script], { cwd: process.cwd(), timeout: 15_000, stdio: "pipe" }); assert.fail("child did not stop"); }
  catch (error) { assert.equal((error as { signal?: string }).signal, "SIGKILL", error instanceof Error ? error.message : String(error)); }
}
test("placement WAL recovers create/replace/delete at finite durable cut points, twice", async () => {
  for (const operation of ["create", "replace", "delete"] as const) {
    for (const cut of ["prepare", "installed", "committed", "cleanup"] as const) {
      const f = await placementFixture(operation);
      try {
        placementCrash(f, operation, cut);
        const store = await FileJournaledBackend.open(f.options);
        try {
          const before = await readBlobSyncState(store, f.key, scope);
          assert.equal(before.map.entries[0]!.placement!.state, cut === "prepare" || cut === "installed" ? "pending" : "committed");
          assert.deepEqual((await recoverBlobPlacements(f.folder, store, scope)).held, [], `${operation}/${cut}`);
          assert.deepEqual((await recoverBlobPlacements(f.folder, store, scope)).held, [], "idempotent recovery");
          const committed = cut === "committed" || cut === "cleanup", absent = committed ? operation === "delete" : operation === "create";
          if (absent) await assert.rejects(readFile(path.join(f.folder, f.key)), { code: "ENOENT" });
          else assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), committed ? "new" : "old");
          const after = await readBlobSyncState(store, f.key, scope), entry = after.map.entries[0];
          assert.equal(entry?.placement, undefined);
          if (!committed) assert.deepEqual(after.map, f.map);
          else { assert.equal(entry!.placedDigest, operation === "delete" ? null : digest("new")); assert.equal(entry!.desiredContentType, operation === "create" ? undefined : "x/old"); }
        } finally { await store.close(); }
      } finally { await f.cleanup(); }
    }
  }
});
test("placement preserves independent new bytes, user edits/recreation and changed preimage evidence", async () => {
  for (const mutation of ["installed-edit", "recreated", "preimage", "committed-edit"] as const) {
    const f = await placementFixture("replace");
    try {
      placementCrash(f, "replace", mutation === "committed-edit" ? "committed" : "installed");
      const store = await FileJournaledBackend.open(f.options);
      try {
        const snapshot = await readBlobSyncState(store, f.key, scope), id = snapshot.map.entries[0]!.placement!.id;
        const stage = (role: string) => path.join(f.folder, `.superbee-bp-${id}-${role}.tmp`);
        if (mutation === "recreated") { await unlink(path.join(f.folder, f.key)); await writeFile(path.join(f.folder, f.key), "new"); }
        else await writeFile(mutation === "preimage" ? stage("pre") : path.join(f.folder, f.key), "user edit");
        assert.equal(await readFile(stage("new"), "utf8"), "new", "immutable new bytes do not share installed inode");
        const result = await recoverBlobPlacements(f.folder, store, scope);
        if (mutation === "committed-edit") {
          assert.deepEqual(result.held, []);
          const entry = (await readBlobSyncState(store, f.key, scope)).map.entries[0]!;
          assert.equal(entry.placement, undefined);
          assert.equal(blobSyncDirty(entry, digest("user edit")), true);
        } else { assert.equal(result.held.length, 1); assert.ok((await readBlobSyncState(store, f.key, scope)).map.entries[0]!.placement); }
        if (mutation === "preimage") assert.equal(await readFile(stage("pre"), "utf8"), "user edit");
        else assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), mutation === "recreated" ? "new" : "user edit");
      } finally { await store.close(); }
    } finally { await f.cleanup(); }
  }
});
test("normal staged placement resolves lost metadata acknowledgments and supports a 255-byte leaf", async () => {
  const f = await placementFixture("replace", "x".repeat(255));
  const store = await FileJournaledBackend.open(f.options);
  try {
    const proxy = new Proxy(store, { get(target, key) { if (key === "writeBlobMeta") return async (...args: Parameters<typeof store.writeBlobMeta>) => { await target.writeBlobMeta(...args); throw new Error("lost durable acknowledgment"); }; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    const snapshot = await readBlobSyncState(store, f.key, scope);
    assert.equal(await stageBlobPlacement(f.folder, proxy, snapshot, { key: f.key, head: { key: f.key, version: digest("new"), contentType: "x/new" }, bytes: Buffer.from("new") }), "placed");
    assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), "new");
    assert.equal((await readBlobSyncState(store, f.key, scope)).map.entries[0]!.placement, undefined);
    assert.deepEqual((await readdir(f.folder)).filter(name => name.startsWith(".superbee-bp-")), []);
  } finally { await store.close(); await f.cleanup(); }
});
test("placement metadata capacity refusal after installation leaves WAL and recovers original bytes", async () => {
  const f = await placementFixture("replace");
  const limitedOptions = { ...f.options, [STORE_BYTE_LIMIT]: 5000 };
  const store = await FileJournaledBackend.open(limitedOptions);
  let calls = 0, refused = false;
  try {
    const proxy = new Proxy(store, { get(target, key) {
      if (key === "writeBlobMeta") return async (...args: Parameters<typeof store.writeBlobMeta>) => {
        if (++calls === 3) {
          let low = 0, high = 5000;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            try { await target.writeMeta("padding", "x".repeat(middle)); low = middle; }
            catch (error) { if (!(error instanceof RangeError)) throw error; high = middle - 1; }
          }
          for (;;) { try { await target.writeMeta("padding", "x".repeat(low)); break; } catch (error) { if (!(error instanceof RangeError) || low === 0) throw error; low--; } }
        }
        try { await target.writeBlobMeta(...args); } catch (error) { if (calls === 3 && error instanceof RangeError) refused = true; throw error; }
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await stageBlobPlacement(f.folder, proxy, await readBlobSyncState(store, f.key, scope), { key: f.key, head: { key: f.key, version: digest("new"), contentType: "x/new" }, bytes: Buffer.from("new") });
    assert.equal(refused, true, "actual projected store budget refuses committed map growth");
    assert.equal(result, "held");
    assert.equal((await readBlobSyncState(store, f.key, scope)).map.entries[0]!.placement!.state, "pending");
    assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), "new");
    assert.deepEqual((await recoverBlobPlacements(f.folder, store, scope)).held, []);
    assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), "old");
    assert.deepEqual((await readBlobSyncState(store, f.key, scope)).map, f.map);
  } finally { await store.close(); await f.cleanup(); }
});
test("staged placement refuses stale maps, same-byte physical replace and malformed descriptors before mutation", async () => {
  const f = await placementFixture("replace"), store = await FileJournaledBackend.open(f.options);
  try {
    const snapshot = await readBlobSyncState(store, f.key, scope);
    await assert.rejects(stageBlobPlacement(f.folder, store, snapshot, { key: f.key, head: { key: f.key, version: digest("old"), contentType: "x/metadata-only" }, bytes: Buffer.from("old") }), /operation mismatch/);
    const other = changeBlobSyncEntry(f.map, { key: "other.bin", placedDigest: null });
    await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(other));
    await assert.rejects(stageBlobPlacement(f.folder, store, snapshot, { key: f.key, head: { key: f.key, version: digest("new"), contentType: "x/new" }, bytes: Buffer.from("new") }));
    assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), "old");
    assert.deepEqual((await readdir(f.folder)).filter(name => name.startsWith(".superbee-bp-")), []);
    const malformed = structuredClone(other);
    malformed.entries[0]!.placement = { id: "not-a-uuid", operation: "replace", state: "pending", original: f.map.entries[0]!, intended: { head: { key: f.key, version: digest("new"), contentType: "x/new" }, placedDigest: digest("new") } };
    assert.throws(() => captureBlobSyncMap(malformed, scope), /invalid placement descriptor/);
    malformed.entries[0]!.placement!.id = randomUUID();
    assert.throws(() => captureBlobSyncMap({ ...malformed, entries: [{ ...malformed.entries[0]!, placement: { ...malformed.entries[0]!.placement!, extra: "x".repeat(20000) } }] } as unknown as BlobSyncMap, scope), /invalid placement descriptor/);
    assert.throws(() => captureBlobSyncMap({ ...malformed, entries: [{ ...malformed.entries[0]!, placement: { ...malformed.entries[0]!.placement!, install: { dev: "1".repeat(33), ino: "1", mtimeNs: "1" } } }] }, scope), /invalid placement identity/);
    assert.throws(() => captureBlobSyncMap({ ...malformed, entries: [{ ...malformed.entries[0]!, placement: { ...malformed.entries[0]!.placement!, original: { ...malformed.entries[0]!, placement: malformed.entries[0]!.placement! } } }] } as unknown as BlobSyncMap, scope), /recursive placement original/);
  } finally { await store.close(); await f.cleanup(); }
});
test("selected receipt cannot retire pending or committed placement WAL", async () => {
  const f = await placementFixture("replace"), store = await FileJournaledBackend.open(f.options);
  try {
    const frozen = prepareBlobIntent({ scope, intent: { operationId: "blobs.create.v1", key: f.key, expectedVersion: null, expectedContentType: null, version: digest("old"), contentType: "x/old" }, identity: { requestId: randomUUID(), binding: digest("checkout") }, createdAt: new Date().toISOString() }, Buffer.from("old"));
    const row = await store.admitPreparedBlob(frozen, { guard: (await store.readBlobWithJournal(f.key)).guard });
    const receipt = blobReceipt(frozen, { ok: true, operationId: "blobs.create.v1", data: { key: f.key, version: digest("old"), contentType: "x/old", changed: true } });
    const terminal = await store.updateBlobIntent(row.requestId, "pending", { state: "acknowledged", receipt }, { guard: (await store.readBlobWithJournal(f.key)).guard });
    for (const state of ["pending", "committed"] as const) {
      const original = f.map.entries[0]!, head = { key: f.key, version: digest("new"), contentType: "x/new" };
      const identity = { dev: "1", ino: "2", mtimeNs: "3" };
      const entry = { ...(state === "pending" ? original : { key: f.key, head, placedDigest: head.version, desiredContentType: original.desiredContentType }), placement: { id: randomUUID(), operation: "replace" as const, state, original, intended: { head, placedDigest: head.version }, ...(state === "committed" ? { install: identity, preimage: identity } : {}) } };
      const map = captureBlobSyncMap({ ...f.map, entries: [entry] }, scope);
      await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(map));
      await assert.rejects(settleBlobSyncReceipt(store, await readBlobSyncState(store, f.key, scope), terminal, { state: "acknowledged", receipt }), /waits for placement recovery/);
      assert.equal(await store.readMeta(BLOB_SYNC_META_KEY), encodeBlobSyncMap(map));
      assert.deepEqual(await store.readBlobIntent(row.requestId), terminal);
    }
  } finally { await store.close(); await f.cleanup(); }
});
test("generic entry updates cannot drop or rewrite real pending/committed placement authority", async () => {
  for (const cut of ["installed", "committed"] as const) {
    const f = await placementFixture("replace");
    try {
      placementCrash(f, "replace", cut);
      const store = await FileJournaledBackend.open(f.options);
      try {
        const snapshot = await readBlobSyncState(store, f.key, scope), current = snapshot.map.entries[0]!;
        const { placement: _placement, ...ordinary } = current;
        assert.throws(() => changeBlobSyncEntry(snapshot.map, ordinary), /cannot alter placement WAL/);
        assert.throws(() => changeBlobSyncEntry(snapshot.map, { ...current, placement: { ...current.placement!, id: randomUUID() } }), /cannot alter placement WAL/);
        const next = changeBlobSyncEntry(snapshot.map, { key: "other.bin", placedDigest: null });
        await store.writeBlobMeta(f.key, { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(next) }] }, { guard: snapshot.journal.guard });
        assert.deepEqual((await readBlobSyncState(store, f.key, scope)).map.entries.find(row => row.key === f.key)!.placement, current.placement);
        assert.deepEqual((await recoverBlobPlacements(f.folder, store, scope)).held, []);
        assert.equal((await readBlobSyncState(store, f.key, scope)).map.entries.some(row => row.key === "other.bin"), true);
      } finally { await store.close(); }
    } finally { await f.cleanup(); }
  }
});
test("unapplied explicit MIME refuses placement before WAL or filesystem work and preserves its old CAS", async () => {
  const f = await placementFixture("replace"), store = await FileJournaledBackend.open(f.options);
  try {
    const map = changeBlobSyncEntry(f.map, { ...f.map.entries[0]!, desiredContentType: "x/local-choice" });
    const original = encodeBlobSyncMap(map);
    await store.writeMeta(BLOB_SYNC_META_KEY, original);
    const snapshot = await readBlobSyncState(store, f.key, scope);
    assert.equal(await stageBlobPlacement(f.folder, store, snapshot, { key: f.key, head: { key: f.key, version: digest("new"), contentType: "x/remote" }, bytes: Buffer.from("new") }), "held");
    assert.equal(await store.readMeta(BLOB_SYNC_META_KEY), original);
    assert.deepEqual(await readdir(f.folder), [f.key]);
    assert.equal(await readFile(path.join(f.folder, f.key), "utf8"), "old");
    assert.equal(snapshot.map.entries[0]!.head!.version, digest("old"));
    assert.equal(snapshot.map.entries[0]!.head!.contentType, "x/old");
  } finally { await store.close(); await f.cleanup(); }
});

function refreshHost(rows: { key: string; bytes: Buffer; contentType: string }[], hooks: { beforeRead?: (key: string) => Promise<void>; readFailure?: boolean; listingFailure?: boolean; revision?: number } = {}) {
  const heads = rows.map(row => ({ key: row.key, version: digest(row.bytes.toString("base64")), contentType: row.contentType }));
  // Binary versions hash the original bytes, never a UTF8 conversion.
  for (let i = 0; i < heads.length; i++) heads[i]!.version = `sha256:${createHash("sha256").update(rows[i]!.bytes).digest("hex")}`;
  heads.sort((a, b) => compareStorageKeys(a.key, b.key));
  let reads = 0, lists = 0;
  const revision = hooks.revision ?? 1;
  const carrier: HostedCarrier = {
    json: async () => { lists++; return hooks.listingFailure ? { status: 503, headers: new Headers(), body: { error: "unavailable" } } : { status: 200, headers: new Headers(), body: { schemaVersion: 1, bundleId: scope.bundleId, revision, digest: digest(JSON.stringify([revision, heads.map(row => [row.key, row.version, row.contentType])])), total: heads.length, heads, next: null } }; },
    stream: async (_route, body) => {
      const pin = body as { key: string }; reads++; await hooks.beforeRead?.(pin.key);
      if (hooks.readFailure) return { ok: false, status: 409, headers: new Headers(), body: new ReadableStream({ start(c) { c.close(); } }) };
      const row = rows.find(row => row.key === pin.key)!, head = heads.find(head => head.key === pin.key)!;
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/octet-stream", "content-length": String(row.bytes.length), "x-superbee-blob-version": head.version, "x-superbee-content-type": head.contentType }), body: new ReadableStream({ start(c) { c.enqueue(row.bytes); c.close(); } }) };
    },
  };
  return { carrier, counts: () => ({ lists, reads }) };
}
const readCaps = async () => decodeHostedCapabilities({ heads: true, snapshot: true, operations: true, root: null, bound: { documents: 10000, bytes: 1000000 }, blobReads: "allowed", blobWrites: "refused", limits: { blobReadBytes: 16 * 1024 * 1024 } });
async function refreshFixture(entries: BlobSyncMap["entries"] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "blob-refresh-")), folder = path.join(dir, "files"); await mkdir(folder);
  const backend = await FileJournaledBackend.open({ directory: path.join(dir, "store"), lock: { lockRoot: path.join(dir, "locks"), waitMs: 0 } });
  await backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap({ ...empty(), entries }));
  return { folder, backend, close: async () => { await backend.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("blob refresh places exact binary create/replace/delete with read-only capability and same-byte parameterized MIME", async () => {
  const old = Buffer.from("old"), key = "replace.bin", removed = "gone.bin";
  const f = await refreshFixture([key, removed].map(key => seedBlobSyncEntry({ key, version: digest("old"), contentType: "x/old" }, digest("old"))));
  try {
    await writeFile(path.join(f.folder, key), old); await writeFile(path.join(f.folder, removed), old);
    const binary = Buffer.from([0, 255, 128]), host = refreshHost([{ key, bytes: binary, contentType: 'image/svg+xml; charset="utf-8"' }, { key: "new.bin", bytes: binary, contentType: "x/new" }]);
    const out = await refreshBlobCheckout({ ...f, store: f.backend, scope, carrier: host.carrier, capabilities: readCaps });
    assert.deepEqual(out?.refreshed.sort(), ["new.bin", key].sort()); assert.deepEqual(out?.removed, [removed]); assert.deepEqual(out?.held, []);
    assert.deepEqual(await readFile(path.join(f.folder, key)), binary); await assert.rejects(readFile(path.join(f.folder, removed)), { code: "ENOENT" });
    const changedType = refreshHost([{ key, bytes: binary, contentType: 'image/svg+xml; profile="same bytes"' }, { key: "new.bin", bytes: binary, contentType: "x/new" }]);
    const typeOut = await refreshBlobCheckout({ ...f, store: f.backend, scope, carrier: changedType.carrier, capabilities: readCaps });
    assert.deepEqual(typeOut?.metadataUpdated, [key]); assert.equal(changedType.counts().reads, 0);
    const map = decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope);
    assert.equal(map.entries.find(row => row.key === key)?.head?.contentType, 'image/svg+xml; profile="same bytes"'); assert.equal(map.entries.some(row => row.placement), false);
    assert.equal((await f.backend.listBlobIntents()).length, 0); assert.equal((await f.backend.listIntents()).length, 0);
  } finally { await f.close(); }
});
test("blob refresh defers absence until all pins succeed and preserves edits, recreations, UNKNOWN and occupied legacy bytes", async () => {
  for (const failure of ["listing", "pin", "edit", "revert", "other-map"] as const) {
    const f = await refreshFixture(["a.bin", "gone.bin"].map(key => seedBlobSyncEntry({ key, version: digest("old"), contentType: "x/old" }, digest("old"))));
    try {
      await writeFile(path.join(f.folder, "a.bin"), "old"); await writeFile(path.join(f.folder, "gone.bin"), "old");
      const host = refreshHost([{ key: "a.bin", bytes: Buffer.from("new"), contentType: "x/new" }], { listingFailure: failure === "listing", readFailure: failure === "pin", beforeRead: async () => {
        if (failure === "edit") await writeFile(path.join(f.folder, "a.bin"), "edited meanwhile");
        if (failure === "revert") { const p = prepareBlobIntent({ scope, intent: { operationId: "blobs.replace.v1", key: "a.bin", expectedVersion: digest("old"), expectedContentType: "x/old", version: digest("frozen"), contentType: "x/new" }, identity: { requestId: randomUUID(), binding: digest("checkout") }, createdAt: new Date().toISOString() }, Buffer.from("frozen")); await f.backend.admitPreparedBlob(p, { guard: (await f.backend.readBlobWithJournal("a.bin")).guard }); }
        if (failure === "other-map") { const map = decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope); await f.backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(changeBlobSyncEntry(map, { key: "other.bin", placedDigest: null }))); }
      } });
      const out = await refreshBlobCheckout({ ...f, store: f.backend, scope, carrier: host.carrier, capabilities: readCaps });
      assert.ok(out!.held.length > 0); assert.equal(await readFile(path.join(f.folder, "a.bin"), "utf8"), failure === "edit" ? "edited meanwhile" : "old");
      if (["listing", "pin", "other-map"].includes(failure)) assert.equal(await readFile(path.join(f.folder, "gone.bin"), "utf8"), "old");
    } finally { await f.close(); }
  }
  const f = await refreshFixture([{ key: "unknown.bin", placedDigest: null }, { key: "absent.bin", head: null, placedDigest: null }]);
  try {
    await writeFile(path.join(f.folder, "occupied.bin"), "remote"); await writeFile(path.join(f.folder, "absent.bin"), "recreated");
    const host = refreshHost(["unknown.bin", "occupied.bin", "absent.bin"].map(key => ({ key, bytes: Buffer.from("remote"), contentType: "x/new" })));
    assert.equal((await refreshBlobCheckout({ ...f, store: f.backend, scope, carrier: host.carrier, capabilities: readCaps }))?.held.length, 3);
    assert.equal(host.counts().reads, 0); assert.equal(await readFile(path.join(f.folder, "absent.bin"), "utf8"), "recreated");
    assert.equal(await refreshBlobCheckout({ ...f, store: f.backend, scope, carrier: host.carrier, capabilities: async () => ({ ...await readCaps(), blobReads: "refused" }) }), undefined);
    assert.equal(host.counts().lists, 1);
  } finally { await f.close(); }
});
test("blob catastrophic deletion uses exact scoped family refusal and fresh candidate pins, retaining refusal on failed listing", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => seedBlobSyncEntry({ key: `a${i}.bin`, version: digest("old"), contentType: "x/old" }, digest("old")));
  const f = await refreshFixture([...entries, { key: "unknown.bin", placedDigest: null }]);
  try {
    for (const entry of entries) await writeFile(path.join(f.folder, entry.key), "old");
    const host = refreshHost([]), options = { ...f, store: f.backend, scope, carrier: host.carrier, capabilities: readCaps };
    const first = (await refreshBlobCheckout(options))!;
    assert.equal(first.refused?.reason, "empty-listing"); assert.equal(first.refused?.deletions, 10); assert.equal(first.removed.length, 0);
    const token = blobHostDeletionsToken(first.refused!);
    const saved = await f.backend.readMeta(BLOB_SYNC_META_KEY);
    assert.equal((await refreshBlobCheckout({ ...options, carrier: refreshHost([], { listingFailure: true }).carrier }))?.refused?.digest, first.refused?.digest); assert.equal(await f.backend.readMeta(BLOB_SYNC_META_KEY), saved);
    assert.equal((await refreshBlobCheckout({ ...options, acceptToken: token.slice(6) }))?.removed.length, 0);
    assert.equal((await refreshBlobCheckout({ ...options, carrier: refreshHost([], { revision: 2 }).carrier, acceptToken: token }))?.removed.length, 0);
    const moved = decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope).refusal!;
    // A changed MIME/candidate set at the same count cannot reuse a prior confirmation.
    const changed = decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope); changed.entries[0] = { ...changed.entries[0]!, head: { ...changed.entries[0]!.head!, contentType: "x/changed" } };
    await f.backend.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap(changed));
    const changedOut = (await refreshBlobCheckout({ ...options, carrier: refreshHost([], { revision: 2 }).carrier, acceptToken: blobHostDeletionsToken(moved) }))!;
    assert.equal(changedOut.removed.length, 0); assert.notEqual(changedOut.refused?.digest, moved.digest);
    await writeFile(path.join(f.folder, "a0.bin"), "edited after refusal");
    const afterEdit = (await refreshBlobCheckout({ ...options, carrier: refreshHost([], { revision: 2 }).carrier, acceptToken: blobHostDeletionsToken(changedOut.refused!) }))!;
    assert.equal(afterEdit.removed.length, 0); assert.equal(afterEdit.refused?.deletions, 9);
    const accepted = (await refreshBlobCheckout({ ...options, carrier: refreshHost([], { revision: 2 }).carrier, acceptToken: blobHostDeletionsToken(afterEdit.refused!) }))!;
    assert.equal(accepted.removed.length, 9); assert.equal(await readFile(path.join(f.folder, "a0.bin"), "utf8"), "edited after refusal");
    assert.equal(decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope).refusal, undefined);
    assert.throws(() => decodeBlobSyncMap(saved, { ...scope, workspaceSlug: "elsewhere" }), /scope mismatch/);
  } finally { await f.close(); }
});
test("shared deletion policy preserves seven/eight/half boundaries and rejects invalid counts", () => {
  assert.equal(deletionBound(0, 10, 7, "listing"), undefined);
  assert.equal(deletionBound(1, 16, 8, "listing"), undefined);
  assert.deepEqual(deletionBound(1, 15, 8, "listing"), { deletions: 8, reason: "over-half", digest: "listing" });
  assert.deepEqual(deletionBound(0, 16, 8, "listing"), { deletions: 8, reason: "empty-listing", digest: "listing" });
  for (const counts of [[-1, 1, 1], [1, NaN, 1], [1, 1, 2], [1, Infinity, 1], [1, 2, .5]]) assert.throws(() => deletionBound(counts[0]!, counts[1]!, counts[2]!, "listing"));
  const refusal = deletionBound(0, 8, 8, "listing")!; assert.equal(acceptsRefusal(refusal, { ...refusal }), true); assert.equal(acceptsRefusal(refusal, { ...refusal, digest: "other" }), false);
});


test("explicit stale blob token holds all seven remaining candidates; no-token small-set policy still applies", async () => {
  const entries = Array.from({ length: 8 }, (_, i) => seedBlobSyncEntry({ key: `a${i}.bin`, version: digest("old"), contentType: "x/old" }, digest("old")));
  const f = await refreshFixture(entries);
  try {
    for (const entry of entries) await writeFile(path.join(f.folder, entry.key), "old");
    const options = { ...f, store: f.backend, scope, carrier: refreshHost([]).carrier, capabilities: readCaps };
    const first = (await refreshBlobCheckout(options))!, token = blobHostDeletionsToken(first.refused!);
    const saved = await f.backend.readMeta(BLOB_SYNC_META_KEY);
    await writeFile(path.join(f.folder, "a0.bin"), "local edit");
    const stale = (await refreshBlobCheckout({ ...options, acceptToken: token }))!;
    assert.equal(stale.taken, false); assert.deepEqual(stale.removed, []); assert.equal(stale.refused, undefined);
    assert.equal(stale.held.filter(row => /token no longer names/.test(row.message)).length, 7);
    assert.equal(await f.backend.readMeta(BLOB_SYNC_META_KEY), saved);
    for (const entry of entries.slice(1)) assert.equal(await readFile(path.join(f.folder, entry.key), "utf8"), "old");
    const ordinary = (await refreshBlobCheckout(options))!;
    assert.equal(ordinary.removed.length, 7); assert.equal(ordinary.refused, undefined);
    assert.equal(await readFile(path.join(f.folder, "a0.bin"), "utf8"), "local edit");
    assert.equal(decodeBlobSyncMap(await f.backend.readMeta(BLOB_SYNC_META_KEY), scope).refusal, undefined);
  } finally { await f.close(); }
});
