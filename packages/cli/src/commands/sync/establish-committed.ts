// The committed-folder establishment/recovery: the bundle is a plain folder committed on the
// current branch. Same verb as greenfield, different safety model (preview-first, `--yes`-gated —
// heavier because it stages a change to the CODE branch's future):
//   • FILES, NOT HISTORY: the `board` branch is one fresh ROOT commit over the folder's tree —
//     no parents, so the pre-share history never enters the shared branch.
//   • PR-SHAPED REMOVAL: the folder-removal + .gitignore commit is built with PLUMBING ONLY on a
//     new local `board-cleanup` branch — working tree, index, and current branch never touched,
//     nothing on the current branch pushed; the HUMAN opens the PR.
//   • NOT PROVISIONED HERE: until the cleanup PR merges, the current branch still TRACKS the
//     folder — a board checkout there would read as phantom modifications, and the user's own
//     `git checkout`/`git restore` would rewrite frozen copies over it. One safe journey: merge
//     the PR → `git pull` (the folder vanishes) → `sync` (it returns).
//   • NEVER any `git clean`: the rollout note's `git clean -fdx` line is copy for teammates —
//     nothing here executes it.
import {
  BOARD_BRANCH,
  BOARD_REF,
  BOARD_REMOTE,
  BUNDLE_DIR,
  bundleDirNameForProject,
  COMMITTED_MARKER_KEY,
  boardBranchRemnant,
  boardNamespaceConflicts,
  boardWindowGuidance,
  behindBoardCommits,
  clearGitDirMarker,
  clearGitDirMarkerVerified,
  createBoardRootCommit,
  createRemovalCommit,
  currentBranch,
  fetchOrigin,
  fetchOriginRequired,
  folderTreeAtHead,
  committedBundleAtHead,
  type BundleDirName,
  type CommittedBundleAtHead,
  gitDirMarkerPath,
  isAncestor,
  isProvisioned,
  isShallowRepository,
  localBranchExists,
  mustGit,
  pathLandedAbsentOnRemoteBranch,
  pushBoardUpstream,
  readGitDirMarker,
  refCommit,
  runGit,
  statusRows,
  treeOf,
  writeGitDirMarker,
} from "@superbee/board-git";
import { classifyBundleError } from "../../errors.js";
import { render, type OutputMode } from "../../output.js";
import { syncOutcomeError, syncOutcomeLine, withSharingDetails } from "../../sync-outcomes.js";
import type { EstablishOutcome } from "./establish.js";
import type { CommandPrefix } from "../../command-text.js";

/** The local branch the folder-removal commit is prepared on — the human pushes it and opens the PR. */
export const CLEANUP_BRANCH = "board-cleanup";

// ── pinned strings (test-pinned; no worktree/linked/subtree vocabulary, no retired framing) ──

export const ESTABLISH_COMMITTED_PREVIEW = "preview — nothing has been changed; re-run with --yes to execute";

export const ESTABLISH_COMMITTED_ALREADY = "already established — a board branch already exists on origin";

export const ESTABLISH_COMMITTED_DONE =
  "the board branch is live on origin — push the cleanup branch and open its PR to finish";

/**
 * The both-worlds honesty line (test-pinned): the receipt must say exactly what the window means —
 * most importantly that the folder still committed on the code branch is a DEAD COPY.
 */
export function bothWorldsLine(branch: string): string {
  return (
    `until the cleanup PR merges, this project is in a BOTH-WORLDS state: the shared board ` +
    `lives on the '${BOARD_BRANCH}' branch (live on ${BOARD_REMOTE}), while '${branch}' still ` +
    `carries the old committed folder. That folder is now a FROZEN SNAPSHOT that receives no ` +
    `further updates: treat it as read-only, don't write docs into it, and never merge ` +
    `'${BOARD_BRANCH}' into '${branch}'. Sync starts working on each clone once the PR merges ` +
    `and that clone runs 'git pull'`
  );
}

/**
 * The rollout-note copy to forward to teammates BEFORE the cleanup PR merges (emitted in the
 * preview AND the receipt). The `git clean -fdx` line is COPY ONLY — nothing here executes it.
 */
export function rolloutNote(inv: CommandPrefix, branch: string, bundleDir: string = BUNDLE_DIR): string[] {
  return [
    `after your next 'git pull', ${bundleDir}/ disappears from '${branch}' — nothing is lost: ` +
      `the next '${inv} sync' re-creates it from the shared board branch`,
    `from then on '${inv} sync' — not 'git pull' — updates the board`,
    `you may notice a '${BOARD_BRANCH}' branch on the remote — never merge it into '${branch}'`,
    `'git clean -fdx' on '${branch}' removes the board checkout (recoverable — the next sync ` +
      `re-creates it from ${BOARD_REMOTE}; unpushed board commits are why you sync first)`,
    `re-run '${inv} hook install' so session start stays board-aware`,
  ];
}

/** The preview record — a genuinely useful dry run: what branch, what commits, what leaves where. */
export function committedPreviewRecord(inv: CommandPrefix, branch: string, bundleDir: string = BUNDLE_DIR): Record<string, unknown> {
  return {
    establish: ESTABLISH_COMMITTED_PREVIEW,
    create:
      `a new '${BOARD_BRANCH}' branch whose ONE root commit carries the current committed files ` +
      `of ${bundleDir}/ — files only: the folder's history stays on '${branch}'`,
    push: `the new '${BOARD_BRANCH}' branch to ${BOARD_REMOTE}, with tracking (git push -u ${BOARD_REMOTE} ${BOARD_BRANCH})`,
    commit:
      `ONE commit on a new local '${CLEANUP_BRANCH}' branch removing ${bundleDir}/ from ` +
      `'${branch}' and adding it to .gitignore — NOT pushed: you push that branch and open the ` +
      `PR yourself; nothing on '${branch}' is pushed or changed`,
    after_merge:
      `once the PR merges, on every clone: 'git pull' makes ${bundleDir}/ vanish from ` +
      `'${branch}', and the next '${inv} sync' re-creates it from the ${BOARD_BRANCH} branch — ` +
      `nothing is lost`,
    both_worlds: bothWorldsLine(branch),
    before_you_run:
      `every board writer should sync — at minimum commit — their board changes first: board work ` +
      `sitting uncommitted or unpushed on another machine cannot be detected from here, and it ` +
      `will NOT be on the new branch; worse, a clone whose unpushed board commits merge over the ` +
      `cleanup PR keeps those ${bundleDir}/ paths tracked on '${branch}', and sync will refuse ` +
      `there until they are untracked (git rm -r --cached)`,
    verified:
      `this preview already checked the machine-checkable preconditions: ${BOARD_REMOTE} is ` +
      `reachable, '${branch}' is not behind ${BOARD_REMOTE}/${branch} on board changes, and no ` +
      `'${BOARD_BRANCH}/…' branches exist (they would block creating the '${BOARD_BRANCH}' branch)`,
    rollout_note: rolloutNote(inv, branch, bundleDir),
    run: `${inv} sync --establish --yes`,
  };
}

/** The receipt/recovery next-steps chain (one source — the crash-recovery path re-emits it). */
export function committedNextSteps(inv: CommandPrefix, branch: string, bundleDir: string = BUNDLE_DIR): string[] {
  return [
    `push the cleanup branch: git push -u ${BOARD_REMOTE} ${CLEANUP_BRANCH}`,
    `open a PR from '${CLEANUP_BRANCH}' into '${branch}' and merge it`,
    `after the merge lands: 'git pull', then '${inv} sync' — ${bundleDir}/ vanishes from ` +
      `'${branch}' and comes back as the live shared board`,
  ];
}

/** Throw the behind-origin refusal when {@link behindBoardCommits} found any. */
function assertNotBehindOnBoard(top: string, inv: CommandPrefix, branch: string, bundleDir: BundleDirName): void {
  const behind = behindBoardCommits(top, branch, bundleDir);
  if (behind !== null && behind.length > 0) {
    throw syncOutcomeError("establish.behind-origin", { inv, branch, behind });
  }
}

/** The removal commit's message (rides the human-opened cleanup PR). */
function removalCommitMessage(inv: CommandPrefix, branch: string, bundleDir: string): string {
  return (
    `board: move ${bundleDir}/ to the '${BOARD_BRANCH}' branch\n\n` +
    `The board now lives on its own '${BOARD_BRANCH}' branch (pushed to ${BOARD_REMOTE}) and is ` +
    `ignored on '${branch}'.\nOnce this lands: 'git pull' (the folder vanishes), then ` +
    `'${inv} sync' (it returns as the live shared board).\n`
  );
}

/** True when the marker commit object exists locally — a garbage/unfetched sha reads unverifiable. */
export function markerCommitResolves(top: string, marker: string): boolean {
  return runGit(top, ["cat-file", "-e", `${marker}^{commit}`]).status === 0;
}

/**
 * Clear a stale committed-case crash marker on a FULLY-SHARED clone (the folder no longer at
 * HEAD), where `alreadyShared`'s own clear arms can never run again. Called only after a
 * successful `fetchOriginRequired` (a LIVE view of origin). Clears when the marker's story is
 * definitively over: its snapshot is CONTAINED in origin/board (trustworthy even on truncated
 * history), or NOT contained/unverifiable AND the history is not shallow (truncation can fake
 * non-containment) AND no discard evidence remains (the attempt's local `board` branch is gone,
 * or the winning board is already provisioned over it). Everything else keeps the marker — never
 * guess a recovery pointer away.
 */
export function clearStaleCommittedMarker(top: string): void {
  const marker = readGitDirMarker(top, COMMITTED_MARKER_KEY);
  if (!marker) return;
  const remoteCommit = refCommit(top, `refs/remotes/${BOARD_REF}`);
  if (!remoteCommit) return;
  if (markerCommitResolves(top, marker) && isAncestor(top, marker, remoteCommit)) {
    clearGitDirMarker(top, COMMITTED_MARKER_KEY);
    return;
  }
  if (isShallowRepository(top)) return;
  if (localBranchExists(top, BOARD_BRANCH) && !isProvisioned(top)) return;
  clearGitDirMarker(top, COMMITTED_MARKER_KEY);
}

// ── the committed-folder phases ───────────────────────────────────────────────

/** The guard phase's result: the branch to act on and a reusable interrupted-run remnant (if any). */
interface CommittedPlan { branch: string; bundleDir: BundleDirName; reuseBoardSha: string | null }

/**
 * The precondition guards, verified for BOTH the preview and the execution — the preview is a dry
 * run of the whole act, refusals included: on a real branch (not detached, not `board` itself);
 * NOT behind `origin/<branch>` on board commits (the fetch already succeeded, so this view is
 * LIVE; a stale clone must hear "git pull" first); no uncommitted board changes (they would be
 * silently stranded in the frozen snapshot); no `board-cleanup` branch; no `board/…` branches
 * (they make `refs/heads/board` uncreatable — refuse EARLY, naming them); and any LOCAL `board`
 * branch must be the reusable remnant of an interrupted run (a single root commit over exactly
 * this tree). The one precondition that CANNOT be checked from here — every board writer has
 * synced their board changes — is documented comms in the preview.
 */
function guardCommittedPreconditions(
  top: string, inv: CommandPrefix, treeSha: string, bundleDir: BundleDirName,
): CommittedPlan {
  const branch = currentBranch(top);
  if (branch === "HEAD") {
    throw syncOutcomeError("establish.detached-head.committed", { bundleDir });
  }
  if (branch === BOARD_BRANCH) {
    throw syncOutcomeError("establish.on-board-branch", {});
  }

  assertNotBehindOnBoard(top, inv, branch, bundleDir);

  const dirty = statusRows(top, bundleDir);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 20);
    throw syncOutcomeError("establish.committed-dirty", { inv, bundleDir, rows: shown, total: dirty.length });
  }

  if (localBranchExists(top, CLEANUP_BRANCH)) {
    throw syncOutcomeError("establish.cleanup-branch-exists", { cleanupBranch: CLEANUP_BRANCH });
  }

  const namespaceConflicts = boardNamespaceConflicts(top);
  if (namespaceConflicts.length > 0) {
    throw syncOutcomeError("establish.namespace-conflict.committed", { inv, conflicts: namespaceConflicts });
  }

  let reuseBoardSha: string | null = null;
  if (localBranchExists(top, BOARD_BRANCH)) {
    const remnant = boardBranchRemnant(top);
    if (remnant.tree === treeSha && remnant.count === "1") {
      reuseBoardSha = remnant.sha;
    } else {
      throw syncOutcomeError("establish.board-branch-mismatch", {});
    }
  }

  return { branch, bundleDir, reuseBoardSha };
}

/**
 * The execute phase. Ordering is the recovery story: the board branch is created, the crash
 * marker is written, and the push lands FIRST (a failure before or during the push leaves the
 * current branch bit-for-bit untouched, and a re-run reuses the local root commit); the removal
 * commit is prepared only after origin has the board. The marker — not the local branch's mere
 * existence — is what later identifies THIS clone as the interrupted executor (a teammate who
 * merely checked out the board branch during the window must never be offered the recovery).
 */
function executeCommittedEstablishment(
  top: string, inv: CommandPrefix, plan: CommittedPlan, treeSha: string, mode: OutputMode, stdout: (s: string) => void,
): EstablishOutcome {
  const { branch, bundleDir } = plan;
  const boardSha = plan.reuseBoardSha ?? createBoardRootCommit(top, treeSha, branch);
  writeGitDirMarker(top, COMMITTED_MARKER_KEY, boardSha);
  try {
    pushBoardUpstream(top);
  } catch (err) {
    const fetched = fetchOrigin(top);
    const remoteCommit = refCommit(top, `refs/remotes/${BOARD_REF}`);
    throw withSharingDetails(
      classifyBundleError(err),
      { operation: "create-board", remote_board: fetched ? (remoteCommit ? "exists-confirmed" : "absent-confirmed") : "unknown" },
      inv,
    );
  }
  const removalSha = createRemovalCommit(top, removalCommitMessage(inv, branch, bundleDir), bundleDir);
  mustGit(top, ["branch", CLEANUP_BRANCH, removalSha]);
  clearGitDirMarker(top, COMMITTED_MARKER_KEY);

  const receipt: Record<string, unknown> = {
    established: ESTABLISH_COMMITTED_DONE,
    board_commit: boardSha,
    pushed: `${BOARD_REMOTE}/${BOARD_BRANCH} (tracking set)`,
    cleanup_branch: CLEANUP_BRANCH,
    cleanup_commit: removalSha,
    next_steps: committedNextSteps(inv, branch, bundleDir),
    both_worlds: bothWorldsLine(branch),
    tell_your_teammates: rolloutNote(inv, branch, bundleDir),
  };
  stdout(render(receipt, mode));
  return { already: false };
}

/** The committed-folder establishment: idempotence probe → offline refusal → guards → preview/execute. */
export async function establishCommitted(
  top: string, inv: CommandPrefix, mode: OutputMode, yes: boolean, committed: CommittedBundleAtHead,
  stdout: (s: string) => void,
): Promise<EstablishOutcome> {
  const { tree: treeSha, bundleDir } = committed;
  let fetchOk = false;
  let fetchError: unknown;
  try {
    fetchOriginRequired(top);
    fetchOk = true;
  } catch (err) {
    fetchError = err;
  }

  // IDEMPOTENCE FIRST: a board branch on origin means the establishment already happened (here,
  // on a teammate's clone, or in an interrupted run that got at least as far as the push) — exit
  // 0. Checked even off a failed fetch (the last-known origin/board still proves it).
  if (refCommit(top, `refs/remotes/${BOARD_REF}`)) {
    await alreadyShared(top, inv, mode, yes, fetchOk, bundleDir, stdout);
    return { already: false };
  }

  // A dead fetch REFUSES: the act cannot complete offline anyway (the mandatory `push -u` would
  // fail after mutating local refs), and proceeding on a stale view of origin is exactly the hole
  // that lets a teammate's board commit go unseen.
  if (!fetchOk) {
    throw withSharingDetails(classifyBundleError(fetchError), { operation: "establish-preflight" }, inv);
  }

  const plan = guardCommittedPreconditions(top, inv, treeSha, bundleDir);

  if (!yes) {
    stdout(render(committedPreviewRecord(inv, plan.branch, plan.bundleDir), mode));
    return { already: false };
  }

  return executeCommittedEstablishment(top, inv, plan, treeSha, mode, stdout);
}

/**
 * The recovery phase: a board branch exists on origin while the folder is still committed at
 * HEAD — the establishment already happened SOMEWHERE and this clone sits in the both-worlds
 * window. Exit 0 always (idempotence), but the follow-up must match this clone's ACTUAL state:
 * (a) a local `board-cleanup` branch exists → the removal commit is prepared, the PR is all
 * that's left; (b) this clone's own crash marker exists but no cleanup branch → PROVENANCE
 * FIRST: only a marker CONTAINED in origin/board proves the true crash window (re-create the
 * removal commit, `--yes`-gated, same freshness rules as a fresh run plus the tree check);
 * non-containment against a LIVE fetch means the race was lost — see the arm comments for the
 * claim discipline and the ONE marker-clear mutation; (c) no marker → a truthful window note,
 * never a removal-commit re-creation (that would race the real PR). The fully-shared state
 * (folder no longer committed) never reaches this function: establishBoard routes it
 * structurally, so leftover local crumbs cannot produce stale guidance there.
 */
async function alreadyShared(
  top: string, inv: CommandPrefix, mode: OutputMode, yes: boolean, fetchOk: boolean,
  bundleDir: BundleDirName, stdout: (s: string) => void,
): Promise<void> {
  const rec: Record<string, unknown> = { establish: ESTABLISH_COMMITTED_ALREADY };
  const branch = currentBranch(top);
  const marker = readGitDirMarker(top, COMMITTED_MARKER_KEY);

  if (localBranchExists(top, CLEANUP_BRANCH)) {
    // (a) prepared but not landed: the PR is the only thing left.
    clearGitDirMarker(top, COMMITTED_MARKER_KEY);
    rec.note = syncOutcomeLine("line.marker.prepared.note", { cleanupBranch: CLEANUP_BRANCH });
    rec.next_steps = committedNextSteps(
      inv,
      branch === "HEAD" ? "the default branch" : branch,
      bundleDir,
    );
  } else if (marker) {
    // (b) this clone's own marker proves an interrupted --yes run happened HERE — but only
    // origin/board can say whether that run's push WON. Provenance before any framing.
    if (branch === "HEAD") {
      throw syncOutcomeError("establish.detached-head.marker", { inv, bundleDir });
    }
    const remoteCommit = refCommit(top, `refs/remotes/${BOARD_REF}`);
    const markerValid = markerCommitResolves(top, marker);
    const contained = markerValid && remoteCommit !== undefined && isAncestor(top, marker, remoteCommit);
    if (!contained && fetchOk && isShallowRepository(top)) {
      // A truncated (shallow) history can fake non-containment, so neither the lost-race framing
      // nor the auto-clear may fire off it — refuse to conclude anything.
      if (!yes) {
        rec.note = syncOutcomeLine("line.marker.shallow.note", { inv });
      } else {
        throw syncOutcomeError("marker.shallow.refusal", { inv, marker });
      }
    } else if (!contained && fetchOk) {
      // The race was LOST — or the marker itself is unverifiable. Claim only what is known (a
      // different board is published NOW; this snapshot is not part of it — a crash-then-force-push
      // corner means "never published" would overclaim); name an invalid marker for what it is.
      const story = markerValid
        ? syncOutcomeLine("line.marker.story.lost-race", {})
        : syncOutcomeLine("line.marker.story.unverifiable", {});
      if (!localBranchExists(top, BOARD_BRANCH)) {
        // The attempt is already discarded — definitively over. Clearing the stale marker is the
        // ONLY mutation here; from now on normal routing (state c) owns this clone. The receipt
        // reports what ACTUALLY happened: a marker that survives the unlink (immutable file,
        // denied permissions) must never be reported as cleared.
        const cleared = clearGitDirMarkerVerified(top, COMMITTED_MARKER_KEY);
        rec.cleared = cleared
          ? syncOutcomeLine("line.marker.cleared.removed", { story })
          : syncOutcomeLine("line.marker.cleared.failed", {
              story,
              markerPath: gitDirMarkerPath(top, COMMITTED_MARKER_KEY),
            });
        rec.note = windowNote(top, inv, branch, bundleDir);
      } else if (!yes) {
        rec.note = syncOutcomeLine("line.marker.lost-race.note", { story });
        rec.discard = syncOutcomeLine("line.marker.lost-race.discard", { inv });
      } else {
        throw syncOutcomeError("marker.lost-race.conflict", { inv, marker, markerValid });
      }
    } else if (!yes) {
      rec.note = contained
        ? syncOutcomeLine("line.marker.interrupted-offer.note", { inv, cleanupBranch: CLEANUP_BRANCH })
        : syncOutcomeLine("line.marker.offline.note", { inv });
    } else if (!fetchOk) {
      throw syncOutcomeError("marker.offline.refusal", {});
    } else {
      // contained && fetchOk && yes: the true interrupted-establishment recovery.
      assertNotBehindOnBoard(top, inv, branch, bundleDir);
      const markerTree = treeOf(top, marker);
      if (!markerTree) {
        throw syncOutcomeError("marker.unavailable.commit.changed", { marker });
      }
      const currentTree = committedBundleAtHead(top)?.tree ?? null;
      if (currentTree !== markerTree) {
        throw syncOutcomeError("marker.tree-changed.conflict", {
          inv,
          branch,
          bundleDir,
          snapshotTree: markerTree,
          currentTree: currentTree ?? "absent",
        });
      }
      const removalSha = createRemovalCommit(top, removalCommitMessage(inv, branch, bundleDir), bundleDir);
      mustGit(top, ["branch", CLEANUP_BRANCH, removalSha]);
      clearGitDirMarker(top, COMMITTED_MARKER_KEY);
      rec.recovered =
        `an interrupted establishment left the board branch pushed but no folder-removal commit — ` +
        `it has been re-created on '${CLEANUP_BRANCH}'`;
      rec.cleanup_branch = CLEANUP_BRANCH;
      rec.cleanup_commit = removalSha;
      rec.next_steps = committedNextSteps(inv, branch, bundleDir);
      rec.both_worlds = bothWorldsLine(branch);
    }
  } else {
    // (c) a clone that hasn't pulled the removal yet.
    rec.note = windowNote(top, inv, branch, bundleDir);
  }

  stdout(render(rec, mode));
}

/**
 * The pre-share-window guidance for a clone with no local establishment work left: pull once the
 * removal lands, then sync. Probes origin's actual state so the note never asserts a PR that may
 * or may not exist. A tracked REMNANT (removal landed AND pulled, straggler paths still tracked)
 * gets the ONE factory's untrack-escape line instead: "run 'git pull'" is a dead end there.
 */
function windowNote(top: string, inv: CommandPrefix, branch: string, bundleDir: BundleDirName): string {
  const guidance = boardWindowGuidance(top, true, bundleDir);
  if (guidance.state === "window-remnant") return guidance.message;
  const landedUpstream = pathLandedAbsentOnRemoteBranch(top, branch, bundleDir);
  return landedUpstream
    ? syncOutcomeLine("line.window-note.landed", { inv, branch, bundleDir })
    : syncOutcomeLine("line.window-note.pending", { inv, bundleDir });
}
