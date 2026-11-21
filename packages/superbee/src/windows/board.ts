import { win32 as paths } from 'node:path';
import type { BoardHostPolicy } from '@superbee/cli';

/** Call only after the owning code has obtained physical path evidence. */
export function sameResolvedPath(left: string, right: string): boolean {
  return paths.resolve(left).toLowerCase() === paths.resolve(right).toLowerCase();
}

export const windowsBoardHostPolicy: BoardHostPolicy = Object.freeze({
  sameResolvedPath,
  moveAsideHelp: (boardPath: string, note: string) =>
    `Rename "${boardPath}" to "${paths.basename(boardPath)}.bak" in File Explorer, ${note}.`,
});
