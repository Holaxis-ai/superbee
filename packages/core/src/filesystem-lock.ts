import { promises as fs, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
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

function runtimeOwnerKey(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) return `uid-${uid}`;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Windows temp directories are already user-scoped; this is only a stable path segment.
  }
  return `user-${createHash("sha256").update(username).digest("hex").slice(0, 16)}`;
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
export function filesystemMutationLockRoot(portableRoot?: string): string {
  // POSIX TMPDIR is process/session-scoped (notably shell vs launchd on macOS). Use the
  // system-wide sticky directory so every same-user writer derives one lock namespace.
  const tempParent = canonicalExistingPath(process.platform === "win32" ? tmpdir() : "/tmp");
  const homeParent = canonicalExistingPath(homedir());
  const ownerKey = runtimeOwnerKey();
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
export function filesystemMutationLockPath(target: string, portableRoot?: string): string {
  return filesystemMutationLockPathInRoot(target, filesystemMutationLockRoot(portableRoot));
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

async function readOwner(lockPath: string): Promise<FilesystemMutationLockOwner | null> {
  try {
    return parseFilesystemMutationLockOwner(
      JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), "utf8")),
    );
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
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

async function ensurePrivateLockRoot(root: string): Promise<void> {
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
      enforcePrivateMode: process.platform !== "win32",
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
    const candidateStat = await fs.lstat(candidate);
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

async function selectLockRoot(options: FilesystemMutationLockOptions): Promise<string> {
  const portableRoot = await resolvedPortableRoot(options.portableRoot);
  const lockRoot = options.lockRoot !== undefined
    ? explicitFilesystemMutationLockRoot(options.lockRoot, portableRoot)
    : filesystemMutationLockRoot(portableRoot);
  await ensurePrivateLockRoot(lockRoot);
  return lockRoot;
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
): Promise<() => Promise<void>> {
  const started = owner.created_at_ms;
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (err) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      return async () => {
        const current = await readOwner(lockPath);
        if (current?.token !== owner.token) {
          throw new FilesystemMutationLockError(
            `refusing to release filesystem mutation lock '${lockPath}' because its owner token changed; the mutation may have completed, inspect the lock before retrying.`,
            { lockPath, owner: current, stale: false, malformed: current === null },
          );
        }
        try {
          await fs.rm(lockPath, { recursive: true, force: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new FilesystemMutationLockError(
            `mutation completed but filesystem lock '${lockPath}' could not be removed (${message}); inspect the lock before retrying.`,
            { lockPath, owner: current, stale: false, malformed: false },
          );
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    if (Date.now() - started >= waitMs) throw timeoutError(lockPath, await readOwner(lockPath), owner.target);
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
 * copying, and packaging cannot capture them. The owner record makes a crash leftover diagnosable,
 * but this primitive never steals one automatically.
 */
export async function acquireFilesystemMutationLock(
  target: string,
  options: FilesystemMutationLockOptions = {},
): Promise<() => Promise<void>> {
  const waitMs = positiveOption(options.waitMs, DEFAULT_WAIT_MS, "waitMs");
  const pollMs = positiveOption(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  const targetResolved = path.resolve(target);
  const targetDir = path.dirname(targetResolved);
  const owner = newOwner(targetResolved);

  // An existing Windows drive root (for example C:\) can reject even a recursive mkdir with
  // EPERM. Resolve first and create only when the parent is genuinely absent. This preserves the
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
  const lockRoot = await selectLockRoot(options);
  const lockPath = filesystemMutationLockPathInRoot(targetCanonical, lockRoot);
  return claimLockPath(lockPath, { ...owner, target: targetCanonical }, waitMs, pollMs);
}

const IDENTITY_KEY_SHAPE = /^[0-9a-f]{64}$/;

function assertIdentityKey(key: string): void {
  if (!IDENTITY_KEY_SHAPE.test(key)) throw new TypeError("identity key must be a lowercase hex sha256 digest");
}

/** @internal Runtime lock directory for one identity key; the key is the whole path component. */
export function filesystemIdentityLockPath(key: string, portableRoot?: string): string {
  assertIdentityKey(key);
  return path.join(filesystemMutationLockRoot(portableRoot), `${key}.lock`);
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
  const waitMs = positiveOption(options.waitMs, DEFAULT_WAIT_MS, "waitMs");
  const pollMs = positiveOption(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  const owner = newOwner(identity);
  const lockRoot = await selectLockRoot(options);
  return claimLockPath(path.join(lockRoot, `${key}.lock`), owner, waitMs, pollMs);
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
