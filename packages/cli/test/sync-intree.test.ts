// PR C acceptance suite for the IN-TREE board's CLI surface (plans/board-git-package §"In-tree
// mode semantics: READ-SIDE ONLY (v1)") — detection wired at sync's/session-start's own
// resolution points, the write-verb refusals, `--pull-only`'s fetch-and-report, the
// `--show-incoming` upstream viewer, the home/session-start render, the post-persist
// self-attribution hook's invariants, and the structural autopull exclusion.
//
// Adversarial coverage this file owns (the gate owns the risk it guards):
//   • refusal paths: full sync in-tree (structured, `details.state` discriminator);
//     `--establish` under an INDETERMINATE detection (both the tracked and untracked arms);
//     `--show-incoming` with no comparison basis;
//   • mode-flip cursor isolation, direction in-tree→branch (the package suite pins the other);
//   • no-upstream/detached degradation at the interactive verb (exit 0, honest empty state);
//   • the dead-remote fetch time-box on session-start (bounded, render always appears);
//   • the self-actors hook: records on substantive writes (both modes), never on `changed:false`
//     no-ops, never on refused writes, and a throwing hook never fails the write.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sync,
  syncInTreeRefusalMessage,
  inTreePullHint,
  SYNC_IN_TREE_BOARD_LINE,
  SYNC_IN_TREE_CURRENT,
  SYNC_IN_TREE_NO_BASIS,
  SYNC_REMOTE_STATE_UNKNOWN_MESSAGE,
} from "../src/commands/sync.js";
import { sessionStart } from "../src/commands/session-start.js";
import { home, BOARD_IN_TREE_LINE, inTreeUncommittedLine, inTreeUnpushedLine } from "../src/commands/home.js";
import { doc } from "../src/commands/doc.js";
import { maybeAutoPull } from "../src/autopull.js";
import { boardPostPersistHook } from "../src/board-attribution.js";
import { mutateDoc } from "../src/mutate.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { readSyncState } from "../src/cursor.js";
import { resolveBundleKey, IN_TREE_CURSOR_TIER } from "@superbee/board-git";
import type { KindRegistry } from "@superbee/core";

import {
  BUNDLE_DIR,
  LEGACY_BUNDLE_DIR,
  git,
  gitTry,
  initPlainBundleDir,
  makeCommittedFolderTopology,
  makeGreenfieldTopology,
  makeTwoCloneTopology,
  type BoardRepo,
} from "../../board-git/test/git-harness.js";

const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

// ── scaffolding (the sync.test.ts house pattern) ──────────────────────────────

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

async function runSyncJson(home: string, argv: string[]): Promise<{ rec: Record<string, unknown>; err?: CliError }> {
  const { out, err } = await runSync(home, [...argv, "--json"]);
  return { rec: out.trim() ? (JSON.parse(out) as Record<string, unknown>) : {}, err };
}

async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "aslite-intree-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** Author one doc through the REAL CLI write path, HOME-scoped (hermetic state writes). */
async function cliDocWrite(home: string, bundleDir: string, id: string, args: string[]): Promise<void> {
  await withHome(home, () =>
    doc(["write", id, ...args, "--dir", bundleDir, "--json"], {
      stdout: () => {},
      readStdin: async () => undefined,
    }),
  );
}

/** Commit + push everything on a clone's CURRENT branch (the in-tree sharing flow). */
function commitAndPush(repo: BoardRepo, subject: string): void {
  git(repo.root, ["add", "-A"]);
  git(repo.root, ["commit", "-m", subject]);
  git(repo.root, ["push", "origin", "main"]);
}

/** B ships one board doc change on the shared branch (teammate activity for A to observe). */
async function teammateShipsDoc(home: string, b: BoardRepo, id: string, actor: string): Promise<void> {
  await cliDocWrite(home, b.board, id, ["--type", "Task", "--title", id, "--body", "# from teammate\n", "--actor", actor]);
  commitAndPush(b, `board: ${actor} — ${id}`);
}

// ── refusal paths ──────────────────────────────────────────────────────────────

test("in-tree: full sync refuses with truthful guidance — structured, discriminated by details.state, nothing mutated", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    const statusBefore = git(topo.a.root, ["status", "--porcelain"]);
    const { err } = await runSync(h, ["--dir", topo.a.root]);
    assert.equal(err?.code, "USAGE");
    assert.equal((err?.details as Record<string, unknown>)?.state, "in-tree", "consumers discriminate on details.state");
    assert.ok(err!.message.includes("this board rides your code branch"), err!.message);
    assert.ok(err!.message.includes("--pull-only"), "the refusal names the read-side verb");
    assert.match(err!.help ?? "", /sync --establish/);
    // Pinned to the exported builder so copy drift is a deliberate act.
    assert.ok(err!.message === syncInTreeRefusalMessage(err!.help!.replace(/ sync --establish$/, "")));
    assert.equal(git(topo.a.root, ["status", "--porcelain"]), statusBefore, "refusal mutates nothing");
    assert.notEqual(gitTry(topo.origin, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status, 0, "no board branch was created");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("in-tree: full sync's refusal carries the remoteless remedy when no 'origin' is configured (C review N1)", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["remote", "remove", "origin"]);
    const { err } = await runSync(h, ["--dir", topo.a.root]);
    assert.equal(err?.code, "USAGE");
    assert.equal((err?.details as Record<string, unknown>)?.state, "in-tree", "details.state is unchanged by the remedy");
    assert.match(err!.message, /no 'origin' remote yet/);
    assert.match(err!.message, /git remote add origin <url>/);
    assert.equal(err!.help, "git remote add origin <url>");
    // Pinned to the exported builder so copy drift is a deliberate act.
    assert.equal(err!.message, syncInTreeRefusalMessage(cliInvocation(), false));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("in-tree: --establish refuses under an INDETERMINATE detection (tracked arm, fail closed); bare sync keeps today's honest remote-unknown state", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "gone.git")]);
    const est = await runSync(h, ["--establish", "--yes", "--dir", topo.a.root]);
    assert.equal(est.err?.code, "TRANSIENT", "establish fails closed when origin cannot be checked");
    assert.match(est.err!.message, /could not reach 'origin'/);

    // Bare sync under the same indeterminate state falls through to the provisioning machine's
    // reviewed remote-unknown guidance — byte-identical to before PR C, exit 0, never a guess.
    const bare = await runSync(h, ["--dir", topo.a.root]);
    assert.equal(bare.err, undefined, bare.err?.message);
    assert.ok(bare.out.includes(SYNC_REMOTE_STATE_UNKNOWN_MESSAGE), bare.out);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("greenfield --establish also refuses under an unreachable origin (untracked indeterminate arm)", async () => {
  const topo = await makeGreenfieldTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    await initPlainBundleDir(topo.a);
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "gone.git")]);
    const { err } = await runSync(h, ["--establish", "--dir", topo.a.root]);
    assert.ok(err, "establish must refuse, not publish blind");
    assert.ok(["TRANSIENT", "AUTH_REQUIRED", "RUNTIME"].includes(err!.code), `classified refusal, got ${err!.code}`);
    assert.notEqual(gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", "refs/heads/board"]).status, 0, "nothing published");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── --pull-only: fetch-and-report ─────────────────────────────────────────────

test("in-tree --pull-only: fetches the tracking upstream, reports incoming docs, never touches the working tree; 'git pull' delivers; then current", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    await teammateShipsDoc(h, topo.b, "tasks/from-sara", "sara");

    const headBefore = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const { rec, err } = await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    assert.equal(err, undefined, err?.message);
    assert.equal(rec.board, SYNC_IN_TREE_BOARD_LINE);
    assert.equal(rec.upstream, "origin/main");
    const incoming = rec.incoming as { shown: number; total: number; rows: Array<Record<string, unknown>> };
    assert.equal(incoming.total, 1);
    assert.deepEqual(incoming.rows[0], {
      verb: "added",
      kind: "Task",
      id: "tasks/from-sara",
      title: "tasks/from-sara",
      actor: "sara",
    });
    assert.equal(rec.note, inTreePullHint(1), "delivery is the user's own git pull");
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), headBefore, "fetch-and-report moved nothing");
    assert.equal(existsSync(path.join(topo.a.board, "tasks", "from-sara.md")), false, "no silent delivery");

    // The mode-scoped cursor was minted.
    const key = await withHome(h, async () => resolveBundleKey(topo.a.board));
    const state = await withHome(h, () => readSyncState(key));
    assert.equal(state.cursor?.tier, IN_TREE_CURSOR_TIER);

    // The user's normal pull delivers; the next check is honestly current.
    git(topo.a.root, ["pull", "origin", "main"]);
    assert.equal(existsSync(path.join(topo.a.board, "tasks", "from-sara.md")), true);
    const again = await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    assert.equal((again.rec.incoming as { total: number }).total, 0);
    assert.equal(again.rec.note, SYNC_IN_TREE_CURRENT);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("legacy in-tree --pull-only scopes reads and messages to .agentstate-lite", async () => {
  const topo = await makeCommittedFolderTopology(LEGACY_BUNDLE_DIR);
  const { home: h, cleanup } = await tempHome();
  try {
    await teammateShipsDoc(h, topo.b, "tasks/legacy", "sara");
    const { rec, err } = await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    assert.equal(err, undefined, err?.message);
    assert.match(String(rec.board), /\.agentstate-lite\//);
    assert.doesNotMatch(String(rec.board), /\.superbee\//);
    const incoming = rec.incoming as { rows: Array<{ id: string }> };
    assert.equal(incoming.rows[0]?.id, "tasks/legacy");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("in-tree --pull-only with no comparison basis (no upstream / detached HEAD) → honest empty state, exit 0", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    git(topo.a.root, ["checkout", "-b", "feature"]);
    const noUpstream = await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    assert.equal(noUpstream.err, undefined, noUpstream.err?.message);
    assert.equal(noUpstream.rec.state, SYNC_IN_TREE_NO_BASIS);
    assert.match(String(noUpstream.rec.note), /no upstream tracking configured/);
    assert.match(String(noUpstream.rec.note), /will not guess an upstream/);

    git(topo.a.root, ["checkout", "--detach"]);
    const detached = await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    assert.equal(detached.err, undefined);
    assert.equal(detached.rec.state, SYNC_IN_TREE_NO_BASIS);
    assert.match(String(detached.rec.note), /detached HEAD/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("in-tree --pull-only fetches ONLY the tracked remote — a dead tracking remote is the classified failure (interactive posture), state untouched", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    // The branch tracks a SECOND remote that is dead, while `origin` stays live (so channel
    // detection still resolves in-tree — a dead `origin` is the fail-closed INDETERMINATE state,
    // pinned separately above). The fetch must target the TRACKED remote, never assume origin.
    git(topo.a.root, ["remote", "add", "upstream", path.join(topo.dir, "gone.git")]);
    git(topo.a.root, ["config", "branch.main.remote", "upstream"]);
    git(topo.a.root, ["config", "branch.main.merge", "refs/heads/main"]);
    const { err } = await runSync(h, ["--pull-only", "--dir", topo.a.root]);
    assert.ok(err, "an interactive verb reports the real outcome");
    assert.ok(["TRANSIENT", "AUTH_REQUIRED", "GIT_BUSY", "RUNTIME"].includes(err!.code), err?.code);
    const key = await withHome(h, async () => resolveBundleKey(topo.a.board));
    const state = await withHome(h, () => readSyncState(key));
    assert.equal(state.cursor, null, "a failed fetch records nothing");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── --show-incoming (upstream-scoped viewer) ──────────────────────────────────

test("in-tree --show-incoming: reads the upstream version under the board prefix, as of last fetch; refuses honestly with no basis", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    await teammateShipsDoc(h, topo.b, "tasks/incoming-view", "sara");
    // Fetch once (the viewer itself never fetches — adjudication G).
    await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);

    const { rec, err } = await runSyncJson(h, ["--show-incoming", "tasks/incoming-view", "--dir", topo.a.root]);
    assert.equal(err, undefined, err?.message);
    assert.equal(rec.id, "tasks/incoming-view");
    assert.equal(rec.as_of, "last fetch");
    assert.match(String(rec.body), /from teammate/);

    // Absent upstream renders the in-tree expected state, not an error.
    const absent = await runSyncJson(h, ["--show-incoming", "tasks/never-existed", "--dir", topo.a.root]);
    assert.equal(absent.err, undefined);
    assert.match(String(absent.rec.state), new RegExp(`absent upstream — not under ${BUNDLE_DIR}/`));

    // No comparison basis → an honest NO_UPSTREAM refusal that names the in-tree state.
    git(topo.a.root, ["checkout", "-b", "feature"]);
    const noBasis = await runSyncJson(h, ["--show-incoming", "tasks/incoming-view", "--dir", topo.a.root]);
    assert.equal(noBasis.err?.code, "NO_UPSTREAM");
    assert.equal((noBasis.err?.details as Record<string, unknown>)?.state, "in-tree");
    assert.match(noBasis.err!.message, /rides the current branch/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── mode-flip cursor isolation (direction: in-tree cursor read by BRANCH mode) ─

test("mode flip (in-tree → branch): a 'git-intree' cursor is FOREIGN to branch sync — startHead baseline, cursor re-minted 'git'", async () => {
  const topo = await makeTwoCloneTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    // A syncs once; B ships a change; A syncs again (cache delta = B's change, cursor at head).
    await runSyncJson(h, ["--dir", topo.a.root]);
    await cliDocWrite(h, topo.b.board, "tasks/from-b", ["--type", "Task", "--title", "B doc", "--body", "x", "--actor", "sara"]);
    await runSyncJson(h, ["--dir", topo.b.root]);
    await runSyncJson(h, ["--dir", topo.a.root]);

    const key = await withHome(h, async () => resolveBundleKey(topo.a.board));
    // POISON: an in-tree-tier cursor whose token is an OLD board commit — its token..HEAD diff
    // would re-report B's change (and more) as fresh activity if the tier guard were missing.
    const oldSha = git(topo.a.board, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    const { writeCursor } = await import("../src/cursor.js");
    await withHome(h, () => writeCursor(key, { tier: IN_TREE_CURSOR_TIER, token: oldSha }));

    const { rec, err } = await runSyncJson(h, ["--dir", topo.a.root]);
    assert.equal(err, undefined, err?.message);
    assert.equal(rec.sync, "already up to date", "a current board stays current — the foreign token is ignored");
    const state = await withHome(h, () => readSyncState(key));
    assert.equal(state.cursor?.tier, "git", "the cursor is re-minted branch-scoped");
    assert.equal(state.cache?.delta.length, 0, "no cross-mode rows leaked into the cache");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── session-start + home (the awareness surface) ──────────────────────────────

test("session-start on an in-tree board: fetch-and-record inside the budget, render always appears, working tree untouched; home renders the block", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    await teammateShipsDoc(h, topo.b, "tasks/board-news", "sara");

    const headBefore = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const cap = captureStdout();
    await withHome(h, () => sessionStart(["--dir", topo.a.root], { stdout: cap.stdout }));
    const out = cap.text();
    assert.match(out, /since_this_machine_last_checked: 1 board change from sara/, "the in-tree since-header renders");
    assert.match(out, /sara · added Task/, "the per-doc human line renders");
    assert.match(out, /board-news/);
    assert.match(out, /incoming board change is not yet in this checkout — run 'git pull'/);
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), headBefore, "session-start never merges in-tree");

    // Delivery via the user's own pull; the next render is the quiet mode line.
    git(topo.a.root, ["pull", "origin", "main"]);
    const cap2 = captureStdout();
    await withHome(h, () => sessionStart(["--dir", topo.a.root], { stdout: cap2.stdout }));
    assert.match(cap2.text(), new RegExp("board: rides this branch"), "quiet steady state = the mode line");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("home (plain, offline): in-tree first contact renders the mode line; backstops are prefix-scoped; self-authored rows are filtered", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    // First contact — no cache, clean tree: the mode line, and never an init hint.
    const cap = captureStdout();
    await withHome(h, () => home(["--dir", topo.a.board, "--json"], { stdout: cap.stdout }));
    const view = JSON.parse(cap.text()) as Record<string, unknown>;
    assert.equal(view.board, BOARD_IN_TREE_LINE);
    assert.equal("getting_started" in view, false, "a detected board suppresses the init hint");

    // Mint the cursor NOW (at the seed upstream), so the later fetch reports A's own pushed doc
    // as a delta row — the raw material the self-filter must then hide.
    await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);

    // Prefix scoping: dirty code + one board doc uncommitted; a code commit + a board commit unpushed.
    await writeFile(path.join(topo.a.root, "src", "app.js"), "export const x = 3;\n");
    git(topo.a.root, ["add", "src/app.js"]);
    git(topo.a.root, ["commit", "-m", "code only"]);
    await cliDocWrite(h, topo.a.board, "tasks/mine", ["--type", "Task", "--title", "Mine", "--body", "m", "--actor", "mike"]);
    git(topo.a.root, ["add", BUNDLE_DIR]);
    git(topo.a.root, ["commit", "-m", "board only"]);
    await writeFile(path.join(topo.a.root, "src", "scratch.js"), "// dirty\n");
    await writeFile(path.join(topo.a.board, "tasks", "wip.md"), "---\ntype: Task\ntitle: W\n---\nwip\n");

    const cap2 = captureStdout();
    await withHome(h, () => home(["--dir", topo.a.board, "--json"], { stdout: cap2.stdout }));
    const view2 = JSON.parse(cap2.text()) as Record<string, unknown>;
    const board = view2.board as Record<string, unknown>;
    assert.equal(board.unpushed, inTreeUnpushedLine(1), "one BOARD commit unpushed — the code commit is invisible");
    assert.equal(board.uncommitted, inTreeUncommittedLine(1), "one BOARD change dirty — the code dirt is invisible");

    // Self-filtering via the post-persist hook: A pushes its own doc; the next fetch's delta
    // (cursor at the SEED upstream) genuinely CONTAINS A's row — and the render hides it.
    git(topo.a.root, ["checkout", "--", "."]);
    await rm(path.join(topo.a.board, "tasks", "wip.md"), { force: true });
    git(topo.a.root, ["push", "origin", "main"]);
    await runSyncJson(h, ["--pull-only", "--dir", topo.a.root]);
    const key = await withHome(h, async () => resolveBundleKey(topo.a.board));
    const state = await withHome(h, () => readSyncState(key));
    assert.equal(state.cache?.delta.length, 1, "the raw delta DID contain a row (nothing vacuous)");
    assert.equal(state.cache?.delta[0]?.actor, "mike");
    assert.ok(state.selfActors?.includes("mike"), "the post-persist hook recorded the writing actor");

    const cap3 = captureStdout();
    await withHome(h, () => home(["--dir", topo.a.board, "--json"], { stdout: cap3.stdout }));
    const view3 = JSON.parse(cap3.text()) as Record<string, unknown>;
    assert.equal(view3.board, BOARD_IN_TREE_LINE, "A's own row is filtered — the quiet mode line renders");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("session-start time-box: a black-holed remote is abandoned inside the budget and the render still appears (offline note)", async () => {
  const topo = await makeCommittedFolderTopology();
  const { home: h, cleanup } = await tempHome();
  const helperDir = await mkdtemp(path.join(tmpdir(), "aslite-intree-hang-"));
  const prevPath = process.env.PATH;
  try {
    const helper = path.join(helperDir, "git-remote-hang");
    await writeFile(helper, "#!/bin/sh\nsleep 60\n");
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDir}${path.delimiter}${prevPath ?? ""}`;
    git(topo.a.root, ["remote", "set-url", "origin", "hang://black.hole/repo"]);

    const t0 = Date.now();
    const cap = captureStdout();
    await withHome(h, () => sessionStart(["--dir", topo.a.root], { stdout: cap.stdout, budgetMs: 1_500 }));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 6_000, `bounded by the budget (took ${elapsed}ms)`);
    assert.ok(cap.text().length > 0, "the render ALWAYS appears");
    assert.match(cap.text(), /board sync offline — showing last known state|rides this branch/);
  } finally {
    process.env.PATH = prevPath;
    await rm(helperDir, { recursive: true, force: true });
    await cleanup();
    await topo.cleanup();
  }
});

// ── autopull stays structurally excluded (the zero-spawn pre-gate invariant) ──

test("autopull: an in-tree bundle is a plain directory — the fs-only pre-gate reports no-board and never spawns a pull", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    assert.equal(await maybeAutoPull(topo.a.board, { env: {} }), "no-board");
    assert.equal(await maybeAutoPull(topo.a.root, { env: {} }), "no-board");
  } finally {
    await topo.cleanup();
  }
});

// ── the post-persist self-attribution hook (plan v3 invariants) ───────────────

test("hook: a substantive doc write records the actor (in-tree AND branch mode); a no-op patch and a refused write never do", async () => {
  const intree = await makeCommittedFolderTopology();
  const branch = await makeTwoCloneTopology();
  const { home: h, cleanup } = await tempHome();
  try {
    // Substantive write, in-tree bundle → recorded under THE bundle key.
    await cliDocWrite(h, intree.a.board, "tasks/attributed", ["--type", "Task", "--title", "T", "--body", "b", "--actor", "mike/claude"]);
    const intreeKey = await withHome(h, async () => resolveBundleKey(intree.a.board));
    assert.deepEqual((await withHome(h, () => readSyncState(intreeKey))).selfActors, ["mike/claude"]);

    // Substantive write, branch-mode board worktree → recorded too (closes the branch gap).
    await cliDocWrite(h, branch.a.board, "tasks/attributed", ["--type", "Task", "--title", "T", "--body", "b", "--actor", "mike/claude"]);
    const branchKey = await withHome(h, async () => resolveBundleKey(branch.a.board));
    assert.deepEqual((await withHome(h, () => readSyncState(branchKey))).selfActors, ["mike/claude"]);

    // A no-op patch (changed: false) with a DIFFERENT actor must not record it.
    await withHome(h, () =>
      doc(["update", "tasks/attributed", "--title", "T", "--keep-timestamp", "--actor", "bob", "--dir", intree.a.board, "--json"], {
        stdout: () => {},
        readStdin: async () => undefined,
      }),
    );
    assert.deepEqual(
      (await withHome(h, () => readSyncState(intreeKey))).selfActors,
      ["mike/claude"],
      "a changed:false no-op records nothing",
    );

    // A REFUSED write (the body-blanking guard) with another actor must not record it.
    await assert.rejects(
      cliDocWrite(h, intree.a.board, "tasks/attributed", ["--type", "Task", "--title", "T2", "--actor", "carol"]),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
    assert.deepEqual(
      (await withHome(h, () => readSyncState(intreeKey))).selfActors,
      ["mike/claude"],
      "a refused write records nothing",
    );
  } finally {
    await cleanup();
    await intree.cleanup();
    await branch.cleanup();
  }
});

test("hook: a THROWING post-persist hook can never fail a successful write; a no-op never invokes it; generic bundles get no hook", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-hook-inv-"));
  try {
    const bundleRoot = path.join(dir, "plain-bundle");
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(path.join(bundleRoot, "index.md"), '---\nokf_version: "0.1"\n---\n');
    const bundle = { root: bundleRoot };
    let fired = 0;

    // A throwing hook: the write still succeeds.
    const result = await mutateDoc({
      bundle,
      id: "notes/a",
      mode: "create-only",
      registry: EMPTY_REGISTRY,
      strict: false,
      helpOnKindReject: "x",
      buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "hello" }),
      onPersisted: () => {
        fired += 1;
        throw new Error("hook exploded");
      },
      errors: {},
    });
    assert.equal(result.doc.id, "notes/a");
    assert.equal(fired, 1, "the hook fired exactly once, after the persist");

    // A no-op patch never invokes the hook.
    fired = 0;
    const noop = await mutateDoc({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      helpOnKindReject: "x",
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }),
      onPersisted: () => {
        fired += 1;
      },
      errors: {},
    });
    assert.equal(noop.changed, false);
    assert.equal(fired, 0, "no-op writes never fire the post-persist hook");

    // Generic (non-conventional, remote) bundles get no hook at all — zero git discovery.
    assert.equal(boardPostPersistHook({ root: bundleRoot }, "mike"), undefined, "non-conventional name → no hook");
    assert.equal(boardPostPersistHook({ root: bundleRoot }, undefined), undefined);
    assert.equal(boardPostPersistHook({ root: bundleRoot }, "unknown"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
