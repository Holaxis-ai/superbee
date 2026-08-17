/**
 * `identity-fallback.test.ts` — tasks/sync-fallback-identity: every sync-family COMMIT-CREATING
 * git call carries a per-invocation `-c user.name=… -c user.email=…` fallback
 * ({@link identityFlags}, porcelain.ts) when git itself cannot resolve a commit identity anywhere
 * it looks — a fresh container / identity-less CI runner otherwise dies with git's raw "Please
 * tell me who you are" on the FIRST sync commit. `../../cli/test/sync-fallback-identity.test.ts`
 * covers the CLI-level receipt/end-to-end shape (DoD 1/2/3 verbatim); this file pins the
 * PRIMITIVE directly and the two call sites that suite doesn't reach: the establishment's
 * plumbing commits, and — the design constraint's open question — whether the CONVERGING rebase's
 * replayed commits can hit the same failure. Empirically: YES (a replayed commit needs committer
 * identity too, same as any other commit), guarded the same way, pinned below.
 *
 * Hermeticity note (unlike git-porcelain.test.ts, which pins a module-level identity for its
 * WHOLE file): this file does NOT set one — `withNoGitIdentity` (git-harness.ts) supplies the
 * identity-LESS case per test; the ambient default (whatever the host naturally resolves)
 * supplies the has-identity case, matching `identityFlags`'s own contract (`[]` whenever git can
 * already construct an identity somewhere).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUNDLE_DIR,
  commitBoard,
  divergeDifferentDoc,
  fetchBoard,
  git,
  makeCommittedFolderTopology,
  makeTwoCloneTopology,
  modifyBoardDoc,
  pushBoard,
  withNoGitIdentity,
  writeBoardDoc,
} from "./git-harness.js";

import {
  createBoardRootCommit,
  createRemovalCommit,
  fetchRebase,
  fetchRebaseResolving,
  identityFlags,
  runGit,
  stageAndCommit,
} from "../src/index.js";

/** A commit's `{author, committer}` identity line, each `<name> <email>`. */
function identityOf(dir: string, rev = "HEAD"): { author: string; committer: string } {
  const [author, committer] = git(dir, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", rev]).trim().split("\n");
  return { author: author!, committer: committer! };
}

// ── identityFlags itself ────────────────────────────────────────────────────

test("identityFlags: [] once git already has a resolvable identity — byte-identical argv for every user with real config", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-identity-flags-"));
  try {
    git(scratch, ["init", "-q", "-b", "main"]);
    // The resolvable identity is CONSTRUCTED (a local repo config — one of the sources git itself
    // consults), never ambient host state: a hermetic CI runner resolves NO ambient identity at
    // all (empirically: both gate lanes), so a test leaning on the host's own config/guess is
    // machine-dependent. Run under withNoGitIdentity so the local config is the ONLY live source
    // — deterministic everywhere, and it pins that the probe respects local config specifically.
    git(scratch, ["config", "user.name", "Configured User"]);
    git(scratch, ["config", "user.email", "configured@example.invalid"]);
    await withNoGitIdentity(() => {
      assert.deepEqual(identityFlags(scratch), []);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("identityFlags: the four -c args once resolution genuinely fails — actor names user.name verbatim, its slug feeds user.email", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-identity-flags-"));
  try {
    git(scratch, ["init", "-q", "-b", "main"]);
    await withNoGitIdentity(() => {
      assert.deepEqual(identityFlags(scratch, "Mike Collier"), [
        "-c",
        "user.name=Mike Collier",
        "-c",
        "user.email=mike-collier@superbee.invalid",
      ]);
      // No actor at all -> the literal fallback for both name and email.
      assert.deepEqual(identityFlags(scratch), [
        "-c",
        "user.name=superbee",
        "-c",
        "user.email=superbee@superbee.invalid",
      ]);
      // A blank actor reads the same as an absent one.
      assert.deepEqual(identityFlags(scratch, "   "), identityFlags(scratch));
      // An actor that slugs to nothing (all punctuation) still names it verbatim in user.name; only
      // the EMAIL slug falls back to the literal.
      assert.deepEqual(identityFlags(scratch, "!!!"), [
        "-c",
        "user.name=!!!",
        "-c",
        "user.email=superbee@superbee.invalid",
      ]);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("identityFlags: author-only env (GIT_AUTHOR_* set, NO committer source) still injects — the author probe alone would return [] and the commit would die 'Committer identity unknown'", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-identity-flags-"));
  try {
    git(scratch, ["init", "-q", "-b", "main"]);
    await withNoGitIdentity(() => {
      // A real CI shape: only the author pair exported. Set INSIDE the wrapper (its restore pass
      // overwrites these on exit, so nothing leaks past this test).
      process.env.GIT_AUTHOR_NAME = "Env Author";
      process.env.GIT_AUTHOR_EMAIL = "env-author@example.invalid";
      // The hole, empirically: git itself resolves the author ident but NOT the committer ident —
      // an author-only probe would read this as "resolvable" and suppress the flags.
      assert.equal(runGit(scratch, ["var", "GIT_AUTHOR_IDENT"]).status, 0, "author ident resolves from env");
      assert.notEqual(runGit(scratch, ["var", "GIT_COMMITTER_IDENT"]).status, 0, "committer ident does NOT resolve");
      // So the flags MUST be injected. (Semantics are safe by construction: env beats -c for the
      // author, so a commit gets author=env, committer=synthetic.)
      assert.deepEqual(identityFlags(scratch), [
        "-c",
        "user.name=superbee",
        "-c",
        "user.email=superbee@superbee.invalid",
      ]);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── stageAndCommit (CLI-level DoD1 covers the end-to-end receipt; this pins the primitive directly) ──

test("stageAndCommit: a synthetic identity lands the commit when resolution fails; user.name is the doc's own single frontmatter actor", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeBoardDoc(topo.a, "notes/no-identity", {
      frontmatter: { type: "Note", title: "No identity", actor: "priya" },
      body: "# x\n",
    });
    const result = await withNoGitIdentity(() => stageAndCommit(topo.a.board));
    assert.equal(result.committed, true);
    const { author, committer } = identityOf(topo.a.board);
    assert.equal(author, "priya <priya@superbee.invalid>");
    assert.equal(committer, author, "commit created directly (not replayed) — author == committer");
  } finally {
    await topo.cleanup();
  }
});

// ── the establishment's plumbing commits (flow.ts) — no doc-level actor in scope ──────────────

test("createBoardRootCommit + createRemovalCommit: both plumbing commits succeed with the literal fallback identity when resolution fails", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    const top = topo.a.root;
    await withNoGitIdentity(() => {
      const treeSha = git(top, ["rev-parse", `HEAD:${BUNDLE_DIR}`]).trim();
      const boardSha = createBoardRootCommit(top, treeSha, "main");
      const board = identityOf(top, boardSha);
      assert.equal(board.author, "superbee <superbee@superbee.invalid>");
      assert.equal(board.committer, board.author);

      const removalSha = createRemovalCommit(top, "board: retire the committed folder\n", BUNDLE_DIR);
      const removal = identityOf(top, removalSha);
      assert.equal(removal.author, "superbee <superbee@superbee.invalid>");
      assert.equal(removal.committer, removal.author);
    });
  } finally {
    await topo.cleanup();
  }
});

// ── the CONVERGING rebase also creates commits — the design constraint's open question, answered ──

test("fetchRebase: a clean different-doc REPLAY creates a new commit whose COMMITTER is the synthetic identity when resolution fails (converge/rebase answer: YES, guarded)", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    // A pushes first; B's local commit is now NOT a descendant of the moved origin/board — a
    // genuine fork requiring a real REPLAY (not a fast-forward, which would need no identity at all).
    await divergeDifferentDoc(topo);
    const preReplayHead = git(topo.b.board, ["rev-parse", "HEAD"]).trim();

    const outcome = await withNoGitIdentity(() => fetchRebase(topo.b.board));
    assert.equal(outcome.status, "clean");

    const postReplayHead = git(topo.b.board, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(postReplayHead, preReplayHead, "genuinely replayed, not fast-forwarded");
    const { author, committer } = identityOf(topo.b.board);
    // git rebase PRESERVES the original commit's AUTHOR and sets only the COMMITTER to whoever ran
    // the replay — the harness planted this commit as "bob" (divergeDifferentDoc); no doc-level
    // actor context flows into a rebase replay, so the committer is the literal fallback.
    assert.equal(author, "bob <bob@example.invalid>", "author preserved from the original local commit");
    assert.equal(committer, "superbee <superbee@superbee.invalid>", "committer is the synthetic fallback");
  } finally {
    await topo.cleanup();
  }
});

test("fetchRebaseResolving: a resolved conflict whose replayed commit SURVIVES non-empty (the --continue path, not just --skip) also gets the synthetic committer identity when resolution fails", async () => {
  const topo = await makeTwoCloneTopology();
  const exportDir = await mkdtemp(path.join(tmpdir(), "aslite-identity-exports-"));
  try {
    // A same-doc-only divergence resolves to a wholly EMPTY replayed commit (every changed byte
    // reverts to upstream) — git's rebase machinery stops and the loop's `--skip` branch drops it
    // without ever calling commit-tree, so it can't prove `--continue`'s identity need. Touch a
    // SECOND, non-conflicting doc in B's commit too: after keep-upstream resolves the conflicting
    // doc, B's OTHER edit survives — a genuinely non-empty replayed commit that `--continue` must
    // actually commit.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# changed by A\n" });
    commitBoard(topo.a, "board: A edits seed-one", { author: { name: "alice", email: "alice@example.invalid" } });
    pushBoard(topo.a);

    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# changed by B\n" });
    await modifyBoardDoc(topo.b, "notes/welcome", { body: "# B's own welcome edit\n" });
    commitBoard(topo.b, "board: B edits seed-one AND welcome", { author: { name: "bob", email: "bob@example.invalid" } });
    fetchBoard(topo.b);

    const outcome = await withNoGitIdentity(() => fetchRebaseResolving(topo.b.board, exportDir));
    assert.equal(outcome.status, "resolved");
    // The replay genuinely landed a NEW commit (not just origin/board's own tip): welcome.md
    // carries B's surviving edit, seed-one.md carries A's kept-upstream version.
    assert.match(git(topo.b.board, ["show", "HEAD:notes/welcome.md"]), /B's own welcome edit/);
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), /changed by A/);
    const { author, committer } = identityOf(topo.b.board);
    assert.equal(author, "bob <bob@example.invalid>", "author preserved from the original local commit");
    assert.equal(committer, "superbee <superbee@superbee.invalid>", "committer is the synthetic fallback");
  } finally {
    await rm(exportDir, { recursive: true, force: true });
    await topo.cleanup();
  }
});
