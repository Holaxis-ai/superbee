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
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { assertSafeConceptId, pathFromConceptId, type JournaledBackend } from "@superbee/core";

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

/** Place bytes at a path that should be empty. An existing file is kept and reported `occupied`. */
export async function placeNew(file: string, bytes: Uint8Array): Promise<PlaceOutcome> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await createExclusive(file, bytes);
  } catch (error) {
    if (isCode(error, "EEXIST")) return { placed: false, reason: "occupied" };
    throw error;
  }
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
function fold(segment: string): string {
  return segment.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase();
}

/** Two document paths that one case-insensitive or normalizing filesystem would merge. */
export interface PathCollision {
  readonly first: string;
  readonly second: string;
}

/**
 * Check every document path before any file is written: each id must be a safe concept id, and no
 * two paths (or two spellings of one directory) may differ only by letter case or Unicode
 * normalization, because the host's filesystem may treat them as one name. Returns the first
 * collision, or null.
 */
export function findPathCollision(ids: readonly string[]): PathCollision | null {
  const spelled = new Map<string, string>();
  const claim = (spelling: string): PathCollision | null => {
    const key = spelling.split("/").map(fold).join("/");
    const seen = spelled.get(key);
    if (seen !== undefined && seen !== spelling) return { first: seen, second: spelling };
    spelled.set(key, spelling);
    return null;
  };
  const root = claim(ROOT_INDEX);
  if (root) return root;
  for (const id of ids) {
    assertSafeConceptId(id);
    const file = pathFromConceptId(id);
    const segments = file.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const collision = claim(`${segments.slice(0, depth).join("/")}/`);
      if (collision) return collision;
    }
    const collision = claim(file);
    if (collision) return collision;
  }
  return null;
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
