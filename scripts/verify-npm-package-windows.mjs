import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertArtifact, assertIdentity } from "../packages/package-verification/src/harness.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../examples/sample-bundle", import.meta.url));
const docId = "concepts/okf-alignment";
const docPath = `${docId}.md`;
const boardRef = "refs/heads/board";
const trackingRef = "refs/remotes/origin/board";

async function run(file, args, { cwd, env, expected = 0, windowsVerbatimArguments = false }) {
  let result;
  try {
    result = await exec(file, args, {
      cwd, env, windowsVerbatimArguments, windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
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

async function prove({ tarball, expectedDigest, expectedSource, scratch }) {
  assert.equal(createHash("sha256").update(await readFile(tarball)).digest("hex"), expectedDigest, "retained tarball digest changed");
  const prefix = path.join(scratch, "npm install");
  const home = windowsProfile(path.join(scratch, "profile"));
  const privateRoot = path.join(home.LOCALAPPDATA, "Superbee");
  const boardState = path.join(scratch, "mounted board state");
  const env = {
    ...process.env,
    ...home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"),
    SUPERBEE_NO_AUTOPULL: "1",
  };
  for (const name of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|npm_config_.*|SUPERBEE_BOARD_STATE_DIR)$/i.test(name)) delete env[name];
  }
  env.npm_config_userconfig = path.join(scratch, "npmrc");
  env.npm_config_globalconfig = path.join(scratch, "global-npmrc");
  env.npm_config_cache = path.join(scratch, "npm-cache");
  await mkdir(home.LOCALAPPDATA, { recursive: true });

  const npm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await run(process.execPath, [
    npm, "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball,
  ], { cwd: scratch, env });

  const system32 = path.join(process.env.SystemRoot, "System32");
  const pathKey = Object.keys(env).find((name) => /^path$/i.test(name));
  assert.ok(pathKey, "Windows needs an existing PATH with Node and Git");
  env[pathKey] = `${prefix}${path.delimiter}${env[pathKey]}`;
  async function installed(args, options = {}) {
    // Use npm's normal Windows shim. All arguments come from this fixed fixture and its paths.
    const tokens = ["superbee.cmd", ...args];
    for (const token of tokens) assert.doesNotMatch(token, /["%\r\n]/, "unsafe cmd fixture argument");
    const command = tokens.map((token) => `"${token}"`).join(" ");
    return run(path.join(system32, "cmd.exe"), ["/d", "/s", "/v:off", "/c", `"${command}"`], {
      cwd: scratch, env, ...options, windowsVerbatimArguments: true,
    });
  }
  async function cli(args, options) {
    const { stdout } = await installed([...args, "--json"], options);
    return JSON.parse(stdout);
  }
  const { identity } = await cli(["version"]);
  assertIdentity(identity, {
    package: { name: "superbee" },
    source: { commit: expectedSource, dirty: false },
    artifact: { channel: "npm-package" },
    runtime: { invocation: "superbee", launch_mode: "path", launch_confidence: "certain" },
  });
  const entrypoint = await realpath(path.join(prefix, "node_modules", "superbee", "dist", "superbee.mjs"));
  assert.equal(await realpath(identity.runtime.executable_path), entrypoint);
  await assertArtifact(entrypoint, identity.artifact.sha256);
  console.log(`WINDOWS_PROOF_INSTALLED superbee@${identity.package.version} ${expectedSource} sha256:${expectedDigest}`);
  const unsupported = await installed(["ui"], { expected: 1 });
  assert.match(unsupported.stdout, /code: RUNTIME[\s\S]*Use WSL2 for the full CLI/);
  assert.deepEqual(await readdir(home.LOCALAPPDATA), [], "unsupported UI must not start a worker or create private state");

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

  const { sync: defaultState } = await cli(["sync", "--dir", cloneB, "--pull-only"], { cwd: cloneB });
  assert.equal(defaultState, "already up to date");

  await Promise.all([mkdir(privateRoot, { recursive: true }), mkdir(boardState)]);
  const { stdout: identityCsv } = await run(path.join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { cwd: scratch, env });
  const sid = identityCsv.match(/"(S-1-(?:\d+-)+\d+)"/i)?.[1];
  assert.ok(sid, "whoami must report the runner account SID");
  const account = `*${sid}`;
  const acl = (...args) => run(path.join(system32, "icacls.exe"), [privateRoot, ...args], { cwd: scratch, env });
  const denied = (error) => ["EACCES", "EPERM"].includes(error.code);
  const boardEnv = { ...env, SUPERBEE_BOARD_STATE_DIR: boardState };
  const sync = (repo, options = {}, ...args) => cli(["sync", "--dir", repo, ...args], { cwd: repo, env: boardEnv, ...options });
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

    const pulled = await sync(cloneB, {}, "--pull-only");
    assert.deepEqual([pulled.home, pulled.pulled, pulled.pushed, pulled.received], ["git", 1, 0, 1]);
    await assertCheckout(cloneB, firstTip, firstBytes);
    await assertRemote(firstTip, firstBytes);
    assert.equal((await readdir(boardState)).filter((name) => name.endsWith(".json")).length, 2);

    await appendFile(document(cloneA), "\nPublished replacement.\n");
    const upstreamBytes = await readFile(document(cloneA));
    const advanced = await sync(cloneA);
    assert.deepEqual([advanced.committed, advanced.pushed], [1, 1]);
    const upstreamTip = await ref(cloneA, "HEAD");
    assert.notEqual(upstreamTip, firstTip);
    await git(cloneA, ["reset", "--hard", firstTip]);

    const recovered = new Map();
    const exportRoot = await realpath(boardState);
    for (const repo of [cloneA, cloneB]) {
      await appendFile(document(repo), `\nUnpublished words from ${path.basename(repo)}.\n`);
      const localBytes = await readFile(document(repo));
      const { error } = await sync(repo, { expected: 5 });
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.details.conflicts.total, 1);
      const [row] = error.details.conflicts.rows;
      assert.equal(row.id, docId);
      assert.equal(row.theirs, "kept");

      // Every shim invocation starts a fresh CLI process.
      const inspected = await sync(repo, {}, "--inspect", "--doc", docId);
      assert.equal(inspected.conflict, docId);
      const saved = await realpath(inspected.local.saved_at);
      assert.equal(await realpath(row.yours), saved);
      assert.ok(path.relative(exportRoot, saved).startsWith(`exports${path.sep}`), `copy escaped board state: ${saved}`);
      assert.ok(!recovered.has(saved.toLowerCase()), `clones reused recovery path: ${saved}`);
      assert.deepEqual(await readFile(saved), localBytes);
      recovered.set(saved.toLowerCase(), { saved, localBytes });
      await assertCheckout(repo, upstreamTip, upstreamBytes);
      await assertRemote(upstreamTip, upstreamBytes);
    }
    for (const { saved, localBytes } of recovered.values()) {
      assert.deepEqual(await readFile(saved), localBytes);
    }
  } finally {
    await acl("/remove:d", account);
  }
  return identity.package.version;
}

assert.equal(process.platform, "win32", "this proof requires native Windows");
assert.ok(process.env.SystemRoot, "native Windows must provide SystemRoot");
const [, , tarball] = process.argv;
const expectedDigest = process.env.SUPERBEE_TARBALL_SHA256;
const expectedSource = process.env.GITHUB_SHA;
assert.ok(tarball && process.argv.length === 3, "usage: verify-npm-package-windows.mjs <retained-tarball>");
assert.match(expectedDigest ?? "", /^[a-f0-9]{64}$/);
assert.match(expectedSource ?? "", /^[a-f0-9]{40}$/);
const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "superbee-native-"));
const started = Date.now();
try {
  const version = await prove({ tarball: path.resolve(tarball), expectedDigest, expectedSource, scratch });
  const outcome = `Native Windows board push, pull and conflict recovery with superbee@${version} succeeded in ${Date.now() - started} ms. Source ${expectedSource}, tarball sha256:${expectedDigest}.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, outcome);
  console.log(outcome.trim());
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
