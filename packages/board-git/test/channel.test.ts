/**
 * PR B acceptance suite for `src/channel.ts` — the FULL detection matrix from
 * plans/board-git-package ("The BoardChannel seam"), each row a deterministic test over a
 * constructed git state. NO real network anywhere: remotes are local file paths; "unreachable"
 * is a path under the scratch dir that doesn't exist (a dead probe, by construction).
 *
 * The rows this suite pins (matrix row → test):
 *   1. worktree signature (healthy / wedged mid-rebase / stale pointers) → `branch`, remote
 *      NEVER probed — including the historical misclassification regression (a wedged board has
 *      a detached HEAD, so anything keyed on `isProvisioned` would misread it);
 *   2. tracked folder + remote board seeded from it → the pre-share-window refusal, proven
 *      VERBATIM-identical to `provisionBoardWorktree`'s (one shared factory, asserted here);
 *   3. tracked folder + VERIFIED foreign remote board → typed dual-board CONFLICT;
 *   4. tracked folder + remote definitively absent → `in-tree` (the supported read-side channel);
 *   5. tracked folder + remote unknown → typed indeterminate (NEVER in-tree, NEVER absent);
 *   6. untracked + local `board` branch → `branch` (join/provision `local_board` path, no probe);
 *   7. untracked + remote board exists (live or previously fetched evidence) → `branch` (JOIN);
 *   8. untracked + remote definitively absent → `local-only`;
 *   9. untracked + remote unknown → typed indeterminate (NEVER local-only);
 *  10. no git repo → `local-only`.
 * Plus: the probe's evidence model unit-tested, detection's read-only guarantee, the injected
 * probe seam, in-tree's conventional-folder-only scoping, and the out-of-matrix judgment rows
 * (unverifiable-dual → pull-first arm; tracked + local-branch remnant → in-tree).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  git,
  gitTry,
  BUNDLE_DIR,
  initPlainBundleDir,
  isMidRebase,
  makeCommittedFolderTopology,
  makeGreenfieldTopology,
  makeTwoCloneTopology,
  wedgeMidRebase,
  type TwoCloneTopology,
} from "./git-harness.js";

import {
  BOARD_BRANCH,
  BOARD_REMOTE,
  INDETERMINATE_TRACKED_REASON,
  INDETERMINATE_UNTRACKED_REASON,
  detectBoardChannel,
  isBoardGitError,
  probeRemoteBoardState,
  provisionBoardWorktree,
  type ChannelDetection,
  type RemoteBoardState,
} from "../src/index.js";

// Hermetic ambient env (detection's porcelain inherits process.env; neutralize host git config).
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Channel Suite";
process.env.GIT_AUTHOR_EMAIL = "channel@example.invalid";
process.env.GIT_COMMITTER_NAME = "Channel Suite";
process.env.GIT_COMMITTER_EMAIL = "channel@example.invalid";

/** A probe that must never be consulted for the row under test. */
const probeMustNotRun = (top: string): RemoteBoardState => {
  throw new Error(`the remote probe must not run for this row (called with ${top})`);
};

/** Point the clone's `origin` at a path that doesn't exist — a DEAD probe, deterministically. */
function deadenOrigin(topo: TwoCloneTopology, root: string): void {
  git(root, ["remote", "set-url", BOARD_REMOTE, path.join(topo.dir, "missing.git")]);
}

function assertBranch(d: ChannelDetection): void {
  // The branch channel's fields are the porcelain constants — the seam's stated defaults.
  assert.deepEqual(d, {
    kind: "channel",
    channel: { mode: "branch", branch: BOARD_BRANCH, remote: BOARD_REMOTE },
  });
  assert.equal(BOARD_BRANCH, "board");
  assert.equal(BOARD_REMOTE, "origin");
}

function assertLocalOnly(d: ChannelDetection): void {
  assert.deepEqual(d, { kind: "channel", channel: { mode: "local-only" } });
}

/** Run `fn`, asserting it throws, and RETURN the thrown value. */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

/** Root commit over the fixture's committed conventional folder — what establishment cuts. */
function boardRootFromCommittedFolder(root: string): string {
  const treeSha = git(root, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
  return git(root, ["commit-tree", treeSha, "-m", "board: bundle shared from 'main' (files only)"]).trim();
}

// ── row 1: the worktree-signature rows (branch, remote never probed) ─────────────

test("matrix: healthy provisioned board worktree → branch; remote never probed (incl. from a subdirectory)", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    assertBranch(detectBoardChannel(topo.a.root, { remoteBoardState: probeMustNotRun }));
    assertBranch(detectBoardChannel(path.join(topo.a.root, "src"), { remoteBoardState: probeMustNotRun }));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: wedged mid-rebase board worktree → branch (the heal-pipeline regression pin) — and detection heals nothing", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await wedgeMidRebase(topo);
    assert.ok(isMidRebase(topo.b), "fixture: clone B's board is wedged mid-rebase");
    // The historical misclassification: a rebase detaches HEAD, so `isProvisioned` reads false —
    // detection keys on the WEAK structural signature instead and must still say `branch`.
    assertBranch(detectBoardChannel(topo.b.root, { remoteBoardState: probeMustNotRun }));
    assert.ok(isMidRebase(topo.b), "detection is read-only — the wedge must survive it untouched");
  } finally {
    await topo.cleanup();
  }
});

test("matrix: stale worktree-side pointer (this repo's registration survives) → branch", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    // Break ONLY the worktree-side `.git` file; the registration under `<root>/.git/worktrees/`
    // still names the conventional path — the structural "ours, pointers stale" signal.
    await writeFile(
      path.join(topo.a.board, ".git"),
      `gitdir: ${path.join(topo.dir, "nonexistent", ".git", "worktrees", BUNDLE_DIR)}\n`,
    );
    assertBranch(detectBoardChannel(topo.a.root, { remoteBoardState: probeMustNotRun }));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: repo moved to a new path (the mount-move field finding) → still branch", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const moved = path.join(topo.dir, "A-moved");
    await rename(topo.a.root, moved);
    // Absolute worktree pointers break on a move (arm 2: the registration signal); a git that
    // wrote relative pointers survives the move (arm 1). Either way the channel is `branch`.
    assertBranch(detectBoardChannel(moved, { remoteBoardState: probeMustNotRun }));
  } finally {
    await topo.cleanup();
  }
});

test("foreign repo's worktree machinery parked at the conventional path is NOT rule-1 branch", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    // An unrelated repo's linked worktree at `<root>/.superbee`: worktree signature
    // present, but owned by a DIFFERENT common dir — rule 1 must not claim it. With no board
    // refs anywhere and a live-absent origin, the honest channel is local-only (provisioning
    // still owns the move-aside refusal for the path itself).
    const foreignRoot = path.join(topo.dir, "foreign");
    git(topo.dir, ["init", "-b", "main", foreignRoot]);
    await writeFile(path.join(foreignRoot, "f.txt"), "foreign\n");
    git(foreignRoot, ["add", "-A"]);
    git(foreignRoot, ["commit", "-m", "foreign initial"]);
    git(foreignRoot, ["worktree", "add", "-b", "parked", topo.a.board, "main"]);
    assertLocalOnly(detectBoardChannel(topo.a.root));
  } finally {
    await topo.cleanup();
  }
});

// ── rows 2–3: the tracked-folder error arms ──────────────────────────────────────

test("matrix: tracked folder + remote board seeded from it → the pre-share-window refusal, VERBATIM provisioning parity", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    const rootSha = boardRootFromCommittedFolder(topo.a.root);
    git(topo.a.root, ["push", BOARD_REMOTE, `${rootSha}:refs/heads/${BOARD_BRANCH}`]);
    git(topo.b.root, ["fetch", BOARD_REMOTE]);

    const detected = capture(() => detectBoardChannel(topo.b.root));
    assert.ok(isBoardGitError(detected), "detection throws the tier's typed error");
    assert.equal(detected.code, "RUNTIME");
    assert.equal((detected.details as Record<string, unknown>).state, "pre-share-window");
    assert.match(detected.message, /run 'git pull',\s*then run sync again/);

    // VERBATIM parity, empirically: the guidance is ONE factory shared with provisioning.
    const provisioned = capture(() => provisionBoardWorktree(topo.b.root, { allowLocalBranch: false }));
    assert.ok(isBoardGitError(provisioned));
    assert.equal(detected.message, provisioned.message);
    assert.equal(detected.help, provisioned.help);
    assert.deepEqual(detected.details, provisioned.details);
  } finally {
    await topo.cleanup();
  }
});

test("matrix: tracked folder + VERIFIED foreign remote board → typed dual-board CONFLICT with choice guidance", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    // A board branch on origin whose root tree is NOT this folder's tree (a board established
    // from something else entirely) — the genuinely-dual state.
    const foreignTree = git(topo.a.root, ["rev-parse", "HEAD^{tree}"]).trim();
    const foreignRoot = git(topo.a.root, ["commit-tree", foreignTree, "-m", "a foreign board"]).trim();
    git(topo.a.root, ["push", BOARD_REMOTE, `${foreignRoot}:refs/heads/${BOARD_BRANCH}`]);
    git(topo.b.root, ["fetch", BOARD_REMOTE]);

    const err = capture(() => detectBoardChannel(topo.b.root));
    assert.ok(isBoardGitError(err));
    assert.equal(err.code, "CONFLICT");
    assert.equal((err.details as Record<string, unknown>).state, "dual-board");
    assert.equal((err.details as Record<string, unknown>).path, topo.b.board);
    assert.match(err.message, /two competing board locations/);
    assert.match(err.help ?? "", /choose one explicitly/);
  } finally {
    await topo.cleanup();
  }
});

test("UNVERIFIABLE dual (origin/board never fetched) routes to the pull-first arm — the reviewer-proven safe default", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    const foreignTree = git(topo.a.root, ["rev-parse", "HEAD^{tree}"]).trim();
    const foreignRoot = git(topo.a.root, ["commit-tree", foreignTree, "-m", "a foreign board"]).trim();
    git(topo.a.root, ["push", BOARD_REMOTE, `${foreignRoot}:refs/heads/${BOARD_BRANCH}`]);
    // Clone B never fetches: the live probe proves the remote board EXISTS, but no local objects
    // can verify its root tree. Foreignness must be PROVEN before the dual arm fires; the
    // conservative default is today's pull-first guidance (a bare "move it aside" was proven
    // dangerous in exactly this window).
    const err = capture(() => detectBoardChannel(topo.b.root));
    assert.ok(isBoardGitError(err));
    assert.equal((err.details as Record<string, unknown>).state, "pre-share-window");
  } finally {
    await topo.cleanup();
  }
});

// ── rows 4–5: tracked folder, no error arm ───────────────────────────────────────

test("matrix: tracked folder + remote definitively absent → in-tree (the supported read-side channel)", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    // The bare origin exists and answers the live probe: no board ref → definitively absent.
    const d = detectBoardChannel(topo.a.root);
    assert.deepEqual(d, { kind: "channel", channel: { mode: "in-tree" } });
  } finally {
    await topo.cleanup();
  }
});

test("matrix: tracked folder + remote unknown → typed indeterminate — NEVER in-tree, NEVER absent (fail closed)", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    deadenOrigin(topo, topo.a.root);
    const d = detectBoardChannel(topo.a.root);
    assert.deepEqual(d, {
      kind: "indeterminate",
      probe: "remote-board",
      folderTracked: true,
      reason: INDETERMINATE_TRACKED_REASON,
    });
  } finally {
    await topo.cleanup();
  }
});

test("tracked folder + local board-branch remnant + remote absent → still in-tree (establishment recovery owns remnants)", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    // The remnant of an interrupted committed-folder establishment: the local root commit was
    // cut, the push never landed. The CHANNEL is where the board lives NOW (the committed
    // folder); the remnant's reuse/refusal policy stays with establish's own marker-based
    // recovery — a local branch name is not adopted as the channel for a tracked folder.
    const rootSha = boardRootFromCommittedFolder(topo.a.root);
    git(topo.a.root, ["branch", BOARD_BRANCH, rootSha]);
    const d = detectBoardChannel(topo.a.root);
    assert.deepEqual(d, { kind: "channel", channel: { mode: "in-tree" } });
  } finally {
    await topo.cleanup();
  }
});

// ── rows 6–9: the untracked rows ─────────────────────────────────────────────────

test("matrix: untracked + local board branch (join/provision local_board path) → branch, remote never probed", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    git(topo.a.root, ["branch", BOARD_BRANCH, `${BOARD_REMOTE}/${BOARD_BRANCH}`]);
    assertBranch(detectBoardChannel(topo.a.root, { remoteBoardState: probeMustNotRun }));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: untracked + UNPUBLISHED local board branch (no remote board anywhere) → branch, remote never probed", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    // A branch merely NAMED board (adoption policy — refusing to guess whether it is safe —
    // stays with provisioning's `local_board` outcome; the channel is the branch tier).
    git(topo.a.root, ["branch", BOARD_BRANCH]);
    assertBranch(detectBoardChannel(topo.a.root, { remoteBoardState: probeMustNotRun }));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: untracked + origin/board exists → branch (JOIN), live and from previously fetched evidence offline", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    assertBranch(detectBoardChannel(topo.a.root));
    // Offline join fidelity: a dead probe with previously fetched evidence still reads exists —
    // exactly the evidence provisioning already provisions from offline.
    deadenOrigin(topo, topo.a.root);
    assertBranch(detectBoardChannel(topo.a.root));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: untracked + remote definitively absent → local-only (a planted local bundle doesn't change the channel)", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    assertLocalOnly(detectBoardChannel(topo.a.root));
    await initPlainBundleDir(topo.a);
    assertLocalOnly(detectBoardChannel(topo.a.root));
  } finally {
    await topo.cleanup();
  }
});

test("matrix: untracked + remote unknown → typed indeterminate — NEVER local-only (fail closed)", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    deadenOrigin(topo, topo.a.root);
    const d = detectBoardChannel(topo.a.root);
    assert.deepEqual(d, {
      kind: "indeterminate",
      probe: "remote-board",
      folderTracked: false,
      reason: INDETERMINATE_UNTRACKED_REASON,
    });
  } finally {
    await topo.cleanup();
  }
});

test("deleted remote board: live absence overrides stale fetched evidence → local-only, and detection mutates NOTHING", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    git(topo.origin, ["branch", "-D", BOARD_BRANCH]);
    const staleRef = ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REMOTE}/${BOARD_BRANCH}`];
    assert.equal(gitTry(topo.a.root, staleRef).status, 0, "fixture: the stale fetched ref exists");
    assertLocalOnly(detectBoardChannel(topo.a.root));
    // Provisioning DELETES the stale ref when the live probe proves absence; detection must not.
    assert.equal(gitTry(topo.a.root, staleRef).status, 0, "detection is read-only — the stale ref survives");
  } finally {
    await topo.cleanup();
  }
});

// ── row 10 + the probe seam ──────────────────────────────────────────────────────

test("matrix: no git repo (and a nonexistent dir) → local-only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-channel-norepo-"));
  try {
    assertLocalOnly(detectBoardChannel(dir, { remoteBoardState: probeMustNotRun }));
    assertLocalOnly(detectBoardChannel(path.join(dir, "never-created"), { remoteBoardState: probeMustNotRun }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-tree detection scopes to the conventional folder ONLY — a bundle committed elsewhere is not in-tree", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    await mkdir(path.join(topo.a.root, "boards", "x"), { recursive: true });
    await writeFile(path.join(topo.a.root, "boards", "x", "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "a bundle committed at a non-conventional path"]);
    assertLocalOnly(detectBoardChannel(topo.a.root));
  } finally {
    await topo.cleanup();
  }
});

test("the injected probe replaces the real one and receives the repo top", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    let seen: string | null = null;
    const d = detectBoardChannel(topo.a.root, {
      remoteBoardState: (top) => {
        seen = top;
        return "exists";
      },
    });
    // No board exists anywhere in this topology; the injected answer alone drove the JOIN row.
    assertBranch(d);
    assert.equal(seen, topo.a.root);
  } finally {
    await topo.cleanup();
  }
});

test("probeRemoteBoardState: the full evidence model (live wins; dead probes fall back to evidence; never absent off a dead probe)", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const top = topo.a.root;
    assert.equal(probeRemoteBoardState(top), "exists", "live probe: the ref exists on origin");

    git(topo.origin, ["branch", "-D", BOARD_BRANCH]);
    assert.equal(probeRemoteBoardState(top), "absent", "a SUCCESSFUL probe saying no-such-ref beats stale evidence");

    deadenOrigin(topo, top);
    assert.equal(probeRemoteBoardState(top), "exists", "dead probe + previously fetched evidence → exists");

    git(top, ["update-ref", "-d", `refs/remotes/${BOARD_REMOTE}/${BOARD_BRANCH}`]);
    assert.equal(probeRemoteBoardState(top), "unknown", "dead probe + no evidence → unknown, NEVER absent");

    git(top, ["remote", "remove", BOARD_REMOTE]);
    assert.equal(probeRemoteBoardState(top), "absent", "no origin remote at all → structurally absent");

    git(top, ["update-ref", `refs/remotes/${BOARD_REMOTE}/${BOARD_BRANCH}`, git(top, ["rev-parse", "HEAD"]).trim()]);
    assert.equal(probeRemoteBoardState(top), "exists", "no remote but leftover fetched evidence → exists");
  } finally {
    await topo.cleanup();
  }
});
