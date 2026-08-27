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

let command;
let commandArgs;
if (mode === "node") {
  command = process.execPath;
  // The CLI integration files launch many real Node/Git subprocesses. Running those files in
  // parallel saturates the small hosted Windows runner so severely that healthy child processes
  // miss their deliberate 5s anti-hang guards (and killed children then cascade into later Git
  // and hook cases). Bound FILE concurrency to two on Windows while retaining every test and every
  // product/test timeout; one-at-a-time was deterministic but left too little headroom in the
  // required packed-package lane. POSIX keeps Node's normal concurrency. Put the option immediately
  // after --test so it cannot be interpreted as a file argument.
  const testIndex = args.indexOf("--test");
  commandArgs = process.platform === "win32" && testIndex >= 0 && !args.some((arg) => arg.startsWith("--test-concurrency"))
    ? [...args.slice(0, testIndex + 1), "--test-concurrency=2", ...args.slice(testIndex + 1)]
    : args;
} else if (mode === "npm-exec") {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) throw new Error("npm_execpath is required for the npm-exec test command");
  command = process.execPath;
  commandArgs = [npmExecPath, "exec", "--no", "--", ...args];
} else {
  throw new Error("usage: node scripts/run-test-command.mjs node|npm-exec <args...>");
}

const result = spawnSync(command, commandArgs, { env, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
