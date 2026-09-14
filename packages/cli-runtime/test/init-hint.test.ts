/**
 * U6 — `init`'s in-a-git-repo hint (plan §U6: "`init` run inside a git repo prints an fs-only
 * hint ('if this project shares a board, run sync instead' — detected by `.git` up-tree, NO git
 * binary invoked)").
 *
 * Pins three things:
 *  1. init inside a git repo (`.git` DIRECTORY up-tree, at any ancestor depth) carries the hint;
 *     a `.git` FILE (a secondary-checkout marker) counts too.
 *  2. init outside any git repo carries NO hint.
 *  3. The hint never blocks: the receipt is still `init: "ok"` with the recipe applied, and the
 *     probe never invokes the git binary (the planted `.git` is an empty dir/file no real git
 *     would accept — a spawn would fail loudly, so success IS the fs-only proof).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { init, insideGitRepo } from "../src/commands/init.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-init-hint-test-"));
}

async function runInit(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await init([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("init inside a git repo (`.git` dir at an ancestor) prints the run-sync-instead hint and still succeeds", async () => {
  const dir = await tempDir();
  try {
    // Repo root with a bare `.git` DIRECTORY marker; the bundle two levels below it.
    await mkdir(path.join(dir, ".git"));
    const bundleDir = path.join(dir, "packages", "app", ".agentstate-lite");
    const receipt = await runInit(["--dir", bundleDir]);
    assert.equal(receipt.init, "ok", "the hint never blocks — init still succeeds");
    assert.equal(typeof receipt.hint, "string");
    assert.match(receipt.hint as string, /shares a board/);
    assert.match(receipt.hint as string, /sync/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a `.git` FILE (secondary-checkout marker) also counts — fs-only, shape-agnostic", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, ".git"), "gitdir: /somewhere/else\n");
    const receipt = await runInit(["--dir", path.join(dir, ".agentstate-lite")]);
    assert.equal(receipt.init, "ok");
    assert.match(receipt.hint as string, /sync/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init OUTSIDE any git repo prints no hint", async () => {
  const dir = await tempDir();
  try {
    const receipt = await runInit(["--dir", path.join(dir, ".agentstate-lite")]);
    assert.equal(receipt.init, "ok");
    assert.equal("hint" in receipt, false, "no git repo up-tree → no hint field at all");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insideGitRepo is a pure fs walk: true at/below a `.git` ancestor, false at the fs root path", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    assert.equal(insideGitRepo(dir), true);
    assert.equal(insideGitRepo(path.join(dir, "a", "b", "c")), true, "missing intermediate dirs are fine — the walk only reads");
    assert.equal(insideGitRepo(path.join(dir, "..", "definitely-absent-" + Date.now())), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
