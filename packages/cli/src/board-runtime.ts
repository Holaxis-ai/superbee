import * as board from "@superbee/board-git";
import { currentBoardHost } from "./runtime-context.js";
export function worktreeRootResolves(path: string): boolean {
  return board.worktreeRootResolves(path, currentBoardHost());
}
export function worktreeRootResolvesForOwner(
  path: string,
  owner: string,
): boolean {
  return board.worktreeRootResolvesForOwner(path, owner, currentBoardHost());
}
export function isProvisioned(path: string): boolean {
  return board.isProvisioned(path, currentBoardHost());
}
export function resolveProvisionedBoardPath(path: string): string | null {
  return board.resolveProvisionedBoardPath(path, currentBoardHost());
}
export function existingDirRefusal(
  ...args: Parameters<typeof board.existingDirRefusal>
): ReturnType<typeof board.existingDirRefusal> {
  return board.existingDirRefusal(
    args[0],
    args[1],
    args[2],
    currentBoardHost(),
  );
}
export function provisionBoardWorktree(
  ...args: Parameters<typeof board.provisionBoardWorktree>
): ReturnType<typeof board.provisionBoardWorktree> {
  return board.provisionBoardWorktree(args[0], args[1], currentBoardHost());
}
export function detectBoardChannel(
  ...args: Parameters<typeof board.detectBoardChannel>
): ReturnType<typeof board.detectBoardChannel> {
  return board.detectBoardChannel(args[0], {
    ...args[1],
    hostPolicy: currentBoardHost(),
  });
}
