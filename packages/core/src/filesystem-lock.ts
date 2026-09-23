import { promises as fs, realpathSync } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { homedir, hostname } from "node:os";
import { captureFilesystemHostPolicy, type FilesystemHostPolicy } from "./filesystem-host.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const OWNER_FILE = "owner.json";
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

export interface FilesystemMutationLockOwner {
  pid: number;
  hostname: string;
  created_at_ms: number;
  token: string;
  target: string;
}

export interface FilesystemMutationLockOptions {
  waitMs?: number;
  pollMs?: number;
  /** Portable tree that must never contain runtime lock state. FilesystemBackend supplies its root. */
  portableRoot?: string;
  /** Explicit runtime namespace for isolated consumers/tests; the default remains per-user and external. */
  lockRoot?: string;
  /** Trusted host construction; omitted for the supported default filesystem. */
  hostPolicy?: FilesystemHostPolicy;
}

export interface FilesystemMutationLockRootFacts {
  directory: boolean;
  symbolicLink: boolean;
  ownerUid: number;
  expectedUid: number | undefined;
  mode: number;
  enforcePrivateMode: boolean;
}

export class FilesystemMutationLockError extends Error {
  readonly lockPath: string;
  readonly owner: FilesystemMutationLockOwner | null;
  readonly stale: boolean;
  readonly malformed: boolean;

  constructor(
    message: string,
    details: {
      lockPath: string;
      owner: FilesystemMutationLockOwner | null;
      stale: boolean;
      malformed: boolean;
    },
  ) {
    super(message);
    this.name = "FilesystemMutationLockError";
    this.lockPath = details.lockPath;
    this.owner = details.owner;
    this.stale = details.stale;
    this.malformed = details.malformed;
  }
}

function canonicalExistingPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function pathContains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Stable per-user runtime namespace outside `portableRoot`; refuses an impossible root bundle. */
export function filesystemMutationLockRoot(portableRoot?: string, hostPolicy?: FilesystemHostPolicy): string {
  const policy = captureFilesystemHostPolicy(hostPolicy);
  // A stable host parent keeps different process/session temp settings in one namespace.
  const runtimeParent = policy.runtimeLockParent();
  const tempParent = canonicalExistingPath(runtimeParent);
  const homeParent = canonicalExistingPath(homedir());
  const ownerKey = policy.runtimeOwnerKey();
  const candidates = [
    path.join(tempParent, `agentstate-lite-mutation-locks-${ownerKey}`),
    path.join(homeParent, ".agentstate", `mutation-locks-${ownerKey}`),
  ];
  if (portableRoot === undefined) return candidates[0]!;

  const portable = canonicalExistingPath(portableRoot);
  const selected = candidates.find((candidate) => !pathContains(portable, candidate));
  if (selected) return selected;
  throw new FilesystemMutationLockError(
    `cannot place filesystem mutation locks outside portable root '${portable}'`,
    { lockPath: portable, owner: null, stale: false, malformed: true },
  );
}

function explicitFilesystemMutationLockRoot(root: string, portableRoot?: string): string {
  const requested = path.resolve(root);
  if (portableRoot === undefined) return requested;

  const portable = canonicalExistingPath(portableRoot);
  if (!pathContains(portable, canonicalExistingPath(requested))) return requested;
  throw new FilesystemMutationLockError(
    `cannot place filesystem mutation locks outside portable root '${portable}'`,
    { lockPath: portable, owner: null, stale: false, malformed: true },
  );
}

/** Runtime lock directory for one already-canonical physical target. */
export function filesystemMutationLockPath(target: string, portableRoot?: string, hostPolicy?: FilesystemHostPolicy): string {
  return filesystemMutationLockPathInRoot(target, filesystemMutationLockRoot(portableRoot, hostPolicy));
}

function filesystemMutationLockPathInRoot(target: string, lockRoot: string): string {
  const digest = createHash("sha256").update(path.resolve(target)).digest("hex");
  return path.join(lockRoot, `${digest}.lock`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @internal Pure metadata validator shared by acquisition diagnostics and focused tests. */
export function parseFilesystemMutationLockOwner(value: unknown): FilesystemMutationLockOwner | null {
  if (!isObject(value)) return null;
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    typeof value.created_at_ms !== "number" ||
    !Number.isFinite(value.created_at_ms) ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.target !== "string" ||
    value.target.length === 0
  ) {
    return null;
  }
  return {
    pid: value.pid,
    hostname: value.hostname,
    created_at_ms: value.created_at_ms,
    token: value.token,
    target: value.target,
  };
}

/**
 * What one attempt to read a lock's owner record established. `absent` and `unreadable` are
 * different facts: the first says the record is not there or is not a usable record, the second
 * says this process could not find out. Collapsing them makes a transient open failure look like
 * an abandoned lock.
 */
type OwnerRecordState =
  | { readonly state: "record"; readonly owner: FilesystemMutationLockOwner }
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly error: unknown };

/** A missing path or malformed content is `absent`; every other read failure is `unreadable`. */
async function readOwnerRecord(lockPath: string): Promise<OwnerRecordState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(lockPath, OWNER_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "absent" } : { state: "unreadable", error: err };
  }
  let owner: FilesystemMutationLockOwner | null = null;
  try {
    owner = parseFilesystemMutationLockOwner(JSON.parse(raw));
  } catch {
    owner = null;
  }
  return owner === null ? { state: "absent" } : { state: "record", owner };
}

/**
 * Resolve the owner record to a definitive answer, polling out an indeterminate read inside the
 * caller's remaining budget. `EMFILE`/`ENFILE` under concurrency, and the `EBUSY`/`EACCES`/`EPERM`
 * open transients that Windows indexing and antivirus software produce, otherwise read as "no
 * record" and let a caller conclude that a lock it still owns has changed hands. An unreadable
 * record never authorizes the destructive step: the caller fails closed when the budget expires.
 */
async function resolveOwnerRecord(
  lockPath: string,
  started: number,
  waitMs: number,
  pollMs: number,
): Promise<OwnerRecordState> {
  while (true) {
    const record = await readOwnerRecord(lockPath);
    if (record.state !== "unreadable" || Date.now() - started >= waitMs) return record;
    await delay(pollMs);
  }
}

async function readOwner(lockPath: string): Promise<FilesystemMutationLockOwner | null> {
  const record = await readOwnerRecord(lockPath);
  return record.state === "record" ? record.owner : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function staleLockQuarantinePath(lockPath: string, owner: FilesystemMutationLockOwner): string {
  const tokenHash = createHash("sha256").update(owner.token).digest("hex");
  return `${lockPath}.stale-${tokenHash}`;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Move one demonstrably dead same-host lock aside without deleting its evidence. The destination
 * is stable for the dead owner's token and remains non-empty, so a delayed competing reclaimer
 * cannot rename a replacement live lock over it across supported filesystems.
 */
async function quarantineStaleLock(
  lockPath: string,
  owner: FilesystemMutationLockOwner,
  policy: FilesystemHostPolicy,
): Promise<boolean> {
  if (owner.hostname !== hostname() || processExists(owner.pid)) return false;
  const quarantinePath = staleLockQuarantinePath(lockPath, owner);
  try {
    await fs.rename(lockPath, quarantinePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (await pathExists(quarantinePath)) return false;
    if (policy.isDirectoryContentionError(err)) return false;
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

/** @internal Pure policy seam so ownership refusal is testable without privileged filesystem setup. */
export function isPrivateFilesystemMutationLockRoot(facts: FilesystemMutationLockRootFacts): boolean {
  const wrongOwner = facts.expectedUid !== undefined && facts.ownerUid !== facts.expectedUid;
  const unsafeMode = facts.enforcePrivateMode && (facts.mode & 0o777) !== 0o700;
  return facts.directory && !facts.symbolicLink && !wrongOwner && !unsafeMode;
}

async function ensurePrivateLockRoot(root: string, policy: FilesystemHostPolicy): Promise<void> {
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const stat = await fs.lstat(root);
  const uid = process.getuid?.();
  if (
    !isPrivateFilesystemMutationLockRoot({
      directory: stat.isDirectory(),
      symbolicLink: stat.isSymbolicLink(),
      ownerUid: stat.uid,
      expectedUid: uid,
      mode: stat.mode,
      enforcePrivateMode: policy.enforcePrivateMode,
    })
  ) {
    throw new FilesystemMutationLockError(
      `refusing unsafe filesystem mutation lock root '${root}'; it must be a private directory owned by this user`,
      { lockPath: root, owner: null, stale: false, malformed: true },
    );
  }
}

async function canonicalTargetInDirectory(directory: string, requestedBasename: string): Promise<string> {
  const requested = path.join(directory, requestedBasename);
  let requestedStat: Stats;
  try {
    requestedStat = await fs.lstat(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return requested;
    throw err;
  }

  const entries = await fs.readdir(directory);
  if (entries.includes(requestedBasename)) return requested;

  // On a case-/normalization-insensitive filesystem, lstat(requested) can succeed even though
  // readdir reports a differently-spelled directory entry. Find that entry without realpath'ing
  // the target itself: resolving a final symlink would put the lock outside the bundle even though
  // atomicWrite replaces the symlink directory entry inside it.
  for (const entry of entries) {
    const candidate = path.join(directory, entry);
    let candidateStat: Stats;
    try {
      candidateStat = await fs.lstat(candidate);
    } catch {
      // A sibling may disappear during the scan, or the host may deny metadata for a protected
      // system entry in an otherwise-readable directory. Neither sibling can be the successfully
      // witnessed requested entry, so it contributes no alias evidence and must not block locking.
      continue;
    }
    if (candidateStat.dev === requestedStat.dev && candidateStat.ino === requestedStat.ino) return candidate;
  }
  return requested;
}

/**
 * `guarded` names what the claimer wanted to mutate, so a leftover is diagnosable even when
 * malformed. One lock key is one LOGICAL identity, and on a host that equates spellings the
 * claimer and the holder can spell it differently; naming only the claimer's spelling sends a
 * human looking for a file that may not exist under that name. Name the holder's recorded
 * spelling too whenever it differs. The message reports what the owner record SAYS and no more:
 * a lock reached through its own fold key holds the same identity by construction, but nothing
 * here re-derives that from an arbitrary `owner.json`, so it must not assert the equivalence.
 */
function timeoutError(
  lockPath: string,
  owner: FilesystemMutationLockOwner | null,
  guarded: string,
): FilesystemMutationLockError {
  const malformed = owner === null;
  const sameHost = owner?.hostname === hostname();
  const stale = owner !== null && sameHost && !processExists(owner.pid);
  let message: string;
  if (malformed) {
    message =
      `timed out waiting for filesystem mutation lock '${lockPath}'; its owner metadata is missing or malformed. ` +
      `Inspect and remove the lock only after confirming no process is mutating the target, then retry.`;
  } else if (stale) {
    message =
      `stale filesystem mutation lock '${lockPath}' belongs to absent PID ${owner.pid} on ${owner.hostname}. ` +
      `Inspect and remove the lock, then retry.`;
  } else {
    message =
      `timed out waiting for filesystem mutation lock '${lockPath}' held by PID ${owner.pid} on ${owner.hostname}; retry the mutation.`;
  }
  const heldFor =
    owner !== null && owner.target !== guarded
      ? ` Its holder recorded '${owner.target}' for the same lock key.`
      : "";
  return new FilesystemMutationLockError(`${message} The lock guards '${guarded}'.${heldFor}`, { lockPath, owner, stale, malformed });
}

/** Resolve `portableRoot` the way both claim entry points do: physical when it exists, else lexical. */
async function resolvedPortableRoot(portableRoot: string | undefined): Promise<string | undefined> {
  if (portableRoot === undefined) return undefined;
  return fs.realpath(portableRoot).catch(() => path.resolve(portableRoot));
}

async function selectLockRoot(options: FilesystemMutationLockOptions, policy: FilesystemHostPolicy): Promise<string> {
  const portableRoot = await resolvedPortableRoot(options.portableRoot);
  const lockRoot = options.lockRoot !== undefined
    ? explicitFilesystemMutationLockRoot(options.lockRoot, portableRoot)
    : filesystemMutationLockRoot(portableRoot, policy);
  await ensurePrivateLockRoot(lockRoot, policy);
  return lockRoot;
}

type LockClaimFailure = "contention" | "unwitnessed-contention-error" | "terminal";

async function classifyLockClaimFailure(error: unknown, lockPath: string, policy: FilesystemHostPolicy): Promise<LockClaimFailure> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return "contention";
  if (!policy.isDirectoryContentionError(error)) return "terminal";

  // A host may report a contention-shaped error while another claimer creates or removes this exact
  // directory. A witnessed path is contention. An absent path is ambiguous: permit one bounded
  // retry in case the competing directory operation just completed, but never turn a durable
  // create denial into a malformed-lock timeout. A denied probe remains terminal immediately.
  try {
    await fs.lstat(lockPath);
    return "contention";
  } catch (probeError) {
    const probeCode = (probeError as NodeJS.ErrnoException).code;
    return probeCode === "ENOENT" || probeCode === "ENOTDIR"
      ? "unwitnessed-contention-error"
      : "terminal";
  }
}

/**
 * The claim itself, shared by every entry point: `mkdir(lockPath)` is the atomic claim, the
 * owner record makes a crash leftover diagnosable, and release is token-checked so a caller can
 * never remove a lock it no longer owns. Waits up to `waitMs`, polling every `pollMs`.
 */
async function claimLockPath(
  lockPath: string,
  owner: FilesystemMutationLockOwner,
  waitMs: number,
  pollMs: number,
  policy: FilesystemHostPolicy,
): Promise<() => Promise<void>> {
  const started = owner.created_at_ms;
  let unwitnessedRetryUsed = false;
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (err) {
      const failure = await classifyLockClaimFailure(err, lockPath, policy);
      if (failure === "terminal") throw err;
      if (failure === "unwitnessed-contention-error") {
        if (unwitnessedRetryUsed) throw err;
        unwitnessedRetryUsed = true;
        // This is one immediate re-attempt, not a wait. It is permitted even with waitMs: 0 so
        // the next result can distinguish a one-shot sharing race from a durable create denial.
        continue;
      } else {
        unwitnessedRetryUsed = false;
      }

      let existingOwner = await readOwner(lockPath);
      if (existingOwner !== null) {
        if (await quarantineStaleLock(lockPath, existingOwner, policy)) continue;
        // A failed quarantine attempt is non-progress: another reclaimer may have moved the stale
        // lock and installed a live replacement while this caller was delayed in rename. Diagnose
        // the owner that exists now, never the dead-owner snapshot that authorized the attempt.
        existingOwner = await readOwner(lockPath);
      }

      if (Date.now() - started >= waitMs) throw timeoutError(lockPath, existingOwner, owner.target);
      await delay(pollMs);
      continue;
    }

    // The directory this claim made, to recognize it later even if the owner record never lands.
    const claimed = await fs.lstat(lockPath, { bigint: true }).catch(() => null);

    // The claim is ours now, unless this claimer was suspended long enough for the owner-less
    // directory to be removed as orphaned and claimed again. Owner initialization and rollback
    // failures are not claim contention, even when the host reports a contention-shaped error, and
    // must propagate unchanged. A lost claim is contention: a record this claim never wrote
    // (EEXIST), or no directory to write into (ENOENT, ENOTDIR).
    try {
      await fs.writeFile(path.join(lockPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (err) {
      await rollBackOwnClaim(lockPath, owner, claimed, waitMs, pollMs, policy).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }

    // One release in flight per claim: a concurrent second invocation shares the first outcome
    // instead of racing it, so two removers can never act on one claim. A later invocation
    // re-verifies the record and refuses, as it always did.
    let inFlight: Promise<void> | undefined;
    return () => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        // One budget spans ownership resolution and removal, so the worst-case hold stays the
        // mutation plus waitMs however the two steps divide it.
        const started = Date.now();
        const current = await resolveOwnerRecord(lockPath, started, waitMs, pollMs);
        if (current.state === "unreadable") throw unreadableOwnerRefusal(lockPath, current.error);
        if (current.state !== "record" || current.owner.token !== owner.token) {
          throw changedOwnerRefusal(lockPath, current.state === "record" ? current.owner : null);
        }
        await removeReleasedLock(lockPath, owner, started, waitMs, pollMs, policy);
      })();
      return inFlight.finally(() => {
        inFlight = undefined;
      });
    };
  }
}

/**
 * Undo a claim whose owner record could not be written, removing the lock directory only when it
 * is provably this claim's: a compare-and-release. The directory is this claim's when it carries
 * this claim's owner record, or when it carries no record and is still the very directory this
 * claim made (same device, inode and birth time). Any other record is another process's lock, and
 * a directory that is not the one this claim made may be another claim in progress; both are left
 * alone. So is anything this process cannot read, and a host that reports no birth time, where the
 * directory cannot be told from a successor that reused its inode: an owner-less lock left behind
 * is reported as orphaned once the claim grace passes, while a deleted live lock breaks exclusion.
 */
async function rollBackOwnClaim(
  lockPath: string,
  owner: FilesystemMutationLockOwner,
  claimed: BigIntStats | null,
  waitMs: number,
  pollMs: number,
  policy: FilesystemHostPolicy,
): Promise<void> {
  const record = await readOwnerRecord(lockPath);
  if (record.state === "record") {
    if (record.owner.token === owner.token) await removeReleasedLock(lockPath, owner, Date.now(), waitMs, pollMs, policy);
    return;
  }
  if (record.state === "unreadable" || !(await isClaimedDirectory(lockPath, claimed))) return;
  // Move exactly the verified directory aside, under a name only this claim can produce, then remove it.
  const remnant = releasedLockRemnantPath(lockPath, owner);
  await fs.rename(lockPath, remnant);
  await fs.rm(remnant, { recursive: true, force: true });
}

async function isClaimedDirectory(lockPath: string, claimed: BigIntStats | null): Promise<boolean> {
  if (claimed === null || claimed.birthtimeNs <= 0n) return false;
  const current = await fs.lstat(lockPath, { bigint: true }).catch(() => null);
  return current !== null && current.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino && current.birthtimeNs === claimed.birthtimeNs;
}

function changedOwnerRefusal(lockPath: string, current: FilesystemMutationLockOwner | null): FilesystemMutationLockError {
  return new FilesystemMutationLockError(
    `refusing to release filesystem mutation lock '${lockPath}' because its owner token changed; the mutation may have completed, inspect the lock before retrying.`,
    { lockPath, owner: current, stale: false, malformed: current === null },
  );
}

/**
 * A record this process could never read is not a record that changed; say which one happened.
 * `malformed` stays true because the outcome for a consumer is the same one it already handled,
 * no usable owner record, and the message carries the distinction the flag cannot.
 */
function unreadableOwnerRefusal(lockPath: string, error: unknown): FilesystemMutationLockError {
  const message = error instanceof Error ? error.message : String(error);
  return new FilesystemMutationLockError(
    `refusing to release filesystem mutation lock '${lockPath}' because its owner record could not be read within the wait budget (${message}); the mutation may have completed, inspect the lock before retrying.`,
    { lockPath, owner: null, stale: false, malformed: true },
  );
}

/** Token-derived sibling name that only this claim can produce; a competitor can never claim it. */
function releasedLockRemnantPath(lockPath: string, owner: FilesystemMutationLockOwner): string {
  const tokenHash = createHash("sha256").update(owner.token).digest("hex");
  return `${lockPath}.released-${tokenHash}`;
}

function removalFailure(
  inspectPath: string,
  owner: FilesystemMutationLockOwner,
  err: unknown,
  attempts: number,
  detail: string,
): FilesystemMutationLockError {
  const message = err instanceof Error ? err.message : String(err);
  const suffix = attempts > 1 ? ` after ${attempts} bounded attempts` : "";
  return new FilesystemMutationLockError(
    `mutation completed but ${detail}${suffix} (${message}); inspect the lock before retrying.`,
    { lockPath: inspectPath, owner, stale: false, malformed: false },
  );
}

/**
 * Release a lock directory whose owner record was just verified as this caller's, in two steps
 * that keep the destructive action fenced to this claim.
 *
 * Step one renames the directory to a token-derived sibling. Rename is atomic and moves exactly
 * the directory whose record was verified; the lock key is free the instant it succeeds, and a
 * competitor's later claim lands on a fresh directory that step two never names. Step two removes
 * the renamed remnant, which only this claim can produce. What remains is the check-then-act gap
 * between a record read and the next rename syscall, reachable only through an external actor
 * that removes the verified directory and a completed competitor claim inside that gap: the same
 * class the stale-lock quarantine rename accepts.
 *
 * A host may report a contention-shaped error while another claimer still holds a handle inside
 * the directory: Windows unlink through Node 20's libuv only marks a file delete-on-close, so a
 * competitor's poll of `owner.json` briefly blocks both the directory rename and the removal of
 * its unlinked record. Retry only what the host policy classifies as directory contention, inside
 * the budget `started` at release entry and bounded by the claim's `waitMs`, polling every
 * `pollMs`, so the worst-case hold is the mutation plus `waitMs`. The default supported policy
 * classifies nothing, so its release stays single-shot. Before each rename retry the record is
 * re-read: rename never removes the record, so anything but this claim's own record means the
 * directory changed hands and the release refuses, unless the directory itself is gone. A record
 * this process cannot read is neither, and is polled out rather than acted on. A directory gone
 * between attempts is the requested outcome, and so is an absent remnant, whose token-derived
 * name no competitor can produce.
 */
async function removeReleasedLock(
  lockPath: string,
  owner: FilesystemMutationLockOwner,
  started: number,
  waitMs: number,
  pollMs: number,
  policy: FilesystemHostPolicy,
): Promise<void> {
  const remnant = releasedLockRemnantPath(lockPath, owner);
  let attempts = 0;
  while (true) {
    try {
      await fs.rename(lockPath, remnant);
      break;
    } catch (err) {
      attempts += 1;
      if (attempts > 1 && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!policy.isDirectoryContentionError(err) || Date.now() - started >= waitMs) {
        throw removalFailure(lockPath, owner, err, attempts, `filesystem lock '${lockPath}' could not be removed`);
      }
    }
    await delay(pollMs);
    // Only a definitive record authorizes another rename, so an indeterminate read delays this
    // claim's own cleanup instead of ever pointing the rename at a directory it did not verify.
    const current = await resolveOwnerRecord(lockPath, started, waitMs, pollMs);
    if (current.state === "record" && current.owner.token === owner.token) continue;
    if (current.state === "unreadable") throw unreadableOwnerRefusal(lockPath, current.error);
    // Rename never removes the record, so a record-less directory here is a competitor's claim in
    // progress, never this caller's leftover; only an absent directory means already released.
    if (current.state === "absent" && !(await pathExists(lockPath))) return;
    throw changedOwnerRefusal(lockPath, current.state === "record" ? current.owner : null);
  }

  attempts = 0;
  while (true) {
    try {
      await fs.rm(remnant, { recursive: true, force: false });
      return;
    } catch (err) {
      attempts += 1;
      // No competitor can produce this token-derived name, so an absent remnant on any attempt,
      // the first included, means the release already reached its requested end state.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!policy.isDirectoryContentionError(err) || Date.now() - started >= waitMs) {
        throw removalFailure(
          remnant,
          owner,
          err,
          attempts,
          `filesystem lock '${lockPath}' was released yet its remnant '${remnant}' could not be removed`,
        );
      }
    }
    await delay(pollMs);
  }
}

function newOwner(target: string): FilesystemMutationLockOwner {
  return {
    pid: process.pid,
    hostname: hostname(),
    created_at_ms: Date.now(),
    token: randomUUID(),
    target,
  };
}

/**
 * Acquire one same-user cross-process mutation lock for `target`.
 *
 * `mkdir` is the atomic claim. Locks live in a private per-user runtime namespace keyed by the
 * canonical target path, never inside the portable bundle: Git staging, establishment snapshots,
 * copying, and packaging cannot capture them. A valid same-host lock whose PID is absent is moved
 * to a token-fenced quarantine and retried; malformed, foreign-host, and live locks remain
 * fail-closed.
 */
export async function acquireFilesystemMutationLock(
  target: string,
  options: FilesystemMutationLockOptions = {},
): Promise<() => Promise<void>> {
  const policy = captureFilesystemHostPolicy(options.hostPolicy);
  const waitMs = positiveOption(options.waitMs, DEFAULT_WAIT_MS, "waitMs");
  const pollMs = positiveOption(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  const targetResolved = path.resolve(target);
  const targetDir = path.dirname(targetResolved);
  const owner = newOwner(targetResolved);

  // Existing filesystem roots can reject even a recursive mkdir. Resolve first and create
  // only when the parent is genuinely absent. This preserves the
  // create-on-demand behavior without mutating an already-existing filesystem root.
  let canonicalDir: string;
  try {
    canonicalDir = await fs.realpath(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(targetDir, { recursive: true });
    canonicalDir = await fs.realpath(targetDir);
  }
  // Two callers may spell the same bundle through real and symlinked parent paths. Canonicalize
  // the now-existing parent so both claim the same runtime lock for the physical target.
  const targetCanonical = await canonicalTargetInDirectory(canonicalDir, path.basename(targetResolved));
  const lockRoot = await selectLockRoot(options, policy);
  const lockPath = filesystemMutationLockPathInRoot(targetCanonical, lockRoot);
  return claimLockPath(lockPath, { ...owner, target: targetCanonical }, waitMs, pollMs, policy);
}

const IDENTITY_KEY_SHAPE = /^[0-9a-f]{64}$/;

function assertIdentityKey(key: string): void {
  if (!IDENTITY_KEY_SHAPE.test(key)) throw new TypeError("identity key must be a lowercase hex sha256 digest");
}

/** @internal Runtime lock directory for one identity key; the key is the whole path component. */
export function filesystemIdentityLockPath(key: string, portableRoot?: string, hostPolicy?: FilesystemHostPolicy): string {
  assertIdentityKey(key);
  return path.join(filesystemMutationLockRoot(portableRoot, hostPolicy), `${key}.lock`);
}

/**
 * @internal Claim the same-user cross-process lock for an identity key that the caller derived
 * purely (`filesystem-identity.ts`). Unlike {@link acquireFilesystemMutationLock} this creates no
 * target directory and resolves no target path: the bundle stays exactly as it was until the
 * caller decides to mutate it. `identity` is recorded as the owner's `target` for diagnosis.
 */
export async function acquireFilesystemIdentityLock(
  key: string,
  identity: string,
  options: FilesystemMutationLockOptions = {},
): Promise<() => Promise<void>> {
  assertIdentityKey(key);
  const policy = captureFilesystemHostPolicy(options.hostPolicy);
  const waitMs = positiveOption(options.waitMs, DEFAULT_WAIT_MS, "waitMs");
  const pollMs = positiveOption(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  const owner = newOwner(identity);
  const lockRoot = await selectLockRoot(options, policy);
  return claimLockPath(path.join(lockRoot, `${key}.lock`), owner, waitMs, pollMs, policy);
}

/** Run `fn` while holding the same-user cross-process mutation lock for `target`. */
export async function withFilesystemMutationLock<T>(
  target: string,
  fn: () => Promise<T>,
  options: FilesystemMutationLockOptions = {},
): Promise<T> {
  const release = await acquireFilesystemMutationLock(target, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * How long ago a lock directory last changed (its owner record written or removed), or null when
 * it is gone. Lets a caller tell a claim or release in progress from an orphaned lock.
 */
export async function filesystemLockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const info = await fs.stat(lockPath);
    return Math.max(0, Date.now() - info.mtimeMs);
  } catch {
    return null;
  }
}
