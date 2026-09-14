// THE read for a leaf the CLI has just decided must be a regular file it owns — installed skill
// assets, generated host plugins, and anything else whose bytes decide ownership or trigger a
// destructive write.
//
// `lstatSync(p)` followed by `readFileSync(p)` names the path twice, and the second lookup is a
// different act from the first: between them the leaf can become a symlink to any file the user
// can read, so the check proves nothing about the bytes that arrive. This module closes the leaf
// over a descriptor instead — `O_NOFOLLOW` refuses a link AT the leaf, and the read comes from the
// descriptor rather than from a second path lookup, so the bytes are the file that was verified.
//
// Ancestor symlinks stay honored (a stowed `~/.claude` is legitimate); the guard is leaf-only,
// matching the ownership rule the skill and hook commands already state. Where `O_NOFOLLOW` does
// not exist (Windows), the flag alone would silently stop rejecting links, so the read falls back
// to `lstat` plus a `dev`/`ino` comparison against the descriptor — a read-only subset of the
// discipline `update-orientation.ts` and `user-state.ts` keep for their read-modify-write cycles,
// which also re-check identity after the read because they go on to write. That fallback narrows
// the window rather than closing it: the identity check happens after the open, so it detects a
// swap instead of preventing one.
//
// Those two sites still own their own copy; this module owns the leaf reads whose contents settle
// ownership or trigger a destructive write, and absorbing the other two is a separate unit.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

/** `missing`: nothing at the path. `unsafe`: a link, a non-regular leaf, or an unreadable one. */
export type NoFollowRead =
  | { state: "missing" }
  | { state: "unsafe" }
  | { state: "present"; bytes: Buffer };

// `O_NONBLOCK` is load-bearing, not tidiness: opening a FIFO for reading blocks until a writer
// appears, so a leaf swapped for a pipe would hang the CLI forever, before `isFile()` ever runs.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const HAS_NOFOLLOW = (constants.O_NOFOLLOW ?? 0) !== 0;

/** The pre-open leaf identity the fallback compares against; `null` means "refuse". */
function leafIdentity(filePath: string): { dev: number; ino: number } | "missing" | null {
  try {
    const leaf = lstatSync(filePath);
    if (!leaf.isFile()) return null;
    return { dev: leaf.dev, ino: leaf.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
}

/** Reads a regular file's bytes, refusing a symlink at the leaf. Never throws for filesystem state. */
export function readRegularFileNoFollowSync(filePath: string): NoFollowRead {
  return readLeafSync(filePath, READ_FLAGS, HAS_NOFOLLOW);
}

/**
 * The read itself, with the platform's two facts passed in. Exported only so a POSIX runner can
 * exercise the degraded path a Windows host takes; callers use {@link readRegularFileNoFollowSync}.
 * Passing `hasNoFollow: true` with flags that lack `O_NOFOLLOW` disables the guard, which is why
 * this is a test seam and not an API.
 *
 * @internal
 */
export function readLeafSync(filePath: string, flags: number, hasNoFollow: boolean): NoFollowRead {
  let expected: { dev: number; ino: number } | null = null;
  if (!hasNoFollow) {
    const identity = leafIdentity(filePath);
    if (identity === null) return { state: "unsafe" };
    if (identity === "missing") return { state: "missing" };
    expected = identity;
  }
  let descriptor: number;
  try {
    descriptor = openSync(filePath, flags);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unsafe" };
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return { state: "unsafe" };
    if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) return { state: "unsafe" };
    return { state: "present", bytes: readFileSync(descriptor) };
  } catch {
    return { state: "unsafe" };
  } finally {
    closeSync(descriptor);
  }
}

/** UTF-8 text form of {@link readRegularFileNoFollowSync}; undecodable bytes are not `present`. */
export function readRegularFileTextNoFollowSync(
  filePath: string,
): { state: "missing" } | { state: "unsafe" } | { state: "present"; text: string } {
  const read = readRegularFileNoFollowSync(filePath);
  if (read.state !== "present") return read;
  return { state: "present", text: read.bytes.toString("utf8") };
}
