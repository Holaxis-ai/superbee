// Built-CLI proof of persona A's invariant: a local bundle and a Git board make no network call
// across every read, write and `sync`. Each command runs under `test/fixtures/deny-network.mjs`,
// a `node --import` preload that records and refuses `fetch`, `http(s)`, `net` and `tls`
// connections (child Node processes inherit it through NODE_OPTIONS). Git's own transport is a
// subprocess and is not Node's network; the Git board's origin here is a local bare repository.
//
// The npm release notice is a separate, documented opt-out (SUPERBEE_NO_UPDATE_CHECK) and is off.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolatedUserEnv } from "./support/user-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "../../superbee");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");
const preload = path.join(here, "fixtures", "deny-network.mjs");

before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

interface Sandbox {
  root: string;
  home: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-zero-network-")));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const log = path.join(root, "network.log");
  const env = isolatedUserEnv(home, {
    SUPERBEE_TEST_NETWORK_LOG: log,
    SUPERBEE_NO_UPDATE_CHECK: "1",
    SUPERBEE_ACTOR: "process:zero-network",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  });
  for (const key of Object.keys(env)) {
    if (key === "AGENTSTATE_LITE_REMOTE" || key === "SUPERBEE_ACCESS_TOKEN" || key.startsWith("SUPERBEE_HOST")) delete env[key];
  }
  return { root, home, log, env };
}

function run(box: Sandbox, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [cliBin, ...args], { cwd, env: box.env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

function git(cwd: string, box: Sandbox, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...box.env, NODE_OPTIONS: "" }, stdio: "pipe" });
}

async function networkLog(box: Sandbox): Promise<string[]> {
  try {
    return (await readFile(box.log, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Every read, write and sync verb a persona-A session uses, in one bundle, and the exit code each
 * must return: 0, except `whoami` with no hosted host selected (USAGE, 2).
 */
function expectedCode(args: string[]): number {
  return args[0] === "whoami" ? 2 : 0;
}

/** Run one command and require its expected exit code and no refused network call. */
async function runExpecting(box: Sandbox, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await run(box, args, cwd);
  const transcript = `${args.join(" ")} (exit ${result.code}): ${result.stdout}${result.stderr}`;
  assert.doesNotMatch(result.stdout + result.stderr, /network access refused/, transcript);
  assert.equal(result.code, expectedCode(args), transcript);
  return result;
}

function localCommands(): string[][] {
  return [
    ["doc", "write", "notes/first", "--type", "Note", "--title", "First", "--body", "One."],
    ["doc", "update", "notes/first", "--title", "First, again"],
    ["link", "add", "notes/first", "notes/second"],
    ["doc", "write", "notes/second", "--type", "Note", "--title", "Second"],
    ["list"],
    ["list", "--json"],
    ["doc", "read", "notes/first"],
    ["doc", "history", "notes/first"],
    ["link", "show", "notes/first"],
    ["kinds"],
    ["recipes"],
    ["view", "list"],
    ["blobs"],
    ["status"],
    ["status", "--json"],
    ["bundle", "locate"],
    ["catalog", "list"],
    ["home"],
    ["session-start"],
    ["turn-end"],
    ["whoami"],
    // Not a hosted checkout: nothing to convert, and nothing is fetched.
    ["export", "--in-place"],
    ["sync"],
    ["sync", "--pull-only"],
  ];
}

test("the deny-network preload catches fetch, http and net from a child process", async () => {
  const box = await sandbox();
  try {
    const probe = [
      "const http = await import('node:http');",
      "const net = await import('node:net');",
      "for (const attempt of [() => fetch('http://example.invalid/'), () => http.request('http://example.invalid/'), () => net.connect(80, 'example.invalid')]) {",
      "  try { await attempt(); } catch {}",
      "}",
    ].join("\n");
    await new Promise<void>((resolve) => {
      execFile("node", ["--input-type=module", "-e", probe], { env: box.env }, () => resolve());
    });
    const lines = (await networkLog(box)).map((line) => (JSON.parse(line) as { api: string }).api);
    assert.deepEqual(lines, ["fetch", "http.request", "net.connect"]);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a network call injected into the built CLI is recorded, so the zero-network assertions can fail", async () => {
  const box = await sandbox();
  try {
    const project = path.join(box.root, "project");
    await mkdir(project);
    await runExpecting(box, ["init", "--recipe", "none"], project);
    const inject = pathToFileURL(path.join(here, "fixtures", "inject-fetch.mjs")).href;
    const injected: Sandbox = { ...box, env: { ...box.env, NODE_OPTIONS: `${box.env.NODE_OPTIONS} --import=${inject}` } };
    await run(injected, ["list"], project);
    const calls = (await networkLog(box)).map((line) => JSON.parse(line) as { api: string; target: string; argv: string[] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.api, "fetch");
    assert.equal(calls[0]!.target, "http://example.invalid/injected");
    assert.deepEqual(calls[0]!.argv.slice(-1), ["list"]);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a local bundle makes zero network calls across every read, write and sync", async () => {
  const box = await sandbox();
  try {
    const project = path.join(box.root, "project");
    await mkdir(project);
    const init = await run(box, ["init", "--recipe", "none"], project);
    assert.equal(init.code, 0, init.stderr || init.stdout);
    for (const args of localCommands()) await runExpecting(box, args, project);
    // The writes really ran: the documents and the link are there.
    const listed = JSON.parse((await runExpecting(box, ["list", "--json"], project)).stdout) as { count: number };
    assert.equal(listed.count, 2);
    const locate = await run(box, ["bundle", "locate", "--json"], project);
    assert.equal((JSON.parse(locate.stdout) as { home: string }).home, "local");
    assert.deepEqual(await networkLog(box), []);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a Git board makes zero network calls across establish, join, sync, pull and every read", async () => {
  const box = await sandbox();
  try {
    const origin = path.join(box.root, "origin.git");
    const founder = path.join(box.root, "founder");
    const teammate = path.join(box.root, "teammate");
    execFileSync("git", ["init", "-q", "--bare", origin], { env: { ...box.env, NODE_OPTIONS: "" } });
    await mkdir(founder);
    git(founder, box, "init", "-q");
    git(founder, box, "remote", "add", "origin", origin);
    git(founder, box, "commit", "-q", "--allow-empty", "-m", "init");
    git(founder, box, "push", "-q", "origin", "HEAD:main");

    const steps: Array<[string, string[]]> = [
      [founder, ["init", "--dir", ".superbee", "--recipe", "none"]],
      [founder, ["sync"]],
      [founder, ["sync", "--establish"]],
      ...localCommands().map((args): [string, string[]] => [founder, args]),
    ];
    for (const [cwd, args] of steps) await runExpecting(box, args, cwd);
    execFileSync("git", ["clone", "-q", origin, teammate], { env: { ...box.env, NODE_OPTIONS: "" } });
    // The founder's final sync pushed the documents; the teammate's clone joins and sees them.
    for (const args of [["sync"], ["list"], ["session-start"], ["status"], ["sync", "--pull-only"]]) await runExpecting(box, args, teammate);
    const joined = JSON.parse((await runExpecting(box, ["list", "--json"], teammate)).stdout) as { count: number };
    assert.equal(joined.count, 2);

    const locate = JSON.parse((await run(box, ["bundle", "locate", "--json"], founder)).stdout) as { home: string; board: { shared: boolean } };
    assert.equal(locate.home, "git");
    assert.equal(locate.board.shared, true);
    const status = JSON.parse((await run(box, ["status", "--json"], teammate)).stdout) as { home: string; sync: { state: string } };
    assert.equal(status.home, "git");
    assert.equal(status.sync.state, "clean");
    assert.deepEqual(await networkLog(box), []);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("session-start's other-bundle listing and the opt-in Git turn end make zero network calls", async () => {
  const box = await sandbox();
  try {
    const origin = path.join(box.root, "origin.git");
    const founder = path.join(box.root, "founder");
    const personal = path.join(box.root, "personal");
    execFileSync("git", ["init", "-q", "--bare", origin], { env: { ...box.env, NODE_OPTIONS: "" } });
    await mkdir(founder);
    await mkdir(personal);
    git(founder, box, "init", "-q");
    git(founder, box, "remote", "add", "origin", origin);
    git(founder, box, "commit", "-q", "--allow-empty", "-m", "init");
    git(founder, box, "push", "-q", "origin", "HEAD:main");
    for (const [cwd, args] of [
      [founder, ["init", "--dir", ".superbee", "--recipe", "none"]],
      [founder, ["sync", "--establish"]],
      [founder, ["catalog", "add", "team"]],
      [personal, ["init", "--recipe", "none"]],
      [personal, ["catalog", "add", "personal"]],
    ] as Array<[string, string[]]>) await runExpecting(box, args, cwd);

    const started = JSON.parse((await runExpecting(box, ["session-start", "--json"], personal)).stdout) as { workspaces: { entries: { label: string; home: string }[] } };
    assert.deepEqual(started.workspaces.entries.map((entry) => [entry.label, entry.home]), [["team", "git"]]);

    await runExpecting(box, ["doc", "write", "notes/turn", "--type", "Note", "--title", "Turn"], founder);
    await runExpecting(box, ["turn-end", "--git-boards"], founder);
    const pushed = execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "board"], { env: { ...box.env, NODE_OPTIONS: "" }, encoding: "utf8" });
    assert.match(pushed, /^notes\/turn\.md$/m, "the turn end committed and pushed the board");
    assert.deepEqual(await networkLog(box), []);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a Git board conflict makes zero network calls across --inspect and --resolve", async () => {
  const box = await sandbox();
  try {
    const origin = path.join(box.root, "origin.git");
    const founder = path.join(box.root, "founder");
    const teammate = path.join(box.root, "teammate");
    execFileSync("git", ["init", "-q", "--bare", origin], { env: { ...box.env, NODE_OPTIONS: "" } });
    await mkdir(founder);
    git(founder, box, "init", "-q");
    git(founder, box, "remote", "add", "origin", origin);
    git(founder, box, "commit", "-q", "--allow-empty", "-m", "init");
    git(founder, box, "push", "-q", "origin", "HEAD:main");
    for (const args of [
      ["init", "--dir", ".superbee", "--recipe", "none"],
      ["sync", "--establish"],
      ["doc", "write", "notes/shared", "--type", "Note", "--title", "Shared", "--body", "Base."],
      ["sync"],
    ]) await runExpecting(box, args, founder);
    execFileSync("git", ["clone", "-q", origin, teammate], { env: { ...box.env, NODE_OPTIONS: "" } });
    await runExpecting(box, ["sync"], teammate);
    await runExpecting(box, ["doc", "update", "notes/shared", "--body", "Teammate's."], teammate);
    await runExpecting(box, ["sync"], teammate);
    await runExpecting(box, ["doc", "update", "notes/shared", "--body", "Founder's."], founder);

    const converged = await run(box, ["sync"], founder);
    assert.equal(converged.code, 5, converged.stdout + converged.stderr);
    const inspected = await run(box, ["sync", "--inspect", "--doc", "notes/shared", "--json"], founder);
    assert.equal(inspected.code, 0, inspected.stdout + inspected.stderr);
    assert.equal((JSON.parse(inspected.stdout) as { reason: string }).reason, "changed_remotely");
    await runExpecting(box, ["sync", "--resolve", "keep", "--doc", "notes/shared"], founder);
    await runExpecting(box, ["sync"], founder);
    assert.deepEqual(await networkLog(box), []);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});
