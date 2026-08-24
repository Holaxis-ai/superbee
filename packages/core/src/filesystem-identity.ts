/**
 * Exact filesystem identity for the filesystem adapter.
 *
 * A bundle-relative path `rel` names ONE physical entry only when every segment's on-disk
 * spelling equals the requested spelling. On a case- or normalization-insensitive filesystem
 * (case-insensitive APFS, NTFS, ext4 casefold, normalization-insensitive APFS) two distinct
 * canonical ids would otherwise reach one file, so reads, compare-and-swap, and deletes would
 * alias. This module is the single owner of that decision:
 *
 * - Observations verify the spelling of every `rel` segment before and after use and bind the
 *   bytes to the entry through an inode witness. They hold no lock and write nothing, so an
 *   absent bundle root stays absent.
 * - Mutations hold one cross-process lock keyed by a pure fold of the root and `rel`, decide
 *   inside it, and create directories one segment at a time with a spelling check, so a
 *   first-creation race cannot succeed with the wrong spelling.
 *
 * Exactness applies to `rel` segments only. The bundle root is the declared storage context:
 * a root (tail) segment that already exists as a directory under any spelling is accepted,
 * and the root's spelling is folded into the lock key rather than verified.
 *
 * Every filesystem call goes through a {@link FilesystemIdentityPort} passed to the protocol
 * functions. Production binds {@link nodeFilesystemIdentityPort} once, as a module constant;
 * nothing on a backend instance can substitute it. Normalizing stores that rewrite names on
 * write (legacy HFS+) are unsupported: an id whose NFD form differs from its own form is written
 * and then refused as an alias on every later observation, never silently aliased.
 */

import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { ConcurrentReplacementError, FilesystemIdentityAliasError, InvalidInputError } from "./errors.js";
import { acquireFilesystemIdentityLock } from "./filesystem-lock.js";

export type EntryKind = "file" | "directory" | "symlink" | "other";

/** The `(dev, ino)` pair that binds a name to a physical entry for one observation. */
export interface EntryWitness {
  dev: number;
  ino: number;
}

export interface ProbeResult extends EntryWitness {
  kind: EntryKind;
}

export interface ListedEntry extends ProbeResult {
  name: string;
}

export interface ReadWitness extends EntryWitness {
  bytes: Buffer;
}

export interface IdentityDescriptor {
  root: string;
  rel: string;
}

/**
 * The complete filesystem surface the protocol needs. `mkdir` is deliberately NON-recursive:
 * exact directory creation is decided one segment at a time against the parent listing.
 */
export interface FilesystemIdentityPort {
  /** `lstat`; `null` when nothing is at the path (ENOENT or ENOTDIR). */
  probe(target: string): Promise<ProbeResult | null>;
  /** Directory listing with each entry's kind and witness; `null` when the directory is absent. */
  entries(dir: string): Promise<ListedEntry[] | null>;
  /** Open, `fstat` the handle, read every byte, close; throws the filesystem error otherwise. */
  readFile(target: string): Promise<ReadWitness>;
  stat(target: string): Promise<{ mtime: Date }>;
  mkdir(dir: string): Promise<"created" | "exists">;
  writeTemp(dir: string, name: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  claim(key: string, identity: IdentityDescriptor): Promise<() => Promise<void>>;
}

/**
 * A regular file where a directory is needed (or the reverse) at an exactly spelled segment.
 * A runtime state of the bundle, not a caller-input error, so it is not an `InvalidInputError`.
 */
export class FilesystemShapeMismatchError extends Error {
  readonly rel: string;
  readonly segment: string;

  constructor(rel: string, segment: string) {
    super(`Path '${rel}' needs a directory at segment '${segment}' but a regular file exists there.`);
    this.name = "FilesystemShapeMismatchError";
    this.rel = rel;
    this.segment = segment;
  }
}

const ABSENT_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isAbsentPathError(err: unknown): boolean {
  return ABSENT_PATH_CODES.has((err as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * Split `rel` into its exact segments. Ids and keys are validated upstream by `paths.ts`; this
 * repeats the containment guard so no caller can escape the bundle root even if it skipped
 * that guard. Lone `.` segments are dropped, exactly as `path.resolve` used to collapse them.
 */
function relSegments(rel: string): string[] {
  if (typeof rel !== "string" || rel.startsWith("/")) {
    throw new InvalidInputError(`Path '${String(rel)}' resolves outside the bundle root.`);
  }
  const segments = rel.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new InvalidInputError(`Path '${rel}' resolves outside the bundle root.`);
  }
  return segments;
}

// ── identity key ──────────────────────────────────────────────────────────────

/** NFKD then locale-independent lower case: a superset of every supported host's equivalence. */
export function foldSegment(segment: string): string {
  return segment.normalize("NFKD").toLowerCase();
}

/** The physical path of the longest existing ancestor of `resolved`, plus the absent remainder. */
async function existingAnchor(resolved: string): Promise<{ anchor: string; tail: string[] }> {
  const tail: string[] = [];
  let candidate = resolved;
  for (;;) {
    try {
      return { anchor: await fs.realpath(candidate), tail };
    } catch (err) {
      if (!isAbsentPathError(err)) throw err;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return { anchor: candidate, tail };
    tail.unshift(path.basename(candidate));
    candidate = parent;
  }
}

/**
 * The lock key for one logical identity `(root, rel)`: a digest of the fully folded physical
 * root path and the folded `rel`. The WHOLE existing ancestor chain is resolved and folded, so
 * the key is identical whether it is computed before or after any part of the root is created,
 * and identical for every case or normalization spelling of any segment. It depends on nothing
 * else: not the environment, the clock, the process, or the host name.
 */
export async function identityKey(root: string, rel: string): Promise<string> {
  const foldedRel = relSegments(rel).map(foldSegment).join("/");
  const { anchor, tail } = await existingAnchor(path.resolve(root));
  const anchorSegments = anchor.split(path.sep).filter((segment, index) => index === 0 || segment !== "");
  const foldedRoot = [...anchorSegments, ...tail].map(foldSegment).join("/");
  return createHash("sha256").update(`superbee-identity/v1\0${foldedRoot}\0${foldedRel}`).digest("hex");
}

// ── pure decisions ────────────────────────────────────────────────────────────

export type LeafVerdict = "exact" | "replaced" | "aliased" | "absent";

export interface LeafSnapshot {
  leaf: string;
  handle: EntryWitness;
  entries: ListedEntry[];
}

function sameWitness(a: EntryWitness, b: EntryWitness): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Post-use verdict for the leaf: the bytes were read from the handle's inode, and the exact
 * spelling must still be the name bound to that inode in a fresh listing of the parent.
 */
export function classifyLeaf(snapshot: LeafSnapshot): LeafVerdict {
  const exact = snapshot.entries.find((entry) => entry.name === snapshot.leaf);
  if (exact !== undefined) return sameWitness(exact, snapshot.handle) ? "exact" : "replaced";
  return snapshot.entries.some((entry) => sameWitness(entry, snapshot.handle)) ? "aliased" : "absent";
}

export type MkdirVerdict = "created" | "exact" | "aliased" | "shape-mismatch";

/** A directory entry that traversal follows: a directory, or a symlink whose target it resolves. */
function traversable(kind: EntryKind): boolean {
  return kind === "directory" || kind === "symlink";
}

/**
 * Verdict for one non-recursive `mkdir` outcome against the parent listing. A `rel` segment
 * that already exists is exact only under the requested spelling; a tail (root) segment that
 * already exists as a directory is accepted under any spelling.
 */
export function classifyMkdir(
  outcome: "created" | "exists",
  listing: ListedEntry[],
  segment: string,
  isTail: boolean,
): MkdirVerdict {
  if (outcome === "created") return "created";
  const exact = listing.find((entry) => entry.name === segment);
  if (exact === undefined) return isTail ? "exact" : "aliased";
  return traversable(exact.kind) ? "exact" : "shape-mismatch";
}

// ── realization walk (shared by observation and mutation) ─────────────────────

type Realization =
  | { state: "exact"; leaf: ProbeResult }
  /** `rel` segments `[0, depth)` exist and are traversable; segment `depth` is absent. */
  | { state: "absent"; depth: number }
  | { state: "shape-mismatch"; segment: string };

/** Per segment, root to leaf: it must exist, and the parent listing must carry its exact spelling. */
async function walkExact(
  port: FilesystemIdentityPort,
  rootResolved: string,
  segments: string[],
  rel: string,
): Promise<Realization> {
  let parent = rootResolved;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const candidate = path.join(parent, segment);
    const probed = await port.probe(candidate);
    if (probed === null) return { state: "absent", depth: index };
    const listing = await port.entries(parent);
    if (listing === null) return { state: "absent", depth: index };
    if (!listing.some((entry) => entry.name === segment)) throw new FilesystemIdentityAliasError(rel, segment);
    if (index === segments.length - 1) return { state: "exact", leaf: probed };
    if (!traversable(probed.kind)) return { state: "shape-mismatch", segment };
    parent = candidate;
  }
  throw new InvalidInputError(`Path '${rel}' resolves outside the bundle root.`);
}

// ── observation ───────────────────────────────────────────────────────────────

const MAX_REPLACED_RESTARTS = 3;

export type Observation<T> = { state: "exact"; value: T } | { state: "absent" };

/** What an observation does with the exactly spelled path; `null` means "nothing is there". */
export type ObservationUse<T> = (target: string) => Promise<(EntryWitness & { value: T }) | null>;

/** Re-walk every segment with fresh listings; the leaf must still bind the exact name to the handle. */
async function postVerify(
  port: FilesystemIdentityPort,
  rootResolved: string,
  segments: string[],
  rel: string,
  handle: EntryWitness,
): Promise<LeafVerdict> {
  let parent = rootResolved;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const listing = await port.entries(parent);
    if (listing === null) return "absent";
    if (index === segments.length - 1) {
      const verdict = classifyLeaf({ leaf: segment, handle, entries: listing });
      if (verdict === "aliased") throw new FilesystemIdentityAliasError(rel, segment);
      return verdict;
    }
    if (!listing.some((entry) => entry.name === segment)) throw new FilesystemIdentityAliasError(rel, segment);
    parent = path.join(parent, segment);
  }
  throw new InvalidInputError(`Path '${rel}' resolves outside the bundle root.`);
}

/**
 * Observe `(root, rel)` without a lock and without writing anything. Absence is decided by one
 * probe of the full path; presence is verified segment by segment before `use` runs and again
 * after it, with the leaf bound to the inode `use` reported. A leaf replaced between the two
 * walks restarts the observation a bounded number of times.
 */
export async function observeExact<T>(
  port: FilesystemIdentityPort,
  root: string,
  rel: string,
  use: ObservationUse<T>,
): Promise<Observation<T>> {
  const segments = relSegments(rel);
  const rootResolved = path.resolve(root);
  const target = path.join(rootResolved, ...segments);
  if ((await port.probe(target)) === null) return { state: "absent" };

  for (let restarts = 0; ; restarts++) {
    const realized = await walkExact(port, rootResolved, segments, rel);
    if (realized.state !== "exact") return { state: "absent" };
    const used = await use(target);
    if (used === null) return { state: "absent" };
    const verdict = await postVerify(port, rootResolved, segments, rel, used);
    if (verdict === "exact") return { state: "exact", value: used.value };
    if (verdict === "absent") return { state: "absent" };
    if (restarts >= MAX_REPLACED_RESTARTS) throw new ConcurrentReplacementError(rel, restarts + 1);
  }
}

// ── mutation ──────────────────────────────────────────────────────────────────

/**
 * Process-local queue per identity key, shared by every `FilesystemBackend` instance: the
 * engine constructs a fresh adapter per bundle operation, so an instance-level map would
 * serialize nothing. The entry is dropped once it drains and no newer waiter replaced it.
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

export interface MutationContext {
  /** Realized state of the exact path while the identity lock is held. */
  readonly state: "exact" | "absent";
  /** Current bytes at the exact path, `null` when absent; the compare-and-swap basis. */
  current(): Promise<Buffer | null>;
  /** Create the missing directory segments exactly, then atomically replace the leaf. */
  replace(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}

const ABSENT_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

function absentDirectoryError(dir: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "scandir";
  err.path = dir;
  return err;
}

async function mkdirExact(
  port: FilesystemIdentityPort,
  parent: string,
  segment: string,
  isTail: boolean,
  rel: string,
): Promise<void> {
  const outcome = await port.mkdir(path.join(parent, segment));
  if (outcome === "created") return;
  const listing = await port.entries(parent);
  if (listing === null) throw absentDirectoryError(parent);
  const verdict = classifyMkdir(outcome, listing, segment, isTail);
  if (verdict === "aliased") throw new FilesystemIdentityAliasError(rel, segment);
  if (verdict === "shape-mismatch") throw new FilesystemShapeMismatchError(rel, segment);
}

/**
 * Create every missing directory from the deepest existing one down to the leaf's parent, one
 * non-recursive `mkdir` at a time. `mkdir` is atomic and core never renames directories, so a
 * segment this process created keeps its spelling; an EEXIST on a `rel` segment is accepted
 * only when the parent listing carries the exact spelling.
 */
async function ensureExactDirectories(
  port: FilesystemIdentityPort,
  rootResolved: string,
  segments: string[],
  existingDepth: number,
  rel: string,
): Promise<void> {
  if (existingDepth === 0 && (await port.probe(rootResolved)) === null) {
    const tail: string[] = [];
    let candidate = rootResolved;
    for (;;) {
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      tail.unshift(path.basename(candidate));
      candidate = parent;
      if ((await port.probe(candidate)) !== null) break;
    }
    for (const segment of tail) {
      await mkdirExact(port, candidate, segment, true, rel);
      candidate = path.join(candidate, segment);
    }
  }
  let parent = path.join(rootResolved, ...segments.slice(0, existingDepth));
  for (const segment of segments.slice(existingDepth, -1)) {
    await mkdirExact(port, parent, segment, false, rel);
    parent = path.join(parent, segment);
  }
}

/**
 * Mutate `(root, rel)` inside its identity lock: claim the key, realize the exact state, and let
 * `body` decide (compare-and-swap, delete-of-absent) before anything is written. An alias at
 * any segment, a conflict, or an early return leaves the bundle untouched; the bundle root and
 * missing directories are created only by `replace`. The lock is released on every path.
 */
export async function mutateExact<T>(
  port: FilesystemIdentityPort,
  root: string,
  rel: string,
  body: (context: MutationContext) => Promise<T>,
): Promise<T> {
  const segments = relSegments(rel);
  const rootResolved = path.resolve(root);
  const target = path.join(rootResolved, ...segments);
  const leaf = segments[segments.length - 1]!;
  const key = await identityKey(root, rel);
  return enqueue(key, async () => {
    const release = await port.claim(key, { root: rootResolved, rel });
    try {
      const realized = await walkExact(port, rootResolved, segments, rel);
      if (realized.state === "shape-mismatch") throw new FilesystemShapeMismatchError(rel, realized.segment);
      const existingDepth = realized.state === "absent" ? realized.depth : segments.length - 1;
      const context: MutationContext = {
        state: realized.state,
        async current() {
          if (realized.state !== "exact") return null;
          try {
            return (await port.readFile(target)).bytes;
          } catch (err) {
            if (ABSENT_FILE_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) return null;
            throw err;
          }
        },
        async replace(bytes) {
          await ensureExactDirectories(port, rootResolved, segments, existingDepth, rel);
          const dir = path.dirname(target);
          // Unique per call, not per process: one process can issue two writes to the same
          // target within a millisecond, and the second's temp file must not clobber the first's.
          const tmpName = `.${leaf}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
          await port.writeTemp(dir, tmpName, bytes);
          try {
            await port.rename(path.join(dir, tmpName), target);
          } catch (err) {
            await port.unlink(path.join(dir, tmpName)).catch(() => {});
            throw err;
          }
        },
        async remove() {
          await port.unlink(target);
        },
      };
      return await body(context);
    } finally {
      await release();
    }
  });
}

// ── production port ───────────────────────────────────────────────────────────

function kindOf(stats: Stats): EntryKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * Kind from `lstat`; the witness from the entry that opening the name would reach, so a symlink
 * that resolves reports its target's inode (the one `readFile`'s handle carries) and one that
 * does not resolve (dangling, looping, unreadable) reports its own.
 */
async function witnessOf(target: string, lstats: Stats): Promise<ProbeResult> {
  const kind = kindOf(lstats);
  if (kind === "symlink") {
    try {
      const stats = await fs.stat(target);
      return { kind, dev: stats.dev, ino: stats.ino };
    } catch {
      // Fall through: the link itself is the entry; opening it reports the real failure.
    }
  }
  return { kind, dev: lstats.dev, ino: lstats.ino };
}

/** The one production binding: `node:fs`, the temp-file convention, and the identity lock. */
export const nodeFilesystemIdentityPort: FilesystemIdentityPort = Object.freeze({
  async probe(target: string): Promise<ProbeResult | null> {
    let lstats: Stats;
    try {
      lstats = await fs.lstat(target);
    } catch (err) {
      if (isAbsentPathError(err)) return null;
      throw err;
    }
    return witnessOf(target, lstats);
  },
  async entries(dir: string): Promise<ListedEntry[] | null> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (isAbsentPathError(err)) return null;
      throw err;
    }
    const listed = await Promise.all(
      names.map(async (name): Promise<ListedEntry | null> => {
        const target = path.join(dir, name);
        try {
          return { name, ...(await witnessOf(target, await fs.lstat(target))) };
        } catch (err) {
          // An entry removed between the listing and its lstat is simply no longer listed.
          if (isAbsentPathError(err)) return null;
          throw err;
        }
      }),
    );
    return listed.filter((entry): entry is ListedEntry => entry !== null);
  },
  async readFile(target: string): Promise<ReadWitness> {
    const handle = await fs.open(target, "r");
    try {
      const stats = await handle.stat();
      return { bytes: await handle.readFile(), dev: stats.dev, ino: stats.ino };
    } finally {
      await handle.close();
    }
  },
  async stat(target: string): Promise<{ mtime: Date }> {
    return { mtime: (await fs.stat(target)).mtime };
  },
  async mkdir(dir: string): Promise<"created" | "exists"> {
    try {
      await fs.mkdir(dir);
      return "created";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    }
  },
  async writeTemp(dir: string, name: string, bytes: Uint8Array): Promise<void> {
    await fs.writeFile(path.join(dir, name), bytes);
  },
  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  },
  async unlink(target: string): Promise<void> {
    await fs.unlink(target);
  },
  claim(key: string, identity: IdentityDescriptor): Promise<() => Promise<void>> {
    return acquireFilesystemIdentityLock(key, `${identity.root}:${identity.rel}`, { portableRoot: identity.root });
  },
});
