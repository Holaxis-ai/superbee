// Publication-side private-state refusal (specification F8) at the CLI boundary: the one place
// sync, establishment, `publish --to hosted` and hosted checkout sync turn a private-state finding
// into the same typed CONFLICT, before anything is committed, staged or sent. Detection itself is
// `@superbee/board-git`'s `private-state.ts`, shared with the push backstop.
import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import {
  isBoardGitError,
  isPrivateStateRefusal,
  privateStateFinding,
  privateStateInOutgoingCommits,
  privateStateInOutgoingWorktree,
  privateStatePathEvidence,
  privateStateRefusal,
  readPrivateStateCandidate,
  sortPrivateStateFindings,
  type PrivateStateFinding,
  type PrivateStateRefusalContext,
} from "@superbee/board-git";

import { CliError, cliErrorFromBoardGit } from "./errors.js";

/** The refusal as a CLI error: CONFLICT (exit 5), naming the path and how to move it out. */
export function privateStateCliError(found: readonly PrivateStateFinding[], context: PrivateStateRefusalContext): CliError {
  const refusal = privateStateRefusal(found, context);
  return new CliError("CONFLICT", refusal.message, { details: refusal.details, help: refusal.help });
}

/** A push backstop's private-state refusal as the CLI error it is, or null for any other failure. */
export function asPrivateStateRefusal(error: unknown): CliError | null {
  if (!isPrivateStateRefusal(error)) return null;
  if (error instanceof CliError) return error;
  return isBoardGitError(error) ? cliErrorFromBoardGit(error) : null;
}

/** Refuse when the board worktree's outgoing files (what `git add -A` would stage) carry private state. */
export function refuseOutgoingWorktreePrivateState(boardPath: string, operation: string, rerun: string): void {
  const found = privateStateInOutgoingWorktree(boardPath);
  if (found.length > 0) throw privateStateCliError(found, { operation, root: boardPath, stage: "files", rerun });
}

/** Refuse when the objects pushing `head` would send carry private state. */
export function refuseOutgoingCommitsPrivateState(
  dir: string,
  head: string,
  context: { operation: string; rerun: string; base?: string | null; stage?: "files" | "commits"; root?: string },
): void {
  const found = privateStateInOutgoingCommits(dir, head);
  if (found.length > 0) {
    throw privateStateCliError(found, {
      operation: context.operation,
      root: context.root ?? dir,
      stage: context.stage ?? "commits",
      base: context.base ?? null,
      rerun: context.rerun,
    });
  }
}

/**
 * Private state in a folder a hosted upload reads: every plain file outside dot-folders (what
 * `publish --to hosted` and hosted sync can send), judged by name and then by its bytes, plus any
 * folder named like a guarded root at any depth, dot-folder or not, which is never bundle content
 * whether or not it would travel. `.git` and symbolic links are not entered.
 */
export function privateStateInTree(folder: string): PrivateStateFinding[] {
  const found: PrivateStateFinding[] = [];
  const visit = (prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(folder, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        const named = privateStatePathEvidence(`${rel}/-`);
        if (named?.evidence === "state_folder") {
          found.push({ path: rel, evidence: "state_folder", remove: named.remove });
          continue;
        }
        visit(rel);
        continue;
      }
      if (!entry.isFile() || rel.split("/").some((segment) => segment.startsWith("."))) continue;
      const finding = privateStateFinding(rel, readPrivateStateCandidate(path.join(folder, ...rel.split("/"))));
      if (finding) found.push(finding);
    }
  };
  visit("");
  return sortPrivateStateFindings(found);
}

/** Refuse a hosted upload of `folder` when it carries private state; nothing has been sent. */
export function refuseTreePrivateState(folder: string, operation: string, rerun: string): void {
  const found = privateStateInTree(folder);
  if (found.length > 0) throw privateStateCliError(found, { operation, root: folder, stage: "files", rerun });
}
