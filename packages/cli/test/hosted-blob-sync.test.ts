import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, symlink, writeFile, truncate, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { prepareBlobIntent, decodePreparedBlobIntent, blobReceipt, compareStorageKeys, type BlobTargetScope } from "@superbee/core/storage";
import { decodeHostedCapabilities, type HostedCarrier } from "@superbee/core/hosted-transport";
import { createHash, randomUUID } from "node:crypto";
import { BLOB_SYNC_META_KEY, captureBlobSyncMap, encodeBlobSyncMap, decodeBlobSyncMap, changeBlobSyncEntry, blobSyncDirty, seedBlobSyncEntry, readBlobSyncState, settleBlobSyncReceipt, seedInitialBlobBaselines, captureTrackedBlobChanges, type BlobSyncMap } from "../src/hosted/blob-sync.js";
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
