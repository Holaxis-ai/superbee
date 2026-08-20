/**
 * The capability boundary for a project binding that points at a board worktree.
 *
 * Ordinary bundle discovery answers "which directory contains documents?".  A bound board
 * additionally needs to prove that that directory is the board worktree of its direct owner
 * before a command may use Git or private sync state.  Keep that proof CLI-owned: board-git is
 * deliberately unaware of project bindings.
 */
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  BOARD_BRANCH,
  BOARD_REMOTE,
  BUNDLE_DIRS,
  detectStaleRebase,
  rebaseWasFromBoardBranch,
  repoTopLevel,
  resolveBundleKey,
  runGit,
} from "@superbee/board-git";

import type { LocalBundleTarget } from "./bundle.js";
import { CliError } from "./errors.js";

export interface BoundBoardOwner {
  readonly selection: "project-binding";
  readonly bindingFile: string;
  readonly bundleRoot: string;
  readonly ownerRoot: string;
  readonly commonGitDir: string;
  readonly bundleDir: ".superbee" | ".agentstate-lite";
  readonly boardBranch: "board";
  readonly remote: { readonly name: "origin"; readonly url?: string; readonly label: string };
  /** Calculated after ownership proof, never re-derived from the public invocation directory. */
  readonly stateKey: string;
}

/** The route records whether this read-only proof observed an attached board or its own rebase. */
export type BoundBoardReadiness = "ready" | "recovery-pending";

export interface BoundBoardOwnerValidation {
  readonly owner: BoundBoardOwner;
  readonly readiness: BoundBoardReadiness;
}

function failure(target: LocalBundleTarget, stage: string, message: string): CliError {
  return new CliError("CONFLICT", `project binding cannot be used as a board owner: ${message}`, {
    details: {
      binding_file: target.bindingFile,
      binding_target: target.canonicalRoot,
      validation_stage: stage,
    },
  });
}

function canonicalGitPath(from: string, raw: string): string | null {
  if (!raw) return null;
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(from, raw);
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Validate a binding-selected target into the only capability board-aware code may consume.
 * Every Git call is rooted at the candidate board worktree or its direct private owner; no
 * invocation cwd is consulted after this function begins.
 */
export async function validateBoundBoardOwner(target: LocalBundleTarget): Promise<BoundBoardOwnerValidation | undefined> {
  if (target.selectedBy !== "project-binding") return undefined;
  const bindingFile = target.bindingFile;
  if (!bindingFile) throw failure(target, "binding", "the selected binding has no source path");

  const bundleRoot = await realpath(target.canonicalRoot);
  const bundleDir = path.basename(bundleRoot) as BoundBoardOwner["bundleDir"];
  if (!BUNDLE_DIRS.includes(bundleDir)) return undefined;
  const ownerRoot = path.dirname(bundleRoot);

  // A conventional name alone is ordinary bundle selection, not board authority.  It becomes a
  // candidate only when both exact roots are already worktrees sharing one common Git directory.
  if (repoTopLevel(bundleRoot) !== bundleRoot || repoTopLevel(ownerRoot) !== ownerRoot) return undefined;

  const candidateGit = runGit(bundleRoot, ["rev-parse", "--git-common-dir"]);
  const ownerGit = runGit(ownerRoot, ["rev-parse", "--git-common-dir"]);
  const commonGitDir = candidateGit.status === 0 ? canonicalGitPath(bundleRoot, candidateGit.stdout.trim()) : null;
  const ownerCommonGitDir = ownerGit.status === 0 ? canonicalGitPath(ownerRoot, ownerGit.stdout.trim()) : null;
  if (!commonGitDir || !ownerCommonGitDir || commonGitDir !== ownerCommonGitDir) return undefined;

  const registered = runGit(ownerRoot, ["worktree", "list", "--porcelain"]);
  const listed = registered.status === 0 && registered.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => canonicalGitPath(ownerRoot, line.slice("worktree ".length).trim()) === bundleRoot);
  if (!listed) throw failure(target, "worktree-registration", "the selected worktree is not registered by its owner");

  // A board-origin rebase is structural evidence of this exact worktree, but validation itself
  // is read-only.  Explicit sync owns any later recovery transition.
  const readiness: BoundBoardReadiness = detectStaleRebase(bundleRoot) ? "recovery-pending" : "ready";
  if (readiness === "recovery-pending") {
    if (!rebaseWasFromBoardBranch(bundleRoot)) {
      throw failure(target, "rebase-origin", "the selected worktree has a rebase not started from the board branch");
    }
  }

  const branch = runGit(bundleRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (readiness === "ready" && (branch.status !== 0 || branch.stdout.trim() !== BOARD_BRANCH)) {
    throw failure(target, "branch", `the selected worktree is not on the '${BOARD_BRANCH}' branch`);
  }

  const remoteProbe = runGit(ownerRoot, ["remote", "get-url", BOARD_REMOTE]);
  const remoteUrl = remoteProbe.status === 0 && remoteProbe.stdout.trim() ? remoteProbe.stdout.trim() : undefined;
  return {
    readiness,
    owner: {
      selection: "project-binding",
      bindingFile,
      bundleRoot,
      ownerRoot,
      commonGitDir,
      bundleDir,
      boardBranch: BOARD_BRANCH,
      remote: { name: BOARD_REMOTE, ...(remoteUrl ? { url: remoteUrl } : {}), label: remoteUrl ? BOARD_REMOTE : "no origin" },
      stateKey: resolveBundleKey(bundleRoot),
    },
  };
}
