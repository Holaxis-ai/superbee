/**
 * Experimental (`0.2.0-pre`): the API may change before a stable release.
 *
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
 * filesystem lock is.
 *
 * A dead holder whose process id now belongs to another process would otherwise read as live
 * forever. So before answering "held elsewhere" for a same-host holder, the role asks the host
 * when the process now carrying that id started: a process that started after the lock was
 * claimed cannot be the claimer, and the request rejects with {@link PushRoleStaleOwnerError}
 * naming the lock, instead of skipping every sync in silence. The role is released when the
 * callback settles.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type { FilesystemHostPolicy } from "./filesystem-host.js";
import { acquireFilesystemIdentityLock, FilesystemMutationLockError, type FilesystemMutationLockOptions, type FilesystemMutationLockOwner } from "./filesystem-lock.js";

/** The Web Locks `LockManager` subset the push role uses; `withPushRole` accepts any value of this shape. */
export interface PushRoleLockManager {
  request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T>;
}

export interface FilesystemPushRoleOptions extends Pick<FilesystemMutationLockOptions, "lockRoot" | "pollMs"> {
  /** How long `ifAvailable` waits for a claim in progress to show its owner. Default 250 ms. */
  contentionWaitMs?: number;
  /** How long a request without `ifAvailable` waits before it rejects. Default 5 s. */
  waitMs?: number;
  /** The trusted host construction; omitted, the supported default (macOS and Linux). */
  hostPolicy?: FilesystemHostPolicy;
  /**
   * When the process now carrying `pid` started, in epoch milliseconds, or `null` when the host
   * cannot say. Defaults to asking `ps`; a test or another host substitutes its own.
   */
  processStartedAt?: (pid: number) => Promise<number | null>;
}

/**
 * The role's lock names a same-host holder whose process id now belongs to a process that
 * started after the lock was claimed: the claimer is gone and its id was reused. Nothing was
 * run. Remove the lock (`lockPath`) once no sync is running.
 */
export class PushRoleStaleOwnerError extends Error {
  override readonly name = "PushRoleStaleOwnerError";
  readonly lockPath: string;
  readonly owner: FilesystemMutationLockOwner;
  readonly processStartedAt: number;
  constructor(lockPath: string, owner: FilesystemMutationLockOwner, processStartedAt: number) {
    super(
      `push role lock '${lockPath}' was claimed by PID ${owner.pid} at ${new Date(owner.created_at_ms).toISOString()}, ` +
        `but PID ${owner.pid} now belongs to a process started at ${new Date(processStartedAt).toISOString()}; ` +
        `the holder is gone. Remove the lock after confirming no sync is running, then retry.`,
    );
    this.lockPath = lockPath;
    this.owner = owner;
    this.processStartedAt = processStartedAt;
  }
}

/** The lock key for a role name: its SHA-256, so any name is one fixed-length path component. */
export function pushRoleLockKey(name: string): string {
  return createHash("sha256").update(`superbee:push-role\0${name}`, "utf8").digest("hex");
}

/** `ps` reports a start time to the second, so a genuine claimer can look up to this much later than its claim. */
const START_TIME_RESOLUTION_MS = 1_000;

/**
 * The environment `ps` runs in: this process's own, with the C locale. `TZ` must pass through:
 * `ps` formats `lstart` in its time zone and `Date.parse` reads it in this process's, so both
 * must be the same zone, or a live holder can look younger than its claim.
 */
export function psEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, LC_ALL: "C" };
}

/** When `pid` started, from `ps -o lstart=` under the C locale; `null` when no `ps` answers. */
export function processStartedAtFromPs(pid: number): Promise<number | null> {
  const attempt = (binary: string) =>
    new Promise<number | null>((resolve) => {
      execFile(binary, ["-o", "lstart=", "-p", String(pid)], { env: psEnvironment(), timeout: 2_000 }, (error, stdout) => {
        if (error) return resolve(null);
        const parsed = Date.parse(stdout.trim().replace(/\s+/g, " "));
        resolve(Number.isFinite(parsed) ? parsed : null);
      });
    });
  return attempt("/bin/ps").then((found) => found ?? attempt("/usr/bin/ps"));
}

/** A {@link PushRoleLockManager} whose roles are exclusive across every process of this user on this host. */
export function filesystemPushRoleLocks(options: FilesystemPushRoleOptions = {}): PushRoleLockManager {
  const contentionWaitMs = options.contentionWaitMs ?? 250;
  const waitMs = options.waitMs ?? 5_000;
  const startedAt = options.processStartedAt ?? processStartedAtFromPs;
  return {
    async request<T>(name: string, request: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T> {
      if (typeof name !== "string" || name === "") throw new TypeError("a push role needs a name");
      let release: () => Promise<void>;
      try {
        release = await acquireFilesystemIdentityLock(pushRoleLockKey(name), name, {
          lockRoot: options.lockRoot,
          pollMs: options.pollMs,
          hostPolicy: options.hostPolicy,
          waitMs: request.ifAvailable ? contentionWaitMs : waitMs,
        });
      } catch (error) {
        if (request.ifAvailable && error instanceof FilesystemMutationLockError && heldByKnownOwner(error)) {
          const owner = error.owner!;
          if (owner.hostname === hostname()) {
            const started = await startedAt(owner.pid);
            if (started !== null && started > owner.created_at_ms + START_TIME_RESOLUTION_MS) throw new PushRoleStaleOwnerError(error.lockPath, owner, started);
          }
          return callback(null);
        }
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
