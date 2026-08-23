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

/** Only a genuine missing entry is ordinary absence. */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** An ENOENT-shaped rejection so filesystem and non-filesystem adapters agree on a missing doc. */
function notFound(id: string): NodeJS.ErrnoException {
  const err = new Error(`no concept document '${id}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
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

/** A missing scan directory is empty; every other filesystem failure remains observable. */
async function readDirectory(abs: string) {
  try {
    return await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** Recursively collect bundle-relative posix paths of every `.md` file (skips dot-dirs). */
async function walkMarkdown(root: string, sub = ""): Promise<string[]> {
  const abs = path.join(root, sub);
  const entries = await readDirectory(abs);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip .git, temp files, etc.
    const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".md")) {
        throw new InvalidInputError(`Filesystem entry '${rel}' is a directory where a document or reserved file is required.`);
      }
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
  const entries = await readDirectory(abs);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dot-dirs/dot-files invisible to the walk
    const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase().endsWith(".md")) {
        throw new InvalidInputError(`Filesystem entry '${rel}' is a directory in the document namespace.`);
      }
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

  /** How one operation intentionally projects a directory at a file-shaped target. */
  private static readonly directoryAsAbsent = "absent" as const;
  private static readonly directoryAsInvalid = "invalid" as const;

  /**
   * Per-bundle promise chain serializing writes within this process before the same-user
   * cross-process filesystem lock is acquired.
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
   * Keyed by the resolved bundle root. A target-only lock cannot protect two names that are
   * distinct logically but alias while a case-/normalization-folding filesystem creates them;
   * serializing the realization + write decision at the bundle boundary closes that creation
   * race. The target lock remains nested below it for its existing cross-process receipts.
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
   * Run `fn` after any prior mutation for this bundle has settled (success or
   * failure), guaranteeing one in-flight realization/write decision per bundle —
   * across ALL `FilesystemBackend` instances in this process (see `locks`'s doc
   * comment on why the map is static). Must be called with NO prior `await` in the
   * caller since acquiring the tail from the map and re-registering it happen
   * synchronously here — that is what makes concurrent callers queue in call order
   * rather than racing each other for the map entry. The chain entry is deleted once
   * it drains and no newer waiter has replaced it, so a long-lived `serve` process
   * does not accumulate one `Map` entry per ever-opened bundle.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = FilesystemBackend.locks;
    const bundleKey = path.resolve(this.root);
    const tail = locks.get(bundleKey) ?? Promise.resolve();
    const locked = () =>
      withFilesystemMutationLock(
        bundleKey,
        () => withFilesystemMutationLock(key, fn, { portableRoot: this.root }),
        { portableRoot: this.root },
      );
    const run = tail.then(locked, locked);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(bundleKey, settled);
    void settled.then(() => {
      if (locks.get(bundleKey) === settled) locks.delete(bundleKey);
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

  /**
   * Verify every existing component is exactly the requested component, not merely a
   * case-/normalization-folded lookup accepted by the host filesystem. `readdir` is the spelling
   * authority: JavaScript `realpath` can preserve the request's alias on APFS. `realpath` below
   * remains only a symlink/physical-containment check after an exact directory entry is found.
   */
  private async assertExactRealization(rel: string): Promise<void> {
    const root = path.resolve(this.root);
    let physicalRoot: string;
    try {
      physicalRoot = await fs.realpath(root);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }

    const components = rel.split("/");
    for (let i = 0; i < components.length; i += 1) {
      const expected = path.join(physicalRoot, ...components.slice(0, i + 1));
      const parent = path.dirname(expected);
      const component = components[i]!;
      const entries = await readDirectory(parent);
      if (!entries.some((entry) => entry.name === component)) {
        try {
          // A successful lookup without a byte-for-byte directory entry is precisely a folded
          // alias. A genuinely absent suffix remains absent and is classified by lstat below.
          await fs.lstat(expected);
        } catch (err) {
          if (isEnoent(err)) return;
          throw err;
        }
        throw new InvalidInputError(
          `Filesystem target '${rel}' does not realize with its exact spelling and normalization.`,
        );
      }

      let realized: string;
      try {
        realized = await fs.realpath(expected);
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }
      if (realized !== expected) {
        throw new InvalidInputError(
          `Filesystem target '${rel}' does not realize with its exact spelling and normalization.`,
        );
      }
    }
  }

  /**
   * The one authority for file-shaped targets. It never converts a real I/O fault into absence.
   * Document and reserved-file operations reject directories; blob read/exists/delete retain
   * their legacy directory-as-absence projection by opting into it explicitly at each call site.
   */
  private async realizeFileTarget(
    rel: string,
    directoryProjection: "absent" | "invalid",
  ): Promise<{ path: string; state: "missing" | "file" }> {
    const target = this.abs(rel);
    await this.assertExactRealization(rel);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (err) {
      if (isEnoent(err)) return { path: target, state: "missing" };
      throw err;
    }
    if (stat.isFile()) return { path: target, state: "file" };
    if (stat.isDirectory() && directoryProjection === FilesystemBackend.directoryAsAbsent) {
      return { path: target, state: "missing" };
    }
    const shape = stat.isDirectory() ? "a directory" : "not a regular file";
    throw new InvalidInputError(`Filesystem target '${rel}' is ${shape}, where a regular file is required.`);
  }

  private async currentVersionAt(rel: string): Promise<Version | null> {
    const entry = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
    if (entry.state === "missing") return null;
    return versionOfBytes(await fs.readFile(entry.path, "utf8"));
  }

  private async currentBlobVersionAt(rel: string): Promise<Version | null> {
    const entry = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsAbsent);
    if (entry.state === "missing") return null;
    return blobVersion(await fs.readFile(entry.path));
  }

  async read(id: ConceptId): Promise<ReadResult> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const entry = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
    if (entry.state === "missing") throw notFound(id);
    const raw = await fs.readFile(entry.path, "utf8");
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

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const target = this.abs(rel);
    // The whole check-then-write section runs inside one local + same-user cross-process critical section.
    return this.withLock(target, async () => {
      await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
      if (options.expectedVersion !== undefined) {
        // Compare-and-swap: hash the current bytes and compare while every filesystem
        // mutation of this physical target is excluded by the same lock.
        const current = await this.currentVersionAt(rel);
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
      const realized = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
      if (realized.state !== "file") throw new InvalidInputError(`Filesystem target '${rel}' was not created as a regular file.`);
      return versionOfBytes(raw);
    });
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const target = this.abs(rel);
    // Same per-key mutex as write() — the whole check-then-unlink section runs as one
    // critical section per resolved path, so a concurrent delete/write racer observes a
    // consistent pre-op version rather than a torn check.
    return this.withLock(target, async () => {
      const current = await this.currentVersionAt(rel);
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
    const rel = pathFromConceptId(id);
    const entry = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
    if (entry.state === "missing") return [];
    let raw: string;
    let mtime: Date;
    try {
      raw = await fs.readFile(entry.path, "utf8");
      mtime = (await fs.stat(entry.path)).mtime;
    } catch (err) {
      if (isEnoent(err)) return []; // deleted after realization ⇒ no history
      throw err;
    }
    const { frontmatter } = parseMarkdown(raw, pathFromConceptId(id));
    const actor = mutationActorFromFrontmatter(frontmatter) ?? defaultActor();
    const timestamp = firstString(frontmatter.timestamp) ?? mtime.toISOString();
    // Single current revision: a plain filesystem retains no prior versions.
    return [{ version: versionOfBytes(raw), actor, timestamp }];
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return (await this.realizeFileTarget(pathFromConceptId(id), FilesystemBackend.directoryAsInvalid)).state === "file";
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    const files = await walkMarkdown(this.root);
    const ids: ConceptId[] = [];
    for (const rel of files) {
      if (isReservedFile(rel)) continue;
      await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
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
    const rel = reservedPath(dir, name);
    const entry = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
    if (entry.state === "missing") return null;
    const content = await fs.readFile(entry.path, "utf8");
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
      await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
      if (options.expectedVersion !== undefined) {
        const current = await this.currentVersionAt(rel);
        if (current !== options.expectedVersion) {
          throw new VersionConflict(rel, options.expectedVersion, current);
        }
      }
      await atomicWrite(target, content);
      const realized = await this.realizeFileTarget(rel, FilesystemBackend.directoryAsInvalid);
      if (realized.state !== "file") throw new InvalidInputError(`Filesystem target '${rel}' was not created as a regular file.`);
      return versionOfBytes(content);
    });
  }

  // ── blobs: opaque bytes + a content-type ──────────────────────────────────

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    const entry = await this.realizeFileTarget(key, FilesystemBackend.directoryAsAbsent);
    if (entry.state === "missing") return null;
    const bytes = await fs.readFile(entry.path); // NO encoding — raw bytes (B1)
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
    // the same bundle mutation lock docs/reserved files use, so creation aliases cannot race.
    return this.withLock(target, async () => {
      await this.realizeFileTarget(key, FilesystemBackend.directoryAsInvalid);
      if (options.expectedVersion !== undefined) {
        const current = await this.currentBlobVersionAt(key);
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
      const realized = await this.realizeFileTarget(key, FilesystemBackend.directoryAsInvalid);
      if (realized.state !== "file") throw new InvalidInputError(`Filesystem target '${key}' was not created as a regular file.`);
      return blobVersion(bytes);
    });
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    const target = this.abs(key);
    // Same per-key mutex as writeBlob() — see delete()'s comment above for why the whole
    // check-then-unlink section must run as one critical section.
    return this.withLock(target, async () => {
      const current = await this.currentBlobVersionAt(key);
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
    return (await this.realizeFileTarget(key, FilesystemBackend.directoryAsAbsent)).state === "file";
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    const keys = await walkBlobs(this.root);
    for (const key of keys) await this.realizeFileTarget(key, FilesystemBackend.directoryAsAbsent);
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
