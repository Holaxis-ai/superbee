import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const entrypoint = process.env.SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT;
const prefix = process.env.SUPERBEE_WINDOWS_INSTALLED_PREFIX;
const COMMAND_TIMEOUT_MS = 45_000;
const SCENARIO_TIMEOUT_MS = 120_000;

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
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

async function runScenario(name, operation) {
  const startedAt = Date.now();
  process.stderr.write(`WINDOWS_PROOF_START ${name}\n`);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} exceeded its ${SCENARIO_TIMEOUT_MS}ms scenario deadline`)),
        SCENARIO_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([operation(), timeout]);
    process.stderr.write(`WINDOWS_PROOF_PASS ${name} ${Date.now() - startedAt}ms\n`);
    return result;
  } catch (error) {
    process.stderr.write(
      `WINDOWS_PROOF_FAIL ${name} ${Date.now() - startedAt}ms ${String(error?.message ?? error)}\n`,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

async function renderManagedDocumentInChromium(url, expectedTitle) {
  const driverRoot = process.env.CHROMEWEBDRIVER;
  assert.ok(driverRoot, "the native Windows proof requires GitHub's matched ChromeDriver");
  const driver = path.join(driverRoot, "chromedriver.exe");
  await access(driver);
  const profile = path.join(scratch, "managed-chromium-profile");
  await mkdir(profile, { recursive: true });
  const driverPort = 9515;
  const driverProcess = spawn(driver, [`--port=${driverPort}`, "--allowed-ips="], {
    cwd: scratch,
    env: commandEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let driverOutput = "";
  driverProcess.stdout.setEncoding("utf8").on("data", (chunk) => { driverOutput += chunk; });
  driverProcess.stderr.setEncoding("utf8").on("data", (chunk) => { driverOutput += chunk; });
  const driverExit = new Promise((resolve) => driverProcess.once("exit", resolve));

  async function webdriver(method, route, body, timeoutMs = 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${driverPort}${route}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      assert.equal(response.ok, true, `${method} ${route} failed: ${JSON.stringify(payload)}`);
      assert.equal(payload.value?.error, undefined, `${method} ${route} failed: ${JSON.stringify(payload)}`);
      return payload.value;
    } catch (error) {
      throw new Error(`${method} ${route} failed: ${String(error?.message ?? error)}; driver: ${driverOutput}`);
    }
  }

  let sessionId;
  try {
    const readyDeadline = Date.now() + 10_000;
    let ready = false;
    while (!ready && Date.now() < readyDeadline) {
      try {
        const status = await webdriver("GET", "/status");
        ready = status.ready === true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(ready, true, `ChromeDriver did not become ready: ${driverOutput}`);

    const session = await webdriver("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "chrome",
          pageLoadStrategy: "eager",
          "goog:chromeOptions": {
            args: [
              "--headless=new",
              "--disable-background-networking",
              "--disable-component-update",
              "--disable-default-apps",
              "--disable-gpu",
              "--disable-extensions",
              "--disable-sync",
              "--metrics-recording-only",
              "--no-default-browser-check",
              "--no-first-run",
              `--user-data-dir=${profile}`,
            ],
          },
        },
      },
    }, 30_000);
    sessionId = session.sessionId;
    assert.ok(sessionId, `ChromeDriver did not return a session: ${JSON.stringify(session)}`);
    await webdriver("POST", `/session/${sessionId}/url`, { url });

    const renderDeadline = Date.now() + 15_000;
    let source = "";
    while (Date.now() < renderDeadline) {
      source = await webdriver("GET", `/session/${sessionId}/source`);
      if (source.includes(expectedTitle)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(source, new RegExp(expectedTitle), "Chromium must render the exact managed document");
  } finally {
    if (sessionId) {
      try {
        await webdriver("DELETE", `/session/${sessionId}`);
      } catch {
        // Driver termination below remains the bounded cleanup authority.
      }
    }
    driverProcess.kill();
    await Promise.race([
      driverExit,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function proveManagedDocumentLifecycle(bundle) {
  // doc open -> parent exit -> exact authority reuse/isolation/convergence -> real Edge render -> exact stop
  const actors = ["windows-proof", "windows-proof-other", "windows-proof-concurrent"];
  const managedEnv = { ...commandEnv, PATH: prefix };
  const managed = (args) => cliJson(args, { env: managedEnv });
  await cliJson([
    "doc", "write", "docs/windows-managed-proof", "--type", "Note",
    "--title", "Windows managed UI proof", "--body", "Managed document content", "--dir", bundle,
  ]);
  await cliJson([
    "doc", "write", "docs/windows-managed-second", "--type", "Note",
    "--title", "Windows managed UI second document", "--body", "Second managed document", "--dir", bundle,
  ]);

  let first;
  try {
    first = await managed([
      "doc", "open", "docs/windows-managed-proof", "--dir", bundle, "--actor", actors[0],
    ]);
    assert.equal(first.state, "started");
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+&view=doc&id=docs%2Fwindows-managed-proof$/);

    const afterParentExit = await managed(["ui", "--status", "--dir", bundle]);
    assert.equal(afterParentExit.count, 1, "the detached managed child must survive the launching parent");
    assert.equal(afterParentExit.instances[0].phase, "adopted");
    assert.equal(afterParentExit.instances[0].live, true);

    const reused = await managed([
      "doc", "open", "docs/windows-managed-proof", "--dir", bundle, "--actor", actors[0],
    ]);
    assert.equal(reused.state, "reused");
    assert.equal(reused.url, first.url);

    const secondDocument = await managed([
      "doc", "open", "docs/windows-managed-second", "--dir", bundle, "--actor", actors[0],
    ]);
    assert.equal(secondDocument.state, "reused");
    assert.equal(new URL(secondDocument.url).origin, new URL(first.url).origin);
    assert.notEqual(secondDocument.url, first.url);

    const isolatedActor = await managed([
      "doc", "open", "docs/windows-managed-proof", "--dir", bundle, "--actor", actors[1],
    ]);
    assert.equal(isolatedActor.state, "started");
    assert.notEqual(new URL(isolatedActor.url).origin, new URL(first.url).origin);

    const concurrent = await Promise.all([
      managed(["doc", "open", "docs/windows-managed-proof", "--dir", bundle, "--actor", actors[2]]),
      managed(["doc", "open", "docs/windows-managed-proof", "--dir", bundle, "--actor", actors[2]]),
    ]);
    assert.deepEqual(concurrent.map((receipt) => receipt.state).sort(), ["reused", "started"]);
    assert.equal(concurrent[0].url, concurrent[1].url);

    const converged = await managed(["ui", "--status", "--dir", bundle]);
    assert.equal(converged.count, 3, "three exact actor authorities must remain after concurrent convergence");
    assert.ok(converged.instances.every((instance) => instance.phase === "adopted" && instance.live === true));

    await renderManagedDocumentInChromium(first.url, "Windows managed UI proof");
  } finally {
    for (const actor of actors) {
      await managed(["ui", "--stop", "--dir", bundle, "--actor", actor]);
    }
  }

  const stopped = await managed(["ui", "--status", "--dir", bundle]);
  assert.equal(stopped.count, 0, "exact cleanup must leave no managed Windows authority");
  let listenerClosed = false;
  try {
    await fetch(first.url, { signal: AbortSignal.timeout(3000) });
  } catch {
    listenerClosed = true;
  }
  assert.equal(listenerClosed, true, "the stopped managed listener must no longer answer");
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

const installedPackageProofComplete = Symbol("installed-package-proof-complete");

async function runInstalledPackageProof() {
  const { bundle } = await runScenario("catalog-lifecycle", proveCatalogLifecycle);
  await runScenario("local-remote-sync", proveLocalRemoteSync);
  await runScenario("ui-url-lifecycle", () => proveUiUrlLifecycle(bundle));
  await runScenario("managed-document-lifecycle", () => proveManagedDocumentLifecycle(bundle));
  await runScenario("mcp-config-lifecycle", proveMcpConfigLifecycle);
  return installedPackageProofComplete;
}

try {
  const completion = await runInstalledPackageProof();
  assert.equal(completion, installedPackageProofComplete, "every installed-package lifecycle must complete");
  process.stdout.write(`${JSON.stringify({
    platform: process.platform,
    artifact: "exact installed npm tarball",
    scenarios: ["catalog-lifecycle", "local-remote-sync", "ui-url-lifecycle", "managed-document-lifecycle", "mcp-config-lifecycle"],
  })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}
