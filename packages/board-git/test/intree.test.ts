// PR C acceptance suite for `src/intree.ts` — the in-tree board's read-side mechanics, each
// scenario a deterministic scratch-repo state (no real network: remotes are local paths; "dead"
// is a path that doesn't exist).
//
// What this suite pins:
//   • the UPSTREAM DECISION TABLE — tracking config → that ref; detached HEAD / no tracking /
//     unusable ref → an explicit no-comparison-basis outcome, never a guessed `origin/<branch>`;
//   • PREFIX-SCOPED awareness over the one `diffDocsBetween`: ids prefix-stripped BEFORE
//     doc-id/reserved interpretation (`.superbee/index.md` stays reserved after the
//     strip), non-ASCII ids round-trip, code-tree `.md` files never appear;
//   • the MODE-SCOPED cursor tier (`git-intree`): a branch-mode (`"git"`) cursor reads as
//     FOREIGN (first-contact merge-base baseline, silently replaced), and an unusable
//     `git-intree` token (non-ancestor — history rewritten/repositioned) takes the honest
//     re-anchor (empty delta + REANCHOR_NOTE), never a cross-tree diff;
//   • state discipline mirrors the branch pull: a failed fetch and every no-basis outcome write
//     NOTHING (the cursor advances only on a successful check); the working tree is never
//     touched on any path;
//   • prefix-scoped backstops: unpushed/uncommitted/behind count board-touching work only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BUNDLE_DIR,
  git,
  gitTry,
  makeCommittedFolderTopology,
  type BoardRepo,
  type TwoCloneTopology,
} from "./git-harness.js";

import {
  IN_TREE_CURSOR_TIER,
  REANCHOR_NOTE,
  countUncommitted,
  createSyncStore,
  inTreeBehindCount,
  inTreeFetchAndRecord,
  inTreeUnpushedCount,
  isBoardGitError,
  resolveInTreeUpstream,
  type SyncStore,
} from "../src/index.js";

// Hermetic ambient env (the porcelain inherits process.env; neutralize host git config).
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

/** A plain temp-dir store (the CLI's credentials discipline is not under test here). */
function tempStore(topo: TwoCloneTopology): SyncStore {
  const dir = path.join(topo.dir, "state");
  return createSyncStore({
    stateDir: dir,
    writeAtomic: async (d: string, name: string, content: string) => {
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, name), content);
    },
  });
}

/** Author + commit + push one board doc change on a clone's CURRENT branch (the in-tree flow). */
async function pushBoardDocChange(
  repo: BoardRepo,
  relPath: string,
  content: string,
  subject: string,
): Promise<void> {
  const abs = path.join(repo.root, BUNDLE_DIR, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  git(repo.root, ["add", "-A"]);
  git(repo.root, ["commit", "-m", subject]);
  git(repo.root, ["push", "origin", "main"]);
}

const KEY = "intree-test-key";

// ── the upstream decision table ────────────────────────────────────────────────

test("decision table: tracking config set → that ref (never a guess)", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    const r = resolveInTreeUpstream(topo.a.root);
    assert.equal(r.state, "ok");
    assert.deepEqual(r.state === "ok" && r.config, { branch: "main", ref: "origin/main", remote: "origin" });
  } finally {
    await topo.cleanup();
  }
});

test("decision table: detached HEAD → no comparison basis; nothing fetched, nothing recorded", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    git(topo.a.root, ["checkout", "--detach"]);
    assert.deepEqual(resolveInTreeUpstream(topo.a.root), { state: "none", reason: "detached-head" });
    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.deepEqual(out, { state: "no-upstream", reason: "detached-head" });
    assert.equal(await store.readCursor(KEY), null, "no cursor minted without a basis");
    assert.equal(await store.readCache(KEY), null, "no cache written without a basis");
  } finally {
    await topo.cleanup();
  }
});

test("decision table: a branch with NO tracking config → no comparison basis (origin/<branch> is never assumed)", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    git(topo.a.root, ["checkout", "-b", "feature"]);
    assert.deepEqual(resolveInTreeUpstream(topo.a.root), { state: "none", reason: "no-upstream" });
    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.deepEqual(out, { state: "no-upstream", reason: "no-upstream" });
    assert.equal(await store.readCursor(KEY), null);
  } finally {
    await topo.cleanup();
  }
});

test("decision table: tracking ref deleted on the remote → unusable after the pruning fetch; nothing recorded", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    git(topo.a.root, ["checkout", "-b", "feature"]);
    git(topo.a.root, ["push", "-u", "origin", "feature"]);
    git(topo.origin, ["update-ref", "-d", "refs/heads/feature"]);
    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state, "unusable-upstream");
    assert.equal(out.state === "unusable-upstream" && out.ref, "origin/feature");
    assert.equal(await store.readCursor(KEY), null);
    assert.equal(await store.readCache(KEY), null);
  } finally {
    await topo.cleanup();
  }
});

test("fetch failure (dead remote) → classified, and NOTHING is recorded (state untouched)", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "does-not-exist.git")]);
    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state, "fetch-failed");
    assert.ok(out.state === "fetch-failed" && isBoardGitError(out.failure), "the failure is the typed taxonomy");
    assert.equal(await store.readCursor(KEY), null, "cursor advances only on a successful check");
    assert.equal(await store.readCache(KEY), null);
  } finally {
    await topo.cleanup();
  }
});

// ── prefix-scoped awareness ────────────────────────────────────────────────────

test("awareness: prefix-stripped ids; reserved index.md stays reserved after the strip; code .md never a row; non-ASCII round-trips; the working tree is untouched", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    // Teammate (clone B) ships, on the SHARED branch: a board doc update, a reserved-file edit,
    // a non-ASCII board doc, and a code-tree markdown change.
    await pushBoardDocChange(
      topo.b,
      "tasks/seed-one.md",
      "---\ntype: Task\ntitle: Seed one\nactor: sara\n---\n# updated by sara\n",
      "board + code changes",
    );
    const abs = (rel: string) => path.join(topo.b.root, rel);
    await writeFile(abs(`${BUNDLE_DIR}/index.md`), '---\nokf_version: "0.1"\n---\nregenerated\n');
    await mkdir(path.dirname(abs(`${BUNDLE_DIR}/tasks/café.md`)), { recursive: true });
    await writeFile(abs(`${BUNDLE_DIR}/tasks/café.md`), "---\ntype: Task\ntitle: Café\nactor: sara\n---\nnon-ascii\n");
    await writeFile(abs("README.md"), "# demo project — changed\n");
    git(topo.b.root, ["add", "-A"]);
    git(topo.b.root, ["commit", "-m", "more changes"]);
    git(topo.b.root, ["push", "origin", "main"]);

    const headBefore = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state, "refreshed");
    if (out.state !== "refreshed") throw new Error("unreachable");
    const ids = out.changes.map((c) => c.docId).sort();
    assert.deepEqual(ids, ["tasks/café", "tasks/seed-one"], "prefix-stripped doc ids only");
    assert.ok(!ids.some((id) => id.includes(BUNDLE_DIR)), "the prefix never leaks into ids");
    const seedRow = out.changes.find((c) => c.docId === "tasks/seed-one")!;
    assert.equal(seedRow.actor, "sara", "attribution from frontmatter at the upstream ref");
    assert.equal(seedRow.verb, "updated");
    assert.ok(out.behind >= 2, "behind counts the unpulled board-touching commits");

    // The cursor is mode-scoped and the cache carries the same rows.
    const cursor = await store.readCursor(KEY);
    assert.equal(cursor?.tier, IN_TREE_CURSOR_TIER);
    assert.equal(cursor?.token, git(topo.a.root, ["rev-parse", "origin/main"]).trim());
    const cache = await store.readCache(KEY);
    assert.equal(cache?.delta.length, 2);

    // READ-SIDE ONLY: the fetch never touched the working tree or HEAD.
    assert.equal(git(topo.a.root, ["rev-parse", "HEAD"]).trim(), headBefore, "HEAD unmoved");
    assert.equal(git(topo.a.root, ["status", "--porcelain"]).trim(), "", "working tree untouched");

    // Steady state: a second check reports nothing new.
    const again = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(again.state === "refreshed" && again.changes.length, 0);
  } finally {
    await topo.cleanup();
  }
});

// ── mode-scoped cursor (the mode-flip poisoning scenario) ─────────────────────

test("mode flip (branch → in-tree): a 'git'-tier cursor is FOREIGN — merge-base first contact, never a cross-tree diff from its token", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    // Upstream gains a board change, and A PULLS it (checkout current with upstream): the honest
    // delta is now EMPTY.
    await pushBoardDocChange(
      topo.b,
      "tasks/seed-one.md",
      "---\ntype: Task\ntitle: Seed one\nactor: sara\n---\nupdated\n",
      "board change",
    );
    git(topo.a.root, ["pull", "origin", "main"]);

    // The poisoning setup: a BRANCH-mode cursor whose token EXISTS in this repo's object
    // database (existence-only guards would accept it) and whose token..upstream diff WOULD
    // report the board change above as fresh activity.
    const rootCommit = git(topo.a.root, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    await store.writeCursor(KEY, { tier: "git", token: rootCommit });

    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state, "refreshed");
    if (out.state !== "refreshed") throw new Error("unreachable");
    // The foreign token was ignored: first-contact merge-base baseline → nothing to report.
    assert.deepEqual(out.changes, []);
    assert.equal(out.reanchored, false, "a foreign tier is first contact, not a re-anchor");
    const cursor = await store.readCursor(KEY);
    assert.equal(cursor?.tier, IN_TREE_CURSOR_TIER, "the cursor is re-minted mode-scoped");
  } finally {
    await topo.cleanup();
  }
});

test("a git-intree token that no longer sits behind upstream (history repositioned) → the honest re-anchor, never a silent skip", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    // A local commit AHEAD of upstream: exists, but is not an ancestor of origin/main.
    await writeFile(path.join(topo.a.root, BUNDLE_DIR, "tasks", "local.md"), "---\ntype: Task\ntitle: L\n---\nlocal\n");
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-m", "local board work"]);
    const nonAncestor = git(topo.a.root, ["rev-parse", "HEAD"]).trim();
    await store.writeCursor(KEY, { tier: IN_TREE_CURSOR_TIER, token: nonAncestor });

    const out = await inTreeFetchAndRecord(store, topo.a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state, "refreshed");
    if (out.state !== "refreshed") throw new Error("unreachable");
    assert.equal(out.reanchored, true);
    assert.deepEqual(out.changes, [], "the delta across a reposition is unknowable — empty, with the note");
    const cache = await store.readCache(KEY);
    assert.equal(cache?.note, REANCHOR_NOTE);
    const cursor = await store.readCursor(KEY);
    assert.equal(cursor?.token, git(topo.a.root, ["rev-parse", "origin/main"]).trim());
  } finally {
    await topo.cleanup();
  }
});

// ── prefix-scoped backstops ────────────────────────────────────────────────────

test("backstops: unpushed/uncommitted/behind count board-touching work ONLY (a busy code tree stays invisible)", async () => {
  const topo = await makeCommittedFolderTopology();
  const store = tempStore(topo);
  try {
    const a = topo.a;
    // One unpushed CODE commit + one unpushed BOARD commit; one uncommitted code file + one
    // uncommitted board doc.
    await writeFile(path.join(a.root, "src", "app.js"), "export const x = 2;\n");
    git(a.root, ["add", "-A"]);
    git(a.root, ["commit", "-m", "code only"]);
    await writeFile(path.join(a.root, BUNDLE_DIR, "tasks", "mine.md"), "---\ntype: Task\ntitle: M\nactor: mike\n---\nmine\n");
    git(a.root, ["add", "-A"]);
    git(a.root, ["commit", "-m", "board only"]);
    await writeFile(path.join(a.root, "src", "scratch.js"), "// dirty code\n");
    await writeFile(path.join(a.root, BUNDLE_DIR, "tasks", "wip.md"), "---\ntype: Task\ntitle: W\n---\nwip\n");

    const upstream = git(a.root, ["rev-parse", "origin/main"]).trim();
    assert.equal(inTreeUnpushedCount(a.root, upstream, BUNDLE_DIR), 1, "only the board-touching commit counts");
    assert.equal(countUncommitted(a.root, BUNDLE_DIR), 1, "only the board-touching dirt counts");
    assert.equal(inTreeBehindCount(a.root, upstream, BUNDLE_DIR), 0);

    const out = await inTreeFetchAndRecord(store, a.root, KEY, BUNDLE_DIR);
    assert.equal(out.state === "refreshed" && out.unpushedCount, 1);
    assert.equal(out.state === "refreshed" && out.uncommittedCount, 1);
    const cache = await store.readCache(KEY);
    assert.equal(cache?.unpushedCount, 1);
    assert.equal(cache?.uncommittedCount, 1);
  } finally {
    await topo.cleanup();
  }
});

// ── read-only guarantee under gitTry misuse ───────────────────────────────────

test("no-basis probes are read-only: resolveInTreeUpstream mutates nothing", async () => {
  const topo = await makeCommittedFolderTopology();
  try {
    const before = git(topo.a.root, ["for-each-ref"]);
    resolveInTreeUpstream(topo.a.root);
    assert.equal(git(topo.a.root, ["for-each-ref"]), before);
    assert.equal(gitTry(topo.a.root, ["status", "--porcelain"]).stdout.trim(), "");
  } finally {
    await topo.cleanup();
  }
});
