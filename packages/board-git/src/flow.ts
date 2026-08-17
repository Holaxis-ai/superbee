// `flow.ts` — the sync/establish ENGINE steps (board-git A1, carved from the CLI's
// `commands/sync.ts` / `commands/sync-establish.ts` per the plan's acceptance bar: git/channel
// orchestration only). Everything here is a named probe or mutation with a typed result — no
// CliError, no invocation-aware copy, no rendering. The command shells (refusal policy, preview
// records, receipts) stay in the CLI and compose these.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BOARD_BRANCH,
  BOARD_REF,
  BOARD_REMOTE,
  BUNDLE_DIRS,
  bundleDirNameForProject,
  identityFlags,
  mustGit,
  repoTopLevel,
  runGit,
  withIgnoreEntries,
  type ResolvedConflict,
  type BundleDirName,
} from "./porcelain.js";
import { BoardGitError } from "./errors.js";

// ── ref probes ────────────────────────────────────────────────────────────────

/** The commit a ref resolves to, or undefined when it doesn't resolve. */
export function refCommit(top: string, ref: string): string | undefined {
  const r = runGit(top, ["rev-parse", "--verify", "--quiet", ref]);
  const value = r.stdout.trim();
  return r.status === 0 && value ? value : undefined;
}

/** The tree object of a commit, or undefined when unavailable. */
export function treeOf(top: string, commit: string): string | undefined {
  return refCommit(top, `${commit}^{tree}`);
}

/** True when `ancestor` is contained in `descendant`'s history. */
export function isAncestor(top: string, ancestor: string, descendant: string): boolean {
  return runGit(top, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

/** True when `refs/heads/<name>` resolves. */
export function localBranchExists(top: string, name: string): boolean {
  return runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).status === 0;
}

/** The `refs/remotes/origin/board` sha, or `null` when it doesn't resolve (mirrors `unpushedCount`'s own check). */
export function resolveOriginRef(boardPath: string): string | null {
  const r = runGit(boardPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── conventional-bundle / committed-folder probes ─────────────────────────────

/** Detect a conventional local bundle by its reserved root index. */
export function hasLocalOnlyBundle(dir: string): boolean {
  const top = repoTopLevel(dir);
  if (!top) return false;
  return existsSync(path.join(top, bundleDirNameForProject(top), "index.md"));
}

/**
 * The tree object of the selected committed conventional folder at HEAD, or null when the current
 * branch carries no such folder (or carries a non-directory of that name) — the structural router
 * between the greenfield and committed-folder establish cases.
 */
export interface CommittedBundleAtHead {
  bundleDir: BundleDirName;
  tree: string;
}

/**
 * Select the conventional bundle tracked at HEAD from Git evidence alone. Filesystem state can
 * temporarily disagree during migration or recovery, so it must never choose the pathspec used
 * to inspect committed history.
 */
export function committedBundleAtHead(top: string): CommittedBundleAtHead | null {
  const found: CommittedBundleAtHead[] = [];
  for (const bundleDir of BUNDLE_DIRS) {
    const r = runGit(top, ["rev-parse", "--verify", "--quiet", `HEAD:${bundleDir}`]);
    if (r.status !== 0) continue;
    const tree = r.stdout.trim();
    const type = runGit(top, ["cat-file", "-t", tree]);
    if (type.status === 0 && type.stdout.trim() === "tree") found.push({ bundleDir, tree });
  }
  if (found.length > 1) {
    throw new BoardGitError(
      "CONFLICT",
      `both '${BUNDLE_DIRS[0]}/' and '${BUNDLE_DIRS[1]}/' are committed at HEAD — refusing to choose one project bundle`,
      {
        details: {
          phase: "git-head-bundle-selection",
          state: "committed-bundle-directory-conflict",
          directories: [...BUNDLE_DIRS],
        },
        help: "remove one committed bundle directory on the project branch before retrying",
      },
    );
  }
  return found[0] ?? null;
}

/** The tree object of the Git-selected committed conventional folder at HEAD, or null. */
export function folderTreeAtHead(top: string): string | null {
  return committedBundleAtHead(top)?.tree ?? null;
}

/** True when any board-folder path is staged in the enclosing repo's code index. */
export function folderPresentInCodeIndex(top: string): boolean {
  const r = runGit(top, ["ls-files", "--", ...BUNDLE_DIRS]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * The behind-origin freshness guard's probe: the commits on `origin/<branch>` that this clone
 * does NOT have and that TOUCH the board folder. Establishing past such a commit would orphan the
 * teammate's board commit on the frozen folder FOREVER (the root commit is cut from stale HEAD,
 * the cleanup PR merges cleanly,
 * and sync refuses everywhere). Returns null when `origin/<branch>` doesn't resolve (a
 * never-pushed branch — nothing to be behind of); commits that DON'T touch the folder are
 * deliberately not blocking (the board tree is identical either way).
 */
export function behindBoardCommits(top: string, branch: string, bundleDir: BundleDirName): string[] | null {
  const remoteRef = `refs/remotes/${BOARD_REMOTE}/${branch}`;
  if (runGit(top, ["rev-parse", "--verify", "--quiet", remoteRef]).status !== 0) return null;
  return mustGit(top, ["rev-list", `HEAD..${remoteRef}`, "--", bundleDir])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * True when `refs/remotes/origin/<branch>` is known AND no longer carries `relPath` at its tip —
 * the committed-folder establish flow's "has the folder-removal already landed upstream" probe
 * (`windowNote`). A detached-HEAD `branch` (`"HEAD"`) has no remote-tracking counterpart, so it
 * reads as not-landed rather than probing a nonsensical ref.
 */
export function pathLandedAbsentOnRemoteBranch(top: string, branch: string, relPath: string): boolean {
  if (branch === "HEAD") return false;
  const remoteRef = `refs/remotes/${BOARD_REMOTE}/${branch}`;
  const remoteBranchKnown = runGit(top, ["rev-parse", "--verify", "--quiet", remoteRef]).status === 0;
  return remoteBranchKnown && runGit(top, ["cat-file", "-e", `${remoteRef}:${relPath}`]).status !== 0;
}

/**
 * The interrupted-run remnant probe: the sha/tree/root-count triple for the local `board`
 * branch, so the committed-folder establish flow can tell a genuine crash remnant (a single
 * commit whose tree matches the folder being established) from an unrelated pre-existing branch
 * of the same name.
 */
export interface BoardBranchRemnant {
  sha: string;
  tree: string;
  count: string;
}

/** Read {@link BoardBranchRemnant} for the local `board` branch (caller ensures it exists). */
export function boardBranchRemnant(top: string): BoardBranchRemnant {
  return {
    sha: mustGit(top, ["rev-parse", `refs/heads/${BOARD_BRANCH}`]).trim(),
    tree: mustGit(top, ["rev-parse", `refs/heads/${BOARD_BRANCH}^{tree}`]).trim(),
    count: mustGit(top, ["rev-list", "--count", `refs/heads/${BOARD_BRANCH}`]).trim(),
  };
}

// ── converge annotation (the one landed probe per conflicted doc) ─────────────

/**
 * A {@link ResolvedConflict} annotated with whether the kept-upstream version actually LANDED at
 * HEAD (false = the teammate's side DELETED the file, so keep-upstream meant removing it). The
 * one `cat-file -e HEAD:<path>` probe per conflict happens in {@link annotateLanded}; the CLI's
 * message builder, row projector, and help-chain pick all read the same answer —
 * the help chain must never name a doc whose file is gone (`doc update` on it fails NOT_FOUND).
 */
export type LandedConflict = ResolvedConflict & { landed: boolean };

/** Annotate each resolved conflict with the post-rebase HEAD existence probe (ONE probe per doc). */
export function annotateLanded(boardPath: string, conflicts: ResolvedConflict[]): LandedConflict[] {
  return conflicts.map((c) => ({
    ...c,
    landed: runGit(boardPath, ["cat-file", "-e", `HEAD:${c.relPath}`]).status === 0,
  }));
}

// ── git-dir markers (the establishment channel's crash-recovery state) ────────

/** The greenfield establishment's crash marker: the snapshot commit awaiting conversion. */
export const ESTABLISH_MARKER_KEY = "agentstate.establishCommit";
/** Write-time provenance for the committed case's crash window: only the executing clone has it. */
export const COMMITTED_MARKER_KEY = "agentstate.establishCommittedShare";

function markerPath(top: string, key: string): string {
  return path.join(mustGit(top, ["rev-parse", "--absolute-git-dir"]).trim(), key);
}

/** The stored marker commit, or undefined (absent/unreadable/not-a-sha reads as no marker). */
export function readGitDirMarker(top: string, key: string): string | undefined {
  try {
    const value = readFileSync(markerPath(top, key), "utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Persist a marker commit atomically (temp + rename) into the repo's own git dir. */
export function writeGitDirMarker(top: string, key: string, commit: string): void {
  const target = markerPath(top, key);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${commit}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/** Remove a marker; already-absent is fine (cleanup retries on the next explicit establish). */
export function clearGitDirMarker(top: string, key: string): void {
  clearGitDirMarkerVerified(top, key);
}

/** The marker file's absolute path — so refusal copy can name the exact file to remove by hand. */
export function gitDirMarkerPath(top: string, key: string): string {
  return markerPath(top, key);
}

/**
 * Remove a marker and REPORT whether it is actually gone: an unlink can fail silently in
 * spirit (immutable file, EPERM on the containing dir), and a receipt claiming "cleared" for a
 * file that survived is a lie. Never throws — `false` means "still present; say so honestly".
 */
export function clearGitDirMarkerVerified(top: string, key: string): boolean {
  try {
    const target = markerPath(top, key);
    try {
      unlinkSync(target);
    } catch {
      // Already absent, or the unlink was denied — the existence check below is the verdict.
    }
    return !existsSync(target);
  } catch {
    return false;
  }
}

// ── the committed-folder establishment's plumbing-only commits ────────────────

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

/** Parse `ls-tree -z` output (NUL-terminated `<mode> <type> <sha>\t<name>` records). */
function parseLsTreeZ(out: string): TreeEntry[] {
  return out
    .split("\0")
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf("\t");
      const [mode = "", type = "", sha = ""] = l.slice(0, tab).split(" ");
      return { mode, type, sha, name: l.slice(tab + 1) };
    });
}

/**
 * Git's tree-entry sort key: entries are ordered by name bytes, with a directory comparing as if
 * suffixed by `/` — required because inserting a new `.gitignore` entry must keep the listing in
 * the canonical order `mktree` records.
 */
function treeSortKey(e: TreeEntry): string {
  return e.type === "tree" ? `${e.name}/` : e.name;
}

/** The board branch's one attributed root-commit message (attribution = the git author running it). */
function boardCommitMessage(branch: string): string {
  return (
    `board: bundle shared from '${branch}' (files only)\n\n` +
    `One-time establishment: the bundle's current files, moved onto the dedicated ` +
    `'${BOARD_BRANCH}' branch.\nThe folder's history stays on '${branch}'.\n`
  );
}

/**
 * Create the board branch's ROOT commit (files, not history): `git commit-tree` over the folder's
 * tree at HEAD with NO parents, then point `refs/heads/board` at it. Object-store and ref writes
 * only; the working tree and index are untouched.
 */
export function createBoardRootCommit(top: string, treeSha: string, branch: string): string {
  const sha = mustGit(top, [...identityFlags(top), "commit-tree", treeSha], {
    input: boardCommitMessage(branch),
  }).trim();
  mustGit(top, ["branch", BOARD_BRANCH, sha]);
  return sha;
}

/**
 * Build the folder-removal commit with PLUMBING ONLY — HEAD's top-level tree minus the
 * selected bundle entry, with `.gitignore` gaining the entry — parented on HEAD. The working
 * tree, the index, and the current branch are never touched, which also means any STAGED user
 * code stays exactly as staged. `message` is the caller's commit message (the CLI owns the copy —
 * it names the invocation, which this package never resolves).
 */
export function createRemovalCommit(top: string, message: string, bundleDir: BundleDirName): string {
  const headTree = mustGit(top, ["rev-parse", "HEAD^{tree}"]).trim();
  const entries = parseLsTreeZ(mustGit(top, ["ls-tree", "-z", headTree])).filter(
    (e) => e.name !== bundleDir,
  );

  const existing = entries.find((e) => e.name === ".gitignore");
  const base = existing ? mustGit(top, ["cat-file", "blob", existing.sha]) : "";
  const updated = withIgnoreEntries(base);
  if (updated !== base) {
    const blob = mustGit(top, ["hash-object", "-w", "--stdin"], { input: updated }).trim();
    if (existing) {
      existing.sha = blob;
    } else {
      entries.push({ mode: "100644", type: "blob", sha: blob, name: ".gitignore" });
    }
  }

  entries.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const mktreeInput = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join("");
  const newTree = mustGit(top, ["mktree", "-z"], { input: mktreeInput }).trim();
  return mustGit(top, [...identityFlags(top), "commit-tree", newTree, "-p", "HEAD"], { input: message }).trim();
}
