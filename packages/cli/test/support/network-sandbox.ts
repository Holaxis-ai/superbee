// The built CLI under the deny-network preload, in an isolated HOME: the harness the zero-network
// suite (persona A: local and Git make no network call) and the multi-backend rehearsal share.
//
// `test/fixtures/deny-network.mjs` records and refuses every connection a child process tries
// (child Node processes inherit it through NODE_OPTIONS). A suite that serves a fake on loopback
// names its port in `allow`; the preload then admits that port and still logs each use of it.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUILT_CLI } from "./private-state-fixtures.js";
import { isolatedUserEnv } from "./user-env.js";

export { BUILT_CLI };

const here = path.dirname(fileURLToPath(import.meta.url));
export const DENY_NETWORK_PRELOAD = path.resolve(here, "../fixtures/deny-network.mjs");

/** Build the CLI once when a suite runs before the workspace build (a focused local run). */
export function ensureBuiltCli(): void {
  if (!existsSync(BUILT_CLI)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: path.resolve(path.dirname(BUILT_CLI), ".."), stdio: "inherit" });
}

/**
 * Variables from the developer's shell that would change what a sandboxed command does: an ambient
 * remote or token, a selected host, and the opt-outs of the automatic pull and the turn-end sync.
 */
function ambient(key: string): boolean {
  return key === "AGENTSTATE_LITE_REMOTE" || key === "SUPERBEE_ACCESS_TOKEN" || key.startsWith("SUPERBEE_HOST") || key.endsWith("NO_AUTOPULL") || key.endsWith("NO_TURN_SYNC");
}

export interface SandboxEnvOptions {
  /** The network log the preload appends to. */
  readonly log: string;
  /** Loopback ports the preload admits (and logs); none by default. */
  readonly allow?: readonly number[];
  readonly actor?: string;
  readonly extra?: NodeJS.ProcessEnv;
}

/** The environment of a sandboxed CLI run: an isolated profile under `home`, the preload, no update check. */
export function sandboxEnv(home: string, options: SandboxEnvOptions): NodeJS.ProcessEnv {
  const env = isolatedUserEnv(home, {
    SUPERBEE_TEST_NETWORK_LOG: options.log,
    ...(options.allow && options.allow.length > 0 ? { SUPERBEE_TEST_NETWORK_ALLOW: options.allow.map((port) => `127.0.0.1:${port}`).join(",") } : {}),
    SUPERBEE_NO_UPDATE_CHECK: "1",
    SUPERBEE_ACTOR: options.actor ?? "process:zero-network",
    NODE_OPTIONS: `--import=${pathToFileURL(DENY_NETWORK_PRELOAD).href}`,
    ...options.extra,
  });
  for (const key of Object.keys(env)) if (ambient(key) && !(options.extra && key in options.extra)) delete env[key];
  return env;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the built CLI once; never rejects. */
export function runSandboxed(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile("node", [BUILT_CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

/** One connection the preload saw: refused, or `allowed` to a listed loopback port. */
export interface NetworkLine {
  readonly api: string;
  readonly target: string;
  readonly argv: readonly string[];
  readonly allowed?: true;
}

export async function readNetworkLog(log: string): Promise<NetworkLine[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as NetworkLine);
  } catch {
    return [];
  }
}
