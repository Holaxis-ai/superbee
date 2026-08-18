// One authority for private, user-scoped CLI state. The Superbee successor owns ~/.superbee;
// the separately published Aslite bridge retains ~/.agentstate. Successor readers may consult the
// legacy root one exact record at a time, but every successor write lands under ~/.superbee.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { staticBuildIdentity } from "./build-identity.js";

export const USER_STATE_DIR_NAME = ".superbee";
export const LEGACY_USER_STATE_DIR_NAME = ".agentstate";
export const LEGACY_BRIDGE_PACKAGE_NAME = "@holaxis/aslite";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function userStateDirForPackage(home: string, packageName: string): string {
  return join(home, packageName === LEGACY_BRIDGE_PACKAGE_NAME ? LEGACY_USER_STATE_DIR_NAME : USER_STATE_DIR_NAME);
}

export function userStateDir(home: string = homedir()): string {
  return userStateDirForPackage(home, staticBuildIdentity().package.name);
}

export function legacyUserStateDir(home: string = homedir()): string {
  return join(home, LEGACY_USER_STATE_DIR_NAME);
}

export interface UserStateText {
  content: string;
  path: string;
  source: "canonical" | "legacy";
}

export async function readPrivateStateFile(file: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`private user-state record is not a regular file: ${file}`);
    return await handle.readFile({ encoding: "utf8", signal });
  } finally {
    await handle.close();
  }
}

/** Canonical wins. Only canonical absence permits a read-only fallback to the exact legacy file. */
export async function readUserStateText(
  canonicalPath: string,
  legacyPath: string,
  signal?: AbortSignal,
): Promise<UserStateText | null> {
  try {
    return { content: await readPrivateStateFile(canonicalPath, signal), path: canonicalPath, source: "canonical" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (legacyPath === canonicalPath) return null;
  try {
    return { content: await readPrivateStateFile(legacyPath, signal), path: legacyPath, source: "legacy" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ensurePrivateUserStateDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const status = await lstat(dir);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`private user-state path is not a real directory: ${dir}`);
  }
  await chmod(dir, DIR_MODE);
}

/** Atomic 0600 write inside an exact 0700 private directory. */
export async function writeFileAtomic0600(
  dir: string,
  fileName: string,
  content: string,
  options: {
    beforeCommit?: () => boolean | Promise<boolean>;
    /** Product-state root to validate before creating a nested store directory. */
    rootDir?: string;
  } = {},
): Promise<void> {
  if (options.rootDir) await ensurePrivateUserStateDirectory(options.rootDir);
  if (dir !== options.rootDir) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await ensurePrivateUserStateDirectory(dir);
  }

  const path = join(dir, fileName);
  const tmpPath = join(dir, `.${fileName}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(tmpPath, "wx", FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.chmod(FILE_MODE);
  } finally {
    await handle.close();
  }
  try {
    if (options.beforeCommit && !(await options.beforeCommit())) {
      throw new Error("atomic write commit authority was withdrawn");
    }
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
