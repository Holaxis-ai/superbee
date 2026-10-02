import { spawnSync } from "node:child_process";

const [mode, ...args] = process.argv.slice(2);
const env = {
  ...process.env,
  ASLITE_NO_UPDATE_CHECK: "1",
  AGENTSTATE_LITE_NO_AUTOPULL: "1",
  GIT_AUTHOR_NAME: "test-suite",
  GIT_AUTHOR_EMAIL: "test-suite@example.invalid",
  GIT_COMMITTER_NAME: "test-suite",
  GIT_COMMITTER_EMAIL: "test-suite@example.invalid",
};

// CI splits the CLI suite, the dominant cost of the runtime lane, across parallel jobs. The shard
// is `<index>/<total>`, applied through Node's own `--test-shard` so each file runs in exactly one
// shard. A malformed value fails closed instead of silently running everything or nothing.
function withTestShard(nodeArgs) {
  const shard = process.env.SUPERBEE_TEST_SHARD;
  if (shard === undefined || shard === "") return nodeArgs;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`SUPERBEE_TEST_SHARD must be <index>/<total> with 1 <= index <= total, got ${JSON.stringify(shard)}`);
  }
  if (nodeArgs[0] !== "--test") {
    throw new Error("SUPERBEE_TEST_SHARD applies only to a node --test command");
  }
  return ["--test", `--test-shard=${shard}`, ...nodeArgs.slice(1)];
}

let command;
let commandArgs;
if (mode === "node") {
  command = process.execPath;
  commandArgs = withTestShard(args);
} else if (mode === "npm-exec") {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) throw new Error("npm_execpath is required for the npm-exec test command");
  command = process.execPath;
  commandArgs = [npmExecPath, "exec", "--no", "--", ...args];
} else {
  throw new Error("usage: node scripts/run-test-command.mjs node|npm-exec <args...>");
}

const result = spawnSync(command, commandArgs, { env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
