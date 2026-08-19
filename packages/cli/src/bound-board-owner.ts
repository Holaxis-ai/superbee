/**
 * The capability boundary for a project binding that points at a board worktree.
 *
 * Ordinary bundle discovery answers "which directory contains documents?".  A bound board
 * additionally needs to prove that that directory is the board worktree of its direct owner
 * before a command may use Git or private sync state.  Keep that proof CLI-owned: board-git is
 * deliberately unaware of project bindings.
 */
import { lstat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { BOARD_BRANCH, BOARD_REMOTE, BUNDLE_DIRS, repoTopLevel, resolveBundleKey, runGit } from "@superbee/board-git";
import type { Bundle } from "@superbee/core";

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

const owners = new WeakMap<Bundle, BoundBoardOwner>();

export function boundBoardOwnerForBundle(bundle: Bundle): BoundBoardOwner | undefined {
  return owners.get(bundle);
}

export function rememberBoundBoardOwner(bundle: Bundle, owner: BoundBoardOwner | undefined): void {
  if (owner) owners.set(bundle, owner);
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
export async function validateBoundBoardOwner(target: LocalBundleTarget): Promise<BoundBoardOwner | undefined> {
  if (target.selectedBy !== "project-binding") return undefined;
  const bindingFile = target.bindingFile;
  if (!bindingFile) throw failure(target, "binding", "the selected binding has no source path");

  let stat;
  try {
    stat = await lstat(target.root);
  } catch {
    throw failure(target, "target", "the selected target is unavailable");
  }
  if (stat.isSymbolicLink()) throw failure(target, "target", "the selected target must not be a symlink");

  const bundleRoot = await realpath(target.canonicalRoot);
  const bundleDir = path.basename(bundleRoot) as BoundBoardOwner["bundleDir"];
  if (!BUNDLE_DIRS.includes(bundleDir)) throw failure(target, "bundle-name", "the selected target is not a recognized bundle directory");
  const ownerRoot = path.dirname(bundleRoot);

  if (repoTopLevel(bundleRoot) !== bundleRoot) throw failure(target, "worktree-root", "the selected bundle is not its own Git worktree root");
  if (repoTopLevel(ownerRoot) !== ownerRoot) throw failure(target, "owner-root", "the selected bundle's direct parent is not its owner checkout");

  const candidateGit = runGit(bundleRoot, ["rev-parse", "--git-common-dir"]);
  const ownerGit = runGit(ownerRoot, ["rev-parse", "--git-common-dir"]);
  const commonGitDir = candidateGit.status === 0 ? canonicalGitPath(bundleRoot, candidateGit.stdout.trim()) : null;
  const ownerCommonGitDir = ownerGit.status === 0 ? canonicalGitPath(ownerRoot, ownerGit.stdout.trim()) : null;
  if (!commonGitDir || !ownerCommonGitDir || commonGitDir !== ownerCommonGitDir) {
    throw failure(target, "common-git-dir", "the selected worktree does not share its owner's Git common directory");
  }

  const registered = runGit(ownerRoot, ["worktree", "list", "--porcelain"]);
  const listed = registered.status === 0 && registered.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => canonicalGitPath(ownerRoot, line.slice("worktree ".length).trim()) === bundleRoot);
  if (!listed) throw failure(target, "worktree-registration", "the selected worktree is not registered by its owner");

  const branch = runGit(bundleRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0 || branch.stdout.trim() !== BOARD_BRANCH) {
    throw failure(target, "branch", `the selected worktree is not on the '${BOARD_BRANCH}' branch`);
  }

  const remoteProbe = runGit(ownerRoot, ["remote", "get-url", BOARD_REMOTE]);
  const remoteUrl = remoteProbe.status === 0 && remoteProbe.stdout.trim() ? remoteProbe.stdout.trim() : undefined;
  return {
    selection: "project-binding",
    bindingFile,
    bundleRoot,
    ownerRoot,
    commonGitDir,
    bundleDir,
    boardBranch: BOARD_BRANCH,
    remote: { name: BOARD_REMOTE, ...(remoteUrl ? { url: remoteUrl } : {}), label: remoteUrl ? BOARD_REMOTE : "no origin" },
    stateKey: resolveBundleKey(bundleRoot),
  };
}
