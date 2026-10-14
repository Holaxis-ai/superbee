// The sync gate: a command a Git board's clone or a hosted checkout declares, which sync runs on
// the converged tree (after rebasing onto the remote board, or after pulling the host's changes)
// and before anything is sent. A non-zero exit holds the send with the work kept locally. The
// command comes from Git configuration, never from the board's own files or from the host: a
// teammate's pushed content or a host's answer must not be able to choose the command every
// syncing machine executes, just as it cannot install a Git hook. (A command that runs a script
// stored in the board still runs that script's current, pulled content; the docs say so.)
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { countUncommitted, isBoardGitError, currentHead, resolveOriginRef, runGit } from "@superbee/board-git";

/** The Git configuration key that declares the gate command (any scope; `""` declares none). */
export const SYNC_GATE_CONFIG = "superbee.syncGate";
/** Optional timeout override, in whole seconds. */
export const SYNC_GATE_TIMEOUT_CONFIG = "superbee.syncGateTimeoutSeconds";
export const DEFAULT_SYNC_GATE_TIMEOUT_SECONDS = 600;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_MAX_CHARS = 256 * 1024;

export interface SyncGate {
  command: string;
  timeoutSeconds: number;
}

/**
 * The declared gate for the checkout at `boardPath`, or null when none is declared. A hosted
 * checkout reads the same key from Git configuration as seen from its folder (the system and
 * global scopes, and the repository that contains the folder, if any). Sync writes only `.md`
 * documents and dot-prefixed temporary files into a hosted checkout, never a `.git/config` file,
 * so a host cannot declare a gate there.
 */
export function declaredSyncGate(boardPath: string): SyncGate | null {
  const configured = runGit(boardPath, ["config", "--get", SYNC_GATE_CONFIG]);
  const command = configured.status === 0 ? configured.stdout.trim() : "";
  if (command === "") return null;
  const timeout = runGit(boardPath, ["config", "--get", SYNC_GATE_TIMEOUT_CONFIG]);
  const raw = timeout.status === 0 ? timeout.stdout.trim() : "";
  const seconds = /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_SYNC_GATE_TIMEOUT_SECONDS;
  return { command, timeoutSeconds: seconds };
}

export interface SyncGateRun {
  passed: boolean;
  /** The structured facts a receipt or error envelope carries. */
  details: Record<string, unknown>;
  /** A one-line description of a failure, for the warning. */
  reason?: string;
}

/**
 * Run the gate once against the board's current HEAD on `branch` (the board branch the caller
 * resolved and will push). The gate's working directory is the board root, and it is told which
 * commits it judges through the environment:
 *
 *   SUPERBEE_SYNC_GATE=1, SUPERBEE_BOARD_PATH, SUPERBEE_BOARD_BRANCH,
 *   SUPERBEE_BOARD_UPSTREAM_REF (`origin/<branch>`), SUPERBEE_BOARD_UPSTREAM_SHA (the remote tip
 *   this tree was rebased onto; empty if none), SUPERBEE_BOARD_HEAD_SHA (what would be pushed),
 *   SUPERBEE_SYNC_ATTEMPT (1 on the first push attempt, higher after a lost push race).
 *
 * Its output never reaches sync's stdout (that carries the receipt); a failure keeps the last
 * lines for the envelope. The gate runs in its own process group, and the whole group is killed
 * when it exits or times out, so nothing it started can touch the board afterwards. A gate that
 * commits, edits the board, or moves HEAD off the branch fails: what was judged must be exactly
 * what is pushed, and where.
 */
export async function runSyncGate(boardPath: string, branch: string, gate: SyncGate, attempt: number): Promise<SyncGateRun> {
  const head = currentHead(boardPath);
  const upstreamSha = resolveOriginRef(boardPath) ?? "";
  const base: Record<string, unknown> = {
    command: gate.command,
    attempt,
    head,
    upstream: `origin/${branch}`,
    ...(upstreamSha ? { upstream_sha: upstreamSha } : {}),
  };
  const { ran, failed } = await runGateCommand(gate, boardPath, base, {
    SUPERBEE_SYNC_GATE: "1",
    SUPERBEE_BOARD_PATH: boardPath,
    SUPERBEE_BOARD_BRANCH: branch,
    SUPERBEE_BOARD_UPSTREAM_REF: `origin/${branch}`,
    SUPERBEE_BOARD_UPSTREAM_SHA: upstreamSha,
    SUPERBEE_BOARD_HEAD_SHA: head,
    SUPERBEE_SYNC_ATTEMPT: String(attempt),
  });
  if (!ran.passed) return ran;

  const attached = runGit(boardPath, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (
    runGit(boardPath, ["rev-parse", "HEAD"]).stdout.trim() !== head ||
    attached.status !== 0 || attached.stdout.trim() !== branch ||
    countUncommitted(boardPath) > 0
  ) {
    return failed("changed the board (a gate must only inspect it)", { modified_board: true });
  }
  return ran;
}

/** The facts a hosted checkout's sync hands its gate. */
export interface HostedGateContext {
  folder: string;
  origin: string;
  bundleId: string;
}

/**
 * Run the gate once on a hosted checkout's folder, after the pull placed the host's changes and
 * before anything is sent. Its working directory is the checkout folder, and it is told what it
 * judges through the environment:
 *
 *   SUPERBEE_SYNC_GATE=1, SUPERBEE_SYNC_HOME=hosted, SUPERBEE_BOARD_PATH (the checkout folder),
 *   SUPERBEE_HOSTED_ORIGIN, SUPERBEE_HOSTED_BUNDLE_ID, SUPERBEE_SYNC_ATTEMPT (always 1).
 *
 * A gate that creates, edits, or removes anything in the folder fails: the files judged must be
 * the files sent.
 */
export async function runHostedSyncGate(context: HostedGateContext, gate: SyncGate): Promise<SyncGateRun> {
  const base: Record<string, unknown> = { command: gate.command, attempt: 1, folder: context.folder };
  const before = await folderFingerprint(context.folder);
  const { ran, failed } = await runGateCommand(gate, context.folder, base, {
    SUPERBEE_SYNC_GATE: "1",
    SUPERBEE_SYNC_HOME: "hosted",
    SUPERBEE_BOARD_PATH: context.folder,
    SUPERBEE_HOSTED_ORIGIN: context.origin,
    SUPERBEE_HOSTED_BUNDLE_ID: context.bundleId,
    SUPERBEE_SYNC_ATTEMPT: "1",
  });
  if (!ran.passed) return ran;
  if ((await folderFingerprint(context.folder)) !== before) {
    return failed("changed the checkout (a gate must only inspect it)", { modified_board: true });
  }
  return ran;
}

/**
 * The declared gate for a hosted checkout's folder. Git itself is optional for a hosted
 * checkout: with no git installed, nothing can declare a gate.
 */
export function declaredHostedSyncGate(folder: string): SyncGate | null {
  try {
    return declaredSyncGate(folder);
  } catch (error) {
    if (isBoardGitError(error) && error.code === "GIT_MISSING") return null;
    throw error;
  }
}

interface GateCommandRun {
  /** The classified exit; `passed` means it exited 0 within its time. */
  ran: SyncGateRun;
  /** A failure carrying the run's facts and output tail, for a check made after it exited. */
  failed: (reason: string, extra: Record<string, unknown>) => SyncGateRun;
}

async function runGateCommand(gate: SyncGate, cwd: string, base: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<GateCommandRun> {
  const result = await runInOwnGroup(gate.command, cwd, gate.timeoutSeconds * 1000, { ...gateBaseEnv(), ...env });
  const tail = outputTail(result.output);
  const failed = (reason: string, extra: Record<string, unknown>): SyncGateRun => ({
    passed: false,
    reason,
    details: { ...base, ...extra, ...(tail ? { output_tail: tail } : {}) },
  });
  const classified = (): SyncGateRun => {
    if (result.timedOut) {
      return failed(`timed out after ${gate.timeoutSeconds}s`, { timed_out: true, timeout_seconds: gate.timeoutSeconds });
    }
    if (result.spawnError) return failed(`could not run (${result.spawnError})`, { spawn_error: result.spawnError });
    if (result.signal) return failed(`was killed by ${result.signal}`, { signal: result.signal });
    if (result.status !== 0) return failed(`exited ${result.status}`, { exit_status: result.status });
    return { passed: true, details: { ...base, exit_status: 0 } };
  };
  return { ran: classified(), failed };
}

/** One digest of every entry under `folder`: its relative path, kind, and bytes or link target. */
async function folderFingerprint(folder: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(folder, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = path.join(folder, child);
      if (entry.isDirectory()) {
        hash.update(`d\0${child}\0`);
        await walk(child);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${child}\0${await fs.readlink(full)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${child}\0${createHash("sha256").update(await fs.readFile(full)).digest("hex")}\0`);
      } else {
        hash.update(`o\0${child}\0`);
      }
    }
  };
  await walk("");
  return hash.digest("hex");
}

interface GroupRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Run `command` through the shell as the leader of a new process group, capture its combined
 * output (bounded), and kill the whole group when the leader exits or the timeout fires.
 */
function runInOwnGroup(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<GroupRun> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    };
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_MAX_CHARS) output = output.slice(-OUTPUT_MAX_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (run: Omit<GroupRun, "output" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve({ ...run, output, timedOut });
    };
    child.on("error", (error: NodeJS.ErrnoException) => finish({ status: null, signal: null, spawnError: error.code ?? error.message }));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

/** The ambient environment minus Git's repository-selection variables, so the gate sees the board. */
function gateBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

function outputTail(output: string): string {
  const lines = output.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  return lines.slice(-OUTPUT_TAIL_LINES).join("\n");
}
