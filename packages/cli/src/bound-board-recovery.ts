/**
 * Explicit-sync-only recovery for a binding-selected private board.
 *
 * Generic route proof is intentionally read-only. This module is the single destructive seam:
 * an explicit sync may abort only a Git-proven board-origin rebase at the already-frozen private
 * root, then must reproduce the complete owner proof before any sync phase consumes it.
 */
import {
  abortStaleRebase,
  detectStaleRebase,
  rebaseWasFromBoardBranch,
  syncStartedRebase,
} from "@superbee/board-git";
import type { CommandPrefix } from "./command-text.js";
import { rebaseInProgressRefusal } from "./sync-outcomes.js";

import type { LocalBundleTarget } from "./bundle.js";
import {
  validateBoundBoardOwner,
  type BoundBoardOwner,
} from "./bound-board-owner.js";
import { CliError } from "./errors.js";

function recoveryFailure(target: LocalBundleTarget, stage: string, message: string): CliError {
  return new CliError("CONFLICT", `project binding cannot recover its private board: ${message}`, {
    details: {
      binding_file: target.bindingFile,
      binding_target: target.canonicalRoot,
      recovery_stage: stage,
    },
  });
}

function sameOwner(left: BoundBoardOwner, right: BoundBoardOwner): boolean {
  return (
    left.selection === right.selection &&
    left.bindingFile === right.bindingFile &&
    left.bundleRoot === right.bundleRoot &&
    left.ownerRoot === right.ownerRoot &&
    left.commonGitDir === right.commonGitDir &&
    left.bundleDir === right.bundleDir &&
    left.boardBranch === right.boardBranch &&
    left.remote.name === right.remote.name &&
    left.remote.url === right.remote.url &&
    left.remote.label === right.remote.label &&
    left.stateKey === right.stateKey
  );
}

/**
 * Recover one already-proven `recovery-pending` route for an explicit sync invocation.
 * No read-side caller imports this module.
 */
export async function recoverBoundBoardOwner(
  target: LocalBundleTarget,
  expected: BoundBoardOwner,
  underRootLock: (boardPath: string, abort: () => void) => Promise<void>,
  inv: CommandPrefix,
): Promise<BoundBoardOwner> {
  const before = await validateBoundBoardOwner(target);
  if (!before || before.readiness !== "recovery-pending" || !sameOwner(before.owner, expected)) {
    throw recoveryFailure(target, "preflight", "the selected board identity changed before recovery");
  }
  if (!detectStaleRebase(expected.bundleRoot) || !rebaseWasFromBoardBranch(expected.bundleRoot)) {
    throw recoveryFailure(target, "rebase-origin", "the pending rebase is no longer a board-origin rebase");
  }
  // Only a rebase a sync started is ours to abort; the caller's folder lock proves that sync is gone.
  if (!syncStartedRebase(expected.bundleRoot)) throw rebaseInProgressRefusal(expected.bundleRoot, inv);

  try {
    await underRootLock(expected.bundleRoot, () => abortStaleRebase(expected.bundleRoot));
  } catch {
    throw recoveryFailure(target, "abort", "the unfinished board rebase could not be canceled");
  }

  const after = await validateBoundBoardOwner(target);
  if (!after || after.readiness !== "ready" || !sameOwner(after.owner, expected)) {
    throw recoveryFailure(target, "reproof", "the selected board identity changed during recovery");
  }
  return after.owner;
}
