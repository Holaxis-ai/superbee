// Named git boards: a repository can carry more boards than the default `board` branch. A named
// board lives on `board-<name>`, declares itself with a committed `.superbee-board.json`, and is
// used from a standalone checkout of that branch. Every per-checkout op (fetch/rebase/push/count)
// must address the checkout's own branch and never touch `origin/board`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOARD_MARKER_FILE,
  boardBranchOf,
  boardRefOf,
  declaredBoardBranchAtRef,
  fetchRebaseResolving,
  ffPull,
  healStaleRebaseBeforeProvisioning,
  isBoardBranchName,
  isBoardGitError,
  isDeclaredBoardBranch,
  isRecoverableStandaloneBoardCheckout,
  provisionBoardWorktree,
  push,
  resolveOriginRef,
  resolveProvisionedBoardPath,
  resolveStandaloneBoardCheckout,
  stageAndCommit,
  unpushedCount,
} from "../src/index.js";
import {
  BOARD_BRANCH,
  BUNDLE_DIR,
  git,
  gitTry,
  makeTwoCloneTopology,
  modifyBoardDoc,
  publishNamedBoard,
  type BoardRepo,
} from "./git-harness.js";

const NAME = "board-fairport";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw");
}

function cloneNamed(topo: { dir: string; origin: string }, name: string, as: string): string {
  const root = path.join(topo.dir, as);
  git(topo.dir, ["clone", "--no-local", "--branch", name, topo.origin, root]);
  return root;
}

test("named boards: branch names are board or lowercase board-<name>", () => {
  for (const ok of ["board", "board-fairport", "board-a", "board-fairport-ny", "board-2026"]) {
    assert.equal(isBoardBranchName(ok), true, ok);
  }
  for (const bad of ["main", "boards", "board-", "board--x", "board-X", "board/x", "board-x/y", "board-x-", "board-x.lock", "content", ""]) {
    assert.equal(isBoardBranchName(bad), false, bad);
  }
});

test("named boards: a standalone clone of a declared board-<name> branch is its own board", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    publishNamedBoard(topo, NAME);
    const root = cloneNamed(topo, NAME, "fairport");

    assert.equal(declaredBoardBranchAtRef(root, "HEAD"), NAME);
    assert.equal(isDeclaredBoardBranch(root, NAME), true);
    assert.equal(boardBranchOf(root), NAME);
    assert.equal(boardRefOf(root), `origin/${NAME}`);
    assert.equal(resolveStandaloneBoardCheckout(root), root);
    assert.equal(resolveProvisionedBoardPath(root), root);
    assert.deepEqual(provisionBoardWorktree(root, { allowLocalBranch: false, ensureIgnore: true }), {
      kind: "already",
      boardPath: root,
    });
    assert.equal(existsSync(path.join(root, BUNDLE_DIR)), false, "never creates a nested bundle worktree");
    assert.equal(resolveOriginRef(root), git(topo.origin, ["rev-parse", NAME]).trim());
  } finally {
    await topo.cleanup();
  }
});

test("named boards: commit, rebase and push move only origin/board-<name>", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    publishNamedBoard(topo, NAME);
    const a = cloneNamed(topo, NAME, "fairport-a");
    const b = cloneNamed(topo, NAME, "fairport-b");
    const boardBefore = git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim();

    await modifyBoardDoc({ name: "a", root: a, board: a }, "tasks/seed-one", { body: "# From A\n" });
    assert.equal(stageAndCommit(a).committed, true);
    assert.equal(fetchRebaseResolving(a, mkdtempSync(path.join(tmpdir(), "named-exports-"))).status, "clean");
    assert.equal(unpushedCount(a), 1);
    push(a);
    assert.equal(unpushedCount(a), 0);
    assert.equal(git(topo.origin, ["rev-parse", NAME]).trim(), git(a, ["rev-parse", "HEAD"]).trim());
    assert.equal(git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim(), boardBefore, "the default board is untouched");

    // A second writer rebases onto origin/board-fairport (not origin/board) and pushes on top.
    await modifyBoardDoc({ name: "b", root: b, board: b }, "tasks/seed-two", { body: "# From B\n" });
    assert.equal(stageAndCommit(b).committed, true);
    assert.equal(fetchRebaseResolving(b, mkdtempSync(path.join(tmpdir(), "named-exports-"))).status, "clean");
    push(b);
    assert.equal(git(topo.origin, ["rev-parse", NAME]).trim(), git(b, ["rev-parse", "HEAD"]).trim());
    assert.equal(gitTry(topo.origin, ["merge-base", "--is-ancestor", git(a, ["rev-parse", "HEAD"]).trim(), NAME]).status, 0);

    const pulled = ffPull(a);
    assert.equal(pulled.updated, true);
    assert.equal(git(a, ["rev-parse", "HEAD"]).trim(), git(topo.origin, ["rev-parse", NAME]).trim());
    assert.equal(git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim(), boardBefore, "the default board is untouched");
  } finally {
    await topo.cleanup();
  }
});

test("named boards: an undeclared or mis-declared board-<name> checkout is refused, not adopted", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const cases: Array<{ name: string; marker: string | null; why: string }> = [
      { name: "board-nomarker", marker: null, why: "no marker" },
      { name: "board-other", marker: `${JSON.stringify({ schema: 1, branch: "board-elsewhere" })}\n`, why: "marker names another branch" },
      { name: "board-schema", marker: `${JSON.stringify({ schema: 2, branch: "board-schema" })}\n`, why: "unknown schema" },
      { name: "board-garbage", marker: "{not json\n", why: "unparseable marker" },
      { name: "board-default", marker: `${JSON.stringify({ schema: 1, branch: "board" })}\n`, why: "marker names the default board" },
      { name: "board-huge", marker: `${JSON.stringify({ schema: 1, branch: "board-huge", pad: "x".repeat(5000) })}\n`, why: "oversized marker" },
    ];
    for (const c of cases) {
      publishNamedBoard(topo, c.name, c.marker);
      const root = cloneNamed(topo, c.name, `refused-${c.name}`);
      assert.equal(isDeclaredBoardBranch(root, c.name), false, c.why);
      assert.equal(boardBranchOf(root), BOARD_BRANCH, `${c.why}: ops fall back to the default board name`);
      assert.equal(resolveStandaloneBoardCheckout(root), null, c.why);
      const err = capture(() => provisionBoardWorktree(root, { allowLocalBranch: false }));
      assert.ok(isBoardGitError(err), c.why);
      assert.equal(err.code, "CONFLICT", c.why);
      assert.equal(err.details?.state, "standalone-board-wrong-branch", c.why);
      assert.equal(existsSync(path.join(root, BUNDLE_DIR)), false, c.why);
    }

    // A declared clone renamed locally loses its authority: the marker names the remote branch.
    publishNamedBoard(topo, NAME);
    const renamed = cloneNamed(topo, NAME, "renamed");
    git(renamed, ["branch", "-m", NAME, "board-renamed"]);
    assert.equal(resolveStandaloneBoardCheckout(renamed), null);
    assert.equal(isDeclaredBoardBranch(renamed, "board-renamed"), false);
  } finally {
    await topo.cleanup();
  }
});

test("named boards: a symlinked marker cannot declare a board", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const seed = path.join(topo.dir, "symlink-seed");
    git(topo.dir, ["clone", "--no-local", "--branch", BOARD_BRANCH, topo.origin, seed]);
    git(seed, ["checkout", "-b", "board-link"]);
    writeFileSync(path.join(seed, "marker-target.json"), `${JSON.stringify({ schema: 1, branch: "board-link" })}\n`);
    symlinkSync("marker-target.json", path.join(seed, BOARD_MARKER_FILE));
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "symlinked marker"]);
    assert.equal(declaredBoardBranchAtRef(seed, "HEAD"), null);
    assert.equal(isDeclaredBoardBranch(seed, "board-link"), false);
  } finally {
    await topo.cleanup();
  }
});

test("named boards: a crashed rebase on a named board is recognized and healed in place", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    publishNamedBoard(topo, NAME);
    const upstream = cloneNamed(topo, NAME, "named-upstream");
    const wedged = cloneNamed(topo, NAME, "named-wedged");
    const up: BoardRepo = { name: "up", root: upstream, board: upstream };
    const local: BoardRepo = { name: "local", root: wedged, board: wedged };

    await modifyBoardDoc(up, "tasks/seed-one", { frontmatter: { actor: "alice" }, body: "# Upstream\n" });
    stageAndCommit(upstream);
    push(upstream);
    await modifyBoardDoc(local, "tasks/seed-one", { frontmatter: { actor: "bob" }, body: "# Local\n" });
    stageAndCommit(wedged);
    const localHead = git(wedged, ["rev-parse", "HEAD"]).trim();
    git(wedged, ["fetch", "origin"]);
    assert.notEqual(gitTry(wedged, ["rebase", `origin/${NAME}`]).status, 0, "fixture is genuinely mid-rebase");

    assert.equal(boardBranchOf(wedged), NAME, "a detached mid-rebase checkout keeps its board branch");
    assert.equal(isRecoverableStandaloneBoardCheckout(wedged), true);
    healStaleRebaseBeforeProvisioning(wedged);
    assert.equal(git(wedged, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), NAME);
    assert.equal(git(wedged, ["rev-parse", "HEAD"]).trim(), localHead);
  } finally {
    await topo.cleanup();
  }
});

test("named boards: the default board's checkouts are unchanged", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    publishNamedBoard(topo, NAME);
    // The conventional worktree and a standalone `board` clone keep syncing origin/board, even
    // in a repository that also carries a named board.
    assert.equal(boardBranchOf(topo.a.board), BOARD_BRANCH);
    assert.equal(boardRefOf(topo.a.board), `origin/${BOARD_BRANCH}`);
    const standalone = path.join(topo.dir, "default-standalone");
    git(topo.dir, ["clone", "--no-local", "--branch", BOARD_BRANCH, topo.origin, standalone]);
    assert.equal(boardBranchOf(standalone), BOARD_BRANCH);
    assert.equal(resolveStandaloneBoardCheckout(standalone), standalone);
    // The project checkout on `main` never reads a board branch from `main`.
    assert.equal(boardBranchOf(topo.a.root), BOARD_BRANCH);
  } finally {
    await topo.cleanup();
  }
});
