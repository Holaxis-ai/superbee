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
} from "@superbee/board-git";

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
): Promise<BoundBoardOwner> {
  const before = await validateBoundBoardOwner(target);
  if (!before || before.readiness !== "recovery-pending" || !sameOwner(before.owner, expected)) {
    throw recoveryFailure(target, "preflight", "the selected board identity changed before recovery");
  }
  if (!detectStaleRebase(expected.bundleRoot) || !rebaseWasFromBoardBranch(expected.bundleRoot)) {
    throw recoveryFailure(target, "rebase-origin", "the pending rebase is no longer a board-origin rebase");
  }

  try {
    abortStaleRebase(expected.bundleRoot);
  } catch {
    throw recoveryFailure(target, "abort", "the unfinished board rebase could not be canceled");
  }

  const after = await validateBoundBoardOwner(target);
  if (!after || after.readiness !== "ready" || !sameOwner(after.owner, expected)) {
    throw recoveryFailure(target, "reproof", "the selected board identity changed during recovery");
  }
  return after.owner;
}
