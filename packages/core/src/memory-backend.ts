/**
 * In-memory {@link StorageBackend} — the PROOF that the seam's hard contract is
 * implementable, and that the engine leaks no filesystem assumptions.
 *
 * Where {@link FilesystemBackend} is the degenerate adapter (single-version history,
 * cross-process filesystem compare-and-swap), this adapter implements the historical hard case:
 *   - a genuine per-document VERSION CHAIN (`versions()` returns the full history,
 *     newest-first);
 *   - ENFORCED compare-and-swap: a `write` whose `expectedVersion` no longer matches
 *     the current head throws {@link VersionConflict}, atomically against the in-process
 *     map (no check-then-write window);
 *   - per-write ACTOR attribution recorded on every revision;
 *   - a real batch {@link MemoryBackend.readMany}.
 *
 * It touches NO filesystem and NO markdown serialization for storage — documents are
 * held as parsed {@link OkfDocument} objects, keyed by concept id — so running the
 * core operations over it exercises exactly the parts of the engine that must be
 * backend-neutral. Version tokens are still content-addressed via {@link contentVersion},
 * so an engine-written document carries the SAME token here as on disk.
 *
 * Id/dir safety mirrors {@link FilesystemBackend} exactly: an unsafe concept id (a `..`
 * segment, an absolute id) or an unsafe reserved-file `dir` is harmless against a plain
 * `Map` key, but this adapter rejects it via the SAME `assertSafeConceptId` /
 * `assertSafeReservedDir` guards anyway — the two adapters must agree on rejecting it, or
 * the dual-backend / wire-protocol contract tests diverge.
 */

import { resolveContentType } from "./content-type.js";
import { assertSafeBlobKey, assertSafeConceptId, assertSafeReservedDir, assertSafeReservedFilename, compareStorageKeys } from "./paths.js";
import { blobVersion, contentVersion, defaultActor, VersionConflict, versionOfBytes } from "./versioning.js";
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
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

/** One recorded revision in a document's in-memory version chain. */
interface Revision {
  version: Version;
  actor: string;
  timestamp: string;
  /** The client-declared agent label attested under `actor`, when one was given. Absent otherwise. */
  agent?: string;
  /** A defensively-cloned snapshot of the document at this revision. */
  doc: OkfDocument;
}

/** Deep copy so stored state never aliases a caller's object (and vice-versa). */
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/**
 * One in-memory blob's current state (bytes + resolved content-type + version). No
 * history chain — I7: blob actor attribution is unobservable in v1 (there is no
 * `blobVersions` on the seam), so unlike {@link Revision} this holds only the CURRENT
 * state; growing a parallel blob-history mechanism here would be scope the seam does
 * not ask for.
 */
interface BlobState {
  bytes: Uint8Array;
  contentType: string;
  version: Version;
}

/** An ENOENT-shaped rejection so missing-document handling matches {@link FilesystemBackend}. */
function notFound(id: ConceptId): NodeJS.ErrnoException {
  const err = new Error(`no concept document '${id}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Bundle-relative key for a reserved file (`""` = bundle root), mirroring the fs adapter's layout. */
function reservedKey(dir: string, name: ReservedFilename): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * A fully in-memory OKF store implementing the {@link StorageBackend} contract for
 * the hard, multi-writer case. Not persistent — its purpose is to prove the seam and
 * to back tests, not to be a shipping store.
 */
export class MemoryBackend implements StorageBackend {
  /** Concept id → revision chain, newest-first (index 0 is the head). */
  private readonly chains = new Map<ConceptId, Revision[]>();
  /** Reserved-file path → raw content. */
  private readonly reserved = new Map<string, string>();
  /** Blob key → current state. Separate from `chains` — a different namespace, no history. */
  private readonly blobs = new Map<BlobKey, BlobState>();

  async read(id: ConceptId): Promise<ReadResult> {
    // An unsafe id is harmless against a plain Map key, but the two adapters must AGREE
    // on rejecting it — otherwise the dual-backend/wire contract tests diverge.
    assertSafeConceptId(id);
    const head = this.chains.get(id)?.[0];
    if (!head) throw notFound(id);
    return { doc: snapshot(head.doc), version: head.version };
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    // Validate every id up front (same contract as FilesystemBackend.readMany), then a
    // real multi-get: one pass over the in-memory index, results in input order.
    for (const id of ids) assertSafeConceptId(id);
    return Promise.all(ids.map((id) => this.read(id)));
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    const chain = this.chains.get(id);
    const current = chain?.[0]?.version ?? null;
    // Enforced compare-and-swap, atomic against the in-process map.
    if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
      throw new VersionConflict(id, options.expectedVersion, current);
    }
    // The seam's `id` argument owns identity. Filesystem and wire adapters reconstruct/attach
    // that route id on reads because document bytes do not serialize `doc.id`; mirror them here
    // instead of retaining a mismatched caller-supplied `doc.id` in the in-memory snapshot.
    const storedDoc = { ...doc, id };
    const version = contentVersion(storedDoc);
    // Idempotent: re-writing byte-identical content is a no-op that does not grow the
    // chain (the content address is unchanged). A genuine content change appends a revision.
    if (current === version) return version;
    const revision: Revision = {
      version,
      actor: options.actor?.trim() || defaultActor(),
      timestamp: new Date().toISOString(),
      // Unlike `actor`, an unattested agent is simply absent — no default is applied.
      agent: options.agent?.trim() || undefined,
      doc: snapshot(storedDoc),
    };
    this.chains.set(id, chain ? [revision, ...chain] : [revision]);
    return version;
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    const chain = this.chains.get(id);
    const current = chain?.[0]?.version ?? null;
    if (current === null) return false; // absent ⇒ idempotent no-op, EVEN under CAS
    // Enforced compare-and-swap, atomic against the in-process map (no check-then-write
    // window — synchronous with no `await` between the check above and the mutation below).
    if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
      throw new VersionConflict(id, options.expectedVersion, current);
    }
    // D5: the whole chain is purged, not just the head — `versions(id)` reports `[]`
    // afterward, matching a never-written concept (a delete's history is unobservable).
    this.chains.delete(id);
    return true;
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return this.chains.has(id);
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    const ids = [...this.chains.keys()].filter((id) => !prefix || id.startsWith(prefix));
    ids.sort(compareStorageKeys);
    return ids;
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const chain = this.chains.get(id) ?? [];
    // Strip the stored doc snapshot; expose only the history metadata (newest-first).
    // `agent` is omitted (not merely `undefined`-valued) when the revision was never
    // agent-attested, so a never-agent'd revision serializes clean over the wire.
    return chain.map(({ version, actor, timestamp, agent }) =>
      agent === undefined ? { version, actor, timestamp } : { version, actor, timestamp, agent },
    );
  }

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    assertSafeReservedDir(dir);
    assertSafeReservedFilename(name);
    const content = this.reserved.get(reservedKey(dir, name));
    if (content === undefined) return null;
    // Content-addressed, so the token matches the filesystem adapter's for identical bytes.
    return { content, version: versionOfBytes(content) };
  }

  async writeReserved(
    dir: string,
    name: ReservedFilename,
    content: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertSafeReservedDir(dir);
    assertSafeReservedFilename(name);
    const key = reservedKey(dir, name);
    const existing = this.reserved.get(key);
    const current = existing === undefined ? null : versionOfBytes(existing);
    // Enforced compare-and-swap, atomic against the in-process map (no check-then-write window).
    if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
      throw new VersionConflict(key, options.expectedVersion, current);
    }
    this.reserved.set(key, content);
    return versionOfBytes(content);
  }

  // ── blobs: opaque bytes + a content-type ──────────────────────────────────

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    const entry = this.blobs.get(key);
    if (!entry) return null;
    // `new Uint8Array(entry.bytes)`, NOT `entry.bytes.slice()`: a `Buffer` (the shape
    // every real caller's bytes actually are — `fs.readFile`, the CLI's `promote`)
    // OVERRIDES `.slice()` to return a VIEW onto the SAME underlying ArrayBuffer, not a
    // copy — a caller mutating its own buffer after the fact would silently mutate the
    // "stored" blob too. The constructor form always copies element-by-element into a
    // fresh buffer, regardless of the input's concrete TypedArray subclass.
    return { bytes: new Uint8Array(entry.bytes), contentType: entry.contentType, version: entry.version };
  }

  async writeBlob(
    key: BlobKey,
    bytes: Uint8Array,
    contentType?: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertSafeBlobKey(key);
    const existing = this.blobs.get(key);
    const current = existing?.version ?? null;
    // Enforced compare-and-swap, atomic against the in-process map (no check-then-write window).
    if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
      throw new VersionConflict(key, options.expectedVersion, current);
    }
    const version = blobVersion(bytes);
    // Unlike FilesystemBackend, this adapter KEEPS STATE, so an explicit content-type
    // override is persisted (not merely inferred-on-read) — the documented divergence
    // the tri-adapter contentType parity test pins (B5).
    const resolvedType = resolveContentType(key, contentType);
    // Idempotent: a byte-identical AND content-type-identical re-write is a true
    // same-version no-op (I7) — mirrors write()'s content-address idempotency.
    if (existing && existing.version === version && existing.contentType === resolvedType) {
      return version;
    }
    // See readBlob's comment: `new Uint8Array(bytes)`, never `bytes.slice()` (a Buffer's
    // `.slice()` returns a shared VIEW, not a copy) — the caller's own buffer must not
    // alias what gets stored.
    this.blobs.set(key, { bytes: new Uint8Array(bytes), contentType: resolvedType, version });
    return version;
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    const existing = this.blobs.get(key);
    const current = existing?.version ?? null;
    if (current === null) return false; // absent ⇒ idempotent no-op, EVEN under CAS
    if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
      throw new VersionConflict(key, options.expectedVersion, current);
    }
    this.blobs.delete(key);
    return true;
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    return this.blobs.has(key);
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    const keys = [...this.blobs.keys()].filter((k) => !prefix || k.startsWith(prefix));
    keys.sort(compareStorageKeys);
    return keys;
  }
}
