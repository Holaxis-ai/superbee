import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";

import { KNOWN_COMMANDS } from "../src/cli.js";
import { CLI_LEAVES, type PublicLeaf, type PublicLeafId } from "../src/command-spec.js";
import { assertLeafArity } from "../src/positional-arity.js";
import { COMMAND_GROUPS } from "../src/reference.js";

const CLI = resolve(import.meta.dirname, "../dist/superbee.mjs");
const SURPLUS = "arity-surplus-sentinel";

interface FixtureContext {
  readonly scratch: string;
  readonly bundle: string;
  readonly initTarget: string;
  readonly artifactFile: string;
  readonly env: NodeJS.ProcessEnv;
}

interface LeafCase {
  readonly leaf: PublicLeaf;
  readonly operands: readonly string[];
  readonly argv: (operands: readonly string[]) => string[];
  readonly errorChannel?: "stdout" | "stderr";
}

function simple(
  leaf: PublicLeaf,
  prefix: readonly string[],
  operands: readonly string[],
  suffix: readonly string[] = [],
  errorChannel: "stdout" | "stderr" = "stdout",
): LeafCase {
  return { leaf, operands, argv: (data) => [...prefix, ...data, ...suffix], errorChannel };
}

function leafCases(ctx: FixtureContext): Record<PublicLeafId, LeafCase> {
  const dir = ["--dir", ctx.bundle] as const;
  return {
    bundleLocate: simple(CLI_LEAVES.bundleLocate, ["bundle", "locate"], [], dir),
    catalogAdd: simple(CLI_LEAVES.catalogAdd, ["catalog", "add"], ["arity-second"], dir),
    catalogList: simple(CLI_LEAVES.catalogList, ["catalog", "list"], []),
    catalogResolve: simple(CLI_LEAVES.catalogResolve, ["catalog", "resolve"], ["arity-bundle"], ["--field", "path"], "stderr"),
    init: simple(CLI_LEAVES.init, ["init"], [], ["--dir", ctx.initTarget, "--recipe", "none"]),
    indexGenerate: simple(CLI_LEAVES.indexGenerate, ["index", "generate"], [], [...dir, "--check"]),
    status: simple(CLI_LEAVES.status, ["status"], [], dir),
    docWrite: simple(CLI_LEAVES.docWrite, ["doc", "write"], ["candidate"], ["--type", "Test", "--body", "body", ...dir]),
    docUpdate: simple(CLI_LEAVES.docUpdate, ["doc", "update"], ["existing"], ["--title", "Changed", ...dir]),
    docRead: simple(CLI_LEAVES.docRead, ["doc", "read"], ["existing"], ["--out", "-", ...dir], "stderr"),
    docHistory: simple(CLI_LEAVES.docHistory, ["doc", "history"], ["existing"], dir),
    docDelete: simple(CLI_LEAVES.docDelete, ["doc", "delete"], ["victim"], dir),
    list: simple(CLI_LEAVES.list, ["list"], [], dir),
    query: simple(CLI_LEAVES.query, ["query"], [], dir),
    linkAdd: simple(CLI_LEAVES.linkAdd, ["link", "add"], ["from", "to"], dir),
    linkShow: simple(CLI_LEAVES.linkShow, ["link", "show"], ["from"], dir),
    linkList: simple(CLI_LEAVES.linkList, ["link", "list"], [], dir),
    artifactCreate: simple(CLI_LEAVES.artifactCreate, ["artifact", "create"], [ctx.artifactFile], ["--title", "Arity artifact", ...dir]),
    promote: simple(CLI_LEAVES.promote, ["promote"], [ctx.artifactFile], ["--doc-key", "artifacts/review.html", ...dir]),
    pull: simple(CLI_LEAVES.pull, ["pull"], [], ["--doc-key", "existing.md", "--out", "-", ...dir]),
    blobs: simple(CLI_LEAVES.blobs, ["blobs"], [], dir),
    delete: simple(CLI_LEAVES.delete, ["delete"], [], ["--doc-key", "victim.md", ...dir]),
    new: simple(CLI_LEAVES.new, ["new"], ["Context Note", "new-id"], ["--title", "New note", ...dir]),
    kinds: simple(CLI_LEAVES.kinds, ["kinds"], [], dir),
    kindFieldAdd: {
      leaf: CLI_LEAVES.kindFieldAdd,
      operands: ["Task", "repair-field"],
      argv: (data) => [
        "kind", "field",
        ...(data[0] === undefined ? [] : [data[0]]),
        "add",
        ...(data[1] === undefined ? [] : data.slice(1)),
        ...dir,
      ],
    },
    kindFieldRemove: {
      leaf: CLI_LEAVES.kindFieldRemove,
      operands: ["Task", "repair-field"],
      argv: (data) => [
        "kind", "field",
        ...(data[0] === undefined ? [] : [data[0]]),
        "remove",
        ...(data[1] === undefined ? [] : data.slice(1)),
        ...dir,
      ],
    },
    recipes: simple(CLI_LEAVES.recipes, ["recipes"], [], dir),
    recipeAdd: simple(CLI_LEAVES.recipeAdd, ["recipe", "add"], ["work-tracking"], dir),
    serve: simple(CLI_LEAVES.serve, ["serve"], [], [...dir, "--port", "0"]),
    ui: simple(CLI_LEAVES.ui, ["ui"], [], [...dir, "--port", "0"]),
    mcp: simple(CLI_LEAVES.mcp, ["mcp"], [], dir, "stderr"),
    viewList: simple(CLI_LEAVES.viewList, ["view", "list"], [], dir),
    sync: simple(CLI_LEAVES.sync, ["sync"], [], dir),
    version: simple(CLI_LEAVES.version, ["version"], []),
    sessionStart: simple(CLI_LEAVES.sessionStart, ["session-start"], [], [...dir, "--no-update-check"]),
    hookInstall: simple(CLI_LEAVES.hookInstall, ["hook", "install"], [], ["--scope", "project"]),
    hookStatus: simple(CLI_LEAVES.hookStatus, ["hook", "status"], [], ["--scope", "project"]),
    hookUninstall: simple(CLI_LEAVES.hookUninstall, ["hook", "uninstall"], [], ["--scope", "project"]),
    skillInstall: simple(CLI_LEAVES.skillInstall, ["skill", "install"], [], ["--scope", "project"]),
    skillStatus: simple(CLI_LEAVES.skillStatus, ["skill", "status"], [], ["--scope", "project"]),
    skillUninstall: simple(CLI_LEAVES.skillUninstall, ["skill", "uninstall"], [], ["--scope", "project"]),
  };
}

function run(argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5_000,
  });
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

function createFixture(): FixtureContext {
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-leaves-"));
  const bundle = join(scratch, "bundle");
  const home = join(scratch, "home");
  const artifactFile = join(scratch, "artifact.html");
  mkdirSync(home);
  writeFileSync(artifactFile, "<!doctype html><title>arity</title>\n");
  const env = { HOME: home, ASLITE_NO_UPDATE_CHECK: "1", AGENTSTATE_LITE_NO_AUTOPULL: "1" };
  const setupCommands = [
    ["init", "--dir", bundle],
    ["recipe", "add", "work-tracking", "--dir", bundle],
    ["doc", "write", "existing", "--type", "Test", "--body", "body", "--dir", bundle],
    ["doc", "write", "from", "--type", "Test", "--body", "from", "--dir", bundle],
    ["doc", "write", "to", "--type", "Test", "--body", "to", "--dir", bundle],
    ["doc", "write", "victim", "--type", "Test", "--body", "victim", "--dir", bundle],
    ["catalog", "add", "arity-bundle", "--dir", bundle],
  ] as const;
  for (const argv of setupCommands) {
    const result = run(argv, scratch, env);
    assert.equal(result.status, 0, `fixture setup ${argv.join(" ")}\n${result.stdout}${result.stderr}`);
  }
  return { scratch, bundle, initTarget: join(scratch, "must-not-exist"), artifactFile, env };
}

interface DecodedError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly help?: string;
  };
}

function decodedError(result: ReturnType<typeof run>, row: LeafCase, path: string): DecodedError {
  const channel = row.errorChannel ?? "stdout";
  const output = channel === "stderr" ? result.stderr : result.stdout;
  const reserved = channel === "stderr" ? result.stdout : result.stderr;
  assert.equal(reserved, "", `${path} must keep its reserved non-error channel byte-clean`);
  assert.notEqual(output, "", `${path} must emit a structured error`);
  return decode(output.trim()) as unknown as DecodedError;
}

test("documented paths, runtime top-level registration, arity, and executable rows agree bidirectionally", () => {
  const paths = COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((command) => command.paths));
  const ctx = { scratch: "", bundle: "bundle", initTarget: "target", artifactFile: "artifact", env: {} };
  const rows = leafCases(ctx);
  assert.equal(paths.length, Object.keys(rows).length);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(CLI_LEAVES).sort());
  assert.deepEqual(Object.values(rows).map((row) => row.leaf.path).sort(), [...paths].sort());
  assert.deepEqual([...new Set(paths.map((path) => path.split(" ")[0]))].sort(), [...KNOWN_COMMANDS].sort());
});

test("every catalogued built leaf has a valid boundary and rejects one derived surplus with an exact envelope", () => {
  const ctx = createFixture();
  const rows = leafCases(ctx);
  const bundleBefore = treeSnapshot(ctx.bundle);

  for (const [id, row] of Object.entries(rows)) {
    const contract = row.leaf.arity;
    const path = row.leaf.path;
    assert.equal(contract.kind, "exact", `${id}: matrix derivation requires an exact contract`);
    assert.equal(row.operands.length, contract.count, `${path}: fixture must be minimally valid`);
    assert.doesNotThrow(() => assertLeafArity(row.leaf, row.operands), `${path}: valid boundary`);

    const result = run(row.argv([...row.operands, SURPLUS]), ctx.scratch, ctx.env);
    assert.equal(result.status, 2, `${path}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const envelope = decodedError(result, row, path);
    assert.equal(envelope.error.code, "USAGE", path);
    assert.deepEqual(envelope.error.details, {
      command: row.leaf.canonical.path,
      expected: contract.count === 0
        ? "no positional arguments"
        : `exactly ${contract.count} positional${contract.count === 1 ? "" : "s"}`,
      actual: contract.count + 1,
      surplus: 1,
      first_unexpected: SURPLUS,
    }, path);
    assert.equal(envelope.error.help?.endsWith(`${row.leaf.canonical.path} --help`), true, `${path}: canonical leaf help`);
  }

  assert.equal(existsSync(ctx.initTarget), false);
  assert.equal(treeSnapshot(ctx.bundle), bundleBefore, "surplus leaves, including schema-deferred new, must not mutate the bundle");

  const terminated = run(["new", "Context Note", "terminated", "--dir", ctx.bundle, "--", "--title", SURPLUS], ctx.scratch, ctx.env);
  assert.equal(terminated.status, 2, terminated.stdout + terminated.stderr);
  assert.equal(treeSnapshot(ctx.bundle), bundleBefore, "-- terminated schema-deferred surplus must leave recursive bytes unchanged");

  const explicitHome = run(["home", SURPLUS], ctx.scratch, ctx.env);
  assert.equal(explicitHome.status, 2);
  const meta = run(["--version", SURPLUS], ctx.scratch, ctx.env);
  assert.equal(meta.status, 0);
  const shadow = run(["update"], ctx.scratch, ctx.env);
  assert.equal(shadow.status, 2);
});

test("selected missing boundaries and help precedence are executable across the matrix", () => {
  const ctx = createFixture();
  const rows = leafCases(ctx);
  const bundleBefore = treeSnapshot(ctx.bundle);

  for (const [id, row] of Object.entries(rows)) {
    const contract = row.leaf.arity;
    const path = row.leaf.path;
    if (contract.count > 0) {
      const missing = run(row.argv(row.operands.slice(0, -1)), ctx.scratch, ctx.env);
      assert.equal(missing.status, 2, `${path} missing boundary\n${missing.stdout}${missing.stderr}`);
      const envelope = decodedError(missing, row, path);
      assert.equal(envelope.error.code, "USAGE", path);
      assert.equal(envelope.error.details?.command, row.leaf.canonical.path, id);
      assert.equal(envelope.error.details?.actual, contract.count - 1, path);
    }

    const help = run([...row.argv([...row.operands, SURPLUS]), "--help"], ctx.scratch, ctx.env);
    assert.equal(help.status, 0, `${path} help precedence\nstdout=${help.stdout}\nstderr=${help.stderr}`);
    assert.notEqual(help.stdout, "", `${path}: help should be visible on stdout`);
  }

  assert.equal(existsSync(ctx.initTarget), false);
  assert.equal(treeSnapshot(ctx.bundle), bundleBefore, "missing/help probes must not mutate the bundle");
});

test("schema-deferred new preserves valid dynamic-field ordering", () => {
  const scratch = mkdtempSync(join(tmpdir(), "aslite-arity-new-dynamic-"));
  const bundle = join(scratch, "bundle");
  const init = run(["init", "--dir", bundle, "--recipe", "work-tracking"], scratch);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const created = run(["new", "Task", "--progress_status", "todo", "valid-interspersed", "--title", "Valid", "--dir", bundle], scratch);
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
  const sync = run(["sync", SURPLUS], scratch, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(sync.status, 2, sync.stdout + sync.stderr);
  assert.equal(existsSync(marker), false);

  const serve = run(["serve", SURPLUS, "--port", "0"], scratch);
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
  const child = spawn(process.execPath, [CLI, "list", SURPLUS, "--remote", `http://127.0.0.1:${address.port}`], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
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
