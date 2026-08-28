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
 * serialized per logical identity across processes by a private runtime lock directory;
 * a process-local promise queue avoids filesystem polling among callers in one process.
 * `MemoryBackend`
 * (`memory-backend.ts`) implements the SAME contract for the hard case; a remote
 * (HTTP/CF/D1) adapter is a FUTURE plug-in, never a rewrite of the engine.
 *
 * This adapter touches no filesystem API itself. Every read and write goes through the
 * exact-identity protocol in `filesystem-identity.ts` with its production port, which is what
 * keeps two differently spelled ids from ever reaching one physical file on a case- or
 * normalization-insensitive filesystem.
 *
 * There is exactly ONE frontmatter parser (`frontmatter.ts`); this adapter uses it.
 * A remote backend that stores already-structured documents need not parse markdown
 * at all — parsing is an implementation detail of THIS adapter, not of the seam.
 */

import path from "node:path";

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
import {
  mutateExact,
  nodeFilesystemIdentityPort as port,
  observeExact,
  probeExact,
  type PortHandle,
} from "./filesystem-identity.js";
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

const publicationRoots = new WeakMap<FilesystemBackend, string>();

/** First trimmed non-empty string among `vals`, else `undefined`. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * True when a thrown fs error means "there is no FILE at this path" — absence (`ENOENT`,
 * `ENOTDIR`) or a directory sitting where a file was expected (`EISDIR`, the blob-key/directory
 * collision). Anything else (`EACCES`, `EPERM`, a disk error, …) is a REAL failure, not a "this
 * blob doesn't exist" signal, and must propagate — a blanket catch that mapped every error to
 * `null` would silently misreport a permissions problem as "absent."
 */
function isAbsentFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** The ENOENT-shaped rejection `read`/`readMany` promise for an absent document. */
function notFound(root: string, rel: string): NodeJS.ErrnoException {
  const target = path.join(root, rel);
  const err = new Error(`ENOENT: no such file or directory, open '${target}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "open";
  err.path = target;
  return err;
}

/** Observation read: every byte through the open handle; `null` when no file is there. */
async function readBytes(handle: PortHandle): Promise<Buffer | null> {
  try {
    return await port.readAll(handle);
  } catch (err) {
    if (isAbsentFileError(err)) return null;
    throw err;
  }
}

/** Recursively collect bundle-relative posix paths of files `keep` accepts (skips dot-entries). */
async function walkFiles(root: string, keep: (name: string) => boolean, sub = ""): Promise<string[]> {
  const entries = (await port.entries(path.join(root, sub))) ?? [];
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, temp files, dot-dirs: invisible to the walk
    const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.kind === "directory") {
      out.push(...(await walkFiles(root, keep, rel)));
    } else if (entry.kind === "file" && keep(entry.name)) {
      // `rel` is already assembled with `/`. Preserve any literal backslash in an entry name so
      // `list()` can reject it as a noncanonical on-disk identity instead of silently converting
      // it into a different nested concept id.
      out.push(rel);
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
  readonly #root: string;

  /**
   * The root is resolved once here: a relative root would otherwise re-resolve against the
   * process's current directory on every operation, so a later `chdir` would silently move the
   * bundle and derive a different identity key.
   */
  constructor(root: string) {
    this.#root = path.resolve(root);
    publicationRoots.set(this, this.#root);
  }

  async read(id: ConceptId): Promise<ReadResult> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const observed = await observeExact(port, this.#root, rel, readBytes);
    if (observed.state === "absent") throw notFound(this.#root, rel);
    const raw = observed.value.toString("utf8");
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
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? "");
    const rel = pathFromConceptId(id);
    // The whole check-then-write section runs inside one identity-keyed critical section, local
    // and same-user cross-process; an unconditional writer holds it too so it cannot move the
    // target between another process's version check and write.
    return mutateExact(port, this.#root, rel, async (target) => {
      if (options.expectedVersion !== undefined) {
        const bytes = await target.current();
        const current = bytes === null ? null : versionOfBytes(bytes.toString("utf8"));
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
      await target.replace(Buffer.from(raw, "utf8"));
      return versionOfBytes(raw);
    });
  }

  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    return mutateExact(port, this.#root, pathFromConceptId(id), async (target) => {
      const bytes = await target.current();
      if (bytes === null) return false; // absent ⇒ idempotent no-op, EVEN under CAS
      const current = versionOfBytes(bytes.toString("utf8"));
      if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
        throw new VersionConflict(id, options.expectedVersion, current);
      }
      await target.remove();
      // Empty parent dirs are intentionally NOT pruned (a write never prunes either) — a later
      // write to a sibling id under the same now-empty directory must not have to worry about
      // a missing directory tree.
      return true;
    });
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const rel = pathFromConceptId(id);
    const observed = await observeExact(port, this.#root, rel, async (handle, target) => {
      try {
        const bytes = await port.readAll(handle);
        // mtime is taken by path rather than through the open handle: the port has no
        // stat-by-handle call, and widening the protocol surface for a fallback timestamp used
        // only when the frontmatter carries none is not worth it. It cannot attribute another
        // entry's mtime to this identity: the post-walk that follows requires the leaf the
        // requested path reaches to still be this handle's inode and every directory segment to
        // still be its recorded one, so a swap between this call and that check restarts the
        // observation instead of returning EXACT — under the same A11 witness limit the walk
        // itself carries.
        const { mtime } = await port.stat(target);
        return { raw: bytes.toString("utf8"), mtime };
      } catch {
        return null; // no readable document ⇒ no history
      }
    });
    if (observed.state === "absent") return [];
    const { raw, mtime } = observed.value;
    const { frontmatter } = parseMarkdown(raw, rel);
    const actor = mutationActorFromFrontmatter(frontmatter) ?? defaultActor();
    const timestamp = firstString(frontmatter.timestamp) ?? mtime.toISOString();
    // Single current revision: a plain filesystem retains no prior versions.
    return [{ version: versionOfBytes(raw), actor, timestamp }];
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    return (await probeExact(port, this.#root, pathFromConceptId(id))).state === "exact";
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    const files = await walkFiles(this.#root, (name) => name.endsWith(".md"));
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
    const observed = await observeExact(port, this.#root, reservedPath(dir, name), readBytes);
    if (observed.state === "absent") return null;
    const content = observed.value.toString("utf8");
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
    // Same identity-keyed critical section as `write()`. A reserved-file read-modify-write
    // depends on a genuine `VersionConflict` under contention.
    return mutateExact(port, this.#root, rel, async (target) => {
      if (options.expectedVersion !== undefined) {
        const bytes = await target.current();
        const current = bytes === null ? null : versionOfBytes(bytes.toString("utf8"));
        if (current !== options.expectedVersion) {
          throw new VersionConflict(rel, options.expectedVersion, current);
        }
      }
      await target.replace(Buffer.from(content, "utf8"));
      return versionOfBytes(content);
    });
  }

  // ── blobs: opaque bytes + a content-type ──────────────────────────────────

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    // Absence (ENOENT) or a directory sitting at this path (EISDIR) is a normal "no blob here"
    // result; `readBytes` propagates everything else (EACCES, EPERM, …) as the real failure it is.
    const observed = await observeExact(port, this.#root, key, readBytes);
    if (observed.state === "absent") return null;
    const bytes = observed.value; // raw bytes, NO encoding (B1)
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
    // The WHOLE check-then-write section runs inside the identity lock, exactly like write(),
    // so N concurrent CAS writers to the SAME blob key queue instead of racing the version
    // check (B3). Raw-bytes versioning: hashing through a UTF-8 decode would corrupt binary (B1).
    return mutateExact(port, this.#root, key, async (target) => {
      if (options.expectedVersion !== undefined) {
        const existing = await target.current();
        const current = existing === null ? null : blobVersion(existing);
        if (current !== options.expectedVersion) {
          throw new VersionConflict(key, options.expectedVersion, current);
        }
      }
      // `contentType` (like `options.actor`) is accepted for contract parity but NOT
      // persisted here: the filesystem keeps no sidecar metadata store, so an explicit
      // override is honored at write time and re-inferred from the key extension on
      // every read instead (see readBlob) — mirrors write()'s actor-parity posture
      // exactly (B5). `MemoryBackend` persists it because it keeps state.
      await target.replace(bytes);
      return blobVersion(bytes);
    });
  }

  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    return mutateExact(port, this.#root, key, async (target) => {
      const existing = await target.current();
      if (existing === null) return false; // absent (or a directory-shaped path) ⇒ idempotent no-op
      const current = blobVersion(existing);
      if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
        throw new VersionConflict(key, options.expectedVersion, current);
      }
      await target.remove();
      return true;
    });
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    // A regular file only: a blob key that collides with an existing DIRECTORY (e.g. a sibling
    // key like `artifacts/x/y.bin` leaves `artifacts/x` a directory) must report `false` here,
    // matching MemoryBackend/RemoteBackend — neither has a filesystem notion of "a path that is
    // a directory," so a directory-counts-as-exists answer would break tri-adapter parity.
    const observed = await probeExact(port, this.#root, key);
    return observed.state === "exact" && observed.value.kind === "file";
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    // Skipping dot-entries is what excludes the adapter's own dot-prefixed temp files and `.git`
    // from a blob listing (I3), not just the write-time `assertSafeBlobKey` guard. The
    // `.md`-extension check is case-insensitive, mirroring `assertSafeBlobKey`.
    const files = await walkFiles(this.#root, (name) => !name.toLowerCase().endsWith(".md"));
    const keys = files.map(toPosix);
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

function publicationRoot(backend: FilesystemBackend): string {
  const root = publicationRoots.get(backend);
  if (!root) throw new InvalidInputError("Unknown filesystem backend publication source.");
  return root;
}

/** Internal exact-byte authority for the publication adapter; not part of StorageBackend. */
export async function readRawFilesystemDocument(
  backend: FilesystemBackend,
  id: ConceptId,
): Promise<{ bytes: Uint8Array; version: Version }> {
  assertSafeConceptId(id);
  const root = publicationRoot(backend);
  const rel = pathFromConceptId(id);
  const observed = await observeExact(port, root, rel, readBytes);
  if (observed.state === "absent") throw notFound(root, rel);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(observed.value);
  return { bytes: observed.value.slice(), version: versionOfBytes(raw) };
}

/** Internal exact-byte authority for reserved publication objects. */
export async function readRawFilesystemReserved(
  backend: FilesystemBackend,
  dir: string,
  name: ReservedFilename,
): Promise<{ bytes: Uint8Array; version: Version } | null> {
  assertSafeReservedDir(dir);
  const root = publicationRoot(backend);
  const observed = await observeExact(port, root, reservedPath(dir, name), readBytes);
  if (observed.state === "absent") return null;
  return {
    bytes: observed.value.slice(),
    version: versionOfBytes(observed.value.toString("utf8")),
  };
}

/** Internal canonical inventory of reserved publication objects. */
export async function listFilesystemReservedObjects(
  backend: FilesystemBackend,
): Promise<Array<{ dir: string; name: ReservedFilename }>> {
  const root = publicationRoot(backend);
  const files = await walkFiles(root, (name) => name === "index.md" || name === "log.md");
  return files
    .map((relative) => {
      const slash = relative.lastIndexOf("/");
      const dir = slash === -1 ? "" : relative.slice(0, slash);
      const name = relative.slice(slash + 1) as ReservedFilename;
      assertSafeReservedDir(dir);
      return { dir, name };
    })
    .sort((a, b) => reservedPath(a.dir, a.name).localeCompare(reservedPath(b.dir, b.name)));
}
