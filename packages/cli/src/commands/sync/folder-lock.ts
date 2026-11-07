// The two locks a Git sync takes, always in this order:
//
// 1. The FOLDER lock, one per clone (keyed on the repository's git common-dir), held for the whole
//    sync: heal, provision, commit, fetch, rebase, push. Two syncs over one board folder never
//    overlap, so neither aborts, drives or stages into the other's rebase.
// 2. The bundle ROOT lock, the one every document write to the board already holds, held only
//    around steps that move files in the worktree (stage and commit, rebase, abort, fast-forward).
//    A document write therefore lands before or after such a step, never inside it. Fetch and
//    push stay outside it, so a slow network never blocks a write.
//
// Nothing holding the root lock may ask for the folder lock: a write waits on the root lock only,
// and that order is what keeps the pair free of deadlock.
import { realpathSync } from "node:fs";
import { FilesystemMutationLockError } from "@superbee/core";
import { filesystemPushRoleLocks, PushRoleStaleOwnerError } from "@superbee/core/filesystem-push-role";
import { cliFilesystemRuntime } from "../../filesystem-runtime.js";
import { currentFilesystemHost } from "../../runtime-context.js";
import { syncLockOrphaned } from "../../sync-outcomes.js";
import { CliError } from "../../errors.js";

/** How long an explicit sync waits for another sync in the same folder. */
export const SYNC_FOLDER_LOCK_WAIT_MS = 15_000;
/** How long a sync under a deadline (the turn-end hook) waits before it skips. */
export const DEADLINE_SYNC_FOLDER_LOCK_WAIT_MS = 250;

let rootLockDepth = 0;

/** The folder lock's name for a clone, from its git common-dir. */
export function syncFolderLockName(gitCommonDir: string): string {
  let canonical = gitCommonDir;
  try { canonical = realpathSync(gitCommonDir); } catch { /* an absent dir keeps its spelling */ }
  return `superbee-git-sync:${canonical}`;
}

export type FolderLockOutcome<T> =
  | { kind: "ran"; value: T; waitedMs: number }
  | { kind: "busy"; holderPid: number | null; waitedMs: number; lockPath: string };

/**
 * Run `body` holding the folder lock for the clone at `gitCommonDir`, waiting up to `waitMs`. A
 * live holder that outlasts the wait answers `busy` and nothing ran. A dead holder's lock is
 * reclaimed by the lock itself; one that cannot be reclaimed is refused as orphaned.
 */
export async function withSyncFolderLock<T>(gitCommonDir: string, waitMs: number, body: () => Promise<T>): Promise<FolderLockOutcome<T>> {
  if (rootLockDepth > 0) throw new Error("sync asked for the folder lock while holding the bundle root lock");
  const started = Date.now();
  let entered = false;
  const host = currentFilesystemHost();
  const locks = filesystemPushRoleLocks({ waitMs, ...(host ? { hostPolicy: host } : {}) });
  try {
    return await locks.request(syncFolderLockName(gitCommonDir), {}, async () => {
      entered = true;
      const waitedMs = Date.now() - started;
      return { kind: "ran" as const, value: await body(), waitedMs };
    });
  } catch (error) {
    if (entered) throw error;
    if (error instanceof PushRoleStaleOwnerError) throw syncLockOrphaned(error.lockPath, error.owner.pid);
    if (error instanceof FilesystemMutationLockError) {
      if (error.malformed || error.stale) throw syncLockOrphaned(error.lockPath, error.owner?.pid ?? null);
      return { kind: "busy", holderPid: error.owner?.pid ?? null, waitedMs: Date.now() - started, lockPath: error.lockPath };
    }
    throw error;
  }
}

/**
 * Run `body` holding the bundle root lock for the board at `boardPath`. `body` moves worktree files
 * with Git only; it must not write documents through a backend, nor ask for the folder lock.
 */
export async function withSyncRootLock<T>(boardPath: string, body: () => T | Promise<T>): Promise<T> {
  rootLockDepth += 1;
  let entered = false;
  try {
    return await cliFilesystemRuntime().withRootMutationLock(boardPath, async () => {
      entered = true;
      return body();
    });
  } catch (error) {
    if (entered || !(error instanceof FilesystemMutationLockError)) throw error;
    throw new CliError("GIT_BUSY", "a document write kept the board folder busy longer than sync waits; retry once it finishes", {
      details: { reason: "write_busy", retryable: true },
    });
  } finally {
    rootLockDepth -= 1;
  }
}
