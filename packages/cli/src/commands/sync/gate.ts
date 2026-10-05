// The sync gate: a command a Git board's clone declares, which sync runs on the converged tree
// after rebasing onto the remote board and before every push. A non-zero exit holds the push
// with the work committed locally. The command comes from Git configuration, never from the
// board's own files: a teammate's pushed content must not be able to choose the command every
// syncing machine executes, just as it cannot install a Git hook. (A command that runs a script
// stored in the board still runs that script's current, pulled content; the docs say so.)
import { spawnSync } from "node:child_process";
import { boardBranchOf, countUncommitted, currentHead, resolveOriginRef, runGit } from "@superbee/board-git";

/** The Git configuration key that declares the gate command (any scope; `""` declares none). */
export const SYNC_GATE_CONFIG = "superbee.syncGate";
/** Optional timeout override, in whole seconds. */
export const SYNC_GATE_TIMEOUT_CONFIG = "superbee.syncGateTimeoutSeconds";
export const DEFAULT_SYNC_GATE_TIMEOUT_SECONDS = 600;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

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
 * Run the gate once against the board's current HEAD. The gate's working directory is the board
 * root, and it is told which commits it judges through the environment:
 *
 *   SUPERBEE_SYNC_GATE=1, SUPERBEE_BOARD_PATH, SUPERBEE_BOARD_BRANCH,
 *   SUPERBEE_BOARD_UPSTREAM_REF (`origin/<branch>`), SUPERBEE_BOARD_UPSTREAM_SHA (the remote tip
 *   this tree was rebased onto; empty if none), SUPERBEE_BOARD_HEAD_SHA (what would be pushed),
 *   SUPERBEE_SYNC_ATTEMPT (1 on the first push attempt, higher after a lost push race).
 *
 * Its output never reaches sync's stdout (that carries the receipt); a failure keeps the last
 * lines for the envelope. A gate that commits or edits the board fails: what was judged must be
 * exactly what is pushed.
 */
export function runSyncGate(boardPath: string, gate: SyncGate, attempt: number): SyncGateRun {
  const head = currentHead(boardPath);
  const branch = boardBranchOf(boardPath);
  const upstreamSha = resolveOriginRef(boardPath) ?? "";
  const base: Record<string, unknown> = {
    command: gate.command,
    attempt,
    head,
    upstream: `origin/${branch}`,
    ...(upstreamSha ? { upstream_sha: upstreamSha } : {}),
  };
  const result = spawnSync(gate.command, {
    cwd: boardPath,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: gate.timeoutSeconds * 1000,
    maxBuffer: OUTPUT_MAX_BYTES,
    env: {
      ...gateBaseEnv(),
      SUPERBEE_SYNC_GATE: "1",
      SUPERBEE_BOARD_PATH: boardPath,
      SUPERBEE_BOARD_BRANCH: branch,
      SUPERBEE_BOARD_UPSTREAM_REF: `origin/${branch}`,
      SUPERBEE_BOARD_UPSTREAM_SHA: upstreamSha,
      SUPERBEE_BOARD_HEAD_SHA: head,
      SUPERBEE_SYNC_ATTEMPT: String(attempt),
    },
  });
  const tail = outputTail(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const failed = (reason: string, extra: Record<string, unknown>): SyncGateRun => ({
    passed: false,
    reason,
    details: { ...base, ...extra, ...(tail ? { output_tail: tail } : {}) },
  });

  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") {
    return failed(`timed out after ${gate.timeoutSeconds}s`, { timed_out: true, timeout_seconds: gate.timeoutSeconds });
  }
  if (error) return failed(`could not run (${error.code ?? error.message})`, { spawn_error: error.code ?? error.message });
  if (result.signal) return failed(`was killed by ${result.signal}`, { signal: result.signal });
  if (result.status !== 0) return failed(`exited ${result.status}`, { exit_status: result.status });

  if (runGit(boardPath, ["rev-parse", "HEAD"]).stdout.trim() !== head || countUncommitted(boardPath) > 0) {
    return failed("changed the board (a gate must only inspect it)", { modified_board: true });
  }
  return { passed: true, details: { ...base, exit_status: 0 } };
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
