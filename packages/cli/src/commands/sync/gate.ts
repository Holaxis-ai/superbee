// The sync gate: a command a Git board's clone declares, which sync runs on the converged tree
// after rebasing onto the remote board and before every push. A non-zero exit holds the push
// with the work committed locally. The command comes from Git configuration, never from the
// board's own files: a teammate's pushed content must not be able to choose the command every
// syncing machine executes, just as it cannot install a Git hook. (A command that runs a script
// stored in the board still runs that script's current, pulled content; the docs say so.)
import { spawn } from "node:child_process";
import { countUncommitted, currentHead, resolveOriginRef, runGit } from "@superbee/board-git";

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

/** The declared gate for the checkout at `boardPath`, or null when none is declared. */
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
  const result = await runInOwnGroup(gate.command, boardPath, gate.timeoutSeconds * 1000, {
    ...gateBaseEnv(),
    SUPERBEE_SYNC_GATE: "1",
    SUPERBEE_BOARD_PATH: boardPath,
    SUPERBEE_BOARD_BRANCH: branch,
    SUPERBEE_BOARD_UPSTREAM_REF: `origin/${branch}`,
    SUPERBEE_BOARD_UPSTREAM_SHA: upstreamSha,
    SUPERBEE_BOARD_HEAD_SHA: head,
    SUPERBEE_SYNC_ATTEMPT: String(attempt),
  });
  const tail = outputTail(result.output);
  const failed = (reason: string, extra: Record<string, unknown>): SyncGateRun => ({
    passed: false,
    reason,
    details: { ...base, ...extra, ...(tail ? { output_tail: tail } : {}) },
  });

  if (result.timedOut) {
    return failed(`timed out after ${gate.timeoutSeconds}s`, { timed_out: true, timeout_seconds: gate.timeoutSeconds });
  }
  if (result.spawnError) return failed(`could not run (${result.spawnError})`, { spawn_error: result.spawnError });
  if (result.signal) return failed(`was killed by ${result.signal}`, { signal: result.signal });
  if (result.status !== 0) return failed(`exited ${result.status}`, { exit_status: result.status });

  const attached = runGit(boardPath, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (
    runGit(boardPath, ["rev-parse", "HEAD"]).stdout.trim() !== head ||
    attached.status !== 0 || attached.stdout.trim() !== branch ||
    countUncommitted(boardPath) > 0
  ) {
    return failed("changed the board (a gate must only inspect it)", { modified_board: true });
  }
  return { passed: true, details: { ...base, exit_status: 0 } };
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
