// Tests for the explicit, snapshot-first `sync --establish` transition. Everything runs in
// SCRATCH topologies via the U0 harness — the real repo's own board is never touched.
//
// The suite pins:
//   • first publication is explicit: bare sync never publishes a local-only `board` branch;
//   • snapshot creation does not touch the code worktree, its index, or the source bundle;
//   • bare `sync` never auto-publishes and reports an existing local bundle honestly;
//   • decision 3 (LOCKED): the gitignore append lands in the WORKING TREE only, uncommitted;
//   • the keystone first-contact journey end to end (clone A establishes, clone B joins);
//   • races, push failures, symlinks, staged bundle paths, and post-publish crash recovery;
//   • idempotence: `--establish` re-run notes `already established` and behaves as an ordinary sync;
//   • the precondition ladder's structured refusals (no repo, no origin, unreachable origin, no
//     folder / empty / no index.md, a folder already committed at HEAD, a `board/…` namespace
//     branch, a nested `.git`) and the USAGE flag-combination guards.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile, mkdir, rename, symlink } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { initBundle } from "@superbee/core";
import { sync, SYNC_LOCAL_ONLY_MESSAGE, syncLocalOnlyNote } from "../src/commands/sync.js";
import { init } from "../src/commands/init.js";
import { recipe } from "../src/commands/recipe.js";
import { list } from "../src/commands/list.js";
import {
  ESTABLISH_ALREADY,
  ESTABLISH_COMMITTED_PREVIEW,
  ESTABLISH_DONE,
  establishNextSteps,
} from "../src/commands/sync-establish.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import {
  BOARD_BRANCH,
  GITIGNORE_ENTRIES,
  provisionBoardWorktree,
  pushBoardCommit,
  snapshotBundleCommit,
} from "@superbee/board-git";
import {
  BUNDLE_DIR,
  git,
  gitTry,
  initPlainBundleDir,
  makeGreenfieldTopology,
  writeBoardDoc,
  type BoardRepo,
} from "../../board-git/test/git-harness.js";

const INV = cliInvocation();

// ── scaffolding (mirrors sync.test.ts / sync-establish-committed.test.ts) ─────

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  return withIsolatedUserEnv(home, run);
}

async function runSync(home: string, argv: string[]): Promise<{ out: string; err?: CliError }> {
  const chunks: string[] = [];
  try {
    await withHome(home, () =>
      sync(argv, { stdout: (s: string) => void chunks.push(s), hookInstalled: () => true }),
    );
    return { out: chunks.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: chunks.join(""), err };
    throw err;
  }
}

async function runSyncJson(home: string, argv: string[]): Promise<Record<string, unknown>> {
  const { out, err } = await runSync(home, [...argv, "--json"]);
  assert.equal(err, undefined, `expected success, got ${err?.code}: ${err?.message}`);
  return JSON.parse(out) as Record<string, unknown>;
}

async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "aslite-establish-test-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function establishMarkerPath(root: string): string {
  return path.join(git(root, ["rev-parse", "--absolute-git-dir"]).trim(), "agentstate.establishCommit");
}

function plantEstablishMarker(root: string, commit: string): void {
  writeFileSync(establishMarkerPath(root), `${commit}\n`, { mode: 0o600 });
}

/**
 * Hand-build a legitimate local-only board without invoking `--establish`: snapshot a plain
 * bundle, attach a local branch to that commit, then provision it at the conventional path.
 */
async function handBuildLocalOnlyBoard(repo: BoardRepo, id: string, body: string): Promise<void> {
  await initBundle(repo.board);
  await writeBoardDoc(repo, id, { frontmatter: { type: "Note", title: id }, body });
  const snapshot = snapshotBundleCommit(repo.root, repo.board);
  await rm(repo.board, { recursive: true, force: false });
  git(repo.root, ["branch", BOARD_BRANCH, snapshot.sha]);
  const outcome = provisionBoardWorktree(repo.root);
  assert.equal(outcome.kind, "provisioned");
}

// ── pure string tests ──────────────────────────────────────────────────────────

test("establish strings: pinned constants", () => {
  assert.equal(
    ESTABLISH_DONE,
    "the shared board is live — the project bundle now syncs over the 'board' branch",
  );
  assert.equal(ESTABLISH_ALREADY, "already established");
  const steps = establishNextSteps(INV);
  assert.equal(steps.length, 2);
  assert.match(steps[0]!, /teammates just run/);
  assert.match(steps[1]!, /hook install/);
});

// ── matrix cell 1: absent/absent — bare sync hints, --establish publishes ─────

test("combo 1 (absent/absent): bare sync reports the LOCAL-ONLY state, whose note routes to --establish", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    const rec = await runSyncJson(home, ["--dir", topo.a.root]);
    assert.equal(rec.sync, SYNC_LOCAL_ONLY_MESSAGE);
    assert.equal(rec.note, syncLocalOnlyNote(cliInvocation()));
    assert.match(rec.note as string, /--establish/, "the note routes sharing to the real verb");
    assert.equal("hint" in rec, false, "the ad-hoc hint field is retired — the note carries the routing");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("combo 1: bare sync with NO local bundle folder at all stays 'nothing to sync' with no establish routing", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    const rec = await runSyncJson(home, ["--dir", topo.a.root]);
    assert.equal(rec.sync, "nothing to sync");
    assert.equal("hint" in rec, false, "nothing establishABLE here — no folder, no routing to give");
    assert.equal("note" in rec, false, "and no local-only note either — there is no board here at all");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("combo 1: --establish — full receipt, origin gets the board, working-tree gitignore, idempotent re-run", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/hello", {
      frontmatter: { type: "Note", title: "Hello", actor: "mike" },
      body: "# Hello\n\nfirst doc\n",
    });

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_DONE);
    assert.equal(typeof rec.board_commit, "string");
    assert.equal(rec.committed, 1, "index.md is reserved (never counted); the one concept doc is");
    assert.equal(rec.actor, "mike");
    assert.equal(rec.pushed, "origin/board (tracking set)");
    assert.equal(typeof rec.gitignore, "string");
    assert.match(rec.gitignore as string, /appended/);
    assert.deepEqual(rec.next_steps, establishNextSteps(INV));

    // origin now genuinely carries the board branch.
    assert.equal(
      gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status,
      0,
    );
    // the conventional path is now a linked worktree checked out on `board`.
    assert.equal(git(topo.a.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), BOARD_BRANCH);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "hello.md")), true);

    // gitignore: WORKING TREE only, uncommitted (decision 3).
    const gitignorePath = path.join(topo.a.root, ".gitignore");
    assert.equal(existsSync(gitignorePath), true);
    const gitignore = readFileSync(gitignorePath, "utf8");
    for (const entry of GITIGNORE_ENTRIES) {
      assert.match(gitignore, new RegExp(entry.replace("/", "\\/")));
    }
    const status = git(topo.a.root, ["status", "--porcelain"]);
    assert.match(status, /\.gitignore/, ".gitignore itself is uncommitted");
    assert.doesNotMatch(
      status,
      /\.superbee/,
      "the board worktree itself never shows as a dirty path in the main worktree",
    );
    // never committed onto the code branch.
    const headTree = gitTry(topo.a.root, ["cat-file", "-e", "HEAD:.gitignore"]);
    assert.notEqual(headTree.status, 0, ".gitignore must not be committed to the code branch");

    // Idempotent re-run: notes already-established and keeps the same single lineage.
    const boardCommitsBefore = git(topo.a.board, ["rev-list", "--count", "HEAD"]).trim();
    const rerun = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rerun.establish, ESTABLISH_ALREADY);
    assert.equal(rerun.sync, "already up to date");
    const boardCommitsAfter = git(topo.a.board, ["rev-list", "--count", "HEAD"]).trim();
    assert.equal(boardCommitsAfter, boardCommitsBefore, "re-running --establish never adds a second lineage");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("combo 1: user code + the working tree survive establish untouched", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(existsSync(path.join(topo.a.root, "src", "app.js")), true);
    assert.equal(readFileSync(path.join(topo.a.root, "src", "app.js"), "utf8"), "export const x = 1;\n");
    assert.equal(git(topo.a.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── keystone first-contact journey (buildlist #1) ─────────────────────────────

test("keystone journey: clone A inits + recipe add work-tracking + --establish; clone B bare sync joins and sees the Task kind", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    const boardA = path.join(topo.a.root, BUNDLE_DIR);
    await withHome(home, () =>
      init(["--dir", boardA, "--recipe", "none", "--json"], { stdout: () => {} }),
    );
    await withHome(home, () =>
      recipe(["add", "work-tracking", "--dir", boardA, "--json"], { stdout: () => {} }),
    );

    const establishRec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(establishRec.established, ESTABLISH_DONE);

    // Clone B joins with a bare sync (no flag) — the existing provision/join path, unchanged.
    const joinRec = await runSyncJson(home, ["--dir", topo.b.root]);
    assert.ok("provisioned" in joinRec || "sync" in joinRec, "clone B's first sync provisions the board");

    const boardB = path.join(topo.b.root, BUNDLE_DIR);
    assert.equal(
      existsSync(path.join(boardB, "conventions", "task.md")),
      true,
      "the work-tracking convention doc synced to clone B",
    );

    const chunks: string[] = [];
    await withHome(home, () =>
      list(["--type", "Task", "--dir", boardB, "--json"], { stdout: (s: string) => void chunks.push(s) }),
    );
    const listRec = JSON.parse(chunks.join("")) as { count: number };
    assert.equal(typeof listRec.count, "number");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── local-only board: publication always requires explicit consent ────────────

test("local-only board: bare sync and --pull-only refuse; --establish publishes explicitly", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await handBuildLocalOnlyBoard(topo.a, "notes/local-only", "hand-built, never pushed");
    for (const argv of [[], ["--pull-only"]]) {
      const { err } = await runSync(home, [...argv, "--dir", topo.a.root]);
      assert.equal(err?.code, "NO_UPSTREAM");
      assert.match(err?.message ?? "", /sync --establish/);
      assert.notEqual(
        gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status,
        0,
      );
    }

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_DONE);
    assert.equal(rec.pushed, "origin/board (tracking set)");
    assert.equal(
      git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim(),
      git(topo.a.board, ["rev-parse", "HEAD"]).trim(),
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("local-only board: --show-incoming routes an UNPUBLISHED local board to --establish, not the viewer's no-fetched-state message", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await handBuildLocalOnlyBoard(topo.a, "notes/local-only", "hand-built, never pushed");
    const { err } = await runSync(home, ["--show-incoming", "notes/local-only", "--dir", topo.a.root]);
    assert.equal(err?.code, "NO_UPSTREAM");
    assert.match(err?.message ?? "", /sync --establish/, "an unpublished local board has a real publication path");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("stale origin/board tracking ref cannot make bare sync recreate a remotely deleted board", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await handBuildLocalOnlyBoard(topo.a, "notes/private", "must remain local");
    const localHead = git(topo.a.board, ["rev-parse", "HEAD"]).trim();
    git(topo.a.board, ["push", "origin", `${localHead}:refs/heads/${BOARD_BRANCH}`]);
    git(topo.a.root, ["fetch", "origin"]);
    git(topo.origin, ["update-ref", "-d", `refs/heads/${BOARD_BRANCH}`]);
    assert.equal(
      gitTry(topo.a.root, ["show-ref", "--verify", `refs/remotes/origin/${BOARD_BRANCH}`]).status,
      0,
      "the clone begins with a genuinely stale tracking ref",
    );
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);

    const { err } = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(err?.code, "NO_UPSTREAM");
    assert.match(err?.message ?? "", /bare sync never creates/);
    assert.notEqual(
      gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status,
      0,
      "ordinary sync must not recreate the deleted remote branch",
    );
    assert.equal(existsSync(path.join(topo.a.board, "notes", "private.md")), true);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("privacy regression: bare sync never publishes an unrelated local branch named board, even when its root has index.md", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["checkout", "-b", BOARD_BRANCH]);
    await writeFile(path.join(topo.a.root, "index.md"), "ordinary project index, not an OKF declaration\n");
    await writeFile(path.join(topo.a.root, "private-plan.md"), "do not publish this branch\n");
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "private branch unrelated to AgentState"]);
    git(topo.a.root, ["checkout", "main"]);

    const { err } = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(err?.code, "NO_UPSTREAM");
    assert.match(err?.message ?? "", /will not check it out/);
    assert.equal(existsSync(topo.a.board), false, "bare sync does not even materialize the untrusted branch");
    assert.notEqual(
      gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status,
      0,
      "the unrelated private branch never crosses the network",
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("privacy regression: an unrelated local board branch is not adopted when origin/board also exists", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.b);
    await writeBoardDoc(topo.b, "notes/shared", {
      frontmatter: { type: "Note", title: "Shared" },
      body: "remote board\n",
    });
    await runSyncJson(home, ["--establish", "--dir", topo.b.root]);

    git(topo.a.root, ["checkout", "-b", BOARD_BRANCH]);
    await writeFile(path.join(topo.a.root, "index.md"), "ordinary project index\n");
    await writeFile(path.join(topo.a.root, "private-plan.md"), "never publish\n");
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "private local branch"]);
    git(topo.a.root, ["checkout", "main"]);

    const { err } = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(err?.code, "CONFLICT");
    assert.match(err?.message ?? "", /will not guess which history is safe/);
    assert.equal(existsSync(topo.a.board), false);
    const remoteTree = git(topo.origin, ["ls-tree", "-r", "--name-only", BOARD_BRANCH]);
    assert.doesNotMatch(remoteTree, /private-plan\.md/);
    assert.match(remoteTree, /notes\/shared\.md/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("explicit establish may adopt and publish an unprovisioned local-only board branch", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/local", {
      frontmatter: { type: "Note", title: "Local" },
      body: "explicitly shared\n",
    });
    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    await rm(topo.a.board, { recursive: true, force: false });
    git(topo.a.root, ["branch", BOARD_BRANCH, snapshot.sha]);

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_DONE);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "local.md")), true);
    assert.equal(git(topo.origin, ["rev-parse", BOARD_BRANCH]).trim(), snapshot.sha);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── snapshot isolation and destructive-boundary probes ───────────────────────

test("snapshot primitive reads only the bundle and leaves the code worktree, real index, source, and refs untouched", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/hello", {
      frontmatter: { type: "Note", title: "Hello", actor: "alice" },
      body: "source bytes stay here\n",
    });
    await writeFile(path.join(topo.a.root, "src", "staged.js"), "export const staged = true;\n");
    git(topo.a.root, ["add", "src/staged.js"]);
    const stagedBefore = git(topo.a.root, ["diff", "--cached", "--name-only"]);
    const sourceBefore = readFileSync(path.join(topo.a.board, "notes", "hello.md"), "utf8");

    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);

    assert.equal(git(topo.a.root, ["diff", "--cached", "--name-only"]), stagedBefore);
    assert.equal(readFileSync(path.join(topo.a.board, "notes", "hello.md"), "utf8"), sourceBefore);
    assert.notEqual(gitTry(topo.a.root, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
    const treePaths = git(topo.a.root, ["ls-tree", "-r", "--name-only", snapshot.sha]).trim().split("\n");
    assert.deepEqual(treePaths.sort(), ["index.md", "notes/hello.md"]);
    assert.equal(snapshot.docs[0]?.actor, "alice");
  } finally {
    await topo.cleanup();
  }
});

test("snapshot includes bundle files even when repository exclude rules match them", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/ignored-by-git", {
      frontmatter: { type: "Note", title: "Still bundle data" },
      body: "must be published\n",
    });
    const gitDir = git(topo.a.root, ["rev-parse", "--absolute-git-dir"]).trim();
    await writeFile(path.join(gitDir, "info", "exclude"), "*.md\n");

    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    const treePaths = git(topo.a.root, ["ls-tree", "-r", "--name-only", snapshot.sha]);
    assert.match(treePaths, /^index\.md$/m);
    assert.match(treePaths, /^notes\/ignored-by-git\.md$/m);
  } finally {
    await topo.cleanup();
  }
});

test("Git clean filters cannot rewrite bundle bytes during establishment", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/private", {
      frontmatter: { type: "Note", title: "Private" },
      body: "PRIVATE original bytes\n",
    });
    const gitDir = git(topo.a.root, ["rev-parse", "--absolute-git-dir"]).trim();
    await writeFile(path.join(gitDir, "info", "attributes"), "*.md filter=redact\n");
    git(topo.a.root, ["config", "filter.redact.clean", "sed 's/PRIVATE/REDACTED/g'"]);
    git(topo.a.root, ["config", "filter.redact.smudge", "cat"]);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /bundle bytes differ from the Git snapshot/);
    assert.match(readFileSync(path.join(topo.a.board, "notes", "private.md"), "utf8"), /PRIVATE original bytes/);
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("ambient core.autocrlf does not rewrite literal bundle bytes during establishment", async () => {
  const topo = await makeGreenfieldTopology();
  try {
    await initPlainBundleDir(topo.a);
    git(topo.a.root, ["config", "core.autocrlf", "true"]);

    const expected = readFileSync(path.join(topo.a.board, "index.md"));
    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    assert.deepEqual(
      execFileSync("git", ["-C", topo.a.root, "show", `${snapshot.sha}:index.md`]),
      expected,
    );
  } finally {
    await topo.cleanup();
  }
});

test("Git smudge filters cannot hide checkout byte changes before backup deletion", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/private", {
      frontmatter: { type: "Note", title: "Private" },
      body: "PRIVATE original bytes\n",
    });
    const gitDir = git(topo.a.root, ["rev-parse", "--absolute-git-dir"]).trim();
    await writeFile(path.join(gitDir, "info", "attributes"), "*.md filter=redact\n");
    git(topo.a.root, ["config", "filter.redact.clean", "sed 's/REDACTED/PRIVATE/g'"]);
    git(topo.a.root, ["config", "filter.redact.smudge", "sed 's/PRIVATE/REDACTED/g'"]);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    const backup = `${topo.a.board}.establish-backup`;
    assert.match(readFileSync(path.join(backup, "notes", "private.md"), "utf8"), /PRIVATE original bytes/);
    assert.match(readFileSync(path.join(topo.a.board, "notes", "private.md"), "utf8"), /REDACTED original bytes/);
    assert.equal(existsSync(establishMarkerPath(topo.a.root)), true);
    assert.match(git(topo.origin, ["show", `${BOARD_BRANCH}:notes/private.md`]), /PRIVATE original bytes/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("symlink regression: establish never follows a conventional-path symlink or moves its external target", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  const external = await mkdtemp(path.join(tmpdir(), "aslite-establish-external-"));
  try {
    await initBundle(external);
    await writeFile(path.join(external, "secret.md"), "external bytes must stay put\n");
    await symlink(external, topo.a.board, "dir");

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /symlinks/);
    assert.equal(readFileSync(path.join(external, "secret.md"), "utf8"), "external bytes must stay put\n");
    assert.equal(existsSync(path.join(external, "index.md")), true);
    assert.equal(existsSync(topo.a.board), true, "the symlink itself is untouched");
  } finally {
    await rm(external, { recursive: true, force: true });
    await cleanup();
    await topo.cleanup();
  }
});

test("nested git repo regression: establish refuses before Git can collapse its files into a gitlink", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    const nested = path.join(topo.a.board, "artifact-repo");
    await mkdir(nested, { recursive: true });
    git(nested, ["init", "-b", "main"]);
    await writeFile(path.join(nested, "secret.txt"), "nested bytes must not disappear\n");
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "-m", "nested content"]);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /silently omit or collapse files/);
    assert.deepEqual(err?.details?.nested_git_paths, ["artifact-repo/.git"]);
    assert.equal(readFileSync(path.join(nested, "secret.txt"), "utf8"), "nested bytes must not disappear\n");
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("plain nested .git control data is refused even when it is not a valid repository", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    const hidden = path.join(topo.a.board, "data", ".git");
    await mkdir(hidden, { recursive: true });
    await writeFile(path.join(hidden, "private"), "Git would silently omit this\n");

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /nested git control data/);
    assert.deepEqual(err?.details?.nested_git_paths, ["data/.git"]);
    assert.equal(readFileSync(path.join(hidden, "private"), "utf8"), "Git would silently omit this\n");
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("staged bundle regression: establish refuses without altering the code index", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    git(topo.a.root, ["add", BUNDLE_DIR]);
    const stagedBefore = git(topo.a.root, ["diff", "--cached", "--name-only"]);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /staged in the code branch's index/);
    assert.equal(err?.help, `git restore --staged -- ${BUNDLE_DIR}`);
    assert.equal(git(topo.a.root, ["diff", "--cached", "--name-only"]), stagedBefore);
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("push rejection preserves the classified auth error and leaves the source, index, and refs untouched", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/hello", {
      frontmatter: { type: "Note", title: "Hello" },
      body: "must survive failed publication\n",
    });
    const sourceBefore = readFileSync(path.join(topo.a.board, "notes", "hello.md"), "utf8");
    const hook = path.join(topo.a.root, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\necho 'fatal: Authentication failed' >&2\nexit 1\n");
    await chmod(hook, 0o755);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "AUTH_REQUIRED");
    assert.equal(readFileSync(path.join(topo.a.board, "notes", "hello.md"), "utf8"), sourceBefore);
    assert.equal(git(topo.a.root, ["diff", "--cached", "--name-only"]), "");
    assert.notEqual(gitTry(topo.a.root, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
    assert.equal(existsSync(establishMarkerPath(topo.a.root)), true, "failed publication retains recovery provenance");

    await rm(hook);
    const resumed = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(resumed.established, ESTABLISH_DONE);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "hello.md")), true);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("recovery markers are isolated between linked code worktrees", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  const siblingRoot = path.join(topo.dir, "A-sibling");
  try {
    git(topo.a.root, ["worktree", "add", "-b", "sibling-code", siblingRoot, "main"]);
    const sibling: BoardRepo = {
      name: "A-sibling",
      root: siblingRoot,
      board: path.join(siblingRoot, BUNDLE_DIR),
    };
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/from-a", {
      frontmatter: { type: "Note", title: "From A" },
      body: "first snapshot\n",
    });
    await initPlainBundleDir(sibling);
    await writeBoardDoc(sibling, "notes/from-sibling", {
      frontmatter: { type: "Note", title: "From sibling" },
      body: "second snapshot\n",
    });
    const hook = path.join(topo.a.root, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\necho 'fatal: Authentication failed' >&2\nexit 1\n");
    await chmod(hook, 0o755);

    assert.equal((await runSync(home, ["--establish", "--dir", topo.a.root])).err?.code, "AUTH_REQUIRED");
    assert.equal((await runSync(home, ["--establish", "--dir", siblingRoot])).err?.code, "AUTH_REQUIRED");
    const markerA = establishMarkerPath(topo.a.root);
    const markerSibling = establishMarkerPath(siblingRoot);
    assert.notEqual(markerA, markerSibling);
    assert.notEqual(readFileSync(markerA, "utf8"), readFileSync(markerSibling, "utf8"));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("an unproven pre-existing backup blocks before publication", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    const backup = `${topo.a.board}.establish-backup`;
    await initBundle(backup);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /no matching establishment marker/);
    assert.equal(existsSync(path.join(topo.a.board, "index.md")), true);
    assert.equal(existsSync(path.join(backup, "index.md")), true);
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", `refs/heads/${BOARD_BRANCH}`]).status, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── race and crash recovery: the marker is provenance, never branch heuristics ─

test("race: a teammate publishes after our snapshot; re-run reports conflict and preserves both sides", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/from-a", {
      frontmatter: { type: "Note", title: "From A", actor: "alice" },
      body: "A's local bytes\n",
    });
    const aSnapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    plantEstablishMarker(topo.a.root, aSnapshot.sha);

    await initPlainBundleDir(topo.b);
    await writeBoardDoc(topo.b, "notes/from-b", {
      frontmatter: { type: "Note", title: "From B", actor: "bob" },
      body: "B's published bytes\n",
    });
    await runSyncJson(home, ["--establish", "--dir", topo.b.root]);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "CONFLICT");
    assert.match(err?.message ?? "", /different origin\/board/);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "from-a.md")), true);
    assert.equal(git(topo.origin, ["ls-tree", "-r", "--name-only", BOARD_BRANCH]).includes("notes/from-b.md"), true);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("crash recovery: published snapshot + marker + original folder resumes conversion", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/recovered", {
      frontmatter: { type: "Note", title: "Recovered" },
      body: "published before crash\n",
    });
    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    pushBoardCommit(topo.a.root, snapshot.sha);
    plantEstablishMarker(topo.a.root, snapshot.sha);

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_DONE);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "recovered.md")), true);
    assert.equal(git(topo.a.board, ["rev-parse", "HEAD"]).trim(), snapshot.sha);
    assert.equal(existsSync(establishMarkerPath(topo.a.root)), false);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("crash recovery: renamed backup before provisioning is restored into a verified board worktree", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/recovered", {
      frontmatter: { type: "Note", title: "Recovered" },
      body: "backup bytes\n",
    });
    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    pushBoardCommit(topo.a.root, snapshot.sha);
    plantEstablishMarker(topo.a.root, snapshot.sha);
    const backup = `${topo.a.board}.establish-backup`;
    await rename(topo.a.board, backup);

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_DONE);
    assert.equal(existsSync(path.join(topo.a.board, "notes", "recovered.md")), true);
    assert.equal(existsSync(backup), false, "verified recovery removes its temporary backup");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("concurrent backup write during provisioning is detected at the deletion boundary and preserved", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/original", {
      frontmatter: { type: "Note", title: "Original" },
      body: "snapshot content\n",
    });
    const backup = `${topo.a.board}.establish-backup`;
    const hook = path.join(topo.a.root, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      `#!/bin/sh\nmkdir -p '${backup}/notes'\nprintf '%s\\n' 'concurrent bytes' > '${backup}/notes/concurrent.md'\n`,
    );
    await chmod(hook, 0o755);

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "CONFLICT");
    assert.match(err?.message ?? "", /backup.*changed/);
    assert.equal(readFileSync(path.join(backup, "notes", "concurrent.md"), "utf8"), "concurrent bytes\n");
    assert.equal(existsSync(path.join(topo.a.board, "notes", "concurrent.md")), false);
    assert.equal(existsSync(establishMarkerPath(topo.a.root)), true, "the marker stays so recovery remains explicit");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("crash recovery: provisioned board plus verified backup is cleaned idempotently", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    const snapshot = snapshotBundleCommit(topo.a.root, topo.a.board);
    pushBoardCommit(topo.a.root, snapshot.sha);
    plantEstablishMarker(topo.a.root, snapshot.sha);
    const backup = `${topo.a.board}.establish-backup`;
    await rename(topo.a.board, backup);
    git(topo.a.root, ["fetch", "origin"]);
    const provisioned = provisionBoardWorktree(topo.a.root);
    assert.equal(provisioned.kind, "provisioned");

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_ALREADY);
    assert.equal(rec.sync, "already up to date");
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(establishMarkerPath(topo.a.root)), false);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── precondition ladder: structured refusals ──────────────────────────────────

test("establish refusals: no git repo at all, and a repo with no origin remote", async () => {
  const { home, cleanup } = await tempHome();
  try {
    const plain = await mkdtemp(path.join(tmpdir(), "aslite-establish-plain-"));
    try {
      const { err } = await runSync(home, ["--establish", "--dir", plain]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err?.message ?? "", /not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }

    const noOrigin = await mkdtemp(path.join(tmpdir(), "aslite-establish-noorigin-"));
    try {
      git(noOrigin, ["init", "-b", "main"]);
      await writeFile(path.join(noOrigin, "f.txt"), "x");
      git(noOrigin, ["add", "-A"]);
      git(noOrigin, ["commit", "-m", "init"]);
      const { err } = await runSync(home, ["--establish", "--dir", noOrigin]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err?.message ?? "", /origin/);
      // The remoteless dead end is remedied, not just named: the actionable next step.
      assert.match(err?.help ?? "", /git remote add origin <url>/);
    } finally {
      await rm(noOrigin, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
});

test("establish refusals: no folder / empty folder / no index.md all point at init", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    {
      const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err?.message ?? "", /run '.*init/);
    }
    {
      await mkdir(topo.a.board, { recursive: true });
      const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err?.message ?? "", /is empty/);
      await rm(topo.a.board, { recursive: true, force: true });
    }
    {
      await mkdir(topo.a.board, { recursive: true });
      await writeFile(path.join(topo.a.board, "stray.md"), "# not a bundle\n");
      const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err?.message ?? "", /no index\.md/);
    }
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("establish on a folder already committed at HEAD routes to the committed-case preview, never the greenfield conversion", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    await writeBoardDoc(topo.a, "notes/hello", { frontmatter: { type: "Note", title: "Hello" }, body: "hi\n" });
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "committed the bundle folder directly"]);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_COMMITTED_PREVIEW);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead, "preview mutates nothing");
    assert.notEqual(
      gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status,
      0,
      "nothing published by a preview",
    );
    assert.equal(existsSync(path.join(topo.a.board, "notes", "hello.md")), true, "the folder is untouched");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("establish refusal: a nested .git inside the folder is refused, never adopted", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await mkdir(topo.a.board, { recursive: true });
    await writeFile(path.join(topo.a.board, "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(topo.a.board, ["init", "-b", "main"]);
    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /\.git/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("establish refusal: a 'board/…' namespace branch blocks (uncreatable-ref hazard), named in details", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["branch", `${BOARD_BRANCH}/stray`]);
    await initPlainBundleDir(topo.a);
    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.deepEqual(err?.details?.conflicting_branches, [`${BOARD_BRANCH}/stray (local)`]);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("establish refusal: a project binding (.agentstate.json) pointing elsewhere refuses — out of the git-sync tier by design", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  const elsewhere = await mkdtemp(path.join(tmpdir(), "aslite-establish-elsewhere-"));
  try {
    await initPlainBundleDir(topo.a);
    await writeFile(path.join(topo.a.root, ".agentstate.json"), JSON.stringify({ bundle: elsewhere }));
    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /project binding/);
    assert.match(err?.message ?? "", /out of the git-sync tier/);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await cleanup();
    await topo.cleanup();
  }
});

test("establish refusal: unreachable origin classifies TRANSIENT", async () => {
  const topo = await makeGreenfieldTopology();
  const { home, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    git(topo.a.root, ["remote", "set-url", "origin", "https://127.0.0.1:1/nope.git"]);
    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "TRANSIENT");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── USAGE guards ───────────────────────────────────────────────────────────────

test("sync flag combinations: --establish is mutually exclusive with --pull-only / --migrate / --show-incoming", async () => {
  const { home, cleanup } = await tempHome();
  try {
    for (const argv of [
      ["--establish", "--pull-only"],
      ["--establish", "--migrate"],
      ["--establish", "--show-incoming", "some/id"],
    ]) {
      const { err } = await runSync(home, argv);
      assert.equal(err?.code, "USAGE", `expected USAGE for ${JSON.stringify(argv)}`);
    }
  } finally {
    await cleanup();
  }
});
