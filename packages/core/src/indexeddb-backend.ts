/**
 * IndexedDB-backed {@link StorageBackend}: the browser-local working copy's first persistent
 * store candidate, sitting behind the same core seam as {@link FilesystemBackend} and
 * {@link MemoryBackend} and proven by the same adapter contract kit.
 *
 * Storage shape mirrors the filesystem adapter, not the memory adapter: a concept document is
 * stored as its exact OKF-serialized string and parsed on every read, so the read body carries
 * the serializer's normalization (the trailing newline) and the version token is
 * `versionOfBytes(raw)` over the same bytes the disk copy would hold. Reserved files are stored
 * as raw strings and blobs as raw bytes, both content-addressed with the shared primitives, so a
 * document, reserved file, or blob carries one token on disk, in memory, and in the browser.
 *
 * Compare-and-swap is one IndexedDB readwrite transaction per mutation: the current record is
 * read, compared, and replaced (or the transaction aborted with a {@link VersionConflict}) before
 * the transaction commits. IndexedDB serializes readwrite transactions that overlap on a store,
 * so two adapter instances (two tabs, two workers) over the same database cannot both win a
 * conditional write. A write resolves only after the transaction's `complete` event, which is
 * the point a local-save indicator may follow. That is a commit promise, not a power-loss
 * promise: the browser decides when committed pages reach stable storage.
 *
 * This module imports no Node builtin so it bundles for the browser; the IndexedDB factory is
 * injectable so a Node test can supply an in-memory implementation without touching globals.
 */

import { resolveContentType } from "./content-type.js";
import { MalformedDocumentError, parseMarkdown, stringifyDoc } from "./frontmatter.js";
import { mutationActorFromFrontmatter } from "./mutation-attribution.js";
import { assertSafeBlobKey, assertSafeConceptId, assertSafeReservedDir, pathFromConceptId, toPosix } from "./paths.js";
import { parseLeadingFrontmatter } from "./portable-frontmatter.js";
import { blobVersion, defaultActor, VersionConflict, versionOfBytes } from "./versioning.js";
import type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  OkfDocument,
  ReadBlobResult,
  ReadResult,
  ReservedFilename,
  ReservedReadResult,
  StorageBackend,
  StorageCapabilities,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

// ── the slice of the IndexedDB API this adapter needs ──────────────────────────────────────
// Core compiles against the ES library only (no DOM lib), so the adapter names the structural
// surface it uses. A real `IDBFactory` and fake-indexeddb's factory both satisfy these shapes.

type Handler = ((this: any, event: any) => any) | null;

export interface IdbRequestLike<T = unknown> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: Handler;
  onerror: Handler;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: Handler;
  onblocked: Handler;
  readonly transaction: IdbTransactionLike | null;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike;
  getAllKeys(): IdbRequestLike<unknown[]>;
  count(key: string): IdbRequestLike<number>;
  put(value: unknown): IdbRequestLike;
  delete(key: string): IdbRequestLike;
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  abort(): void;
  readonly error: unknown;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
}

export interface IdbDatabaseLike {
  readonly version: number;
  readonly objectStoreNames: { contains(name: string): boolean; readonly length: number };
  createObjectStore(name: string, options?: { keyPath?: string }): unknown;
  transaction(storeNames: string | string[], mode?: "readonly" | "readwrite"): IdbTransactionLike;
  close(): void;
  onversionchange: Handler;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

export interface IndexedDbBackendOptions {
  /** The IndexedDB database holding this working copy; one bundle per database. */
  databaseName: string;
  /** The factory to open it with. Defaults to the host's global `indexedDB`. */
  indexedDB?: IdbFactoryLike;
}

/** The database does not carry this adapter's schema and the adapter refuses to touch it. */
export class IndexedDbSchemaError extends Error {
  override readonly name = "IndexedDbSchemaError";
}

// ── schema ─────────────────────────────────────────────────────────────────────────────────

/** Bumping this requires a migration in `upgrade`; the handler refuses any other older layout. */
export const INDEXEDDB_SCHEMA_VERSION = 1;

const DOCUMENTS = "documents";
const RESERVED = "reserved";
const BLOBS = "blobs";
const STORES = [DOCUMENTS, RESERVED, BLOBS] as const;

interface DocumentRecord {
  id: ConceptId;
  /** The exact OKF-serialized document; `version` is `versionOfBytes(raw)`. */
  raw: string;
  version: Version;
  updatedBy: string;
  updatedAt: string;
}

interface ReservedRecord {
  path: string;
  content: string;
  version: Version;
}

interface BlobRecord {
  key: BlobKey;
  bytes: Uint8Array;
  contentType: string;
  version: Version;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────

/** An ENOENT-shaped rejection so missing-document handling matches the other adapters. */
function notFound(id: ConceptId): Error & { code: string } {
  const err = new Error(`no concept document '${id}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

/** Bundle-relative key for a reserved file (`""` = bundle root), the filesystem adapter's layout. */
function reservedKey(dir: string, name: ReservedFilename): string {
  const d = toPosix(dir).replace(/^\.?\//, "").replace(/\/$/, "");
  return d === "" ? name : `${d}/${name}`;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function requestError(request: IdbRequestLike, fallback: string): Error {
  const error = request.error;
  return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`);
}

function sorted<T extends string>(keys: unknown[], prefix?: string): T[] {
  const out = keys.filter((key): key is T => typeof key === "string" && (!prefix || key.startsWith(prefix)));
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** The okf edition declared by a bundle root, from a raw `index.md`; malformed metadata is no edition. */
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

/**
 * A persistent browser-local OKF store implementing the {@link StorageBackend} contract over
 * IndexedDB. One instance per bundle per JavaScript realm; several instances over the same
 * database name are peers whose conditional writes are serialized by the database.
 */
export class IndexedDbBackend implements StorageBackend {
  /**
   * What a resolved write promises: the IndexedDB transaction reported `complete`. Whether the
   * committed pages survive power loss is the browser's and the operating system's decision.
   */
  readonly durability = "transaction-committed" as const;

  readonly #name: string;
  readonly #factory: IdbFactoryLike | undefined;
  #db: IdbDatabaseLike | null = null;
  #opening: Promise<IdbDatabaseLike> | null = null;

  constructor(options: IndexedDbBackendOptions) {
    if (typeof options.databaseName !== "string" || options.databaseName.trim() === "") {
      throw new Error("IndexedDbBackend requires a non-empty databaseName.");
    }
    this.#name = options.databaseName;
    this.#factory = options.indexedDB;
  }

  /** Whether an IndexedDB factory is reachable, so a caller can fall back to another store. */
  static available(indexedDB?: IdbFactoryLike): boolean {
    const factory = indexedDB ?? (globalThis as { indexedDB?: unknown }).indexedDB;
    return typeof factory === "object" && factory !== null && typeof (factory as IdbFactoryLike).open === "function";
  }

  /** The database name this adapter opens. */
  get databaseName(): string {
    return this.#name;
  }

  capabilities(): StorageCapabilities {
    return { history: false, enforced_cas: true, blobs: true, projections: false, backlinks: false };
  }

  /** Release the database handle. The next operation reopens it lazily. */
  close(): void {
    const db = this.#db;
    this.#db = null;
    this.#opening = null;
    db?.close();
  }

  // ── open and transact ────────────────────────────────────────────────────────────────

  #open(): Promise<IdbDatabaseLike> {
    if (this.#db) return Promise.resolve(this.#db);
    if (this.#opening) return this.#opening;
    const factory = this.#factory ?? (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB;
    if (!factory) {
      return Promise.reject(new Error("IndexedDB is not available in this host; pass a factory or use another backend."));
    }
    this.#opening = new Promise<IdbDatabaseLike>((resolve, reject) => {
      let refused: Error | null = null;
      const request = factory.open(this.#name, INDEXEDDB_SCHEMA_VERSION);
      request.onupgradeneeded = (event: { oldVersion?: number }) => {
        const oldVersion = typeof event?.oldVersion === "number" ? event.oldVersion : 0;
        if (oldVersion !== 0) {
          // No migration exists for an older layout. Abort the upgrade so the existing data is
          // left exactly as it was rather than reshaped by a guess.
          refused = new IndexedDbSchemaError(
            `IndexedDB database '${this.#name}' is at schema version ${oldVersion}; this adapter migrates only from an empty database to version ${INDEXEDDB_SCHEMA_VERSION}.`,
          );
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        for (const store of STORES) {
          db.createObjectStore(store, { keyPath: store === DOCUMENTS ? "id" : store === RESERVED ? "path" : "key" });
        }
      };
      request.onblocked = () => {
        // Another connection holds an older version open; the request stays pending until it
        // closes. Nothing to do here but let the caller's await wait.
      };
      request.onerror = () => {
        this.#opening = null;
        if (refused) {
          reject(refused);
          return;
        }
        const error = request.error;
        const name = error instanceof Error ? error.name : "";
        if (name === "VersionError") {
          reject(
            new IndexedDbSchemaError(
              `IndexedDB database '${this.#name}' is at a newer schema version than ${INDEXEDDB_SCHEMA_VERSION}; refusing to open it.`,
            ),
          );
          return;
        }
        reject(requestError(request, `IndexedDB open failed for '${this.#name}'`));
      };
      request.onsuccess = () => {
        const db = request.result;
        const missing = STORES.filter((store) => !db.objectStoreNames.contains(store));
        if (missing.length > 0 || db.objectStoreNames.length !== STORES.length) {
          db.close();
          this.#opening = null;
          reject(
            new IndexedDbSchemaError(
              `IndexedDB database '${this.#name}' does not carry this adapter's object stores (missing: ${missing.join(", ") || "none"}; expected exactly ${STORES.join(", ")}).`,
            ),
          );
          return;
        }
        // Another realm is upgrading this database; drop our handle so it is not blocked.
        db.onversionchange = () => this.close();
        this.#db = db;
        this.#opening = null;
        resolve(db);
      };
    });
    return this.#opening;
  }

  /**
   * Run `body` inside one transaction and resolve with its recorded result only after the
   * transaction reports `complete`. `fail` records an error and aborts; the rejection carries that
   * error. An abort from anywhere else (the host, a failed request) rejects with the transaction's
   * own error. Nothing outside IndexedDB is awaited inside `body`, which is what keeps a
   * check-then-write section inside the transaction's lifetime.
   */
  async #transact<T>(
    stores: string | string[],
    mode: "readonly" | "readwrite",
    body: (tx: IdbTransactionLike, done: (value: T) => void, fail: (error: Error) => void) => void,
  ): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: { value: T } | null = null;
      let failure: Error | null = null;
      tx.oncomplete = () => {
        if (result) resolve(result.value);
        else reject(new Error("IndexedDB transaction completed without a result."));
      };
      const rejectWith = () => {
        if (failure) reject(failure);
        else {
          // A host-initiated abort carries no error object; the transaction simply never committed.
          const error = tx.error;
          reject(error instanceof Error ? error : new Error("IndexedDB transaction aborted before commit."));
        }
      };
      tx.onabort = rejectWith;
      tx.onerror = () => {
        // An erroring request aborts the transaction; `onabort` reports it once.
      };
      const done = (value: T) => {
        result = { value };
      };
      const fail = (error: Error) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          // Already aborting or finished; the recorded failure still wins in `onabort`.
        }
      };
      try {
        body(tx, done, fail);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** One conditional read-compare-put over a keyed store, inside one readwrite transaction. */
  #compareAndSwap<R extends { version: Version }>(
    store: string,
    key: string,
    conflictId: string,
    expected: Version | null | undefined,
    decide: (current: R | undefined) => { record: R } | { version: Version },
  ): Promise<Version> {
    return this.#transact<Version>(store, "readwrite", (tx, done, fail) => {
      const objects = tx.objectStore(store);
      const read = objects.get(key);
      read.onerror = () => fail(requestError(read, `IndexedDB read failed for '${key}'`));
      read.onsuccess = () => {
        const current = read.result as R | undefined;
        const currentVersion = current?.version ?? null;
        if (expected !== undefined && expected !== currentVersion) {
          fail(new VersionConflict(conflictId, expected, currentVersion));
          return;
        }
        const decision = decide(current);
        if ("record" in decision) {
          const put = objects.put(decision.record);
          put.onerror = () => fail(requestError(put, `IndexedDB write failed for '${key}'`));
          done(decision.record.version);
        } else {
          done(decision.version);
        }
      };
    });
  }

  /** One conditional read-compare-delete over a keyed store, inside one readwrite transaction. */
  #compareAndDelete(store: string, key: string, conflictId: string, expected: Version | null | undefined): Promise<boolean> {
    return this.#transact<boolean>(store, "readwrite", (tx, done, fail) => {
      const objects = tx.objectStore(store);
      const read = objects.get(key);
      read.onerror = () => fail(requestError(read, `IndexedDB read failed for '${key}'`));
      read.onsuccess = () => {
        const current = read.result as { version: Version } | undefined;
        if (!current) {
          done(false); // absent: idempotent no-op, even under CAS
          return;
        }
        if (expected !== undefined && expected !== current.version) {
          fail(new VersionConflict(conflictId, expected, current.version));
          return;
        }
        const removal = objects.delete(key);
        removal.onerror = () => fail(requestError(removal, `IndexedDB delete failed for '${key}'`));
        done(true);
      };
    });
  }

  #getOne<R>(store: string, key: string): Promise<R | undefined> {
    return this.#transact<R | undefined>(store, "readonly", (tx, done) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => done(request.result as R | undefined);
    });
  }

  #keys(store: string, prefix?: string): Promise<string[]> {
    return this.#transact<string[]>(store, "readonly", (tx, done) => {
      const request = tx.objectStore(store).getAllKeys();
      request.onsuccess = () => done(sorted<string>(request.result, prefix));
    });
  }

  #has(store: string, key: string): Promise<boolean> {
    return this.#transact<boolean>(store, "readonly", (tx, done) => {
      const request = tx.objectStore(store).count(key);
      request.onsuccess = () => done(request.result > 0);
    });
  }

  // ── documents ─────────────────────────────────────────────────────────────────────────

  async read(id: ConceptId): Promise<ReadResult> {
    const [result] = await this.readMany([id]);
    return result!;
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    for (const id of ids) assertSafeConceptId(id);
    if (ids.length === 0) return [];
    // One readonly transaction fetches the documents and the root index.md together, so the
    // edition used to normalize frontmatter is the one that held when the documents were read.
    const { records, index } = await this.#transact<{ records: (DocumentRecord | undefined)[]; index: ReservedRecord | undefined }>(
      [DOCUMENTS, RESERVED],
      "readonly",
      (tx, done) => {
        const documents = tx.objectStore(DOCUMENTS);
        const records: (DocumentRecord | undefined)[] = new Array(ids.length);
        let index: ReservedRecord | undefined;
        let pending = ids.length + 1;
        const finish = () => {
          if (--pending === 0) done({ records, index });
        };
        ids.forEach((id, position) => {
          const request = documents.get(id);
          request.onsuccess = () => {
            records[position] = request.result as DocumentRecord | undefined;
            finish();
          };
        });
        const rootIndex = tx.objectStore(RESERVED).get(reservedKey("", "index.md"));
        rootIndex.onsuccess = () => {
          index = rootIndex.result as ReservedRecord | undefined;
          finish();
        };
      },
    );
    let edition: string | undefined;
    let editionResolved = false;
    const out: ReadResult[] = [];
    ids.forEach((id, position) => {
      const record = records[position];
      if (!record) throw notFound(id);
      if (!editionResolved) {
        edition = editionOf(index);
        editionResolved = true;
      }
      // Parse the stored serialization exactly as the filesystem adapter parses on-disk bytes,
      // so the read body is the normalized form and carries the same token.
      const { frontmatter, body } = parseMarkdown(record.raw, pathFromConceptId(id), { okfVersion: edition });
      out.push({ doc: { id, frontmatter, body }, version: record.version });
    });
    return out;
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const version = versionOfBytes(raw);
    // `options.agent` is accepted for contract parity and not persisted; the adapter keeps no
    // revision chain to attach it to.
    const updatedBy = options.actor?.trim() || defaultActor();
    return this.#compareAndSwap<DocumentRecord>(DOCUMENTS, id, id, options.expectedVersion, () => ({
      record: { id, raw, version, updatedBy, updatedAt: new Date().toISOString() },
    }));
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    return this.#compareAndDelete(DOCUMENTS, id, id, options.expectedVersion);
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return this.#has(DOCUMENTS, id);
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    return this.#keys(DOCUMENTS, prefix);
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const record = await this.#getOne<DocumentRecord>(DOCUMENTS, id);
    if (!record) return [];
    let frontmatter: Record<string, unknown> = {};
    try {
      frontmatter = parseMarkdown(record.raw, pathFromConceptId(id)).frontmatter;
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
    // Portable attribution in the document wins, as on disk; the recorded writer is the fallback
    // the filesystem cannot offer, and it defaults to the same local identity.
    const actor = mutationActorFromFrontmatter(frontmatter) ?? record.updatedBy;
    const timestamp = firstString(frontmatter.timestamp) ?? record.updatedAt;
    // Single current revision: this store retains no prior versions.
    return [{ version: record.version, actor, timestamp }];
  }

  // ── reserved files ─────────────────────────────────────────────────────────────────────

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    assertSafeReservedDir(dir);
    const record = await this.#getOne<ReservedRecord>(RESERVED, reservedKey(dir, name));
    if (!record) return null;
    return { content: record.content, version: record.version };
  }

  async writeReserved(dir: string, name: ReservedFilename, content: string, options: WriteOptions = {}): Promise<Version> {
    assertSafeReservedDir(dir);
    const path = reservedKey(dir, name);
    return this.#compareAndSwap<ReservedRecord>(RESERVED, path, path, options.expectedVersion, () => ({
      record: { path, content, version: versionOfBytes(content) },
    }));
  }

  // ── blobs ──────────────────────────────────────────────────────────────────────────────

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    const record = await this.#getOne<BlobRecord>(BLOBS, key);
    if (!record) return null;
    // A fresh copy: the caller must not alias the stored bytes.
    return { bytes: new Uint8Array(record.bytes), contentType: record.contentType, version: record.version };
  }

  async writeBlob(key: BlobKey, bytes: Uint8Array, contentType?: string, options: WriteOptions = {}): Promise<Version> {
    assertSafeBlobKey(key);
    const version = blobVersion(bytes);
    // This adapter keeps state, so an explicit content-type override persists, as in MemoryBackend.
    const resolvedType = resolveContentType(key, contentType);
    // `new Uint8Array(bytes)` copies element by element into a plain array, whatever TypedArray
    // subclass the caller handed over, so a later caller-side mutation cannot reach the store.
    const stored = new Uint8Array(bytes);
    return this.#compareAndSwap<BlobRecord>(BLOBS, key, key, options.expectedVersion, (current) => {
      if (current && current.version === version && current.contentType === resolvedType) return { version };
      return { record: { key, bytes: stored, contentType: resolvedType, version } };
    });
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    return this.#compareAndDelete(BLOBS, key, key, options.expectedVersion);
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    return this.#has(BLOBS, key);
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    return this.#keys(BLOBS, prefix);
  }
}
