import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { KNOWN_COMMANDS } from "../src/cli.js";
import { LEAF_POSITIONAL_ARITY } from "../src/positional-arity.js";
import { COMMAND_GROUPS, type PublicLeafPath } from "../src/reference.js";

const CLI = resolve(import.meta.dirname, "../dist/agentstate-lite.mjs");

const SURPLUS_ARGV = {
  "bundle locate": ["bundle", "locate", "extra"],
  "catalog add": ["catalog", "add", "label", "extra"],
  "catalog list": ["catalog", "list", "extra"],
  "catalog resolve": ["catalog", "resolve", "label", "extra", "--field", "path"],
  init: ["init", "extra"],
  "index generate": ["index", "generate", "extra"],
  status: ["status", "extra"],
  "doc write": ["doc", "write", "id", "extra"],
  "doc update": ["doc", "update", "id", "extra"],
  "doc read": ["doc", "read", "id", "extra", "--out", "-"],
  "doc history": ["doc", "history", "id", "extra"],
  "doc delete": ["doc", "delete", "id", "extra"],
  list: ["list", "extra"],
  query: ["query", "extra"],
  "link add": ["link", "add", "from", "to", "extra"],
  "link show": ["link", "show", "id", "extra"],
  "link list": ["link", "list", "extra"],
  "artifact create": ["artifact", "create", "file", "extra"],
  promote: ["promote", "file", "extra"],
  pull: ["pull", "extra", "--out", "-"],
  blobs: ["blobs", "extra"],
  delete: ["delete", "extra"],
  new: ["new", "Context Note", "id", "extra", "--title", "title"],
  kinds: ["kinds", "extra"],
  "kind field add": ["kind", "field", "Task", "add", "name", "extra"],
  "kind field remove": ["kind", "field", "Task", "remove", "name", "extra"],
  recipes: ["recipes", "extra"],
  "recipe add": ["recipe", "add", "context-notes", "extra"],
  serve: ["serve", "extra"],
  ui: ["ui", "extra"],
  mcp: ["mcp", "extra"],
  "view list": ["view", "list", "extra"],
  sync: ["sync", "extra"],
  version: ["version", "extra"],
  "session-start": ["session-start", "extra"],
  "hook install": ["hook", "install", "extra", "--scope", "project"],
  "hook status": ["hook", "status", "extra", "--scope", "project"],
  "hook uninstall": ["hook", "uninstall", "extra", "--scope", "project"],
  "skill install": ["skill", "install", "extra", "--scope", "project"],
  "skill status": ["skill", "status", "extra", "--scope", "project"],
  "skill uninstall": ["skill", "uninstall", "extra", "--scope", "project"],
} as const satisfies Record<PublicLeafPath, readonly string[]>;

function run(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...argv], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 5_000 });
}

function treeSnapshot(root: string): string {
  const rows: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else rows.push(`${path.slice(root.length)}\0${readFileSync(path).toString("base64")}`);
    }
  };
  visit(root);
  return rows.join("\n");
}

test("documented paths, runtime top-level registration, arity, and executable rows agree bidirectionally", () => {
  const paths = COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((command) => command.paths));
  assert.equal(paths.length, 41);
  assert.deepEqual(Object.keys(SURPLUS_ARGV).sort(), [...paths].sort());
  assert.deepEqual(Object.keys(LEAF_POSITIONAL_ARITY).filter((path) => path !== "home").sort(), [...paths].sort());
  assert.deepEqual([...new Set(paths.map((path) => path.split(" ")[0]))].sort(), [...KNOWN_COMMANDS].sort());
});

test("all 41 documented built leaves reject a surplus sentinel; reserved channels stay byte-clean", () => {
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-leaves-"));
  const bundle = join(scratch, "bundle");
  const init = run(["init", "--dir", bundle], scratch);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const bundleBefore = treeSnapshot(bundle);

  for (const [path, baseArgv] of Object.entries(SURPLUS_ARGV)) {
    const argv = [...baseArgv];
    if (path === "init") argv.push("--dir", join(scratch, "must-not-exist"), "--recipe", "none");
    else if (path === "new") argv.push("--dir", bundle);
    const result = run(argv, scratch);
    assert.equal(result.status, 2, `${path}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const reserved = path === "mcp" || path === "doc read" || path === "catalog resolve";
    if (reserved) {
      assert.equal(result.stdout, "", `${path} must keep reserved stdout empty`);
      assert.match(result.stderr, /USAGE/);
    } else {
      assert.match(result.stdout + result.stderr, /USAGE/);
    }
  }
  assert.equal(existsSync(join(scratch, "must-not-exist")), false);
  assert.equal(treeSnapshot(bundle), bundleBefore, "surplus leaves, including schema-deferred new, must not mutate the bundle");
  const terminated = run(["new", "Context Note", "terminated", "--dir", bundle, "--", "--title", "extra"], scratch);
  assert.equal(terminated.status, 2, terminated.stdout + terminated.stderr);
  assert.equal(treeSnapshot(bundle), bundleBefore, "-- terminated schema-deferred surplus must leave recursive bytes unchanged");

  const explicitHome = run(["home", "extra"], scratch);
  assert.equal(explicitHome.status, 2);
  const meta = run(["--version", "extra"], scratch);
  assert.equal(meta.status, 0);
  const shadow = run(["update"], scratch);
  assert.equal(shadow.status, 2);
});

test("schema-deferred new preserves valid dynamic-field ordering", () => {
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-new-dynamic-"));
  const bundle = join(scratch, "bundle");
  const init = run(["init", "--dir", bundle, "--recipe", "work-tracking"], scratch);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const created = run(["new", "Task", "--status", "todo", "valid-interspersed", "--title", "Valid", "--dir", bundle], scratch);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.ok(existsSync(join(bundle, "tasks/valid-interspersed.md")));
});

test("surplus sync performs zero Git spawns and surplus serve exits before listener readiness", () => {
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-effects-"));
  const bin = join(scratch, "bin");
  const marker = join(scratch, "git-called");
  mkdirSync(bin);
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 99\n`);
  chmodSync(fakeGit, 0o755);
  const sync = run(["sync", "extra"], scratch, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(sync.status, 2, sync.stdout + sync.stderr);
  assert.equal(existsSync(marker), false);

  const serve = run(["serve", "extra", "--port", "0"], scratch);
  assert.equal(serve.status, 2, serve.stdout + serve.stderr);
  assert.doesNotMatch(serve.stdout + serve.stderr, /listening|ready/i);
});

test("surplus remote list performs zero HTTP requests or connections", async () => {
  let connections = 0;
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
  server.on("connection", () => { connections++; });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-network-"));
  const child = spawn(process.execPath, [CLI, "list", "extra", "--remote", `http://127.0.0.1:${address.port}`], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  assert.equal(code, 2, stdout + stderr);
  assert.equal(requests, 0);
  assert.equal(connections, 0);
});
