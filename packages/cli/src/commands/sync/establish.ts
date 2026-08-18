// `superbee sync --establish` — the explicit local-bundle -> shared-board transition.
// TWO CASES, ONE VERB. Greenfield (the folder is uncommitted — THIS module): snapshot first,
// publish second, convert the local folder last — until the exact board commit exists on origin,
// the user's only bundle copy is never renamed or modified; the conversion keeps a deterministic
// backup until the provisioned worktree is verified, and a git-dir marker makes an interrupted
// post-push conversion resumable without guessing from branch names, `index.md`, or crash debris.
// The committed-folder case (preview-first, `--yes`-gated) is ./establish-committed.ts.
import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { resolveProjectBinding } from "../../bundle.js";
import { CliError } from "../../errors.js";
import {
  BOARD_BRANCH,
  BOARD_REF,
  BOARD_REMOTE,
  BUNDLE_DIR,
  ESTABLISH_MARKER_KEY,
  assertBundleBytesMatchCommit,
  bundleDirNameForProject,
  boardNamespaceConflicts,
  clearGitDirMarker,
  currentHead,
  ensureBoardGitignoreWorkingTree,
  fetchOrigin,
  fetchOriginRequired,
  folderPresentInCodeIndex,
  committedBundleAtHead,
  isAncestor,
  isProvisioned,
  provisionBoardWorktree,
  pushBoardCommit,
  pushBoardUpstream,
  readGitDirMarker,
  refCommit,
  repoTopLevel,
  resolveBundleKey,
  runGit,
  setBoardUpstream,
  singleActor,
  snapshotBundleCommit,
  treeOf,
  unpushedCount,
  writeGitDirMarker,
  type BundleSnapshotCommit,
} from "@superbee/board-git";
import { defaultSyncStore } from "../../cursor.js";
import { render, type OutputMode } from "../../output.js";
import { hookInstallHintOnce, type SyncCliDeps } from "../../sync-cli.js";
import { syncOutcomeError } from "../../sync-outcomes.js";
import { clearStaleCommittedMarker, establishCommitted } from "./establish-committed.js";
import { assertBundleOutsidePrivateState } from "../../private-state-bundle-boundary.js";

export const ESTABLISH_DONE =
  "the shared board is live — the project bundle now syncs over the 'board' branch";
export const ESTABLISH_ALREADY = "already established";

export type EstablishOutcome = { already: true } | { already: false };

export function establishNextSteps(inv: string): string[] {
  return [
    `teammates just run '${inv} sync' — it provisions automatically`,
    `'${inv} hook install' keeps session start board-aware`,
  ];
}

/** Reject filesystem indirection before any ref, remote, index, or folder mutation. */
function assertPlainBundleShape(bundlePath: string, inv: string): void {
  const bundleDir = path.basename(bundlePath);
  const runInitHelp = `${inv} init --create-only --dir ${BUNDLE_DIR}`;
  if (!existsSync(bundlePath)) {
    throw new CliError(
      "RUNTIME",
      `no '${bundleDir}/' folder here to establish — run '${runInitHelp}' first, then re-run establish`,
      { help: runInitHelp },
    );
  }
  const root = lstatSync(bundlePath);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new CliError(
      "RUNTIME",
      `'${bundlePath}' must be a real, plain directory — symlinks and non-directories are never followed by establish`,
    );
  }
  if (existsSync(path.join(bundlePath, ".git"))) {
    throw new CliError(
      "RUNTIME",
      `'${bundlePath}' already contains its own '.git' — establish only operates on a plain bundle folder`,
    );
  }
  if (readdirSync(bundlePath).length === 0) {
    throw new CliError("RUNTIME", `'${bundlePath}' is empty — run '${runInitHelp}' first`, {
      help: runInitHelp,
    });
  }
  const indexPath = path.join(bundlePath, "index.md");
  if (!existsSync(indexPath)) {
    throw new CliError(
      "RUNTIME",
      `'${bundlePath}' doesn't look like an OKF bundle (no index.md) — run '${runInitHelp}' first`,
      { help: runInitHelp },
    );
  }
  const index = lstatSync(indexPath);
  if (index.isSymbolicLink() || !index.isFile()) {
    throw new CliError("RUNTIME", `'${indexPath}' must be a real file — establish never follows it through a symlink`);
  }
}

function assertFreshSource(top: string, boardPath: string, inv: string): void {
  const bundleDir = path.basename(boardPath);
  assertPlainBundleShape(boardPath, inv);
  if (folderPresentInCodeIndex(top)) {
    throw new CliError(
      "RUNTIME",
      `'${bundleDir}/' is staged in the code branch's index — establish refuses to leave board files ` +
        `queued for a later code commit; unstage them, then re-run`,
      { help: `git restore --staged -- ${bundleDir}` },
    );
  }
}

async function assertNotBoundElsewhere(top: string, boardPath: string): Promise<void> {
  const binding = await resolveProjectBinding(top);
  if (!binding) return;
  const boundIsConventional = path.resolve(binding.target) === boardPath;
  if (boundIsConventional) return;
  throw new CliError(
    "RUNTIME",
    `a project binding (${binding.file}) points this project's bundle out of the git-sync tier ` +
      `(the selected conventional path is '${path.basename(boardPath)}/')`,
    { help: `fix or remove ${binding.file} if you want to share this bundle over the board branch` },
  );
}

function gitignoreNote(top: string): string {
  const gi = ensureBoardGitignoreWorkingTree(top);
  return gi.changed
    ? `${gi.path} — appended ${gi.entries.map((entry) => `'${entry}'`).join(" and ")} (uncommitted; commit it so teammates' clones stay clean)`
    : `${gi.path} — already ignores ${gi.entries.map((entry) => `'${entry}'`).join(" and ")}`;
}

interface ConversionResult { boardPath: string; boardCommit: string; gitignore: string }

/** The only backup-deletion boundary: re-read the backup immediately before removing it. */
function removeVerifiedBackup(top: string, backupPath: string, expectedCommit: string, inv: string): void {
  if (!existsSync(backupPath)) return;
  assertPlainBundleShape(backupPath, inv);
  const backupSnapshot = snapshotBundleCommit(top, backupPath);
  const expectedTree = treeOf(top, expectedCommit);
  if (!expectedTree) throw new CliError("RUNTIME", `the establishment commit has no readable tree (${expectedCommit})`);
  if (backupSnapshot.tree !== expectedTree) {
    throw new CliError("CONFLICT", `the establishment backup at ${backupPath} changed; it was not removed`);
  }
  assertBundleBytesMatchCommit(top, backupPath, expectedCommit);
  rmSync(backupPath, { recursive: true, force: false });
}

/** Finish the post-publish local swap, retaining the deterministic backup until every check passes. */
function finishLocalConversion(top: string, sourcePath: string, publishedCommit: string, expectedTree: string, inv: string): ConversionResult {
  const boardPath = path.join(top, bundleDirNameForProject(top));
  const backupPath = `${boardPath}.establish-backup`;
  const remoteCommit = refCommit(top, `refs/remotes/${BOARD_REF}`);
  if (!remoteCommit || !isAncestor(top, publishedCommit, remoteCommit)) {
    throw new CliError(
      "CONFLICT",
      `origin/${BOARD_BRANCH} no longer contains this establishment's published snapshot — the local bundle is untouched`,
    );
  }

  if (isProvisioned(top)) {
    const current = currentHead(boardPath);
    if (!isAncestor(top, publishedCommit, current)) {
      throw new CliError("CONFLICT", "the provisioned board does not contain the establishment snapshot");
    }
    assertBundleBytesMatchCommit(top, boardPath, publishedCommit);
    setBoardUpstream(boardPath);
    const note = gitignoreNote(top);
    removeVerifiedBackup(top, backupPath, publishedCommit, inv);
    clearGitDirMarker(top, ESTABLISH_MARKER_KEY);
    return { boardPath, boardCommit: current, gitignore: note };
  }

  assertPlainBundleShape(sourcePath, inv);
  const currentSnapshot = snapshotBundleCommit(top, sourcePath);
  if (currentSnapshot.tree !== expectedTree) {
    throw new CliError(
      "CONFLICT",
      `the local bundle changed after its establishment snapshot was created — nothing was moved; ` +
        `review the local changes, then re-run '${inv} sync --establish'`,
      { details: { expected_tree: expectedTree, actual_tree: currentSnapshot.tree } },
    );
  }

  if (sourcePath === boardPath) {
    if (existsSync(backupPath)) {
      throw new CliError("RUNTIME", `establish recovery backup already exists at ${backupPath}; nothing was moved`);
    }
    renameSync(boardPath, backupPath);
    sourcePath = backupPath;
  }

  try {
    const outcome = provisionBoardWorktree(top);
    if (outcome.kind !== "provisioned" && outcome.kind !== "already") {
      throw new CliError("RUNTIME", `board provisioning returned '${outcome.kind}' after publication`);
    }
    const provisionedPath = outcome.boardPath;
    const current = currentHead(provisionedPath);
    if (!isAncestor(top, publishedCommit, current)) {
      throw new CliError("CONFLICT", "the provisioned board does not contain the establishment snapshot");
    }
    if (runGit(provisionedPath, ["status", "--porcelain"]).stdout.trim()) {
      throw new CliError("RUNTIME", "the newly provisioned board worktree is unexpectedly dirty");
    }
    assertBundleBytesMatchCommit(top, provisionedPath, publishedCommit);
    setBoardUpstream(provisionedPath);
    const note = gitignoreNote(top);
    removeVerifiedBackup(top, sourcePath, publishedCommit, inv);
    clearGitDirMarker(top, ESTABLISH_MARKER_KEY);
    return { boardPath: provisionedPath, boardCommit: current, gitignore: note };
  } catch (err) {
    if (!existsSync(boardPath) && existsSync(backupPath)) renameSync(backupPath, boardPath);
    throw err;
  }
}

async function renderEstablished(
  top: string, conversion: ConversionResult, snapshot: Pick<BundleSnapshotCommit, "docs">,
  inv: string, mode: OutputMode, stdout: (s: string) => void, deps: Partial<SyncCliDeps>,
): Promise<EstablishOutcome> {
  const key = resolveBundleKey(conversion.boardPath);
  await defaultSyncStore.refreshMarker(key);
  if (snapshot.docs.length > 0) await defaultSyncStore.recordSelfActors(key, snapshot.docs.map((d) => d.actor));
  await defaultSyncStore.writeCursor(key, { tier: "git", token: conversion.boardCommit });
  await defaultSyncStore.writeCache(key, {
    updatedAt: new Date().toISOString(),
    delta: [],
    unpushedCount: unpushedCount(conversion.boardPath) ?? 0,
    uncommittedCount: 0,
  });

  const receipt: Record<string, unknown> = {
    established: ESTABLISH_DONE,
    board_commit: conversion.boardCommit,
    committed: snapshot.docs.length,
  };
  const actor = singleActor(snapshot.docs);
  if (actor) receipt.actor = actor;
  receipt.pushed = `${BOARD_REMOTE}/${BOARD_BRANCH} (tracking set)`;
  receipt.gitignore = conversion.gitignore;
  receipt.next_steps = establishNextSteps(inv);
  const hint = await hookInstallHintOnce(key, inv, deps.hookInstalled);
  if (hint) receipt.hint = hint;
  stdout(render(receipt, mode));
  return { already: false };
}

// ── the greenfield phases ─────────────────────────────────────────────────────

/** The greenfield routing facts, read in one place (in this fixed order). */
interface GreenfieldState {
  boardPath: string; backupPath: string;
  marker: string | undefined; remoteCommit: string | undefined; localCommit: string | undefined;
}

function readGreenfieldState(top: string): GreenfieldState {
  const boardPath = path.join(top, bundleDirNameForProject(top));
  return {
    boardPath,
    backupPath: `${boardPath}.establish-backup`,
    marker: readGitDirMarker(top, ESTABLISH_MARKER_KEY),
    remoteCommit: refCommit(top, `refs/remotes/${BOARD_REF}`),
    localCommit: refCommit(top, `refs/heads/${BOARD_BRANCH}`),
  };
}

/** Push the snapshot commit; tolerate a raced push origin can explain, then re-verify origin/board LIVE. */
function pushAndConfirmRemote(top: string, sha: string): string | undefined {
  try {
    pushBoardCommit(top, sha);
  } catch (err) {
    if (!fetchOrigin(top) || !refCommit(top, `refs/remotes/${BOARD_REF}`)) throw err;
  }
  fetchOriginRequired(top);
  return refCommit(top, `refs/remotes/${BOARD_REF}`);
}

/**
 * Completed state: ordinary sync owns it. A leftover verified backup/marker is cleanup from a
 * post-publish crash, never evidence for another publication; the remaining conversion steps run
 * BEFORE deleting the only pre-conversion copy, so a failure stays resumable.
 */
function resumeProvisionedEstablishment(top: string, st: GreenfieldState, remoteCommit: string, inv: string): EstablishOutcome {
  if (st.marker) {
    if (!isAncestor(top, st.marker, remoteCommit)) {
      throw new CliError(
        "CONFLICT",
        `the provisioned board does not contain the interrupted establishment snapshot (${st.marker})`,
      );
    }
    const markerTree = treeOf(top, st.marker);
    if (!markerTree) {
      throw syncOutcomeError("marker.unavailable.tree", { marker: st.marker });
    }
    setBoardUpstream(st.boardPath);
    gitignoreNote(top);
    assertBundleBytesMatchCommit(top, st.boardPath, st.marker);
    removeVerifiedBackup(top, st.backupPath, st.marker, inv);
    clearGitDirMarker(top, ESTABLISH_MARKER_KEY);
  }
  return { already: true };
}

/**
 * Explicit publication of a local-only board, including a legacy branch that has not yet been
 * materialized at the conventional path. Bare sync and SessionStart never take this path.
 */
async function publishLocalBoardBranch(
  top: string, boardPath: string, inv: string, mode: OutputMode, stdout: (s: string) => void, deps: Partial<SyncCliDeps>,
): Promise<EstablishOutcome> {
  if (!isProvisioned(top)) {
    const provisioned = provisionBoardWorktree(top);
    if (provisioned.kind !== "provisioned" && provisioned.kind !== "already") {
      throw new CliError("RUNTIME", "the local board branch could not be provisioned for explicit establishment");
    }
  }
  const indexPath = path.join(boardPath, "index.md");
  if (!existsSync(indexPath) || lstatSync(indexPath).isSymbolicLink() || !lstatSync(indexPath).isFile()) {
    throw new CliError("RUNTIME", `the local '${BOARD_BRANCH}' worktree is not a valid bundle (root index.md missing)`);
  }
  pushBoardUpstream(boardPath);
  fetchOriginRequired(top);
  const remoteCommit = refCommit(top, `refs/remotes/${BOARD_REF}`);
  if (!remoteCommit) throw new CliError("RUNTIME", "board push succeeded but origin/board could not be verified");
  const conversion: ConversionResult = {
    boardPath,
    boardCommit: currentHead(boardPath),
    gitignore: gitignoreNote(top),
  };
  return renderEstablished(top, conversion, { docs: [] }, inv, mode, stdout, deps);
}

/** Resume an interrupted greenfield establishment from its git-dir marker. */
async function resumeInterruptedEstablishment(
  top: string, st: GreenfieldState, marker: string, inv: string, mode: OutputMode,
  stdout: (s: string) => void, deps: Partial<SyncCliDeps>,
): Promise<EstablishOutcome> {
  const recoverySource = existsSync(st.backupPath) ? st.backupPath : st.boardPath;
  const markerTree = treeOf(top, marker);
  if (!markerTree) {
    throw syncOutcomeError("marker.unavailable.commit.moved", { marker });
  }
  assertPlainBundleShape(recoverySource, inv);
  const currentSnapshot = snapshotBundleCommit(top, recoverySource);
  if (currentSnapshot.tree !== markerTree) {
    throw new CliError("CONFLICT", "the local bundle changed since the interrupted establishment snapshot; nothing was moved");
  }

  let remoteCommit = st.remoteCommit;
  if (!remoteCommit) {
    remoteCommit = pushAndConfirmRemote(top, marker);
  }
  if (!remoteCommit || !isAncestor(top, marker, remoteCommit)) {
    throw new CliError(
      "CONFLICT",
      `a different origin/${BOARD_BRANCH} appeared while establishing; the local bundle remains untouched`,
    );
  }
  const conversion = finishLocalConversion(top, recoverySource, marker, markerTree, inv);
  return renderEstablished(top, conversion, currentSnapshot, inv, mode, stdout, deps);
}

/** The fresh greenfield publication: snapshot → marker → push → verify → convert → receipt. */
async function publishGreenfieldBoard(
  top: string, boardPath: string, inv: string, mode: OutputMode, stdout: (s: string) => void, deps: Partial<SyncCliDeps>,
): Promise<EstablishOutcome> {
  const namespaceConflicts = boardNamespaceConflicts(top);
  if (namespaceConflicts.length > 0) {
    throw syncOutcomeError("establish.namespace-conflict.greenfield", { inv, conflicts: namespaceConflicts });
  }
  assertFreshSource(top, boardPath, inv);
  await assertNotBoundElsewhere(top, boardPath);

  const snapshot = snapshotBundleCommit(top, boardPath);
  writeGitDirMarker(top, ESTABLISH_MARKER_KEY, snapshot.sha);
  const remoteCommit = pushAndConfirmRemote(top, snapshot.sha);
  if (!remoteCommit || !isAncestor(top, snapshot.sha, remoteCommit)) {
    throw new CliError(
      "CONFLICT",
      `a teammate published a different origin/${BOARD_BRANCH} first; the local bundle remains untouched`,
      { details: { snapshot_commit: snapshot.sha } },
    );
  }

  const conversion = finishLocalConversion(top, boardPath, snapshot.sha, snapshot.tree, inv);
  return renderEstablished(top, conversion, snapshot, inv, mode, stdout, deps);
}

/** The establish entry: route structurally (committed vs greenfield), then dispatch by state. */
export async function establishBoard(
  dir: string, inv: string, mode: OutputMode, stdout: (s: string) => void,
  deps: Partial<SyncCliDeps>, opts: { yes?: boolean } = {},
): Promise<EstablishOutcome> {
  const top = repoTopLevel(dir);
  if (!top) {
    throw new CliError("RUNTIME", "not inside a git repository — establish needs a repo with an 'origin' remote");
  }
  if (runGit(top, ["remote", "get-url", BOARD_REMOTE]).status !== 0) {
    throw new CliError(
      "RUNTIME",
      `this repository has no '${BOARD_REMOTE}' remote — establish needs one to publish the board`,
      { help: `git remote add ${BOARD_REMOTE} <url>  # then re-run ${inv} sync --establish` },
    );
  }

  // The COMMITTED-FOLDER case routes structurally, before any network op: a selected conventional
  // tree committed at HEAD means the greenfield safety model (rename + convert the folder) must
  // never run — the code branch still tracks those paths. A fully shared clone (folder no longer
  // committed) never enters this branch, so its leftover local crumbs can't produce stale guidance.
  const committed = committedBundleAtHead(top);
  if (committed !== null) {
    assertBundleOutsidePrivateState(path.join(top, committed.bundleDir));
    return establishCommitted(top, inv, mode, Boolean(opts.yes), committed, stdout);
  }
  fetchOriginRequired(top);
  // The committed-case crash marker outlives its machinery once the folder leaves HEAD:
  // `alreadyShared`'s clear arms are unreachable from here, so a marker whose story is
  // DEFINITIVELY over is cleared now — against the LIVE fetch just guaranteed above.
  clearStaleCommittedMarker(top);

  const st = readGreenfieldState(top);
  assertBundleOutsidePrivateState(st.boardPath);

  if (isProvisioned(top) && st.remoteCommit) {
    return resumeProvisionedEstablishment(top, st, st.remoteCommit, inv);
  }
  if (st.localCommit && !st.remoteCommit) {
    return publishLocalBoardBranch(top, st.boardPath, inv, mode, stdout, deps);
  }
  if (st.marker) {
    return resumeInterruptedEstablishment(top, st, st.marker, inv, mode, stdout, deps);
  }
  if (st.remoteCommit) {
    if (existsSync(st.boardPath) || existsSync(st.backupPath)) {
      throw new CliError(
        "CONFLICT",
        `origin/${BOARD_BRANCH} already exists while this clone also has a local bundle — establish ` +
          `will not guess that they are identical or replace either one`,
        { help: `move the local folder aside, run '${inv} sync' to join, then reconcile deliberately` },
      );
    }
    return { already: true };
  }
  if (st.localCommit) {
    throw syncOutcomeError("establish.local-branch-unrecognized", {});
  }
  if (existsSync(st.backupPath)) {
    throw new CliError(
      "RUNTIME",
      `an establishment backup already exists at ${st.backupPath}, but this clone has no matching ` +
        `establishment marker; nothing was published or moved`,
    );
  }

  return publishGreenfieldBoard(top, st.boardPath, inv, mode, stdout, deps);
}
