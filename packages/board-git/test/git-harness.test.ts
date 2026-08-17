/**
 * Self-test for the U0 git harness ([plans/sync-verb-implementation] §U0). The downstream sync
 * suites (U1/U2/…) don't exist yet, so this suite is the harness's acceptance proof: it builds the
 * two-clone topology, verifies the board worktree checks out with bundle content at its root, and
 * verifies EACH planted fixture is genuinely in the state it claims — the stale-rebase fixture
 * really has a `rebase-merge` dir, the `index.lock` fixture really blocks a git op, the
 * same-doc-divergence fixture really conflicts on rebase — then verifies teardown leaves nothing
 * behind. It also proves hermeticity: a host environment with GIT_DIR/GIT_WORK_TREE set does not
 * leak into a fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  BOARD_BRANCH,
  BUNDLE_DIR,
  git,
  gitTry,
  makeTwoCloneTopology,
  provisionBoard,
  writeBoardDoc,
  modifyBoardDoc,
  deleteBoardDoc,
  readBoardFile,
  commitBoard,
  boardHead,
  pushBoard,
  divergeSameDoc,
  divergeDifferentDoc,
  danglingCursorSha,
  wedgeMidRebase,
  isMidRebase,
  worktreeGitPath,
  holdIndexLock,
  plantDirtyUserCode,
  plantStagedUserCode,
  plantNonEmptyBundleDir,
  originBoardHead,
  type TwoCloneTopology,
} from "./git-harness.js";

/** git status --porcelain lines for a repo dir. */
function porcelain(dir: string): string[] {
  return git(dir, ["status", "--porcelain"]).split("\n").filter((l) => l.length > 0);
}

// ── topology shape ────────────────────────────────────────────────────────────

test("topology: two clones, each with a board worktree whose ROOT carries the bundle", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    // The scratch root is under os.tmpdir(), realpath'd — never the real repo.
    assert.ok(topo.dir.startsWith(await realpath(tmpdir())));
    assert.ok(existsSync(topo.origin));

    for (const repo of [topo.a, topo.b]) {
      // main is checked out at the clone root (user code present).
      assert.equal(git(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
      assert.ok(existsSync(path.join(repo.root, "src", "app.js")));
      // The board worktree exists at .superbee with the bundle root files.
      assert.ok(existsSync(path.join(repo.board, "index.md")), "reserved root index.md at board root");
      assert.ok(existsSync(path.join(repo.board, "tasks", "seed-one.md")), "seed doc at board root");
      assert.equal(git(repo.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), BOARD_BRANCH);
      // index.md is reserved and carries okf_version (gate 2).
      assert.match(await readBoardFile(repo, "index.md"), /okf_version/);
    }

    // Both clones and origin agree on the board tip at start.
    assert.equal(boardHead(topo.a), boardHead(topo.b));
    assert.equal(boardHead(topo.a), originBoardHead(topo));
  } finally {
    await topo.cleanup();
  }
});

test("topology: {provision:false} leaves the board un-checked-out; provisionBoard self-heals it", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    assert.ok(!existsSync(topo.a.board), "board worktree absent until provisioned");
    provisionBoard(topo.a);
    assert.ok(existsSync(path.join(topo.a.board, "index.md")));
    // The worktree registers as a real linked worktree, not a plain dir.
    assert.match(git(topo.a.root, ["worktree", "list"]), new RegExp(BUNDLE_DIR));
  } finally {
    await topo.cleanup();
  }
});

// ── user-code fixtures live on main, untouched by any board op ────────────────

test("user-code fixtures: dirty + staged code sit on the MAIN worktree", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const dirty = await plantDirtyUserCode(topo.a);
    const staged = await plantStagedUserCode(topo.a);
    const lines = porcelain(topo.a.root);
    assert.ok(lines.some((l) => l.startsWith(" M") && l.includes(dirty)), "unstaged modification present");
    assert.ok(lines.some((l) => l.startsWith("A ") && l.includes(staged)), "staged addition present");
    // The board worktree is a SEPARATE tree — clean and unaffected.
    assert.equal(porcelain(topo.a.board).length, 0);
  } finally {
    await topo.cleanup();
  }
});

// ── new / modified / deleted docs ─────────────────────────────────────────────

test("board docs: new/modified/deleted are planted UNCOMMITTED in the board worktree", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeBoardDoc(topo.a, "tasks/fresh", { frontmatter: { type: "Task", title: "Fresh" }, body: "# Fresh\n" });
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nEDITED\n" });
    await deleteBoardDoc(topo.a, "notes/welcome");

    const lines = porcelain(topo.a.board);
    assert.ok(lines.some((l) => l.startsWith("??") && l.includes("tasks/fresh.md")), "new doc untracked");
    assert.ok(lines.some((l) => l.startsWith(" M") && l.includes("tasks/seed-one.md")), "modified doc");
    assert.ok(lines.some((l) => l.startsWith(" D") && l.includes("notes/welcome.md")), "deleted doc");
    assert.match(await readBoardFile(topo.a, "tasks/seed-one.md"), /EDITED/);

    // commitBoard stages -A and commits; a distinct git author is honored.
    const head = commitBoard(topo.a, "board: churn", { author: { name: "carol", email: "carol@example.invalid" } });
    assert.equal(git(topo.a.board, ["log", "-1", "--format=%an", head]).trim(), "carol");
    assert.equal(porcelain(topo.a.board).length, 0, "clean after commit");
  } finally {
    await topo.cleanup();
  }
});

// ── divergent histories ───────────────────────────────────────────────────────

test("divergeDifferentDoc: B's rebase onto origin/board replays cleanly (no conflict)", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await divergeDifferentDoc(topo);
    const r = gitTry(topo.b.board, ["rebase", `origin/${BOARD_BRANCH}`]);
    assert.equal(r.status, 0, "different-doc edits do not conflict");
    assert.ok(!isMidRebase(topo.b), "rebase finished");
  } finally {
    await topo.cleanup();
  }
});

test("divergeSameDoc: B's rebase onto origin/board CONFLICTS on the shared doc; clean abort restores it", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const d = await divergeSameDoc(topo);
    const r = gitTry(topo.b.board, ["rebase", `origin/${BOARD_BRANCH}`]);
    assert.notEqual(r.status, 0, "same-doc edits conflict");
    const conflicted = git(topo.b.board, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    assert.deepEqual(conflicted, [d.docPath], "the shared doc is the (only) conflicted path");
    // A clean abort leaves the worktree pristine (the U1 detect+abort contract).
    git(topo.b.board, ["rebase", "--abort"]);
    assert.ok(!isMidRebase(topo.b));
    assert.equal(porcelain(topo.b.board).length, 0, "worktree pristine after abort");
  } finally {
    await topo.cleanup();
  }
});

// ── dangling cursor SHA ───────────────────────────────────────────────────────

test("danglingCursorSha: the returned sha is genuinely gone from the object store", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const live = boardHead(topo.a);
    const gone = await danglingCursorSha(topo.a);
    assert.notEqual(gone, live);
    // A live commit resolves; the rewritten-out one does not (the re-anchor guard's trigger).
    assert.equal(gitTry(topo.a.board, ["cat-file", "-e", `${live}^{commit}`]).status, 0);
    assert.notEqual(gitTry(topo.a.board, ["cat-file", "-e", `${gone}^{commit}`]).status, 0);
  } finally {
    await topo.cleanup();
  }
});

// ── stale mid-rebase ──────────────────────────────────────────────────────────

test("wedgeMidRebase: clone B is left wedged mid-rebase with a real rebase-merge dir; abort clears it", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await wedgeMidRebase(topo);
    assert.ok(isMidRebase(topo.b), "rebase-merge present");
    assert.ok(existsSync(worktreeGitPath(topo.b, "rebase-merge")));
    // The state is abortable (what sync entry does to self-heal).
    git(topo.b.board, ["rebase", "--abort"]);
    assert.ok(!isMidRebase(topo.b));
  } finally {
    await topo.cleanup();
  }
});

// ── held index.lock (concurrent-sync / GIT_BUSY) ──────────────────────────────

test("holdIndexLock: a held index.lock blocks an index-touching git op until released", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeBoardDoc(topo.a, "tasks/blocked", { frontmatter: { type: "Task", title: "Blocked" }, body: "# Blocked\n" });
    const lock = holdIndexLock(topo.a);
    assert.ok(existsSync(lock.lockPath));
    const blocked = gitTry(topo.a.board, ["add", "-A"]);
    assert.notEqual(blocked.status, 0, "git refuses while the lock is held");
    assert.match(blocked.stderr, /index\.lock|File exists/i, "the GIT_BUSY signal");
    lock.release();
    assert.equal(gitTry(topo.a.board, ["add", "-A"]).status, 0, "succeeds once released");
    // Double release is a no-op.
    lock.release();
  } finally {
    await topo.cleanup();
  }
});

// ── non-empty unprovisioned bundle dir ────────────────────────────────────────

test("plantNonEmptyBundleDir: a non-empty, non-worktree .superbee makes worktree add refuse", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    await plantNonEmptyBundleDir(topo.a);
    assert.ok(existsSync(path.join(topo.a.board, "stray.md")));
    // It is NOT a registered worktree...
    assert.doesNotMatch(git(topo.a.root, ["worktree", "list"]), new RegExp(BUNDLE_DIR));
    // ...and a blind `worktree add` into it fails (the case U1 must resolve-or-refuse).
    git(topo.a.root, ["fetch", "origin"]);
    const r = gitTry(topo.a.root, ["worktree", "add", "--no-track", "-b", BOARD_BRANCH, topo.a.board, `origin/${BOARD_BRANCH}`]);
    assert.notEqual(r.status, 0, "worktree add refuses a non-empty target");
  } finally {
    await topo.cleanup();
  }
});

// ── hermeticity + teardown ────────────────────────────────────────────────────

test("hermetic: a host env with GIT_DIR/GIT_WORK_TREE set does not leak into a fixture", async () => {
  const saved = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = "/nonexistent/leaked.git";
  process.env.GIT_WORK_TREE = "/nonexistent/leaked-tree";
  let topo: TwoCloneTopology | undefined;
  try {
    // If the scrub failed, `git init` would honor the bogus inherited GIT_DIR and blow up.
    topo = await makeTwoCloneTopology();
    assert.ok(existsSync(path.join(topo.a.board, "index.md")));
  } finally {
    if (topo) await topo.cleanup();
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.work === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.work;
  }
});

test("teardown: cleanup removes the entire scratch tree", async () => {
  const topo = await makeTwoCloneTopology();
  await writeBoardDoc(topo.a, "tasks/x", { frontmatter: { type: "Task", title: "X" }, body: "# X\n" });
  commitBoard(topo.a, "board: x");
  pushBoard(topo.a);
  const dir = topo.dir;
  assert.ok((await stat(dir)).isDirectory());
  await topo.cleanup();
  assert.ok(!existsSync(dir), "nothing left behind");
});
