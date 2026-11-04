// What is still unsettled among a Git board's saved conflict copies, derived each time from the
// copies and the document as it stands. A copy whose content the document already carries, apart
// from engine stamps, is settled however it got there. Everything else stays named until `--resolve`
// or removing the file: any other difference is something the person wrote.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { conceptIdFromPath, parseMarkdown } from "@superbee/core";
import { boardRefOf, isConceptDocPath, listSavedCopies, readDocBytesAtRef, type SavedCopy } from "@superbee/board-git";
import { commandFragment, commandToken, type CommandPrefix, type CommandText } from "./command-text.js";
import { ENGINE_STAMPED_FIELDS } from "./commands/sync/claim-conflict.js";
import { defaultSyncStore } from "./cursor.js";

/** Frontmatter keys, engine stamps excluded, whose values differ between two parsed versions. */
function differingFields(left: Record<string, unknown>, right: Record<string, unknown>, stamped: ReadonlySet<string>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !stamped.has(key) && JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

/** True when the document as it stands holds everything the saved copy would add. */
export function copyIsCarried(relPath: string, copy: Buffer, current: Buffer | null): boolean {
  if (current === null) return false;
  if (copy.equals(current)) return true;
  if (!isConceptDocPath(relPath)) return false;
  // Different invalid bytes decode to the same text, so only a lossless decode can be compared as text.
  const lossless = (bytes: Buffer): boolean => Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
  if (!lossless(copy) || !lossless(current)) return false;
  let saved: ReturnType<typeof parseMarkdown>;
  let now: ReturnType<typeof parseMarkdown>;
  try {
    saved = parseMarkdown(copy.toString("utf8"), relPath);
    now = parseMarkdown(current.toString("utf8"), relPath);
  } catch {
    return false;
  }
  return saved.body === now.body && differingFields(saved.frontmatter as Record<string, unknown>, now.frontmatter as Record<string, unknown>, ENGINE_STAMPED_FIELDS).length === 0;
}

/** The file's bytes, or null when it is absent. Any other failure is the caller's to report. */
async function readIfThere(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** One file with saved copies still to settle. */
export interface UnsettledConflict {
  relPath: string;
  /** The document id, or null for a raw or reserved file that the conflict verbs do not take. */
  id: string | null;
  /** Oldest first; the verbs settle them in this order, so the newest has the last word. */
  copies: SavedCopy[];
  /**
   * What discards a copy and leaves the document as it is: take when the document equals the
   * upstream version or is absent there too, revise when it holds local edits a take would undo,
   * and removing the file when the person deleted the document, which a take would restore.
   */
  discardWith: "take" | "revise" | "remove";
  /** Set when a copy could not be compared: the verbs may fail on it too, so only removing it is offered. */
  unreadable?: boolean;
}

async function classify(boardPath: string, key: string): Promise<{ unsettled: UnsettledConflict[]; carried: SavedCopy[] }> {
  const byPath = new Map<string, UnsettledConflict>();
  const carried: SavedCopy[] = [];
  for (const copy of listSavedCopies(defaultSyncStore.exportsDir(key))) {
    let discardWith: UnsettledConflict["discardWith"] = "remove";
    let unreadable = false;
    // Reporting a copy can never stop a sync: what cannot be read stays listed, as unsettled.
    try {
      const bytes = await readIfThere(copy.file);
      if (bytes === null) continue;
      const current = await readIfThere(path.join(boardPath, copy.relPath));
      if (copyIsCarried(copy.relPath, bytes, current)) {
        carried.push(copy);
        continue;
      }
      const upstream = readDocBytesAtRef(boardPath, `refs/remotes/${boardRefOf(boardPath)}`, copy.relPath);
      discardWith = current === null ? (upstream === null ? "take" : "remove") : upstream === null || !current.equals(upstream) ? "revise" : "take";
    } catch {
      unreadable = true;
    }
    const entry = byPath.get(copy.relPath) ?? { relPath: copy.relPath, id: isConceptDocPath(copy.relPath) ? conceptIdFromPath(copy.relPath) : null, copies: [], discardWith };
    if (unreadable) entry.unreadable = true;
    entry.copies.push(copy);
    byPath.set(copy.relPath, entry);
  }
  return { unsettled: [...byPath.values()], carried };
}

/** The saved conflicts still to settle on this board: local state and the working tree only. */
export async function unsettledConflicts(boardPath: string, key: string): Promise<UnsettledConflict[]> {
  return (await classify(boardPath, key)).unsettled;
}

/**
 * Remove the copies the document already carries, so a later change to the document cannot make
 * one read as unsettled again. Only a full sync calls this, before it moves anything.
 */
export async function removeCarriedCopies(boardPath: string, key: string): Promise<void> {
  for (const copy of (await classify(boardPath, key)).carried) {
    // A copy that cannot be removed is judged again next time, which costs nothing.
    await rm(copy.file, { force: true }).catch(() => {});
    if (copy.bodyFile !== null) await rm(copy.bodyFile, { force: true }).catch(() => {});
  }
}

/** The command that shows one unsettled document's first copy. */
export function inspectCommand(inv: CommandPrefix, id: string, dir: string | undefined): CommandText {
  const suffix = dir === undefined ? commandFragment`` : commandFragment` --dir ${commandToken(dir)}`;
  return commandFragment`${inv} sync --inspect --doc ${commandToken(id)}${suffix}`;
}

function removeCommand(copy: SavedCopy): string {
  return `rm ${commandToken(copy.file)}${copy.bodyFile === null ? "" : ` ${commandToken(copy.bodyFile)}`}`;
}

/** The row `sync` reports for one unsettled file. */
export function unsettledRow(conflict: UnsettledConflict, inv: CommandPrefix, dir: string | undefined): Record<string, unknown> {
  const newest = conflict.copies[conflict.copies.length - 1]!;
  const suffix = dir === undefined ? commandFragment`` : commandFragment` --dir ${commandToken(dir)}`;
  return {
    ...(conflict.id !== null ? { id: conflict.id } : { path: conflict.relPath }),
    saved_at: newest.file,
    copies: conflict.copies.length,
    ...(conflict.unreadable ? { note: "this copy could not be compared with the document or its upstream version, so it stays listed" } : {}),
    next:
      conflict.id !== null && !conflict.unreadable
        ? String(inspectCommand(inv, conflict.id, dir))
        : `merge what you need into ${conflict.relPath} by hand, then delete the saved file`,
    discard:
      conflict.id !== null && conflict.discardWith !== "remove" && !conflict.unreadable
        ? String(commandFragment`${inv} sync --resolve ${commandToken(conflict.discardWith)} --doc ${commandToken(conflict.id)}${suffix}`)
        : removeCommand(conflict.copies[0]!),
  };
}

/** The one sentence every surface uses for what is still unsettled. */
export function unsettledMessage(unsettled: readonly UnsettledConflict[]): string {
  const names = unsettled.map((conflict) => conflict.id ?? conflict.relPath);
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return `${names.length} saved conflict${names.length === 1 ? "" : "s"} still need${names.length === 1 ? "s" : ""} a decision: ${shown}${more}`;
}
