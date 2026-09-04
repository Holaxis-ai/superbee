// Tests for `sync --establish` on a COMMITTED bundle folder — the hard case the verb absorbed
// from the retired `--migrate` spelling. Everything runs in SCRATCH topologies via the U0
// harness — the real repo's board is never touched.
//
// The suite carries the audited committed-case guards forward, plus the two findings the
// unification adjudicated:
//   • the full e2e: committed-folder repo → `--establish --yes` → board branch on origin with the
//     bundle at its ROOT and exactly ONE commit (files, not history), tracking config set
//     (`push -u` — load-bearing), the removal+gitignore commit prepared on a local
//     `board-cleanup` branch (NOT pushed; current branch, working tree, index all untouched);
//   • the BOTH-WORLDS window semantics (test-pinned): board live on origin, folder still tracked
//     on main as a frozen snapshot, sync on such a clone refusing with structured guidance;
//   • the completion journey on BOTH clones, literally running the receipt's emitted commands
//     (verbatim-execution pin): push the cleanup branch, merge, `git pull`, then `sync`
//     provisions LOUDLY and the docs are intact — the full vanish-reappear cycle;
//   • preview (no --yes): a pinned dry-run that mutates NOTHING;
//   • idempotence: re-run and teammate-run both report `already established` (exit 0);
//   • crash-window recovery keyed on the WRITE-TIME MARKER (the U5 delta-review LOW: a local
//     `board` branch is not provenance — a teammate who checked out the board branch during the
//     window must never be offered the recovery);
//   • the LOST race (QA F1): a marker whose snapshot origin/board does not contain is reported
//     truthfully (never "pushed"), and the loser's journey terminates — discarding the local
//     branch lets the next run clear the stale marker (the only mutation) exactly once; the clear
//     never fires on a contained snapshot, while the branch exists, or off a dead fetch;
//   • a fully shared clone with leftover local crumbs gets ordinary already-established behavior,
//     never stale push-the-PR guidance (the Codex PR#26 finding, moot by structural routing);
//   • refusals: uncommitted board changes (naming them), behind-origin freshness, dead fetch,
//     `board/…` namespace, detached HEAD, stray board branch — nothing mutated by any of them;
//   • no forbidden vocabulary (worktree/linked/subtree, and no retired migration framing) in any
//     user-facing committed-case string.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { sync } from "../src/commands/sync.js";
import { buildBoardBlock, defaultLoadBoardStatus } from "../src/commands/home.js";
import {
  CLEANUP_BRANCH,
  ESTABLISH_ALREADY,
  ESTABLISH_COMMITTED_ALREADY,
  ESTABLISH_COMMITTED_DONE,
  ESTABLISH_COMMITTED_PREVIEW,
  bothWorldsLine,
  committedNextSteps,
  committedPreviewRecord,
  rolloutNote,
} from "../src/commands/sync-establish.js";
import { GITIGNORE_ENTRIES, withIgnoreEntries } from "@superbee/board-git";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import {
  BUNDLE_DIR,
  LEGACY_BUNDLE_DIR,
  git,
  gitTry,
  makeCommittedFolderTopology,
  plantStagedUserCode,
  readBoardFile,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";

const INV = cliInvocation();

// ── scaffolding (mirrors sync.test.ts / sync-establish.test.ts) ───────────────

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

/** Run `sync … --json` and parse the receipt (asserts no error was thrown). */
async function runSyncJson(home: string, argv: string[]): Promise<Record<string, unknown>> {
  const { out, err } = await runSync(home, [...argv, "--json"]);
  assert.equal(err, undefined, `expected success, got ${err?.code}: ${err?.message}`);
  return JSON.parse(out) as Record<string, unknown>;
}

async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "aslite-establish-committed-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** The committed case's crash-window marker (write-time provenance; see sync-establish.ts). */
function committedMarkerPath(root: string): string {
  return path.join(
    git(root, ["rev-parse", "--absolute-git-dir"]).trim(),
    "agentstate.establishCommittedShare",
  );
}

function plantCommittedMarker(root: string, commit: string): void {
  writeFileSync(committedMarkerPath(root), `${commit}\n`, { mode: 0o600 });
}

/**
 * Reproduce the EXACT crash state: root commit cut, local board branch created, board pushed with
 * -u, the crash marker written — and then the process died before the removal commit existed
 * anywhere. Returns the planted root sha.
 */
function plantCrashWindow(root: string): string {
  const treeSha = git(root, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
  const rootSha = git(root, ["commit-tree", treeSha, "-m", "board: bundle shared from 'main' (files only)"]).trim();
  git(root, ["branch", "board", rootSha]);
  git(root, ["push", "-u", "origin", "board"]);
  plantCommittedMarker(root, rootSha);
  return rootSha;
}

/** Every ref/branch/tree fact asserted to prove NOTHING was mutated by a preview/refusal. */
function assertPristine(topo: TwoCloneTopology, repoRoot: string, preHead: string): void {
  assert.equal(gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status !== 0, true, "no local board branch");
  assert.equal(
    gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
    true,
    "no cleanup branch",
  );
  assert.equal(gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status !== 0, true, "no board on origin");
  assert.equal(git(repoRoot, ["rev-parse", "HEAD"]).trim(), preHead, "HEAD unchanged");
  assert.equal(existsSync(path.join(repoRoot, BUNDLE_DIR, "index.md")), true, "committed folder intact");
}

/** No worktree/linked/subtree vocabulary, and the retired migration framing stays dead. */
const FORBIDDEN = /worktree|linked|subtree|migrat/i;

// ── pure string tests ─────────────────────────────────────────────────────────

test("committed-case strings: pinned constants, rollout note, and no forbidden vocabulary", () => {
  assert.equal(ESTABLISH_COMMITTED_PREVIEW, "preview — nothing has been changed; re-run with --yes to execute");
  assert.equal(ESTABLISH_COMMITTED_ALREADY, "already established — a board branch already exists on origin");
  assert.equal(
    ESTABLISH_COMMITTED_DONE,
    "the board branch is live on origin — push the cleanup branch and open its PR to finish",
  );
  assert.equal(CLEANUP_BRANCH, "board-cleanup");
  assert.deepEqual(GITIGNORE_ENTRIES, [".superbee/", ".agentstate-lite/"]);

  const note = rolloutNote(INV, "main");
  assert.equal(note.length, 5);
  assert.match(note[0]!, /disappears from 'main' — nothing is lost/);
  assert.match(note[1]!, /not 'git pull' — updates the board/);
  assert.match(note[2]!, /never merge it into 'main'/);
  // The `git clean -fdx` line is rollout-note COPY only — pinned here so its wording survives.
  assert.match(note[3]!, /^'git clean -fdx' on 'main' removes the board checkout \(recoverable/);
  assert.match(note[3]!, /unpushed board commits are why you sync first\)$/);
  assert.match(note[4]!, /hook install/);

  const both = bothWorldsLine("main");
  assert.match(both, /BOTH-WORLDS state/);
  assert.match(both, /FROZEN\s+SNAPSHOT/);
  assert.match(both, /never merge 'board' into 'main'/);

  // F3(a): the preview's coordination warning states the REAL consequence — a clone whose
  // unpushed board commits merge over the cleanup PR stays partially tracked and needs the
  // untrack escape.
  const previewForCopy = committedPreviewRecord(INV, "main");
  assert.match(String(previewForCopy.before_you_run), /git rm -r --cached/);
  assert.match(String(previewForCopy.before_you_run), /sync will refuse there until they are untracked/);

  // Forbidden-vocabulary sweep over every user-facing committed-case string.
  const preview = committedPreviewRecord(INV, "main");
  const steps = committedNextSteps(INV, "main");
  const everything = JSON.stringify({
    preview,
    note,
    both,
    steps,
    ESTABLISH_COMMITTED_PREVIEW,
    ESTABLISH_COMMITTED_ALREADY,
    ESTABLISH_COMMITTED_DONE,
  });
  assert.doesNotMatch(everything, FORBIDDEN);
});

test("withIgnoreEntries: appends both names once, is idempotent, and respects existing spellings", () => {
  const appended = withIgnoreEntries("node_modules/\n");
  assert.match(appended, /managed on the 'board' branch by superbee sync/);
  assert.doesNotMatch(appended, /by aslite sync/);
  assert.match(appended, /^node_modules\/\n\n#.*\n\.superbee\/\n\.agentstate-lite\/\n$/s);
  assert.equal(withIgnoreEntries(appended), appended, "idempotent");
  for (const spelling of [".superbee", ".superbee/", "/.superbee", "/.superbee/"]) {
    const covered = withIgnoreEntries(`${spelling}\n`);
    assert.equal(covered.startsWith(`${spelling}\n`), true, `existing '${spelling}' respected`);
    assert.match(covered, /\.agentstate-lite\/\n$/);
  }
  const fresh = withIgnoreEntries("");
  assert.equal(fresh.startsWith("#"), true, "no leading blank line in a fresh .gitignore");
  assert.match(fresh, /\.superbee\/\n\.agentstate-lite\/\n$/);
  assert.equal(withIgnoreEntries(fresh), fresh);
});

// ── preview (no --yes): a dry run that mutates nothing ────────────────────────

test("sync --establish on a committed folder without --yes: pinned preview, nothing mutated", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.deepEqual(rec, committedPreviewRecord(INV, "main"));
    assert.equal(rec.establish, ESTABLISH_COMMITTED_PREVIEW);
    assertPristine(topo, topo.a.root, preHead);
    assert.equal(git(topo.a.root, ["status", "--porcelain"]).trim(), "", "working tree untouched");
    assert.doesNotMatch(JSON.stringify(rec), FORBIDDEN);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("legacy committed-folder establish keeps .agentstate-lite selected in preview, guards, cleanup, and ignore coverage", async () => {
  const topo = await makeCommittedFolderTopology(LEGACY_BUNDLE_DIR);
  const { home, cleanup } = await tempHome();
  try {
    const preview = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.match(JSON.stringify(preview), /\.agentstate-lite/);

    await writeFile(path.join(topo.a.board, "local-change.md"), "# local\n");
    const dirty = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.match(dirty.err?.message ?? "", /\.agentstate-lite\/ has uncommitted changes/);
    await rm(path.join(topo.a.board, "local-change.md"));

    const complete = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    const cleanupTree = git(topo.a.root, ["show", `${complete.cleanup_commit}:.gitignore`]);
    assert.match(cleanupTree, /^\.superbee\/$/m);
    assert.match(cleanupTree, /^\.agentstate-lite\/$/m);
    assert.equal(gitTry(topo.a.root, ["cat-file", "-e", `${complete.cleanup_commit}:${LEGACY_BUNDLE_DIR}`]).status, 128);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("sync --establish never treats a Git-tracked legacy bundle as greenfield when a canonical filesystem bundle also exists", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const canonical = path.join(topo.a.root, BUNDLE_DIR);
    const legacy = path.join(topo.a.root, ".agentstate-lite");
    git(topo.a.root, ["mv", BUNDLE_DIR, ".agentstate-lite"]);
    git(topo.a.root, ["commit", "-m", "keep the committed bundle at its legacy path"]);
    await rename(legacy, `${legacy}.moved-aside`);
    await writeFile(canonical, "occupied");

    const { err } = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(err?.code, "RUNTIME");
    assert.match(err?.message ?? "", /uncommitted changes/i);
    assert.equal(gitTry(topo.origin, ["rev-parse", "refs/heads/board"]).status, 128);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── the full establishment + both clones' vanish-reappear journey ─────────────

test("sync --establish --yes on a committed folder: files-not-history board branch, PR-shaped cleanup, both-worlds window, and the full two-clone journey", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: homeA, cleanup: cleanupA } = await tempHome();
  const { home: homeB, cleanup: cleanupB } = await tempHome();
  try {
    // Staged user code must survive the establishment untouched (plumbing-only removal commit).
    const stagedPath = await plantStagedUserCode(topo.a);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const preOriginMain = git(topo.origin, ["rev-parse", "refs/heads/main"]).trim();

    const rec = await runSyncJson(homeA, ["--establish", "--yes", "--dir", topo.a.root]);

    // Receipt strings pinned.
    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);
    assert.equal(rec.pushed, "origin/board (tracking set)");
    assert.equal(rec.cleanup_branch, CLEANUP_BRANCH);
    assert.equal(rec.both_worlds, bothWorldsLine("main"));
    assert.deepEqual(rec.tell_your_teammates, rolloutNote(INV, "main"));
    const steps = rec.next_steps as string[];
    assert.equal(steps.length, 3);
    assert.equal(steps[0], `push the cleanup branch: git push -u origin ${CLEANUP_BRANCH}`);
    assert.match(steps[1]!, new RegExp(`open a PR from '${CLEANUP_BRANCH}' into 'main'`));
    assert.match(steps[2]!, /'git pull', then '.* sync'/);
    assert.doesNotMatch(JSON.stringify(rec), FORBIDDEN);

    // Board branch on origin, exactly ONE commit (files, not history — a fresh root).
    const boardSha = (rec.board_commit as string).trim();
    assert.equal(git(topo.a.root, ["rev-parse", "refs/heads/board"]).trim(), boardSha);
    assert.equal(git(topo.origin, ["rev-parse", "refs/heads/board"]).trim(), boardSha);
    assert.equal(git(topo.a.root, ["rev-list", "--count", "refs/heads/board"]).trim(), "1");
    // Bundle at the branch ROOT.
    const boardFiles = git(topo.a.root, ["ls-tree", "-r", "--name-only", "refs/heads/board"]);
    assert.match(boardFiles, /^index\.md$/m);
    assert.match(boardFiles, /^tasks\/seed-one\.md$/m);
    assert.doesNotMatch(boardFiles, /README\.md/, "board branch carries ONLY the bundle");
    // `push -u` was load-bearing: tracking config exists.
    assert.equal(git(topo.a.root, ["config", "branch.board.remote"]).trim(), "origin");
    assert.equal(git(topo.a.root, ["config", "branch.board.merge"]).trim(), "refs/heads/board");
    // The crash marker is cleared on the completed path.
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "marker cleared after success");

    // PR-shaped removal: ONE commit on the local cleanup branch; main/current branch untouched.
    const removalSha = (rec.cleanup_commit as string).trim();
    assert.equal(git(topo.a.root, ["rev-parse", `refs/heads/${CLEANUP_BRANCH}`]).trim(), removalSha);
    assert.equal(git(topo.a.root, ["rev-parse", `${CLEANUP_BRANCH}~1`]).trim(), preHead, "exactly one commit on top of main");
    const removalTree = git(topo.a.root, ["ls-tree", "--name-only", CLEANUP_BRANCH]);
    assert.doesNotMatch(removalTree, /\.superbee/, "folder removed from the cleanup branch's tree");
    const gitignore = git(topo.a.root, ["show", `${CLEANUP_BRANCH}:.gitignore`]);
    assert.match(gitignore, /^\.superbee\/$/m, "gitignore entry present");
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead, "current branch did not move");
    assert.equal(git(topo.a.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main", "still on main");
    assert.equal(
      gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "cleanup branch NOT pushed",
    );
    assert.equal(git(topo.origin, ["rev-parse", "refs/heads/main"]).trim(), preOriginMain, "origin main untouched");
    // Staged user code untouched, still staged.
    const staged = git(topo.a.root, ["diff", "--cached", "--name-only"]);
    assert.match(staged, new RegExp(stagedPath.replace("/", "\\/")));
    assert.equal(existsSync(path.join(topo.a.root, BUNDLE_DIR, "index.md")), true, "folder still on disk (frozen snapshot)");

    // BOTH-WORLDS window semantics (test-pinned): the folder is a frozen snapshot main still
    // TRACKS, so a plain `sync` on this clone refuses with the window-aware guidance — NEVER the
    // generic "move it aside" advice, which would hand-build the phantom-modification →
    // checkout-restore → stale-push overlay the U5 reviewer proved.
    const during = await runSync(homeA, ["--dir", topo.a.root, "--json"]);
    assert.equal(during.err?.code, "RUNTIME");
    assert.match(during.err!.message, /the folder-removal \(cleanup\) PR hasn't merged yet, or this clone hasn't pulled it/);
    assert.doesNotMatch(during.err!.message, /move it aside/);
    assert.match(during.err!.help ?? "", /git pull/);

    // COMPLETION — literally run the receipt's emitted chain (verbatim-execution pin).
    // 1. "git push -u origin board-cleanup" (from next_steps[0]).
    git(topo.a.root, ["push", "-u", "origin", CLEANUP_BRANCH]);
    // 2. Merge the PR (simulated: ff-merge into main and push — the working tree's folder
    //    vanishes here, exactly the moment the rollout note describes).
    git(topo.a.root, ["merge", "--ff-only", CLEANUP_BRANCH]);
    git(topo.a.root, ["push", "origin", "main"]);
    assert.equal(existsSync(path.join(topo.a.root, BUNDLE_DIR)), false, "folder vanished from A after the merge");
    // 3. "'git pull', then 'sync'" on clone A: provisions LOUDLY, docs intact. Clone A
    // materializes from its OWN local `board` branch here (establishment itself created that
    // local branch before pushing it) — not literally "from origin/board" (that's clone B's
    // path below, which never created one locally).
    const afterA = await runSyncJson(homeA, ["--dir", topo.a.root]);
    assert.match(String(afterA.provisioned), /materialized from the local board branch/);
    assert.match(await readBoardFile(topo.a, "tasks/seed-one.md"), /Seed one/);

    // The OTHER teammate's journey (clone B): pull → folder gone → sync provisions loudly → intact.
    assert.equal(existsSync(path.join(topo.b.root, BUNDLE_DIR, "index.md")), true, "B still has the folder pre-pull");
    // Pre-pull, B's plain `sync` gets the same window refusal — never the mv advice.
    const preB = await runSync(homeB, ["--dir", topo.b.root, "--json"]);
    assert.equal(preB.err?.code, "RUNTIME");
    assert.match(preB.err!.message, /the folder-removal \(cleanup\) PR hasn't merged yet, or this clone hasn't pulled it/);
    // And B's --establish --yes at this point is the already-established state (c) with the
    // LANDED probe: the removal has reached origin/main, so the note says so truthfully.
    const bAlready = await runSyncJson(homeB, ["--establish", "--yes", "--dir", topo.b.root]);
    assert.equal(bAlready.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(bAlready.note), /already landed on 'main' — run 'git pull'/);
    git(topo.b.root, ["pull"]);
    assert.equal(existsSync(path.join(topo.b.root, BUNDLE_DIR)), false, "folder vanished from B after git pull");
    const afterB = await runSyncJson(homeB, ["--dir", topo.b.root]);
    assert.match(String(afterB.provisioned), /materialized from origin\/board/);
    assert.match(await readBoardFile(topo.b, "tasks/seed-one.md"), /Seed one/);
    // And B is genuinely syncing: an idempotent re-run reports the definitive empty state.
    const againB = await runSyncJson(homeB, ["--dir", topo.b.root]);
    assert.equal(againB.sync, "already up to date");
  } finally {
    await topo.cleanup();
    await cleanupA();
    await cleanupB();
  }
});

// ── idempotence ───────────────────────────────────────────────────────────────

test("sync --establish --yes is idempotent: re-run and teammate-run both report already established (exit 0)", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    const boardSha = git(topo.origin, ["rev-parse", "refs/heads/board"]).trim();

    // Re-run on the establishing clone: exit 0, pinned string, nothing changes. State (a) of the
    // already-established branching: the cleanup branch exists, so the note guides to the PR —
    // the happy path's lost-receipt affordance.
    const removalSha = git(topo.a.root, ["rev-parse", `refs/heads/${CLEANUP_BRANCH}`]).trim();
    const again = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(again.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(again.note), /already prepared on 'board-cleanup' — push it and open its PR/);
    assert.equal((again.next_steps as string[])[0], `push the cleanup branch: git push -u origin ${CLEANUP_BRANCH}`);
    assert.equal(git(topo.origin, ["rev-parse", "refs/heads/board"]).trim(), boardSha);
    assert.equal(git(topo.a.root, ["rev-parse", `refs/heads/${CLEANUP_BRANCH}`]).trim(), removalSha, "nothing recreated");

    // Teammate's clone (folder still committed, hasn't pulled, NO local evidence): state (c) —
    // already established, nothing mutated, and the note is TRUTHFUL about where the removal is
    // (the PR hasn't landed on origin/main yet — never asserts a PR this clone can't see).
    const preHeadB = git(topo.b.root, ["rev-parse", "HEAD"]).trim();
    const teammate = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.b.root]);
    assert.equal(teammate.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(teammate.note), /once the folder-removal lands on the default branch: 'git pull'/);
    assert.equal(git(topo.b.root, ["rev-parse", "HEAD"]).trim(), preHeadB);
    assert.equal(
      gitTry(topo.b.root, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status !== 0,
      true,
      "no local board branch created on B",
    );
    assert.equal(
      gitTry(topo.b.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "no cleanup branch created on B",
    );
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── the Codex PR#26 finding: no stale guidance on a fully shared clone ────────

test("a leftover local cleanup branch on a FULLY shared clone never resurrects push-the-PR guidance", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // Execute and complete the whole journey, deliberately KEEPING the local cleanup branch.
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    git(topo.a.root, ["merge", "--ff-only", CLEANUP_BRANCH]);
    git(topo.a.root, ["push", "origin", "main"]);
    assert.equal(existsSync(path.join(topo.a.root, BUNDLE_DIR)), false, "folder gone after the merge");
    assert.equal(gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status, 0);

    // The folder is no longer committed, so --establish routes past the committed case entirely:
    // ordinary already-established behavior, never the stale "push it and open its PR" note.
    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_ALREADY);
    assert.match(String(rec.provisioned), /materialized from the local board branch/);
    assert.doesNotMatch(JSON.stringify(rec), /push it and open its PR/);
    assert.match(await readBoardFile(topo.a, "tasks/seed-one.md"), /Seed one/);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── refusals ──────────────────────────────────────────────────────────────────

test("committed-case establish refuses on uncommitted board changes, naming them; nothing mutated", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    await writeFile(path.join(topo.a.board, "tasks", "seed-one.md"), "---\ntype: Task\ntitle: dirty\n---\n# dirty\n");
    await writeFile(path.join(topo.a.board, "stray-note.md"), "---\ntype: Note\ntitle: new\n---\n# new\n");

    for (const argv of [["--establish", "--yes"], ["--establish"]]) {
      const { err } = await runSync(home, [...argv, "--dir", topo.a.root, "--json"]);
      assert.equal(err?.code, "RUNTIME");
      assert.match(err!.message, /establish refused: \.superbee\/ has uncommitted changes/);
      const uncommitted = (err!.details as { uncommitted: { total: number; rows: Array<{ path: string }> } }).uncommitted;
      assert.equal(uncommitted.total, 2);
      const paths = uncommitted.rows.map((r) => r.path).sort();
      assert.deepEqual(paths, [".superbee/stray-note.md", ".superbee/tasks/seed-one.md"]);
      assert.match(err!.help ?? "", /sync --establish --yes$/);
      assertPristine(topo, topo.a.root, preHead);
    }
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("committed-case structured refusals: detached HEAD and a stray local board branch", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // Detached HEAD (the committed folder is still at HEAD, so the committed case routes).
    git(topo.a.root, ["checkout", "--detach"]);
    const detached = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(detached.err?.code, "RUNTIME");
    assert.match(detached.err!.message, /detached HEAD/);
    git(topo.a.root, ["checkout", "main"]);

    // A stray local `board` branch that is NOT an interrupted-run remnant.
    git(topo.a.root, ["branch", "board", "main"]);
    const stray = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(stray.err?.code, "RUNTIME");
    assert.match(stray.err!.message, /a local 'board' branch already exists and does not match the committed folder/);
    git(topo.a.root, ["branch", "-D", "board"]);

    // No forbidden vocabulary in any of the refusal strings.
    for (const e of [detached.err, stray.err]) {
      assert.doesNotMatch(`${e!.message} ${e!.help ?? ""}`, FORBIDDEN);
    }
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("committed-case establish recovers an interrupted pre-push run: a matching single-root local board branch is reused", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // Simulate the pre-push crash: the root commit + branch exist locally, but nothing was pushed.
    const treeSha = git(topo.a.root, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
    const orphanSha = git(topo.a.root, ["commit-tree", treeSha, "-m", "board: interrupted run"]).trim();
    git(topo.a.root, ["branch", "board", orphanSha]);

    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);
    assert.equal((rec.board_commit as string).trim(), orphanSha, "the interrupted run's root commit is reused");
    assert.equal(git(topo.origin, ["rev-parse", "refs/heads/board"]).trim(), orphanSha);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── crash-window recovery: the WRITE-TIME MARKER is the discriminator ─────────

test("crash window (killed between push -u and the removal commit): re-run offers, --yes re-creates just the removal commit", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const rootSha = plantCrashWindow(topo.a.root);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();

    // Without --yes: the OFFER — and the already-established path never mutates under a bare run.
    const offer = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(offer.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(
      String(offer.note),
      /an interrupted establishment left the board branch pushed but no folder-removal commit — re-run/,
    );
    assert.match(String(offer.note), /--establish --yes/);
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "the offer mutated nothing",
    );
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "the marker stays until recovery completes");

    // With --yes: the recovery re-creates JUST the removal commit and guides to the PR.
    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(rec.recovered), /it has been re-created on 'board-cleanup'/);
    const removalSha = (rec.cleanup_commit as string).trim();
    assert.equal(git(topo.a.root, ["rev-parse", `refs/heads/${CLEANUP_BRANCH}`]).trim(), removalSha);
    assert.equal(git(topo.a.root, ["rev-parse", `${CLEANUP_BRANCH}~1`]).trim(), preHead, "one commit on top of main");
    assert.doesNotMatch(git(topo.a.root, ["ls-tree", "--name-only", CLEANUP_BRANCH]), /\.superbee/);
    assert.match(git(topo.a.root, ["show", `${CLEANUP_BRANCH}:.gitignore`]), /^\.superbee\/$/m);
    assert.equal((rec.next_steps as string[])[0], `push the cleanup branch: git push -u origin ${CLEANUP_BRANCH}`);
    assert.equal(git(topo.origin, ["rev-parse", "refs/heads/board"]).trim(), rootSha, "board on origin untouched");
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead, "current branch untouched");
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "marker cleared after recovery");
    assert.doesNotMatch(JSON.stringify(rec), FORBIDDEN);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("the crash discriminator is NOT spoofable: a teammate's local board branch without the marker is never offered the recovery", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // A establishes fully; B (in the window) merely peeks at the shared board branch.
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    git(topo.b.root, ["fetch", "origin"]);
    git(topo.b.root, ["branch", "board", "origin/board"]);
    const preHeadB = git(topo.b.root, ["rev-parse", "HEAD"]).trim();

    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.b.root]);
    assert.equal(rec.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.equal("recovered" in rec, false, "no recovery offered without this clone's own marker");
    assert.match(String(rec.note), /once the folder-removal lands on the default branch: 'git pull'/);
    assert.equal(
      gitTry(topo.b.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "no cleanup branch created on the teammate's clone",
    );
    assert.equal(git(topo.b.root, ["rev-parse", "HEAD"]).trim(), preHeadB, "B untouched");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("crash recovery refuses when a DIFFERENT origin/board was published: the marker's snapshot must be contained", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // A's push crashed before landing (simulated: root commit + branch + marker, NO push) — then
    // B establishes for real. A's marker now names a snapshot origin/board does not contain.
    const treeSha = git(topo.a.root, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
    const dates = { GIT_AUTHOR_DATE: "2005-04-07T22:13:13", GIT_COMMITTER_DATE: "2005-04-07T22:13:13" };
    const rootSha = git(topo.a.root, ["commit-tree", treeSha, "-m", "board: bundle shared from 'main' (files only)"], dates).trim();
    git(topo.a.root, ["branch", "board", rootSha]);
    plantCommittedMarker(topo.a.root, rootSha);
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.b.root]);

    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const { err } = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(err?.code, "CONFLICT");
    assert.match(err!.message, /does not contain this clone's interrupted establishment snapshot/);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead);
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "nothing recreated against a foreign board",
    );
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "the marker evidence is preserved");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("crash recovery refuses when the committed folder changed after the interrupted push: newer board commits are never silently stranded", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    plantCrashWindow(topo.a.root);
    // The user commits MORE board changes on main after the crash — the pushed snapshot is stale.
    await writeFile(path.join(topo.a.board, "tasks", "after-crash.md"), "---\ntype: Task\ntitle: After\n---\n# After\n");
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "board: post-crash board change on main"]);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();

    const { err } = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(err?.code, "CONFLICT");
    assert.match(err!.message, /would strand those newer board changes/);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead);
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "no removal commit cut from a stale snapshot",
    );
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── the LOST race: a marker whose snapshot origin/board does not contain ──────

/**
 * Plant the race LOSER's state on clone A: root commit cut, local board branch created, marker
 * written — but the push LOST (never landed), and the teammate (B) then published a DIVERGENT
 * board. origin/board does not contain the returned sha.
 */
async function plantLostRace(topo: TwoCloneTopology, home: string): Promise<string> {
  await writeFile(path.join(topo.a.board, "tasks", "only-on-a.md"), "---\ntype: Task\ntitle: Only on A\n---\n# Only on A\n");
  git(topo.a.root, ["add", "-A"]);
  git(topo.a.root, ["commit", "-m", "board: a-only doc"]);
  const treeSha = git(topo.a.root, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
  const rootSha = git(topo.a.root, ["commit-tree", treeSha, "-m", "board: bundle shared from 'main' (files only)"]).trim();
  git(topo.a.root, ["branch", "board", rootSha]);
  plantCommittedMarker(topo.a.root, rootSha);
  await runSyncJson(home, ["--establish", "--yes", "--dir", topo.b.root]);
  return rootSha;
}

test("a lost establish race is reported truthfully: state (b) never claims the loser's board was pushed", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await plantLostRace(topo, home);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_COMMITTED_ALREADY);
    // F-D3: claim only what is KNOWN — a different board is published NOW and this snapshot is
    // not part of it ("never published" would overclaim in the crash-then-force-push corner).
    assert.match(String(rec.note), /a different board is published on origin\/board/);
    assert.match(String(rec.note), /snapshot is not part of it/);
    assert.doesNotMatch(String(rec.note), /never published/);
    assert.doesNotMatch(JSON.stringify(rec), /left the board branch pushed/, "the false interrupted-establishment note is gone");
    assert.equal("recovered" in rec, false, "never offered the removal-commit recovery");
    assert.match(String(rec.discard), /^git branch -D board, then re-run/);
    // Nothing mutated: the marker + local-branch evidence is preserved, nothing created.
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "marker preserved while the local branch exists");
    assert.equal(gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status, 0);
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "no cleanup branch created",
    );
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead);
    assert.doesNotMatch(JSON.stringify(rec), FORBIDDEN);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("the lost-race journey terminates: --yes CONFLICTs with the discard path, following it clears the stale marker exactly once", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await plantLostRace(topo, home);

    // --yes: the pinned CONFLICT, its help documenting the full escape.
    const conflict = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(conflict.err?.code, "CONFLICT");
    assert.match(conflict.err!.message, /does not contain this clone's interrupted establishment snapshot/);
    assert.match(conflict.err!.help ?? "", /git branch -D board/);
    assert.match(conflict.err!.help ?? "", /stale marker is cleared automatically once the branch is gone/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "the CONFLICT preserves the marker evidence");

    // Follow the CLI's own help.
    git(topo.a.root, ["branch", "-D", "board"]);

    // The next run terminates the loop; the marker clear is the ONLY mutation.
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const cleared = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(cleared.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(cleared.cleared), /snapshot is not part of it — its stale marker has been cleared/);
    assert.doesNotMatch(String(cleared.cleared), /never published/);
    assert.match(String(cleared.note), /once the folder-removal lands on the default branch: 'git pull'/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "marker cleared");
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead, "HEAD untouched");
    assert.equal(git(topo.a.root, ["status", "--porcelain"]).trim(), "", "working tree untouched");
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${CLEANUP_BRANCH}`]).status !== 0,
      true,
      "no cleanup branch created on the loser",
    );

    // Subsequent runs route normally (state c) — the clear fired exactly once.
    const after = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(after.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.equal("cleared" in after, false);
    assert.equal("recovered" in after, false);
    assert.match(String(after.note), /once the folder-removal lands on the default branch/);
    assert.doesNotMatch(JSON.stringify(cleared) + JSON.stringify(after), FORBIDDEN);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("the stale-marker auto-clear never fires on a contained snapshot, even with the local board branch gone", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    plantCrashWindow(topo.a.root); // the marker's snapshot IS on origin/board
    git(topo.a.root, ["branch", "-D", "board"]);

    const offer = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.match(String(offer.note), /an interrupted establishment left the board branch pushed but no folder-removal commit/);
    assert.equal("cleared" in offer, false);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "a contained snapshot is never auto-cleared");

    // And --yes still completes the REAL recovery from this state.
    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.match(String(rec.recovered), /re-created on 'board-cleanup'/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "recovery (not the stale-clear) clears the marker");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("an unverifiable marker (dead fetch) never claims the board was pushed and never auto-clears", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await plantLostRace(topo, home);
    // One live run populates refs/remotes/origin/board on A; then A goes offline and even
    // discards its local branch — the clear still must not fire without a live fetch.
    await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "nonexistent.git")]);
    git(topo.a.root, ["branch", "-D", "board"]);

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.match(String(rec.note), /cannot be reached to verify what was published — get online/);
    assert.doesNotMatch(JSON.stringify(rec), /left the board branch pushed/);
    assert.equal("cleared" in rec, false);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "the clear never fires off a dead fetch");
    assert.doesNotMatch(JSON.stringify(rec), FORBIDDEN);

    const yes = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(yes.err?.code, "TRANSIENT");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── behind-origin freshness guard + dead-fetch refusal ────────────────────────

test("behind-origin guard: a stale clone whose origin carries a teammate's board commit refuses; pull-then-establish carries it", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // The U5 reviewer's exact disaster setup: B pushes a board commit to main; A establishes UNPULLED.
    await writeFile(
      path.join(topo.b.board, "tasks", "from-b.md"),
      "---\ntype: Task\ntitle: From B\nactor: mike\n---\n# From B\n",
    );
    git(topo.b.root, ["add", "-A"]);
    git(topo.b.root, ["commit", "-m", "board: B adds a task"]);
    git(topo.b.root, ["push", "origin", "main"]);

    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    for (const argv of [["--establish", "--yes"], ["--establish"]]) {
      const { err } = await runSync(home, [...argv, "--dir", topo.a.root, "--json"]);
      assert.equal(err?.code, "RUNTIME", argv.join(" "));
      assert.match(err!.message, /'main' is behind origin\/main with board changes/);
      assert.match(err!.message, /strand a teammate's board commits/);
      assert.match(err!.help ?? "", /^git pull, then re-run/);
      assert.equal((err!.details as { behind_board_commits: number }).behind_board_commits, 1);
      assertPristine(topo, topo.a.root, preHead);
    }

    // The guard's whole point: pull first, and the teammate's doc IS on the board branch.
    git(topo.a.root, ["pull"]);
    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);
    assert.match(git(topo.a.root, ["ls-tree", "-r", "--name-only", "refs/heads/board"]), /^tasks\/from-b\.md$/m);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("behind-origin on NON-board commits does not block establishment (the board tree is identical either way)", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await writeFile(path.join(topo.b.root, "README.md"), "# demo project — updated by B\n");
    git(topo.b.root, ["add", "-A"]);
    git(topo.b.root, ["commit", "-m", "docs: B updates the README"]);
    git(topo.b.root, ["push", "origin", "main"]);

    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("a network fetch failure preserves TRANSIENT classification and refuses before committed-case mutation", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["remote", "set-url", "origin", "https://127.0.0.1:1/nonexistent.git"]);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    for (const argv of [["--establish", "--yes"], ["--establish"]]) {
      const { err } = await runSync(home, [...argv, "--dir", topo.a.root, "--json"]);
      assert.equal(err?.code, "TRANSIENT", argv.join(" "));
      assert.match(err!.message, /remote repository and board states remain unknown/);
      assert.equal((err!.details as { retryable: boolean }).retryable, true);
      assert.deepEqual(err!.details?.sharing, {
        operation: "establish-preflight",
        remote_repository: "unknown",
        remote_board: "unknown",
        repository_creation: "external-if-absent",
        local_work: "preserved",
        cause_certainty: "best-effort",
        possible_causes: ["network"],
      });
      assert.doesNotMatch(`${err?.message} ${err?.help}`, /sync --establish|create (?:a|the|another|it) (?:remote )?repository/i);
    }
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead);
    assert.equal(
      gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status !== 0,
      true,
      "nothing mutated offline",
    );
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("an access-shaped committed fetch failure remains AUTH_REQUIRED and mutates no ref or marker", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "private-or-missing.git")]);
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const { err } = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(err?.code, "AUTH_REQUIRED");
    assert.equal(err?.exitCode, 4);
    assert.equal(err?.details?.best_effort, true);
    assert.deepEqual(err?.details?.sharing, {
      operation: "establish-preflight",
      remote_repository: "unknown",
      remote_board: "unknown",
      repository_creation: "external-if-absent",
      required_authority: "repository-read-or-visibility",
      local_work: "preserved",
      cause_certainty: "best-effort",
      possible_causes: ["url", "authentication", "visibility", "repository-read"],
    });
    assert.doesNotMatch(`${err?.message} ${err?.help}`, /repository (?:is )?(?:missing|absent)|create (?:a|the) repository/i);
    assert.doesNotMatch(`${err?.message} ${err?.help}`, /sync --establish/i);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead);
    assert.notEqual(gitTry(topo.a.root, ["show-ref", "--verify", "refs/heads/board"]).status, 0);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("generic remote rejection during committed establishment preserves the local recovery state", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const preHead = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const sourceBefore = readFileSync(path.join(topo.a.root, BUNDLE_DIR, "index.md"), "utf8");
    const hook = path.join(topo.a.root, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\necho '! [remote rejected] board -> board (pre-receive hook declined)' >&2\nexit 1\n");
    await chmod(hook, 0o755);

    const { err } = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(err?.code, "RUNTIME");
    assert.equal(err?.details?.reason, "remote-rejected");
    assert.equal(err?.details?.best_effort, true);
    assert.deepEqual(err?.details?.sharing, {
      operation: "create-board",
      remote_repository: "exists-confirmed",
      remote_board: "absent-confirmed",
      repository_creation: "irrelevant",
      required_authority: "repository-write-and-board-create-policy",
      local_work: "preserved",
      cause_certainty: "best-effort",
      possible_causes: ["repository-write", "branch-policy"],
    });
    assert.match(`${err?.message} ${err?.help}`, /remote policy, branch rule, or server-side hook may be responsible/i);
    assert.doesNotMatch(`${err?.message} ${err?.help}`, /GitHub ruleset|repository creat(?:ion|e)/i);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), preHead, "source branch stays put");
    assert.equal(readFileSync(path.join(topo.a.root, BUNDLE_DIR, "index.md"), "utf8"), sourceBefore);
    assert.equal(git(topo.a.root, ["diff", "--cached", "--name-only"]), "");
    assert.equal(gitTry(topo.a.root, ["show-ref", "--verify", "refs/heads/board"]).status, 0, "root snapshot remains locally");
    assert.notEqual(gitTry(topo.origin, ["show-ref", "--verify", "refs/heads/board"]).status, 0);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "marker preserves crash recovery provenance");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── board/… namespace D/F conflict ────────────────────────────────────────────

test("branches under board/… (remote or local) refuse the committed case by name; cleared, establishment proceeds", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // The EXACT shape this repo's own origin carried: a merged PR branch named board/<something>.
    git(topo.b.root, ["push", "origin", "main:refs/heads/board/sync-verb-tasks"]);

    const remoteCase = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(remoteCase.err?.code, "RUNTIME");
    assert.match(remoteCase.err!.message, /branches named 'board\/…' exist/);
    assert.match(remoteCase.err!.message, /board\/sync-verb-tasks \(on origin\)/);
    assert.match(remoteCase.err!.help ?? "", /delete or rename these branches/);

    // A LOCAL offender is named too (same D/F class against refs/heads/board).
    git(topo.a.root, ["branch", "board/local-experiment"]);
    const localCase = await runSync(home, ["--establish", "--dir", topo.a.root, "--json"]);
    assert.equal(localCase.err?.code, "RUNTIME");
    assert.match(localCase.err!.message, /board\/local-experiment \(local\)/);

    // Clear both offenders → the same command completes (the establishment fetch prunes the stale
    // refs/remotes/origin/board/* tracking ref, so the push's own tracking-ref update is clean).
    git(topo.a.root, ["branch", "-D", "board/local-experiment"]);
    git(topo.b.root, ["push", "origin", ":refs/heads/board/sync-verb-tasks"]);
    const rec = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);
    assert.equal(git(topo.origin, ["rev-list", "--count", "refs/heads/board"]).trim(), "1");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

// ── flag surface: the retired spelling and the --yes scope ────────────────────

test("--migrate is retired with a USAGE pointer at establish; --yes without --establish is USAGE", async () => {
  const { home, cleanup } = await tempHome();
  try {
    for (const argv of [["--migrate"], ["--migrate", "--yes"], ["--migrate", "--establish"]]) {
      const { err } = await runSync(home, [...argv, "--json"]);
      assert.equal(err?.code, "USAGE", argv.join(" "));
      assert.match(err!.message, /--migrate was retired/);
      assert.match(err!.message, /sync --establish/);
      assert.match(err!.help ?? "", /sync --establish$/);
    }
    const { err } = await runSync(home, ["--yes", "--json"]);
    assert.equal(err?.code, "USAGE");
    assert.match(err!.message, /--yes only applies to sync --establish/);
    assert.match(err!.help ?? "", /sync --establish --yes$/);
  } finally {
    await cleanup();
  }
});

// ── establish/window journeys (PR #75 QA carry-overs: F2, F3, F5, F-D1, F-D2) ──

/** Complete the human half of the committed-case journey on clone A: push + merge the cleanup PR. */
function mergeCleanupPr(topo: TwoCloneTopology): void {
  git(topo.a.root, ["push", "-u", "origin", CLEANUP_BRANCH]);
  git(topo.a.root, ["merge", "--ff-only", CLEANUP_BRANCH]);
  git(topo.a.root, ["push", "origin", "main"]);
}

test("F2 journey: the establisher's receipt chain ('git pull', then sync) survives a teammate advancing the board in the window", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: homeA, cleanup: cleanupA } = await tempHome();
  const { home: homeB, cleanup: cleanupB } = await tempHome();
  try {
    await runSyncJson(homeA, ["--establish", "--yes", "--dir", topo.a.root]);
    mergeCleanupPr(topo);

    // Teammate B pulls the merge, joins, and ADVANCES origin/board past A's root commit.
    git(topo.b.root, ["pull"]);
    await runSyncJson(homeB, ["--dir", topo.b.root]);
    await writeFile(
      path.join(topo.b.board, "tasks", "from-b.md"),
      "---\ntype: Task\ntitle: From B\nactor: bob\n---\n# From B\n",
    );
    await runSyncJson(homeB, ["--dir", topo.b.root]);

    // A runs the receipt's EXACT chain — 'git pull', then sync. This used to refuse exit 5
    // ("will not guess which history is safe") because A's leftover local `board` branch was a
    // strict ancestor of the advanced origin/board.
    git(topo.a.root, ["pull"]);
    const rec = await runSyncJson(homeA, ["--dir", topo.a.root]);
    assert.match(String(rec.provisioned), /materialized from origin\/board/);
    assert.equal(
      git(topo.a.root, ["rev-parse", "refs/heads/board"]).trim(),
      git(topo.a.root, ["rev-parse", "refs/remotes/origin/board"]).trim(),
      "A's leftover local branch fast-forwarded to origin/board",
    );
    assert.match(await readBoardFile(topo.a, "tasks/from-b.md"), /From B/, "the teammate's doc arrived");
    assert.match(await readBoardFile(topo.a, "tasks/seed-one.md"), /Seed one/, "the original docs are intact");

    // And the adopted clone is genuinely syncing: an idempotent re-run is the definitive empty state.
    const again = await runSyncJson(homeA, ["--dir", topo.a.root]);
    assert.equal(again.sync, "already up to date");
  } finally {
    await topo.cleanup();
    await cleanupA();
    await cleanupB();
  }
});

test("F3 wedge: a clone whose unpushed board commit merged over the cleanup PR gets the untrack escape (never dual-board, never 'git pull'), and the escape works verbatim", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: homeA, cleanup: cleanupA } = await tempHome();
  const { home: homeB, cleanup: cleanupB } = await tempHome();
  try {
    await runSyncJson(homeA, ["--establish", "--yes", "--dir", topo.a.root]);

    // B plants an UNPUSHED board commit on main during the window — the exact state the
    // preview's before_you_run warning names.
    await writeFile(
      path.join(topo.b.board, "tasks", "extra.md"),
      "---\ntype: Task\ntitle: Extra\nactor: bob\n---\n# Extra\n",
    );
    git(topo.b.root, ["add", `${BUNDLE_DIR}/tasks/extra.md`]);
    git(topo.b.root, ["commit", "-m", "board: b extra doc"]);

    mergeCleanupPr(topo);
    git(topo.b.root, ["pull", "--no-rebase"]);
    assert.equal(
      git(topo.b.root, ["ls-files", "--", BUNDLE_DIR]).trim(),
      `${BUNDLE_DIR}/tasks/extra.md`,
      "sanity: the wedge — exactly one remnant path tracked after the merge",
    );

    // The refusal is the ACTIONABLE escape, naming the actual tracked paths.
    const wedged = await runSync(homeB, ["--dir", topo.b.root, "--json"]);
    assert.equal(wedged.err?.code, "RUNTIME");
    assert.match(wedged.err!.message, /'git pull' has nothing left to fix/);
    assert.match(wedged.err!.message, /untrack/);
    assert.doesNotMatch(wedged.err!.message, /two competing board locations/, "never misclassified as dual-board");
    const details = wedged.err!.details as Record<string, unknown>;
    assert.equal(details.state, "window-remnant");
    const remnants = details.tracked_remnants as { shown: number; total: number; rows: string[] };
    assert.deepEqual(remnants.rows, [`${BUNDLE_DIR}/tasks/extra.md`], "the refusal names the actual tracked paths");
    assert.match(wedged.err!.help ?? "", /git rm -r --cached -- \.superbee/);
    assert.doesNotMatch(`${wedged.err!.message} ${wedged.err!.help ?? ""}`, FORBIDDEN);

    // F5 (wedge face): home's offline board line carries the SAME truth, one hop.
    const status = await withHome(homeB, () => defaultLoadBoardStatus(topo.b.root));
    assert.equal(status?.state, "window");
    assert.equal((status as { line: string }).line, wedged.err!.message, "home renders the refusal's own message");

    // establish's own state-(c) window note tells the remnant truth too — never the dead-end pull.
    const eb = await runSyncJson(homeB, ["--establish", "--dir", topo.b.root]);
    assert.equal(eb.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(eb.note), /'git pull' has nothing left to fix/);

    // FOLLOW the emitted escape chain: untrack, commit, move the leftovers aside, re-run sync.
    git(topo.b.root, ["rm", "-r", "--cached", "--", BUNDLE_DIR]);
    git(topo.b.root, ["commit", "-m", "board: untrack leftover board paths"]);
    await rename(path.join(topo.b.root, BUNDLE_DIR), path.join(topo.b.root, `${BUNDLE_DIR}.bak`));
    const rec = await runSyncJson(homeB, ["--dir", topo.b.root]);
    assert.match(String(rec.provisioned), /materialized from origin\/board/);
    assert.match(await readBoardFile(topo.b, "tasks/seed-one.md"), /Seed one/);
    assert.equal(
      existsSync(path.join(topo.b.root, `${BUNDLE_DIR}.bak`, "tasks", "extra.md")),
      true,
      "the local-only doc is preserved in the backup for reconciliation",
    );

  } finally {
    await topo.cleanup();
    await cleanupA();
    await cleanupB();
  }
});

test("F5 window: home's board block renders the pull-first window truth one-hop — never 'run sync' for a sync that refuses", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);

    const status = await withHome(home, () => defaultLoadBoardStatus(topo.a.root));
    assert.equal(status?.state, "window");
    const line = (status as { line: string }).line;
    assert.match(line, /the folder-removal \(cleanup\) PR hasn't merged yet, or this clone hasn't pulled it/);
    assert.match(line, /run 'git pull'/);
    assert.doesNotMatch(line, /not yet provisioned/);
    assert.doesNotMatch(line, FORBIDDEN);

    // And the sync refusal in the SAME state carries the SAME message — one factory, verbatim.
    const refused = await runSync(home, ["--dir", topo.a.root, "--json"]);
    assert.equal(refused.err?.code, "RUNTIME");
    assert.equal(line, refused.err!.message);

    // The pure render puts the line in the board slot (the init-hint-suppressing firstContact slot).
    const { block, firstContact } = buildBoardBlock(status!, undefined, INV);
    assert.equal(block, undefined);
    assert.equal(firstContact, line);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("F-D2: a SHALLOW history refuses to conclude anything about a non-contained marker — no lost-race claim, no auto-clear", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    await plantLostRace(topo, home);
    git(topo.a.root, ["branch", "-D", "board"]); // even with the branch gone — the auto-clear's usual trigger
    const gitDir = git(topo.a.root, ["rev-parse", "--absolute-git-dir"]).trim();
    const rootSha = git(topo.a.root, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    writeFileSync(path.join(gitDir, "shallow"), `${rootSha}\n`);

    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_COMMITTED_ALREADY);
    assert.match(String(rec.note), /shallow \(truncated\)/);
    assert.match(String(rec.note), /git fetch --unshallow/);
    assert.equal("cleared" in rec, false, "the auto-clear never fires off a truncated history");
    assert.doesNotMatch(JSON.stringify(rec), /different board is published/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "marker preserved");

    const yes = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(yes.err?.code, "RUNTIME");
    assert.match(yes.err!.message, /shallow/);
    assert.match(yes.err!.help ?? "", /git fetch --unshallow/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "marker preserved by the --yes refusal too");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("an INVALID/unverifiable marker is named for what it is — same refusal shapes, honest auto-clear copy", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    // A published board exists (via B); A carries a marker naming a commit that does not exist.
    await runSyncJson(home, ["--establish", "--yes", "--dir", topo.b.root]);
    plantCommittedMarker(topo.a.root, "0123456789abcdef0123456789abcdef01234567");
    git(topo.a.root, ["branch", "board", "HEAD"]); // discard evidence present: no clear may fire

    const offer = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.match(String(offer.note), /invalid or unverifiable/);
    assert.doesNotMatch(String(offer.note), /never published/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true);

    const conflict = await runSync(home, ["--establish", "--yes", "--dir", topo.a.root, "--json"]);
    assert.equal(conflict.err?.code, "CONFLICT");
    assert.match(conflict.err!.message, /invalid or unverifiable/);
    assert.match(conflict.err!.message, /cannot be found even after fetching/);

    // Discarding the branch lets the clear fire — with the honest invalid-marker story.
    git(topo.a.root, ["branch", "-D", "board"]);
    const cleared = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.match(String(cleared.cleared), /invalid or unverifiable/);
    assert.match(String(cleared.cleared), /its stale marker has been cleared/);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false);
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test("a stale committed-case marker on a FULLY-shared clone is cleared by establish — contained, or definitively over; never on a shallow history", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const done = await runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]);
    const boardSha = String(done.board_commit).trim();
    mergeCleanupPr(topo);
    await runSyncJson(home, ["--dir", topo.a.root]); // provisions the shared board — fully shared now

    // (1) contained: the marker's work landed — debris, cleared.
    plantCommittedMarker(topo.a.root, boardSha);
    const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(rec.establish, ESTABLISH_ALREADY);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "a contained marker is cleared once fully shared");

    // (2) NOT contained, but this clone already runs the winning board (provisioned) — cleared.
    const codeSha = git(topo.a.root, ["rev-parse", "HEAD"]).trim(); // a real commit that is NOT on the board branch
    plantCommittedMarker(topo.a.root, codeSha);
    await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), false, "a definitively-lost marker is cleared once fully shared");

    // (3) F-D2: a shallow history keeps a non-contained marker (containment unverifiable).
    plantCommittedMarker(topo.a.root, codeSha);
    const gitDir = git(topo.a.root, ["rev-parse", "--absolute-git-dir"]).trim();
    const rootSha = git(topo.a.root, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    writeFileSync(path.join(gitDir, "shallow"), `${rootSha}\n`);
    await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "shallow: the marker is preserved");
  } finally {
    await topo.cleanup();
    await cleanup();
  }
});

test(
  "F-D1: the auto-clear receipt never claims 'cleared' for a marker that survived the unlink (immutable file)",
  { skip: process.platform !== "darwin" ? "needs chflags(1)" : false },
  async () => {
    const topo = await makeCommittedFolderTopology();
    const { home, cleanup } = await tempHome();
    try {
      await plantLostRace(topo, home);
      git(topo.a.root, ["branch", "-D", "board"]);
      execFileSync("chflags", ["uchg", committedMarkerPath(topo.a.root)]);
      try {
        const rec = await runSyncJson(home, ["--establish", "--dir", topo.a.root]);
        assert.match(String(rec.cleared), /could NOT be removed/);
        assert.match(String(rec.cleared), /rm /, "the honest copy names the file to remove by hand");
        assert.doesNotMatch(String(rec.cleared), /has been cleared/);
        assert.equal(existsSync(committedMarkerPath(topo.a.root)), true, "the marker genuinely survived");
      } finally {
        execFileSync("chflags", ["nouchg", committedMarkerPath(topo.a.root)]);
      }
    } finally {
      await topo.cleanup();
      await cleanup();
    }
  },
);
