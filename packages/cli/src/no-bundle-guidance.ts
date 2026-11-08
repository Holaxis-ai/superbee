// The one owner of "no bundle here" guidance. Home, session-start, status and every command that
// discovers a bundle (list, doc read, doc write, ...) give the same next step: a shared board's own
// first-contact line when this checkout has one, else setup's project-folder choice. Setup refuses
// the home folder as a project, so this guidance never offers it either.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { cliInvocation } from "./invocation.js";
import { commandToken, type CommandPrefix } from "./command-text.js";

/** Physical path when it exists, so a symlink to home is still recognized as home. */
function physical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** True when `dir` is home, a folder above home, or a filesystem root. */
export function unsafeProjectDir(dir: string, home: string): boolean {
  const target = physical(dir);
  if (path.parse(target).root === target) return true;
  for (let cursor = physical(home); ; cursor = path.dirname(cursor)) {
    if (cursor === target) return true;
    if (path.dirname(cursor) === cursor) return false;
  }
}

/**
 * Setup's project-folder choice, worded as setup words it. `dir` is the folder the caller is
 * looking from (relative to the cwd, "." for the cwd itself); it is offered as a choice only when
 * setup would accept it.
 */
export function setupProjectChoice(dir: string, inv: CommandPrefix, home: string = homedir()): string {
  const setup = `${inv} setup`;
  const later = `\`${setup} --no-project\` to set this up later`;
  if (unsafeProjectDir(path.resolve(dir), home)) {
    return `This is your home folder, a folder above it, or a filesystem root, so it cannot hold a project's notes. ` +
      `Pick a folder for this project's notes: \`${setup} --project <dir>\`, or ${later}`;
  }
  return `Pick a folder for this project's notes: \`${setup} --project ${commandToken(dir)}\` for this folder, ` +
    `\`${setup} --project <dir>\` for another, or ${later}`;
}

/** True when `dir` or a folder above it has a `.git` entry; a filesystem check with no Git spawn. */
function insideGitCheckout(dir: string): boolean {
  for (let cursor = dir; ; cursor = path.dirname(cursor)) {
    if (existsSync(path.join(cursor, ".git"))) return true;
    if (path.dirname(cursor) === cursor) return false;
  }
}

/**
 * The next step when discovery from `startDir` finds no bundle. A checkout that shares a board
 * gets the board's first-contact line (sync or session-start, never a divergent second bundle);
 * anything else gets setup's project-folder choice. Board detection reads local Git only.
 */
export async function noBundleNextStep(startDir: string): Promise<string> {
  const inv = cliInvocation();
  const resolved = path.resolve(startDir);
  const atCwd = resolved === process.cwd();
  // Commands also probe discovery and discard the error, so outside a checkout this spawns nothing.
  if (insideGitCheckout(resolved)) {
    try {
      const { buildBoardBlock, defaultLoadBoardStatus } = await import("./commands/home.js");
      const status = await defaultLoadBoardStatus(resolved);
      const firstContact = buildBoardBlock(status, undefined, inv, atCwd ? undefined : resolved).firstContact;
      if (firstContact) return firstContact;
    } catch {
      // Board detection is advisory here; the project-folder choice is always a safe next step.
    }
  }
  return setupProjectChoice(atCwd ? "." : resolved, inv);
}
