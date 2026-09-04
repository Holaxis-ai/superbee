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
// matching the ownership rule the skill and hook commands already state. `O_NOFOLLOW` does not
// exist on Windows, where the flag degrades to 0 and this is exactly the previous read.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** `missing`: nothing at the path. `unsafe`: a link, a non-regular leaf, or an unreadable one. */
export type NoFollowRead =
  | { state: "missing" }
  | { state: "unsafe" }
  | { state: "present"; bytes: Buffer };

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Reads a regular file's bytes, refusing a symlink at the leaf. Never throws for filesystem state. */
export function readRegularFileNoFollowSync(filePath: string): NoFollowRead {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, READ_FLAGS);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unsafe" };
  }
  try {
    if (!fstatSync(descriptor).isFile()) return { state: "unsafe" };
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
