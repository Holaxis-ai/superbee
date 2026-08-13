/**
 * The `init` receipt's follow-up commands must retain an explicit `--dir` target. This test runs
 * the built CLI with its preferred `superbee` bin on PATH, then executes the emitted shell commands
 * from a different bundle. That catches both failure-to-find and, more importantly, wrong-bundle
 * reads/writes. A target containing spaces and an apostrophe also proves the emitted target is
 * safely shell-quoted.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

before(() => {
  if (!existsSync(cliBin)) {
    execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
  }
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function makeBinOnPath(): Promise<{ binDir: string; env: NodeJS.ProcessEnv }> {
  const binDir = await tempDir("superbee-init-help-bin-");
  await symlink(cliBin, path.join(binDir, "superbee"));
  return {
    binDir,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
  };
}

function run(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("superbee", args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runEmitted(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("built CLI: init --dir follow-ups execute from another bundle without losing their target", async () => {
  const sandbox = await tempDir("aslite-init-help-");
  const unrelated = path.join(sandbox, "unrelated-bundle");
  const taskTarget = path.join(sandbox, "target's task bundle");
  const noteTarget = path.join(sandbox, "target's note bundle");
  const { binDir, env } = await makeBinOnPath();

  try {
    await Promise.all([mkdir(unrelated), mkdir(taskTarget), mkdir(noteTarget)]);
    const unrelatedInit = run(["init", "--recipe", "none", "--json"], { cwd: unrelated, env });
    assert.equal(unrelatedInit.status, 0, unrelatedInit.stdout + unrelatedInit.stderr);

    const taskInit = run(
      ["init", "--dir", taskTarget, "--recipe", "work-tracking", "--json"],
      { cwd: unrelated, env },
    );
    assert.equal(taskInit.status, 0, taskInit.stdout + taskInit.stderr);
    const taskReceipt = JSON.parse(taskInit.stdout) as { help: string[] };
    assert.equal(taskReceipt.help.length, 2);

    const kinds = runEmitted(taskReceipt.help[0]!, { cwd: unrelated, env });
    assert.equal(kinds.status, 0, kinds.stdout + kinds.stderr);
    assert.match(kinds.stdout, /Task/, "the emitted kinds command must inspect the selected target");

    const recipes = runEmitted(taskReceipt.help[1]!, { cwd: unrelated, env });
    assert.equal(recipes.status, 0, recipes.stdout + recipes.stderr);
    assert.match(recipes.stdout, /work-tracking/);
    assert.match(recipes.stdout, /applied: true/, "the emitted recipes command must inspect the selected target");

    const noteInit = run(["init", "--dir", noteTarget, "--json"], { cwd: unrelated, env });
    assert.equal(noteInit.status, 0, noteInit.stdout + noteInit.stderr);
    const noteReceipt = JSON.parse(noteInit.stdout) as { help: string[] };
    const createNote = noteReceipt.help[0]!
      .replace("<id>", "followup-note")
      .replace("<title>", "Followup");
    const created = runEmitted(createNote, { cwd: unrelated, env });
    assert.equal(created.status, 0, created.stdout + created.stderr);
    assert.ok(existsSync(path.join(noteTarget, "context-notes", "followup-note.md")));
    assert.ok(
      !existsSync(path.join(unrelated, "context-notes", "followup-note.md")),
      "the emitted mutation must not write to the invocation cwd's bundle",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("built CLI: init accepts its supported authoring version and rejects false claims before creation", async () => {
  const sandbox = await tempDir("aslite-init-version-guard-");
  const { binDir, env } = await makeBinOnPath();

  try {
    for (const [name, versionArgs] of [
      ["default", []],
      ["explicit", ["--okf-version", "0.1"]],
    ] as const) {
      const target = path.join(sandbox, name);
      const result = run(["init", "--dir", target, "--recipe", "none", ...versionArgs, "--json"], {
        cwd: sandbox,
        env,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(await readFile(path.join(target, "index.md"), "utf8"), /okf_version: ['"]?0\.1['"]?/);
    }

    for (const [name, requested, extraArgs] of [
      ["v02", "0.2", []],
      ["future", "9.4", ["--create-only"]],
      ["blank", "", ["--create-only"]],
    ] as const) {
      const target = path.join(sandbox, name);
      const result = run(
        ["init", "--dir", target, "--recipe", "none", "--okf-version", requested, ...extraArgs],
        { cwd: sandbox, env },
      );
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /code: USAGE/);
      assert.match(result.stdout, /author 0\.1/);
      assert.match(result.stdout, /read or transport/);
      assert.equal(existsSync(target), false, `unsupported version ${JSON.stringify(requested)} must not create its target`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
