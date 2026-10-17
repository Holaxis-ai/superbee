// The checkout folder is a projection of the private store: the store is the working copy, and
// the folder is what ordinary commands and agents read and edit. Export writes store bytes into
// the folder and never overwrites a file it did not expect to find (review S9):
//
// - a new file is placed with an exclusive create (`O_EXCL`), so a file an agent created first is
//   kept;
// - a replacement renames the current file to a pre-image, verifies the pre-image holds exactly
//   the bytes last exported, and places the new bytes with `link()`, which fails rather than
//   replace a file an agent created in between. On any mismatch or failure the pre-image is
//   restored (again with `link()`, never over a newer file) and the document is reported as a
//   pending edit, for the next scan to pick up.
//
// Temporary and pre-image files are dot-files ending in `.tmp` beside their target, so no bundle
// reader treats them as documents.
import { readRegularFileNoFollowSync } from "../nofollow-read.js";
import { assertSafeBlobKey, isWriteRequestId } from "@superbee/core/storage";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { assertSafeConceptId, pathFromConceptId, FilesystemBackend, probeFilesystemPath, InvalidInputError, type JournaledBackend } from "@superbee/core";

export type PlaceOutcome =
  | { readonly placed: true }
  | {
      readonly placed: false;
      /** Why the new bytes were not placed; the file keeps what was found and the document is a pending edit. */
      readonly reason: "occupied" | "changed" | "missing";
      /** Set only when a pre-image could not be put back because another file took its place. */
      readonly preimage?: string;
    };

export function digestOf(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sibling(file: string, label: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.superbee-${label}-${randomBytes(6).toString("hex")}.tmp`);
}

async function syncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write `bytes` to a new file that must not exist; fsynced before it resolves. */
async function createExclusive(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(file, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * Place bytes at a path that should be empty. An existing file is kept and reported `occupied`.
 * The bytes are written whole to a staged sibling first and linked into place, so a crash never
 * leaves a partly written file under the document's name.
 */
export async function placeNew(file: string, bytes: Uint8Array): Promise<PlaceOutcome> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staged = sibling(file, "new");
  await createExclusive(staged, bytes);
  try {
    await fs.link(staged, file);
  } catch (error) {
    await fs.unlink(staged).catch(() => {});
    if (isCode(error, "EEXIST")) return { placed: false, reason: "occupied" };
    throw error;
  }
  await fs.unlink(staged);
  await syncDir(path.dirname(file));
  return { placed: true };
}

/**
 * Replace the file's bytes only while it still holds exactly `expected`. Never overwrites: the
 * current file is moved aside first, and the new bytes are linked into an empty name.
 */
export async function replaceGuarded(file: string, expected: Uint8Array, next: Uint8Array): Promise<PlaceOutcome> {
  const preimage = sibling(file, "pre");
  try {
    await fs.rename(file, preimage);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { placed: false, reason: "missing" };
    throw error;
  }
  const restore = async (reason: "occupied" | "changed"): Promise<PlaceOutcome> => {
    try {
      await fs.link(preimage, file);
    } catch (error) {
      // Another file took the name after the pre-image moved aside: keep both, and name the
      // pre-image so its bytes are never silently lost.
      if (isCode(error, "EEXIST")) return { placed: false, reason, preimage };
      throw error;
    }
    await fs.unlink(preimage);
    return { placed: false, reason };
  };
  let found: Buffer;
  try {
    found = await fs.readFile(preimage);
  } catch (error) {
    await restore("changed");
    throw error;
  }
  if (!Buffer.from(expected).equals(found)) return restore("changed");
  const staged = sibling(file, "new");
  try {
    await createExclusive(staged, next);
  } catch (error) {
    if (!isCode(error, "EEXIST")) await fs.unlink(staged).catch(() => {});
    await restore("changed").catch(() => {});
    throw error;
  }
  try {
    await fs.link(staged, file);
  } catch (error) {
    await fs.unlink(staged).catch(() => {});
    if (isCode(error, "EEXIST")) {
      // An agent created the file between the rename and the link: its bytes win. The
      // pre-image held only what was exported, so nothing is lost by dropping it.
      await fs.unlink(preimage);
      return { placed: false, reason: "occupied" };
    }
    await restore("changed").catch(() => {});
    throw error;
  }
  await fs.unlink(staged);
  await fs.unlink(preimage);
  await syncDir(path.dirname(file));
  return { placed: true };
}

/** What one export wrote, and the digest of every file it placed (the next scan's baseline). */
export interface ExportReport {
  readonly documents: number;
  readonly root: boolean;
  /** Document id (or `index.md` for the root) to the digest of the bytes placed. */
  readonly exported: Record<string, string>;
  /** Files an export found already present and kept. */
  readonly kept: readonly string[];
}

export const ROOT_INDEX = "index.md";

/**
 * One path segment folded as a case-insensitive host equates it: NFKD, then lower-upper-lower
 * (the same fold core's filesystem identity uses), so ß/ss and final-sigma pairs collide too.
 */
export function fold(segment: string): string {
  return segment.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase();
}
/** Exact native spelling only: metadata probes create no paths and read no bodies. */
export async function projectionPathExact(folder: string, rel: string): Promise<boolean> {
  if (await parentUnsafe(folder, path.join(folder, ...rel.split("/")))) return false;
  try { await probeFilesystemPath(new FilesystemBackend(folder), rel); return true; }
  catch (error) { if (error instanceof InvalidInputError) return false; throw error; }
}


/** Two document paths that one case-insensitive or normalizing filesystem would merge. */
export interface PathCollision {
  readonly first: string;
  readonly second: string;
}

/**
 * Check relative physical paths using the existing portable projection fold. The caller owns
 * its path grammar; this owner checks leaf and ancestor spelling and file/directory ownership.
 * Returns the first collision, or null. Native exact spelling is observed separately.
 */
export function findFilePathCollision(files: Iterable<string>): PathCollision | null {
  const spelled = new Map<string, string>();
  for (const file of files) {
    const segments = file.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const spelling = segments.slice(0, depth).join("/") + (depth < segments.length ? "/" : "");
      const key = segments.slice(0, depth).map(fold).join("/");
      const seen = spelled.get(key);
      if (seen !== undefined && seen !== spelling) return { first: seen, second: spelling };
      spelled.set(key, spelling);
    }
  }
  return null;
}
/** Document facade retains concept-id validation and the reserved root path. */
export function findPathCollision(ids: readonly string[]): PathCollision | null {
  function* files() {
    yield ROOT_INDEX;
    for (const id of ids) { assertSafeConceptId(id); yield pathFromConceptId(id); }
  }
  return findFilePathCollision(files());
}

/** Refuse a placement whose parent resolves outside the folder (a symlinked directory inside it). */
async function assertContained(folder: string, file: string): Promise<void> {
  const parent = await fs.realpath(path.dirname(file));
  if (parent !== folder && !parent.startsWith(`${folder}${path.sep}`)) {
    throw Object.assign(new Error(`${path.relative(folder, file)} resolves outside the checkout folder`), { code: "EXDEV" });
  }
}

/**
 * Project every document and the root index from the store into an empty checkout folder. The
 * bytes are the store's exact serialization, the bytes each version names.
 */
export async function exportFresh(store: JournaledBackend, folder: string, onPlaced: (file: string, digest: string) => void = () => {}): Promise<ExportReport> {
  const exported: Record<string, string> = {};
  const kept: string[] = [];
  let root = false;
  const index = await store.readReserved("", "index.md");
  if (index) {
    const bytes = Buffer.from(index.content, "utf8");
    const outcome = await placeNew(path.join(folder, ROOT_INDEX), bytes);
    if (outcome.placed) {
      onPlaced(path.join(folder, ROOT_INDEX), digestOf(bytes));
      exported[ROOT_INDEX] = digestOf(bytes);
      root = true;
    } else kept.push(ROOT_INDEX);
  }
  const heads = await store.readHeads({ project: (head) => ({ id: head.id, raw: head.raw }) });
  let documents = 0;
  for (const head of heads) {
    const bytes = Buffer.from(head.raw, "utf8");
    const file = path.join(folder, pathFromConceptId(head.id));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await assertContained(folder, file);
    const outcome = await placeNew(file, bytes);
    if (outcome.placed) {
      onPlaced(file, digestOf(bytes));
      exported[head.id] = digestOf(bytes);
      documents += 1;
    } else kept.push(head.id);
  }
  return { documents, root, exported, kept };
}

/** The temporary names placement leaves beside a target: `.NAME.superbee-<pre|new|del>-<tag>.tmp`. */
export const PLACEMENT_TEMP = /^\.(.+)\.superbee-(pre|new|del)-[^./]+\.tmp$/;

/** A path under the folder that cannot be placed safely: a symbolic link or a file on the way to it. */
export class UnsafePlacementError extends Error {
  override readonly name = "UnsafePlacementError";
}

/**
 * Create the directories from the folder down to `file`'s parent, one level at a time, refusing
 * any component that is a symbolic link or not a directory, before anything is created below it.
 * Nothing is ever created through a link, inside or outside the folder.
 */
export async function ensureParentInside(folder: string, file: string): Promise<void> {
  const rel = path.relative(folder, path.dirname(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new UnsafePlacementError(`${file} is outside the checkout folder`);
  let dir = folder;
  for (const segment of rel === "" ? [] : rel.split(path.sep)) {
    dir = path.join(dir, segment);
    let info;
    try {
      info = await fs.lstat(dir);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      try {
        await fs.mkdir(dir);
      } catch (made) {
        if (!isCode(made, "EEXIST")) throw made;
      }
      info = await fs.lstat(dir);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafePlacementError(`${path.relative(folder, dir)} is a symbolic link or a file, so sync does not place documents under it`);
  }
}

/** True when some directory between the folder and `file` is a symbolic link or not a directory. */
export async function parentUnsafe(folder: string, file: string): Promise<boolean> {
  const rel = path.relative(folder, path.dirname(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;
  let dir = folder;
  for (const segment of rel === "" ? [] : rel.split(path.sep)) {
    dir = path.join(dir, segment);
    try {
      const info = await fs.lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
    } catch (error) {
      if (isCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  return false;
}

/** Optional ordinary-file staging. Existing document placement and legacy temps are unchanged. */
export interface BlobFileIdentity { dev: string; ino: string; mtimeNs: string }
export interface BlobStagePlan {
  id: string; key: string; operation: "create" | "replace" | "delete";
  beforeDigest: string | null; afterDigest: string | null;
  install?: BlobFileIdentity; preimage?: BlobFileIdentity;
}
const BLOB_STAGE_NAME = /^\.superbee-bp-([0-9a-f-]{36})-(new|install|pre|del)\.tmp$/i;
function blobStagePaths(folder: string, plan: BlobStagePlan) {
  assertSafeBlobKey(plan.key);
  if (!isWriteRequestId(plan.id)) throw new UnsafePlacementError("invalid blob placement id");
  const target = path.join(folder, ...plan.key.split("/")), dir = path.dirname(target);
  return { target, dir, new: path.join(dir, `.superbee-bp-${plan.id}-new.tmp`), install: path.join(dir, `.superbee-bp-${plan.id}-install.tmp`), pre: path.join(dir, `.superbee-bp-${plan.id}-pre.tmp`), del: path.join(dir, `.superbee-bp-${plan.id}-del.tmp`) };
}
function sameBlobIdentity(a: BlobFileIdentity, b: BlobFileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs; }
async function blobStageRead(file: string): Promise<{ bytes: Buffer; identity: BlobFileIdentity } | null> {
  let before;
  try { before = await fs.lstat(file, { bigint: true }); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; }
  if (!before.isFile() || before.dev <= 0n || before.ino <= 0n) throw new UnsafePlacementError("blob stage has no reliable regular-file identity");
  const read = readRegularFileNoFollowSync(file, { maximumBytes: 16 * 1024 * 1024 });
  if (read.state !== "present") throw new UnsafePlacementError("blob stage is unsafe or exceeds its bound");
  const after = await fs.lstat(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new UnsafePlacementError("blob stage changed during capture");
  return { bytes: read.bytes, identity: { dev: after.dev.toString(), ino: after.ino.toString(), mtimeNs: after.mtimeNs.toString() } };
}
function stageMatches(value: Awaited<ReturnType<typeof blobStageRead>>, digest: string | null, identity?: BlobFileIdentity): boolean {
  return value !== null && digest !== null && digestOf(value.bytes) === digest && (identity === undefined || sameBlobIdentity(value.identity, identity));
}
/** Pending WAL must already be durable. Returns identity evidence to persist BEFORE install. */
export async function prepareBlobStage(folder: string, plan: BlobStagePlan, supplied?: Uint8Array): Promise<{ install?: BlobFileIdentity; preimage?: BlobFileIdentity }> {
  const bytes = supplied === undefined ? undefined : new Uint8Array(supplied), p = blobStagePaths(folder, plan);
  if (!await projectionPathExact(folder, plan.key)) throw new UnsafePlacementError("aliased blob placement path");
  await ensureParentInside(folder, p.target);
  const original = await blobStageRead(p.target);
  if (plan.operation === "create" ? original !== null : !stageMatches(original, plan.beforeDigest)) throw new UnsafePlacementError("blob placement precondition changed");
  if (plan.operation !== "delete") {
    if (!bytes || bytes.length > 16 * 1024 * 1024 || digestOf(bytes) !== plan.afterDigest) throw new UnsafePlacementError("blob staged bytes do not match intended digest");
    await createExclusive(p.new, bytes);
    await createExclusive(p.install, bytes); // independent evidence: an editor can mutate the installed inode
  }
  await syncDir(p.dir);
  const install = plan.operation === "delete" ? undefined : await blobStageRead(p.install);
  const evidence = plan.operation === "delete" ? undefined : await blobStageRead(p.new);
  if (install && evidence && install.identity.dev === evidence.identity.dev && install.identity.ino === evidence.identity.ino) throw new UnsafePlacementError("blob stage evidence must be independent");
  return { ...(install ? { install: install.identity } : {}), ...(original ? { preimage: original.identity } : {}) };
}
/** Installation identity must already be durable in the same pending map descriptor. */
export async function installBlobStage(folder: string, plan: BlobStagePlan): Promise<void> {
  const p = blobStagePaths(folder, plan);
  if (!await projectionPathExact(folder, plan.key)) throw new UnsafePlacementError("unsafe or aliased blob placement path");
  if (plan.operation !== "delete" && (!plan.install || !stageMatches(await blobStageRead(p.new), plan.afterDigest) || !stageMatches(await blobStageRead(p.install), plan.afterDigest, plan.install))) throw new UnsafePlacementError("blob stage evidence changed");
  const current = await blobStageRead(p.target);
  if (plan.operation === "create") {
    if (current) throw new UnsafePlacementError("blob target appeared");
  } else {
    if (!plan.preimage || !stageMatches(current, plan.beforeDigest, plan.preimage)) throw new UnsafePlacementError("blob original changed");
    const aside = plan.operation === "delete" ? p.del : p.pre;
    if (await blobStageRead(aside)) throw new UnsafePlacementError("blob preimage name occupied");
    await fs.rename(p.target, aside);
    await syncDir(p.dir);
    if (!stageMatches(await blobStageRead(aside), plan.beforeDigest, plan.preimage)) throw new UnsafePlacementError("blob moved preimage changed");
  }
  if (plan.operation !== "delete") { await fs.link(p.install, p.target); await syncDir(p.dir); }
  if (!await projectionPathExact(folder, plan.key) || (plan.operation === "delete" ? await blobStageRead(p.target) !== null : !stageMatches(await blobStageRead(p.target), plan.afterDigest, plan.install))) throw new UnsafePlacementError("blob target changed during installation");
}
/** Recover one WAL-owned operation. Ambiguous/changed evidence is kept, never guessed away. */
export async function finishBlobStage(folder: string, plan: BlobStagePlan, state: "pending" | "committed"): Promise<boolean> {
  const p = blobStagePaths(folder, plan);
  if (!await projectionPathExact(folder, plan.key)) return false;
  let target = await blobStageRead(p.target);
  const prePath = plan.operation === "delete" ? p.del : p.pre;
  const pre = plan.operation === "create" ? null : await blobStageRead(prePath);
  if (pre && !stageMatches(pre, plan.beforeDigest, plan.preimage)) return false;
  if (state === "pending") {
    if (!plan.install && !plan.preimage) {
      // No target mutation is permitted before identity publication. Unexpected pre/del is held.
      if (await blobStageRead(p.pre) || await blobStageRead(p.del)) return false;
    } else if (plan.operation === "create") {
      if (target) {
        if (!stageMatches(target, plan.afterDigest, plan.install) || await blobStageRead(p.del)) return false;
        await fs.rename(p.target, p.del); await syncDir(p.dir);
        if (!stageMatches(await blobStageRead(p.del), plan.afterDigest, plan.install)) return false;
        target = null;
      }
    } else if (pre) {
      if (!stageMatches(target, plan.beforeDigest, plan.preimage)) {
        if (target) {
          if (plan.operation === "delete" || !stageMatches(target, plan.afterDigest, plan.install) || await blobStageRead(p.del)) return false;
          if (!stageMatches(await blobStageRead(p.new), plan.afterDigest) || !stageMatches(await blobStageRead(p.install), plan.afterDigest, plan.install)) return false;
          await fs.rename(p.target, p.del); await syncDir(p.dir);
          if (!stageMatches(await blobStageRead(p.del), plan.afterDigest, plan.install)) return false;
        }
        await fs.link(prePath, p.target); await syncDir(p.dir); // empty name only
        target = await blobStageRead(p.target);
      }
    } else if (!stageMatches(target, plan.beforeDigest, plan.preimage)) return false;
  }
  // Validate every retained evidence file before removing any. A mutated install hardlink is
  // disposable only when the same inode is still reachable under the user's target name.
  const roles = ["new", "install", "pre", "del"] as const;
  const removable: string[] = [];
  for (const role of roles) {
    const file = p[role], value = await blobStageRead(file);
    if (!value) continue;
    const old = role === "pre" || role === "del" && plan.operation === "delete";
    const digest = old ? plan.beforeDigest : plan.afterDigest;
    const identity = old ? plan.preimage : role === "new" ? undefined : plan.install;
    if (!stageMatches(value, digest, identity)) {
      const sameReachableInstall = state === "committed" && role === "install" && plan.install && sameBlobIdentity(value.identity, { ...plan.install, mtimeNs: value.identity.mtimeNs }) && target && target.identity.dev === value.identity.dev && target.identity.ino === value.identity.ino;
      if (!sameReachableInstall) return false;
    }
    removable.push(file);
  }
  for (const file of removable) await fs.unlink(file);
  if (removable.length > 0) await syncDir(p.dir);
  return true;
}
/** Raw stage names have no target authority; an unreferenced UUID holds recovery, not deletion. */
export async function orphanBlobStages(folder: string, known: ReadonlySet<string>): Promise<string[]> {
  const orphans: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), match = BLOB_STAGE_NAME.exec(entry.name);
      if (match && !known.has(match[1]!)) orphans.push(file);
      else if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(file);
    }
  }
  await visit(folder);
  return orphans;
}
