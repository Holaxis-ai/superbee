// One authority for private, user-scoped CLI state.
//
// The Superbee package owns ~/.config/superbee. The separately published Aslite bridge keeps its
// historical ~/.agentstate root until that bridge is retired. Ordinary Superbee readers never
// consult the legacy root; only setup's explicit one-shot migration module may inspect it.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { staticBuildIdentity } from "./build-identity.js";

export const SUPERBEE_USER_STATE_PARENT_DIR_NAME = ".config";
export const SUPERBEE_USER_STATE_DIR_NAME = "superbee";
export const LEGACY_USER_STATE_DIR_NAME = ".agentstate";
export const LEGACY_BRIDGE_PACKAGE_NAME = "@holaxis/aslite";
export const USER_STATE_MARKER_FILE_NAME = "state.json";
export const USER_STATE_MARKER = Object.freeze({ product: "superbee", schema_version: 1 as const });
export const USER_STATE_MARKER_BYTES = `${JSON.stringify(USER_STATE_MARKER)}\n`;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MARKER_MAX_BYTES = 256;

export function canonicalUserStateDir(home: string = homedir()): string {
  return join(home, SUPERBEE_USER_STATE_PARENT_DIR_NAME, SUPERBEE_USER_STATE_DIR_NAME);
}

export function legacyUserStateDir(home: string = homedir()): string {
  return join(home, LEGACY_USER_STATE_DIR_NAME);
}

export function userStateDirForPackage(home: string, packageName: string): string {
  return packageName === LEGACY_BRIDGE_PACKAGE_NAME ? legacyUserStateDir(home) : canonicalUserStateDir(home);
}

export function userStateDir(home: string = homedir()): string {
  return userStateDirForPackage(home, staticBuildIdentity().package.name);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function assertRealDirectory(directory: string): Promise<void> {
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("private user-state path is not a real directory");
  }
}

async function ensureParentDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await assertRealDirectory(directory);
}

/** Read one bounded private record without following a final symlink or blocking on a FIFO. */
export async function readPrivateStateFile(file: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > maxBytes) throw new Error("private user-state record is not a bounded regular file");
    const bytes = Buffer.alloc(status.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("private user-state record exceeds its size limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export async function hasExactUserStateMarker(root: string): Promise<boolean> {
  try {
    const marker = join(root, USER_STATE_MARKER_FILE_NAME);
    const status = await lstat(marker);
    const currentUid = process.getuid?.();
    return !status.isSymbolicLink()
      && status.isFile()
      && (status.mode & 0o077) === 0
      && (currentUid === undefined || status.uid === currentUid)
      && await readPrivateStateFile(marker, MARKER_MAX_BYTES) === USER_STATE_MARKER_BYTES;
  } catch {
    return false;
  }
}

/** Atomic 0600 write inside a caller-validated private directory. */
export async function writeFileAtomic0600(
  dir: string,
  fileName: string,
  content: string,
  options: { beforeCommit?: () => boolean | Promise<boolean> } = {},
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await assertRealDirectory(dir);
  await chmod(dir, DIR_MODE);

  const file = join(dir, fileName);
  const temporary = join(dir, `.${fileName}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.chmod(FILE_MODE);
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

async function initializeCanonicalRoot(root: string): Promise<void> {
  const parent = dirname(root);
  await ensureParentDirectory(parent);
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
      await writeFileAtomic0600(root, USER_STATE_MARKER_FILE_NAME, USER_STATE_MARKER_BYTES);
    } catch (error) {
      await rmdir(root).catch(() => {});
      throw error;
    }
  }
  if (!created) {
    // A second process may observe the exclusively-created directory before its owner publishes
    // the tiny marker. Bound that ordinary first-write race without adopting a persistent
    // marker-less directory: after ~250 ms it is still a conflict requiring setup inspection.
    for (let attempt = 0; attempt < 50 && !(await hasExactUserStateMarker(root)); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!(await hasExactUserStateMarker(root))) {
    throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  await chmod(root, DIR_MODE);
}

/** Ensure the running package's one writable state root exists and is safe. */
export async function ensureUserStateRoot(home: string = homedir()): Promise<string> {
  const packageName = staticBuildIdentity().package.name;
  const root = userStateDirForPackage(home, packageName);
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    try {
      await mkdir(root, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    await assertRealDirectory(root);
    await chmod(root, DIR_MODE);
    return root;
  }
  await initializeCanonicalRoot(root);
  return root;
}

function ensureRealDirectorySync(directory: string): void {
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("private user-state path is not a real directory");
  }
}

function writeMarkerExclusiveSync(root: string): void {
  const marker = join(root, USER_STATE_MARKER_FILE_NAME);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    writeFileSync(descriptor, USER_STATE_MARKER_BYTES, "utf8");
    fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Synchronous twin used only by the synchronous update-cache lease authority. */
export function ensureUserStateRootSync(home: string = homedir()): string {
  const packageName = staticBuildIdentity().package.name;
  const root = userStateDirForPackage(home, packageName);
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) {
    try {
      mkdirSync(root, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    ensureRealDirectorySync(root);
    chmodSync(root, DIR_MODE);
    return root;
  }

  const parent = dirname(root);
  try {
    mkdirSync(parent, { mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  ensureRealDirectorySync(parent);
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
      writeMarkerExclusiveSync(root);
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
  chmodSync(root, DIR_MODE);
  return root;
}

/** One write entry point for every persistent private Superbee record. */
export async function writeUserStateFileAtomic0600(
  home: string,
  dir: string,
  fileName: string,
  content: string,
  options: { beforeCommit?: () => boolean | Promise<boolean> } = {},
): Promise<void> {
  await ensureUserStateRoot(home);
  await writeFileAtomic0600(dir, fileName, content, options);
}

/** Marker read used by setup inspection; it does not create or repair anything. */
export async function inspectCanonicalUserStateRoot(home: string = homedir()): Promise<"absent" | "ready" | "conflict"> {
  const root = canonicalUserStateDir(home);
  try {
    await assertRealDirectory(root);
    const status = await lstat(root);
    const currentUid = process.getuid?.();
    if ((status.mode & 0o077) !== 0 || (currentUid !== undefined && status.uid !== currentUid)) return "conflict";
  } catch (error) {
    return errno(error) === "ENOENT" ? "absent" : "conflict";
  }
  return await hasExactUserStateMarker(root) ? "ready" : "conflict";
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

/** Read one record only after the running package's root proves its exact ownership boundary. */
export async function readUserStateFile(
  home: string,
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const packageName = staticBuildIdentity().package.name;
  const root = userStateDirForPackage(home, packageName);
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
    const state = await inspectCanonicalUserStateRoot(home);
    if (state === "absent") throw missingStateError(file);
    if (state === "conflict") throw new Error("canonical Superbee user-state root is not owned by this product");
  }
  return readPrivateStateFile(file, maxBytes, signal);
}

export function inspectUserStateRootSync(home: string = homedir()): "absent" | "ready" | "conflict" {
  const packageName = staticBuildIdentity().package.name;
  const root = userStateDirForPackage(home, packageName);
  try {
    ensureRealDirectorySync(root);
    const rootStatus = lstatSync(root);
    const currentUid = process.getuid?.();
    if ((rootStatus.mode & 0o077) !== 0 || (currentUid !== undefined && rootStatus.uid !== currentUid)) return "conflict";
  } catch (error) {
    return errno(error) === "ENOENT" ? "absent" : "conflict";
  }
  if (packageName === LEGACY_BRIDGE_PACKAGE_NAME) return "ready";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      join(root, USER_STATE_MARKER_FILE_NAME),
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const status = lstatSync(join(root, USER_STATE_MARKER_FILE_NAME));
    const currentUid = process.getuid?.();
    if (
      status.isSymbolicLink()
      || !status.isFile()
      || status.size > MARKER_MAX_BYTES
      || (status.mode & 0o077) !== 0
      || (currentUid !== undefined && status.uid !== currentUid)
    ) return "conflict";
    return readFileSync(descriptor, "utf8") === USER_STATE_MARKER_BYTES ? "ready" : "conflict";
  } catch {
    return "conflict";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Test/migration-only helper: read the exact marker bytes without a broad directory walk. */
export async function readUserStateMarker(home: string = homedir()): Promise<string | null> {
  try {
    return await readFile(join(canonicalUserStateDir(home), USER_STATE_MARKER_FILE_NAME), "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}
