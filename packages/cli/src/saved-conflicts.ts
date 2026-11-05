// What is still unsettled among a Git board's saved conflict copies, derived each time from the
// copies and the document as it stands. A copy whose content the document already carries, apart
// from engine stamps, is settled however it got there. So is a lost claim race: a copy that differs
// from the document only by the one-line owner field its kind declares holds nothing else of the
// person's, and the run reports the value it held. Both are judged on the file's text.
// Everything else stays named until `--resolve` or removing the file: any other difference, a state
// field included, is something the person wrote.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { conceptIdFromPath, parseMarkdown } from "@superbee/core";
import { boardRefOf, isConceptDocPath, listSavedCopies, readDocBytesAtRef, type SavedCopy } from "@superbee/board-git";
import { commandFragment, commandToken, type CommandPrefix, type CommandText } from "./command-text.js";
import { ENGINE_STAMPED_FIELDS, loadClaimPolicy, recordedOwner, type ClaimPolicy } from "./commands/sync/claim-conflict.js";
import { defaultSyncStore } from "./cursor.js";

/** Different invalid bytes decode to the same text, so only a lossless decode can be compared as text. */
export function decodesLosslessly(bytes: Buffer): boolean {
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

/** A one-line top-level value with nothing beside it: no comment, no collection, no block scalar. */
const ONE_LINE_VALUE = /^(?:"[^"#]*"|'[^'#]*'|[^\s\[\]{}|>&*!#'"-][^#]*)?$/;

/**
 * The document as text with its engine stamps and, when named, its owner field removed, or null when
 * that cannot be done with certainty. Parsed values cannot judge this: YAML drops comments and rounds
 * large numbers, so two versions that read as equal can still hold different words.
 */
function comparableText(relPath: string, bytes: Buffer, ownerField?: string): string | null {
  if (!isConceptDocPath(relPath) || !decodesLosslessly(bytes)) return null;
  const text = bytes.toString("utf8");
  const close = text.indexOf("\n---\n", 3);
  if (!text.startsWith("---\n") || close === -1) return null;
  const lines = text.slice(4, close).split("\n");
  const kept: string[] = [];
  const continues = (line: string | undefined): boolean => line !== undefined && /^(?:\s|-(?:\s|$))/.test(line);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const key = /^([^\s#:'"-][^\s:]*):(?:\s|$)/.exec(line)?.[1];
    if (key !== undefined && key === ownerField) {
      if (continues(lines[index + 1]) || !ONE_LINE_VALUE.test(line.slice(key.length + 1).trim())) return null;
    } else if (key !== undefined && ENGINE_STAMPED_FIELDS.has(key)) {
      if (line.includes("#")) return null;
      while (continues(lines[index + 1])) {
        if (lines[++index]!.includes("#")) return null;
      }
    } else {
      kept.push(line);
    }
  }
  return `${kept.join("\n")}\n---\n${text.slice(close + 5)}`;
}

/** True when the document as it stands holds everything the saved copy would add. */
export function copyIsCarried(relPath: string, copy: Buffer, current: Buffer | null): boolean {
  if (current === null) return false;
  if (copy.equals(current)) return true;
  const saved = comparableText(relPath, copy);
  return saved !== null && saved === comparableText(relPath, current);
}

/** The owner field's two values when the copy differs from the document by that field alone, or null. */
function lostClaim(relPath: string, copy: Buffer, current: Buffer, policy: ClaimPolicy): { owner?: string; yourOwner?: string } | null {
  try {
    const fields = parseMarkdown(current.toString("utf8"), relPath).frontmatter as Record<string, unknown>;
    const ownerField = policy.forType(fields.type)?.ownerField;
    if (ownerField === undefined) return null;
    const saved = comparableText(relPath, copy, ownerField);
    if (saved === null || saved !== comparableText(relPath, current, ownerField)) return null;
    const owner = recordedOwner(fields, ownerField);
    const yourOwner = recordedOwner(parseMarkdown(copy.toString("utf8"), relPath).frontmatter as Record<string, unknown>, ownerField);
    return { ...(owner !== undefined ? { owner } : {}), ...(yourOwner !== undefined ? { yourOwner } : {}) };
  } catch {
    return null;
  }
}

/** A lost claim race that a sync settled: the document, who holds it now, and what the copy said. */
export interface SettledClaim {
  id: string;
  owner?: string;
  your_owner?: string;
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

async function classify(boardPath: string, key: string): Promise<{ unsettled: UnsettledConflict[]; carried: SavedCopy[]; lostClaims: { copy: SavedCopy; claim: SettledClaim }[] }> {
  const byPath = new Map<string, UnsettledConflict>();
  const carried: SavedCopy[] = [];
  const lostClaims: { copy: SavedCopy; claim: SettledClaim }[] = [];
  // Loaded at most once, and only when a saved copy is not already carried.
  let policy: ClaimPolicy | undefined;
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
      if (current !== null && isConceptDocPath(copy.relPath)) {
        policy ??= await loadClaimPolicy(boardPath);
        const lost = lostClaim(copy.relPath, bytes, current, policy);
        if (lost !== null) {
          lostClaims.push({
            copy,
            claim: { id: conceptIdFromPath(copy.relPath), ...(lost.owner !== undefined ? { owner: lost.owner } : {}), ...(lost.yourOwner !== undefined ? { your_owner: lost.yourOwner } : {}) },
          });
          continue;
        }
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
  return { unsettled: [...byPath.values()], carried, lostClaims };
}

/** The saved conflicts still to settle on this board: local state and the working tree only. */
export async function unsettledConflicts(boardPath: string, key: string): Promise<UnsettledConflict[]> {
  return (await classify(boardPath, key)).unsettled;
}

/**
 * Remove the copies with nothing left to lose, so a later change to the document cannot make one
 * read as unsettled again, and return the lost claims among them for the run to report once. Only a
 * full sync calls this, before it moves anything.
 */
export async function removeCarriedCopies(boardPath: string, key: string): Promise<SettledClaim[]> {
  const { carried, lostClaims } = await classify(boardPath, key);
  const settled = new Map<string, SettledClaim>();
  for (const { copy, claim } of lostClaims) {
    carried.push(copy);
    settled.set(claim.id, claim);
  }
  for (const copy of carried) {
    // A copy that cannot be removed is judged again next time, which costs nothing.
    await rm(copy.file, { force: true }).catch(() => {});
    if (copy.bodyFile !== null) await rm(copy.bodyFile, { force: true }).catch(() => {});
  }
  return [...settled.values()];
}

/** The command that shows one unsettled document's first copy. */
export function inspectCommand(inv: CommandPrefix, id: string, dir: string | undefined): CommandText {
  const suffix = dir === undefined ? commandFragment`` : commandFragment` --dir ${commandToken(dir)}`;
  return commandFragment`${inv} sync --inspect --doc ${commandToken(id)}${suffix}`;
}

export function removeCommand(copy: SavedCopy): string {
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
