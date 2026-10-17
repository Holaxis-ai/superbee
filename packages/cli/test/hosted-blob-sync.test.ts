import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { prepareBlobIntent, blobReceipt, type BlobTargetScope } from "@superbee/core/storage";
import { createHash, randomUUID } from "node:crypto";
import { BLOB_SYNC_META_KEY, captureBlobSyncMap, encodeBlobSyncMap, decodeBlobSyncMap, changeBlobSyncEntry, blobSyncDirty, seedBlobSyncEntry, readBlobSyncState, settleBlobSyncReceipt } from "../src/hosted/blob-sync.js";
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const scope: BlobTargetScope = { origin: "https://example.test", prefix: "/sync/v1", bundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceSlug: "team" };
const empty = () => ({ schemaVersion: 1 as const, scope, entries: [] });
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
