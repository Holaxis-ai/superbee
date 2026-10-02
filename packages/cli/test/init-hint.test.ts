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
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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

/** Run plain init (no --dir) from `cwd`, the way a person types it. */
async function runPlainInit(cwd: string): Promise<Record<string, unknown>> {
  const before = process.cwd();
  process.chdir(cwd);
  try {
    return await runInit([]);
  } finally {
    process.chdir(before);
  }
}

test("plain init inside a Git work tree makes the top's .superbee/, the folder establish shares, from any depth", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    const below = path.join(dir, "src", "app");
    await mkdir(below, { recursive: true });
    const receipt = await runPlainInit(below);
    assert.equal(await realpath(receipt.root as string), await realpath(path.join(dir, ".superbee")));
    assert.match(receipt.hint as string, /sync --establish/);
    assert.equal(existsSync(path.join(dir, "index.md")), false, "nothing lands at the work tree's top");
    assert.equal(existsSync(path.join(below, "index.md")), false);
    // Again from the top: it opens the same bundle rather than nesting a second.
    assert.equal(await realpath((await runPlainInit(dir)).root as string), await realpath(path.join(dir, ".superbee")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain init opens the nearest bundle up to the work tree's top, never splitting the project in two", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    await runInit(["--dir", path.join(dir, "notes")]);
    const deep = path.join(dir, "notes", "deep");
    await mkdir(deep);
    for (const cwd of [path.join(dir, "notes"), deep]) {
      const receipt = await runPlainInit(cwd);
      assert.equal(await realpath(receipt.root as string), await realpath(path.join(dir, "notes")), cwd);
      // A bundle that is not the work tree's .superbee/ is never told to establish; it is told how.
      assert.doesNotMatch(receipt.hint as string, /sync --establish/);
      assert.match(receipt.hint as string, /init --dir .*\.superbee/);
    }
    assert.equal(existsSync(path.join(dir, ".superbee")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bundle already at the work tree's top keeps opening from below, and its hint names the move", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    await runInit(["--dir", dir]);
    await mkdir(path.join(dir, "sub"));
    const receipt = await runPlainInit(path.join(dir, "sub"));
    assert.equal(await realpath(receipt.root as string), await realpath(dir));
    assert.equal(existsSync(path.join(dir, ".superbee")), false, "no second bundle nested inside the first");
    assert.match(receipt.hint as string, /move the bundle at the work tree's top into \.superbee\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inside an established board folder (a linked worktree with its own .git file) plain init opens it", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    await runInit(["--dir", path.join(dir, ".superbee")]);
    await writeFile(path.join(dir, ".superbee", ".git"), "gitdir: ../.git/worktrees/board\n");
    await mkdir(path.join(dir, ".superbee", "tasks"));
    const receipt = await runPlainInit(path.join(dir, ".superbee", "tasks"));
    assert.equal(await realpath(receipt.root as string), await realpath(path.join(dir, ".superbee")));
    assert.equal(existsSync(path.join(dir, ".superbee", ".superbee")), false);
    assert.match(receipt.hint as string, /shared board/);
    assert.doesNotMatch(receipt.hint as string, /--establish/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--create-only with no --dir inside a Git work tree creates the top's .superbee/ too", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".git"));
    await mkdir(path.join(dir, "src"));
    const before = process.cwd();
    process.chdir(path.join(dir, "src"));
    let receipt: Record<string, unknown>;
    try {
      receipt = await runInit(["--create-only"]);
    } finally {
      process.chdir(before);
    }
    assert.equal(await realpath(receipt.root as string), await realpath(path.join(dir, ".superbee")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain init outside Git still makes the bundle in the current directory", async () => {
  const dir = await tempDir();
  try {
    const receipt = await runPlainInit(dir);
    assert.equal(await realpath(receipt.root as string), await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
