// The moved-board marker: `.superbee-moved-to-hosted.json` at the root of a Git board's `board` branch, written
// by `publish --to hosted` when it moves the board. It travels to every teammate with their next
// pull, and from then on `sync` (and the turn-end hook, which runs it) refuses to push to the board
// and names the hosted checkout instead. The bundle walk skips dot-entries, so the marker is never a
// document. It is a root file, not under `.superbee/`: a committed `.superbee/` folder is how sync
// recognizes an in-tree bundle, and a teammate's clone of the branch would read as two boards.
//
// Writing it is two steps around the folder's conversion: the marker is committed while the folder
// is still the board's worktree (`commitMovedMarker`), and pushed from the project once the folder
// is a hosted checkout (`pushMovedMarker`), so a failed push never leaves the folder half converted.
// A board with no `origin/board` has no teammates to stop: nothing is committed.
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isBoardGitError, push, resolveOriginRef, runGit } from "@superbee/board-git";

import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";

export const MOVED_MARKER_FILE = ".superbee-moved-to-hosted.json";
export const MOVED_MARKER_SCHEMA = 1;
const MOVED_MARKER_BYTES = 4 * 1024;

export interface MovedMarker {
  /** The host the board moved to, as `--host` takes it. */
  readonly host: string;
  /** The hosted bundle, as `checkout` takes it: `<workspace-slug>/<bundle-id>` or the bare id. */
  readonly bundle: string;
  readonly moved_at: string;
  /** Who moved it (their hosted email, else principal id), for teammates to ask for access. */
  readonly moved_by?: string;
}

export function movedMarkerPath(root: string): string {
  return path.join(root, MOVED_MARKER_FILE);
}

const safe = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** At most `max + 1` bytes of a regular file (never following a link), or null when there is none. */
function readBounded(file: string, max: number): Buffer | "unreadable" | null {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
  if (!info.isFile()) return "unreadable";
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) read = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.subarray(0, length);
  } catch {
    return "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The marker in this board folder, or null when there is none. A file that is there but does not
 * parse (or is not a regular file, or is too large) still marks the board as moved (it can only
 * come from a publish or a person): the refusal then names no checkout. */
export function readMovedMarker(root: string): MovedMarker | { readonly unreadable: true } | null {
  const bytes = readBounded(movedMarkerPath(root), MOVED_MARKER_BYTES);
  if (bytes === null) return null;
  if (bytes === "unreadable" || bytes.byteLength > MOVED_MARKER_BYTES) return { unreadable: true };
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> | null;
    if (
      value?.superbee_moved_to_hosted === MOVED_MARKER_SCHEMA &&
      safe(value.host, 2048) &&
      safe(value.bundle, 300) &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.bundle) &&
      safe(value.moved_at, 64)
    )
      return { host: value.host, bundle: value.bundle, moved_at: value.moved_at, ...(safe(value.moved_by, 320) ? { moved_by: value.moved_by } : {}) };
  } catch {
    // Unreadable, below.
  }
  return { unreadable: true };
}

/** The refusal `sync` gives on a moved board: nothing is pushed, local work stays in the folder. */
export function movedBoardRefusal(
  root: string,
  marker: MovedMarker | { readonly unreadable: true },
  unpushed: { commits: number; uncommitted: number },
  options: { readonly markerUnpushed?: string } = {},
): CliError {
  const checkout = "unreadable" in marker ? null : commandFragment`${cliInvocation()} checkout ${commandToken(marker.bundle)} --host ${commandToken(marker.host)}`;
  const share =
    "unreadable" in marker ? null : commandFragment`${cliInvocation()} access grant ${commandToken(marker.bundle)} <your email> --level write --host ${commandToken(marker.host)}`;
  const who = "unreadable" in marker || marker.moved_by === undefined ? "whoever moved the board" : marker.moved_by;
  const local = unpushed.commits + unpushed.uncommitted > 0;
  return new CliError(
    "FORBIDDEN",
    `this Git board moved to hosted Superbee${"unreadable" in marker ? "" : ` ('${marker.bundle}' on ${marker.host})`}, so sync no longer pushes to it`,
    {
      details: {
        reason: "board_moved",
        board: root,
        ...("unreadable" in marker ? { marker: "unreadable" } : { host: marker.host, bundle: marker.bundle, moved_at: marker.moved_at, ...(marker.moved_by !== undefined ? { moved_by: marker.moved_by } : {}) }),
        unpushed_commits: unpushed.commits,
        uncommitted_files: unpushed.uncommitted,
        ...(local
          ? {
              local_work: `your ${unpushed.commits} unpushed commit(s) and ${unpushed.uncommitted} uncommitted file(s) stay in ${root}; after checking out the hosted bundle into a new folder, copy the documents you changed into it and run sync there`,
            }
          : {}),
        ...(options.markerUnpushed !== undefined
          ? {
              marker_unpushed: `the moved marker here never reached origin, so teammates are not stopped yet; push it: ${String(commandFragment`git -C ${commandToken(options.markerUnpushed)} push origin board`)}`,
            }
          : {}),
        moved_back: `if the board was moved back to Git (its marker commit reverted on origin), ${cliInvocation()} sync works again: it checks origin first`,
      },
      help: checkout
        ? `${String(checkout)} --dir <new folder>   (then use that folder; this one stays as it is); if checkout says not found, ask ${who} to share it: ${String(share)}`
        : `ask whoever moved the board for the hosted bundle's checkout command (the marker at ${movedMarkerPath(root)} is unreadable)`,
    },
  );
}

/** The marker committed on the board branch (not yet pushed), or why it was not. */
export type MovedMarkerCommit =
  | { readonly state: "committed"; readonly project: string | null }
  | { readonly state: "no_shared_board" }
  | { readonly state: "failed"; readonly error: string };

/** The repository a board worktree belongs to: the folder holding its common Git dir, or null. */
function projectOf(boardTop: string): string | null {
  const common = runGit(boardTop, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0) return null;
  const dir = common.stdout.trim();
  return path.basename(dir) === ".git" ? path.dirname(dir) : dir;
}

/**
 * Commit the marker on the board branch in this worktree. Only the marker file is committed;
 * anything else uncommitted stays as it is. Only a board shared on origin (`origin/board`) gets
 * one: without it there is no teammate to stop. Never throws: the bundle is already created, so a
 * failure is reported (and the marker file removed again).
 */
export async function commitMovedMarker(boardTop: string, marker: MovedMarker): Promise<MovedMarkerCommit> {
  if (resolveOriginRef(boardTop) === null) return { state: "no_shared_board" };
  const relative = MOVED_MARKER_FILE;
  const file = movedMarkerPath(boardTop);
  const failed = async (error: string): Promise<MovedMarkerCommit> => {
    runGit(boardTop, ["reset", "-q", "--", relative]);
    await unlink(file).catch(() => {});
    return { state: "failed", error };
  };
  try {
    await writeFile(
      file,
      `${JSON.stringify({ superbee_moved_to_hosted: MOVED_MARKER_SCHEMA, ...marker, note: "This board moved to hosted Superbee. superbee sync no longer pushes here; check out the hosted bundle instead." }, null, 2)}\n`,
      "utf8",
    );
    const add = runGit(boardTop, ["add", "--force", "--", relative]);
    if (add.status !== 0) return await failed(add.stderr.trim() || "git add failed");
    const commit = runGit(boardTop, ["commit", "--no-verify", "-m", `Move this board to hosted Superbee (${marker.bundle})`, "--only", "--", relative]);
    if (commit.status !== 0) return await failed(commit.stderr.trim() || commit.stdout.trim() || "git commit failed");
  } catch (error) {
    return await failed((error as Error).message);
  }
  return { state: "committed", project: projectOf(boardTop) };
}

/** The marker pushed to origin, or why not: a teammate's push got there first, or another Git error. */
export type MovedMarkerPush = { readonly pushed: true } | { readonly pushed: false; readonly cause: "teammate_pushed" | "remote_rejected" | "git"; readonly error: string };

/** Push the board branch (the marker on top) from the project. Never throws. */
export function pushMovedMarker(project: string): MovedMarkerPush {
  try {
    push(project);
    return { pushed: true };
  } catch (error) {
    const reason = isBoardGitError(error) ? error.details?.reason : undefined;
    return { pushed: false, cause: reason === "non-fast-forward" ? "teammate_pushed" : reason === "remote-rejected" ? "remote_rejected" : "git", error: (error as Error).message };
  }
}

/** The receipt for a marker committed but not pushed: the cause, and the exact commands that finish it. */
export function movedMarkerPushFailed(project: string | null, failure: Extract<MovedMarkerPush, { pushed: false }>): { message: string; recovery: string[] } {
  const dir = project ?? "<project>";
  const tmp = `${dir}-board-marker`;
  const git = (where: string, args: CommandText) => String(commandFragment`git -C ${commandToken(where)} ${args}`);
  const finish = [
    git(dir, commandFragment`worktree add ${commandToken(tmp)} board`),
    git(tmp, commandFragment`pull --rebase origin board`),
    git(tmp, commandFragment`push origin board`),
    git(dir, commandFragment`worktree remove ${commandToken(tmp)}`),
  ];
  if (failure.cause === "teammate_pushed") {
    return {
      message:
        "committed the moved marker on the board branch, but the push was rejected: a teammate pushed to the board after your snapshot, so their commits are not in the hosted bundle. See them with the first two commands, copy what they changed into the hosted checkout and sync it, then put the marker on top of theirs with the rest, so teammates' syncs stop",
      recovery: [git(dir, commandFragment`fetch origin`), git(dir, commandFragment`log board..origin/board`), ...finish],
    };
  }
  if (failure.cause === "remote_rejected") {
    return {
      message:
        "committed the moved marker on the board branch, but origin refused the push (a branch protection rule or server hook on the board branch): lift the rule for a moment, push with the command below, then protect the branch again, so teammates' syncs stop",
      recovery: [git(dir, commandFragment`push origin board`)],
    };
  }
  return {
    message: `committed the moved marker on the board branch, but the push failed (${failure.error}): push it once Git can reach origin, so teammates' syncs stop`,
    recovery: [git(dir, commandFragment`push origin board`)],
  };
}
