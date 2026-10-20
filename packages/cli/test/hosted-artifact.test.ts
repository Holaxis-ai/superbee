import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink, symlink } from "node:fs/promises";
import { STORE_BYTE_LIMIT } from "../../core/dist/file-journaled-backend-internal.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseKey, commitLocal } from "@superbee/browser-local";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { prepareBlobIntent, blobReceipt } from "@superbee/core/storage";
import { ARTIFACT_ROWS, decodePublication, publicationKey, publications, admitArtifactRecord, initialArtifactOwner, recoverArtifactRecord, type Publication } from "../src/hosted/artifact.js";
import { BLOB_SYNC_META_KEY, encodeBlobSyncMap, readBlobSyncState, settleBlobSyncReceipt } from "../src/hosted/blob-sync.js";
import { digestOf } from "../src/hosted/projection.js";
import { exportCheckout, placeQueuedLocalCreate, type ProjectionRecord } from "../src/hosted/sync-scan.js";

async function fixture(maximumBytes?: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-native-")), folder = path.join(dir, "folder"); await mkdir(folder);
  const store = await FileJournaledBackend.open({ directory: path.join(dir, "journal"), ...(maximumBytes === undefined ? {} : { [STORE_BYTE_LIMIT]: maximumBytes }) });
  await store.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Test\n");
  const bytes = Buffer.from("<p>immutable</p>"), digest = digestOf(bytes);
  const scope = { origin: "https://example.test", prefix: "/sync/v1", bundleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceSlug: "team" };
  const p = decodePublication({ schema: 1, id: "artifacts/result", entry: "artifacts/result.html", scope, binding: digestOf(Buffer.from("binding")), principal: "person:test", title: "Result", actor: "process:test", digest, contentType: "text/html", blobRequestId: randomUUID(), state: "blob_admitted" });
  const prepared = prepareBlobIntent({ scope, intent: { operationId: "blobs.create.v1", key: p.entry, expectedVersion: null, expectedContentType: null, version: digest, contentType: "text/html" }, identity: { requestId: p.blobRequestId, binding: p.binding }, createdAt: new Date().toISOString() }, bytes);
  const empty = await store.readBlobWithJournal(p.entry, { meta: [publicationKey(p.id), BLOB_SYNC_META_KEY] });
  const row = await store.admitPreparedBlob(prepared, { guard: empty.guard, meta: [{ key: publicationKey(p.id), value: p }, { key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap({ schemaVersion: 1, scope, entries: [{ key: p.entry, placedDigest: digest, desiredContentType: "text/html" }] }) }] });
  const snapshot = await readBlobSyncState(store, p.entry, scope);
  await settleBlobSyncReceipt(store, snapshot, row, { state: "acknowledged", receipt: blobReceipt(prepared, { ok: true, operationId: "blobs.create.v1", data: { key: p.entry, version: digest, contentType: "text/html", changed: true } }) });
  return { dir, folder, store, p, cleanup: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("Artifact exact admission and pending placement recover each local crash boundary without another intent", async () => {
  const f = await fixture();
  try {
    const p = await admitArtifactRecord(f.store, f.p, f.p.digest, 983040), projection: ProjectionRecord = { root: null, files: {} };
    await f.store.close();
    f.store = await FileJournaledBackend.open({ directory: path.join(f.dir, "journal") });
    assert.equal((await f.store.readWithJournal(p.id)).intents.length, 1);
    const baseline = await exportCheckout(f.folder, f.store, projection, { only: new Set([p.id]), placeMissing: true });
    assert.deepEqual(baseline.placed, [], "ordinary export refuses unsettled documents");
    assert.ok(await initialArtifactOwner(f.store, projection, p));
    assert.equal(await recoverArtifactRecord(f.store, f.folder, projection, p), null);
    const file = path.join(f.folder, `${p.id}.md`), raw = await readFile(file, "utf8");
    assert.ok(projection.files[p.id]);
    // Lost projection after file placement is adopted from exact bytes.
    projection.files = {}; assert.equal(await recoverArtifactRecord(f.store, f.folder, projection, p), null);
    assert.equal(await readFile(file, "utf8"), raw);
    // A durable projection ends initial recovery, including after a user's deletion.
    await unlink(file); assert.equal(await recoverArtifactRecord(f.store, f.folder, projection, p), null);
    await assert.rejects(readFile(file));
    assert.equal((await f.store.readWithJournal(p.id)).intents.length, 1);
  } finally { await f.store.close(); await f.cleanup(); }
});

test("Artifact unprojected physical edits and symlinks are preserved; legitimate successor ends initial ownership", async () => {
  const f = await fixture();
  try {
    const p = await admitArtifactRecord(f.store, f.p, f.p.digest, 983040), projection: ProjectionRecord = { root: null, files: {} };
    const file = path.join(f.folder, `${p.id}.md`); await mkdir(path.dirname(file)); await writeFile(file, "user edit");
    assert.ok(await recoverArtifactRecord(f.store, f.folder, projection, p)); assert.equal(await readFile(file, "utf8"), "user edit"); assert.equal(Object.keys(projection.files).length, 0);
    await unlink(file); const outside = path.join(f.dir, "outside"); await writeFile(outside, "outside"); await symlink(outside, file);
    assert.ok(await recoverArtifactRecord(f.store, f.folder, projection, p)); assert.equal(await readFile(outside, "utf8"), "outside"); await unlink(file);
    await commitLocal(f.store, p.id, { mode: "patch", buildCandidate: doc => ({ frontmatter: { ...doc!.frontmatter, title: "Next" }, body: doc!.body }) });
    assert.equal(await initialArtifactOwner(f.store, projection, p), null);
  } finally { await f.cleanup(); }
});

for (const premise of ["base", "tombstone", "publication", "capacity"] as const) test(`Artifact admission rejects ${premise} without partial document or linkage`, async () => {
  const f = await fixture();
  try {
    if (premise === "base") await f.store.writeMeta(baseKey(f.p.id), { version: f.p.digest, content: "old" });
    if (premise === "tombstone") await f.store.writeMeta(baseKey(f.p.id), { version: null, content: null, tombstone: f.p.digest });
    if (premise === "publication") await f.store.writeMeta(publicationKey(f.p.id), { ...f.p, title: "changed" });
    const before = await f.store.readMeta(publicationKey(f.p.id));
    await assert.rejects(admitArtifactRecord(f.store, f.p, f.p.digest, premise === "capacity" ? 1 : 983040));
    assert.equal((await f.store.readWithJournal(f.p.id)).document, null); assert.deepEqual(await f.store.listIntents(), []); assert.deepEqual(await f.store.readMeta(publicationKey(f.p.id)), before);
  } finally { await f.cleanup(); }
});

test("Artifact independent retained-row bound survives unrelated blob map replacement", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n < ARTIFACT_ROWS; n++) { const id = `artifacts/result-${n}`; await f.store.writeMeta(publicationKey(id), decodePublication({ ...f.p, id, entry: `${id}.html`, blobRequestId: randomUUID() })); }
    await f.store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap({ schemaVersion: 1, scope: f.p.scope, entries: [] }));
    assert.equal((await publications(f.store)).length, ARTIFACT_ROWS);
    const id = "artifacts/overflow";
    await assert.rejects(publications(f.store, decodePublication({ ...f.p, id, entry: `${id}.html`, blobRequestId: randomUUID() })), /capacity/);
    assert.throws(() => decodePublication({ ...f.p, description: "x".repeat(16384) }), /16 KiB/);
  } finally { await f.cleanup(); }
});


test("Artifact near FileJournal capacity preserves ACK and atomically refuses record growth", async () => {
  const f = await fixture(220000);
  try {
    let lo = 0, hi = 220000;
    while (lo + 1 < hi) { const size = Math.floor((lo + hi) / 2); try { await f.store.writeMeta("capacity-probe", "x".repeat(size)); lo = size; } catch (error) { if (!(error instanceof RangeError)) throw error; hi = size; } }
    const before = await f.store.readMeta(publicationKey(f.p.id));
    await assert.rejects(admitArtifactRecord(f.store, f.p, f.p.digest, 983040));
    assert.equal((await f.store.readBlobIntent(f.p.blobRequestId))!.state, "acknowledged");
    assert.equal((await f.store.readWithJournal(f.p.id)).document, null);
    assert.deepEqual(await f.store.listIntents(), []);
    assert.deepEqual(await f.store.readMeta(publicationKey(f.p.id)), before);
  } finally { await f.cleanup(); }
});

test("Artifact full metadata guard rejects a premise changed immediately before the atomic write", async () => {
  const f = await fixture();
  const original = f.store.writeJournaled.bind(f.store);
  try {
    f.store.writeJournaled = async (id, doc, options) => {
      await f.store.writeMeta(baseKey(id), { version: null, content: null, tombstone: f.p.digest });
      return original(id, doc, options);
    };
    await assert.rejects(admitArtifactRecord(f.store, f.p, f.p.digest, 983040));
    assert.equal((await f.store.readWithJournal(f.p.id)).document, null); assert.deepEqual(await f.store.listIntents(), []);
    assert.equal((await f.store.readMeta<Publication>(publicationKey(f.p.id)))!.state, "blob_admitted");
  } finally { await f.cleanup(); }
});
