/**
 * The Node log store: the core contract kit (its storage rows and its journal rows) over
 * `FileJournaledBackend`, then adversarial rows for the mechanics the kit cannot see. An
 * interrupted append leaves the previous state and token; a torn tail is truncated at open and
 * never replays; corruption before the end refuses the open without touching the files; every
 * crash point of compaction reopens to the same state; the store is exclusive across processes;
 * and a writer killed with SIGKILL reopens with every write it acknowledged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FILE_JOURNAL_LOG,
  FILE_JOURNAL_SNAPSHOT,
  FileJournalCorruptError,
  FileJournaledBackend,
  FileJournalUnavailableError,
  type FileJournalHandle,
  type FileJournaledBackendOptions,
} from "../src/file-journaled-backend.js";
import { FilesystemMutationLockError } from "../src/filesystem-lock.js";
import { IntentHoldConflict, IntentStateConflict, type JournaledBackend, type NewIntentRecord } from "../src/journaled-backend.js";
import type { OkfDocument } from "../src/types.js";
import { VersionConflict } from "../src/versioning.js";
import { registerJournaledBackendContract } from "./journaled-backend-contract.js";
import {
  registerClaimPreconditionContract,
  registerFrontmatterReadContract,
  registerOkfAuthoringContract,
  registerStorageBackendAtomicCasContract,
  registerStorageBackendBaseContract,
  registerStorageBackendBlobContract,
  registerStorageBackendHistoryContract,
  registerStorageBackendIdentityContract,
  type BackendFixture,
} from "./storage-backend-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = "2026-09-22T00:00:00.000Z";
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Log store\n";

interface Root {
  directory: string;
  lockRoot: string;
  options(extra?: Partial<FileJournaledBackendOptions>): FileJournaledBackendOptions;
  cleanup(): Promise<void>;
}

async function newRoot(): Promise<Root> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-file-journal-"));
  const directory = path.join(base, "store");
  const lockRoot = path.join(base, "locks");
  return {
    directory,
    lockRoot,
    options: (extra = {}) => ({ directory, lock: { lockRoot, waitMs: 0 }, ...extra }),
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

async function fixture(): Promise<BackendFixture & { backend: FileJournaledBackend }> {
  const root = await newRoot();
  const backend = await FileJournaledBackend.open(root.options());
  return { backend, cleanup: async () => { await backend.close(); await root.cleanup(); } };
}

// ── the contract kit ───────────────────────────────────────────────────────────────────────

registerStorageBackendBaseContract({ name: "FileJournaledBackend", create: fixture });
registerFrontmatterReadContract({ name: "FileJournaledBackend", create: fixture, localYamlValues: true });
registerOkfAuthoringContract({ name: "FileJournaledBackend", create: fixture });
registerStorageBackendBlobContract({ name: "FileJournaledBackend", create: fixture });
registerStorageBackendHistoryContract({ name: "FileJournaledBackend", create: fixture, retention: "current-only" });
for (const register of [registerStorageBackendAtomicCasContract, registerClaimPreconditionContract]) {
  register({ name: "FileJournaledBackend", async createPeers() { const made = await fixture(); return { ...made, peers: [made.backend] }; } });
}
// The store keys by string, never by filename, so no spelling pair aliases.
registerStorageBackendIdentityContract({
  name: "FileJournaledBackend",
  create: async () => ({ ...(await fixture()), host: { hostClass: "exact", case: false, normalization: false } as const }),
});
registerJournaledBackendContract({
  name: "FileJournaledBackend",
  create: async () => {
    const made = await fixture();
    return { ...made, storeRaw: (id, raw) => made.backend.storeRaw(id, raw) };
  },
  seam: { IntentStateConflict, IntentHoldConflict, VersionConflict },
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────

function doc(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title: id }, body };
}

function intent(requestId: string, target: string, base: string | null = null): NewIntentRecord {
  return { requestId, kind: "document.write", target, base, baseContent: null, createdAt: NOW };
}

/** Everything a caller can observe, in one comparable value. */
async function observe(backend: JournaledBackend) {
  return {
    heads: (await backend.readHeads({ shared: ["pause", "date", "map", "undef"], meta: (id) => [`base:${id}`] })).map((head) => ({ ...head, meta: [...head.meta] })),
    intents: await backend.listIntents(),
    reserved: await backend.readReserved("", "index.md"),
    blobs: await Promise.all((await backend.listBlobs()).map(async (key) => [key, await backend.readBlob(key)])),
  };
}

/** A realistic mix: documents with intents and bases, settled and unsettled, opaque meta, a blob. */
async function populate(backend: FileJournaledBackend): Promise<void> {
  await backend.writeReserved("", "index.md", ROOT_INDEX);
  for (const name of ["alpha", "beta", "gamma"]) {
    const id = `notes/${name}`;
    await backend.writeJournaled(id, doc(id, `${name} v1\n`), { intent: intent(`r-${name}`, id), meta: (written) => [{ key: `base:${id}`, value: written.version }] });
  }
  await backend.updateIntent("r-alpha", "pending", { state: "acknowledged", attempts: 1 }, { meta: [{ key: "pause", value: false }] });
  await backend.writeMeta("date", new Date(0));
  await backend.writeMeta("map", new Map([["k", { nested: [1, 2] }]]));
  await backend.writeMeta("undef", undefined);
  await backend.writeBlob("artifacts/a.bin", new Uint8Array([0, 1, 2, 255]));
  await backend.deleteJournaled("notes/beta", { removeMeta: [] });
}

async function reopened(root: Root, extra?: Partial<FileJournaledBackendOptions>): Promise<FileJournaledBackend> {
  return FileJournaledBackend.open(root.options(extra));
}

async function logBytes(root: Root): Promise<Buffer> {
  return fs.readFile(path.join(root.directory, FILE_JOURNAL_LOG));
}

/** A log handle that fails once on cue; `truncate` can be told to fail too. */
function faultyLog(plan: { failWrite?: "partial" | "whole"; failSync?: boolean; failTruncate?: boolean; armed: boolean }) {
  return async (file: string): Promise<FileJournalHandle> => {
    const real = await fs.open(file, "r+");
    return {
      async write(buffer, offset, length, position) {
        if (plan.armed && plan.failWrite) {
          if (plan.failWrite === "partial") await real.write(buffer, offset, Math.floor(length / 2), position);
          plan.armed = false;
          throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        }
        return real.write(buffer, offset, length, position);
      },
      async sync() {
        if (plan.armed && plan.failSync) {
          plan.armed = false;
          throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
        }
        return real.sync();
      },
      async truncate(length) {
        if (plan.failTruncate) throw Object.assign(new Error("injected truncate failure"), { code: "EIO" });
        return real.truncate(length);
      },
      close: () => real.close(),
    };
  };
}

// ── persistence ────────────────────────────────────────────────────────────────────────────

test("everything a caller can observe survives close and reopen, and the intent sequence continues", async () => {
  const root = await newRoot();
  try {
    const first = await reopened(root);
    await populate(first);
    const before = await observe(first);
    const txn = first.transaction;
    await first.close();
    await assert.rejects(first.read("notes/alpha"), FileJournalUnavailableError);

    const second = await reopened(root);
    try {
      assert.deepEqual(await observe(second), before);
      assert.equal(second.transaction, txn);
      assert.deepEqual(await second.readMeta("date"), new Date(0));
      const next = await second.writeJournaled("notes/delta", doc("notes/delta", "delta\n"), { intent: intent("r-delta", "notes/delta") });
      assert.equal(next.intent!.sequence, 4);
    } finally {
      await second.close();
    }
  } finally {
    await root.cleanup();
  }
});

test("a refused mutation writes no record, and a no-op writes none either", async () => {
  const root = await newRoot();
  try {
    const backend = await reopened(root);
    await populate(backend);
    const size = (await logBytes(root)).byteLength;
    const txn = backend.transaction;
    await assert.rejects(backend.write("notes/alpha", doc("notes/alpha", "x"), { expectedVersion: "sha256:" + "0".repeat(64) }), VersionConflict);
    await assert.rejects(backend.writeJournaled("notes/gamma", doc("notes/gamma", "x"), { requireSettled: true }), IntentHoldConflict);
    await assert.rejects(backend.updateIntent("r-alpha", "pending", { state: "in_flight" }), IntentStateConflict);
    await assert.rejects(backend.writeMeta("fn", () => true));
    assert.equal(await backend.delete("notes/absent"), false);
    const blob = await backend.readBlob("artifacts/a.bin");
    await backend.writeBlob("artifacts/a.bin", blob!.bytes, blob!.contentType);
    assert.equal((await logBytes(root)).byteLength, size);
    assert.equal(backend.transaction, txn);
    await backend.close();
  } finally {
    await root.cleanup();
  }
});

// ── the interrupted-write rows ─────────────────────────────────────────────────────────────

for (const fault of [
  { name: "a failed write of part of the record", plan: { failWrite: "partial" as const } },
  { name: "a failed write of the whole record", plan: { failWrite: "whole" as const } },
  { name: "a failed fsync after the record was written", plan: { failSync: true } },
]) {
  test(`interrupted write: ${fault.name} rejects, leaves the previous state and token, and never replays`, async () => {
    const root = await newRoot();
    try {
      const plan = { ...fault.plan, armed: false };
      const backend = await reopened(root, { openLog: faultyLog(plan) });
      await populate(backend);
      const before = await observe(backend);
      const size = (await logBytes(root)).byteLength;
      const token = (await backend.read("notes/gamma")).version;

      plan.armed = true;
      await assert.rejects(backend.writeJournaled("notes/gamma", doc("notes/gamma", "interrupted\n"), { expectedVersion: token, intent: intent("r-lost", "notes/gamma", token), meta: [{ key: "pause", value: true }] }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /injected/);
        assert.ok(!(error instanceof VersionConflict));
        return true;
      });
      assert.deepEqual(await observe(backend), before);
      assert.equal((await logBytes(root)).byteLength, size);

      // Still usable, and the previous token is still the compare-and-swap baseline.
      const next = await backend.write("notes/gamma", doc("notes/gamma", "after\n"), { expectedVersion: token });
      await backend.close();

      const again = await reopened(root);
      try {
        assert.equal((await again.read("notes/gamma")).version, next);
        assert.equal(await again.readIntent("r-lost"), undefined);
        assert.equal(await again.readMeta("pause"), false);
      } finally {
        await again.close();
      }
    } finally {
      await root.cleanup();
    }
  });
}

test("interrupted write: when the failed record cannot be removed, the store refuses every later call and a reopen decides from the log", async () => {
  const root = await newRoot();
  try {
    const plan = { failWrite: "partial" as const, failTruncate: true, armed: false };
    const backend = await reopened(root, { openLog: faultyLog(plan) });
    await populate(backend);
    const before = await observe(backend);
    plan.armed = true;
    await assert.rejects(backend.write("notes/gamma", doc("notes/gamma", "torn\n")), /injected write failure/);
    await assert.rejects(backend.write("notes/alpha", doc("notes/alpha", "later\n")), FileJournalUnavailableError);
    await assert.rejects(backend.read("notes/alpha"), FileJournalUnavailableError);
    await backend.close();

    // The half record is a torn tail: the reopen truncates it and the state is the one before.
    const again = await reopened(root);
    try {
      assert.deepEqual(await observe(again), before);
    } finally {
      await again.close();
    }
  } finally {
    await root.cleanup();
  }
});

// ── torn tails and corruption at open ──────────────────────────────────────────────────────

/** The log after `populate`, and the bytes of one more record appended after it. */
async function logWithOneMore(root: Root): Promise<{ prefix: Buffer; record: Buffer; before: Awaited<ReturnType<typeof observe>> }> {
  const backend = await reopened(root);
  await populate(backend);
  const before = await observe(backend);
  const prefix = await logBytes(root);
  await backend.writeJournaled("notes/gamma", doc("notes/gamma", "one more\n"), { meta: [{ key: "pause", value: true }] });
  const record = (await logBytes(root)).subarray(prefix.byteLength);
  await backend.close();
  return { prefix, record, before };
}

for (const tear of [
  { name: "a record cut inside its header", bytes: (record: Buffer) => record.subarray(0, 17) },
  { name: "a record cut inside its payload", bytes: (record: Buffer) => record.subarray(0, record.byteLength - 5) },
  { name: "a whole record whose checksum fails", bytes: (record: Buffer) => { const copy = Buffer.from(record); copy[copy.byteLength - 1]! ^= 0xff; return copy; } },
  { name: "a zero-filled extension", bytes: (record: Buffer) => Buffer.alloc(record.byteLength) },
  { name: "three stray bytes", bytes: (record: Buffer) => record.subarray(0, 3) },
]) {
  test(`torn tail: ${tear.name} is truncated at open and the store continues from the last whole record`, async () => {
    const root = await newRoot();
    try {
      const { prefix, record, before } = await logWithOneMore(root);
      await fs.writeFile(path.join(root.directory, FILE_JOURNAL_LOG), Buffer.concat([prefix, tear.bytes(record)]));
      const backend = await reopened(root);
      try {
        assert.deepEqual(await observe(backend), before);
        assert.deepEqual(await logBytes(root), prefix);
        const next = await backend.write("notes/gamma", doc("notes/gamma", "continued\n"));
        await backend.close();
        const again = await reopened(root);
        assert.equal((await again.read("notes/gamma")).version, next);
        await again.close();
      } finally {
        await backend.close();
      }
    } finally {
      await root.cleanup();
    }
  });
}

for (const damage of [
  { name: "a flipped payload byte in an early record", at: (prefix: Buffer) => prefix.byteLength - 60 },
  { name: "a damaged record header in the middle", at: () => 0 },
]) {
  test(`corruption: ${damage.name} refuses the open, leaves the files as they were, and releases the lock`, async () => {
    const root = await newRoot();
    try {
      const { prefix, record } = await logWithOneMore(root);
      const damaged = Buffer.concat([prefix, record]);
      damaged[damage.at(prefix)]! ^= 0xff;
      await fs.writeFile(path.join(root.directory, FILE_JOURNAL_LOG), damaged);
      await assert.rejects(reopened(root), FileJournalCorruptError);
      assert.deepEqual(await logBytes(root), damaged);
      // The failed open released the lock: a second attempt reports the same corruption, not a held lock.
      await assert.rejects(reopened(root), FileJournalCorruptError);
    } finally {
      await root.cleanup();
    }
  });
}

// ── compaction ─────────────────────────────────────────────────────────────────────────────

test("compaction: the snapshot replaces the log, and every crash point reopens to the same state", async () => {
  const root = await newRoot();
  try {
    const backend = await reopened(root);
    await populate(backend);
    const before = await observe(backend);
    const txn = backend.transaction;
    const oldLog = await logBytes(root);
    await backend.compact();
    assert.equal((await logBytes(root)).byteLength, 0);
    await backend.close();

    // Clean: snapshot only.
    let again = await reopened(root);
    assert.deepEqual(await observe(again), before);
    assert.equal(again.transaction, txn);
    await again.close();

    // Crash after the rename, before the log was emptied: the covered records are skipped, not re-applied.
    await fs.writeFile(path.join(root.directory, FILE_JOURNAL_LOG), oldLog);
    again = await reopened(root);
    assert.deepEqual(await observe(again), before);
    assert.equal(again.transaction, txn);
    const next = await again.writeJournaled("notes/delta", doc("notes/delta", "delta\n"), { intent: intent("r-delta", "notes/delta") });
    assert.equal(next.intent!.sequence, 4);
    assert.equal(again.transaction, txn + 1);
    await again.close();
    again = await reopened(root);
    assert.equal((await again.readIntent("r-delta"))!.sequence, 4);
    await again.close();

    // Crash while the temporary snapshot was being written: the leftover is ignored and removed.
    await fs.writeFile(path.join(root.directory, "store.snapshot.tmp"), "half a snapshot");
    again = await reopened(root);
    assert.equal((await again.readIntent("r-delta"))!.sequence, 4);
    await again.close();
    await assert.rejects(fs.access(path.join(root.directory, "store.snapshot.tmp")));
  } finally {
    await root.cleanup();
  }
});

test("compaction: when the log's fsync fails after it was emptied, later appends still start at its beginning", async () => {
  const root = await newRoot();
  try {
    const plan = { failSync: true, armed: false };
    const backend = await reopened(root, { openLog: faultyLog(plan) });
    await populate(backend);
    plan.armed = true;
    await assert.rejects(backend.compact(), /injected fsync failure/);
    const next = await backend.write("notes/gamma", doc("notes/gamma", "after a failed compaction\n"));
    const before = await observe(backend);
    await backend.close();
    const again = await reopened(root);
    try {
      assert.deepEqual(await observe(again), before);
      assert.equal((await again.read("notes/gamma")).version, next);
    } finally {
      await again.close();
    }
  } finally {
    await root.cleanup();
  }
});

test("compaction: a damaged snapshot refuses the open; a log past the threshold compacts at open", async () => {
  const root = await newRoot();
  try {
    const backend = await reopened(root);
    await populate(backend);
    const before = await observe(backend);
    await backend.close();

    const compacting = await reopened(root, { compactAfterBytes: 1 });
    assert.deepEqual(await observe(compacting), before);
    assert.equal((await logBytes(root)).byteLength, 0);
    await compacting.close();

    const snapshot = await fs.readFile(path.join(root.directory, FILE_JOURNAL_SNAPSHOT));
    snapshot[snapshot.byteLength - 3]! ^= 0xff;
    await fs.writeFile(path.join(root.directory, FILE_JOURNAL_SNAPSHOT), snapshot);
    await assert.rejects(reopened(root), FileJournalCorruptError);
  } finally {
    await root.cleanup();
  }
});

test("a log whose transaction numbers skip one is corruption, not a torn tail", async () => {
  const root = await newRoot();
  try {
    const backend = await reopened(root);
    for (let value = 1; value <= 3; value++) await backend.writeMeta("k", value);
    await backend.close();
    const log = await logBytes(root);
    const records: Buffer[] = [];
    for (let at = 0; at < log.byteLength;) {
      const end = at + 40 + log.readUInt32BE(at + 4);
      records.push(log.subarray(at, end));
      at = end;
    }
    assert.equal(records.length, 3);
    const gapped = Buffer.concat([records[0]!, records[2]!]);
    await fs.writeFile(path.join(root.directory, FILE_JOURNAL_LOG), gapped);
    await assert.rejects(reopened(root), /transaction 3 follows 1/);
    assert.deepEqual(await logBytes(root), gapped);
  } finally {
    await root.cleanup();
  }
});

// ── concurrency and exclusivity ────────────────────────────────────────────────────────────

test("a second open of the same store is refused while the first holds it, and allowed after close", async () => {
  const root = await newRoot();
  try {
    const first = await reopened(root);
    await assert.rejects(reopened(root), FilesystemMutationLockError);
    await first.close();
    const second = await reopened(root);
    await second.close();
  } finally {
    await root.cleanup();
  }
});

test("concurrent mutations in one process serialize, one intent settles once, and the log replays the same order", async () => {
  const root = await newRoot();
  try {
    const backend = await reopened(root);
    await backend.writeReserved("", "index.md", ROOT_INDEX);
    await Promise.all(Array.from({ length: 24 }, (_, index) => {
      const id = `race/doc-${index % 6}`;
      return backend.writeJournaled(id, doc(id, `write ${index}\n`), { intent: intent(`race-${index}`, id), meta: [{ key: `last:${id}`, value: index }] });
    }));
    const settles = await Promise.allSettled(Array.from({ length: 5 }, () => backend.updateIntent("race-0", "pending", { state: "acknowledged", attempts: 1 })));
    assert.equal(settles.filter((row) => row.status === "fulfilled").length, 1);
    const sequences = (await backend.listIntents()).map((row) => row.sequence);
    assert.deepEqual(sequences, Array.from({ length: 24 }, (_, index) => index + 1));
    const before = await observe(backend);
    await backend.close();
    const again = await reopened(root);
    try {
      assert.deepEqual(await observe(again), before);
    } finally {
      await again.close();
    }
  } finally {
    await root.cleanup();
  }
});

test("a writer killed with SIGKILL reopens with every write it acknowledged, whole", { timeout: 60_000 }, async () => {
  const root = await newRoot();
  try {
    const child = fork(path.join(HERE, "fixtures", "file-journal-child.ts"), [root.directory, root.lockRoot], {
      execArgv: ["--import", path.join(HERE, "ts-loader.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const acks: { index: number; id: string; version: string; sequence: number }[] = [];
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message: { type: string } & (typeof acks)[number]) => {
        if (message.type === "ack") acks.push(message);
        if (acks.length >= 150) resolve();
      });
      child.on("exit", () => reject(new Error(`child exited early: ${stderr}`)));
    });
    child.kill("SIGKILL");
    await exited;

    // The dead writer's lock is reclaimed; the log reopens to a whole prefix of its writes.
    const backend = await reopened(root, { lock: { lockRoot: root.lockRoot, waitMs: 2_000 } });
    try {
      const intents = await backend.listIntents();
      const last = acks[acks.length - 1]!;
      assert.ok(intents.length >= acks.length, `${intents.length} intents for ${acks.length} acknowledged writes`);
      assert.deepEqual(intents.map((row) => row.sequence), intents.map((_, index) => index + 1));
      for (const ack of acks) assert.equal((await backend.readIntent(`kill-${ack.index}`))?.local, ack.version);
      const lastRecorded = await backend.readMeta<number>("last");
      assert.ok(lastRecorded! >= last.index);
      // Each document holds the bytes of the last write recorded for it.
      const lastByDoc = new Map<string, string>();
      for (const row of intents) lastByDoc.set(row.target, row.local!);
      for (const [id, version] of lastByDoc) assert.equal((await backend.read(id)).version, version);
    } finally {
      await backend.close();
    }
  } finally {
    await root.cleanup();
  }
});
