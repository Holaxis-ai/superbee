/**
 * The Node push role: a lock manager shaped like the Web Locks `LockManager` subset that
 * `withPushRole` (`@superbee/browser-local`) takes, over the same-user cross-process filesystem
 * lock. The browser's role is a Web Lock, which a user agent shares across the tabs of one
 * origin. Node 22 also exposes `navigator.locks`, but only within one process, so two CLI
 * processes over one working copy would both hold it. A Node caller therefore always passes this
 * manager explicitly (`withPushRole(name, fn, { locks: filesystemPushRoleLocks() })`) and never
 * relies on the host default.
 *
 * `ifAvailable` (the only mode `withPushRole` uses) does not queue: a role held by a live process
 * answers `null` after at most `contentionWaitMs`, which only rides out the moment between another
 * claimer's `mkdir` and its owner record. A lock whose owner record stays missing or malformed is
 * not "held elsewhere" but an unknown holder, and rejects with the lock's own error so it is
 * diagnosed rather than skipped forever. A dead same-host holder's lock is reclaimed, as every
 * filesystem lock is. The role is released when the callback settles.
 */

import { createHash } from "node:crypto";

import { acquireFilesystemIdentityLock, FilesystemMutationLockError, type FilesystemMutationLockOptions } from "./filesystem-lock.js";

/** The Web Locks `LockManager` subset the push role uses; `withPushRole` accepts any value of this shape. */
export interface PushRoleLockManager {
  request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T>;
}

export interface FilesystemPushRoleOptions extends Pick<FilesystemMutationLockOptions, "lockRoot" | "pollMs"> {
  /** How long `ifAvailable` waits for a claim in progress to show its owner. Default 250 ms. */
  contentionWaitMs?: number;
  /** How long a request without `ifAvailable` waits before it rejects. Default 5 s. */
  waitMs?: number;
}

/** The lock key for a role name: its SHA-256, so any name is one fixed-length path component. */
export function pushRoleLockKey(name: string): string {
  return createHash("sha256").update(`superbee:push-role\0${name}`, "utf8").digest("hex");
}

/** A {@link PushRoleLockManager} whose roles are exclusive across every process of this user on this host. */
export function filesystemPushRoleLocks(options: FilesystemPushRoleOptions = {}): PushRoleLockManager {
  const contentionWaitMs = options.contentionWaitMs ?? 250;
  const waitMs = options.waitMs ?? 5_000;
  return {
    async request<T>(name: string, request: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T> {
      if (typeof name !== "string" || name === "") throw new TypeError("a push role needs a name");
      let release: () => Promise<void>;
      try {
        release = await acquireFilesystemIdentityLock(pushRoleLockKey(name), name, {
          lockRoot: options.lockRoot,
          pollMs: options.pollMs,
          waitMs: request.ifAvailable ? contentionWaitMs : waitMs,
        });
      } catch (error) {
        if (request.ifAvailable && error instanceof FilesystemMutationLockError && heldByKnownOwner(error)) return callback(null);
        throw error;
      }
      let result: T;
      try {
        result = await callback({ name });
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
      await release();
      return result;
    },
  };
}

/** A holder with a well-formed owner record; a missing or malformed one is an unknown holder the caller must see. */
function heldByKnownOwner(error: FilesystemMutationLockError): boolean {
  return !error.malformed && !error.stale && error.owner !== null;
}
