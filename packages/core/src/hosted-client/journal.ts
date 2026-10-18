/**
 * The hosted client's durable intent store: a {@link HostedIntentStore} over a private
 * `FileJournaledBackend` directory, so a process that exits with a write `unknown` finds it again
 * (`heldWrites`) and settles it (`settleWrite`) after a restart. Node only; reached through
 * `@superbee/core/hosted-client/node`.
 *
 * The directory holds the backend's own log and snapshot, in its supported on-disk format. Each
 * held document write is one meta row, `hosted-client.write.<requestId>`, and a marker row,
 * `hosted-client.journal = { schemaVersion: 1 }`, names the directory as this store. The store's
 * document, reserved-file and blob families stay empty: open refuses a directory holding any of
 * them, so a CLI checkout store is never adopted.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  FILE_JOURNAL_LOG,
  FILE_JOURNAL_SNAPSHOT,
  FileJournaledBackend,
  type FileJournaledBackendOptions,
} from "../file-journaled-backend.js";
import type { HostedIntentStore, HostedWriteIntent } from "./write.js";
import { captureJournalValue, JournalGuardConflict } from "../journaled-backend.js";

/** The marker row's key. */
export const HOSTED_CLIENT_JOURNAL_MARKER = "hosted-client.journal";
/** The schema this version of the client writes and reads. */
export const HOSTED_CLIENT_JOURNAL_SCHEMA_VERSION = 1;
/** The prefix of every held document write's meta row; the request identity follows it. */
export const HOSTED_CLIENT_WRITE_PREFIX = "hosted-client.write.";
/** How many times `delete` reads a row again after a concurrent put to it, before refusing. */
const DELETE_ATTEMPTS = 8;
/** The CLI's blob-sync map: a store holding it is a checkout store. */
const CHECKOUT_BLOB_SYNC_KEY = "hosted.blob-sync.v1";

/**
 * The log is compacted into the snapshot once it is larger than the greater of this floor and
 * twice the last snapshot, checked after every mutation. Settled writes leave the live state, so
 * a steady stream of writes keeps the log under about this floor plus one record, and the work
 * stays linear when unsettled writes hold the snapshot large.
 */
export const HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES = 1024 * 1024;

export type HostedClientJournalProblem =
  /** The directory is a symbolic link, or (on POSIX) grants its group or others any permission. */
  | "JOURNAL_DIRECTORY_NOT_PRIVATE"
  /** The directory holds a store this client did not create: documents, blobs, a checkout's state, or unmarked rows. */
  | "JOURNAL_NOT_HOSTED_CLIENT"
  /** The marker names a schema this version does not read (a newer client wrote it). */
  | "JOURNAL_SCHEMA_UNSUPPORTED";

/** Open refused the directory; nothing in it was changed. */
export class HostedClientJournalError extends Error {
  override readonly name = "HostedClientJournalError";
  readonly code: HostedClientJournalProblem;
  readonly directory: string;
  /** With `JOURNAL_SCHEMA_UNSUPPORTED`: the marker's `schemaVersion`, as found. */
  readonly schemaVersion?: unknown;
  constructor(code: HostedClientJournalProblem, directory: string, message: string, options: { schemaVersion?: unknown } = {}) {
    super(message);
    this.code = code;
    this.directory = directory;
    if ("schemaVersion" in options) this.schemaVersion = options.schemaVersion;
  }
}

/** True when `error` is a {@link HostedClientJournalError}, with `code` when one is named. */
export function isHostedClientJournalError(error: unknown, code?: HostedClientJournalProblem): error is HostedClientJournalError {
  return error instanceof HostedClientJournalError && (code === undefined || error.code === code);
}

export interface HostedClientJournalOptions {
  /**
   * The journal's directory, on a local file system. Created (mode 0700) when absent; an existing
   * one must be a real directory with no group or other permission bits.
   */
  readonly directory: string;
  /** How long open waits for another process holding the directory (default 5,000 ms), then fails. */
  readonly lock?: { readonly waitMs?: number };
}

/**
 * A durable {@link HostedIntentStore}: pass it as `createHostedClient({ intentStore })`. It holds
 * the directory's exclusive lock until {@link close}; every call after close rejects.
 */
export interface HostedClientJournal extends HostedIntentStore {
  /** The journal's directory, resolved. */
  readonly directory: string;
  put(intent: HostedWriteIntent): Promise<void>;
  get(requestId: string): Promise<HostedWriteIntent | undefined>;
  delete(requestId: string): Promise<void>;
  /** Every held write, oldest first (by `createdAt`, then request identity). */
  list(): AsyncIterable<HostedWriteIntent>;
  /** Let pending calls finish, then release the directory. */
  close(): Promise<void>;
}

/**
 * Open (or create) the hosted client's durable intent store in `directory`.
 *
 * Refusals change no file in an existing directory:
 * - {@link HostedClientJournalError} — the directory is not private (a symbolic link, another
 *   owner, group or other permission bits), holds files but no store, is not this client's
 *   store, or names a newer schema;
 * - `FilesystemMutationLockError` — another process holds the directory past `lock.waitMs`;
 * - `FileJournalCorruptError` / `FileJournalFormatError` — the log or snapshot is damaged or in a
 *   newer format. Nothing is repaired: moving the directory aside loses the writes it holds.
 *
 * The decision is made on a read-only open, which changes nothing, and made again under the
 * writable open's lock before the marker is written. Only when the directory changes between the
 * two (another process replacing it) can the writable open, before refusing, have truncated a
 * torn log tail or created an empty log.
 */
export function openHostedClientJournal(options: HostedClientJournalOptions): Promise<HostedClientJournal> {
  return openHostedClientJournalWith(options);
}

/** @internal What the store's own tests vary: the lock namespace and the backend's opener (its fault seam). */
export interface JournalTestSeam {
  readonly lockRoot?: string;
  readonly openBackend?: (options: FileJournaledBackendOptions) => Promise<FileJournaledBackend>;
}

/** The files a `FileJournaledBackend` keeps in its directory. */
const STORE_FILES = new Set([FILE_JOURNAL_LOG, FILE_JOURNAL_SNAPSHOT, "store.snapshot.tmp"]);

/** @internal {@link openHostedClientJournal} with its test seam. Not in the package's exports. */
export async function openHostedClientJournalWith(options: HostedClientJournalOptions, seam: JournalTestSeam = {}): Promise<HostedClientJournal> {
  if (!options || typeof options.directory !== "string" || options.directory.trim() === "") throw new TypeError("a hosted client journal names its directory");
  const waitMs = options.lock?.waitMs;
  if (waitMs !== undefined && !(typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs >= 0)) throw new TypeError("lock.waitMs is a finite number of milliseconds, 0 or more");
  const directory = path.resolve(options.directory);
  const open = seam.openBackend ?? ((backendOptions) => FileJournaledBackend.open(backendOptions));
  const backendOptions = (readOnly: boolean): FileJournaledBackendOptions => ({
    directory,
    // Never compact before the store is adopted: a refused store keeps its files as they were.
    compactAfterBytes: Number.POSITIVE_INFINITY,
    lock: { ...(waitMs !== undefined ? { waitMs } : {}), ...(seam.lockRoot !== undefined ? { lockRoot: seam.lockRoot } : {}) },
    ...(readOnly ? { readOnly } : {}),
  });

  const existing = await privateDirectory(directory, { mayBeAbsent: true });
  if (existing) {
    const names = await fs.readdir(directory);
    if (names.length > 0 && !names.some((name) => STORE_FILES.has(name))) {
      throw new HostedClientJournalError("JOURNAL_NOT_HOSTED_CLIENT", directory, `'${directory}' holds files but no store; a hosted client journal is an empty or journal-only directory`);
    }
    // Decide on a read-only open first, which changes no file.
    const inspected = await open(backendOptions(true));
    try {
      await inspect(inspected, directory);
    } finally {
      await inspected.close();
    }
  }

  const backend = await open(backendOptions(false));
  try {
    // The lock is held from here: the directory must still be the private one checked above.
    const held = await privateDirectory(directory, { mayBeAbsent: false });
    if (existing && (held!.ino !== existing.ino || held!.dev !== existing.dev)) {
      throw new HostedClientJournalError("JOURNAL_DIRECTORY_NOT_PRIVATE", directory, `'${directory}' was replaced while the journal opened`);
    }
    if ((await inspect(backend, directory)) === "empty") {
      await backend.writeMeta(HOSTED_CLIENT_JOURNAL_MARKER, { schemaVersion: HOSTED_CLIENT_JOURNAL_SCHEMA_VERSION }, { expected: { present: false }, requireEmptyJournal: true });
    }
    const journal = new FileHostedClientJournal(backend, await fileSize(path.join(directory, FILE_JOURNAL_SNAPSHOT)));
    await journal.compactIfDue();
    return journal;
  } catch (error) {
    await backend.close().catch(() => {});
    throw error;
  }
}

/**
 * The directory's identity when it is a real directory private to this user, or undefined when
 * it is absent and may be (the backend then creates it 0700). Windows has no POSIX mode bits or
 * uids; its ACLs are the distribution's to check.
 */
async function privateDirectory(directory: string, options: { mayBeAbsent: boolean }): Promise<{ dev: number; ino: number } | undefined> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.mayBeAbsent) return undefined;
    throw error;
  }
  const refuse = (why: string) => new HostedClientJournalError("JOURNAL_DIRECTORY_NOT_PRIVATE", directory, `'${directory}' ${why}; a hosted client journal is a real directory of mode 0700 owned by this user`);
  if (stat.isSymbolicLink()) throw refuse("is a symbolic link");
  if (!stat.isDirectory()) throw refuse("is not a directory");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw refuse(`is owned by uid ${stat.uid}`);
    if ((stat.mode & 0o077) !== 0) throw refuse(`grants its group or others access (mode ${(stat.mode & 0o777).toString(8)})`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

/**
 * Whether the open store is this client's: `marked` (a marker of a known schema, none of a
 * checkout's state) or `empty` (nothing at all, to be marked). Anything else is refused.
 *
 * The caller marks an empty store with `writeMeta(expected: absent, requireEmptyJournal)`. That
 * write re-checks only the marker and the intents family; what makes the whole empty check hold
 * is the directory's exclusive lock, held from this check through that write, with no other
 * caller of the backend in between. A crash between the two leaves either nothing or a torn
 * marker record, which open truncates, so the next open finds the store empty and marks it.
 */
async function inspect(backend: FileJournaledBackend, directory: string): Promise<"marked" | "empty"> {
  const meta = await backend.listMeta();
  const foreign =
    (await backend.list()).length > 0 ||
    (await backend.listBlobs()).length > 0 ||
    (await backend.readReserved("", "index.md")) !== null ||
    (await backend.readReserved("", "log.md")) !== null ||
    (await backend.listIntents()).length > 0 ||
    meta.some((row) => row.key === CHECKOUT_BLOB_SYNC_KEY);
  if (foreign) throw new HostedClientJournalError("JOURNAL_NOT_HOSTED_CLIENT", directory, `'${directory}' holds documents or a checkout's state; it is not a hosted client journal`);
  const marker = meta.find((row) => row.key === HOSTED_CLIENT_JOURNAL_MARKER);
  if (marker) {
    const schemaVersion = typeof marker.value === "object" && marker.value !== null ? (marker.value as { schemaVersion?: unknown }).schemaVersion : undefined;
    if (schemaVersion !== HOSTED_CLIENT_JOURNAL_SCHEMA_VERSION) {
      throw new HostedClientJournalError("JOURNAL_SCHEMA_UNSUPPORTED", directory, `'${directory}' is a hosted client journal of schema ${String(schemaVersion)}; this version reads schema ${HOSTED_CLIENT_JOURNAL_SCHEMA_VERSION}`, { schemaVersion });
    }
    return "marked";
  }
  if (meta.length > 0 || (await backend.listBlobIntents()).length > 0) {
    throw new HostedClientJournalError("JOURNAL_NOT_HOSTED_CLIENT", directory, `'${directory}' holds a store with no hosted client journal marker`);
  }
  return "empty";
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function keyOf(requestId: unknown): string {
  if (typeof requestId !== "string" || requestId === "") throw new TypeError("a held write names its request identity");
  return `${HOSTED_CLIENT_WRITE_PREFIX}${requestId}`;
}

class FileHostedClientJournal implements HostedClientJournal {
  readonly directory: string;
  readonly #backend: FileJournaledBackend;
  #snapshotBytes: number;
  #compacting: Promise<void> | null = null;

  constructor(backend: FileJournaledBackend, snapshotBytes: number) {
    this.#backend = backend;
    this.directory = backend.directory;
    this.#snapshotBytes = snapshotBytes;
  }

  async put(intent: HostedWriteIntent): Promise<void> {
    if (typeof intent !== "object" || intent === null) throw new TypeError("a held write is a record");
    const key = keyOf(intent.requestId);
    let record: HostedWriteIntent;
    try {
      // Only plain data is held, so the row can later be removed compare-and-swap against itself.
      record = captureJournalValue({ ...intent });
    } catch (cause) {
      throw new TypeError("a held write holds only strings, numbers, booleans, null and plain records", { cause });
    }
    await this.#backend.writeMeta(key, record);
    await this.compactIfDue();
  }

  async get(requestId: string): Promise<HostedWriteIntent | undefined> {
    const value = await this.#backend.readMeta<HostedWriteIntent>(keyOf(requestId));
    return value === undefined ? undefined : Object.freeze(value);
  }

  async delete(requestId: string): Promise<void> {
    const key = keyOf(requestId);
    // Compare-and-swap against the row as read. A put to this key landing in between is read
    // again, a bounded number of times; any other refusal is the caller's.
    for (let attempt = 1; ; attempt++) {
      const current = await this.#backend.readMeta(key);
      if (current === undefined) return;
      try {
        await this.#backend.removeMeta(key, { expected: { present: true, value: current } });
        break;
      } catch (error) {
        if (!(error instanceof JournalGuardConflict) || error.target !== key || attempt >= DELETE_ATTEMPTS) throw error;
      }
    }
    await this.compactIfDue();
  }

  async *list(): AsyncIterable<HostedWriteIntent> {
    const rows = await this.#backend.listMeta<HostedWriteIntent>(HOSTED_CLIENT_WRITE_PREFIX);
    const intents = rows.map((row) => row.value);
    intents.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
    for (const intent of intents) yield Object.freeze(intent);
  }

  close(): Promise<void> {
    return this.#backend.close();
  }

  /**
   * Compact when the log has outgrown the live state (see
   * {@link HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES}). The mutation before it is already durable,
   * so a failed compaction only leaves the log longer: it is not the caller's failure, and the
   * next mutation tries again.
   */
  async compactIfDue(): Promise<void> {
    if (this.#compacting) return;
    this.#compacting = (async () => {
      try {
        const logBytes = await fileSize(path.join(this.directory, FILE_JOURNAL_LOG));
        if (logBytes <= Math.max(HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES, 2 * this.#snapshotBytes)) return;
        await this.#backend.compact();
        this.#snapshotBytes = await fileSize(path.join(this.directory, FILE_JOURNAL_SNAPSHOT));
      } catch {
        // Durable already; see above.
      } finally {
        this.#compacting = null;
      }
    })();
    await this.#compacting;
  }
}
