/** Frozen ordinary-file payloads and the optional file-only journal family. No dispatch/retry. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { prepareBlobIntent, decodePreparedBlobIntent, blobReceipt, BLOB_JOURNAL_BOUNDS, type BlobPreparedInput } from "../src/blob-journal.js";
import { FileJournaledBackend, FileJournalCorruptError, FILE_JOURNAL_LOG, FILE_JOURNAL_SNAPSHOT } from "../src/file-journaled-backend.js";
import { OPEN_LOG, STORE_BYTE_LIMIT } from "../src/file-journaled-backend-internal.js";
import { JournalGuardConflict, type NewIntentRecord } from "../src/journaled-backend.js";
const now = "2026-10-17T06:00:00.000Z";
const bytes = new Uint8Array([0, 255, 3, 128]);
const digest = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const old = digest(new Uint8Array([4]));
const binding = digest(new Uint8Array([5]));
function input(operation: "create" | "replace" | "delete" = "create", key = "media/💾.bin"): BlobPreparedInput {
  const common = { key, expectedVersion: operation === "create" ? null : old, expectedContentType: operation === "create" ? null : "application/old" };
  const intent = operation === "delete" ? { ...common, operationId: "blobs.delete.v1" as const } : { ...common, operationId: operation === "create" ? "blobs.create.v1" as const : "blobs.replace.v1" as const, version: digest(bytes), contentType: "application/octet-stream; x=Exact" };
  return { scope: { origin: "https://example.test", prefix: "/sync/v1", bundleId: "notes.a", workspaceSlug: "1-team" }, intent: intent as BlobPreparedInput["intent"], identity: { requestId: randomUUID(), binding, via: "test-agent" }, createdAt: now };
}
const prepared = (value = input()) => prepareBlobIntent(value, value.intent.operationId === "blobs.delete.v1" ? undefined : bytes);
const success = (value: BlobPreparedInput) => ({ ok: true, operationId: value.intent.operationId, data: value.intent.operationId === "blobs.delete.v1" ? { key: value.intent.key, version: old, contentType: "application/old", deleted: true } : { key: value.intent.key, version: value.intent.version, contentType: value.intent.contentType, changed: true } });
async function fixture(limit?: number) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-journal-"));
  const options = { directory, lock: { lockRoot: path.join(directory, "locks"), waitMs: 0 }, ...(limit === undefined ? {} : { [STORE_BYTE_LIMIT]: limit }), compactAfterBytes: Infinity };
  const backend = await FileJournaledBackend.open(options);
  return { directory, options, backend, async cleanup() { await backend.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
const docIntent = (requestId: string, target = "same"): NewIntentRecord => ({ requestId, target, kind: "document.write", base: null, baseContent: null, createdAt: now });

test("prepared blob codec freezes binary bytes, MIME, scope and identity for all three operations", () => {
  for (const op of ["create", "replace", "delete"] as const) {
    const value = input(op), frozen = prepared(value), copy = structuredClone(value);
    value.scope.bundleId = "different"; value.identity.via = "changed"; value.intent.key = "different";
    const decoded = decodePreparedBlobIntent(frozen);
    assert.deepEqual(decoded, { schemaVersion: 1, ...copy, ...(op === "delete" ? {} : { bytesBase64: Buffer.from(bytes).toString("base64") }) });
    const receipt = blobReceipt(frozen, success(copy));
    assert.deepEqual(receipt.scope, copy.scope);
    assert.equal("head" in receipt && receipt.head === null, op === "delete");
    if (op === "delete") assert.deepEqual("removed" in receipt && receipt.removed, { key: copy.intent.key, version: old, contentType: "application/old" });
  }
});

test("prepared codec refuses noncanonical, wrong-digest, authority-shaped and oversized payloads", () => {
  const value = input(), encoded = prepared(value), parsed = JSON.parse(encoded);
  for (const bad of [encoded + " ", JSON.stringify({ ...parsed, acceptDeletes: 4 }), JSON.stringify({ ...parsed, bytesBase64: "AP8DgB==" }), JSON.stringify({ ...parsed, identity: { ...parsed.identity, acceptDeletes: 2 } }), JSON.stringify({ ...parsed, intent: { ...parsed.intent, expectedContentType: "missing-null" } })]) assert.throws(() => decodePreparedBlobIntent(bad));
  const reordered = JSON.stringify({ ...parsed, intent: Object.fromEntries(Object.entries(parsed.intent).reverse()) });
  assert.throws(() => decodePreparedBlobIntent(reordered), /noncanonical/);
  assert.throws(() => prepareBlobIntent(value, new Uint8Array([9])), /digest/);
  assert.throws(() => prepareBlobIntent(input("delete"), bytes), /bytes/);
  assert.throws(() => prepareBlobIntent(value, new Uint8Array(BLOB_JOURNAL_BOUNDS.rawBytes + 1)), /bytes/);
  assert.throws(() => decodePreparedBlobIntent("x".repeat(BLOB_JOURNAL_BOUNDS.preparedBytes + 1)), /payload/);
  for (const scope of [{ ...value.scope, origin: "https://user:pass@example.test" }, { ...value.scope, prefix: "/sync/../v1" }]) assert.throws(() => prepareBlobIntent({ ...value, scope }, bytes));
});

test("document selectors and mutations isolate blob family while identity, sequence and empty barriers are global", async () => {
  const f = await fixture();
  try {
    const value = input("create", "same"), frozen = prepared(value), guard = (await f.backend.readBlobWithJournal("same")).guard;
    const blob = await f.backend.admitPreparedBlob(frozen, { guard });
    assert.equal(blob.sequence, 1);
    assert.equal(await f.backend.readIntent(blob.requestId), undefined);
    assert.deepEqual(await f.backend.listIntents(), []);
    assert.equal((await f.backend.readWithJournal("same")).intents.length, 0);
    await assert.rejects(f.backend.writeMeta("bootstrap", true, { requireEmptyJournal: true }), JournalGuardConflict);
    await assert.rejects(f.backend.writeJournaled("same", { id: "same", frontmatter: { type: "Note" }, body: "no" }, { intent: docIntent(blob.requestId) }));
    assert.equal(f.backend.transaction, 1);
    const doc = await f.backend.writeJournaled("same", { id: "same", frontmatter: { type: "Note" }, body: "yes" }, { requireSettled: true, intent: docIntent(randomUUID()) });
    assert.equal(doc.intent?.sequence, 2);
    assert.equal((await f.backend.readHeads())[0]?.intents.length, 1);
    const documentGuard = { target: "same", document: { version: doc.version, raw: doc.raw }, intents: [doc.intent!], meta: [] };
    await f.backend.updateBlobIntent(blob.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await f.backend.readBlobWithJournal("same")).guard });
    await f.backend.updateIntent(doc.intent!.requestId, "pending", { state: "acknowledged" }, { guard: documentGuard });
    await assert.rejects(f.backend.updateIntent(blob.requestId, "in_flight", { state: "acknowledged" }));
    await assert.rejects(f.backend.deleteJournaled("same", { intent: docIntent(blob.requestId) }));
    const reused = input("create", "other"); reused.identity.requestId = doc.intent!.requestId;
    await assert.rejects(f.backend.admitPreparedBlob(prepared(reused), { guard: (await f.backend.readBlobWithJournal("other")).guard }));
    assert.equal((await f.backend.listBlobIntents())[0]?.state, "in_flight");
  } finally { await f.cleanup(); }
});

test("complete blob guards prevent races and receipt/state/baseline updates commit atomically", async () => {
  const f = await fixture();
  try {
    const value = input(), frozen = prepared(value), key = value.intent.key;
    const first = await f.backend.readBlobWithJournal(key, { meta: ["base", "absent"] });
    const record = await f.backend.admitPreparedBlob(frozen, { guard: first.guard, meta: [{ key: "base", value: { version: old, contentType: "application/old" } }] });
    await assert.rejects(f.backend.admitPreparedBlob(prepared(input("replace", key)), { guard: first.guard }), JournalGuardConflict);
    await assert.rejects(f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged" }, { guard: (await f.backend.readBlobWithJournal(key)).guard }));
    await assert.rejects(f.backend.retireBlobIntents(key, [record.requestId], { guard: (await f.backend.readBlobWithJournal(key)).guard }));
    const seen = await f.backend.readBlobWithJournal(key, { meta: ["base"] });
    await f.backend.writeMeta("base", { version: "moved" });
    const receipt = blobReceipt(frozen, success(value));
    const before = f.backend.transaction;
    await assert.rejects(f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt }, { guard: seen.guard, meta: [{ key: "base", value: receipt }] }), JournalGuardConflict);
    assert.equal(f.backend.transaction, before);
    assert.equal((await f.backend.readBlobIntent(record.requestId))?.state, "pending");
    const guard = (await f.backend.readBlobWithJournal(key, { meta: ["base", "absent"] })).guard;
    await f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt }, { guard, meta: [{ key: "base", value: receipt }, { key: "absent", value: undefined }] });
    assert.deepEqual((await f.backend.readBlobIntent(record.requestId))?.receipt, receipt);
    assert.deepEqual(await f.backend.readMeta("base"), receipt);
    assert.equal((await f.backend.readBlobWithJournal(key, { meta: ["absent"] })).meta.has("absent"), true);
    await assert.rejects(f.backend.retireBlobIntents(key, [record.requestId], { guard }));
    await f.backend.retireBlobIntents(key, [record.requestId], { guard: (await f.backend.readBlobWithJournal(key, { meta: ["base"] })).guard, removeMeta: ["base"] });
    assert.equal(await f.backend.readBlobIntent(record.requestId), undefined);
    assert.equal(await f.backend.readMeta("base"), undefined);
  } finally { await f.cleanup(); }
});

test("only original typed terminal results become receipts; uncertainty and scope/head forgery never settle", async () => {
  const f = await fixture();
  try {
    for (const operation of ["create", "delete"] as const) {
      const value = input(operation), frozen = prepared(value), record = await f.backend.admitPreparedBlob(frozen, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
      assert.throws(() => blobReceipt(frozen, { ok: false, operationId: value.intent.operationId, error: { code: "write_outcome_unknown", message: "lost", retryable: false, writeState: "unknown" } }), /uncertain/);
      const receipt = blobReceipt(frozen, success(value));
      const guard = (await f.backend.readBlobWithJournal(value.intent.key)).guard;
      await assert.rejects(f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt: { ...receipt, scope: { ...receipt.scope, bundleId: "other" } } }, { guard }));
      await f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt }, { guard });
      await assert.rejects(f.backend.updateBlobIntent(record.requestId, "acknowledged", { attempts: 1 }, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard }));
    }
    const value = input("replace"), frozen = prepared(value), record = await f.backend.admitPreparedBlob(frozen, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    const refusal = blobReceipt(frozen, { ok: false, operationId: value.intent.operationId, error: { code: "version_conflict", message: "changed", retryable: false, writeState: "not_applied", expected: old, actual: null, expectedContentType: "application/old", actualContentType: null } });
    assert.equal("head" in refusal, false);
    await assert.rejects(f.backend.updateBlobIntent(record.requestId, "pending", { state: "refused", receipt: refusal }, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard }));
    await f.backend.updateBlobIntent(record.requestId, "pending", { state: "conflict", receipt: refusal }, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
  } finally { await f.cleanup(); }
});

function frames(log: Buffer): { at: number; end: number; format: number }[] {
  const out = [];
  for (let at = 0; at < log.length;) { const end = at + 44 + log.readUInt32BE(at + 8); out.push({ at, end, format: log.readUInt32BE(at + 4) }); at = end; }
  return out;
}
function rewritePayload(log: Buffer, frame: { at: number; end: number }, mutate: (raw: any) => any, format: number): Buffer {
  const payload = Buffer.from(JSON.stringify(mutate(JSON.parse(log.subarray(frame.at + 44, frame.end).toString("utf8")))));
  const header = Buffer.alloc(44); header.writeUInt32BE(0x53424a52, 0); header.writeUInt32BE(format, 4); header.writeUInt32BE(payload.length, 8); createHash("sha256").update(payload).digest().copy(header, 12);
  return Buffer.concat([log.subarray(0, frame.at), header, payload, log.subarray(frame.end)]);
}

test("format promotion is lazy, frame/payload-coherent and sticky across retirement, compaction and reopen", async () => {
  const f = await fixture();
  let b = f.backend;
  try {
    await b.writeMeta("doc-only", true);
    await b.compact();
    assert.equal((await fs.readFile(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).readUInt32BE(4), 1);
    const value = input(), frozen = prepared(value);
    const record = await b.admitPreparedBlob(frozen, { guard: (await b.readBlobWithJournal(value.intent.key)).guard });
    const log = await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG));
    assert.deepEqual(frames(log).map(r => r.format), [2]);
    const json = JSON.parse(log.subarray(44).toString("utf8"));
    assert.equal(json[json.indexOf("format") + 1], 2);
    await b.close(); b = await FileJournaledBackend.open(f.options);
    const receipt = blobReceipt(frozen, success(value));
    await b.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt }, { guard: (await b.readBlobWithJournal(value.intent.key)).guard });
    await b.retireBlobIntents(value.intent.key, [record.requestId], { guard: (await b.readBlobWithJournal(value.intent.key)).guard });
    await b.compact();
    assert.equal((await fs.readFile(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).readUInt32BE(4), 2);
    await b.close(); b = await FileJournaledBackend.open(f.options);
    await b.writeMeta("after-retirement", true);
    assert.deepEqual(frames(await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG))).map(r => r.format), [2]);
  } finally { await b.close(); await f.cleanup(); }
});

test("legacy blob rows and mismatched payload/frame formats refuse reopen without changing evidence", async () => {
  const f = await fixture();
  try {
    const value = input();
    await f.backend.admitPreparedBlob(prepared(value), { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    await f.backend.close();
    const file = path.join(f.directory, FILE_JOURNAL_LOG), original = await fs.readFile(file), part = frames(original)[0]!;
    for (const bad of [rewritePayload(original, part, raw => { raw[raw.indexOf("format") + 1] = 1; return raw; }, 2), rewritePayload(original, part, raw => { const at = raw.indexOf("format"); raw.splice(at, 2); return raw; }, 1)]) {
      await fs.writeFile(file, bad);
      await assert.rejects(FileJournaledBackend.open(f.options), FileJournalCorruptError);
      assert.deepEqual(await fs.readFile(file), bad);
    }
  } finally { await f.cleanup(); }
});

test("exact transaction and whole-snapshot budgets reject atomically, including promoted growth; retirement frees space", async () => {
  const reserve = BLOB_JOURNAL_BOUNDS.terminalReceiptBytes + BLOB_JOURNAL_BOUNDS.settlementStructureBytes + BLOB_JOURNAL_BOUNDS.baselineBytes;
  const limit = reserve + 5000;
  const f = await fixture(limit);
  try {
    await f.backend.writeMeta("retained", "x".repeat(2500));
    const value = input(), frozen = prepared(value), guard = (await f.backend.readBlobWithJournal(value.intent.key, { meta: ["new"] })).guard;
    const record = await f.backend.admitPreparedBlob(frozen, { guard, meta: [{ key: "new", value: "ok" }] });
    const before = f.backend.transaction, log = await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG));
    await assert.rejects(f.backend.writeMeta("growth", "x".repeat(2000)), /projected snapshot/);
    await assert.rejects(f.backend.writeMeta("huge-transaction", "x".repeat(limit + 1000)), /transaction/);
    const other = input("create", "other");
    await assert.rejects(f.backend.admitPreparedBlob(prepared(other), { guard: (await f.backend.readBlobWithJournal("other", { meta: ["new"] })).guard, meta: [{ key: "new", value: "not committed".repeat(100) }] }), /snapshot/);
    assert.equal(f.backend.transaction, before);
    assert.deepEqual(await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG)), log);
    assert.equal(await f.backend.readMeta("growth"), undefined);
    assert.equal(await f.backend.readMeta("new"), "ok");
    await f.backend.updateBlobIntent(record.requestId, "pending", { state: "acknowledged", receipt: blobReceipt(frozen, success(value)) }, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    await f.backend.retireBlobIntents(value.intent.key, [record.requestId], { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    const next = await f.backend.admitPreparedBlob(prepared(other), { guard: (await f.backend.readBlobWithJournal("other")).guard });
    assert.equal(next.sequence, 2);
    await f.backend.compact();
    assert.ok((await fs.stat(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).size <= limit + 44);
  } finally { await f.cleanup(); }
});

test("failed first durable blob append leaves format, sequence, metadata and admission unchanged", async () => {
  const f = await fixture();
  await f.backend.close();
  let fail = true;
  const b = await FileJournaledBackend[OPEN_LOG](f.options, async file => {
    const handle = await fs.open(file, "r+");
    return { write: (...args) => handle.write(...args), async sync() { if (fail) { fail = false; throw new Error("injected fsync"); } await handle.sync(); }, truncate: n => handle.truncate(n), close: () => handle.close() };
  });
  try {
    const value = input(), frozen = prepared(value), guard = (await b.readBlobWithJournal(value.intent.key, { meta: ["base"] })).guard;
    await assert.rejects(b.admitPreparedBlob(frozen, { guard, meta: [{ key: "base", value: true }] }), /injected/);
    assert.equal(b.transaction, 0);
    assert.deepEqual(await b.listBlobIntents(), []);
    assert.equal(await b.readMeta("base"), undefined);
    assert.equal((await fs.stat(path.join(f.directory, FILE_JOURNAL_LOG))).size, 0);
    await b.writeMeta("legacy", true);
    assert.equal(frames(await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG)))[0]?.format, 1);
    assert.equal((await b.admitPreparedBlob(frozen, { guard })).sequence, 1);
  } finally { await b.close(); await f.cleanup(); }
});


test("queued admissions capture guards and named metadata before the caller can mutate them", async () => {
  const f = await fixture();
  try {
    const value = input(), frozen = prepared(value);
    const options = { guard: (await f.backend.readBlobWithJournal(value.intent.key, { meta: ["captured"] })).guard, meta: [{ key: "captured", value: { original: true } }] };
    const write = f.backend.admitPreparedBlob(frozen, options);
    options.meta[0]!.value.original = false;
    options.guard.key = "changed";
    const row = await write;
    assert.deepEqual(await f.backend.readMeta("captured"), { original: true });
    const snapshot = await f.backend.readBlobWithJournal(value.intent.key);
    const patch = { state: "in_flight" as const, attempts: 1 };
    const update = f.backend.updateBlobIntent(row.requestId, "pending", patch, { guard: snapshot.guard });
    patch.attempts = 99; snapshot.guard.intents.length = 0;
    assert.equal((await update).attempts, 1);
    const shared = (await f.backend.readBlobWithJournal(value.intent.key)).guard;
    // The claimed row is unsettled on the same bundle and key, so both admissions name it as their premise.
    const unsettled = shared.intents;
    const answers = await Promise.allSettled([f.backend.admitPreparedBlob(prepared(input("replace", value.intent.key)), { guard: shared, unsettled }), f.backend.admitPreparedBlob(prepared(input("replace", value.intent.key)), { guard: shared, unsettled })]);
    assert.equal(answers.filter(answer => answer.status === "fulfilled").length, 1);
    assert.equal((await f.backend.listBlobIntents()).length, 2);
  } finally { await f.cleanup(); }
});

test("snapshot writer checks the exact encoded bound before opening its temporary file", async () => {
  const f = await fixture();
  let b = f.backend;
  try {
    await b.writeMeta("base", "bounded");
    await b.compact(); await b.close();
    const file = path.join(f.directory, FILE_JOURNAL_SNAPSHOT), exact = await fs.readFile(file), payloadBytes = exact.length - 44;
    const exactOptions = { ...f.options, [STORE_BYTE_LIMIT]: payloadBytes };
    b = await FileJournaledBackend.open(exactOptions);
    await b.writeMeta("base", "bounded");
    await assert.rejects(b.writeMeta("base", "bounded+"), /projected snapshot/);
    await b.compact(); await b.close();
    const before = await fs.readFile(file);
    const smallerOptions = { ...f.options, [STORE_BYTE_LIMIT]: payloadBytes - 1 };
    b = await FileJournaledBackend.open(smallerOptions);
    await assert.rejects(b.compact(), /snapshot/);
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(fs.stat(path.join(f.directory, "store.snapshot.tmp")), { code: "ENOENT" });
  } finally { await b.close(); await f.cleanup(); }
});


test("crowded admission protects terminal progress from later growth and rejects oversized receipts atomically", async () => {
  const reserve = BLOB_JOURNAL_BOUNDS.terminalReceiptBytes + BLOB_JOURNAL_BOUNDS.settlementStructureBytes + BLOB_JOURNAL_BOUNDS.baselineBytes;
  const limit = reserve + 5000;
  const f = await fixture(limit);
  let b = f.backend;
  try {
    await b.writeMeta("retained", "x".repeat(3800));
    const value = input(), frozen = prepared(value), key = value.intent.key;
    const record = await b.admitPreparedBlob(frozen, { guard: (await b.readBlobWithJournal(key)).guard });
    await b.compact(); await b.close();
    b = await FileJournaledBackend.open(f.options);
    const before = b.transaction;
    await assert.rejects(b.writeMeta("padding", "x".repeat(2000)), /settlement reserve/);
    await assert.rejects(b.write("padding", { id: "padding", frontmatter: { type: "Note" }, body: "x".repeat(2000) }), /settlement reserve/);
    assert.equal(b.transaction, before);
    assert.equal(await b.readMeta("padding"), undefined);
    assert.equal(await b.exists("padding"), false);
    // A durable claim at a crowded boundary must not consume the same record's reserve.
    await b.updateBlobIntent(record.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await b.readBlobWithJournal(key)).guard });
    const refusal = (message: string) => blobReceipt(frozen, { ok: false, operationId: value.intent.operationId, error: { code: "backend_unavailable", message, retryable: false, writeState: "not_applied" } });
    const guard = (await b.readBlobWithJournal(key, { meta: ["baseline"] })).guard;
    const log = await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG)), txn = b.transaction;
    await assert.rejects(b.updateBlobIntent(record.requestId, "in_flight", { state: "refused", receipt: refusal("x".repeat(BLOB_JOURNAL_BOUNDS.terminalReceiptBytes)) }, { guard, meta: [{ key: "baseline", value: "not committed" }] }), /blob terminal receipt/);
    assert.equal(b.transaction, txn);
    assert.deepEqual(await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG)), log);
    assert.equal((await b.readBlobIntent(record.requestId))?.state, "in_flight");
    assert.equal(await b.readMeta("baseline"), undefined);
    // A near-ceiling valid witness plus the documented ordinary metadata allowance fits.
    const receipt = refusal("x".repeat(BLOB_JOURNAL_BOUNDS.terminalReceiptBytes - 1024));
    await b.updateBlobIntent(record.requestId, "in_flight", { state: "refused", receipt }, { guard, meta: [{ key: "baseline", value: "x".repeat(BLOB_JOURNAL_BOUNDS.baselineBytes - 256) }] });
    assert.deepEqual((await b.readBlobIntent(record.requestId))?.receipt, receipt);
    await b.retireBlobIntents(key, [record.requestId], { guard: (await b.readBlobWithJournal(key)).guard });
    await b.writeMeta("padding", "capacity released");
    await b.compact();
    assert.ok((await fs.stat(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).size <= limit + 44);
  } finally { await b.close(); await f.cleanup(); }
});

test("a store without settlement headroom refuses the review's crowded pending admission", async () => {
  const f = await fixture(5000);
  try {
    await f.backend.writeMeta("retained", "x".repeat(3800));
    const value = input(), before = f.backend.transaction;
    await assert.rejects(f.backend.admitPreparedBlob(prepared(value), { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard }), /settlement reserve/);
    assert.equal(f.backend.transaction, before);
    assert.deepEqual(await f.backend.listBlobIntents(), []);
    await f.backend.compact();
    assert.equal((await fs.readFile(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).readUInt32BE(4), 1);
  } finally { await f.cleanup(); }
});


test("an exact-capacity store can claim attempts across a transaction digit boundary and then settle", async () => {
  const f = await fixture();
  let b = f.backend;
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  let exact: FileJournaledBackend | undefined;
  try {
    const value = input(), frozen = prepared(value), key = value.intent.key;
    const row = await b.admitPreparedBlob(frozen, { guard: (await b.readBlobWithJournal(key)).guard });
    // Nine real commits make the first claim grow the transaction counter from9 to10.
    for (let i = 0; i < 8; i++) await b.writeMeta("counter", i);
    await b.compact(); await b.close();
    const snapshotBytes = (await fs.stat(path.join(f.directory, FILE_JOURNAL_SNAPSHOT))).size - 44;
    // Ask a fresh admission for its actual pending capacity, without reimplementing the codec
    // or reserve formula. Its snapshot has the same rows and single-digit txn as the9-commit one.
    second = await fixture(4096);
    await second.backend.writeMeta("counter", 7);
    let exactLimit = 0;
    try { await second.backend.admitPreparedBlob(frozen, { guard: (await second.backend.readBlobWithJournal(key)).guard }); }
    catch (error) {
      const match = /snapshot of (\d+) bytes plus (\d+) bytes of blob settlement reserve/.exec(String(error));
      assert.ok(match);
      exactLimit = Number(match[1]) + Number(match[2]);
    }
    assert.ok(exactLimit > snapshotBytes);
    await b.close();
    const exactOptions = { ...f.options, [STORE_BYTE_LIMIT]: exactLimit };
    b = await FileJournaledBackend.open(exactOptions);
    await b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await b.readBlobWithJournal(key)).guard });
    assert.equal(b.transaction, 10);
    const receipt = blobReceipt(frozen, success(value));
    await b.updateBlobIntent(row.requestId, "in_flight", { state: "acknowledged", receipt }, { guard: (await b.readBlobWithJournal(key)).guard });
    // Prove the same bound admits from empty, not only after lowering a preexisting store.
    await second.backend.close();
    const freshOptions = { ...second.options, [STORE_BYTE_LIMIT]: exactLimit };
    exact = await FileJournaledBackend.open(freshOptions);
    await exact.admitPreparedBlob(frozen, { guard: (await exact.readBlobWithJournal(key)).guard });
    await exact.updateBlobIntent(value.identity.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await exact.readBlobWithJournal(key)).guard });
    await exact.updateBlobIntent(value.identity.requestId, "in_flight", { state: "acknowledged", receipt }, { guard: (await exact.readBlobWithJournal(key)).guard });
  } finally { await exact?.close(); await second?.cleanup(); await b.close(); await f.cleanup(); }
});

test("guarded blob metadata is same-key atomic, named, bounded, and independent of unrelated retained rows", async () => {
  const f = await fixture();
  try {
    const value = input(), frozen = prepared(value);
    const other = await f.backend.admitPreparedBlob(frozen, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    await f.backend.updateBlobIntent(other.requestId, "pending", { state: "acknowledged", receipt: blobReceipt(frozen, success(value)) }, { guard: (await f.backend.readBlobWithJournal(value.intent.key)).guard });
    const key = "placement.bin", snapshot = await f.backend.readBlobWithJournal(key, { meta: ["map"] });
    const changes = { meta: [{ key: "map", value: { phase: "pending" } }] };
    const write = f.backend.writeBlobMeta(key, changes, { guard: snapshot.guard });
    changes.meta[0]!.value.phase = "caller-mutated";
    await write;
    assert.deepEqual(await f.backend.readMeta("map"), { phase: "pending" });
    await assert.rejects(f.backend.writeBlobMeta(key, { meta: [{ key: "map", value: "stale" }] }, { guard: snapshot.guard }), JournalGuardConflict);
    const current = await f.backend.readBlobWithJournal(key, { meta: ["map"] });
    await assert.rejects(f.backend.writeBlobMeta(key, { meta: [{ key: "unnamed", value: true }] }, { guard: current.guard }), JournalGuardConflict);
    const competing = input("delete", key);
    await f.backend.admitPreparedBlob(prepared(competing), { guard: current.guard });
    await assert.rejects(f.backend.writeBlobMeta(key, { removeMeta: ["map"] }, { guard: current.guard }), JournalGuardConflict);
    assert.deepEqual(await f.backend.readMeta("map"), { phase: "pending" });
  } finally { await f.cleanup(); }
  const small = await fixture(5000);
  try {
    const snap = await small.backend.readBlobWithJournal("small.bin", { meta: ["map"] });
    await assert.rejects(small.backend.writeBlobMeta("small.bin", { meta: [{ key: "map", value: "x".repeat(6000) }] }, { guard: snap.guard }), RangeError);
    assert.equal(await small.backend.readMeta("map"), undefined);
    assert.equal((await small.backend.readBlobWithJournal("small.bin")).intents.length, 0);
  } finally { await small.cleanup(); }
});

test("blob non-execution prefix is guarded, one-count, restart-safe, and never terminal authority", async () => {
  const f = await fixture(); let b = f.backend;
  try {
    const value = input("delete"), row = await b.admitPreparedBlob(prepared(value), { guard: (await b.readBlobWithJournal(value.intent.key)).guard });
    assert.equal(row.notAppliedThrough, undefined);
    const guard = async () => (await b.readBlobWithJournal(row.target)).guard;
    const before = b.transaction;
    await assert.rejects(b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 2 }, { guard: await guard() })); assert.equal(b.transaction, before);
    const claim = await b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: await guard() });
    for (const patch of [
      { state: "pending", attempts: 1, notAppliedThrough: 2, deletionHold: { deletions: 3, baseline: 5 } },
      { state: "pending", attempts: 1, notAppliedThrough: 1 },
      { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: { deletions: 0, baseline: 5 } },
      { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: { deletions: 3, baseline: 5, acceptDeletes: 3 } },
      { state: "in_flight", attempts: 1 },
    ]) await assert.rejects(b.updateBlobIntent(row.requestId, "in_flight", patch as never, { guard: await guard() }));
    assert.deepEqual(await b.readBlobIntent(row.requestId), claim);
    const held = await b.updateBlobIntent(row.requestId, "in_flight", { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: { deletions: 3, baseline: 5 } }, { guard: await guard() });
    assert.equal(held.receipt, undefined); await b.compact(); await b.close(); b = await FileJournaledBackend.open(f.options);
    assert.deepEqual(await b.readBlobIntent(row.requestId), held);
    const stale = await guard(); const second = await b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 2 }, { guard: stale });
    assert.equal(second.notAppliedThrough, 1); assert.deepEqual(second.deletionHold, held.deletionHold);
    await assert.rejects(b.updateBlobIntent(row.requestId, "pending", { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: held.deletionHold }, { guard: stale }));
    await b.updateBlobIntent(row.requestId, "in_flight", { state: "unknown", attempts: 2 }, { guard: await guard() });
    // A crash after the claim leaves a gap; no new claim or stale proof can fill it by counter manipulation.
    await assert.rejects(b.updateBlobIntent(row.requestId, "unknown", { state: "in_flight", attempts: 3 }, { guard: await guard() }));
    await assert.rejects(b.updateBlobIntent(row.requestId, "unknown", { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: held.deletionHold }, { guard: await guard() }));
    const receipt = blobReceipt(row.prepared, success(value));
    await b.updateBlobIntent(row.requestId, "unknown", { state: "acknowledged", receipt }, { guard: await guard() });
    await assert.rejects(b.updateBlobIntent(row.requestId, "acknowledged", { state: "pending", attempts: 2, notAppliedThrough: 2, deletionHold: { deletions: 4, baseline: 5 } }, { guard: await guard() }));
    assert.deepEqual((await b.readBlobIntent(row.requestId))?.receipt, receipt);
  } finally { await b.close(); await f.cleanup(); }
});

test("held prefix keeps settlement capacity reserved and proof plus named metadata refuses atomically", async () => {
  const reserve = BLOB_JOURNAL_BOUNDS.terminalReceiptBytes + BLOB_JOURNAL_BOUNDS.settlementStructureBytes + BLOB_JOURNAL_BOUNDS.baselineBytes;
  const f = await fixture(reserve + 5000), b = f.backend;
  try {
    await b.writeMeta("retained", "x".repeat(3800));
    const value = input("delete"), row = await b.admitPreparedBlob(prepared(value), { guard: (await b.readBlobWithJournal(value.intent.key)).guard });
    const key = row.target;
    await b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await b.readBlobWithJournal(key)).guard });
    const patch = { state: "pending" as const, attempts: 1, notAppliedThrough: 1, deletionHold: { deletions: 3, baseline: 5 } };
    const guard = (await b.readBlobWithJournal(key, { meta: ["baseline"] })).guard, txn = b.transaction, log = await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG));
    await assert.rejects(b.updateBlobIntent(row.requestId, "in_flight", patch, { guard, meta: [{ key: "baseline", value: "x".repeat(2000) }] }), /settlement reserve/);
    assert.equal(b.transaction, txn); assert.deepEqual(await fs.readFile(path.join(f.directory, FILE_JOURNAL_LOG)), log); assert.equal((await b.readBlobIntent(row.requestId))?.notAppliedThrough, undefined); assert.equal(await b.readMeta("baseline"), undefined);
    await b.updateBlobIntent(row.requestId, "in_flight", patch, { guard });
    await assert.rejects(b.writeMeta("padding", "x".repeat(2000)), /settlement reserve/);
    const beforeBad = b.transaction;
    await assert.rejects(b.updateBlobIntent(row.requestId, "pending", { notAppliedThrough: null } as never, { guard: (await b.readBlobWithJournal(key)).guard })); assert.equal(b.transaction, beforeBad);
    await b.updateBlobIntent(row.requestId, "pending", { state: "in_flight", attempts: 2 }, { guard: (await b.readBlobWithJournal(key)).guard });
    const receipt = blobReceipt(row.prepared, { ok: false, operationId: value.intent.operationId, error: { code: "backend_unavailable", message: "x".repeat(BLOB_JOURNAL_BOUNDS.terminalReceiptBytes - 1024), retryable: false, writeState: "not_applied" } });
    await b.updateBlobIntent(row.requestId, "in_flight", { state: "refused", attempts: 2, receipt }, { guard: (await b.readBlobWithJournal(key, { meta: ["baseline"] })).guard, meta: [{ key: "baseline", value: "x".repeat(BLOB_JOURNAL_BOUNDS.baselineBytes - 256) }] });
    assert.deepEqual((await b.readBlobIntent(row.requestId))?.receipt, receipt);
  } finally { await f.cleanup(); }
});
