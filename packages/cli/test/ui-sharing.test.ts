/**
 * Sharing-chip classifier truth table (designs/home-surface; plans/home-surface-build PR-B) over
 * REAL temp git repos — every state row pinned, including the two FABRICATION cases the design
 * review caught (a wrong "shared" for an in-tree bundle with no remote, and for a local-only
 * board branch): those rows are the reason this classifier exists, so they are asserted
 * explicitly against the shared kinds. Offline throughout — no row performs a network operation
 * (the classifier is local-evidence-only by design).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifySharing, createSharingLoader, createWorkspacesLoader, humanizeRemote } from "../src/ui/sharing.js";
import { credentialsDir } from "../src/credentials.js";
import { ensureUserStateRoot } from "../src/user-state.js";
import { withIsolatedUserEnv } from "./support/user-env.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-sharing-"));
  return dir;
}

/** Init a git repo with one commit so HEAD exists (identity pinned local to the repo). */
function initRepo(dir: string): void {
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  execFileSync("git", ["commit", "--allow-empty", "-m", "root"], { cwd: dir, stdio: "ignore" });
}

async function conventionalBoard(dir: string): Promise<string> {
  const board = path.join(dir, ".agentstate-lite");
  await mkdir(board, { recursive: true });
  await writeFile(path.join(board, "index.md"), "---\nokf_version: '0.1'\n---\n");
  return board;
}

/** Fabricate LOCAL evidence that origin/board was fetched (no network: a plain ref write). */
function fakeFetchedBoardRef(dir: string): void {
  git(dir, "update-ref", "refs/remotes/origin/board", "HEAD");
}

test("no git repo at all → private (a plain folder shares nothing)", async () => {
  const dir = await tempProject();
  try {
    const board = await conventionalBoard(dir);
    assert.equal(classifySharing(board).kind, "private");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FABRICATION GUARD: a broken repository probe is unavailable, never private", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    await writeFile(path.join(dir, ".git", "config"), "[broken\n");
    const summary = classifySharing(board);
    assert.equal(summary.kind, "unavailable");
    assert.match(String(summary.reason), /repository discovery failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sharing loader publishes its positive cache lifetime for client re-evaluation", async () => {
  const dir = await tempProject();
  try {
    const board = await conventionalBoard(dir);
    const summary = await createSharingLoader(board, 1_234)();
    assert.equal(summary.kind, "private");
    assert.equal(summary.refresh_after_ms, 1_234);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WRONG-TARGET guard: a non-conventional --dir bundle inside a repo makes NO claim (unscoped)", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const elsewhere = path.join(dir, "examples", "sample-bundle");
    await mkdir(elsewhere, { recursive: true });
    assert.equal(classifySharing(elsewhere).kind, "unscoped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untracked conventional board, no board evidence → private", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    assert.equal(classifySharing(board).kind, "private");
    // An origin CODE remote alone is not a shared board.
    git(dir, "remote", "add", "origin", "https://github.com/org/repo.git");
    assert.equal(classifySharing(board).kind, "private");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every summary carries as_of (pinned on the private row)", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    const summary = classifySharing(board);
    assert.equal(summary.kind, "private");
    assert.ok(summary.as_of, "every summary carries as_of");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FABRICATION GUARD: a local-only board branch is private_local_branch, never shared", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    git(dir, "branch", "board");
    // No remote at all:
    assert.equal(classifySharing(board).kind, "private_local_branch");
    // Even WITH a code remote — no fetched board ref means the branch never left this machine:
    git(dir, "remote", "add", "origin", "https://github.com/org/repo.git");
    assert.equal(classifySharing(board).kind, "private_local_branch");
    // Fetched evidence flips it:
    fakeFetchedBoardRef(dir);
    assert.equal(classifySharing(board).kind, "shared_branch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FABRICATION GUARD: tracked in-tree bundle with NO remote is private_intree_no_remote, never shared", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    git(dir, "add", ".agentstate-lite");
    execFileSync("git", ["commit", "-m", "commit board with code"], { cwd: dir, stdio: "ignore" });
    assert.equal(classifySharing(board).kind, "private_intree_no_remote");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FABRICATION GUARD (review F-1): in-tree commits that never reached the upstream are NOT shared", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    git(dir, "add", ".agentstate-lite");
    execFileSync("git", ["commit", "-m", "commit board with code"], { cwd: dir, stdio: "ignore" });
    git(dir, "remote", "add", "origin", "https://gitlab.example.com/team/project.git");
    // A code remote with NO tracking upstream: no evidence anything was shared.
    assert.equal(classifySharing(board).kind, "private_intree_not_pushed");
    // Tracking config pointing at a fetched upstream that PREDATES the folder (the root commit):
    // still not shared — the folder is not on the upstream tree.
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    git(dir, "config", "branch.main.remote", "origin");
    git(dir, "config", "branch.main.merge", "refs/heads/main");
    assert.equal(classifySharing(board).kind, "private_intree_not_pushed");
    // The upstream catching up (folder present on the fetched tracking ref) flips it to shared —
    // named by the TRACKING remote, as of the last fetch.
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const summary = classifySharing(board);
    assert.equal(summary.kind, "shared_intree");
    assert.equal(summary.remote, "team/project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untracked local folder + fetched origin/board (provisioning's foreign-dir zone) → unavailable, never shared (review F-2)", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    git(dir, "remote", "add", "origin", "https://github.com/org/repo.git");
    fakeFetchedBoardRef(dir);
    // The folder exists locally (it is being SERVED) but is not the provisioned board worktree —
    // its docs never left this machine; the shared board is a different copy.
    const summary = classifySharing(board);
    assert.equal(summary.kind, "unavailable");
    assert.match(String(summary.reason), /not connected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a REAL provisioned board worktree (git worktree add) classifies through the branch arm (review F-7)", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    // Provision the way the product does: a board branch checked out as a linked worktree at the
    // conventional path.
    git(dir, "branch", "board");
    git(dir, "worktree", "add", path.join(dir, ".agentstate-lite"), "board");
    const board = path.join(dir, ".agentstate-lite");
    await writeFile(path.join(board, "index.md"), "---\nokf_version: 0.2\n---\n");
    // No remote: a real worktree that never left this machine.
    assert.equal(classifySharing(board).kind, "private_local_branch");
    // Remote + fetched board evidence: shared.
    git(dir, "remote", "add", "origin", "git@github.com:org/repo.git");
    fakeFetchedBoardRef(dir);
    const summary = classifySharing(board);
    assert.equal(summary.kind, "shared_branch");
    assert.equal(summary.remote, "org/repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracked folder + fetched origin/board (the pre-share/dual zone) → unavailable with a reason, never a guess", async () => {
  const dir = await tempProject();
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    git(dir, "add", ".agentstate-lite");
    execFileSync("git", ["commit", "-m", "commit board with code"], { cwd: dir, stdio: "ignore" });
    git(dir, "remote", "add", "origin", "https://github.com/org/repo.git");
    fakeFetchedBoardRef(dir);
    const summary = classifySharing(board);
    assert.equal(summary.kind, "unavailable");
    assert.match(String(summary.reason), /sync/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a classification failure is unavailable — never a fabricated private (git unreachable)", async () => {
  const dir = await tempProject();
  const savedPath = process.env.PATH;
  try {
    initRepo(dir);
    const board = await conventionalBoard(dir);
    process.env.PATH = path.join(dir, "empty-bin"); // no git on PATH → porcelain throws
    const summary = classifySharing(board);
    assert.equal(summary.kind, "unavailable");
    assert.ok(summary.reason, "failure carries a reason");
  } finally {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("humanizeRemote degrades: GitHub https/ssh → org/repo; host-only and paths degrade honestly", () => {
  assert.equal(humanizeRemote("https://github.com/org/repo.git"), "org/repo");
  assert.equal(humanizeRemote("git@github.com:org/repo.git"), "org/repo");
  assert.equal(humanizeRemote("https://gitlab.example.com/group/sub.git"), "group/sub");
  assert.equal(humanizeRemote("https://host.example.com/"), "host.example.com");
  assert.equal(humanizeRemote("/srv/git/team/project.git"), "team/project");
});

test("workspaces loader projects labels+paths from the catalog with the open entry marked (no probes)", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "aslite-ws-home-"));
  const bundleRoot = path.join(home, "proj", ".agentstate-lite");
  try {
    await ensureUserStateRoot(home);
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(
      path.join(credentialsDir(home), "catalog.json"),
      JSON.stringify({
        schema_version: 1,
        entries: [
          { id: `bnd_${"0".repeat(32)}`, label: "zeta", locator: { kind: "local-path", path: "/nowhere/zeta" } },
          { id: `bnd_${"1".repeat(32)}`, label: "alpha", locator: { kind: "local-path", path: bundleRoot } },
        ],
      }),
    );
    await withIsolatedUserEnv(home, async () => {
      const rows = await createWorkspacesLoader(bundleRoot, home)();
      assert.deepEqual(rows, [
        { label: "alpha", path: bundleRoot, open: true },
        { label: "zeta", path: "/nowhere/zeta", open: false },
      ]);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
