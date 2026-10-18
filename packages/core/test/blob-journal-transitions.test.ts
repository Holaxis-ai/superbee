/** One owner for blob intent transitions: the memory and file journals decide through the same pure
 * functions, so every row (including each refusal) answers identically on both. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  BlobAdmissionConflict,
  blobIntentResendable,
  blobNonExecutionPatch,
  blobReceipt,
  captureBlobIntentRecord,
  checkBlobAdmission,
  createMemoryBlobJournal,
  prepareBlobIntent,
  type BlobIntentPatch,
  type BlobIntentRecord,
  type BlobJournaledBackend,
  type BlobPreparedInput,
} from "../src/blob-journal.js";
import { FileJournaledBackend } from "../src/file-journaled-backend.js";
import type { OperationState } from "../src/uncertain-write.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const now = "2026-10-17T06:00:00.000Z";
const bytes = new Uint8Array([0, 255, 3, 128]);
const digest = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const old = digest(new Uint8Array([4]));
const binding = digest(new Uint8Array([5]));
type Op = "create" | "replace" | "delete";

/** Deterministic request ids, so both journals see identical payloads. */
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function input(n: number, operation: Op, key: string, bundleId = "notes.a"): BlobPreparedInput {
  const common = { key, expectedVersion: operation === "create" ? null : old, expectedContentType: operation === "create" ? null : "application/old" };
  const intent = operation === "delete" ? { ...common, operationId: "blobs.delete.v1" as const } : { ...common, operationId: operation === "create" ? "blobs.create.v1" as const : "blobs.replace.v1" as const, version: digest(bytes), contentType: "application/octet-stream" };
  return { scope: { origin: "https://example.test", prefix: "/sync/v1", bundleId, workspaceSlug: "1-team" }, intent: intent as BlobPreparedInput["intent"], identity: { requestId: rid(n), binding }, createdAt: now };
}
const prepared = (value: BlobPreparedInput) => prepareBlobIntent(value, value.intent.operationId === "blobs.delete.v1" ? undefined : bytes);
const success = (value: BlobPreparedInput) => ({ ok: true, operationId: value.intent.operationId, data: value.intent.operationId === "blobs.delete.v1" ? { key: value.intent.key, version: old, contentType: "application/old", deleted: true } : { key: value.intent.key, version: value.intent.version, contentType: value.intent.contentType, changed: true } });

interface Journal { backend: BlobJournaledBackend; close(): Promise<void> }
async function memoryJournal(): Promise<Journal> { return { backend: createMemoryBlobJournal(), async close() {} }; }
async function fileJournal(): Promise<Journal> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-parity-"));
  const backend = await FileJournaledBackend.open({ directory, lock: { lockRoot: path.join(directory, "locks"), waitMs: 0 }, compactAfterBytes: Infinity });
  return { backend, async close() { await backend.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

/** One step's answer, stripped of wall-clock time: a record's durable fields, or the refusal's class and message. */
type Answer = { ok: true; value: unknown } | { ok: false; error: string; message: string };
const project = (row: BlobIntentRecord) => { const { updatedAt: _t, prepared: _p, ...rest } = row; return rest; };
async function answer(work: Promise<unknown>): Promise<Answer> {
  try {
    const value = await work;
    return { ok: true, value: value && typeof value === "object" && "recordFamily" in value ? project(value as BlobIntentRecord) : value };
  } catch (error) { return { ok: false, error: (error as Error).constructor.name, message: (error as Error).message }; }
}

/** A row drives one journal and returns every step's answer plus the final listing. */
type Row = { name: string; expect: ("ok" | string)[]; run(j: BlobJournaledBackend, step: (work: Promise<unknown>) => Promise<Answer>): Promise<void> };
const guard = async (j: BlobJournaledBackend, key: string, meta?: string[]) => (await j.readBlobWithJournal(key, meta ? { meta } : {})).guard;
const update = async (j: BlobJournaledBackend, n: number, key: string, expected: OperationState, patch: BlobIntentPatch | ((row: BlobIntentRecord) => BlobIntentPatch)) => {
  const row = (await j.readBlobIntent(rid(n)))!;
  return j.updateBlobIntent(rid(n), expected, typeof patch === "function" ? patch(row) : patch, { guard: await guard(j, key) });
};
const admit = async (j: BlobJournaledBackend, value: BlobPreparedInput, unsettled?: BlobIntentRecord[]) => j.admitPreparedBlob(prepared(value), { guard: await guard(j, value.intent.key), ...(unsettled ? { unsettled } : {}) });
const claim = (j: BlobJournaledBackend, n: number, key: string, from: OperationState = "pending") => update(j, n, key, from, row => ({ state: "in_flight", attempts: row.attempts + 1 }));
const notDispatched = (code: "credentials_unavailable" | "credentials_denied" | "aborted" | "invalid_identity" | "precondition_failed") => (row: BlobIntentRecord) => blobNonExecutionPatch(row, { kind: "not_dispatched", code });

const K = "media/a.bin";
const ROWS: Row[] = [
  {
    name: "claim consumes exactly one eligibility; settle; retire",
    expect: ["ok", "JournalGuardConflict", "ok", "ok", "JournalGuardConflict", "ok"],
    async run(j, step) {
      const v = input(1, "create", K);
      await step(admit(j, v));
      await step(update(j, 1, K, "pending", { state: "in_flight", attempts: 2 }));
      await step(claim(j, 1, K));
      await step(update(j, 1, K, "in_flight", { state: "acknowledged", receipt: blobReceipt(prepared(v), success(v)) }));
      await step(update(j, 1, K, "acknowledged", { attempts: 2 }));
      await step(j.retireBlobIntents(K, [rid(1)], { guard: await guard(j, K) }));
    },
  },
  {
    name: "wrong expected state, stale guard, unknown patch field, non-terminal retirement and mismatched guard key refuse",
    expect: ["ok", "IntentStateConflict", "JournalGuardConflict", "JournalGuardConflict", "JournalGuardConflict", "JournalGuardConflict", "IntentStateConflict"],
    async run(j, step) {
      const v = input(2, "replace", K);
      await step(admit(j, v));
      await step(update(j, 2, K, "in_flight", { state: "unknown" }));
      const stale = await guard(j, K);
      await j.updateBlobIntent(rid(2), "pending", { state: "pending" }, { guard: stale });
      await step(j.updateBlobIntent(rid(2), "pending", { state: "in_flight", attempts: 1 }, { guard: { ...stale, intents: [] } }));
      await step(update(j, 2, K, "pending", { state: "unknown", acceptDeletes: 1 } as never));
      await step(j.retireBlobIntents(K, [rid(2)], { guard: await guard(j, K) }));
      await step(j.admitPreparedBlob(prepared(input(3, "create", "media/other.bin")), { guard: await guard(j, K) }));
      await step(j.updateBlobIntent(rid(99), "pending", { state: "unknown" }, { guard: await guard(j, K) }));
    },
  },
  {
    name: "deletion hold extends the prefix from in_flight and unknown, keeps the hold, and a gap stays lookup-only",
    expect: ["ok", "ok", "TypeError", "ok", "ok", "ok", "JournalGuardConflict", "JournalGuardConflict", "ok"],
    async run(j, step) {
      const v = input(4, "delete", K);
      await step(admit(j, v));
      await step(claim(j, 4, K));
      await step(update(j, 4, K, "in_flight", { state: "pending", attempts: 1, notAppliedThrough: 1 }));
      await step(update(j, 4, K, "in_flight", row => blobNonExecutionPatch(row, { kind: "deletion_hold", deletions: 3, baseline: 5 })));
      await step(claim(j, 4, K));
      await step(update(j, 4, K, "in_flight", { state: "unknown" }));
      await step(claim(j, 4, K, "unknown"));
      await step(update(j, 4, K, "unknown", { state: "pending", attempts: 1, notAppliedThrough: 1, deletionHold: { deletions: 3, baseline: 5 } }));
      await step(update(j, 4, K, "unknown", { state: "acknowledged", receipt: blobReceipt(prepared(v), success(v)) }));
    },
  },
  {
    name: "not_dispatched rolls in_flight back to pending, a new claim is allowed, and a later unknown stays lookup-only",
    expect: ["ok", "ok", "ok", "ok", "ok", "JournalGuardConflict", "JournalGuardConflict"],
    async run(j, step) {
      await step(admit(j, input(5, "create", K)));
      await step(claim(j, 5, K));
      await step(update(j, 5, K, "in_flight", notDispatched("credentials_denied")));
      await step(claim(j, 5, K));
      await step(update(j, 5, K, "in_flight", { state: "unknown" }));
      await step(claim(j, 5, K, "unknown"));
      // Not dispatched is local proof for an in_flight claim only; an unknown attempt may have left.
      await step(update(j, 5, K, "unknown", notDispatched("aborted")));
    },
  },
  {
    name: "not_dispatched refuses on pending, terminal, a mixed hold, an unknown code and a wrong count",
    expect: ["ok", "TypeError", "ok", "TypeError", "TypeError", "TypeError", "JournalGuardConflict", "ok", "TypeError"],
    async run(j, step) {
      const v = input(6, "create", K);
      await step(admit(j, v));
      await step(update(j, 6, K, "pending", notDispatched("aborted")));
      await step(claim(j, 6, K));
      await step(update(j, 6, K, "in_flight", { state: "pending", attempts: 1, notAppliedThrough: 1, notDispatched: { code: "made_up" as never } }));
      await step(update(j, 6, K, "in_flight", { state: "pending", attempts: 1, notAppliedThrough: 1, notDispatched: { code: "aborted" }, deletionHold: { deletions: 3, baseline: 5 } }));
      await step(update(j, 6, K, "in_flight", { state: "pending", attempts: 1, notAppliedThrough: 2, notDispatched: { code: "aborted" } }));
      await step(update(j, 6, K, "in_flight", { state: "unknown", notAppliedThrough: 1, notDispatched: { code: "aborted" } }));
      await step(update(j, 6, K, "in_flight", { state: "acknowledged", receipt: blobReceipt(prepared(v), success(v)) }));
      await step(update(j, 6, K, "acknowledged", { state: "pending", attempts: 1, notAppliedThrough: 1, notDispatched: { code: "aborted" } }));
    },
  },
  {
    name: "a held delete that is then not dispatched keeps its hold and stays resendable",
    expect: ["ok", "ok", "ok", "ok", "JournalGuardConflict", "ok", "ok"],
    async run(j, step) {
      await step(admit(j, input(7, "delete", K)));
      await step(claim(j, 7, K));
      await step(update(j, 7, K, "in_flight", row => blobNonExecutionPatch(row, { kind: "deletion_hold", deletions: 2, baseline: 9 })));
      await step(claim(j, 7, K));
      // One attempt has one kind of evidence.
      await step(update(j, 7, K, "in_flight", { state: "pending", attempts: 2, notAppliedThrough: 2, notDispatched: { code: "aborted" }, deletionHold: { deletions: 4, baseline: 9 } }));
      await step(update(j, 7, K, "in_flight", notDispatched("invalid_identity")));
      const row = (await j.readBlobIntent(rid(7)))!;
      await step(Promise.resolve({ resendable: blobIntentResendable(row), hold: row.deletionHold, notDispatched: row.notDispatched, prefix: row.notAppliedThrough }));
    },
  },
  {
    name: "same (bundle, key): a second unsettled intent refuses unless the earlier record is its exact premise",
    expect: ["ok", "BlobAdmissionConflict", "ok", "ok", "BlobAdmissionConflict", "BlobAdmissionConflict", "ok", "ok", "BlobAdmissionConflict", "ok"],
    async run(j, step) {
      await step(admit(j, input(8, "create", K)));
      await step(admit(j, input(9, "create", K)));
      const first = (await j.readBlobIntent(rid(8)))!;
      await step(admit(j, input(9, "create", K), [first]));
      await step(claim(j, 8, K));
      // The premise is the record as it is now: a claimed record no longer matches the old copy.
      await step(admit(j, input(10, "create", K), [first, (await j.readBlobIntent(rid(9)))!]));
      await step(admit(j, input(10, "create", K), [(await j.readBlobIntent(rid(9)))!]));
      await step(admit(j, input(10, "create", K), [(await j.readBlobIntent(rid(8)))!, (await j.readBlobIntent(rid(9)))!]));
      // A settled record never blocks: settle 8 and 9, and 10 is still the one unsettled intent.
      const v8 = input(8, "create", K), v9 = input(9, "create", K);
      await j.updateBlobIntent(rid(8), "in_flight", { state: "acknowledged", receipt: blobReceipt(prepared(v8), success(v8)) }, { guard: await guard(j, K) });
      await step(update(j, 9, K, "pending", { state: "refused", receipt: blobReceipt(prepared(v9), { ok: false, operationId: "blobs.create.v1", error: { code: "backend_unavailable", message: "no", retryable: false, writeState: "not_applied" } }) }));
      await step(admit(j, input(11, "create", K)));
      await step(admit(j, input(11, "create", K), [(await j.readBlobIntent(rid(10)))!]));
    },
  },
  {
    name: "two bundles on one key are independent at admission; their shared per-key guard gives only a false conflict",
    expect: ["ok", "ok", "ok", "JournalGuardConflict", "ok", "JournalSnapshotConflict"],
    async run(j, step) {
      await step(admit(j, input(12, "create", K, "notes.a")));
      const shared = await guard(j, K);
      await step(j.admitPreparedBlob(prepared(input(13, "create", K, "notes.b")), { guard: shared }));
      await step(Promise.resolve((await j.readBlobWithJournal(K)).intents.map(row => row.requestId)));
      // Bundle a's claim under the guard read before bundle b admitted: refused, nothing about a changed.
      await step(j.updateBlobIntent(rid(12), "pending", { state: "in_flight", attempts: 1 }, { guard: shared }));
      await step(claim(j, 12, K));
      await step(admit(j, input(12, "create", "media/reuse.bin", "notes.c")));
    },
  },
  {
    name: "guarded metadata travels with admission, claim and retirement, and a stale premise refuses atomically",
    expect: ["ok", "ok", "JournalGuardConflict", "ok", "ok", "ok"],
    async run(j, step) {
      const v = input(14, "create", K);
      await step(j.admitPreparedBlob(prepared(v), { guard: await guard(j, K, ["map"]), meta: [{ key: "map", value: { n: 1 } }] }));
      const seen = await guard(j, K, ["map"]);
      await step(j.writeBlobMeta!(K, { meta: [{ key: "map", value: { n: 2 } }] }, { guard: seen }));
      await step(j.updateBlobIntent(rid(14), "pending", { state: "in_flight", attempts: 1 }, { guard: seen, meta: [{ key: "map", value: { n: 3 } }] }));
      await step(j.updateBlobIntent(rid(14), "pending", { state: "in_flight", attempts: 1 }, { guard: await guard(j, K, ["map"]), meta: [{ key: "map", value: { n: 3 } }] }));
      await step(update(j, 14, K, "in_flight", { state: "acknowledged", receipt: blobReceipt(prepared(v), success(v)) }));
      await step(j.retireBlobIntents(K, [rid(14)], { guard: await guard(j, K, ["map"]), removeMeta: ["map"] }));
    },
  },
];

for (const row of ROWS) {
  test(`parity: ${row.name}`, async () => {
    const results: { answers: Answer[]; listing: unknown }[] = [];
    for (const open of [memoryJournal, fileJournal]) {
      const journal = await open();
      try {
        const answers: Answer[] = [];
        await row.run(journal.backend, async work => { const a = await answer(work); answers.push(a); return a; });
        results.push({ answers, listing: (await journal.backend.listBlobIntents()).map(project) });
      } finally { await journal.close(); }
    }
    const [memory, file] = results;
    assert.deepEqual(memory, file, "memory and file journals answer every step identically");
    assert.deepEqual(memory!.answers.map(a => a.ok ? "ok" : a.error), row.expect);
  });
}

test("not_dispatched rollback lands at pending with notAppliedThrough = attempts and typed evidence, then reopens intact", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-nd-"));
  const options = { directory, lock: { lockRoot: path.join(directory, "locks"), waitMs: 0 }, compactAfterBytes: Infinity };
  let b = await FileJournaledBackend.open(options);
  try {
    await admit(b, input(20, "replace", K));
    await claim(b, 20, K);
    const rolled = await update(b, 20, K, "in_flight", notDispatched("precondition_failed"));
    assert.equal(rolled.state, "pending");
    assert.equal(rolled.attempts, 1);
    assert.equal(rolled.notAppliedThrough, 1);
    assert.deepEqual(rolled.notDispatched, { code: "precondition_failed" });
    assert.equal(rolled.deletionHold, undefined);
    assert.equal(blobIntentResendable(rolled), true);
    await b.compact(); await b.close();
    b = await FileJournaledBackend.open(options);
    assert.deepEqual(await b.readBlobIntent(rid(20)), rolled);
  } finally { await b.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

/** `fixtures/blob-journal-pre-not-dispatched/store.log` was written by the file journal at
 * 15903109, before typed not-dispatched evidence existed. Its records must decode and behave
 * exactly as they did. */
test("a store written before not_dispatched opens, decodes and keeps its held, unknown and settled semantics", async () => {
  const source = path.join(here, "fixtures", "blob-journal-pre-not-dispatched", "store.log");
  const original = await fs.readFile(source);
  assert.equal(createHash("sha256").update(original).digest("hex"), "b48c7815443c82f3d731e19c0ef480f18466d6fd600a934cf5128ac2add98b89");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-old-"));
  await fs.chmod(directory, 0o700);
  await fs.copyFile(source, path.join(directory, "store.log"));
  const b = await FileJournaledBackend.open({ directory, lock: { lockRoot: path.join(directory, "locks"), waitMs: 0 }, compactAfterBytes: Infinity });
  try {
    const rows = await b.listBlobIntents();
    assert.deepEqual(rows.map(row => [row.target, row.state, row.attempts, row.notAppliedThrough ?? 0, "notDispatched" in row]), [
      ["media/pending.bin", "pending", 0, 0, false],
      ["media/held.bin", "pending", 1, 1, false],
      ["media/unknown.bin", "unknown", 1, 0, false],
      ["media/done.bin", "acknowledged", 1, 0, false],
    ]);
    for (const row of rows) assert.deepEqual(captureBlobIntentRecord(row), row);
    assert.deepEqual(rows[1]!.deletionHold, { deletions: 3, baseline: 5 });
    // The held delete claims its second attempt exactly as before; the unknown replace stays lookup-only.
    const held = await claim(b, 2, "media/held.bin");
    assert.equal(held.attempts, 2); assert.deepEqual(held.deletionHold, { deletions: 3, baseline: 5 }); assert.equal(held.notDispatched, undefined);
    await assert.rejects(claim(b, 3, "media/unknown.bin", "unknown"));
    await b.retireBlobIntents("media/done.bin", [rid(4)], { guard: await guard(b, "media/done.bin") });
    // A record with a non-zero prefix but neither kind of evidence is still refused.
    assert.throws(() => captureBlobIntentRecord({ ...rows[1]!, deletionHold: undefined } as never), /typed evidence/);
  } finally { await b.close(); await fs.rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(await fs.readFile(source), original);
});

test("pre-admit checks refuse unsafe keys, bad MIME pins, bytes on delete and sizes above the advertised bound", () => {
  const ok = { ok: true };
  assert.deepEqual(checkBlobAdmission({ operation: "create", key: "media/a.svg", contentType: "image/svg+xml", byteLength: 10, maximumBytes: 10 }), ok);
  assert.deepEqual(checkBlobAdmission({ operation: "replace", key: "media/a.txt", contentType: "text/plain; charset=utf-8", expectedContentType: "text/plain", byteLength: 0 }), ok);
  assert.deepEqual(checkBlobAdmission({ operation: "delete", key: "media/a.txt", expectedContentType: "text/plain" }), ok);
  const reason = (value: Parameters<typeof checkBlobAdmission>[0]) => { const r = checkBlobAdmission(value); return r.ok ? "ok" : r.reason; };
  assert.equal(reason({ operation: "create", key: "../escape", contentType: "text/plain", byteLength: 1 }), "unsafe_key");
  assert.equal(reason({ operation: "create", key: "media/a", contentType: " text/plain", byteLength: 1 }), "invalid_content_type");
  assert.equal(reason({ operation: "replace", key: "media/a", contentType: "text/plain", byteLength: 1 }), "invalid_expected_content_type");
  assert.equal(reason({ operation: "delete", key: "media/a", expectedContentType: "text/plain", byteLength: 0 }), "bytes_with_delete");
  assert.equal(reason({ operation: "create", key: "media/a", contentType: "text/plain" }), "missing_bytes");
  assert.equal(reason({ operation: "create", key: "media/a", contentType: "text/plain", byteLength: 11, maximumBytes: 10 }), "too_large");
  assert.equal(reason({ operation: "create", key: "media/a", contentType: "text/plain", byteLength: 16 * 1024 * 1024 + 1, maximumBytes: 64 * 1024 * 1024 }), "too_large");
  assert.equal(reason({ operation: "create", key: "media/a", contentType: "text/plain", byteLength: 1, maximumBytes: 0 }), "invalid_bound");
});

test("blobNonExecutionPatch types both kinds and refuses malformed evidence", () => {
  const row = { attempts: 2 } as BlobIntentRecord;
  assert.deepEqual(blobNonExecutionPatch(row, { kind: "deletion_hold", deletions: 1, baseline: 2 }), { state: "pending", attempts: 2, notAppliedThrough: 2, deletionHold: { deletions: 1, baseline: 2 } });
  assert.deepEqual(blobNonExecutionPatch(row, { kind: "not_dispatched", code: "credentials_unavailable" }), { state: "pending", attempts: 2, notAppliedThrough: 2, notDispatched: { code: "credentials_unavailable" } });
  assert.throws(() => blobNonExecutionPatch(row, { kind: "not_dispatched", code: "credentials_unavailable", extra: 1 } as never));
  assert.throws(() => blobNonExecutionPatch(row, { kind: "deletion_hold", deletions: 0, baseline: 2 }));
  assert.throws(() => blobNonExecutionPatch(row, { kind: "other" } as never));
});

test("BlobAdmissionConflict is a JournalGuardConflict, so existing guard-conflict handling still catches it", async () => {
  const j = createMemoryBlobJournal();
  await admit(j, input(30, "create", K));
  const error = await admit(j, input(31, "create", K)).then(() => null, e => e);
  assert.ok(error instanceof BlobAdmissionConflict);
  assert.equal(error.name, "JournalGuardConflict");
  assert.deepEqual(error.unsettled, [rid(30)]);
});

test("one owner: file-journaled-backend.ts calls the pure blob transition functions and keeps no copy of their conditionals", async () => {
  const source = await fs.readFile(path.join(here, "..", "src", "file-journaled-backend.ts"), "utf8");
  for (const call of ["captureBlobAdmission(", "decideBlobAdmission(", "captureBlobUpdate(", "decideBlobUpdate(", "captureBlobRetirement(", "decideBlobRetirement(", "captureBlobMetaWrite(", "decideBlobMetaWrite(", "readBlobJournal("]) assert.ok(source.includes(call), `calls ${call}`);
  for (const copy of [/attempts \+ 1/, /beforePrefix|afterPrefix|sameHold/, /"in_flight"/, /\["pending", "unknown"\]/, /\["in_flight", "unknown"\]/, /patch\.(?:state|attempts|deletionHold|notDispatched)/, /current\.(?:attempts|receipt|notAppliedThrough|deletionHold)/, /\.receipt \|\|/, /assertBlobJournalGuard/, /#blobGuard/, /"state", "attempts", "receipt"/]) {
    assert.doesNotMatch(source, copy, `file-journaled-backend.ts must not restate ${copy}`);
  }
});

test("@superbee/core/storage carries createMemoryBlobJournal into a browser bundle with no node builtins", async () => {
  const result = await build({ entryPoints: [path.resolve(here, "../dist/storage.js")], bundle: true, platform: "browser", write: false, logLevel: "silent" });
  assert.equal(result.errors.length, 0);
  assert.ok(result.outputFiles[0]!.text.includes("createMemoryBlobJournal"));
});
