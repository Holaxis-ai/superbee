import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertArtifact, assertIdentity } from "../packages/package-verification/src/harness.mjs";
import { installedLockBoundaryPreloadSource, waitForJsonFile } from "./installed-lock-boundary.mjs";
import { isMainModule } from "./is-main-module.mjs";

const exec = promisify(execFile);
const retainedTarball = new URL("../out/windows-proof/superbee.tgz", import.meta.url);
const fixture = fileURLToPath(new URL("../examples/sample-bundle", import.meta.url));
const docId = "concepts/okf-alignment";
const docPath = `${docId}.md`;
const docTitle = "OKF Alignment";
const upstreamTitle = "OKF Alignment (upstream replacement)";
const boardRef = "refs/heads/board";
const trackingRef = "refs/remotes/origin/board";

const executables = Object.freeze({
  node: process.execPath,
  cmd: "cmd.exe",
  git: "git.exe",
  whoami: "whoami.exe",
  icacls: "icacls.exe",
});

async function run(tool, args, { cwd, env, expected = 0 }) {
  assert.ok(Object.hasOwn(executables, tool));
  const file = executables[tool];
  let result;
  try {
    result = await exec(file, args, {
      cwd, env, windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === expected && !error.signal && !error.killed) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw new Error(
      `${path.basename(file)} failed (expected ${expected}): ${error.message}\n` +
      `${String(error.stdout ?? "").slice(0, 4000)}\n${String(error.stderr ?? "").slice(0, 4000)}`,
      { cause: error },
    );
  }
  assert.equal(expected, 0, `${path.basename(file)} unexpectedly succeeded\n${result.stdout}`);
  return result;
}

function windowsProfile(root) {
  const local = path.join(root, "AppData", "Local");
  return { HOME: root, USERPROFILE: root, LOCALAPPDATA: local, APPDATA: path.join(root, "AppData", "Roaming") };
}

async function readFixtureFile(file, label) {
  const handle = await open(file, "r");
  try {
    const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(file, { bigint: true })]);
    if (label) {
      console.log(
        `WINDOWS_PROOF_FILE_ID ${label} Node ${process.version} libuv ${process.versions.uv}: ` +
        `path dev=${named.dev} ino=${named.ino}, handle dev=${opened.dev} ino=${opened.ino}`,
      );
    }
    assert.ok(named.isFile() && opened.isFile());
    assert.deepEqual([opened.dev, opened.ino], [named.dev, named.ino], "filesystem identity changed on open");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function assertBoardConflictReceipt(stdout, id) {
  const lines = stdout.split(/\r?\n/);
  assert.equal(lines[0], "error:", stdout);
  assert.equal(lines[1], "  code: CONFLICT", stdout);
  assert.ok(lines.includes("      total: 1"), stdout);
  assert.ok(lines.includes(`        - id: ${id}`), stdout);
  assert.ok(lines.includes("          frontmatter_differs[1]: title"), stdout);
  assert.ok(lines.includes("          theirs: kept"), stdout);
}

async function proveGuardedUpdate({ scratch, entrypoint, options, board, id, snapshot, originalBytes }) {
  const barrier = path.join(scratch, "guarded update barrier");
  const preload = path.join(barrier, "installed-lock-boundary-preload.mjs");
  const writerStates = {
    holder: path.join(scratch, "unused holder board state"),
    contender: path.join(scratch, "unused contender board state"),
  };
  const winnerTitle = "Installed guarded update winner";
  await mkdir(barrier);
  await writeFile(preload, installedLockBoundaryPreloadSource());
  const start = (role, title, expected) => run("node", [
    "--import", pathToFileURL(preload).href, entrypoint,
    "doc", "update", id, "--dir", board, "--expected-version", snapshot.head_version,
    "--title", title, "--actor", "openai/codex", "--json",
  ], {
    ...options,
    expected,
    env: {
      ...options.env,
      SUPERBEE_BOARD_STATE_DIR: writerStates[role],
      ASLITE_INSTALLED_LOCK_BARRIER_DIR: barrier,
      ASLITE_INSTALLED_LOCK_BARRIER_ROLE: role,
    },
  });
  const docFile = path.join(board, `${id}.md`);
  const marker = (name) => waitForJsonFile(path.join(barrier, name));
  const started = performance.now();
  const writers = Promise.allSettled([
    start("holder", winnerTitle, 0),
    start("contender", "Installed guarded update contender", 5),
  ]);
  let barrierFailure;
  let lockPath;
  try {
    const [holder, contender] = await Promise.all([
      marker("holder.acquired.json"),
      marker("contender.contended.json"),
    ]);
    lockPath = holder.lock_path;
    assert.equal(contender.lock_path, lockPath);
    assert.equal(contender.fs_code, "EEXIST");
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.pid, holder.owner_pid, "the holder's production owner record must be installed");
    await assert.rejects(lstat(path.join(barrier, "contender.unexpected-acquire.json")), { code: "ENOENT" });
    assert.deepEqual(await readFile(docFile), originalBytes, "both writers must wait for the production lock");
  } catch (error) {
    barrierFailure = error;
  } finally {
    await writeFile(path.join(barrier, "holder.release"), "release\n");
  }
  const [winner, loser] = await writers;
  console.log(`WINDOWS_PROOF_DOC_UPDATE_RACE_MS ${Math.round(performance.now() - started)}`);
  for (const result of [winner, loser]) {
    if (result.status === "rejected") throw result.reason;
  }
  if (barrierFailure) throw barrierFailure;
  const receipt = JSON.parse(winner.value.stdout);
  assert.deepEqual([receipt.doc, receipt.id, receipt.changed], ["updated", id, true]);
  const bytes = await readFile(docFile);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.notEqual(actual, snapshot.head_version);
  assert.equal(receipt.version, actual);
  const errorLines = loser.value.stdout.split(/\r?\n/);
  assert.deepEqual(errorLines.slice(0, 2), ["error:", "  code: STALE_HEAD"]);
  assert.ok(errorLines.includes(`    expected: "${snapshot.head_version}"`), loser.value.stdout);
  assert.ok(errorLines.includes(`    actual: "${actual}"`), loser.value.stdout);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  for (const state of Object.values(writerStates)) {
    await assert.rejects(lstat(state), { code: "ENOENT" });
  }
  return { actual, winnerTitle };
}

// Execute the installed CLI's structured continuation, including its literal cwd and arguments.
async function proveLocalOnboarding(installed, project, env) {
  await mkdir(project);
  const inspect = async (args = ["setup", "--json"]) =>
    JSON.parse((await installed(args, { cwd: project, env })).stdout).setup;
  const execute = async (action, expected = 0) => {
    assert.equal(action.command[0], "superbee");
    assert.equal(action.cwd, project);
    return installed(action.command.slice(1), { cwd: action.cwd, env, expected });
  };
  const first = await inspect();
  assert.equal(first.next.action, "choose_value");
  const choice = first.next.choices.find(row => row.command.includes("--project"));
  const chosen = JSON.parse((await execute(choice)).stdout).setup;
  assert.equal(chosen.next.approval.required, true);
  assert.equal(chosen.next.command[1], "init");
  await execute(chosen.next);
  const { setup: selected } = JSON.parse((await execute(chosen.verify)).stdout);
  assert.equal(selected.status, "ready");
  const create = selected.example.create;
  assert.deepEqual(create.command.slice(1, 3), ["doc", "write"]);
  assert.equal(create.approval.required, true);
  const body = "Remember this local project.";
  create.command[create.command.indexOf("--body") + 1] = body;
  const written = JSON.parse((await execute(create)).stdout);
  assert.equal(written.doc, "written");
  assert.match((await execute(create, 5)).stdout, /ALREADY_EXISTS/);
  const resumed = await inspect();
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.next, undefined);
  assert.equal(resumed.example.read.mutates, false);
  const read = JSON.parse((await execute(resumed.example.read)).stdout);
  assert.deepEqual([read.id, read.body.trimEnd(), read.head_version], [written.id, body, written.version]);
}

async function prove({ expectedDigest, expectedSource, scratch }) {
  const tarballBytes = await readFixtureFile(retainedTarball);
  assert.equal(createHash("sha256").update(tarballBytes).digest("hex"), expectedDigest, "retained tarball digest changed");
  const tarball = path.join(scratch, "superbee.tgz");
  await writeFile(tarball, tarballBytes, { flag: "wx" });
  const prefix = path.join(scratch, "npm install");
  const home = windowsProfile(path.join(scratch, "profile"));
  const privateRoot = path.join(home.LOCALAPPDATA, "Superbee");
  const boardState = path.join(scratch, "mounted board state");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:NODE_OPTIONS|NODE_PATH|npm_config_.*|GIT_.*|SUPERBEE_NO_AUTOPULL|SUPERBEE_BOARD_STATE_DIR)$/i.test(name),
  ));
  const env = {
    ...inherited,
    ...home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    SUPERBEE_NO_AUTOPULL: "1",
  };
  env.npm_config_userconfig = path.join(scratch, "npmrc");
  env.npm_config_globalconfig = path.join(scratch, "global-npmrc");
  env.npm_config_cache = path.join(scratch, "npm-cache");
  await mkdir(home.LOCALAPPDATA, { recursive: true });

  const npm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await run("node", [
    npm, "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball,
  ], { cwd: scratch, env });

  const pathKey = Object.keys(env).find((name) => /^path$/i.test(name));
  assert.ok(pathKey, "Windows needs an existing PATH with Node and Git");
  env[pathKey] = `${prefix}${path.delimiter}${env[pathKey]}`;
  const { stdout: versionOutput } = await run("cmd", ["/d", "/s", "/c", "superbee.cmd version --json"], { cwd: scratch, env });
  const { identity } = JSON.parse(versionOutput);
  const entrypoint = await realpath(path.join(prefix, "node_modules", "superbee", "dist", "superbee.mjs"));
  const installed = (args, options = {}) => run("node", [entrypoint, ...args], { cwd: scratch, env, ...options });
  const cli = async (args, options) => JSON.parse((await installed([...args, "--json"], options)).stdout);
  assertIdentity(identity, {
    package: { name: "superbee" },
    source: { commit: expectedSource, dirty: false },
    artifact: { channel: "npm-package" },
    runtime: { invocation: "superbee", launch_mode: "path", launch_confidence: "certain" },
  });
  assert.equal(path.normalize(identity.runtime.executable_path).toLowerCase(), entrypoint.toLowerCase());
  await assertArtifact(entrypoint, identity.artifact.sha256);
  console.log(`WINDOWS_PROOF_INSTALLED superbee@${identity.package.version} ${expectedSource} sha256:${expectedDigest}`);
  const unsupported = await installed(["ui"], { expected: 1 });
  assert.match(unsupported.stdout, /code: RUNTIME[\s\S]*Use WSL2 for the full CLI/);
  assert.deepEqual(await readdir(home.LOCALAPPDATA), [], "unsupported UI must not start a worker or create private state");

  const probe = path.join(home.LOCALAPPDATA, "file identity probe");
  await writeFile(probe, "native path and handle identity");
  await readFixtureFile(probe, "bootstrap probe");
  await unlink(probe);

  const localEnv = { ...env, [pathKey]: [prefix, path.dirname(process.execPath)].join(path.delimiter) };
  const project = path.join(scratch, "local project with spaces");
  await proveLocalOnboarding(installed, project, localEnv);
  console.log("WINDOWS_PROOF_LOCAL_SETUP selected, created and read back a local document without Git on PATH");

  const origin = path.join(scratch, "origin.git");
  const seed = path.join(scratch, "seed");
  const cloneA = path.join(scratch, "standalone A");
  const cloneB = path.join(scratch, "standalone B");
  const git = async (cwd, args) => (await run("git", args, { cwd, env })).stdout;
  const ref = async (repo, name) => (await git(repo, ["rev-parse", name])).trim();
  const configure = async (repo) => {
    await git(repo, ["config", "user.name", "Superbee Windows Proof"]);
    await git(repo, ["config", "user.email", "proof@invalid.example"]);
  };

  await Promise.all([git(scratch, ["init", "--bare", "--initial-branch", "board", origin]), cp(fixture, seed, { recursive: true })]);
  await git(seed, ["init", "-b", "board"]);
  await configure(seed);
  await git(seed, ["config", "core.autocrlf", "false"]);
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Seed standalone OKF board"]);
  await git(seed, ["push", origin, "board"]);
  await Promise.all([cloneA, cloneB].map(async (destination) => {
    await git(scratch, ["clone", "--no-local", "--branch", "board", "--config", "core.autocrlf=false", origin, destination]);
    await configure(destination);
  }));

  const { setup: boardSetup } = await cli(["setup"], { cwd: cloneB });
  assert.equal(boardSetup.status, "ready");
  assert.deepEqual(boardSetup.next.command.slice(0, 2), ["superbee", "list"]);
  assert.equal(boardSetup.next.mutates, false);
  const boardList = JSON.parse((await installed(boardSetup.next.command.slice(1), { cwd: boardSetup.next.cwd })).stdout);
  assert.ok(boardList.docs.some(row => row.id === docId));
  const prohibited = await installed(["doc", "write", "notes/new", "--type", "Note", "--create-only", "--body", "Board", "--dir", cloneB], { expected: 2 });
  assert.match(prohibited.stdout, /ordinary local bundle/);

  const { sync: defaultState } = await cli(["sync", "--dir", cloneB, "--pull-only"], { cwd: cloneB });
  assert.equal(defaultState, "already up to date");
  const marker = path.join(privateRoot, "state.json");
  assert.equal((await readFixtureFile(marker, "default state marker")).toString("utf8"), '{"product":"superbee","schema_version":1}\n');

  await mkdir(boardState);
  const { stdout: identityCsv } = await run("whoami", ["/user", "/fo", "csv", "/nh"], { cwd: scratch, env });
  const sid = identityCsv.match(/"(S-1-(?:\d+-)+\d+)"/i)?.[1];
  assert.ok(sid, "whoami must report the runner account SID");
  const account = `*${sid}`;
  const acl = (...args) => run("icacls", [privateRoot, ...args], { cwd: scratch, env });
  const denied = (error) => ["EACCES", "EPERM"].includes(error.code);
  const boardEnv = { ...env, SUPERBEE_BOARD_STATE_DIR: boardState };
  const sync = (repo, ...args) => cli(["sync", "--dir", repo, ...args], { cwd: repo, env: boardEnv });
  const document = (repo) => path.join(repo, docPath);
  const assertRemote = async (tip, bytes) => {
    assert.equal(await ref(origin, boardRef), tip);
    assert.deepEqual(Buffer.from(await git(origin, ["show", `${boardRef}:${docPath}`])), bytes);
  };
  const assertCheckout = async (repo, tip, bytes) => {
    assert.equal(await ref(repo, "HEAD"), tip);
    assert.equal(await ref(repo, trackingRef), tip);
    assert.deepEqual(await readFile(document(repo)), bytes);
    assert.equal(await git(repo, ["status", "--porcelain"]), "");
  };

  await acl("/deny", `${account}:(OI)(CI)(M)`);
  try {
    await assert.rejects(readdir(privateRoot), denied);
    await assert.rejects(writeFile(path.join(privateRoot, "denial probe"), "blocked"), denied);
    const writeProbe = path.join(boardState, "write probe");
    await writeFile(writeProbe, "writable");
    await unlink(writeProbe);
    const initialTip = await ref(origin, boardRef);
    assert.equal(await ref(cloneB, "HEAD"), initialTip);

    await appendFile(document(cloneA), "\nFirst published board edit.\n");
    const firstBytes = await readFile(document(cloneA));
    const pushed = await sync(cloneA);
    assert.deepEqual([pushed.home, pushed.committed, pushed.pushed, pushed.sent], ["git", 1, 1, 1]);
    const firstTip = await ref(cloneA, "HEAD");
    assert.notEqual(firstTip, initialTip);
    await assertRemote(firstTip, firstBytes);
    await assertCheckout(cloneA, firstTip, firstBytes);

    const pulled = await sync(cloneB, "--pull-only");
    assert.deepEqual([pulled.home, pulled.pulled, pulled.pushed, pulled.received], ["git", 1, 0, 1]);
    await assertCheckout(cloneB, firstTip, firstBytes);
    await assertRemote(firstTip, firstBytes);
    assert.equal((await readdir(boardState)).filter((name) => name.endsWith(".json")).length, 2);
    const cloneC = path.join(scratch, "standalone guarded update");
    await git(scratch, ["clone", "--no-local", "--branch", "board", "--config", "core.autocrlf=false", origin, cloneC]);
    await assertCheckout(cloneC, firstTip, firstBytes);

    const firstText = firstBytes.toString("utf8");
    assert.ok(firstText.includes(`title: ${docTitle}`), "sample document must have the expected title");
    await writeFile(document(cloneA),
      firstText.replace(`title: ${docTitle}`, `title: ${upstreamTitle}`) + "\nPublished replacement.\n");
    const upstreamBytes = await readFile(document(cloneA));
    const advanced = await sync(cloneA);
    assert.deepEqual([advanced.committed, advanced.pushed], [1, 1]);
    const upstreamTip = await ref(cloneA, "HEAD");
    assert.notEqual(upstreamTip, firstTip);
    await assertRemote(upstreamTip, upstreamBytes);
    // A fresh board-state path leaves no cursor to suppress an accidental opportunistic pull.
    const readState = path.join(scratch, "unused board reader state");
    const readEnv = { ...boardEnv, SUPERBEE_BOARD_STATE_DIR: readState };
    delete readEnv.SUPERBEE_NO_AUTOPULL;
    const readOptions = { cwd: scratch, env: readEnv };
    const fetchHead = path.join(cloneB, ".git", "FETCH_HEAD");
    const pulledFetchHead = await readFile(fetchHead);
    const assertReadOnlyState = async () => {
      await assert.rejects(lstat(readState), { code: "ENOENT" });
      assert.deepEqual(await readFile(fetchHead), pulledFetchHead);
      await assertCheckout(cloneB, firstTip, firstBytes);
      await assertRemote(upstreamTip, upstreamBytes);
    };
    const listStarted = performance.now();
    const listed = await cli(["list", "--dir", cloneB], readOptions);
    console.log(`WINDOWS_PROOF_LIST_MS ${Math.round(performance.now() - listStarted)}`);
    assert.ok(Array.isArray(listed.docs), "list must emit structured rows");
    const selected = listed.docs.find(({ id }) => id === docId);
    assert.ok(selected, "list must include the fixture document");
    assert.equal(selected.title, docTitle, "list must show the explicitly pulled title while origin is ahead");
    await assertReadOnlyState();

    const readStarted = performance.now();
    const documentResult = await cli(["doc", "read", selected.id, "--dir", cloneB], readOptions);
    const missing = await installed(["doc", "read", "concepts/missing", "--dir", cloneB, "--json"],
      { ...readOptions, expected: 6 });
    console.log(`WINDOWS_PROOF_DOC_READ_PAIR_MS ${Math.round(performance.now() - readStarted)}`);
    const header = firstText.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/);
    assert.ok(header, "the known sample fixture has YAML frontmatter");
    assert.deepEqual(
      [documentResult.id, documentResult.body, documentResult.head_version],
      [docId, firstText.slice(header[0].length), `sha256:${createHash("sha256").update(firstBytes).digest("hex")}`],
    );
    assert.match(missing.stdout, /^error:\r?\n  code: NOT_FOUND\r?\n/);
    await assertReadOnlyState();

    await git(cloneA, ["reset", "--hard", firstTip]);

    const recovered = new Map();
    const exportRoot = path.join(await realpath(boardState), "exports");
    for (const repo of [cloneA, cloneB]) {
      await appendFile(document(repo), `\nUnpublished words from ${path.basename(repo)}.\n`);
      const localBytes = await readFile(document(repo));
      // The CLI error envelope is TOON even with --json. Successful inspect is JSON.
      const { stdout } = await installed(["sync", "--dir", repo, "--json"], { cwd: repo, env: boardEnv, expected: 5 });
      assertBoardConflictReceipt(stdout, docId);

      // A new installed CLI process must reopen the durable copy.
      const inspected = await sync(repo, "--inspect", "--doc", docId);
      assert.equal(inspected.conflict, docId);
      const keys = (await readdir(exportRoot)).filter((key) => !recovered.has(key));
      assert.equal(keys.length, 1, "each clone must create a distinct recovery directory");
      const [key] = keys;
      assert.match(key, /^[a-f0-9]{32}$/);
      const saved = path.join(exportRoot, key, docPath);
      assert.equal((await realpath(saved)).toLowerCase(), saved.toLowerCase(), "saved copy must stay in the fixture export directory");
      assert.equal(path.normalize(inspected.local.saved_at).toLowerCase(), saved.toLowerCase());
      assert.deepEqual(await readFixtureFile(saved), localBytes);
      recovered.set(key, { saved, localBytes });
      await assertCheckout(repo, upstreamTip, upstreamBytes);
      await assertRemote(upstreamTip, upstreamBytes);
    }
    for (const { saved, localBytes } of recovered.values()) {
      assert.deepEqual(await readFixtureFile(saved), localBytes);
    }

    const writeState = path.join(scratch, "unused guarded update read state");
    const writeOptions = { cwd: scratch, env: { ...readEnv, SUPERBEE_BOARD_STATE_DIR: writeState } };
    const snapshot = await cli(["doc", "read", docId, "--dir", cloneC], writeOptions);
    const { actual, winnerTitle } = await proveGuardedUpdate({
      scratch, entrypoint, options: writeOptions, board: cloneC, id: docId,
      snapshot, originalBytes: firstBytes,
    });
    const updated = await cli(["doc", "read", docId, "--dir", cloneC], writeOptions);
    assert.deepEqual(
      [updated.id, updated.title, updated.body, updated.head_version],
      [docId, winnerTitle, snapshot.body, actual],
    );
    assert.equal(await ref(cloneC, "HEAD"), firstTip);
    assert.equal(await ref(cloneC, trackingRef), firstTip);
    await assert.rejects(lstat(path.join(cloneC, ".git", "FETCH_HEAD")), { code: "ENOENT" });
    assert.equal((await git(cloneC, ["status", "--porcelain"])).trimEnd(), ` M ${docPath}`);
    await assertRemote(upstreamTip, upstreamBytes);
    await assert.rejects(lstat(writeState), { code: "ENOENT" });
    await assert.rejects(readdir(privateRoot), denied);
  } finally {
    await acl("/remove:d", account);
  }
  return identity.package.version;
}

if (isMainModule(import.meta.url)) {
  assert.equal(process.platform, "win32", "this proof requires native Windows");
  const expectedDigest = process.env.SUPERBEE_TARBALL_SHA256;
  const expectedSource = process.env.GITHUB_SHA;
  assert.equal(process.argv.length, 2, "usage: verify-npm-package-windows.mjs");
  assert.match(expectedDigest ?? "", /^[a-f0-9]{64}$/);
  assert.match(expectedSource ?? "", /^[a-f0-9]{40}$/);
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "superbee-native-"));
  const started = Date.now();
  try {
    const version = await prove({ expectedDigest, expectedSource, scratch });
    const outcome = `Native Windows local project setup, document creation and read-back, board push, pull, list, document read, guarded update and conflict recovery with superbee@${version} succeeded in ${Date.now() - started} ms. Source ${expectedSource}, tarball sha256:${expectedDigest}.\n`;
    console.log(outcome.trim());
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}
