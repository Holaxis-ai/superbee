// Where a bundle lives: its home, `local`, `git` or `hosted`.
//
// The folder is always the working copy; the home decides only how its changes travel. Every
// command that names a bundle reports it from this one derivation, so `bundle locate`, `status`,
// `home` and `session-start` never disagree. It reads private state and local Git only: no
// request, no fetch, no sign-in.
//
//   hosted  the folder is a live hosted checkout (its private binding, keyed by path and folder
//           identity, names it)
//   git     the folder is a Git board: the provisioned `board` worktree, or the conventional
//           bundle committed with the code on the current branch (in-tree)
//   local   everything else, including a bundle not yet shared with `sync --establish`
//
// A local or Git folder that carries a hosted checkout marker (`.superbee/checkout.json`) but no
// binding is reported as a `copy` of a checkout: moved, copied or restored. The marker never
// changes the home; only `checkout --adopt` binds the folder again.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  BOARD_BRANCH,
  BOARD_REF,
  committedBundleAtHead,
  countUncommitted,
  hasWorktreeSignature,
  inTreeBehindCount,
  inTreeUnpushedCount,
  inTreeUpstreamSha,
  resolveInTreeUpstream,
  runGit,
  type BundleDirName,
} from "@superbee/board-git";

import { bindingForPath, type CheckoutBinding } from "./hosted/binding.js";
import { readCheckoutMarker, unboundCopyDetail, type CheckoutMarker } from "./hosted/marker.js";

export type BundleHome = "local" | "git" | "hosted";

/** A Git board as local Git sees it. */
export interface GitBoardFacts {
  /** `branch` for the provisioned `board` worktree, `in-tree` for a bundle committed with the code. */
  readonly channel: "branch" | "in-tree";
  /** The checked-out branch (`board` for the worktree), or null when detached. */
  readonly branch: string | null;
  /** The tracking ref (`origin/board`, `origin/main`), or null when there is none. */
  readonly upstream: string | null;
  /** True once the branch tracks an upstream: teammates reach it through `sync`. */
  readonly shared: boolean;
  /** The Git working tree that holds the bundle, and the bundle's path inside it ("" for the worktree). */
  readonly top: string;
  readonly prefix: BundleDirName | "";
}

/** A hosted checkout marker found in a folder that is not bound: the folder and what its marker says. */
export interface UnboundCopy {
  readonly folder: string;
  readonly marker: CheckoutMarker;
}

export type BundleHomeFacts =
  | { readonly home: "local"; readonly copy?: UnboundCopy }
  | { readonly home: "git"; readonly board: GitBoardFacts; readonly copy?: UnboundCopy }
  | { readonly home: "hosted"; readonly binding: CheckoutBinding };

function gitText(dir: string, args: string[]): string | null {
  try {
    const result = runGit(dir, args);
    const text = result.stdout.trim();
    return result.status === 0 && text.length > 0 ? text : null;
  } catch {
    // No git binary, or a timed-out spawn: no Git evidence.
    return null;
  }
}

async function canonical(dir: string): Promise<string | null> {
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

/** The Git board this canonical bundle root is, from local Git only, or null. */
export async function gitBoardAt(canonicalRoot: string): Promise<GitBoardFacts | null> {
  const topText = gitText(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (topText === null) return null;
  const top = await canonical(topText);
  if (top === null) return null;

  if (top === canonicalRoot) {
    // The bundle is a working tree's root: a board only when the `board` branch is checked out there.
    const branch = gitText(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
    if (branch !== BOARD_BRANCH) return null;
    // Sync compares the board with `origin/board` whether or not the branch tracks it.
    const upstream =
      gitText(top, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]) ??
      (gitText(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]) === null ? null : BOARD_REF);
    return { channel: "branch", branch, upstream, shared: upstream !== null, top, prefix: "" };
  }

  let committed;
  try {
    committed = committedBundleAtHead(top);
  } catch {
    return null;
  }
  if (!committed || path.join(top, committed.bundleDir) !== canonicalRoot) return null;
  if (hasWorktreeSignature(canonicalRoot)) return null;
  const resolved = resolveInTreeUpstream(top);
  const upstream = resolved.state === "ok" ? resolved.config.ref : null;
  const branch = resolved.state === "ok" ? resolved.config.branch : gitText(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return { channel: "in-tree", branch, upstream, shared: upstream !== null, top, prefix: committed.bundleDir };
}

/**
 * The home of the bundle at this canonical root. `home` is the directory whose private state holds
 * hosted checkout bindings (default: the OS home). Never throws: unreadable evidence reads as local.
 */
export async function bundleHomeAt(canonicalRoot: string, options: { home?: string } = {}): Promise<BundleHomeFacts> {
  const binding = await bindingForPath(options.home ?? homedir(), canonicalRoot).catch(() => null);
  if (binding) return { home: "hosted", binding };
  const marker = readCheckoutMarker(canonicalRoot);
  const copy = marker ? { copy: { folder: canonicalRoot, marker } } : {};
  const board = await gitBoardAt(canonicalRoot).catch(() => null);
  if (board) return { home: "git", board, ...copy };
  return { home: "local", ...copy };
}

/** The `copy_of_checkout` detail for a marked folder that is not bound, or nothing. */
export function unboundCopyOf(facts: BundleHomeFacts): Record<string, unknown> {
  if (facts.home === "hosted" || !facts.copy) return {};
  return unboundCopyDetail(facts.copy.folder, facts.copy.marker);
}

/** The `hosted` or `board` detail a receipt carries beside `home`. */
export function homeDetail(facts: BundleHomeFacts): Record<string, unknown> {
  if (facts.home === "hosted") {
    const { binding } = facts;
    return { hosted: { host: binding.origin, bundle_id: binding.bundle_id, workspace: binding.workspace, principal: binding.principal_id } };
  }
  if (facts.home === "git") {
    const { board } = facts;
    return { board: { channel: board.channel, branch: board.branch, upstream: board.upstream, shared: board.shared }, ...unboundCopyOf(facts) };
  }
  return unboundCopyOf(facts);
}

function count(dir: string, args: string[]): number | null {
  const text = gitText(dir, args);
  if (text === null) return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

/** The newest FETCH_HEAD this working tree or its repository has: a fetch from either one counts. */
async function lastFetch(top: string): Promise<string | null> {
  const own = gitText(top, ["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"]);
  const common = gitText(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  let newest: Date | null = null;
  for (const file of [own, common === null ? null : path.join(common, "FETCH_HEAD")]) {
    if (file === null) continue;
    try {
      const { mtime } = await stat(file);
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Never fetched from there.
    }
  }
  return newest === null ? null : newest.toISOString();
}

/**
 * The `sync` block `status` reports for a Git board, from local Git only (no fetch): what the next
 * `sync` would push (`ahead`, `uncommitted`) and what the last fetch saw upstream (`behind`).
 */
export async function gitBoardSyncBlock(board: GitBoardFacts): Promise<Record<string, unknown>> {
  const block: Record<string, unknown> = {
    channel: board.channel,
    branch: board.branch,
    upstream: board.upstream,
  };
  let ahead: number | null = null;
  let behind: number | null = null;
  const prefix = board.prefix;
  if (board.upstream !== null) {
    if (board.channel === "branch") {
      ahead = count(board.top, ["rev-list", "--count", `${board.upstream}..HEAD`]);
      behind = count(board.top, ["rev-list", "--count", `HEAD..${board.upstream}`]);
    } else if (prefix !== "" && inTreeUpstreamSha(board.top, board.upstream) !== null) {
      ahead = inTreeUnpushedCount(board.top, board.upstream, prefix);
      behind = inTreeBehindCount(board.top, board.upstream, prefix);
    }
  }
  let uncommitted: number | null;
  try {
    uncommitted = prefix === "" ? countUncommitted(board.top) : countUncommitted(board.top, prefix);
  } catch {
    uncommitted = null;
  }
  block.state =
    board.upstream === null
      ? "not_shared"
      : (ahead ?? 0) > 0 && (behind ?? 0) > 0
        ? "diverged"
        : (ahead ?? 0) > 0 || (uncommitted ?? 0) > 0
          ? "unsent_changes"
          : (behind ?? 0) > 0
            ? "behind"
            : "clean";
  block.ahead = ahead;
  block.behind = behind;
  block.uncommitted = uncommitted;
  block.last_fetch = await lastFetch(board.top);
  return block;
}
