import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteFileOptions {
  readonly followFinalSymlink?: boolean;
  /**
   * Optional compare-and-swap guard for a previously inspected file. `destination` is the
   * inspected real path, or null when the entry was absent. The write refuses path retargeting or
   * byte drift instead of overwriting a newer/foreign host configuration.
   */
  readonly expected?: {
    readonly destination: string | null;
    readonly content: string | Uint8Array | null;
  };
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * A symlinked destination (for example, a dotfile-managed settings file) is written through,
 * rather than replaced. Generated files whose ownership is the literal directory entry can opt
 * out. Dangling links are always refused.
 */
function resolveWriteDestination(path: string, followFinalSymlink: boolean): string {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (missing(error)) return path;
    throw error;
  }
  if (!isLink) return path;
  if (!followFinalSymlink) {
    throw new Error(`symlink at ${path} — refusing to replace a generated plugin through a link`);
  }
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`dangling symlink at ${path} — refusing to write through it; fix or remove the link`);
  }
}

/**
 * Replace a private configuration file through a same-directory temporary file and rename.
 * Existing modes are preserved, final symlinks are followed by default, and temporary files are
 * removed after any write or rename failure.
 */
export function atomicWriteFileSync(
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteFileOptions = {},
): void {
  const destination = resolveWriteDestination(path, options.followFinalSymlink ?? true);
  if (options.expected) {
    let currentDestination: string | null;
    try {
      currentDestination = realpathSync(path);
    } catch (error) {
      if (!missing(error)) throw error;
      currentDestination = null;
    }
    if (currentDestination !== options.expected.destination) {
      throw new Error("private configuration destination changed after inspection");
    }
    if (options.expected.content === null) {
      if (currentDestination !== null) {
        throw new Error("private configuration appeared after inspection");
      }
    } else {
      if (currentDestination === null) {
        throw new Error("private configuration disappeared after inspection");
      }
      const expected = Buffer.from(options.expected.content);
      const current = readFileSync(currentDestination);
      if (!current.equals(expected)) {
        throw new Error("private configuration changed after inspection");
      }
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  let mode: number | undefined;
  try {
    mode = statSync(destination).mode & 0o7777;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const tmp = `${destination}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o600 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, destination);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
