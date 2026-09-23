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
import path from "node:path";
import { hostname } from "node:os";

import type { FilesystemHostPolicy } from "./filesystem-host.js";
import { acquireFilesystemIdentityLock, filesystemLockAgeMs as lockAgeMs, FilesystemMutationLockError, type FilesystemMutationLockOptions, type FilesystemMutationLockOwner } from "./filesystem-lock.js";

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
  /** How long an owner-less lock counts as a claim or release in progress. Default 5 s. */
  claimGraceMs?: number;
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

/**
 * How long an owner-less lock may be a claim or release in progress rather than an orphan. A live
 * claimer writes its owner record right after its `mkdir`; a releaser removes the directory right
 * after the record. Either takes milliseconds, so an owner-less lock older than this was orphaned.
 */
const CLAIM_GRACE_MS = 5_000;

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
  const claimGraceMs = options.claimGraceMs ?? CLAIM_GRACE_MS;
  const acquire = (name: string, wait: number) =>
    acquireFilesystemIdentityLock(pushRoleLockKey(name), name, { lockRoot: options.lockRoot, pollMs: options.pollMs, hostPolicy: options.hostPolicy, waitMs: wait });
  /**
   * Acquire, telling a lock caught between states from an orphan. A timeout whose last look found
   * no owner record may have caught a live holder between its claim and its record, or between
   * removing its record and its directory on release. The lock is looked at again: gone means a
   * release just finished, so the claim is retried once; a directory younger than the grace is a
   * claim or release in progress, reported as held by an unknown live holder (not malformed). Only
   * an owner-less lock older than the grace is left as the malformed, orphaned lock it is.
   */
  const acquireSettled = async (name: string, wait: number): Promise<() => Promise<void>> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await acquire(name, wait);
      } catch (error) {
        if (!(error instanceof FilesystemMutationLockError) || !error.malformed || path.basename(error.lockPath) !== `${pushRoleLockKey(name)}.lock`) throw error;
        const age = await lockAgeMs(error.lockPath);
        if (age === null && attempt === 0) continue;
        if (age === null || age < claimGraceMs) {
          throw new FilesystemMutationLockError(
            `filesystem mutation lock '${error.lockPath}' is being claimed or released by another process; retry the mutation.`,
            { lockPath: error.lockPath, owner: null, stale: false, malformed: false },
          );
        }
        throw error;
      }
    }
  };
  return {
    async request<T>(name: string, request: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T> {
      if (typeof name !== "string" || name === "") throw new TypeError("a push role needs a name");
      let release: () => Promise<void>;
      try {
        release = await acquireSettled(name, request.ifAvailable ? contentionWaitMs : waitMs);
      } catch (error) {
        if (request.ifAvailable && error instanceof FilesystemMutationLockError && heldByLiveClaim(error)) {
          if (error.owner === null) return callback(null);
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

/**
 * A live holder: one with a well-formed owner record, or a claim or release caught in progress
 * (no record, not malformed). A malformed or stale lock is one the caller must see.
 */
function heldByLiveClaim(error: FilesystemMutationLockError): boolean {
  return !error.malformed && !error.stale;
}

