// The per-board store of conflict copies: each is the local version sync saved aside when it kept
// a teammate's version of the same file. The files themselves are the record: a copy exists until
// it is settled, so nothing here needs a second list to agree with.
//
// A copy never overwrites another. The first copy of a file lands at `<exportDir>/<relPath>`; a
// repeat conflict on that file lands in a numbered tree beside the directory, which no document id
// can name, so a dotted id such as `notes/v1.2` cannot collide with a repeat of `notes/v1`. Creation
// is an exclusive link of a complete temporary file, so two racing syncs each keep their own copy
// and a reader never sees a partial one.
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseMarkdown } from "@superbee/core";

const TEMP_PREFIX = ".saving-";

/** The body-only companion of a saved copy: the `doc update --body-file` input. */
export function bodyCompanionPath(copyPath: string): string {
  return copyPath.replace(/\.md$/, ".body.md");
}

function slotDir(exportDir: string, slot: number): string {
  return slot === 1 ? exportDir : path.join(`${exportDir}.repeat`, String(slot));
}

function checkPrivateDirectory(directory: string): boolean {
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory()) {
      throw new Error(`unsafe conflict-copy directory ${directory}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function checkCopyParents(root: string, file: string, create: boolean): boolean {
  const directory = path.dirname(file);
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("conflict copy escapes its private directory");
  }
  let current = root;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    // A raw saved file can occupy this slot's desired directory pathname.
    if (current !== root && lstatSync(current, { throwIfNoEntry: false })?.isFile()) {
      if (!create) return false;
      throw Object.assign(new Error("conflict-copy slot already contains a file"), { code: "ENOTDIR" });
    }
    if (!checkPrivateDirectory(current)) {
      if (!create) return false;
      mkdirSync(current, { recursive: true, mode: 0o700 });
      if (!checkPrivateDirectory(current)) throw new Error(`missing conflict-copy directory ${current}`);
    }
  }
  return true;
}

/** The slots that exist on disk, in ascending order: oldest copy first for any one file. */
function existingSlots(exportDir: string): number[] {
  const slots = checkPrivateDirectory(exportDir) ? [1] : [];
  const repeats = `${exportDir}.repeat`;
  const names = checkPrivateDirectory(repeats) ? readdirSync(repeats) : [];
  for (const name of names) if (/^[1-9][0-9]*$/.test(name) && name !== "1") slots.push(Number(name));
  return slots.sort((a, b) => a - b);
}

function readIfFile(file: string): Buffer | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) return null;
    // On hosts without O_NOFOLLOW, only consume the descriptor when the current name is
    // itself a regular file and names the same object.
    const named = lstatSync(file);
    if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1) return null;
    return readFileSync(descriptor);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * True when a copy of `file` here would collide with what the slot holds: the path itself, the body
 * companion it would need, or (for a path shaped like a companion) the copy that companion belongs to.
 */
function slotTaken(file: string): boolean {
  if (existsSync(file) || existsSync(bodyCompanionPath(file))) return true;
  return file.endsWith(".body.md") && existsSync(file.replace(/\.body\.md$/, ".md"));
}

/**
 * Save `bytes` as a new copy of `relPath` and return where it landed. An identical copy already
 * saved is that copy: a retried conflict adds no file.
 */
export function saveConflictCopy(exportDir: string, relPath: string, bytes: Buffer, onCreate?: (file: string) => void): string {
  let highest = 0;
  for (const slot of existingSlots(exportDir)) {
    const root = slotDir(exportDir, slot);
    const file = path.join(root, relPath);
    const existing = checkCopyParents(root, file, false) ? readIfFile(file) : null;
    if (existing === null) continue;
    if (existing.equals(bytes)) return path.join(slotDir(exportDir, slot), relPath);
    highest = slot;
  }
  for (let slot = highest + 1; ; slot++) {
    const root = slotDir(exportDir, slot);
    const file = path.join(root, relPath);
    if (slotTaken(file)) continue;
    // A raw file's copy can sit where this path needs a folder: this slot is taken, the next is not.
    try {
      checkCopyParents(root, file, true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTDIR") continue;
      throw error;
    }
    const temp = path.join(path.dirname(file), `${TEMP_PREFIX}${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temp, bytes, { mode: 0o600, flag: "wx", flush: true });
      linkSync(temp, file);
      onCreate?.(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

/**
 * Give a saved copy its body companion and return its path, or null when that path already holds
 * something else. A copy reused for matching bytes already has its companion; the path can also
 * hold another document's copy from before repeat conflicts were kept apart, and that stays.
 */
export function saveBodyCompanion(copyPath: string, body: string, onCreate?: (file: string) => void): string | null {
  const companion = bodyCompanionPath(copyPath);
  try {
    writeFileSync(companion, body, { mode: 0o600, flag: "wx" });
    onCreate?.(companion);
    return companion;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readIfFile(companion)?.equals(Buffer.from(body, "utf8")) ? companion : null;
}

/**
 * Save a new copy of `relPath` and, for a document whose bytes decode losslessly and parse, its body
 * companion: the literally executable `doc update --body-file` input. A lossy decode would apply a
 * corrupted body, so such a copy has none, and a parse failure only means no runnable chain.
 */
export function saveCopyWithBody(
  exportDir: string, relPath: string, bytes: Buffer, isDoc: boolean, onCreate?: (file: string) => void,
): { exportPath: string; bodyExportPath: string | null } {
  const exportPath = saveConflictCopy(exportDir, relPath, bytes, onCreate);
  if (!isDoc) return { exportPath, bodyExportPath: null };
  try {
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) return { exportPath, bodyExportPath: null };
    return { exportPath, bodyExportPath: saveBodyCompanion(exportPath, parseMarkdown(decoded, relPath).body, onCreate) };
  } catch {
    return { exportPath, bodyExportPath: null };
  }
}

/** True when `companion` holds exactly the body of the copy beside it. */
function isCompanionOf(copy: string, companion: string): boolean {
  const bytes = readIfFile(copy);
  const body = readIfFile(companion);
  if (bytes === null || body === null) return false;
  try {
    return body.equals(Buffer.from(parseMarkdown(bytes.toString("utf8"), copy).body, "utf8"));
  } catch {
    return false;
  }
}

/** One saved copy on disk. */
export interface SavedCopy {
  relPath: string;
  file: string;
  /** The body-only companion, when this copy has one. */
  bodyFile: string | null;
}

function walk(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && checkPrivateDirectory(full)) walk(root, full, out);
    else if (entry.isFile() && !entry.name.startsWith(TEMP_PREFIX)) out.push(path.relative(root, full));
  }
}

/** Every saved copy on this board, oldest first for any one file. */
export function listSavedCopies(exportDir: string): SavedCopy[] {
  const copies: SavedCopy[] = [];
  for (const slot of existingSlots(exportDir)) {
    const root = slotDir(exportDir, slot);
    const files: string[] = [];
    if (checkPrivateDirectory(root)) walk(root, root, files);
    const present = new Set(files);
    const paired = (rel: string): boolean => {
      const companion = bodyCompanionPath(rel);
      return rel.endsWith(".md") && companion !== rel && present.has(companion) && isCompanionOf(path.join(root, rel), path.join(root, companion));
    };
    for (const rel of files.sort()) {
      if (rel.endsWith(".body.md")) {
        const owner = rel.replace(/\.body\.md$/, ".md");
        if (present.has(owner) && paired(owner)) continue;
        // A companion whose copy was removed by hand is no document: every saved document opens
        // with frontmatter, and a companion is the part after it.
        if (!present.has(owner) && !readIfFile(path.join(root, rel))?.subarray(0, 3).equals(Buffer.from("---"))) continue;
      }
      copies.push({
        relPath: rel.split(path.sep).join("/"),
        file: path.join(root, rel),
        bodyFile: paired(rel) ? path.join(root, bodyCompanionPath(rel)) : null,
      });
    }
  }
  return copies;
}
