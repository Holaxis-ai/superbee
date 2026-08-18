import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertBundleOutsidePrivateState } from "../src/private-state-bundle-boundary.js";
import { canonicalUserStateDir, ensureUserStateRoot, legacyUserStateDir } from "../src/user-state.js";

const CLI = fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url));

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "superbee-state-bundle-boundary-"));
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ASLITE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
      ...env,
    },
    encoding: "utf8",
  });
}

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("private state coordinates are absolute and cannot be bundle identities", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const bundle = path.join(root, "project", ".superbee");
    mkdirSync(bundle, { recursive: true });

    assert.throws(() => canonicalUserStateDir(""), /must be an absolute path/);
    assert.throws(() => legacyUserStateDir(""), /must be an absolute path/);
    assert.doesNotThrow(() => assertBundleOutsidePrivateState(bundle, home));
    assert.throws(
      () => assertBundleOutsidePrivateState(canonicalUserStateDir(home), home),
      /private user-state directory cannot be used as an OKF bundle/,
    );

    mkdirSync(path.join(home, ".config"), { recursive: true });
    symlinkSync(bundle, canonicalUserStateDir(home), "dir");
    assert.throws(
      () => assertBundleOutsidePrivateState(bundle, home),
      /private user-state directory cannot be used as an OKF bundle/,
      "physical identity catches an alias even though the lexical names differ",
    );

    unlinkSync(canonicalUserStateDir(home));
    const futureBundle = path.join(root, "future-project", ".superbee");
    mkdirSync(path.dirname(futureBundle), { recursive: true });
    symlinkSync(futureBundle, canonicalUserStateDir(home), "dir");
    assert.throws(
      () => assertBundleOutsidePrivateState(futureBundle, home),
      /private user-state directory cannot be used as an OKF bundle/,
      "a dangling state-root alias cannot become a bundle later",
    );
    assert.equal(existsSync(futureBundle), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing case variants cannot become the private state identity", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const caseVariant = path.join(home, ".CONFIG", "superbee");
    mkdirSync(home, { recursive: true });

    assert.throws(
      () => assertBundleOutsidePrivateState(caseVariant, home),
      /private user-state directory cannot be used as an OKF bundle/,
      "future identity comparison must fail closed before a case-insensitive filesystem creates the alias",
    );
    assert.equal(existsSync(caseVariant), false);
    assert.equal(existsSync(canonicalUserStateDir(home)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("built init refuses the private state root before creating bundle bytes", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = canonicalUserStateDir(home);
    for (const extra of [[], ["--create-only"]]) {
      const result = run(process.execPath, [CLI, "init", ...extra, "--dir", stateRoot, "--json"], root, { HOME: home });
      assert.equal(result.status, 5, result.stderr || result.stdout);
      assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
      assert.equal(existsSync(stateRoot), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("built init refuses a missing portable case variant before creating bundle bytes", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const caseVariant = path.join(home, ".CONFIG", "superbee");
    for (const extra of [[], ["--create-only"]]) {
      const result = run(process.execPath, [CLI, "init", ...extra, "--dir", caseVariant, "--json"], root, { HOME: home });
      assert.equal(result.status, 5, result.stderr || result.stdout);
      assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
      assert.equal(existsSync(caseVariant), false);
      assert.equal(existsSync(canonicalUserStateDir(home)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit bundle selection preserves the path-free private-state conflict", async () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const stateRoot = await ensureUserStateRoot(home);
    const result = run(process.execPath, [CLI, "bundle", "locate", "--dir", stateRoot, "--json"], root, { HOME: home });
    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
    assert.doesNotMatch(result.stdout, /NOT_FOUND|init --create-only/);
    assert.equal(result.stdout.includes(stateRoot), false, "the private coordinate never enters the envelope");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync publication refuses a physical alias of private state", () => {
  const root = scratch();
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const remote = path.join(root, "remote.git");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    git(project, ["init", "-b", "main"]);
    git(project, ["config", "user.name", "Boundary Test"]);
    git(project, ["config", "user.email", "boundary@example.invalid"]);
    git(root, ["init", "--bare", remote]);
    git(project, ["remote", "add", "origin", remote]);

    const initialized = run(process.execPath, [CLI, "init", "--create-only", "--dir", ".superbee", "--json"], project, { HOME: home });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    git(project, ["commit", "--allow-empty", "-m", "initialize project"]);

    mkdirSync(path.join(home, ".config"), { recursive: true });
    symlinkSync(path.join(project, ".superbee"), canonicalUserStateDir(home), "dir");
    const result = run(process.execPath, [CLI, "sync", "--establish", "--json"], project, { HOME: home });
    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stdout, /private user-state directory cannot be used as an OKF bundle/);
    const board = run("git", ["--git-dir", remote, "show-ref", "--verify", "refs/heads/board"], root);
    assert.notEqual(board.status, 0, "the harm-boundary refusal must occur before board publication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
