/**
 * Storage adapters for the OKF engine.
 *
 * The engine's disk-facing operations are expressed against {@link StorageBackend}
 * (declared in `types.ts`) so the store is PLUGGABLE. This module ships the DEFAULT
 * adapter — {@link FilesystemBackend} — which wraps the local filesystem: a bundle
 * is a directory tree of UTF-8 markdown files, written atomically (temp file +
 * rename). It is the DEGENERATE case of the seam's hard contract: `version` is the
 * SHA of the on-disk bytes, and `versions()` reports only the single current
 * revision because a plain filesystem keeps no history. Compare-and-swap is
 * serialized per physical target across processes by a private runtime lock directory;
 * a process-local promise queue avoids filesystem polling among callers in one process.
 * `MemoryBackend`
 * (`memory-backend.ts`) implements the SAME contract for the hard case; a remote
 * (HTTP/CF/D1) adapter is a FUTURE plug-in, never a rewrite of the engine.
 *
 * There is exactly ONE frontmatter parser (`frontmatter.ts`); this adapter uses it.
 * A remote backend that stores already-structured documents need not parse markdown
 * at all — parsing is an implementation detail of THIS adapter, not of the seam.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseMarkdown, stringifyDoc } from "./frontmatter.js";
import { resolveContentType } from "./content-type.js";
import {
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  conceptIdFromPath,
  isReservedFile,
  pathFromConceptId,
  toPosix,
} from "./paths.js";
import { InvalidInputError } from "./errors.js";
import { withFilesystemMutationLock } from "./filesystem-lock.js";
import { mutationActorFromFrontmatter } from "./mutation-attribution.js";
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
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

/** First trimmed non-empty string among `vals`, else `undefined`. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

// ── low-level fs helpers (the single home of the bundle's disk I/O) ───────────

/** True when a path exists on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a path exists on disk AND is a regular file — NOT `pathExists`, which reports
 * `true` for a directory too. A blob key that collides with an existing directory (e.g. a
 * sibling blob key `artifacts/x/y.bin` leaves `artifacts/x` a directory; probing
 * `existsBlob("artifacts/x")` afterward) must report `false`, matching `MemoryBackend`/
 * `RemoteBackend`, which have no such filesystem-only concept of "a path that is a directory."
 */
async function pathIsFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a thrown fs error means "there is no FILE at this path" — absence (`ENOENT`) or a
 * directory sitting where a file was expected (`EISDIR`, the blob-key/directory collision
 * `pathIsFile` also guards). Anything else (`EACCES`, `EPERM`, a disk error, …) is a REAL
 * failure, not a "this blob doesn't exist" signal, and must propagate — a blanket catch that
 * mapped every error to `null` would silently misreport a permissions problem as "absent."
 */
function isAbsentFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EISDIR";
}

/**
 * Atomic write: temp file in the destination dir, then rename over the target.
 *
 * The temp filename must be unique PER CALL, not just per process: a `serve()` process (or any
 * concurrent caller within one Node process) can issue two writes to the SAME target within the
 * same millisecond, and `pid + Date.now()` alone collide in that case — the second write's
 * `fs.writeFile` clobbers the first's temp file, and the first write's `fs.rename` then makes the
 * SECOND write's `fs.rename` fail with ENOENT (its temp file is already gone). Found via the CLI's
 * `--remote` multi-writer convergence test (N concurrent `link add`s to one doc through one
 * `serve()` process). `randomUUID()` makes the name collision-proof
 * regardless of clock resolution or process identity.
 */
async function atomicWrite(filePath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  // Widened for blobs (B1): a string writes as UTF-8 exactly as before; raw bytes
  // (Uint8Array/Buffer) write with NO encoding, so binary content is untouched.
  if (typeof content === "string") {
    await fs.writeFile(tmp, content, "utf8");
  } else {
    await fs.writeFile(tmp, content);
  }
  await fs.rename(tmp, filePath);
}

/** `fs.readdir(..., withFileTypes)` that yields `[]` instead of throwing on a missing dir. */
async function safeReaddir(abs: string) {
  try {
    return await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursively collect bundle-relative posix paths of every `.md` file (skips dot-dirs). */
async function walkMarkdown(root: string, sub = ""): Promise<string[]> {
  const abs = path.join(root, sub);
  const entries = await safeReaddir(abs);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip .git, temp files, etc.
    const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(root, rel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // `rel` is already assembled with `/`. Preserve any literal backslash in an entry name so
      // `list()` can reject it as a noncanonical on-disk identity instead of silently converting
      // it into a different nested concept id.
      out.push(rel);
    }
  }
  return out;
}

/**
 * Recursively collect bundle-relative posix paths of every NON-`.md` file (skips
 * dot-entries — I3: this is what excludes `atomicWrite`'s own dot-prefixed temp files,
 * `.git`, etc. from a blob listing, not just the write-time `assertSafeBlobKey` guard).
 * The `.md`-extension check is case-insensitive, mirroring `assertSafeBlobKey`.
 */
async function walkBlobs(root: string, sub = ""): Promise<string[]> {
  const abs = path.join(root, sub);
  const entries = await safeReaddir(abs);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dot-dirs/dot-files invisible to the walk
    const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkBlobs(root, rel)));
    } else if (entry.isFile() && !entry.name.toLowerCase().endsWith(".md")) {
      out.push(toPosix(rel));
    }
  }
  return out;
}

/** Bundle-relative reserved-file path for a directory (`""` = bundle root). */
function reservedPath(dir: string, name: ReservedFilename): string {
  const d = toPosix(dir).replace(/^\.?\//, "").replace(/\/$/, "");
  return d === "" ? name : `${d}/${name}`;
}

/**
 * The default {@link StorageBackend}: a filesystem-backed OKF bundle rooted at an
 * absolute directory. Concept documents are markdown files at `<id>.md`; reserved
 * files live at `<dir>/index.md` and `<dir>/log.md`.
 */
export class FilesystemBackend implements StorageBackend {
  private readonly root: string;

  /**
   * Per-resolved-path promise chain serializing writes within this process before the
   * same-user cross-process filesystem lock is acquired.
   *
   * `write()`/`writeReserved()`'s compare-and-swap is check-then-write across two
   * `await`s (read the current version, then `atomicWrite`): without serialization, N
   * concurrent writers targeting the SAME file can all observe the SAME pre-write
   * version, all pass the CAS check, and all proceed to write — every writer reports
   * success, only the last write survives, and no `VersionConflict` is ever thrown to
   * trigger a caller's retry loop. Queuing each write's full check-then-write critical
   * section behind this per-key chain avoids needless polling between local callers.
   * `withFilesystemMutationLock` then makes the same critical section exclusive across
   * independent processes, so at most one writer can satisfy a given version premise.
   * Reads stay lock-free because target replacement is atomic.
   *
   * STATIC, not per-instance: `core/src/bundle.ts`'s `backendFor()` constructs a FRESH
   * `FilesystemBackend` on every bundle operation when the caller passes a bare
   * `{ root }` (no explicit `backend`) — which is the shape `serve`/`openBundle` use
   * for every request. An instance-level map would give every concurrent write its own
   * empty lock table and serialize nothing; a process-wide map keyed by the RESOLVED
   * absolute path is what actually makes concurrent writers to the same physical file
   * queue behind each other, regardless of how many `FilesystemBackend` objects front
   * them. Different bundle roots never collide because their resolved paths differ, so
   * sharing the map across instances cannot cross-serialize unrelated bundles.
   *
   * Keyed by the RESOLVED absolute path so both `write()` (concept documents) and
   * `writeReserved()` (`index.md`/`log.md`) share one queue per physical file — the
   * only thing that actually needs serializing is contention on the same bytes.
   *
   * The external runtime lock is used for conditional and unconditional mutations alike: an
   * unconditional writer must not move the target between another process's version
   * check and write. A crash leftover fails closed with inspectable owner metadata.
   */
  private static readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Run `fn` after any prior write queued under `key` has settled (success or
   * failure), guaranteeing at most one in-flight critical section per key at a time —
   * across ALL `FilesystemBackend` instances in this process (see `locks`'s doc
   * comment on why the map is static). Must be called with NO prior `await` in the
   * caller since acquiring the tail from the map and re-registering it happen
   * synchronously here — that is what makes concurrent callers queue in call order
   * rather than racing each other for the map entry. The chain entry is deleted once
   * it drains and no newer waiter has replaced it, so a long-lived `serve` process
   * does not accumulate one `Map` entry per ever-written file.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = FilesystemBackend.locks;
    const tail = locks.get(key) ?? Promise.resolve();
    const locked = () => withFilesystemMutationLock(key, fn, { portableRoot: this.root });
    const run = tail.then(locked, locked);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return run;
  }

  /**
   * Join `rel` onto the bundle root and resolve it. Belt-and-suspenders containment: even
   * though every caller here first validates the id/dir it derived `rel` from
   * ({@link assertSafeConceptId} / {@link assertSafeReservedDir}), this asserts the
   * REALIZED path still lands inside the bundle root before any `fs` call touches it, so
   * a future caller that skips the upstream guard cannot escape the bundle either.
   */
  private abs(rel: string): string {
    const rootResolved = path.resolve(this.root);
    const resolved = path.resolve(rootResolved, rel);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new InvalidInputError(`Path '${rel}' resolves outside the bundle root.`);
    }
    return resolved;
  }

  async read(id: ConceptId): Promise<ReadResult> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const raw = await fs.readFile(this.abs(rel), "utf8");
    const { frontmatter, body } = parseMarkdown(raw, rel);
    return { doc: { id, frontmatter, body }, version: versionOfBytes(raw) };
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    // Validate every id BEFORE any path realization (not just the first that `read`
    // would hit) — degenerate batch read: a loop of single reads, since a local
    // filesystem has no per-read round-trip to amortize. A networked backend implements
    // this as one multi-get, which is the whole reason `readMany` is on the seam.
    for (const id of ids) assertSafeConceptId(id);
    const out: ReadResult[] = [];
    for (const id of ids) out.push(await this.read(id));
    return out;
  }

  /** Current version of the file at the already-resolved `absPath`, or `null` if absent. */
  private async currentVersionAt(absPath: string): Promise<Version | null> {
    try {
      return versionOfBytes(await fs.readFile(absPath, "utf8"));
    } catch (err) {
      if (isAbsentFileError(err)) return null;
      throw err;
    }
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const target = this.abs(pathFromConceptId(id));
    // The whole check-then-write section runs inside one local + same-user cross-process critical section.
    return this.withLock(target, async () => {
      if (options.expectedVersion !== undefined) {
        // Compare-and-swap: hash the current bytes and compare while every filesystem
        // mutation of this physical target is excluded by the same lock.
        const current = await this.currentVersionAt(target);
        if (current !== options.expectedVersion) {
          throw new VersionConflict(id, options.expectedVersion, current);
        }
      }
      // `options.actor` is accepted for contract parity but NOT persisted here: the
      // filesystem keeps no history, and stamping it into frontmatter would both change
      // existing CLI output and diverge the document from other backends. `versions()`
      // reports actor from the portable mutation-attribution projection if present, else a
      // local default — an honest degenerate answer. `options.agent` is likewise
      // accepted-but-not-persisted (this degenerate adapter records no agent at all).
      await atomicWrite(target, raw);
      return versionOfBytes(raw);
    });
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    const target = this.abs(pathFromConceptId(id));
    // Same per-key mutex as write() — the whole check-then-unlink section runs as one
    // critical section per resolved path, so a concurrent delete/write racer observes a
    // consistent pre-op version rather than a torn check.
    return this.withLock(target, async () => {
      const current = await this.currentVersionAt(target);
      if (current === null) return false; // absent ⇒ idempotent no-op, EVEN under CAS
      if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
        throw new VersionConflict(id, options.expectedVersion, current);
      }
      await fs.unlink(target);
      // Empty parent dirs are intentionally NOT pruned (mirrors atomicWrite, which never
      // prunes either) — a later write to a sibling id under the same now-empty directory
      // must not have to worry about a missing directory tree.
      return true;
    });
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const p = this.abs(pathFromConceptId(id));
    let raw: string;
    let mtime: Date;
    try {
      raw = await fs.readFile(p, "utf8");
      mtime = (await fs.stat(p)).mtime;
    } catch {
      return []; // no document ⇒ no history
    }
    const { frontmatter } = parseMarkdown(raw, pathFromConceptId(id));
    const actor = mutationActorFromFrontmatter(frontmatter) ?? defaultActor();
    const timestamp = firstString(frontmatter.timestamp) ?? mtime.toISOString();
    // Single current revision: a plain filesystem retains no prior versions.
    return [{ version: versionOfBytes(raw), actor, timestamp }];
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return pathExists(this.abs(pathFromConceptId(id)));
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    const files = await walkMarkdown(this.root);
    const ids: ConceptId[] = [];
    for (const rel of files) {
      if (isReservedFile(rel)) continue;
      const id = conceptIdFromPath(rel);
      assertSafeConceptId(id);
      if (pathFromConceptId(id) !== rel) {
        throw new InvalidInputError(
          `Concept path '${rel}' does not round-trip through canonical id '${id}'. Rename the file to '${pathFromConceptId(id)}'.`,
        );
      }
      if (prefix && !id.startsWith(prefix)) continue;
      ids.push(id);
    }
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
  }

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    assertSafeReservedDir(dir);
    const p = this.abs(reservedPath(dir, name));
    if (!(await pathExists(p))) return null;
    const content = await fs.readFile(p, "utf8");
    // Reserved files are unparsed markdown, so the version is the content-address of the
    // raw bytes — the same digest a concept document's on-disk bytes carry.
    return { content, version: versionOfBytes(content) };
  }

  async writeReserved(
    dir: string,
    name: ReservedFilename,
    content: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertSafeReservedDir(dir);
    const rel = reservedPath(dir, name);
    const target = this.abs(rel);
    // Same per-key serialization as `write()` — see `locks`'s doc comment. A reserved-file
    // read-modify-write depends on a genuine `VersionConflict` under contention.
    return this.withLock(target, async () => {
      if (options.expectedVersion !== undefined) {
        const current = await this.currentVersionAt(target);
        if (current !== options.expectedVersion) {
          throw new VersionConflict(rel, options.expectedVersion, current);
        }
      }
      await atomicWrite(target, content);
      return versionOfBytes(content);
    });
  }

  // ── blobs: opaque bytes + a content-type ──────────────────────────────────

  /** Current RAW-BYTES version of the blob at the already-resolved `absPath`, or `null` if absent. Reads with NO encoding — reusing the doc-shaped `currentVersionAt` would corrupt binary content via UTF-8 decoding (B1). */
  private async currentBlobVersionAt(absPath: string): Promise<Version | null> {
    try {
      return blobVersion(await fs.readFile(absPath));
    } catch (err) {
      if (isAbsentFileError(err)) return null;
      throw err;
    }
  }

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.abs(key)); // NO encoding — raw bytes (B1)
    } catch (err) {
      // Absence (ENOENT) or a directory sitting at this path (EISDIR) is a normal "no blob
      // here" result. Anything else (EACCES, EPERM, …) is a REAL failure and must propagate
      // — a blanket catch would silently misreport a permissions problem as "absent."
      if (isAbsentFileError(err)) return null;
      throw err;
    }
    // Content-type is ALWAYS inferred-on-read here: the filesystem adapter accepts but
    // does not persist an explicit override at write time (see writeBlob's doc comment,
    // B5) — there is no sidecar to read it back from.
    return { bytes, contentType: resolveContentType(key), version: blobVersion(bytes) };
  }

  async writeBlob(
    key: BlobKey,
    bytes: Uint8Array,
    _contentType?: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertSafeBlobKey(key);
    const target = this.abs(key);
    // The WHOLE check-then-write section runs inside `withLock`, exactly like write() —
    // the same static per-resolved-path mutex docs/reserved files use, so N concurrent
    // CAS writers to the SAME blob key queue instead of racing the version check (B3).
    return this.withLock(target, async () => {
      if (options.expectedVersion !== undefined) {
        const current = await this.currentBlobVersionAt(target);
        if (current !== options.expectedVersion) {
          throw new VersionConflict(key, options.expectedVersion, current);
        }
      }
      // `contentType` (like `options.actor`) is accepted for contract parity but NOT
      // persisted here: the filesystem keeps no sidecar metadata store, so an explicit
      // override is honored at write time and re-inferred from the key extension on
      // every read instead (see readBlob) — mirrors write()'s actor-parity posture
      // exactly (B5). `MemoryBackend` persists it because it keeps state.
      await atomicWrite(target, bytes);
      return blobVersion(bytes);
    });
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    const target = this.abs(key);
    // Same per-key mutex as writeBlob() — see delete()'s comment above for why the whole
    // check-then-unlink section must run as one critical section.
    return this.withLock(target, async () => {
      const current = await this.currentBlobVersionAt(target);
      if (current === null) return false; // absent (or a directory-shaped path) ⇒ idempotent no-op
      if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
        throw new VersionConflict(key, options.expectedVersion, current);
      }
      await fs.unlink(target);
      return true;
    });
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    // `pathIsFile`, NOT `pathExists`: a blob key that collides with an existing DIRECTORY
    // (e.g. a sibling key like `artifacts/x/y.bin` leaves `artifacts/x` a directory) must
    // report `false` here, matching MemoryBackend/RemoteBackend — neither has a filesystem
    // notion of "a path that is a directory," so `pathExists`'s directory-counts-as-exists
    // answer would break tri-adapter parity.
    return pathIsFile(this.abs(key));
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    const keys = await walkBlobs(this.root);
    const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    filtered.sort((a, b) => a.localeCompare(b));
    return filtered;
  }

  capabilities() {
    return {
      history: false,
      enforced_cas: true,
      blobs: true,
      projections: true,
      backlinks: false,
    } as const;
  }
}
