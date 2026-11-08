/** Built-CLI proof that removed remote inputs refuse actionably and bundle resolution stays local. */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "../../superbee");
const repoRoot = path.resolve(cliPackageRoot, "../..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");
const sampleBundle = path.join(repoRoot, "examples", "sample-bundle");

before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  args: string[],
  cwd: string,
  legacyRemote: string | null = null,
  timeout?: number,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERBEE_NO_AUTOPULL: "1",
    AGENTSTATE_LITE_REMOTE: legacyRemote ?? undefined,
  };
  if (legacyRemote === null) delete env.AGENTSTATE_LITE_REMOTE;
  return new Promise((resolve) => {
    execFile(
      "node",
      [cliBin, ...args],
      {
        cwd,
        encoding: "utf8",
        env,
        timeout,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : 0;
        resolve({ code, stdout, stderr, timedOut: error?.killed === true });
      },
    );
  });
}

const SECRET_URL = "http://user:secret-token@legacy.example";

test("built CLI: the retired remote variable is refused only where it used to choose the bundle", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "superbee-retired-remote-env-"));
  try {
    for (const args of [["list", "--json"], ["doc", "read", "a"], ["bundle", "id", "set", "x"]]) {
      const result = await run(args, cwd, SECRET_URL);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
      assert.match(result.stdout, /code: USAGE/);
      assert.match(result.stdout, /code: RETIRED_ENV/);
      assert.match(result.stdout, /AGENTSTATE_LITE_REMOTE is no longer read; remote access was removed\./);
      assert.match(result.stdout, /unset AGENTSTATE_LITE_REMOTE/);
      assert.match(result.stdout, /checkout <bundle-id>/);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
    }
    // An explicit --dir always won over it, so it is ignored there, silently, as before.
    const withDir = await run(["list", "--dir", sampleBundle, "--json"], cwd, SECRET_URL);
    assert.equal(withDir.code, 0, withDir.stdout);
    assert.equal((JSON.parse(withDir.stdout) as { count: number }).count, 4);
    assert.equal(withDir.stderr, "");
    // A command that never read it is unaffected.
    const version = await run(["version"], cwd, SECRET_URL);
    assert.equal(version.code, 0, version.stdout);
    assert.doesNotMatch(version.stdout + version.stderr, /RETIRED_ENV/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: an option value spelled --remote is data, not the removed flag", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "superbee-remote-as-value-"));
  try {
    const bundle = path.join(cwd, "b");
    assert.equal((await run(["init", "--dir", bundle], cwd)).code, 0);
    const written = await run(["doc", "write", "notes/a", "--type", "Note", "--title=--remote", "--body", "x", "--dir", bundle, "--json"], cwd);
    assert.equal(written.code, 0, written.stdout);
    const updated = await run(["doc", "update", "notes/a", "--title", "--remote", "--dir", bundle, "--json"], cwd);
    assert.equal(updated.code, 0, updated.stdout);
    const read = await run(["doc", "read", "notes/a", "--field", "title", "--dir", bundle], cwd);
    assert.equal(read.stdout.trim(), "--remote");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("built CLI: --remote is refused before any work, wherever it appears", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "superbee-retired-remote-flag-"));
  try {
    const shapes = [
      ["list", "--remote", SECRET_URL, "--json"],
      ["list", `--remote=${SECRET_URL}`],
      ["--remote", SECRET_URL],
      ["--remote", SECRET_URL, "list"],
      ["doc", "write", "a", "--type", "Note", "--remote", SECRET_URL, "--dir", sampleBundle],
      ["ui", "--remote", SECRET_URL],
    ];
    for (const args of shapes) {
      const result = await run(args, cwd);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
      assert.match(result.stdout, /message: "--remote was removed\."/);
      assert.match(result.stdout, /code: RETIRED_FLAG/);
      assert.match(result.stdout, /input: "--remote"/);
      assert.match(result.stdout, /Hosted bundle: .+ checkout <bundle-id>\. Local bundle: --dir <path>\. Old server: npx superbee@0\.4\.5 <command> --remote <url>\./);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
    }
    // After `--`, the token is data, not the removed flag.
    const literal = await run(["list", "--dir", sampleBundle, "--json", "--", "--remote"], cwd);
    assert.doesNotMatch(literal.stdout, /RETIRED_FLAG/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: an MCP host started with --remote sees the refusal on stderr, never on the protocol stream", async () => {
  const result = await run(["mcp", "--remote", SECRET_URL], repoRoot);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /code: RETIRED_FLAG/);
  assert.doesNotMatch(result.stderr, /secret-token/);
});

test("built CLI: superbee serve is refused with the local and pinned routes", async () => {
  for (const args of [["serve"], ["serve", "--dir", sampleBundle, "--port", "0"]]) {
    const result = await run(args, repoRoot);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /message: superbee serve was removed\./);
    assert.match(result.stdout, /code: RETIRED_COMMAND/);
    assert.match(result.stdout, /input: serve/);
    assert.match(result.stdout, /Use --dir <path>, and .+ ui --dir <path> for the browser\. Old server: npx superbee@0\.4\.5 serve --dir <path>\./);
  }
});

test("built CLI: a reached URL binding is refused without echoing it, while a local binding still resolves", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "superbee-retired-url-binding-"));
  try {
    const remoteValues = ["http://user:secret-token@binding.example", "x://remote.example/bundle"];
    // Drive-shaped input is still an unsupported URI scheme on supported hosts.
    remoteValues.push("C://remote.example/bundle");
    for (const value of remoteValues) {
      await writeFile(path.join(cwd, ".superbee.json"), JSON.stringify({ bundle: value }));
      const remoteBinding = await run(["list", "--json"], cwd);
      assert.equal(remoteBinding.code, 2);
      assert.match(remoteBinding.stdout, /project binding .* cannot use a URL; remote access was removed/);
      assert.match(remoteBinding.stdout, /RETIRED_URL_BINDING/);
      assert.match(remoteBinding.stdout, /Set \\?"bundle\\?" in .* to a local path, or run .+ checkout <bundle-id>\./);
      assert.ok(!remoteBinding.stdout.includes(value));
    }

    await writeFile(path.join(cwd, ".superbee.json"), JSON.stringify({ bundle: sampleBundle }));
    const localBinding = await run(["list", "--json"], cwd);
    assert.equal(localBinding.code, 0, localBinding.stderr || localBinding.stdout);
    assert.equal((JSON.parse(localBinding.stdout) as { count: number }).count, 4);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: a FIFO project binding is rejected promptly instead of blocking discovery", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "aslite-local-only-binding-fifo-"));
  const binding = path.join(cwd, ".superbee.json");
  try {
    execFileSync("mkfifo", [binding]);
    const result = await run(["list", "--json"], cwd, null, 3_000);
    assert.equal(result.timedOut, false, "binding discovery must not block on the FIFO");
    assert.equal(result.code, 2);
    assert.match(result.stdout, /project binding .* must be a regular file/);
    assert.ok(result.stdout.includes(binding));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
