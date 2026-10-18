/**
 * `openHostedClientJournal` (`@superbee/core/hosted-client/node`): the durable intent store over
 * `FileJournaledBackend`. Round trips across reopen; an `unknown` document write that survives a
 * restart and settles from a new client; the marker and its refusals, including a crash between
 * the empty check and the marker write; directory privacy; the cross-process lock against a real
 * second process and a SIGKILLed holder; torn tails and corruption; and a log that stays bounded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILE_JOURNAL_LOG, FILE_JOURNAL_SNAPSHOT, FileJournaledBackend } from "../src/file-journaled-backend.js";
import { OPEN_LOG, type FileJournalHandle } from "../src/file-journaled-backend-internal.js";
import { bearerCredentials, createHostedClient } from "../src/hosted-client/index.js";
import {
  FileJournalCorruptError,
  FileJournalFormatError,
  FileJournalUnavailableError,
  FilesystemMutationLockError,
  HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES,
  HostedClientJournalError,
  isHostedClientJournalError,
  openHostedClientJournal,
  type HostedClientJournal,
} from "../src/hosted-client/node.js";
import { openHostedClientJournalWith, type JournalTestSeam } from "../src/hosted-client/journal.js";
import type { HostedWriteIntent } from "../src/hosted-client/write.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");
const POSIX = process.platform !== "win32";
const MARKER = "hosted-client.journal";

interface Root {
  directory: string;
  lockRoot: string;
  base: string;
  open(seam?: JournalTestSeam, waitMs?: number): Promise<HostedClientJournal>;
  backend(): Promise<FileJournaledBackend>;
  cleanup(): Promise<void>;
}

async function newRoot(): Promise<Root> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-hosted-journal-"));
  const directory = path.join(base, "journal");
  const lockRoot = path.join(base, "locks");
  return {
    directory,
    lockRoot,
    base,
    open: (seam = {}, waitMs = 0) => openHostedClientJournalWith({ directory, lock: { waitMs } }, { lockRoot, ...seam }),
    backend: () => FileJournaledBackend.open({ directory, lock: { lockRoot, waitMs: 0 } }),
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

async function withRoot(run: (root: Root) => Promise<void>): Promise<void> {
  const root = await newRoot();
  try {
    await run(root);
  } finally {
    await root.cleanup();
  }
}

let counter = 0;
function intent(overrides: Partial<HostedWriteIntent> = {}): HostedWriteIntent {
  counter += 1;
  const tail = counter.toString(16).padStart(12, "0");
  return {
    requestId: `0b5c8a2e-1f3d-4c6b-9a7e-${tail}`,
    binding: `sha256:${"a".repeat(64)}`,
    bundleId: "notes.a",
    workspace: null,
    operation: "create",
    documentId: `notes/${tail}`,
    document: `---\ntype: Note\n---\nbody ${tail}`,
    digest: `sha256:${"b".repeat(64)}`,
    expectedVersion: null,
    okfVersion: "0.2",
    createdAt: new Date(Date.UTC(2026, 9, 17, 0, 0, counter)).toISOString(),
    attempts: 0,
    state: "pending",
    ...overrides,
  };
}

async function listed(journal: HostedClientJournal): Promise<HostedWriteIntent[]> {
  const out: HostedWriteIntent[] = [];
  for await (const row of journal.list()) out.push(row);
  return out;
}

const logFile = (root: Root) => path.join(root.directory, FILE_JOURNAL_LOG);
const snapshotFile = (root: Root) => path.join(root.directory, FILE_JOURNAL_SNAPSHOT);
const sizeOf = async (file: string) => (await fs.stat(file).catch(() => ({ size: 0 }))).size;

/** A log handle that fails once on cue, as the backend's own fault rows use. */
function faultyLog(plan: { failWrite?: "partial"; failSync?: boolean; failTruncate?: boolean; armed: boolean }) {
  return async (file: string): Promise<FileJournalHandle> => {
    const real = await fs.open(file, "r+");
    return {
      async write(buffer, offset, length, position) {
        if (plan.armed && plan.failWrite) {
          await real.write(buffer, offset, Math.floor(length / 2), position);
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

const faultySeam = (plan: Parameters<typeof faultyLog>[0]): JournalTestSeam => ({ openBackend: (options) => FileJournaledBackend[OPEN_LOG](options, faultyLog(plan)) });

const refusedAs = (code: HostedClientJournalError["code"]) => (error: unknown) => isHostedClientJournalError(error, code);

// ── round trip ─────────────────────────────────────────────────────────────────────────────

test("put, get, delete and list round-trip across close and reopen", async () => {
  await withRoot(async (root) => {
    const first = intent();
    const second = intent({ operation: "replace", expectedVersion: `sha256:${"c".repeat(64)}`, workspace: "south" });
    const journal = await root.open();
    assert.equal(journal.directory, root.directory);
    await journal.put(first);
    await journal.put(second);
    await journal.put({ ...first, attempts: 1, state: "in_flight" });
    assert.deepEqual(await journal.get(first.requestId), { ...first, attempts: 1, state: "in_flight" });
    assert.ok(Object.isFrozen(await journal.get(first.requestId)));
    assert.equal(await journal.get("0b5c8a2e-1f3d-4c6b-9a7e-ffffffffffff"), undefined);
    await journal.delete("0b5c8a2e-1f3d-4c6b-9a7e-ffffffffffff");
    await assert.rejects(journal.put({ ...first, requestId: "" }), TypeError);
    await journal.close();

    const again = await root.open();
    assert.deepEqual(await listed(again), [{ ...first, attempts: 1, state: "in_flight" }, second]);
    await again.delete(first.requestId);
    assert.equal(await again.get(first.requestId), undefined);
    await again.close();
    await assert.rejects(again.get(second.requestId), FileJournalUnavailableError);

    const third = await root.open();
    try {
      assert.deepEqual(await listed(third), [second]);
    } finally {
      await third.close();
    }
  });
});

// ── restart recovery (design test 10) ──────────────────────────────────────────────────────

type Fault = "lost-request" | "lost-answer";

/** A host with an identified-write ledger, answering create and outcome as the exchanges do. */
function fakeHost() {
  const capabilities = JSON.parse(JSON.parse(readFileSync(path.join(FIXTURES, "capabilities-200.json"), "utf8")).response.body) as Record<string, unknown>;
  const ledger = new Map<string, { body: string; version: string }>();
  const faults = new Map<string, Fault[]>();
  const sent: { route: string; requestId: string | null; binding: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const name = route.slice(route.lastIndexOf("/") + 1);
    const headers = new Headers(init?.headers);
    const raw = String(init?.body ?? "");
    const requestId = headers.get("x-superbee-write-request");
    const binding = headers.get("x-superbee-checkout");
    sent.push({ route: name, requestId, binding });
    const fault = faults.get(name)?.shift();
    if (fault === "lost-request") throw new TypeError("network lost the request");
    switch (name) {
      case "capabilities":
        return Response.json(capabilities);
      case "create": {
        const input = JSON.parse(raw) as { documentId: string; frontmatter: Record<string, unknown>; body: string };
        const bytes = `---\n${JSON.stringify(input.frontmatter)}\n---\n${input.body}\n`;
        const version = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const result = { ok: true, operationId: "documents.create.v1", data: { bundleId: "notes.a", documentId: input.documentId, version, changed: true } };
        ledger.set(requestId!, { body: raw, version });
        if (fault === "lost-answer") throw new TypeError("network lost the answer");
        return Response.json(result, { headers: { "x-superbee-write-settled": requestId! } });
      }
      case "outcome": {
        const recorded = ledger.get(requestId!);
        if (!recorded) return Response.json({ schemaVersion: 1, requestId, binding, status: "absent" });
        const input = JSON.parse(recorded.body) as { documentId: string; frontmatter: Record<string, unknown>; body: string };
        const bytes = `---\n${JSON.stringify(input.frontmatter)}\n---\n${input.body}\n`;
        return Response.json({
          schemaVersion: 1,
          requestId,
          binding,
          status: "committed",
          result: { ok: true, operationId: "documents.create.v1", data: { bundleId: "notes.a", documentId: input.documentId, version: recorded.version, changed: true } },
          content: { encoding: "base64", version: recorded.version, bytes: Buffer.from(bytes).toString("base64") },
        });
      }
      default:
        return Response.json({ error: "not_found" }, { status: 404 });
    }
  }) as typeof globalThis.fetch;
  return {
    fetch,
    sent,
    ledger,
    fault(route: string, ...queued: Fault[]) {
      faults.set(route, [...(faults.get(route) ?? []), ...queued]);
    },
  };
}

const clientOf = (fetch: typeof globalThis.fetch, journal: HostedClientJournal) =>
  createHostedClient({ target: { origin: "https://hosted.example", syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token"), fetch, intentStore: journal, writeRecovery: { lookupDelayMs: 0 } });

for (const row of [
  { name: "the host applied it and the answer was lost: settling looks it up and sends nothing", fault: "lost-answer" as const, sends: 0 },
  { name: "the host never received it: settling finds it absent and sends it once", fault: "lost-request" as const, sends: 1 },
]) {
  test(`restart: an unknown write survives closing the journal and settles from a new client; ${row.name}`, async () => {
    await withRoot(async (root) => {
      const host = fakeHost();
      host.fault("create", row.fault);
      host.fault("outcome", "lost-request", "lost-request", "lost-request");
      const journal = await root.open();
      const unknown = await clientOf(host.fetch, journal).write("notes.a", { id: "notes/new", document: "---\ntype: Note\n---\nnew", expectAbsent: true });
      assert.equal(unknown.status, "unknown");
      const firstBinding = host.sent.find((sent) => sent.route === "create")!.binding;
      await journal.close();

      // A new process: a new journal handle and a new client, with a binding of its own.
      host.sent.length = 0;
      const reopened = await root.open();
      try {
        const restarted = clientOf(host.fetch, reopened);
        const held = await restarted.heldWrites();
        assert.deepEqual(held.map((write) => [write.requestId, write.state, write.attempts]), [[unknown.requestId, "unknown", 1]]);
        const settled = await restarted.settleWrite(unknown.requestId);
        assert.equal(settled.status, "committed");
        assert.equal(settled.status === "committed" && settled.version, host.ledger.get(unknown.requestId)!.version);
        const creates = host.sent.filter((sent) => sent.route === "create");
        assert.equal(creates.length, row.sends);
        for (const sent of host.sent.filter((s) => s.route === "create" || s.route === "outcome")) {
          assert.equal(sent.requestId, unknown.requestId);
          assert.equal(sent.binding, firstBinding, "the held write is looked up and sent under the binding it was recorded with");
        }
        assert.deepEqual(await restarted.heldWrites(), []);
      } finally {
        await reopened.close();
      }
      const after = await root.open();
      try {
        assert.deepEqual(await listed(after), [], "the settled write left the store durably");
      } finally {
        await after.close();
      }
    });
  });
}

// ── the marker ─────────────────────────────────────────────────────────────────────────────

test("marker: a fresh directory is marked with schema 1, and reopening a marked store keeps it", async () => {
  await withRoot(async (root) => {
    await (await root.open()).close();
    await (await root.open()).close();
    const backend = await root.backend();
    try {
      assert.deepEqual(await backend.listMeta(), [{ key: MARKER, value: { schemaVersion: 1 } }]);
    } finally {
      await backend.close();
    }
  });
});

for (const row of [
  { name: "a non-empty store without the marker", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta("other", 1); } },
  { name: "an unmarked store holding a document", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.write("notes/one", { id: "notes/one", frontmatter: { type: "Note" }, body: "one" }); } },
  { name: "a marked store holding a document", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, { schemaVersion: 1 }); await b.write("notes/one", { id: "notes/one", frontmatter: { type: "Note" }, body: "one" }); } },
  { name: "a marked store holding a checkout's blob-sync map", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, { schemaVersion: 1 }); await b.writeMeta("hosted.blob-sync.v1", { entries: [] }); } },
  { name: "a marked store holding a stored blob", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, { schemaVersion: 1 }); await b.writeBlob("a.bin", new Uint8Array([1])); } },
  { name: "a marked store holding a root index", code: "JOURNAL_NOT_HOSTED_CLIENT" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, { schemaVersion: 1 }); await b.writeReserved("", "index.md", "# root\n"); } },
  { name: "a marker of an unknown schema", code: "JOURNAL_SCHEMA_UNSUPPORTED" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, { schemaVersion: 2 }); } },
  { name: "a marker that is not a record", code: "JOURNAL_SCHEMA_UNSUPPORTED" as const, seed: async (b: FileJournaledBackend) => { await b.writeMeta(MARKER, "v1"); } },
]) {
  test(`marker: ${row.name} is refused as ${row.code}, changes nothing, and releases the lock`, async () => {
    await withRoot(async (root) => {
      const backend = await root.backend();
      await row.seed(backend);
      await backend.close();
      const before = await fs.readFile(logFile(root));
      await assert.rejects(root.open(), (error: unknown) => {
        assert.ok(error instanceof HostedClientJournalError);
        assert.equal(error.code, row.code);
        assert.equal(error.directory, root.directory);
        if (row.code === "JOURNAL_SCHEMA_UNSUPPORTED") assert.ok("schemaVersion" in error);
        return true;
      });
      assert.deepEqual(await fs.readFile(logFile(root)), before);
      // The refused open released the lock: a second attempt meets the same refusal, not a held lock.
      await assert.rejects(root.open(), refusedAs(row.code));
    });
  });
}

test("marker: a crash between the empty check and the marker write leaves a store the next open marks", async () => {
  // The marker's append fails and is removed: open rejects with the store's error, and the store stays empty.
  await withRoot(async (root) => {
    await assert.rejects(root.open(faultySeam({ failSync: true, armed: true })), /injected fsync failure/);
    assert.equal(await sizeOf(logFile(root)), 0);
    const journal = await root.open();
    await journal.put(intent());
    await journal.close();
    const backend = await root.backend();
    try {
      assert.deepEqual(await backend.readMeta(MARKER), { schemaVersion: 1 });
    } finally {
      await backend.close();
    }
  });
  // Half the marker reached the disk and could not be removed: the next open truncates the torn tail and marks.
  await withRoot(async (root) => {
    await assert.rejects(root.open(faultySeam({ failWrite: "partial", failTruncate: true, armed: true })), /injected write failure/);
    assert.ok((await sizeOf(logFile(root))) > 0, "a torn marker record is on disk");
    const journal = await root.open();
    await journal.close();
    const backend = await root.backend();
    try {
      assert.deepEqual(await backend.listMeta(), [{ key: MARKER, value: { schemaVersion: 1 } }]);
    } finally {
      await backend.close();
    }
  });
  // The process died after the directory and the empty log were created, before any record.
  await withRoot(async (root) => {
    await fs.mkdir(root.directory, { mode: 0o700 });
    await fs.writeFile(logFile(root), "", { mode: 0o600 });
    const journal = await root.open();
    await journal.close();
    const backend = await root.backend();
    try {
      assert.deepEqual(await backend.readMeta(MARKER), { schemaVersion: 1 });
    } finally {
      await backend.close();
    }
  });
});

// ── privacy ────────────────────────────────────────────────────────────────────────────────

test("permissions: a created directory is 0700 and its files 0600", { skip: !POSIX }, async () => {
  await withRoot(async (root) => {
    const journal = await root.open();
    await journal.put(intent());
    await journal.close();
    // Compaction writes the snapshot; it is private too.
    const backend = await root.backend();
    await backend.compact();
    await backend.close();
    assert.equal((await fs.stat(root.directory)).mode & 0o777, 0o700);
    const names = await fs.readdir(root.directory);
    assert.ok(names.includes(FILE_JOURNAL_LOG) && names.includes(FILE_JOURNAL_SNAPSHOT));
    for (const name of names) assert.equal((await fs.stat(path.join(root.directory, name))).mode & 0o777, 0o600, name);
  });
});

for (const mode of [0o755, 0o750, 0o701]) {
  test(`permissions: an existing directory of mode ${mode.toString(8)} is refused and left as it was`, { skip: !POSIX }, async () => {
    await withRoot(async (root) => {
      await fs.mkdir(root.directory);
      await fs.chmod(root.directory, mode);
      await assert.rejects(root.open(), refusedAs("JOURNAL_DIRECTORY_NOT_PRIVATE"));
      assert.deepEqual(await fs.readdir(root.directory), []);
      assert.equal((await fs.stat(root.directory)).mode & 0o777, mode);
    });
  });
}

test("permissions: a symbolic link to a private directory is refused", { skip: !POSIX }, async () => {
  await withRoot(async (root) => {
    const real = path.join(root.base, "real");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, root.directory);
    await assert.rejects(root.open(), refusedAs("JOURNAL_DIRECTORY_NOT_PRIVATE"));
    assert.deepEqual(await fs.readdir(real), []);
  });
});

test("options: a missing directory and a malformed wait are TypeErrors; the public opener takes the same shape", async () => {
  await assert.rejects(openHostedClientJournal({ directory: "" }), TypeError);
  await assert.rejects(openHostedClientJournal({ directory: "x", lock: { waitMs: -1 } }), TypeError);
});

// ── the lock (design test 7) ───────────────────────────────────────────────────────────────

test("lock: a second process's open is refused within waitMs, and a SIGKILLed holder's lock is reclaimed", { timeout: 60_000 }, async () => {
  await withRoot(async (root) => {
    const held = intent({ state: "unknown", attempts: 1 });
    const child = fork(path.join(HERE, "fixtures", "hosted-client-journal-child.ts"), [root.directory, root.lockRoot, held.requestId], {
      execArgv: ["--import", path.join(HERE, "ts-loader.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.on("message", (message: { type: string }) => message.type === "open" && resolve());
        child.on("exit", () => reject(new Error(`child exited early: ${stderr}`)));
      });
      const waitMs = 300;
      const started = Date.now();
      await assert.rejects(root.open({}, waitMs), FilesystemMutationLockError);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= waitMs - 50 && elapsed < waitMs + 5_000, `refused after ${elapsed} ms`);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    const journal = await root.open({}, 2_000);
    try {
      assert.deepEqual((await listed(journal)).map((row) => row.requestId), [held.requestId]);
    } finally {
      await journal.close();
    }
  });
});

// ── torn tails and corruption (design test 8) ──────────────────────────────────────────────

/** A marked journal with one held write, its log bytes, and the bytes of one more put's record. */
async function logWithOneMore(root: Root) {
  const kept = intent();
  const journal = await root.open();
  await journal.put(kept);
  await journal.close();
  const prefix = await fs.readFile(logFile(root));
  const again = await root.open();
  await again.put(intent());
  await again.close();
  const record = (await fs.readFile(logFile(root))).subarray(prefix.byteLength);
  return { kept, prefix, record };
}

test("corruption: a torn tail is truncated at open and the journal continues from the last whole record", async () => {
  await withRoot(async (root) => {
    const { kept, prefix, record } = await logWithOneMore(root);
    await fs.writeFile(logFile(root), Buffer.concat([prefix, record.subarray(0, record.byteLength - 5)]));
    const journal = await root.open();
    try {
      assert.deepEqual(await fs.readFile(logFile(root)), prefix);
      assert.deepEqual(await listed(journal), [kept]);
    } finally {
      await journal.close();
    }
  });
});

test("corruption: a damaged record before the log's end refuses the open, typed, with the bytes unchanged", async () => {
  await withRoot(async (root) => {
    const { prefix, record } = await logWithOneMore(root);
    const damaged = Buffer.concat([prefix, record]);
    damaged[60]! ^= 0xff; // inside the marker record's payload
    await fs.writeFile(logFile(root), damaged);
    await assert.rejects(root.open(), FileJournalCorruptError);
    assert.deepEqual(await fs.readFile(logFile(root)), damaged);
    await assert.rejects(root.open(), FileJournalCorruptError);
  });
});

test("corruption: a whole record in a newer store format is FileJournalFormatError, with the bytes unchanged", async () => {
  await withRoot(async (root) => {
    const { prefix, record } = await logWithOneMore(root);
    const newer = Buffer.concat([prefix, record]);
    newer.writeUInt32BE(99, 4); // the first record's format field, outside its payload checksum
    await fs.writeFile(logFile(root), newer);
    await assert.rejects(root.open(), (error: unknown) => error instanceof FileJournalFormatError && error.format === 99);
    assert.deepEqual(await fs.readFile(logFile(root)), newer);
  });
});

// ── retention ──────────────────────────────────────────────────────────────────────────────

test("compaction: many put and delete cycles keep the log under the floor plus one cycle's records", { timeout: 120_000 }, async () => {
  await withRoot(async (root) => {
    const journal = await root.open();
    try {
      const body = "x".repeat(32 * 1024);
      const cycles = 120;
      let largestCycle = 0;
      let peak = 0;
      for (let index = 0; index < cycles; index++) {
        const write = intent({ document: `---\ntype: Note\n---\n${body}${index}` });
        const before = await sizeOf(logFile(root));
        await journal.put(write);
        await journal.put({ ...write, attempts: 1, state: "in_flight" });
        await journal.delete(write.requestId);
        const after = await sizeOf(logFile(root));
        if (after > before) largestCycle = Math.max(largestCycle, after - before);
        peak = Math.max(peak, after);
      }
      // Without runtime compaction the log would hold every record: about 3 × 32 KiB per cycle.
      assert.ok(largestCycle * cycles > 4 * HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES, "the run writes well past the floor");
      assert.ok(peak <= HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES + largestCycle, `log peaked at ${peak} bytes`);
      // The last compaction ran after some mutation of a cycle, so the snapshot holds at most that one live write.
      assert.ok((await sizeOf(snapshotFile(root))) < 2 * body.length, "the snapshot holds only the live state");
      assert.deepEqual(await listed(journal), []);
    } finally {
      await journal.close();
    }
    const again = await root.open();
    try {
      assert.deepEqual(await listed(again), []);
    } finally {
      await again.close();
    }
  });
});
