/**
 * Experimental (`0.2.0-pre`): the API and the on-disk format may change before a stable release.
 *
 * A Node {@link JournaledBackend}: the private store behind a CLI working copy, proven by the
 * same contract kit as the IndexedDB adapter. It is an append-only, checksummed transaction log
 * over an in-memory index, in one directory the store owns:
 *
 * - `store.log` holds one record per transaction. A record is the transaction's effect as a list
 *   of absolute puts and removals over the five record families (documents, reserved files,
 *   blobs, intents, meta) plus the intent sequence, framed as magic, format version, length,
 *   SHA-256 of the payload, payload. The payload is tagged JSON this module owns, so the bytes
 *   never depend on the Node version that wrote them. Every check a verb makes runs synchronously against the index before its
 *   record is written; the record is written at the log's end and fsynced, and only then applied
 *   to the index and the verb resolved. So a resolved write survives a crash, a rejected one
 *   left nothing behind, and a record that was never fsynced was never acknowledged.
 * - `store.snapshot` is the whole index at one transaction number, written by {@link compact}:
 *   write a temporary file, fsync it, rename it over the snapshot, fsync the directory, then
 *   truncate the log. A crash at any point in that sequence leaves either the old snapshot and
 *   the whole log, or the new snapshot and log records it already covers, which open skips by
 *   transaction number.
 *
 * At open the snapshot is loaded and the log replayed. Bytes after the last whole record are a
 * torn write (the one append that can be interrupted, never acknowledged, its pages persisted in
 * any order) and are truncated away, unless a whole record begins inside them: that is
 * corruption, and open refuses without touching the files. One transaction spans documents, intents and meta, which is what the seam requires:
 * the engine settles an intent together with the global pause flag, and writes a receipt, a
 * base and a body record at once.
 *
 * The store holds an exclusive same-user cross-process lock on its directory from open to
 * {@link close}, so a second process cannot replay a log another process is appending to, and
 * compaction always runs under that lock. Within the process, mutations are serialized; reads
 * never wait for them and always see the last committed transaction.
 *
 * Durability is `fsync`: a resolved mutation's record was fsynced, and so was the directory
 * entry of every file the store created. On macOS `fsync` does not force the drive's own cache
 * (Node exposes no `F_FULLFSYNC`), which is the same promise every Node program gets there.
 */

import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

import { resolveContentType } from "./content-type.js";
import { OPEN_LOG, STORE_RAW, type FileJournalHandle } from "./file-journaled-backend-internal.js";
import { captureFilesystemHostPolicy, type FilesystemHostPolicy } from "./filesystem-host.js";
import { acquireFilesystemMutationLock, type FilesystemMutationLockOptions } from "./filesystem-lock.js";
import { MalformedDocumentError, parseMarkdown, stringifyDoc } from "./frontmatter.js";
import {
  assertDeletionIntent,
  assertJournalGuard,
  assertJournalIntentChanges,
  assertJournalMetaChanges,
  assertJournalResolutionOptions,
  assertJournalSnapshot,
  assertMetaWrite,
  captureIntentUpdate,
  captureJournalDeleteOptions,
  captureJournalGuardOption,
  captureJournalValue,
  captureJournalWriteOptions,
  captureMetaWrite,
  deletionIntentRecord,
  IntentHoldConflict,
  IntentStateConflict,
  JournalGuardConflict,
  JournalSnapshotConflict,
  type IntentPatch,
  type IntentRecord,
  type IntentUpdateOptions,
  type JournalGuard,
  type JournaledBackend,
  type JournaledDeleteOptions,
  type JournaledDeleteResult,
  type JournaledHead,
  type JournaledHeadsOptions,
  type JournaledReadResult,
  type JournaledWriteOptions,
  type MetaRecord,
  type MetaWriteOptions,
} from "./journaled-backend.js";
import { mutationActorFromFrontmatter } from "./mutation-attribution.js";
import { assertSafeBlobKey, assertSafeConceptId, assertSafeReservedDir, assertSafeReservedFilename, compareStorageKeys, pathFromConceptId } from "./paths.js";
import { parseLeadingFrontmatter } from "./portable-frontmatter.js";
import { sha256HexOfBytes } from "./sha256.js";
import type { OperationState } from "./uncertain-write.js";
import { blobVersion, defaultActor, VersionConflict, versionOfBytes } from "./versioning.js";
import type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  Frontmatter,
  OkfDocument,
  ReadBlobResult,
  ReadResult,
  ReservedFilename,
  ReservedReadResult,
  StorageCapabilities,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

// ── on-disk format ─────────────────────────────────────────────────────────────────────────

/** Bumping this requires a reader for the older layout; open refuses any other format. */
export const FILE_JOURNAL_FORMAT_VERSION = 1;

export const FILE_JOURNAL_LOG = "store.log";
export const FILE_JOURNAL_SNAPSHOT = "store.snapshot";
const SNAPSHOT_TEMP = "store.snapshot.tmp";

const RECORD_MAGIC = 0x53424a52; // "SBJR"
const RECORD_MAGIC_BYTES = Buffer.from([0x53, 0x42, 0x4a, 0x52]);
const SNAPSHOT_MAGIC = 0x53424a53; // "SBJS"
/** Every record and the snapshot: magic (4) + format version (4) + payload length (4) + SHA-256 of the payload (32). */
const HEADER = 44;
/** A record larger than this is refused at write and read as corruption at open. */
const MAXIMUM_RECORD_BYTES = 256 * 1024 * 1024;
const DEFAULT_COMPACT_AFTER_BYTES = 8 * 1024 * 1024;

interface DocumentRecord {
  /** The exact OKF-serialized document; `version` is `versionOfBytes(raw)`. */
  raw: string;
  version: Version;
  updatedBy: string;
  updatedAt: string;
}

interface ReservedRecord {
  content: string;
  version: Version;
}

interface BlobRecord {
  bytes: Uint8Array;
  contentType: string;
  version: Version;
}

/** One absolute change; replaying a record's changes over any earlier state yields its result. */
type Change =
  | { family: "document"; key: string; value: DocumentRecord | null }
  | { family: "reserved"; key: string; value: ReservedRecord | null }
  | { family: "blob"; key: string; value: BlobRecord | null }
  | { family: "intent"; key: string; value: IntentRecord | null }
  | { family: "meta"; key: string; present: boolean; value?: unknown }
  | { family: "sequence"; value: number };

interface LogRecord {
  txn: number;
  changes: Change[];
}

interface SnapshotPayload {
  format: number;
  txn: number;
  sequence: number;
  documents: [string, DocumentRecord][];
  reserved: [string, ReservedRecord][];
  blobs: [string, BlobRecord][];
  intents: [string, IntentRecord][];
  meta: [string, unknown][];
}

interface State {
  documents: Map<ConceptId, DocumentRecord>;
  reserved: Map<string, ReservedRecord>;
  blobs: Map<BlobKey, BlobRecord>;
  intents: Map<string, IntentRecord>;
  meta: Map<string, unknown>;
  sequence: number;
}

function emptyState(): State {
  return { documents: new Map(), reserved: new Map(), blobs: new Map(), intents: new Map(), meta: new Map(), sequence: 0 };
}

function applyChanges(state: State, changes: readonly Change[]): void {
  for (const change of changes) {
    switch (change.family) {
      case "document":
        if (change.value) state.documents.set(change.key, change.value);
        else state.documents.delete(change.key);
        break;
      case "reserved":
        if (change.value) state.reserved.set(change.key, change.value);
        else state.reserved.delete(change.key);
        break;
      case "blob":
        if (change.value) state.blobs.set(change.key, change.value);
        else state.blobs.delete(change.key);
        break;
      case "intent":
        if (change.value) state.intents.set(change.key, change.value);
        else state.intents.delete(change.key);
        break;
      case "meta":
        if (change.present) state.meta.set(change.key, change.value);
        else state.meta.delete(change.key);
        break;
      case "sequence":
        state.sequence = change.value;
        break;
    }
  }
}

/** The store's files do not hold a log or snapshot this adapter wrote; open changes nothing. */
export class FileJournalCorruptError extends Error {
  override readonly name: string = "FileJournalCorruptError";
  readonly file: string;
  readonly offset: number | undefined;
  constructor(file: string, message: string, offset?: number) {
    super(`${file}${offset === undefined ? "" : ` at byte ${offset}`}: ${message}`);
    this.file = file;
    this.offset = offset;
  }
}

/** A whole, checksummed record or snapshot in a format this adapter does not read (a newer store wrote it). */
export class FileJournalFormatError extends FileJournalCorruptError {
  override readonly name = "FileJournalFormatError";
  readonly format: number;
  constructor(file: string, format: number, offset?: number) {
    super(file, `written in store format ${format}; this adapter reads only format ${FILE_JOURNAL_FORMAT_VERSION}`, offset);
    this.format = format;
  }
}

/**
 * The store cannot tell whether its last append reached the disk (the append failed and so did
 * removing it), or it was closed. Every later call rejects; reopening decides from the files.
 */
export class FileJournalUnavailableError extends Error {
  override readonly name = "FileJournalUnavailableError";
}

// ── the payload codec ──────────────────────────────────────────────────────────────────────
//
// Payloads are UTF-8 JSON in a tagged form that carries what the journal seam's opaque meta
// rows may hold (the structured-clone values: undefined, special numbers, bigint, Date, Map,
// Set, RegExp, typed arrays), so the bytes on disk depend on this module alone and never on the
// Node or V8 version that wrote them. A JSON string, boolean, null or finite number stands for
// itself; every other value is an array whose first element is its tag.

const TYPED_ARRAYS = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;

/** A value the codec cannot persist; the mutation carrying it is refused before anything is written. */
export class FileJournalValueError extends TypeError {
  override readonly name = "FileJournalValueError";
}

const bytesOf = (view: ArrayBufferView): string => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");

function encodeValue(value: unknown, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "undefined":
      return ["U"];
    case "bigint":
      return ["I", value.toString()];
    case "number":
      if (Number.isNaN(value)) return ["N", "NaN"];
      if (value === Infinity) return ["N", "Infinity"];
      if (value === -Infinity) return ["N", "-Infinity"];
      if (Object.is(value, -0)) return ["N", "-0"];
      return value;
    case "object":
      break;
    default:
      throw new FileJournalValueError(`a ${typeof value} cannot be stored`);
  }
  if (value === null) return null;
  if (ancestors.has(value)) throw new FileJournalValueError("a cyclic value cannot be stored");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = ["A"];
      for (let index = 0; index < value.length; index++) out.push(index in value ? encodeValue(value[index], ancestors) : ["H"]);
      return out;
    }
    if (value instanceof Date) return ["D", encodeValue(value.getTime(), ancestors)];
    if (value instanceof Map) return ["M", ...[...value].flatMap(([key, entry]) => [encodeValue(key, ancestors), encodeValue(entry, ancestors)])];
    if (value instanceof Set) return ["S", ...[...value].map((entry) => encodeValue(entry, ancestors))];
    if (value instanceof RegExp) throw new FileJournalValueError("a regular expression cannot be stored");
    if (value instanceof ArrayBuffer) return ["B", bytesOf(new Uint8Array(value))];
    if (value instanceof DataView) return ["V", bytesOf(value)];
    if (ArrayBuffer.isView(value)) {
      const name = (Object.keys(TYPED_ARRAYS) as TypedArrayName[]).find((candidate) => value instanceof TYPED_ARRAYS[candidate]);
      if (!name) throw new FileJournalValueError("an unsupported typed array cannot be stored");
      return ["T", name, bytesOf(value)];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new FileJournalValueError("only plain objects and structured-clone built-ins can be stored");
    const out: unknown[] = ["O"];
    for (const [key, entry] of Object.entries(value)) out.push(key, encodeValue(entry, ancestors));
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** A typed array of a fixed, named kind over `buffer`; any other name is not a value this store wrote. */
function typedArray(name: unknown, buffer: ArrayBuffer): ArrayBufferView {
  switch (name) {
    case "Int8Array": return new Int8Array(buffer);
    case "Uint8Array": return new Uint8Array(buffer);
    case "Uint8ClampedArray": return new Uint8ClampedArray(buffer);
    case "Int16Array": return new Int16Array(buffer);
    case "Uint16Array": return new Uint16Array(buffer);
    case "Int32Array": return new Int32Array(buffer);
    case "Uint32Array": return new Uint32Array(buffer);
    case "Float32Array": return new Float32Array(buffer);
    case "Float64Array": return new Float64Array(buffer);
    case "BigInt64Array": return new BigInt64Array(buffer);
    case "BigUint64Array": return new BigUint64Array(buffer);
    default: throw new TypeError("unknown typed array");
  }
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new TypeError("untagged value");
  const [tag, ...rest] = value as [string, ...unknown[]];
  const bytes = (text: unknown) => {
    if (typeof text !== "string") throw new TypeError("bytes are not base64");
    return Buffer.from(text, "base64");
  };
  switch (tag) {
    case "U":
      return undefined;
    case "I":
      return BigInt(rest[0] as string);
    case "N":
      return ({ NaN, Infinity, "-Infinity": -Infinity, "-0": -0 } as Record<string, number>)[rest[0] as string] ?? (() => { throw new TypeError("unknown number"); })();
    case "A": {
      const out: unknown[] = new Array(rest.length);
      rest.forEach((entry, index) => {
        if (!(Array.isArray(entry) && entry.length === 1 && entry[0] === "H")) out[index] = decodeValue(entry);
      });
      return out;
    }
    case "D":
      return new Date(decodeValue(rest[0]) as number);
    case "M": {
      const out = new Map();
      for (let index = 0; index < rest.length; index += 2) out.set(decodeValue(rest[index]), decodeValue(rest[index + 1]));
      return out;
    }
    case "S":
      return new Set(rest.map(decodeValue));
    case "B": {
      const source = bytes(rest[0]);
      return new Uint8Array(source).buffer;
    }
    case "V": {
      const source = bytes(rest[0]);
      return new DataView(new Uint8Array(source).buffer);
    }
    case "T": {
      return typedArray(rest[0], new Uint8Array(bytes(rest[1])).buffer);
    }
    case "O": {
      const entries: [string, unknown][] = [];
      for (let index = 0; index < rest.length; index += 2) {
        const key = rest[index];
        if (typeof key !== "string") throw new TypeError("object key is not a string");
        entries.push([key, decodeValue(rest[index + 1])]);
      }
      // Own data properties, as structured clone makes them: a `__proto__` key stays a key.
      return Object.fromEntries(entries);
    }
    default:
      throw new TypeError(`unknown tag ${tag}`);
  }
}

const utf8 = new TextEncoder();
const encodePayload = (value: unknown): Uint8Array => utf8.encode(JSON.stringify(encodeValue(value, new Set())));
const decodePayload = (bytes: Uint8Array): unknown => decodeValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));

// ── framing ────────────────────────────────────────────────────────────────────────────────

/** magic (4) + format version (4) + payload length (4) + SHA-256 of the payload (32), then the payload. */
function frame(magic: number, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(HEADER + payload.byteLength);
  out.writeUInt32BE(magic, 0);
  out.writeUInt32BE(FILE_JOURNAL_FORMAT_VERSION, 4);
  out.writeUInt32BE(payload.byteLength, 8);
  Buffer.from(sha256HexOfBytes(payload), "hex").copy(out, 12);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, HEADER);
  return out;
}

/** A whole, checksummed frame starting at `at`, or `null` when the bytes there are not one. */
function frameAt(bytes: Buffer, at: number, magic: number): { format: number; payload: Buffer; end: number } | null {
  if (bytes.byteLength - at < HEADER || bytes.readUInt32BE(at) !== magic) return null;
  const length = bytes.readUInt32BE(at + 8);
  if (length > MAXIMUM_RECORD_BYTES) return null;
  const end = at + HEADER + length;
  if (end > bytes.byteLength) return null;
  const payload = bytes.subarray(at + HEADER, end);
  if (!Buffer.from(sha256HexOfBytes(payload), "hex").equals(bytes.subarray(at + 12, at + HEADER))) return null;
  return { format: bytes.readUInt32BE(at + 4), payload, end };
}

/** The result of reading `store.log`: the records that are whole, and where the valid prefix ends. */
interface ScannedLog {
  records: LogRecord[];
  validBytes: number;
  totalBytes: number;
}

/** Whether a whole, checksummed record begins anywhere at or after `from`. */
function wholeRecordFrom(bytes: Buffer, from: number): boolean {
  for (let at = bytes.indexOf(RECORD_MAGIC_BYTES, from); at !== -1; at = bytes.indexOf(RECORD_MAGIC_BYTES, at + 1)) {
    if (frameAt(bytes, at, RECORD_MAGIC)) return true;
  }
  return false;
}

/**
 * Split a log into whole records. Every record but the last was fsynced before the next was
 * written, so only the last append can be incomplete, and its pages may have reached the disk
 * in any order: cut short, zero-filled, zero at the front with data behind, or with a header
 * whose length was never written. So the bytes after the last whole record are a torn tail
 * exactly when no whole, checksummed record begins anywhere inside them; when one does, a record
 * the store acknowledged is damaged, and that is corruption.
 */
function scanLog(bytes: Buffer, file: string): ScannedLog {
  const records: LogRecord[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    const found = frameAt(bytes, at, RECORD_MAGIC);
    if (!found) {
      if (wholeRecordFrom(bytes, at + 1)) throw new FileJournalCorruptError(file, "a damaged record is followed by a whole one", at);
      return { records, validBytes: at, totalBytes: bytes.byteLength };
    }
    if (found.format !== FILE_JOURNAL_FORMAT_VERSION) throw new FileJournalFormatError(file, found.format, at);
    let record: LogRecord;
    try {
      record = decodePayload(found.payload) as LogRecord;
    } catch {
      throw new FileJournalCorruptError(file, "record checksum matches but its payload does not decode", at);
    }
    if (!record || !Number.isSafeInteger(record.txn) || !Array.isArray(record.changes))
      throw new FileJournalCorruptError(file, "record has no transaction number or changes", at);
    records.push(record);
    at = found.end;
  }
  return { records, validBytes: at, totalBytes: bytes.byteLength };
}

function decodeSnapshot(bytes: Buffer, file: string): SnapshotPayload {
  if (bytes.byteLength < HEADER || bytes.readUInt32BE(0) !== SNAPSHOT_MAGIC) throw new FileJournalCorruptError(file, "not a store snapshot");
  const found = frameAt(bytes, 0, SNAPSHOT_MAGIC);
  if (!found || found.end !== bytes.byteLength) throw new FileJournalCorruptError(file, "snapshot checksum or length does not match");
  if (found.format !== FILE_JOURNAL_FORMAT_VERSION) throw new FileJournalFormatError(file, found.format);
  let decoded: SnapshotPayload;
  try {
    decoded = decodePayload(found.payload) as SnapshotPayload;
  } catch {
    throw new FileJournalCorruptError(file, "snapshot checksum matches but its payload does not decode");
  }
  if (!decoded || decoded.format !== FILE_JOURNAL_FORMAT_VERSION || !Number.isSafeInteger(decoded.txn) || !Number.isSafeInteger(decoded.sequence))
    throw new FileJournalCorruptError(file, "snapshot has no transaction number");
  return decoded;
}

// ── helpers shared with the other adapters' record handling ────────────────────────────────

function notFound(id: ConceptId): Error & { code: string } {
  const err = new Error(`no concept document '${id}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

function reservedKey(dir: string, name: ReservedFilename): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function sortedKeys<T extends string>(keys: Iterable<T>, prefix?: string): T[] {
  const out = [...keys].filter((key) => !prefix || key.startsWith(prefix));
  out.sort(compareStorageKeys);
  return out;
}

const bySequence = (a: IntentRecord, b: IntentRecord) => a.sequence - b.sequence;

/** The okf edition declared by the bundle root's `index.md`; malformed metadata is no edition. */
function editionOf(index: ReservedRecord | undefined): string | undefined {
  if (!index) return undefined;
  try {
    const value = parseLeadingFrontmatter(index.content, "index.md").okf_version;
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch (error) {
    if (error instanceof MalformedDocumentError) return undefined;
    throw error;
  }
}

function headOf(id: ConceptId, record: DocumentRecord, intents: IntentRecord[], meta: Map<string, unknown>, edition: string | undefined): JournaledHead {
  const head = { id, version: record.version, updatedBy: record.updatedBy, updatedAt: record.updatedAt, raw: record.raw, intents, meta };
  let frontmatter: Frontmatter;
  try {
    frontmatter = parseMarkdown(record.raw, pathFromConceptId(id), { okfVersion: edition }).frontmatter;
  } catch (error) {
    if (!(error instanceof MalformedDocumentError)) throw error;
    return { ...head, frontmatter: null, malformed: error };
  }
  return { ...head, frontmatter };
}

// ── the adapter ────────────────────────────────────────────────────────────────────────────

export interface FileJournaledBackendOptions {
  /** The directory that holds this store's log and snapshot. Created (mode 0700) when absent. */
  directory: string;
  /**
   * The store's exclusive lock: how long open waits for another holder, and, for isolated
   * tests, the lock namespace. The default waits five seconds in the per-user runtime namespace.
   */
  lock?: Pick<FilesystemMutationLockOptions, "waitMs" | "pollMs" | "lockRoot">;
  /**
   * The trusted host construction, as every Node filesystem protocol in core takes it. Omitted,
   * the supported default (macOS and Linux); another host (the Windows distribution) passes its
   * own. It decides the lock namespace and which replacement errors are transient.
   */
  hostPolicy?: FilesystemHostPolicy;
  /** Open compacts when the log is larger than this many bytes. Default 8 MiB. */
  compactAfterBytes?: number;
}

/**
 * Make a directory entry durable. Windows cannot open a directory as a file handle to flush it
 * (NTFS journals its own metadata), so there the open or flush refusal is expected and skipped;
 * on every other host it propagates.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES" || code === "EINVAL" || code === "ENOTSUP"))) throw error;
  } finally {
    await handle?.close();
  }
}

/** Rename over `to`, retrying what the host classifies as a transient replacement conflict (a scanner holding the file open). */
async function renameOver(from: string, to: string, policy: FilesystemHostPolicy, waitMs: number, pollMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!policy.isReplacementConflict(error) || Date.now() - started >= waitMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAll(handle: FileJournalHandle, bytes: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written, position + written);
    if (bytesWritten <= 0) throw new Error("the log accepted no bytes");
    written += bytesWritten;
  }
}

/** What one mutation decided, computed synchronously against the index before anything is written. */
interface Decision<T> {
  changes: Change[];
  result: T;
}

/**
 * The Node working copy's persistent store: one directory, one exclusive lock, one log. Open it
 * with {@link FileJournaledBackend.open}; {@link close} releases the lock.
 */
export class FileJournaledBackend implements JournaledBackend {
  readonly journalSnapshotCas = true as const;
  /** A resolved mutation's log record, and every directory entry the store created, were fsynced. */
  readonly durability = "fsync" as const;

  readonly directory: string;
  readonly #state: State;
  readonly #log: FileJournalHandle;
  readonly #release: () => Promise<void>;
  readonly #policy: FilesystemHostPolicy;
  #txn: number;
  #logBytes: number;
  #queue: Promise<unknown> = Promise.resolve();
  #unavailable: Error | null = null;
  #closing: Promise<void> | null = null;

  private constructor(directory: string, state: State, log: FileJournalHandle, release: () => Promise<void>, txn: number, logBytes: number, policy: FilesystemHostPolicy) {
    this.directory = directory;
    this.#policy = policy;
    this.#state = state;
    this.#log = log;
    this.#release = release;
    this.#txn = txn;
    this.#logBytes = logBytes;
  }

  /**
   * Claim the directory's lock, load the snapshot, replay the log, and truncate a torn tail. A
   * corrupt snapshot or a corrupt record before the log's end refuses the open and changes no
   * file. Compacts when the log is larger than `compactAfterBytes`.
   */
  static open(options: FileJournaledBackendOptions): Promise<FileJournaledBackend> {
    return FileJournaledBackend.#open(options, (file) => fs.open(file, "r+"));
  }

  /** @internal The test seam: open with a substitute log handle. Reachable only through {@link OPEN_LOG}. */
  static [OPEN_LOG](options: FileJournaledBackendOptions, openLog: (file: string) => Promise<FileJournalHandle>): Promise<FileJournaledBackend> {
    return FileJournaledBackend.#open(options, openLog);
  }

  static async #open(options: FileJournaledBackendOptions, openLog: (file: string) => Promise<FileJournalHandle>): Promise<FileJournaledBackend> {
    if (typeof options.directory !== "string" || options.directory.trim() === "") throw new TypeError("FileJournaledBackend requires a directory.");
    const directory = path.resolve(options.directory);
    const compactAfter = options.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES;
    if (!(compactAfter >= 0)) throw new TypeError("compactAfterBytes must be a non-negative number");
    let created = false;
    try {
      const stat: Stats = await fs.stat(directory);
      if (!stat.isDirectory()) throw new Error(`'${directory}' is not a directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      created = true;
    }
    const policy = captureFilesystemHostPolicy(options.hostPolicy);
    const release = await acquireFilesystemMutationLock(directory, { ...options.lock, hostPolicy: policy });
    let log: FileJournalHandle | undefined;
    try {
      if (created) await syncDirectory(path.dirname(directory));
      const logFile = path.join(directory, FILE_JOURNAL_LOG);
      const snapshotFile = path.join(directory, FILE_JOURNAL_SNAPSHOT);
      // Read and validate everything before changing any file, so a refusal leaves the evidence as it was.
      const snapshotBytes = await readIfPresent(snapshotFile);
      const snapshot = snapshotBytes ? decodeSnapshot(snapshotBytes, snapshotFile) : null;
      const logRead = await readIfPresent(logFile);
      const logBytes = logRead ?? Buffer.alloc(0);
      const scanned = scanLog(logBytes, logFile);
      const state = emptyState();
      let txn = 0;
      if (snapshot) {
        state.documents = new Map(snapshot.documents);
        state.reserved = new Map(snapshot.reserved);
        state.blobs = new Map(snapshot.blobs);
        state.intents = new Map(snapshot.intents);
        state.meta = new Map(snapshot.meta);
        state.sequence = snapshot.sequence;
        txn = snapshot.txn;
      }
      for (const record of scanned.records) {
        // Records the snapshot already covers are the log compaction had not yet truncated.
        if (record.txn <= txn) continue;
        if (record.txn !== txn + 1) throw new FileJournalCorruptError(logFile, `transaction ${record.txn} follows ${txn}`);
        applyChanges(state, record.changes);
        txn = record.txn;
      }
      await fs.rm(path.join(directory, SNAPSHOT_TEMP), { force: true });
      if (logRead === null) {
        await (await fs.open(logFile, "a", 0o600)).close();
        await syncDirectory(directory);
      }
      log = await openLog(logFile);
      if (scanned.validBytes !== scanned.totalBytes) {
        await log.truncate(scanned.validBytes);
        await log.sync();
      }
      const backend = new FileJournaledBackend(directory, state, log, release, txn, scanned.validBytes, policy);
      if (scanned.validBytes > compactAfter) await backend.compact();
      return backend;
    } catch (error) {
      await log?.close().catch(() => {});
      await release().catch(() => {});
      throw error;
    }
  }

  capabilities(): StorageCapabilities {
    return { history: false, enforced_cas: true, blobs: true, projections: false, backlinks: false };
  }

  /** The number of the last committed transaction; it grows by one per mutation that wrote. */
  get transaction(): number {
    return this.#txn;
  }

  /** Let queued mutations finish, close the log, and release the directory's lock. Later calls reject. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#queue;
      try {
        await this.#log.close();
      } finally {
        await this.#release();
      }
    })();
    return this.#closing;
  }

  /**
   * Write the whole index as the snapshot and empty the log: a temporary file, fsynced, renamed
   * over the snapshot, the directory fsynced, then the log truncated. Serialized with mutations,
   * under the directory lock the store holds.
   */
  compact(): Promise<void> {
    return this.#serial(async () => {
      const state = this.#state;
      const payload: SnapshotPayload = {
        format: FILE_JOURNAL_FORMAT_VERSION,
        txn: this.#txn,
        sequence: state.sequence,
        documents: [...state.documents],
        reserved: [...state.reserved],
        blobs: [...state.blobs],
        intents: [...state.intents],
        meta: [...state.meta],
      };
      const bytes = frame(SNAPSHOT_MAGIC, encodePayload(payload));
      const temp = path.join(this.directory, SNAPSHOT_TEMP);
      const handle = await fs.open(temp, "w", 0o600);
      try {
        await writeAll(handle, bytes, 0);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
      await renameOver(temp, path.join(this.directory, FILE_JOURNAL_SNAPSHOT), this.#policy, 5_000, 25);
      await syncDirectory(this.directory);
      // From here the snapshot covers every record, so a failure to empty the log costs space, not
      // state. Once the truncation lands, the next append goes to offset zero whether or not the
      // fsync that follows succeeds, so no append can leave a hole before its record.
      await this.#log.truncate(0);
      this.#logBytes = 0;
      await this.#log.sync();
    });
  }

  // ── the one mutation path ───────────────────────────────────────────────────────────────

  /** Run `fn` after every earlier mutation settles; mutations never interleave. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new FileJournalUnavailableError("the store is closed"));
    const run = this.#queue.then(() => {
      if (this.#unavailable) throw this.#unavailable;
      return fn();
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Decide against the index, make the decision durable, then apply it. `decide` runs with no
   * await between its checks and the append that follows, and nothing else mutates the index
   * meanwhile, so its checks still hold when the record lands. A decision that changes nothing
   * writes nothing. A failed append is removed from the log before the rejection; when removing
   * it also fails, the store refuses every later call, because only a reopen can tell whether
   * the record reached the disk.
   */
  #mutate<T>(decide: (state: State) => Decision<T>): Promise<T> {
    return this.#serial(async () => {
      const { changes, result } = decide(this.#state);
      if (changes.length === 0) return result;
      const record: LogRecord = { txn: this.#txn + 1, changes };
      const payload = encodePayload(record);
      if (payload.byteLength > MAXIMUM_RECORD_BYTES) throw new RangeError(`a transaction of ${payload.byteLength} bytes exceeds the log's record bound`);
      const bytes = frame(RECORD_MAGIC, payload);
      const at = this.#logBytes;
      try {
        await writeAll(this.#log, bytes, at);
        await this.#log.sync();
      } catch (error) {
        try {
          await this.#log.truncate(at);
          await this.#log.sync();
        } catch (cleanup) {
          this.#unavailable = new FileJournalUnavailableError(
            `the store's last append failed and could not be removed; reopen the store to learn whether it committed (${String((cleanup as Error)?.message ?? cleanup)})`,
            { cause: error },
          );
        }
        throw error;
      }
      this.#logBytes = at + bytes.byteLength;
      this.#txn = record.txn;
      applyChanges(this.#state, changes);
      return result;
    });
  }

  #assertOpen(): void {
    if (this.#closing) throw new FileJournalUnavailableError("the store is closed");
    if (this.#unavailable) throw this.#unavailable;
  }

  // ── documents ─────────────────────────────────────────────────────────────────────────

  async read(id: ConceptId): Promise<ReadResult> {
    const [result] = await this.readMany([id]);
    return result!;
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    for (const id of ids) assertSafeConceptId(id);
    this.#assertOpen();
    const records = ids.map((id) => this.#state.documents.get(id));
    const edition = editionOf(this.#state.reserved.get(reservedKey("", "index.md")));
    return ids.map((id, position) => {
      const record = records[position];
      if (!record) throw notFound(id);
      const { frontmatter, body } = parseMarkdown(record.raw, pathFromConceptId(id), { okfVersion: edition });
      return { doc: { id, frontmatter, body }, version: record.version };
    });
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const version = versionOfBytes(raw);
    const updatedBy = options.actor?.trim() || defaultActor();
    const expected = options.expectedVersion;
    const updatedAt = new Date().toISOString();
    return this.#mutate((state) => {
      const current = state.documents.get(id)?.version ?? null;
      if (expected !== undefined && expected !== current) throw new VersionConflict(id, expected, current);
      return { changes: [{ family: "document", key: id, value: { raw, version, updatedBy, updatedAt } }], result: version };
    });
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    const expected = options.expectedVersion;
    return this.#mutate((state) => {
      const current = state.documents.get(id);
      if (!current) return { changes: [], result: false };
      if (expected !== undefined && expected !== current.version) throw new VersionConflict(id, expected, current.version);
      return { changes: [{ family: "document", key: id, value: null }], result: true };
    });
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    this.#assertOpen();
    return this.#state.documents.has(id);
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    this.#assertOpen();
    return sortedKeys(this.#state.documents.keys(), prefix);
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    this.#assertOpen();
    const record = this.#state.documents.get(id);
    if (!record) return [];
    let frontmatter: Record<string, unknown> = {};
    try {
      frontmatter = parseMarkdown(record.raw, pathFromConceptId(id)).frontmatter;
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
    const actor = mutationActorFromFrontmatter(frontmatter) ?? record.updatedBy;
    const timestamp = firstString(frontmatter.timestamp) ?? record.updatedAt;
    return [{ version: record.version, actor, timestamp }];
  }

  // ── reserved files ─────────────────────────────────────────────────────────────────────

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    assertSafeReservedDir(dir);
    assertSafeReservedFilename(name);
    this.#assertOpen();
    const record = this.#state.reserved.get(reservedKey(dir, name));
    return record ? { content: record.content, version: record.version } : null;
  }

  async writeReserved(dir: string, name: ReservedFilename, content: string, options: WriteOptions = {}): Promise<Version> {
    assertSafeReservedDir(dir);
    assertSafeReservedFilename(name);
    const key = reservedKey(dir, name);
    const version = versionOfBytes(content);
    const expected = options.expectedVersion;
    return this.#mutate((state) => {
      const current = state.reserved.get(key)?.version ?? null;
      if (expected !== undefined && expected !== current) throw new VersionConflict(key, expected, current);
      return { changes: [{ family: "reserved", key, value: { content, version } }], result: version };
    });
  }

  // ── blobs ──────────────────────────────────────────────────────────────────────────────

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    this.#assertOpen();
    const record = this.#state.blobs.get(key);
    return record ? { bytes: new Uint8Array(record.bytes), contentType: record.contentType, version: record.version } : null;
  }

  async writeBlob(key: BlobKey, bytes: Uint8Array, contentType?: string, options: WriteOptions = {}): Promise<Version> {
    assertSafeBlobKey(key);
    const version = blobVersion(bytes);
    const resolvedType = resolveContentType(key, contentType);
    const stored = new Uint8Array(bytes);
    const expected = options.expectedVersion;
    return this.#mutate((state) => {
      const current = state.blobs.get(key);
      if (expected !== undefined && expected !== (current?.version ?? null)) throw new VersionConflict(key, expected, current?.version ?? null);
      if (current && current.version === version && current.contentType === resolvedType) return { changes: [], result: version };
      return { changes: [{ family: "blob", key, value: { bytes: stored, contentType: resolvedType, version } }], result: version };
    });
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    const expected = options.expectedVersion;
    return this.#mutate((state) => {
      const current = state.blobs.get(key);
      if (!current) return { changes: [], result: false };
      if (expected !== undefined && expected !== current.version) throw new VersionConflict(key, expected, current.version);
      return { changes: [{ family: "blob", key, value: null }], result: true };
    });
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    this.#assertOpen();
    return this.#state.blobs.has(key);
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    this.#assertOpen();
    return sortedKeys(this.#state.blobs.keys(), prefix);
  }

  // ── the journal seam ──────────────────────────────────────────────────────────────────

  #checkGuard(state: State, guard: JournalGuard | undefined): void {
    if (guard === undefined) return;
    const document = state.documents.get(guard.target);
    assertJournalGuard(guard, {
      target: guard.target,
      document: document ? { version: document.version, raw: document.raw } : null,
      intents: [...state.intents.values()].filter((row) => row.target === guard.target),
      meta: guard.meta.map((row) => ({ key: row.key, expected: state.meta.has(row.key) ? { present: true, value: state.meta.get(row.key) } : { present: false } })),
    });
  }

  static #holder(state: State, id: ConceptId): IntentRecord | undefined {
    return [...state.intents.values()].sort(bySequence).find((row) => row.target === id && row.state !== "acknowledged");
  }

  static #metaChanges(puts: readonly MetaRecord[], removals: readonly string[] = []): Change[] {
    return [
      ...puts.map((row): Change => ({ family: "meta", key: row.key, present: true, value: structuredClone(row.value) })),
      ...removals.map((key): Change => ({ family: "meta", key, present: false })),
    ];
  }

  async writeJournaled(id: ConceptId, doc: OkfDocument, options: JournaledWriteOptions = {}): Promise<{ version: Version; raw: string; intent: IntentRecord | null }> {
    // Everything the caller handed over is captured before the first await, so a caller that
    // mutates its inputs while the write is queued cannot change what is written.
    const snapshotGuard = captureJournalGuardOption(options, id);
    if (snapshotGuard !== undefined) { options = captureJournalWriteOptions(options); doc = captureJournalValue(doc); }
    assertSafeConceptId(id);
    assertJournalResolutionOptions(id, options);
    if (snapshotGuard && (doc.id !== id || (options.intent && options.intent.target !== id))) throw new JournalGuardConflict(id);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const version = versionOfBytes(raw);
    const producedMeta = typeof options.meta === "function" ? options.meta({ version, raw }) : options.meta ?? [];
    assertJournalMetaChanges(snapshotGuard, producedMeta, options.removeMeta);
    const meta = structuredClone(producedMeta);
    const removeMeta = options.removeMeta ? [...options.removeMeta] : [];
    const intent = options.intent ? structuredClone(options.intent) : undefined;
    const supersede = options.supersede ? { ...options.supersede } : undefined;
    const resolveIntents = options.resolveIntents ? structuredClone(options.resolveIntents) : undefined;
    const { requireSettled } = options;
    const expected = options.expectedVersion;
    const updatedBy = options.actor?.trim() || defaultActor();
    const now = new Date().toISOString();
    return this.#mutate((state) => {
      this.#checkGuard(state, snapshotGuard);
      assertJournalIntentChanges(snapshotGuard, intent ? state.intents.get(intent.requestId) : undefined, supersede ? state.intents.get(supersede.requestId) : undefined);
      if (resolveIntents) assertJournalSnapshot(id, resolveIntents.expected, [...state.intents.values()], intent?.requestId);
      if (requireSettled) {
        const holder = FileJournaledBackend.#holder(state, id);
        if (holder) throw new IntentHoldConflict(id, holder.requestId, holder.state);
      }
      const current = state.documents.get(id)?.version ?? null;
      if (expected !== undefined && expected !== current) throw new VersionConflict(id, expected, current);
      if (supersede) {
        const existing = state.intents.get(supersede.requestId);
        if (!existing || existing.state !== supersede.expectedState || existing.attempts !== supersede.expectedAttempts)
          throw new IntentStateConflict(supersede.requestId, supersede.expectedState, existing?.state ?? null);
      }
      const changes: Change[] = [{ family: "document", key: id, value: { raw, version, updatedBy, updatedAt: now } }];
      if (supersede) changes.push({ family: "intent", key: supersede.requestId, value: null });
      for (const row of resolveIntents?.expected ?? []) changes.push({ family: "intent", key: row.requestId, value: null });
      let record: IntentRecord | null = null;
      if (intent) {
        const sequence = state.sequence + 1;
        record = { ...intent, local: version, content: raw, sequence, attempts: 0, state: "pending", updatedAt: now };
        changes.push({ family: "sequence", value: sequence }, { family: "intent", key: record.requestId, value: structuredClone(record) });
      }
      changes.push(...FileJournaledBackend.#metaChanges(meta, removeMeta));
      return { changes, result: { version, raw, intent: record } };
    });
  }

  async deleteJournaled(id: ConceptId, options: JournaledDeleteOptions = {}): Promise<JournaledDeleteResult> {
    options = captureJournalDeleteOptions(id, options);
    assertSafeConceptId(id);
    assertJournalResolutionOptions(id, options);
    assertDeletionIntent(id, options);
    const captured = structuredClone({ meta: options.meta ?? [], removeMeta: [...(options.removeMeta ?? [])], onHeld: options.onHeld, resolveIntents: options.resolveIntents, intent: options.intent, supersede: options.supersede });
    const { guard, requireSettled } = options;
    const expected = options.expectedVersion;
    const now = new Date().toISOString();
    return this.#mutate<JournaledDeleteResult>((state) => {
      this.#checkGuard(state, guard);
      if (captured.resolveIntents) assertJournalSnapshot(id, captured.resolveIntents.expected, [...state.intents.values()], captured.intent?.requestId);
      if (captured.intent && state.intents.has(captured.intent.requestId)) throw new JournalSnapshotConflict(id);
      if (requireSettled) {
        const holder = FileJournaledBackend.#holder(state, id);
        if (holder) {
          if (!captured.onHeld) throw new IntentHoldConflict(id, holder.requestId, holder.state);
          return { changes: FileJournaledBackend.#metaChanges(captured.onHeld.meta), result: { outcome: "held", requestId: holder.requestId, state: holder.state } };
        }
      }
      const current = state.documents.get(id)?.version ?? null;
      if ((current !== null || captured.resolveIntents) && expected !== undefined && expected !== current) throw new VersionConflict(id, expected, current);
      const { supersede } = captured;
      if (supersede) {
        const existing = state.intents.get(supersede.requestId);
        if (!existing || existing.target !== id || existing.state !== supersede.expectedState || existing.attempts !== supersede.expectedAttempts)
          throw new IntentStateConflict(supersede.requestId, supersede.expectedState, existing?.state ?? null);
      }
      const changes: Change[] = [];
      if (current !== null) changes.push({ family: "document", key: id, value: null });
      if (supersede) changes.push({ family: "intent", key: supersede.requestId, value: null });
      for (const row of captured.resolveIntents?.expected ?? []) changes.push({ family: "intent", key: row.requestId, value: null });
      let record: IntentRecord | undefined;
      if (captured.intent) {
        const sequence = state.sequence + 1;
        record = deletionIntentRecord(captured.intent, sequence, now);
        changes.push({ family: "sequence", value: sequence }, { family: "intent", key: record.requestId, value: structuredClone(record) });
      }
      changes.push(...FileJournaledBackend.#metaChanges(captured.meta, captured.removeMeta));
      return { changes, result: { outcome: current !== null ? "deleted" : "absent", ...(record ? { intent: record } : {}) } };
    });
  }

  async readWithJournal(id: ConceptId, options: { meta?: readonly string[] } = {}): Promise<JournaledReadResult> {
    assertSafeConceptId(id);
    this.#assertOpen();
    const state = this.#state;
    const record = state.documents.get(id);
    const intents = [...state.intents.values()].filter((row) => row.target === id).sort(bySequence).map((row) => structuredClone(row));
    const meta = new Map<string, unknown>();
    for (const key of options.meta ?? []) {
      if (state.meta.has(key)) meta.set(key, structuredClone(state.meta.get(key)));
    }
    if (!record) return { document: null, raw: null, intents, meta };
    const { frontmatter, body } = parseMarkdown(record.raw, pathFromConceptId(id), { okfVersion: editionOf(state.reserved.get(reservedKey("", "index.md"))) });
    return { document: { doc: { id, frontmatter, body }, version: record.version }, raw: record.raw, intents, meta };
  }

  async readHeads<T = JournaledHead>(options: JournaledHeadsOptions<T> = {}): Promise<T[]> {
    this.#assertOpen();
    const state = this.#state;
    const keysOf = options.meta ?? (() => []);
    const sharedKeys = [...new Set(options.shared ?? [])];
    const project = options.project ?? ((head: JournaledHead) => head as unknown as T);
    // One synchronous pass: no mutation can apply between the first row and the last.
    const edition = editionOf(state.reserved.get(reservedKey("", "index.md")));
    const byTarget = new Map<ConceptId, IntentRecord[]>();
    for (const row of state.intents.values()) {
      const list = byTarget.get(row.target);
      if (list) list.push(row);
      else byTarget.set(row.target, [row]);
    }
    const shared = new Map<string, unknown>();
    for (const key of sharedKeys) {
      if (state.meta.has(key)) shared.set(key, structuredClone(state.meta.get(key)));
    }
    const out: T[] = [];
    for (const id of sortedKeys(state.documents.keys())) {
      const record = state.documents.get(id)!;
      const intents = (byTarget.get(id) ?? []).sort(bySequence).map((row) => structuredClone(row));
      const meta = new Map(shared);
      for (const key of new Set(keysOf(id, intents))) {
        if (!sharedKeys.includes(key) && state.meta.has(key)) meta.set(key, structuredClone(state.meta.get(key)));
      }
      out.push(project(headOf(id, record, intents, meta, edition)));
    }
    return out;
  }

  async listIntents(state?: OperationState | readonly OperationState[]): Promise<IntentRecord[]> {
    this.#assertOpen();
    const wanted = state === undefined ? null : new Set(typeof state === "string" ? [state] : state);
    return [...this.#state.intents.values()].filter((row) => !wanted || wanted.has(row.state)).sort(bySequence).map((row) => structuredClone(row));
  }

  async readIntent(requestId: string): Promise<IntentRecord | undefined> {
    this.#assertOpen();
    const row = this.#state.intents.get(requestId);
    return row ? structuredClone(row) : undefined;
  }

  async updateIntent(requestId: string, expectedState: OperationState, patch: IntentPatch, options: IntentUpdateOptions = {}): Promise<IntentRecord> {
    ({ patch, options } = captureIntentUpdate(patch, options));
    const now = new Date().toISOString();
    const raw = options.document ? stringifyDoc(options.document.frontmatter, options.document.body ?? "") : undefined;
    const replacement = raw === undefined ? undefined : { id: options.document!.id, record: { raw, version: versionOfBytes(raw), updatedBy: defaultActor(), updatedAt: now } };
    const { guard } = options;
    const meta = options.meta ?? [];
    return this.#mutate((state) => {
      this.#checkGuard(state, guard);
      const current = state.intents.get(requestId);
      if (!current || current.state !== expectedState) throw new IntentStateConflict(requestId, expectedState, current?.state ?? null);
      if (guard && current.target !== guard.target) throw new JournalGuardConflict(current.target);
      const next: IntentRecord = { ...current, ...patch, requestId, sequence: current.sequence, updatedAt: now };
      const changes: Change[] = [];
      if (replacement) changes.push({ family: "document", key: replacement.id, value: replacement.record });
      changes.push({ family: "intent", key: requestId, value: structuredClone(next) }, ...FileJournaledBackend.#metaChanges(meta));
      return { changes, result: next };
    });
  }

  async readMeta<T = unknown>(key: string): Promise<T | undefined> {
    this.#assertOpen();
    return this.#state.meta.has(key) ? (structuredClone(this.#state.meta.get(key)) as T) : undefined;
  }

  /**
   * @internal Plant exact bytes as `id`'s stored serialization, bypassing the serializer, through
   * the log like any other write: the contract kit's malformed-record and edition rows. Reachable
   * only through {@link STORE_RAW}.
   */
  async [STORE_RAW](id: ConceptId, raw: string): Promise<void> {
    assertSafeConceptId(id);
    const record: DocumentRecord = { raw, version: versionOfBytes(raw), updatedBy: defaultActor(), updatedAt: new Date().toISOString() };
    await this.#mutate(() => ({ changes: [{ family: "document", key: id, value: record }], result: undefined }));
  }

  async writeMeta(key: string, value: unknown, options: MetaWriteOptions = {}): Promise<void> {
    options = captureMetaWrite(options);
    const captured = options.expected !== undefined || options.requireEmptyJournal ? captureJournalValue(value) : structuredClone(value);
    await this.#mutate((state) => {
      assertMetaWrite(key, options, state.meta.has(key) ? { present: true, value: state.meta.get(key) } : { present: false }, [...state.intents.values()]);
      return { changes: [{ family: "meta", key, present: true, value: captured }], result: undefined };
    });
  }
}
