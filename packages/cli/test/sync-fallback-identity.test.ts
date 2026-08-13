// Tests for tasks/sync-fallback-identity: sync-family git COMMITS must not die with git's raw
// "Please tell me who you are" on a fresh container / identity-less CI runner. The fallback
// primitive itself (`identityFlags`) lives in `@superbee/board-git`'s `porcelain.ts`; this
// file exercises it end-to-end through the CLI's real `sync()` entry points — the two DoD
// scenarios that need a REAL receipt: an ordinary sync commit, and the committed-folder
// establishment's cleanup commit.
//
// MASKING MECHANISM (confirmed empirically before writing this file): `packages/cli/package.json`'s
// own `test` script sets `GIT_AUTHOR_NAME=test-suite GIT_AUTHOR_EMAIL=test-suite@example.invalid
// GIT_COMMITTER_NAME=test-suite GIT_COMMITTER_EMAIL=test-suite@example.invalid` for the WHOLE
// `node --test` process — every sync-family git spawn in this suite inherits that identity via
// `process.env`, which is exactly why these tests pass today regardless of the host machine's own
// git config. `withNoGitIdentity` (git-harness.ts) strips those same vars for the duration of one
// call, PLUS neutralizes global/system config, PLUS forces `user.useConfigOnly=true` via a
// synthetic system config — empirically required because a dev machine's OS account still yields a
// guessed `<user>@<hostname>` identity even with every config/env source scrubbed (verified: a
// literal `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` + stripped env alone does NOT
// reproduce the failure on such a machine) — `useConfigOnly` disables that guess too, reproducing
// the identical "Please tell me who you are" class error a genuinely account-less container UID
// hits, deterministically and portably.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sync } from "../src/commands/sync.js";
import { CLEANUP_BRANCH, ESTABLISH_COMMITTED_DONE } from "../src/commands/sync-establish.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import {
  git,
  makeCommittedFolderTopology,
  makeTwoCloneTopology,
  withNoGitIdentity,
} from "../../board-git/test/git-harness.js";

// ── scaffolding (mirrors sync.test.ts / sync-establish-committed.test.ts) ──────

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function captureStdout(): { stdout: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { stdout: (s: string) => chunks.push(s), text: () => chunks.join("") };
}

async function runSync(home: string, argv: string[]): Promise<{ out: string; err?: CliError }> {
  const cap = captureStdout();
  try {
    await withHome(home, () => sync(argv, { stdout: cap.stdout, hookInstalled: () => true }));
    return { out: cap.text() };
  } catch (err) {
    if (err instanceof CliError) return { out: cap.text(), err };
    throw err;
  }
}

async function runSyncJson(home: string, argv: string[]): Promise<Record<string, unknown>> {
  const { out, err } = await runSync(home, [...argv, "--json"]);
  assert.equal(err, undefined, `expected success, got ${err?.code}: ${err?.message}`);
  return JSON.parse(out) as Record<string, unknown>;
}

async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "aslite-fallback-identity-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function cliDocWrite(boardDir: string, id: string, args: string[]): Promise<void> {
  await doc(["write", id, ...args, "--dir", boardDir, "--json"], {
    stdout: () => {},
    readStdin: async () => undefined,
  });
}

/** The board worktree's HEAD author/committer line, `<name> <email>|<committer name> <committer email>`. */
function identityLine(boardPath: string): { author: string; committer: string } {
  const [author, committer] = git(boardPath, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"])
    .trim()
    .split("\n");
  return { author: author!, committer: committer! };
}

// ── DoD 1: a real `sync` commit end-to-end, identity resolution failing ────────

test("sync: DoD1 — a fresh-container / identity-less git still commits, with a normal receipt and a synthetic author (tasks/sync-fallback-identity)", async () => {
  const topo = await makeTwoCloneTopology();
  const { home, cleanup } = await tempHome();
  try {
    await cliDocWrite(topo.a.board, "notes/no-identity", [
      "--type",
      "Note",
      "--title",
      "No identity",
      "--body",
      "# x\n",
      "--actor",
      "mike",
    ]);

    const rec = await withNoGitIdentity(() => runSyncJson(home, ["--dir", topo.a.root]));

    // The receipt is NORMAL — no trace of the fallback in the observable envelope.
    assert.equal(rec.committed, 1);
    assert.equal(rec.pushed, 1);
    assert.equal(rec.actor, "mike");

    // The commit that actually landed carries the synthetic identity: user.name is the
    // resolved actor ("mike", the doc's own frontmatter actor — the same value the receipt
    // names), user.email is its slug at the RFC 2606 `.invalid` placeholder domain.
    const { author, committer } = identityLine(topo.a.board);
    assert.equal(author, "mike <mike@superbee.invalid>");
    assert.equal(committer, author, "commit created directly (not replayed) — author == committer");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── DoD 2: the cleanup-commit path (establish committed-case), same isolation ──

test("sync --establish --yes: DoD2 — the committed-folder cleanup commit succeeds with a synthetic identity when git identity resolution fails (tasks/sync-fallback-identity)", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home, cleanup } = await tempHome();
  try {
    const rec = await withNoGitIdentity(() => runSyncJson(home, ["--establish", "--yes", "--dir", topo.a.root]));

    assert.equal(rec.established, ESTABLISH_COMMITTED_DONE);

    // The board root commit (createBoardRootCommit, flow.ts) — a plumbing commit with no doc-level
    // actor in scope, so the fallback's OWN literal names it.
    const boardSha = (rec.board_commit as string).trim();
    const boardIdentity = git(topo.a.root, ["log", "-1", "--format=%an <%ae>", boardSha]).trim();
    assert.equal(boardIdentity, "superbee <superbee@superbee.invalid>");

    // The folder-removal cleanup commit (createRemovalCommit, flow.ts) — same synthetic identity,
    // on the LOCAL, unpushed `board-cleanup` branch (the DoD's explicit in-scope commit).
    const cleanupSha = (rec.cleanup_commit as string).trim();
    assert.equal(git(topo.a.root, ["rev-parse", `refs/heads/${CLEANUP_BRANCH}`]).trim(), cleanupSha);
    const cleanupIdentity = git(topo.a.root, ["log", "-1", "--format=%an <%ae>", cleanupSha]).trim();
    assert.equal(cleanupIdentity, "superbee <superbee@superbee.invalid>");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── DoD 3: the no-override pin — a configured identity gets ZERO -c flags ──────

test("sync: DoD3 — a resolvable git identity gets NO synthetic override; the commit author is exactly the configured identity", async () => {
  const topo = await makeTwoCloneTopology();
  const { home, cleanup } = await tempHome();
  try {
    await cliDocWrite(topo.a.board, "notes/has-identity", [
      "--type",
      "Note",
      "--title",
      "Has identity",
      "--body",
      "# x\n",
      "--actor",
      "mike",
    ]);

    // Deliberately NOT wrapped in withNoGitIdentity: this suite's ambient process env (from
    // packages/cli/package.json's own `test` script) carries a real, resolvable git identity
    // (GIT_AUTHOR_NAME=test-suite / GIT_AUTHOR_EMAIL=test-suite@example.invalid, matching
    // and reusing this repo's OWN test-identity precedent) — the exact "identity already resolves"
    // case identityFlags must leave untouched.
    const rec = await runSyncJson(home, ["--dir", topo.a.root]);
    assert.equal(rec.committed, 1);

    const { author, committer } = identityLine(topo.a.board);
    assert.equal(author, "test-suite <test-suite@example.invalid>");
    assert.equal(committer, author);
    // Never the synthetic fallback identity — proves no -c override fired.
    assert.doesNotMatch(author, /@agentstate-lite\.invalid/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});
