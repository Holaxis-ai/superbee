/** Built-CLI proof that only an explicit --remote flag can activate HTTP. */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerHandle } from "@superbee/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
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
  legacyRemote: string | null = "http://legacy.example",
  timeout?: number,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTSTATE_LITE_NO_AUTOPULL: "1",
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

test("built CLI: env-only bare command errors with migration guidance", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "aslite-local-only-env-"));
  try {
    const result = await run(["list", "--json"], cwd);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /AGENTSTATE_LITE_REMOTE ambient remote selection is retired/);
    assert.match(result.stdout, /--remote http:\/\/legacy\.example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: explicit --dir suppresses the legacy env and stays local", async () => {
  const result = await run(["list", "--dir", sampleBundle, "--json"], repoRoot);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal((JSON.parse(result.stdout) as { count: number }).count, 4);
});

test("built CLI: empty explicit target flags preserve presence and never fall through to ambient or discovered state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "aslite-local-only-empty-flags-"));
  try {
    for (const remoteArgs of [["--remote", ""], ["--remote="]]) {
      const result = await run(["list", ...remoteArgs, "--json"], cwd);
      assert.equal(result.code, 2);
      assert.match(result.stdout, /remote URL is required|invalid (?:server|remote) URL/i);
      assert.doesNotMatch(result.stdout, /AGENTSTATE_LITE_REMOTE ambient|no OKF bundle found/);
    }

    const emptyDir = await run(["list", "--dir", "", "--json"], cwd);
    assert.equal(emptyDir.code, 0, emptyDir.stderr || emptyDir.stdout);
    assert.equal((JSON.parse(emptyDir.stdout) as { count: number }).count, 0);
    assert.doesNotMatch(emptyDir.stdout, /AGENTSTATE_LITE_REMOTE ambient/);

    const bothEmpty = await run(["list", "--remote=", "--dir", "", "--json"], cwd);
    assert.equal(bothEmpty.code, 2);
    assert.match(bothEmpty.stdout, /--remote and --dir are mutually exclusive/);
    assert.doesNotMatch(bothEmpty.stdout, /AGENTSTATE_LITE_REMOTE ambient|no OKF bundle found/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: a reached URL binding errors actionably, while a local binding still resolves", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "aslite-local-only-binding-"));
  try {
    for (const value of ["http://binding.example", "x://remote.example/bundle", "C://remote.example/bundle"]) {
      await writeFile(path.join(cwd, ".agentstate.json"), JSON.stringify({ bundle: value }));
      const remoteBinding = await run(["list", "--json"], cwd, null);
      assert.equal(remoteBinding.code, 2);
      assert.match(remoteBinding.stdout, /project binding .* cannot use (?:remote URL|unsupported URI scheme)/);
      assert.match(remoteBinding.stdout, /URL bindings no longer activate remotes/);
      assert.ok(remoteBinding.stdout.includes(value));
    }

    await writeFile(path.join(cwd, ".agentstate.json"), JSON.stringify({ bundle: sampleBundle }));
    const localBinding = await run(["list", "--json"], cwd, null);
    assert.equal(localBinding.code, 0, localBinding.stderr || localBinding.stdout);
    assert.equal((JSON.parse(localBinding.stdout) as { count: number }).count, 4);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("built CLI: a FIFO project binding is rejected promptly instead of blocking discovery", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "aslite-local-only-binding-fifo-"));
  const binding = path.join(cwd, ".agentstate.json");
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

test("built CLI: explicit --remote suppresses the legacy env and completes a real server round trip", async () => {
  let handle: ServerHandle | undefined;
  try {
    handle = await serve({ bundle: { root: sampleBundle }, port: 0 });
    const remote = `http://${handle.host}:${handle.port}`;
    const result = await run(["list", "--remote", remote, "--json"], repoRoot);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as { count: number }).count, 4);
  } finally {
    await handle?.close();
  }
});
