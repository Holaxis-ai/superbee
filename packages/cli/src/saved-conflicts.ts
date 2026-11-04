// What is still unsettled among a Git board's saved conflict copies, derived each time from the
// copies and the document as it stands. A copy whose content the document already carries is
// settled however it got there (`--resolve`, the `doc update --body-file` chain, a matching edit),
// and so is one that differs only by a claim the teammate's version won: there is nothing of the
// person's left in it to lose. Everything else stays named until `--resolve` or removing the file.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { conceptIdFromPath, parseMarkdown } from "@superbee/core";
import { isConceptDocPath, listSavedCopies, type SavedCopy } from "@superbee/board-git";
import { commandFragment, commandToken, type CommandPrefix, type CommandText } from "./command-text.js";
import { defaultSyncStore } from "./cursor.js";

/** Frontmatter keys, engine stamps excluded, whose values differ between two parsed versions. */
function differingFields(left: Record<string, unknown>, right: Record<string, unknown>, stamped: ReadonlySet<string>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !stamped.has(key) && JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
}

/** True when the document as it stands holds everything the saved copy would add. */
export async function copyIsCarried(boardPath: string, relPath: string, copy: Buffer, current: Buffer | null): Promise<boolean> {
  if (current === null) return false;
  if (copy.equals(current)) return true;
  if (!isConceptDocPath(relPath)) return false;
  let saved: ReturnType<typeof parseMarkdown>;
  let now: ReturnType<typeof parseMarkdown>;
  try {
    saved = parseMarkdown(copy.toString("utf8"), relPath);
    now = parseMarkdown(current.toString("utf8"), relPath);
  } catch {
    return false;
  }
  if (saved.body !== now.body) return false;
  // Loaded only here: a board with no saved copy never reads its kinds for this.
  const { ENGINE_STAMPED_FIELDS, loadClaimPolicy } = await import("./commands/sync/claim-conflict.js");
  const savedFields = saved.frontmatter as Record<string, unknown>;
  const nowFields = now.frontmatter as Record<string, unknown>;
  const differs = differingFields(savedFields, nowFields, ENGINE_STAMPED_FIELDS);
  if (differs.length === 0) return true;
  const coordinates = (await loadClaimPolicy(boardPath)).forType(nowFields.type);
  const owner = coordinates?.ownerField;
  return owner !== undefined && differs.includes(owner) && differs.every((key) => coordinates!.fields.includes(key));
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** One file with saved copies still to settle. */
export interface UnsettledConflict {
  relPath: string;
  /** The document id, or null for a raw or reserved file that the conflict verbs do not take. */
  id: string | null;
  /** Oldest first; the verbs settle them in this order, so the newest has the last word. */
  copies: SavedCopy[];
}

async function classify(boardPath: string, key: string): Promise<{ unsettled: UnsettledConflict[]; carried: SavedCopy[] }> {
  const byPath = new Map<string, UnsettledConflict>();
  const carried: SavedCopy[] = [];
  for (const copy of listSavedCopies(defaultSyncStore.exportsDir(key))) {
    const bytes = await readOrNull(copy.file);
    if (bytes === null) continue;
    const current = await readOrNull(path.join(boardPath, copy.relPath));
    if (await copyIsCarried(boardPath, copy.relPath, bytes, current)) {
      carried.push(copy);
      continue;
    }
    const entry = byPath.get(copy.relPath) ?? { relPath: copy.relPath, id: isConceptDocPath(copy.relPath) ? conceptIdFromPath(copy.relPath) : null, copies: [] };
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
    await rm(copy.file, { force: true });
    if (copy.bodyFile !== null) await rm(copy.bodyFile, { force: true });
  }
}

/** The command that shows one unsettled document's first copy. */
export function inspectCommand(inv: CommandPrefix, id: string, dir: string | undefined): CommandText {
  const suffix = dir === undefined ? commandFragment`` : commandFragment` --dir ${commandToken(dir)}`;
  return commandFragment`${inv} sync --inspect --doc ${commandToken(id)}${suffix}`;
}

/** The row `sync` reports for one unsettled file. */
export function unsettledRow(conflict: UnsettledConflict, inv: CommandPrefix, dir: string | undefined): Record<string, unknown> {
  const newest = conflict.copies[conflict.copies.length - 1]!;
  return {
    ...(conflict.id !== null ? { id: conflict.id } : { path: conflict.relPath }),
    saved_at: newest.file,
    copies: conflict.copies.length,
    next:
      conflict.id !== null
        ? String(inspectCommand(inv, conflict.id, dir))
        : `merge what you need into ${conflict.relPath} by hand, then delete the saved file`,
  };
}

/** The one sentence every surface uses for what is still unsettled. */
export function unsettledMessage(unsettled: readonly UnsettledConflict[]): string {
  const names = unsettled.map((conflict) => conflict.id ?? conflict.relPath);
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return `${names.length} saved conflict${names.length === 1 ? "" : "s"} still need${names.length === 1 ? "s" : ""} a decision: ${shown}${more}`;
}
