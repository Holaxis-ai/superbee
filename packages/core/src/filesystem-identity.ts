/**
 * Exact filesystem identity for the filesystem adapter.
 *
 * A bundle-relative path `rel` names ONE physical entry only when every segment's on-disk
 * spelling equals the requested spelling. On a case- or normalization-insensitive filesystem
 * (case-insensitive APFS, NTFS, ext4 casefold, normalization-insensitive APFS) two distinct
 * canonical ids would otherwise reach one file, so reads, compare-and-swap, and deletes would
 * alias. This module is the single owner of that decision:
 *
 * - Observations record every `rel` segment's inode, verify each segment's spelling by listing
 *   before and after use, confirm any would-be alias by probing the requested spelling against
 *   the recorded inode, and hold the read handle open through the post-walk so the bytes stay
 *   bound to a live inode. They hold no lock and write nothing, so an absent bundle root stays
 *   absent. Symbolic links at any segment are refused; the walk never follows them.
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
import type { FileHandle } from "node:fs/promises";
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

/** A listing entry: spelling and kind only. Listings never carry inodes; witnesses come from `probe`. */
export interface ListedEntry {
  name: string;
  kind: EntryKind;
}

/** An opaque open-file token owned by the port; the protocol never inspects it. */
export type PortHandle = object;

export interface OpenedFile extends EntryWitness {
  handle: PortHandle;
}

export interface IdentityDescriptor {
  root: string;
  rel: string;
}

/**
 * The complete filesystem surface the protocol needs. `probe` is `lstat` and never follows a
 * symlink; `mkdir` is deliberately NON-recursive: exact directory creation is decided one
 * segment at a time against the parent listing.
 */
export interface FilesystemIdentityPort {
  /** `lstat`; `null` when nothing is at the path (ENOENT or ENOTDIR). */
  probe(target: string): Promise<ProbeResult | null>;
  /** Directory listing, names and kinds only; `null` when the directory is absent. */
  entries(dir: string): Promise<ListedEntry[] | null>;
  /** Open for reading and `fstat` the handle; throws the filesystem error otherwise. */
  open(target: string): Promise<OpenedFile>;
  readAll(handle: PortHandle): Promise<Buffer>;
  close(handle: PortHandle): Promise<void>;
  stat(target: string): Promise<{ mtime: Date }>;
  mkdir(dir: string): Promise<"created" | "exists">;
  writeTemp(dir: string, name: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  claim(key: string, identity: IdentityDescriptor): Promise<() => Promise<void>>;
}

/**
 * A symbolic link at a `rel` segment. The walk never follows links: a link's own inode is not the
 * inode of what opening it would reach, so no exactness verdict is possible. Refused as caller
 * input (the layout is unsupported) rather than reported as a runtime failure.
 */
export class FilesystemSymlinkEntryError extends InvalidInputError {
  readonly rel: string;
  readonly segment: string;

  constructor(rel: string, segment: string) {
    super(`Path '${rel}' reaches a symbolic link at segment '${segment}'; symlinked entries inside a bundle are unsupported.`);
    this.name = "FilesystemSymlinkEntryError";
    this.rel = rel;
    this.segment = segment;
  }
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

function sameWitness(a: EntryWitness, b: EntryWitness): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export type ConfirmVerdict = "continue" | "absent" | "aliased" | "restart";

/**
 * The confirmed-ALIASED rule for one `rel` segment whose parent listing was just taken. A listing
 * that lacks the exact spelling is never a verdict on its own: the requested spelling is probed,
 * and ALIASED requires that probe to reach the inode recorded for this segment earlier in the
 * same observation. A different inode is ambiguous (alias replaced, or exact deleted and recreated
 * between the two snapshots) and restarts the observation instead.
 */
export function confirmAlias(
  listingHasExact: boolean,
  probe: ProbeResult | null,
  recorded: EntryWitness,
): ConfirmVerdict {
  if (listingHasExact) return "continue";
  if (probe === null) return "absent";
  return sameWitness(probe, recorded) ? "aliased" : "restart";
}

export type LeafVerdict = "exact" | "replaced" | "aliased" | "absent";

export interface LeafSnapshot {
  /** The exact spelling is present in the fresh listing of the parent. */
  listed: boolean;
  /** `probe(parent/leaf)` taken after that listing. */
  probe: ProbeResult | null;
  /** The inode the observation is bound to: the open handle's, or the recorded leaf for handle-less observations. */
  handle: EntryWitness;
}

/**
 * Post-use verdict for the leaf, over the six cells of (listed, probe): the bytes came from the
 * handle's inode, which must still be what the requested spelling reaches, under its own name.
 */
export function classifyLeaf(snapshot: LeafSnapshot): LeafVerdict {
  if (snapshot.probe === null) return "absent";
  if (!sameWitness(snapshot.probe, snapshot.handle)) return "replaced";
  return snapshot.listed ? "exact" : "aliased";
}

export type MkdirVerdict = "created" | "exact" | "aliased" | "shape-mismatch";

/**
 * Verdict for one non-recursive `mkdir` outcome against the parent listing. A `rel` segment
 * that already exists is exact only under the requested spelling and only as a directory; a
 * tail (root) segment that already exists as a directory is accepted under any spelling.
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
  return exact.kind === "directory" ? "exact" : "shape-mismatch";
}

// ── walks ─────────────────────────────────────────────────────────────────────

/** `probe` that refuses a symbolic link at any `rel` segment (the walk never follows links). */
async function probeSegment(
  port: FilesystemIdentityPort,
  candidate: string,
  rel: string,
  segment: string,
): Promise<ProbeResult | null> {
  const probed = await port.probe(candidate);
  if (probed !== null && probed.kind === "symlink") throw new FilesystemSymlinkEntryError(rel, segment);
  return probed;
}

function hasExact(listing: ListedEntry[], segment: string): boolean {
  return listing.some((entry) => entry.name === segment);
}

type Realization =
  | { state: "exact"; leaf: ProbeResult }
  /** `rel` segments `[0, depth)` exist and are directories; segment `depth` is absent. */
  | { state: "absent"; depth: number }
  | { state: "shape-mismatch"; segment: string };

/**
 * M-REALIZE: per segment, root to leaf, it must exist and the parent listing must carry its exact
 * spelling. A listing-only alias decision is sound here because the identity lock is held: no
 * same-key operation can remove the leaf concurrently, and core never removes directories.
 */
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
    const probed = await probeSegment(port, candidate, rel, segment);
    if (probed === null) return { state: "absent", depth: index };
    const listing = await port.entries(parent);
    if (listing === null) return { state: "absent", depth: index };
    if (!hasExact(listing, segment)) throw new FilesystemIdentityAliasError(rel, segment);
    if (index === segments.length - 1) return { state: "exact", leaf: probed };
    if (probed.kind !== "directory") return { state: "shape-mismatch", segment };
    parent = candidate;
  }
  throw new InvalidInputError(`Path '${rel}' resolves outside the bundle root.`);
}

// ── observation ───────────────────────────────────────────────────────────────

const MAX_RESTARTS = 3;

export type Observation<T> = { state: "exact"; value: T } | { state: "absent" };

type WalkVerdict = "continue" | "absent" | "restart";

/** O-PROBE: walk `rel` root to leaf recording each segment's witness; `null` when any segment is absent. */
async function recordWalk(
  port: FilesystemIdentityPort,
  rootResolved: string,
  segments: string[],
  rel: string,
): Promise<ProbeResult[] | null> {
  const recorded: ProbeResult[] = [];
  let parent = rootResolved;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const candidate = path.join(parent, segment);
    const probed = await probeSegment(port, candidate, rel, segment);
    if (probed === null) return null;
    if (index < segments.length - 1 && probed.kind !== "directory") return null;
    recorded.push(probed);
    parent = candidate;
  }
  return recorded;
}

/**
 * One listing walk under the confirmed-ALIASED rule. O-VERIFY confirms every segment against its
 * recorded inode. O-POSTVERIFY (`handle` given) confirms directory segments the same way and
 * applies the six-cell leaf table against the handle's inode, probing the leaf unconditionally.
 */
async function confirmedWalk(
  port: FilesystemIdentityPort,
  rootResolved: string,
  segments: string[],
  rel: string,
  recorded: ProbeResult[],
  handle: EntryWitness | null,
): Promise<WalkVerdict | "exact"> {
  let parent = rootResolved;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const candidate = path.join(parent, segment);
    const listing = await port.entries(parent);
    if (listing === null) return "absent";
    const listed = hasExact(listing, segment);
    if (handle !== null && index === segments.length - 1) {
      const verdict = classifyLeaf({ listed, probe: await probeSegment(port, candidate, rel, segment), handle });
      if (verdict === "aliased") throw new FilesystemIdentityAliasError(rel, segment);
      return verdict === "replaced" ? "restart" : verdict;
    }
    if (!listed) {
      const verdict = confirmAlias(false, await probeSegment(port, candidate, rel, segment), recorded[index]!);
      if (verdict === "aliased") throw new FilesystemIdentityAliasError(rel, segment);
      if (verdict !== "continue") return verdict;
    }
    parent = candidate;
  }
  return "continue";
}

function countRestart(restarts: number, rel: string): number {
  if (restarts >= MAX_RESTARTS) throw new ConcurrentReplacementError(rel, restarts + 1);
  return restarts + 1;
}

/**
 * Observe `(root, rel)` without a lock and without writing anything, reading through one open
 * handle. Every segment is probed and recorded (O-PROBE), verified by listing with inode
 * confirmation (O-VERIFY), opened and read, then re-verified with fresh listings while the handle
 * is still open so its inode cannot be recycled (O-POSTVERIFY). Every ambiguous outcome restarts
 * from O-PROBE, bounded; the handle is closed before any restart opens another.
 */
export async function observeExact<T>(
  port: FilesystemIdentityPort,
  root: string,
  rel: string,
  read: (handle: PortHandle, target: string) => Promise<T | null>,
): Promise<Observation<T>> {
  const segments = relSegments(rel);
  const rootResolved = path.resolve(root);
  const target = path.join(rootResolved, ...segments);

  for (let restarts = 0; ; ) {
    const recorded = await recordWalk(port, rootResolved, segments, rel);
    if (recorded === null) return { state: "absent" };
    const verified = await confirmedWalk(port, rootResolved, segments, rel, recorded, null);
    if (verified === "absent") return { state: "absent" };
    if (verified === "restart") {
      restarts = countRestart(restarts, rel);
      continue;
    }

    let opened: OpenedFile;
    try {
      opened = await port.open(target);
    } catch (err) {
      if (isAbsentPathError(err)) return { state: "absent" };
      throw err;
    }
    let value: T | null;
    let verdict: WalkVerdict | "exact";
    try {
      value = await read(opened.handle, target);
      if (value === null) return { state: "absent" };
      verdict = await confirmedWalk(port, rootResolved, segments, rel, recorded, opened);
    } finally {
      await port.close(opened.handle);
    }
    if (verdict === "exact") return { state: "exact", value };
    if (verdict === "absent") return { state: "absent" };
    restarts = countRestart(restarts, rel);
  }
}

/**
 * Handle-less observation of presence: the same walks, with the recorded leaf inode standing in
 * for an open handle. Yields the leaf's kind and witness as verified by the post-walk.
 */
export async function probeExact(
  port: FilesystemIdentityPort,
  root: string,
  rel: string,
): Promise<Observation<ProbeResult>> {
  const segments = relSegments(rel);
  const rootResolved = path.resolve(root);

  for (let restarts = 0; ; ) {
    const recorded = await recordWalk(port, rootResolved, segments, rel);
    if (recorded === null) return { state: "absent" };
    const leaf = recorded[recorded.length - 1]!;
    const verified = await confirmedWalk(port, rootResolved, segments, rel, recorded, null);
    const verdict = verified === "continue" ? await confirmedWalk(port, rootResolved, segments, rel, recorded, leaf) : verified;
    if (verdict === "exact") return { state: "exact", value: leaf };
    if (verdict === "absent") return { state: "absent" };
    restarts = countRestart(restarts, rel);
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

/** Open, read every byte, close; `null` for the absent-file error class. */
async function readWhole(port: FilesystemIdentityPort, target: string): Promise<Buffer | null> {
  let opened: OpenedFile;
  try {
    opened = await port.open(target);
  } catch (err) {
    if (ABSENT_FILE_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) return null;
    throw err;
  }
  try {
    return await port.readAll(opened.handle);
  } catch (err) {
    if (ABSENT_FILE_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) return null;
    throw err;
  } finally {
    await port.close(opened.handle);
  }
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
  if (listing.some((entry) => entry.name === segment && entry.kind === "symlink")) {
    throw new FilesystemSymlinkEntryError(rel, segment);
  }
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
          return realized.state === "exact" ? readWhole(port, target) : null;
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

function kindOf(stats: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): EntryKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
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
    return { kind: kindOf(lstats), dev: lstats.dev, ino: lstats.ino };
  },
  async entries(dir: string): Promise<ListedEntry[] | null> {
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      return dirents.map((dirent) => ({ name: dirent.name, kind: kindOf(dirent) }));
    } catch (err) {
      if (isAbsentPathError(err)) return null;
      throw err;
    }
  },
  async open(target: string): Promise<OpenedFile> {
    const handle = await fs.open(target, "r");
    try {
      const stats = await handle.stat();
      return { handle, dev: stats.dev, ino: stats.ino };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  },
  readAll(handle: PortHandle): Promise<Buffer> {
    return (handle as FileHandle).readFile();
  },
  close(handle: PortHandle): Promise<void> {
    return (handle as FileHandle).close();
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
