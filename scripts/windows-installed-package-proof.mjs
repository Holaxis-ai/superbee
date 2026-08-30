import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const entrypoint = process.env.SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT;
const prefix = process.env.SUPERBEE_WINDOWS_INSTALLED_PREFIX;

assert.equal(process.platform, "win32", "this proof must execute on the native Windows runner");
assert.ok(entrypoint, "SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT is required");
assert.ok(prefix, "SUPERBEE_WINDOWS_INSTALLED_PREFIX is required");
await Promise.all([access(entrypoint), access(prefix)]);

const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "superbee-windows-installed-"));
const home = path.join(scratch, "home");
const localAppData = path.join(home, "AppData", "Local");
const appData = path.join(home, "AppData", "Roaming");
const commandEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: localAppData,
  APPDATA: appData,
  npm_config_prefix: prefix,
  PATH: `${prefix}${path.delimiter}${process.env.PATH ?? ""}`,
  AGENTSTATE_LITE_NO_AUTOPULL: "1",
};

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: options.cwd ?? scratch,
    env: options.env ?? commandEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

async function cli(args, options = {}) {
  return run(process.execPath, [entrypoint, ...args], options);
}

async function cliJson(args, options = {}) {
  const result = await cli([...args, "--json"], options);
  return JSON.parse(result.stdout);
}

async function git(cwd, args) {
  return run("git", args, { cwd });
}

async function proveCatalogLifecycle() {
  // catalog add -> catalog list -> catalog resolve
  const project = path.join(scratch, "catalog-project");
  const bundle = path.join(project, ".superbee");
  await mkdir(project, { recursive: true });
  await cliJson(["init", "--create-only", "--recipe", "none", "--dir", bundle]);
  const added = await cliJson(["catalog", "add", "windows-proof", "--dir", bundle]);
  assert.equal(added.catalog, "added");
  assert.equal(added.available, true);

  const listed = await cliJson(["catalog", "list"]);
  const row = listed.entries.find((entry) => entry.label === "windows-proof");
  assert.ok(row, "catalog list must return the installed-package workspace");
  assert.equal(row.available, true);

  const resolved = await cliJson(["catalog", "resolve", "windows-proof"]);
  assert.equal(path.normalize(resolved.locator.path), path.normalize(bundle));
  assert.equal(resolved.available, true);
  return { bundle };
}

async function configureRepository(repository) {
  await git(repository, ["config", "user.name", "Superbee Windows Proof"]);
  await git(repository, ["config", "user.email", "windows-proof@invalid.example"]);
}

async function proveLocalRemoteSync() {
  // sync --establish against a local bare origin -> teammate sync join -> idempotent sync
  const topology = path.join(scratch, "sync-topology");
  const origin = path.join(topology, "origin.git");
  const seed = path.join(topology, "seed");
  const cloneA = path.join(topology, "A");
  const cloneB = path.join(topology, "B");
  await mkdir(topology, { recursive: true });
  await git(topology, ["init", "--bare", "origin.git"]);
  await git(origin, ["config", "receive.autogc", "false"]);
  await git(origin, ["config", "maintenance.auto", "false"]);
  await git(origin, ["config", "gc.auto", "0"]);

  await git(topology, ["init", "-b", "main", "seed"]);
  await configureRepository(seed);
  await writeFile(path.join(seed, "README.md"), "# native Windows sync proof\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "seed project"]);
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["push", "origin", "main"]);
  await git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(topology, ["clone", "--no-local", origin, "A"]);
  await git(topology, ["clone", "--no-local", origin, "B"]);
  await configureRepository(cloneA);
  await configureRepository(cloneB);

  const boardA = path.join(cloneA, ".superbee");
  await cliJson(["init", "--create-only", "--recipe", "work-tracking", "--dir", boardA]);
  const established = await cliJson(["sync", "--establish", "--dir", cloneA]);
  assert.match(String(established.established), /shared board is live/);
  assert.equal(established.pushed, "origin/board (tracking set)");

  const joined = await cliJson(["sync", "--dir", cloneB]);
  assert.ok(joined.provisioned || joined.sync, "a second clone must join through ordinary sync");
  await stat(path.join(cloneB, ".superbee", "index.md"));
  const current = await cliJson(["sync", "--dir", cloneB]);
  assert.equal(current.sync, "already up to date");
}

async function proveUiUrlLifecycle(bundle) {
  // ui --dir -> ui-url observed -> authenticated request -> clean shutdown -> ui-url cleared
  const uiUrl = path.join(localAppData, "Superbee", "ui-url");
  const observation = path.join(scratch, "ui-observation.json");
  const preload = path.join(scratch, "ui-lifecycle-preload.mjs");
  await writeFile(preload, `
import { access, readFile, writeFile } from "node:fs/promises";
const pointer = process.env.SUPERBEE_WINDOWS_UI_URL_FILE;
const observation = process.env.SUPERBEE_WINDOWS_UI_OBSERVATION;
async function probe() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await access(pointer);
      const url = (await readFile(pointer, "utf8")).trim();
      const response = await fetch(url);
      await writeFile(observation, JSON.stringify({ url, status: response.status }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.emit("SIGTERM");
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
void probe().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + "\\n");
  process.exit(1);
});
`);

  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(preload).href, entrypoint, "ui", "--dir", bundle, "--port", "0", "--json"],
    {
      cwd: scratch,
      env: {
        ...commandEnv,
        SUPERBEE_WINDOWS_UI_URL_FILE: uiUrl,
        SUPERBEE_WINDOWS_UI_OBSERVATION: observation,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("installed UI lifecycle timed out"));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const receipt = JSON.parse(stdout);
  const observed = JSON.parse(await readFile(observation, "utf8"));
  assert.equal(observed.status, 200);
  assert.equal(observed.url, receipt.url);
  assert.match(receipt.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/);
  await assert.rejects(readFile(uiUrl, "utf8"), /ENOENT/, "clean shutdown must clear the ui-url pointer");
}

async function proveMcpConfigLifecycle() {
  // mcp install -> mcp status -> mcp config read-back -> mcp uninstall -> absent status
  const config = path.join(appData, "Claude", "claude_desktop_config.json");
  const installed = await cliJson(["mcp", "install", "--host", "claude-desktop", "--actor", "windows-proof"]);
  assert.equal(installed.mcp_registration.changed, true);
  assert.equal(installed.mcp_registration.after, "owned_current");

  const status = await cliJson(["mcp", "status", "--host", "claude-desktop"]);
  assert.equal(status.mcp_status.hosts[0].state, "owned_current");
  const parsed = JSON.parse(await readFile(config, "utf8"));
  const registration = parsed.mcpServers?.superbee;
  assert.ok(registration, "Claude Desktop configuration must contain the Superbee registration");
  assert.equal(path.normalize(registration.command), path.normalize(process.execPath));
  assert.equal(path.normalize(registration.args[0]), path.normalize(entrypoint));
  assert.deepEqual(registration.args.slice(1), ["mcp", "--actor", "windows-proof"]);

  const removed = await cliJson(["mcp", "uninstall", "--host", "claude-desktop"]);
  assert.equal(removed.mcp_registration.changed, true);
  assert.equal(removed.mcp_registration.after, "absent");
  const after = await cliJson(["mcp", "status", "--host", "claude-desktop"]);
  assert.equal(after.mcp_status.hosts[0].state, "absent");
  const cleaned = JSON.parse(await readFile(config, "utf8"));
  assert.equal(cleaned.mcpServers?.superbee, undefined);
}

async function proveCodexCmdLifecycle() {
  // codex.cmd on PATH/PATHEXT -> setup --host codex classifies empty/unreadable/current -> exact read-back
  const bin = path.join(scratch, "codex-bin");
  const shim = path.join(bin, "codex.cmd");
  const stub = path.join(bin, "codex-stub.mjs");
  const state = path.join(bin, "codex-state.json");
  const log = path.join(bin, "codex-log.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(shim, [
    "@echo off",
    "set \"SUPERBEE_CODEX_STUB_COMMAND=%~f0\"",
    "node \"%~dp0codex-stub.mjs\" %*",
    "",
  ].join("\r\n"));
  await writeFile(stub, `
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
const state = process.env.SUPERBEE_CODEX_STUB_STATE;
const log = process.env.SUPERBEE_CODEX_STUB_LOG;
await appendFile(log, JSON.stringify({ command: process.env.SUPERBEE_CODEX_STUB_COMMAND, argv }) + "\\n");
if (argv[0] !== "mcp") throw new Error("unexpected Codex command");
if (argv[1] === "list" && argv[2] === "--json") {
  if (process.env.SUPERBEE_CODEX_STUB_MODE === "unreadable") {
    process.stdout.write("not-json\\n");
  } else {
    let registration;
    try { registration = JSON.parse(await readFile(state, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    process.stdout.write(JSON.stringify(registration ? [{
      name: "superbee",
      enabled: true,
      disabled_reason: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "unsupported",
      transport: {
        type: "stdio",
        command: registration.command,
        args: registration.args,
        env: null,
        env_vars: [],
        cwd: null,
      },
    }] : []) + "\\n");
  }
} else if (argv[1] === "add" && argv[2] === "superbee") {
  const split = argv.indexOf("--");
  if (split === -1 || argv.length < split + 3) throw new Error("invalid Codex add command");
  await writeFile(state, JSON.stringify({ command: argv[split + 1], args: argv.slice(split + 2) }));
} else if (argv[1] === "remove" && argv[2] === "superbee") {
  await rm(state, { force: true });
} else {
  throw new Error("unexpected Codex MCP command");
}
`);

  const env = {
    ...commandEnv,
    PATH: `${bin}${path.delimiter}${commandEnv.PATH}`,
    PATHEXT: ".EXE;.CMD;.BAT;.COM",
    SUPERBEE_CODEX_STUB_STATE: state,
    SUPERBEE_CODEX_STUB_LOG: log,
  };
  const empty = await cliJson(["mcp", "status", "--host", "codex"], { env });
  assert.equal(empty.mcp_status.hosts[0].state, "absent");
  const emptySetup = await cliJson(["setup", "--host", "codex", "--scope", "user"], { env });
  assert.equal(emptySetup.setup.capabilities.find((capability) => capability.id === "mcp").state, "needs_action");

  const unreadable = await cliJson(["mcp", "status", "--host", "codex"], {
    env: { ...env, SUPERBEE_CODEX_STUB_MODE: "unreadable" },
  });
  assert.equal(unreadable.mcp_status.hosts[0].state, "unreadable");
  const unreadableSetup = await cliJson(["setup", "--host", "codex", "--scope", "user"], {
    env: { ...env, SUPERBEE_CODEX_STUB_MODE: "unreadable" },
  });
  assert.equal(unreadableSetup.setup.capabilities.find((capability) => capability.id === "mcp").state, "blocked");

  const installed = await cliJson(["mcp", "install", "--host", "codex", "--actor", "windows-proof"], { env });
  assert.equal(installed.mcp_registration.changed, true);
  assert.equal(installed.mcp_registration.after, "owned_current");
  const current = await cliJson(["mcp", "status", "--host", "codex"], { env });
  assert.equal(current.mcp_status.hosts[0].state, "owned_current");
  const currentSetup = await cliJson(["setup", "--host", "codex", "--scope", "user"], { env });
  assert.equal(currentSetup.setup.capabilities.find((capability) => capability.id === "mcp").state, "ready");

  const registration = JSON.parse(await readFile(state, "utf8"));
  assert.equal(path.normalize(registration.command), path.normalize(process.execPath));
  assert.equal(path.normalize(registration.args[0]), path.normalize(entrypoint));
  assert.deepEqual(registration.args.slice(1), ["mcp", "--actor", "windows-proof"]);
  const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(calls.length >= 6, "Codex registration must inspect, mutate, and read back");
  assert.ok(calls.every((call) => path.normalize(call.command) === path.normalize(shim)));

  const removed = await cliJson(["mcp", "uninstall", "--host", "codex"], { env });
  assert.equal(removed.mcp_registration.changed, true);
  assert.equal(removed.mcp_registration.after, "absent");
}

async function proveExplicitBundleJourney(label, bundle, env = commandEnv) {
  await cliJson(["init", "--create-only", "--recipe", "none", "--dir", bundle], { env });
  await cliJson(["doc", "write", `notes/${label}`, "--type", "Note", "--title", label, "--body", "windows", "--dir", bundle], { env });
  const read = await cliJson(["doc", "read", `notes/${label}`, "--dir", bundle], { env });
  assert.equal(read.id, `notes/${label}`);
  const status = await cliJson(["status", "--dir", bundle], { env });
  assert.equal(status.malformed, 0);
}

async function provePrivateStatePathMatrix() {
  // UNC, subst, redirected LOCALAPPDATA, and a per-component deny ACE with traverse retained
  const shareRoot = path.join(scratch, "unc-share");
  const shareName = `superbee-proof-${process.pid}`;
  await mkdir(shareRoot, { recursive: true });
  const shareEnv = {
    ...commandEnv,
    SUPERBEE_WINDOWS_SHARE_NAME: shareName,
    SUPERBEE_WINDOWS_SHARE_ROOT: shareRoot,
  };
  await run("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "New-SmbShare -Name $env:SUPERBEE_WINDOWS_SHARE_NAME -Path $env:SUPERBEE_WINDOWS_SHARE_ROOT -FullAccess ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -ErrorAction Stop | Out-Null"], { env: shareEnv });
  try {
    await proveExplicitBundleJourney("unc", `\\\\localhost\\${shareName}\\bundle`, shareEnv);
  } finally {
    await run("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Remove-SmbShare -Name $env:SUPERBEE_WINDOWS_SHARE_NAME -Force -ErrorAction Stop"], { env: shareEnv });
  }

  const substRoot = path.join(scratch, "subst-root");
  await mkdir(substRoot, { recursive: true });
  let drive;
  for (const candidate of ["Z:", "Y:", "X:"]) {
    try {
      await access(`${candidate}\\`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        drive = candidate;
        break;
      }
      throw error;
    }
  }
  assert.ok(drive, "the Windows runner must have one unused subst drive letter");
  await run("subst.exe", [drive, substRoot]);
  try {
    await proveExplicitBundleJourney("subst", `${drive}\\bundle`);
  } finally {
    await run("subst.exe", [drive, "/D"]);
  }

  const redirected = path.join(scratch, "redirected-local-app-data");
  const redirectedEnv = { ...commandEnv, LOCALAPPDATA: redirected };
  await proveExplicitBundleJourney("redirected", path.join(scratch, "redirected-project", ".superbee"), redirectedEnv);

  const deniedAncestor = path.join(home, ".config");
  const guardedRoot = path.join(deniedAncestor, "superbee");
  const ambiguousTarget = path.join(guardedRoot, "ambiguous-target");
  const unrelated = path.join(scratch, "denied-state-control", ".superbee");
  await mkdir(ambiguousTarget, { recursive: true });
  const principal = (await run("whoami.exe", [])).stdout.trim();
  await run("icacls.exe", [deniedAncestor, "/deny", `${principal}:(GR)`]);
  try {
    await assert.rejects(stat(deniedAncestor), (error) => error?.code === "EACCES" || error?.code === "EPERM");
    await stat(ambiguousTarget);
    await assert.rejects(realpath(ambiguousTarget), (error) => error?.code === "EACCES" || error?.code === "EPERM");
    await proveExplicitBundleJourney("denied-control", unrelated);
    await assert.rejects(
      cliJson(["status", "--dir", ambiguousTarget]),
      (error) => {
        const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
        return /cannot verify that the target is separate from private Superbee state/.test(output);
      },
    );
  } finally {
    await run("icacls.exe", [deniedAncestor, "/remove:d", principal]);
  }
}

const installedPackageProofComplete = Symbol("installed-package-proof-complete");

async function runInstalledPackageProof() {
  const { bundle } = await proveCatalogLifecycle();
  await proveLocalRemoteSync();
  await proveUiUrlLifecycle(bundle);
  await proveMcpConfigLifecycle();
  await proveCodexCmdLifecycle();
  await provePrivateStatePathMatrix();
  return installedPackageProofComplete;
}

try {
  const completion = await runInstalledPackageProof();
  assert.equal(completion, installedPackageProofComplete, "every installed-package lifecycle must complete");
  process.stdout.write(`${JSON.stringify({
    platform: process.platform,
    artifact: "exact installed npm tarball",
    scenarios: ["catalog-lifecycle", "local-remote-sync", "ui-url-lifecycle", "mcp-config-lifecycle", "codex-cmd-lifecycle", "private-state-path-matrix"],
  })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}
