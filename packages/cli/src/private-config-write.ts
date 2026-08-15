import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * A symlinked destination (for example, a dotfile-managed settings file) is written through,
 * rather than replaced. Generated files whose ownership is the literal directory entry can opt
 * out. Dangling links are always refused.
 */
function resolveWriteDestination(path: string, followFinalSymlink: boolean): string {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return path;
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
  options: { followFinalSymlink?: boolean } = {},
): void {
  const destination = resolveWriteDestination(path, options.followFinalSymlink ?? true);
  mkdirSync(dirname(destination), { recursive: true });
  const mode = existsSync(destination) ? statSync(destination).mode & 0o7777 : undefined;
  const tmp = `${destination}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, destination);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
