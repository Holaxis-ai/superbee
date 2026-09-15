import { BoardGitError } from "./errors.js";

/** Host spelling and guidance only; physical/Git ownership evidence remains with board-git. */
export interface BoardHostPolicy {
  readonly sameResolvedPath: (left: string, right: string) => boolean;
  readonly moveAsideHelp: (boardPath: string, note: string) => string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function defaultBoardHostPolicy(): BoardHostPolicy {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new BoardGitError("CONFLICT", "This host requires an explicit board host policy; the default supports macOS and Linux.");
  }
  return {
    sameResolvedPath: (left, right) => left === right,
    moveAsideHelp: (boardPath, note) => `mv ${shellQuote(boardPath)} ${shellQuote(`${boardPath}.bak`)}  # ${note}`,
  };
}

/** Preserve member identity and method receivers without freezing the caller's object. */
export function captureBoardHostPolicy(policy?: BoardHostPolicy): BoardHostPolicy {
  const selected = policy ?? defaultBoardHostPolicy();
  return Object.freeze({
    sameResolvedPath: selected.sameResolvedPath.bind(selected),
    moveAsideHelp: selected.moveAsideHelp.bind(selected),
  });
}
