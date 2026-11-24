import { stat } from "node:fs/promises";

export interface FolderIdentity {
  readonly dev: number;
  readonly ino: number;
  /** Birth time in milliseconds; absent or 0 where the filesystem does not report one. */
  readonly birth?: number;
}

/** Compare the physical folder, allowing hosts that do not expose its birth time. */
export function sameFolder(a: FolderIdentity, b: FolderIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && (!a.birth || !b.birth || a.birth === b.birth);
}

/** The identity a folder has now, or null when nothing is there. */
export async function folderIdentity(folder: string): Promise<FolderIdentity | null> {
  try {
    const info = await stat(folder);
    return info.isDirectory()
      ? { dev: info.dev, ino: info.ino, ...(info.birthtimeMs > 0 ? { birth: info.birthtimeMs } : {}) }
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
