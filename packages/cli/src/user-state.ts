// One authority for private, user-scoped CLI state.
//
// Superbee owns one platform-native private root: ~/.superbee-state on POSIX and
// %LOCALAPPDATA%\Superbee on Windows. The separately published Aslite bridge keeps its historical
// ~/.agentstate root until that bridge is retired. Ordinary readers never consult a superseded
// root; only setup's explicit migration module may inspect them.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, isAbsolute, join, relative, sep } from "node:path";

import { withFilesystemMutationLock } from "@superbee/core";
import { staticBuildIdentity } from "./build-identity.js";

/**
 * The released POSIX private-root spelling. The platform policy below is the location authority;
 * Windows deliberately uses its per-user LocalAppData known folder instead.
 */
export const SUPERBEE_USER_STATE_PATH_SEGMENTS: readonly string[] = Object.freeze([".superbee-state"]);

/**
 * Superseded state roots, newest first. A root stays here while it remains a migration SOURCE, and
 * this list only ever grows: every entry is also a guarded bundle boundary.
 */
export const SUPERSEDED_USER_STATE_PATH_SEGMENTS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([".config", "superbee"]),
]);

const WINDOWS_SUPERSEDED_USER_STATE_PATH_SEGMENTS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([".superbee-state"]),
  ...SUPERSEDED_USER_STATE_PATH_SEGMENTS,
]);

/** `~/.superbee-state` — the display spelling, derived from the one constant above. */
export const USER_STATE_DIR_DISPLAY = `~/${SUPERBEE_USER_STATE_PATH_SEGMENTS.join("/")}`;

export const USER_STATE_QUARANTINE_COMMAND = "superbee setup quarantine-state";
export const USER_STATE_HARDEN_COMMAND = "superbee setup harden-state";

/**
 * `~`-relative spelling of a path under $HOME. Every refusal names a guarded root through this, so
 * no resolved private path reaches a message, a help string, or a receipt.
 */
export function homeRelativeDisplay(home: string, target: string): string {
  const child = relative(home, target);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) return target;
  return `~/${child.split(sep).join("/")}`;
}

export const LEGACY_USER_STATE_DIR_NAME = ".agentstate";
export const LEGACY_BRIDGE_PACKAGE_NAME = "@holaxis/aslite";
export const USER_STATE_MARKER_FILE_NAME = "state.json";
export const USER_STATE_MARKER = Object.freeze({ product: "superbee", schema_version: 1 as const });
export const USER_STATE_MARKER_BYTES = `${JSON.stringify(USER_STATE_MARKER)}\n`;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MARKER_MAX_BYTES = 256;
const STATE_ROOT_GITIGNORE_FILE_NAME = ".gitignore";
const STATE_ROOT_GITIGNORE_BYTES = "*\n";

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function absoluteStateRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  if (!platformPath(platform).isAbsolute(root)) {
    throw new Error("private Superbee user-state root must be an absolute path");
  }
  return root;
}

export interface UserStateEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface UserStatePolicy {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly state: "ready" | "blocked";
  readonly canonicalRoot: string | null;
  readonly guardedRoots: readonly string[];
  readonly displayRoot: string;
  readonly containment: "posix-owner-mode" | "windows-user-local";
  readonly reason?: string;
}

export type UserStateInput = string | UserStateEnvironment;

export class UserStatePolicyUnavailable extends Error {
  readonly command = "superbee setup";
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "UserStatePolicyUnavailable";
    this.reason = reason;
  }
}

export function userStateEnvironment(input?: UserStateInput): UserStateEnvironment {
  if (typeof input === "object") return input;
  const home = input ?? homedir();
  if (process.platform !== "win32" || input === undefined) {
    return { platform: process.platform, home, env: process.env };
  }
  // `home: string` is the historical injected-profile seam used throughout the test and SDK
  // adapters. On Windows an explicitly different profile must be self-contained rather than
  // silently sharing the running account's real LOCALAPPDATA. The real production profile still
  // consumes process.env exactly, including a redirected known folder. Callers that need to inject
  // a non-conventional Windows layout use the complete UserStateEnvironment seam above.
  const paths = path.win32;
  const injectedProfile = paths.normalize(home).toLocaleLowerCase("en-US")
    !== paths.normalize(homedir()).toLocaleLowerCase("en-US");
  if (!injectedProfile) return { platform: process.platform, home, env: process.env };
  return {
    platform: process.platform,
    home,
    env: {
      ...process.env,
      USERPROFILE: home,
      LOCALAPPDATA: paths.join(home, "AppData", "Local"),
      APPDATA: paths.join(home, "AppData", "Roaming"),
    },
  };
}

function absoluteHome(environment: UserStateEnvironment): string {
  return absoluteStateRoot(environment.home, environment.platform);
}

export function resolveUserStatePolicy(input?: UserStateInput): UserStatePolicy {
  const environment = userStateEnvironment(input);
  const home = absoluteHome(environment);
  const paths = platformPath(environment.platform);
  const legacy = absoluteStateRoot(paths.join(home, LEGACY_USER_STATE_DIR_NAME), environment.platform);
  const supersededSegments = environment.platform === "win32"
    ? WINDOWS_SUPERSEDED_USER_STATE_PATH_SEGMENTS
    : SUPERSEDED_USER_STATE_PATH_SEGMENTS;
  const superseded = supersededSegments.map((segments) => absoluteStateRoot(paths.join(home, ...segments), environment.platform));
  if (environment.platform !== "win32") {
    const canonicalRoot = absoluteStateRoot(paths.join(home, ...SUPERBEE_USER_STATE_PATH_SEGMENTS), environment.platform);
    return {
      platform: environment.platform,
      home,
      state: "ready",
      canonicalRoot,
      guardedRoots: [...new Set([canonicalRoot, legacy, ...superseded])],
      displayRoot: USER_STATE_DIR_DISPLAY,
      containment: "posix-owner-mode",
    };
  }
  const localAppData = environment.env.LOCALAPPDATA?.trim() ?? "";
  const normalizedLocalAppData = paths.normalize(localAppData);
  const localAppDataRoot = paths.parse(normalizedLocalAppData).root;
  // Windows treats `\foo` as absolute even though it is relative to the current drive. A genuine
  // UNC root is also absolute and remains a valid redirected known folder under D2, but device
  // namespaces (`\\?\`, `\\.\`, and `\??\`) are separate authorities and stay outside policy.
  const driveQualifiedLocal = /^[A-Za-z]:\\$/u.test(localAppDataRoot);
  const deviceNamespace = /^(?:\\\\[?.]\\|\\\?\?\\)/u.test(normalizedLocalAppData);
  const genuineUnc = !deviceNamespace && /^\\\\[^\\]+\\[^\\]+\\$/u.test(localAppDataRoot);
  if (localAppData === "" || !paths.isAbsolute(normalizedLocalAppData) || (!driveQualifiedLocal && !genuineUnc)) {
    return {
      platform: environment.platform,
      home,
      state: "blocked",
      canonicalRoot: null,
      guardedRoots: [...new Set([legacy, ...superseded])],
      displayRoot: "%LOCALAPPDATA%\\Superbee",
      containment: "windows-user-local",
      reason: "LOCALAPPDATA must name an absolute drive-qualified or UNC Windows directory; root-relative, drive-relative, and device paths are not accepted",
    };
  }
  const canonicalRoot = absoluteStateRoot(paths.join(normalizedLocalAppData, "Superbee"), environment.platform);
  return {
    platform: environment.platform,
    home,
    state: "ready",
    canonicalRoot,
    guardedRoots: [...new Set([canonicalRoot, ...superseded, legacy])],
    displayRoot: "%LOCALAPPDATA%\\Superbee",
    containment: "windows-user-local",
  };
}

function requireCanonicalRoot(input?: UserStateInput): { environment: UserStateEnvironment; policy: UserStatePolicy; root: string } {
  const environment = userStateEnvironment(input);
  const policy = resolveUserStatePolicy(environment);
  if (policy.canonicalRoot === null) throw new UserStatePolicyUnavailable(policy.reason ?? "private user-state policy is unavailable");
  return { environment, policy, root: policy.canonicalRoot };
}

export function canonicalUserStateDir(input?: UserStateInput): string {
  return requireCanonicalRoot(input).root;
}

export function legacyUserStateDir(input?: UserStateInput): string {
  const environment = userStateEnvironment(input);
  return absoluteStateRoot(platformPath(environment.platform).join(absoluteHome(environment), LEGACY_USER_STATE_DIR_NAME), environment.platform);
}

/** Every superseded canonical root, newest first: still a migration source, still guarded. */
export function supersededUserStateDirs(input?: UserStateInput): string[] {
  const environment = userStateEnvironment(input);
  const segments = environment.platform === "win32"
    ? WINDOWS_SUPERSEDED_USER_STATE_PATH_SEGMENTS
    : SUPERSEDED_USER_STATE_PATH_SEGMENTS;
  const paths = platformPath(environment.platform);
  return segments.map((entry) => absoluteStateRoot(paths.join(absoluteHome(environment), ...entry), environment.platform));
}

export function userStatePathDisplay(input: UserStateInput, target: string): string {
  const policy = resolveUserStatePolicy(input);
  const paths = platformPath(policy.platform);
  if (policy.canonicalRoot !== null) {
    const localChild = paths.relative(policy.canonicalRoot, target);
    if (localChild === "") return policy.displayRoot;
    if (!localChild.startsWith("..") && !paths.isAbsolute(localChild)) {
      const suffix = localChild.split(paths.sep).join(policy.platform === "win32" ? "\\" : "/");
      return `${policy.displayRoot}${policy.platform === "win32" ? "\\" : "/"}${suffix}`;
    }
  }
  const homeChild = paths.relative(policy.home, target);
  if (homeChild === "") return policy.platform === "win32" ? "%USERPROFILE%" : "~";
  if (!homeChild.startsWith("..") && !paths.isAbsolute(homeChild)) {
    const suffix = homeChild.split(paths.sep).join(policy.platform === "win32" ? "\\" : "/");
    return policy.platform === "win32" ? `%USERPROFILE%\\${suffix}` : `~/${suffix}`;
  }
  return target;
}

export function userStateDirForPackage(input: UserStateInput, packageName: string): string {
  return packageName === LEGACY_BRIDGE_PACKAGE_NAME ? legacyUserStateDir(input) : canonicalUserStateDir(input);
}

export function userStateDir(input: UserStateInput = homedir()): string {
  return userStateDirForPackage(input, staticBuildIdentity().package.name);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface PrivateStateStatus {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function sameFileIdentity(left: PrivateStateStatus, right: PrivateStateStatus): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function privateStateEntryIsSafe(
  status: PrivateStateStatus,
  kind: "directory" | "file",
  input?: UserStateInput,
): boolean {
  const policy = resolveUserStatePolicy(input);
  if (status.isSymbolicLink() || (kind === "directory" ? !status.isDirectory() : !status.isFile())) return false;
  if (policy.containment === "windows-user-local") return true;
  const currentUid = process.getuid?.();
  return (status.mode & 0o077) === 0 && (currentUid === undefined || status.uid === currentUid);
}

function privateStateEntryIsOwned(
  status: PrivateStateStatus,
  kind: "directory" | "file",
  input?: UserStateInput,
): boolean {
  const policy = resolveUserStatePolicy(input);
  if (status.isSymbolicLink() || (kind === "directory" ? !status.isDirectory() : !status.isFile())) return false;
  if (policy.containment === "windows-user-local") return true;
  const currentUid = process.getuid?.();
  return currentUid === undefined || status.uid === currentUid;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("private user-state path is not a real directory");
  }
}

/**
 * The canonical root's parent is $HOME itself. A symlinked home directory is the operator's own
 * configuration and `homedir()` is already the trusted input, so the parent is checked as a
 * DIRECTORY (following links); only the state ROOT must be a real, non-symlink directory.
 */
async function ensureParentDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("private user-state parent is not a directory");
  }
}

/** Read one bounded private record without following a final symlink or blocking on a FIFO. */
export async function readPrivateStateFile(
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
  input?: UserStateInput,
): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const policy = resolveUserStatePolicy(input);
  const before = policy.containment === "windows-user-local" ? await lstat(file) : null;
  if (before !== null && !privateStateEntryIsSafe(before, "file", input)) {
    throw new Error("private user-state record is not a regular file");
  }
  const flags = constants.O_RDONLY | constants.O_NONBLOCK
    | (policy.containment === "posix-owner-mode" ? (constants.O_NOFOLLOW ?? 0) : 0);
  const handle = await open(file, flags);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > maxBytes) throw new Error("private user-state record is not a bounded regular file");
    if (before !== null && !sameFileIdentity(before, status)) throw new Error("private user-state record changed during open");
    const bytes = Buffer.alloc(status.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("private user-state record exceeds its size limit");
    if (before !== null) {
      const after = await lstat(file);
      if (!privateStateEntryIsSafe(after, "file", input) || !sameFileIdentity(before, after)) {
        throw new Error("private user-state record changed during read");
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

/**
 * "Carries our ownership marker" and "is hardened" are INDEPENDENT facts, and conflating them is
 * what let a root with a perfectly valid marker be reported as unrecognized and handed a
 * quarantine. RECOGNITION is decided by ownership evidence only — a real regular file, our uid,
 * our exact bytes. Permissions decide HARDENING, which is drift this product repairs.
 */
interface UserStateMarkerInspection {
  readonly recognized: boolean;
  readonly hardened: boolean;
}

async function inspectUserStateMarker(root: string, input?: UserStateInput): Promise<UserStateMarkerInspection> {
  try {
    const marker = join(root, USER_STATE_MARKER_FILE_NAME);
    const status = await lstat(marker);
    const recognized = privateStateEntryIsOwned(status, "file", input)
      && await readPrivateStateFile(marker, MARKER_MAX_BYTES, undefined, input) === USER_STATE_MARKER_BYTES;
    return {
      recognized,
      hardened: recognized && (
        resolveUserStatePolicy(input).containment === "windows-user-local" || (status.mode & 0o077) === 0
      ),
    };
  } catch {
    return { recognized: false, hardened: false };
  }
}

export async function hasExactUserStateMarker(root: string, input?: UserStateInput): Promise<boolean> {
  return (await inspectUserStateMarker(root, input)).recognized;
}

async function publishFileAtomic0600(
  dir: string,
  fileName: string,
  content: string,
  options: { beforeCommit?: () => boolean | Promise<boolean> } = {},
  input?: UserStateInput,
): Promise<void> {
  const policy = resolveUserStatePolicy(input);
  const file = join(dir, fileName);
  const temporary = join(dir, `.${fileName}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(content);
    if (policy.containment === "posix-owner-mode") await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.beforeCommit && !(await options.beforeCommit())) {
      throw new Error("atomic write commit authority was withdrawn");
    }
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Atomic 0600 write inside a caller-validated private directory. */
export async function writeFileAtomic0600(
  dir: string,
  fileName: string,
  content: string,
  options: { beforeCommit?: () => boolean | Promise<boolean> } = {},
  input?: UserStateInput,
): Promise<void> {
  const policy = resolveUserStatePolicy(input);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await assertRealDirectory(dir);
  if (policy.containment === "posix-owner-mode") await chmod(dir, DIR_MODE);
  await publishFileAtomic0600(dir, fileName, content, options, input);
}

/**
 * A state root that some git work tree already encloses must not be offered up by `git add -A`.
 * Written opportunistically on every ensure so roots created by earlier versions gain it, strictly
 * AFTER the ownership assertion (a foreign or half-created root never receives product bytes).
 * Migration calls it too, but only once its exact-topology assertions and journal removal are
 * complete — never during staging, which would see the file as foreign stock.
 * Inert for an ALREADY-TRACKED root, which is why it is hardening rather than the whole answer.
 */
export async function ensureStateRootGitignore(root: string, input?: UserStateInput): Promise<void> {
  try {
    if (await readPrivateStateFile(join(root, STATE_ROOT_GITIGNORE_FILE_NAME), 64, undefined, input) === STATE_ROOT_GITIGNORE_BYTES) return;
  } catch {
    // Absent, unreadable, or stale — fall through and (re)publish it.
  }
  try {
    await writeFileAtomic0600(root, STATE_ROOT_GITIGNORE_FILE_NAME, STATE_ROOT_GITIGNORE_BYTES, {}, input);
  } catch {
    // Best effort only: hardening must never fail an otherwise-valid ensure.
  }
}

function ensureStateRootGitignoreSync(root: string, input?: UserStateInput): void {
  const policy = resolveUserStatePolicy(input);
  try {
    if (readFileSync(join(root, STATE_ROOT_GITIGNORE_FILE_NAME), "utf8") === STATE_ROOT_GITIGNORE_BYTES) return;
  } catch {
    // Absent, unreadable, or stale — fall through and (re)publish it.
  }
  const temporary = join(root, `.${STATE_ROOT_GITIGNORE_FILE_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    writeFileSync(descriptor, STATE_ROOT_GITIGNORE_BYTES, "utf8");
    if (policy.containment === "posix-owner-mode") fchmodSync(descriptor, FILE_MODE);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, join(root, STATE_ROOT_GITIGNORE_FILE_NAME));
  } catch {
    // Best effort only: hardening must never fail an otherwise-valid ensure.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed into place, or never created.
    }
  }
}

interface UserStateRootInitializationHooks {
  /** @internal Deterministic child-process barrier after root creation and before ownership commit. */
  readonly beforeMarkerPublication?: () => void | Promise<void>;
  /** @internal Forces lock placement in the exclusion test; production always uses the default. */
  readonly lockRoot?: string;
}

async function publishCanonicalRoot(
  root: string,
  input: UserStateInput | undefined,
  hooks: UserStateRootInitializationHooks,
): Promise<void> {
  let created = false;
  try {
    await mkdir(root, { mode: DIR_MODE });
    created = true;
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await assertRealDirectory(root);
  if (created) {
    try {
      await hooks.beforeMarkerPublication?.();
      await writeFileAtomic0600(root, USER_STATE_MARKER_FILE_NAME, USER_STATE_MARKER_BYTES, {}, input);
    } catch (error) {
      await rmdir(root).catch(() => {});
      throw error;
    }
  }
  const marker = await inspectUserStateMarker(root, input);
  if (!marker.recognized) {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
}

async function initializeCanonicalRoot(
  root: string,
  input?: UserStateInput,
  hooks: UserStateRootInitializationHooks = {},
): Promise<void> {
  const policy = resolveUserStatePolicy(input);
  const parent = dirname(root);
  await ensureParentDirectory(parent);
  const lockOptions = hooks.lockRoot === undefined
    ? { portableRoot: root }
    : { portableRoot: root, lockRoot: hooks.lockRoot };
  await withFilesystemMutationLock(root, () => publishCanonicalRoot(root, input, hooks), lockOptions);

  const marker = await inspectUserStateMarker(root, input);
  if (!marker.recognized) {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  // Ownership is proven, so drifted permissions are repaired rather than refused — the directory
  // first, so the marker is re-tightened inside an already-private root.
  if (policy.containment === "posix-owner-mode") {
    await chmod(root, DIR_MODE);
    if (!marker.hardened) await chmod(join(root, USER_STATE_MARKER_FILE_NAME), FILE_MODE);
  }
  await ensureStateRootGitignore(root, input);
}

/** Ensure the running package's one writable state root exists and is safe. */
export async function ensureUserStateRoot(input: UserStateInput = homedir()): Promise<string> {
  const packageName = staticBuildIdentity().package.name;
  const policy = resolveUserStatePolicy(input);
  const root = userStateDirForPackage(input, packageName);
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    try {
      await mkdir(root, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    await assertRealDirectory(root);
    if (policy.containment === "posix-owner-mode") await chmod(root, DIR_MODE);
    await ensureStateRootGitignore(root, input);
    return root;
  }
  await initializeCanonicalRoot(root, input);
  return root;
}

/** @internal Test-only entry point for deterministic initialization publication barriers. */
export async function ensureUserStateRootForTest(
  input: UserStateInput,
  hooks: UserStateRootInitializationHooks,
): Promise<string> {
  const packageName = staticBuildIdentity().package.name;
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    throw new Error("the canonical-root initialization seam is unavailable to the legacy bridge");
  }
  const root = userStateDirForPackage(input, packageName);
  await initializeCanonicalRoot(root, input, hooks);
  return root;
}

function ensureRealDirectorySync(directory: string): void {
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("private user-state path is not a real directory");
  }
}

function writeMarkerExclusiveSync(root: string, input?: UserStateInput): void {
  const policy = resolveUserStatePolicy(input);
  const marker = join(root, USER_STATE_MARKER_FILE_NAME);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    writeFileSync(descriptor, USER_STATE_MARKER_BYTES, "utf8");
    if (policy.containment === "posix-owner-mode") fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Non-concurrent synchronous test boundary. Production sources do not call this helper, and it
 * deliberately makes no cross-process initialization guarantee; callers must serialize its use.
 */
export function ensureUserStateRootSync(input: UserStateInput = homedir()): string {
  const packageName = staticBuildIdentity().package.name;
  const policy = resolveUserStatePolicy(input);
  const root = userStateDirForPackage(input, packageName);
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    try {
      mkdirSync(root, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    ensureRealDirectorySync(root);
    if (policy.containment === "posix-owner-mode") chmodSync(root, DIR_MODE);
    ensureStateRootGitignoreSync(root, input);
    return root;
  }

  const parent = dirname(root);
  try {
    mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  if (!statSync(parent).isDirectory()) {
    throw new Error("private user-state parent is not a directory");
  }
  let created = false;
  try {
    mkdirSync(root, { mode: DIR_MODE });
    created = true;
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  ensureRealDirectorySync(root);
  if (created) {
    try {
      writeMarkerExclusiveSync(root, input);
    } catch (error) {
      try {
        rmdirSync(root);
      } catch {
        // Preserve uncertain state for explicit inspection.
      }
      throw error;
    }
  }
  let marker: string;
  try {
    marker = readFileSync(join(root, USER_STATE_MARKER_FILE_NAME), "utf8");
  } catch {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  if (marker !== USER_STATE_MARKER_BYTES) {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  if (policy.containment === "posix-owner-mode") {
    chmodSync(root, DIR_MODE);
    if ((lstatSync(join(root, USER_STATE_MARKER_FILE_NAME)).mode & 0o077) !== 0) {
      chmodSync(join(root, USER_STATE_MARKER_FILE_NAME), FILE_MODE);
    }
  }
  ensureStateRootGitignoreSync(root, input);
  return root;
}

/** One write entry point for every persistent private Superbee record. */
export async function writeUserStateFileAtomic0600(
  input: UserStateInput,
  dir: string,
  fileName: string,
  content: string,
  options: { beforeCommit?: () => boolean | Promise<boolean> } = {},
): Promise<void> {
  await ensureUserStateRoot(input);
  await writeFileAtomic0600(dir, fileName, content, options, input);
}

export type UserStateRootState = "absent" | "ready" | "conflict";

export interface UserStateRootInspection {
  readonly state: UserStateRootState;
  /**
   * `loose` = recognized as ours, with group- or world-accessible permissions on the root or its
   * marker. That is repairable drift, not a foreign root: an ordinary write tightens it, so the
   * inspector must agree that the root is usable rather than prescribing a quarantine.
   */
  readonly hardening: "hardened" | "loose";
}

/**
 * Marker read used by setup inspection; it does not create or repair anything. It reports the two
 * independent facts separately so no caller has to re-derive one from the other.
 */
export async function inspectCanonicalUserStateRootDetail(
  input: UserStateInput = homedir(),
): Promise<UserStateRootInspection> {
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") return { state: "conflict", hardening: "hardened" };
  const root = canonicalUserStateDir(input);
  let looseRoot = false;
  try {
    await assertRealDirectory(root);
    const status = await lstat(root);
    if (status.isSymbolicLink() || !status.isDirectory()) return { state: "conflict", hardening: "hardened" };
    if (policy.containment === "posix-owner-mode") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && status.uid !== currentUid) return { state: "conflict", hardening: "hardened" };
      looseRoot = (status.mode & 0o077) !== 0;
    }
  } catch (error) {
    return { state: errno(error) === "ENOENT" ? "absent" : "conflict", hardening: "hardened" };
  }
  const marker = await inspectUserStateMarker(root, input);
  if (!marker.recognized) return { state: "conflict", hardening: "hardened" };
  return { state: "ready", hardening: looseRoot || !marker.hardened ? "loose" : "hardened" };
}

export async function inspectCanonicalUserStateRoot(input: UserStateInput = homedir()): Promise<UserStateRootState> {
  return (await inspectCanonicalUserStateRootDetail(input)).state;
}

async function assertCanonicalUserStateRootReady(input: UserStateInput): Promise<void> {
  if (await inspectCanonicalUserStateRoot(input) !== "ready") {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
}

/** @internal Atomic write for callers that already completed root initialization and hold another lock. */
export async function writeReadyUserStateFileAtomic0600(
  input: UserStateInput,
  fileName: string,
  content: string,
): Promise<void> {
  const root = canonicalUserStateDir(input);
  await assertCanonicalUserStateRootReady(input);
  await publishFileAtomic0600(root, fileName, content, {
    beforeCommit: async () => {
      await assertCanonicalUserStateRootReady(input);
      return true;
    },
  }, input);
}

function missingStateError(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error("private user-state record is absent"), { code: "ENOENT", path: file });
}

function assertInsideRoot(root: string, file: string): void {
  const child = relative(root, file);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("private user-state record escapes its product root");
  }
}

/** Every existing directory between the owned root and a private record must stay private. */
async function assertPrivateDirectoryChain(root: string, file: string, input?: UserStateInput): Promise<void> {
  const parent = dirname(file);
  const child = relative(root, parent);
  if (child === "") return;
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error("private user-state record escapes its product root");
  }
  let current = root;
  for (const component of child.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    const status = await lstat(current);
    if (!privateStateEntryIsSafe(status, "directory", input)) {
      throw new Error("private user-state record has an unsafe containing directory");
    }
  }
}

/** Read one record only after the running package's root proves its exact ownership boundary. */
export async function readUserStateFile(
  input: UserStateInput,
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const packageName = staticBuildIdentity().package.name;
  const root = userStateDirForPackage(input, packageName);
  assertInsideRoot(root, file);
  // An absent record is absent regardless of whether a separate setup pass would diagnose the
  // surrounding root as incomplete. This keeps unrelated read-only operations (for example an
  // unauthenticated remote read) independent, while every existing-record read and every write
  // still proves the product-owned root first.
  try {
    await lstat(file);
  } catch (error) {
    if (errno(error) === "ENOENT") throw missingStateError(file);
    throw error;
  }
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    try {
      await assertRealDirectory(root);
    } catch (error) {
      if (errno(error) === "ENOENT") throw missingStateError(file);
      throw error;
    }
  } else {
    const state = await inspectCanonicalUserStateRoot(input);
    if (state === "absent") throw missingStateError(file);
    if (state === "conflict") throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  await assertPrivateDirectoryChain(root, file, input);
  return readPrivateStateFile(file, maxBytes, signal, input);
}

export function inspectUserStateRootSync(input: UserStateInput = homedir()): UserStateRootState {
  const packageName = staticBuildIdentity().package.name;
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") return "conflict";
  const root = userStateDirForPackage(input, packageName);
  try {
    ensureRealDirectorySync(root);
    const rootStatus = lstatSync(root);
    if (policy.containment === "posix-owner-mode") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && rootStatus.uid !== currentUid) return "conflict";
    }
  } catch (error) {
    return errno(error) === "ENOENT" ? "absent" : "conflict";
  }
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) return "ready";
  let descriptor: number | undefined;
  try {
    const marker = join(root, USER_STATE_MARKER_FILE_NAME);
    const before = lstatSync(marker);
    if (before.isSymbolicLink() || !before.isFile() || before.size > MARKER_MAX_BYTES) return "conflict";
    descriptor = openSync(
      marker,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    const after = lstatSync(marker);
    if (
      !opened.isFile()
      || !sameFileIdentity(before, opened)
      || after.isSymbolicLink()
      || !sameFileIdentity(before, after)
      || (policy.containment === "posix-owner-mode"
        && process.getuid?.() !== undefined
        && before.uid !== process.getuid?.())
    ) return "conflict";
    return readFileSync(descriptor, "utf8") === USER_STATE_MARKER_BYTES ? "ready" : "conflict";
  } catch {
    return "conflict";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface UserStateRecoveryReceipt {
  readonly schema_version: 1;
  readonly operation: "harden-state" | "quarantine-state";
  readonly status: "hardened" | "already_hardened" | "absent" | "quarantined";
  readonly changed: boolean;
  readonly root: string;
  readonly preserved_at?: string;
  readonly next: { readonly command: "superbee setup" };
}

interface PrivateTreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly identity: PrivateStateStatus;
}

async function inspectPrivateTree(target: string, directories: PrivateTreeEntry[], files: PrivateTreeEntry[]): Promise<void> {
  const status = await lstat(target);
  if (status.isSymbolicLink()) throw new Error("private user-state tree contains a symbolic link");
  if (status.isDirectory()) {
    directories.push({ path: target, kind: "directory", identity: status });
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) await inspectPrivateTree(join(target, entry.name), directories, files);
    const after = await lstat(target);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(status, after)) {
      throw new Error("private user-state tree changed during inspection");
    }
    return;
  }
  if (!status.isFile()) throw new Error("private user-state tree contains a non-regular entry");
  if (status.nlink !== 1) throw new Error("private user-state tree contains a hard-linked regular file");
  files.push({ path: target, kind: "file", identity: status });
}

function privateDirectoryChain(root: string, target: string): string[] {
  if (target === root) return [];
  const child = relative(root, dirname(target));
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error("private user-state entry changed during hardening");
  }
  const directories = [root];
  let current = root;
  for (const component of child.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    directories.push(current);
  }
  return directories;
}

async function hardenPrivateTreeEntry(
  root: string,
  entry: PrivateTreeEntry,
  directoryIdentities: ReadonlyMap<string, PrivateStateStatus>,
): Promise<void> {
  const directoryHandles: Array<Awaited<ReturnType<typeof open>>> = [];
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Node has no portable openat-style traversal. Bind every scanned ancestor to both an open
    // descriptor and its still-canonical pathname before opening the leaf; then recheck the whole
    // chain in reverse immediately before fchmod. Even if resolving a deeper pathname crossed an
    // ancestor that was concurrently replaced, that ancestor's own O_NOFOLLOW open or the repeated
    // pathname identity checks reject the observed substitution before mutation.
    const directoryChain = privateDirectoryChain(root, entry.path);
    for (const directory of directoryChain) {
      const expected = directoryIdentities.get(directory);
      if (expected === undefined) throw new Error("private user-state entry changed during hardening");
      const directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      directoryHandles.push(directoryHandle);
      const opened = await directoryHandle.stat();
      const named = await lstat(directory);
      if (
        !opened.isDirectory()
        || named.isSymbolicLink()
        || !named.isDirectory()
        || !sameFileIdentity(expected, opened)
        || !sameFileIdentity(expected, named)
      ) {
        throw new Error("private user-state entry changed during hardening");
      }
    }

    handle = await open(entry.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const afterOpen = await lstat(entry.path);
    const expectedShape = entry.kind === "directory" ? opened.isDirectory() : opened.isFile();
    const fileHasSingleLink = entry.kind === "directory"
      || (entry.identity.nlink === 1 && opened.nlink === 1 && afterOpen.nlink === 1);
    if (
      !expectedShape
      || !fileHasSingleLink
      || afterOpen.isSymbolicLink()
      || !sameFileIdentity(entry.identity, opened)
      || !sameFileIdentity(entry.identity, afterOpen)
    ) {
      throw new Error("private user-state entry changed during hardening");
    }

    for (let index = directoryChain.length - 1; index >= 0; index -= 1) {
      const directory = directoryChain[index]!;
      const expected = directoryIdentities.get(directory)!;
      const named = await lstat(directory);
      const openedDirectory = await directoryHandles[index]!.stat();
      if (
        named.isSymbolicLink()
        || !named.isDirectory()
        || !openedDirectory.isDirectory()
        || !sameFileIdentity(expected, named)
        || !sameFileIdentity(expected, openedDirectory)
      ) {
        throw new Error("private user-state entry changed during hardening");
      }
    }
    const immediatelyBefore = await lstat(entry.path);
    if (
      immediatelyBefore.isSymbolicLink()
      || !sameFileIdentity(entry.identity, immediatelyBefore)
    ) {
      throw new Error("private user-state entry changed during hardening");
    }
    // Keep the last identity observation and the mutation in one event-loop turn; yielding here
    // would reopen an avoidable in-process substitution window after the complete chain check.
    fchmodSync(handle.fd, entry.kind === "directory" ? DIR_MODE : FILE_MODE);
  } catch (error) {
    if (error instanceof Error && error.message === "private user-state entry changed during hardening") throw error;
    throw new Error("private user-state entry changed during hardening", { cause: error });
  } finally {
    await handle?.close();
    await Promise.all(directoryHandles.map(async (directoryHandle) => directoryHandle.close()));
  }
}

export interface UserStateHardeningHooks {
  /** Deterministic test barrier after the read-only tree scan and before descriptor hardening. */
  readonly afterInspect?: () => void | Promise<void>;
}

/** Explicit POSIX repair leaf for a recognized root. Windows ACL inheritance needs no chmod. */
export async function hardenUserState(
  input: UserStateInput = homedir(),
  hooks: UserStateHardeningHooks = {},
): Promise<UserStateRecoveryReceipt> {
  const policy = resolveUserStatePolicy(input);
  if (policy.canonicalRoot === null) throw new UserStatePolicyUnavailable(policy.reason ?? "private user-state policy is unavailable");
  const inspection = await inspectCanonicalUserStateRootDetail(input);
  const root = policy.canonicalRoot;
  if (inspection.state === "absent") {
    return { schema_version: 1, operation: "harden-state", status: "absent", changed: false, root: policy.displayRoot, next: { command: "superbee setup" } };
  }
  if (inspection.state !== "ready") throw new Error("canonical Superbee user-state root is not recognized; it cannot be hardened");
  if (policy.containment === "windows-user-local" || inspection.hardening === "hardened") {
    return { schema_version: 1, operation: "harden-state", status: "already_hardened", changed: false, root: policy.displayRoot, next: { command: "superbee setup" } };
  }
  const directories: PrivateTreeEntry[] = [];
  const files: PrivateTreeEntry[] = [];
  await inspectPrivateTree(root, directories, files);
  const directoryIdentities = new Map(directories.map((entry) => [entry.path, entry.identity] as const));
  await hooks.afterInspect?.();
  for (const file of files) await hardenPrivateTreeEntry(root, file, directoryIdentities);
  for (const directory of directories.reverse()) {
    await hardenPrivateTreeEntry(root, directory, directoryIdentities);
  }
  const after = await inspectCanonicalUserStateRootDetail(input);
  if (after.state !== "ready" || after.hardening !== "hardened") throw new Error("private user-state hardening did not converge");
  return { schema_version: 1, operation: "harden-state", status: "hardened", changed: true, root: policy.displayRoot, next: { command: "superbee setup" } };
}

/** Preserve an unrecognized canonical root by moving it into one exclusive same-parent container. */
export async function quarantineUserState(input: UserStateInput = homedir()): Promise<UserStateRecoveryReceipt> {
  const policy = resolveUserStatePolicy(input);
  if (policy.canonicalRoot === null) throw new UserStatePolicyUnavailable(policy.reason ?? "private user-state policy is unavailable");
  const root = policy.canonicalRoot;
  let inspection: UserStateRootInspection;
  try {
    inspection = await inspectCanonicalUserStateRootDetail(input);
  } catch (error) {
    if (errno(error) === "ENOENT") inspection = { state: "absent", hardening: "hardened" };
    else throw error;
  }
  if (inspection.state === "absent") {
    return { schema_version: 1, operation: "quarantine-state", status: "absent", changed: false, root: policy.displayRoot, next: { command: "superbee setup" } };
  }
  if (inspection.state === "ready") throw new Error("recognized Superbee user state cannot be quarantined");

  const parent = dirname(root);
  const base = path.basename(root);
  let container: string | undefined;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = join(parent, `${base}.unrecognized.${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(candidate, { mode: DIR_MODE });
      container = candidate;
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
  }
  if (container === undefined) throw new Error("could not allocate a collision-safe quarantine destination");
  const preserved = join(container, base);
  try {
    await rename(root, preserved);
  } catch (error) {
    await rmdir(container).catch(() => {});
    throw error;
  }
  return {
    schema_version: 1,
    operation: "quarantine-state",
    status: "quarantined",
    changed: true,
    root: policy.displayRoot,
    preserved_at: userStatePathDisplay(input, preserved),
    next: { command: "superbee setup" },
  };
}

/** Test/migration-only helper: read the exact marker bytes without a broad directory walk. */
export async function readUserStateMarker(input: UserStateInput = homedir()): Promise<string | null> {
  try {
    return await readFile(join(canonicalUserStateDir(input), USER_STATE_MARKER_FILE_NAME), "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}
