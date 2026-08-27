// Tests for `sync` (U3a core flow + U3b conflict strings, plans/sync-verb-implementation
// §U3a/§U3b) — entry self-heal, provision, commit, pull, push, envelope, the CONVERGING conflict
// mechanic's pinned strings/composite framing, and the awareness cache/cursor write U4 consumes.
// The U3b-specific scenarios (binding convergence chain, multi-commit loop, reserved-file
// conflict, --show-incoming) live in `sync-conflict.test.ts`.
//
// Two layers, mirroring the codebase's own convention (status.ts/home.ts export pure helpers for
// direct unit testing; git-backed behavior is exercised over the U0 harness):
//
//   1. Pure-function unit tests (no git, no filesystem) for the message-pack string builders and
//      the swallow/classification mappers — fast, and pin the exact strings directly.
//   2. Integration tests over `git-harness.ts`'s real scratch topologies, driving `sync()` itself.
//      Cursor/cache/marker state lives under Superbee's private `~/.superbee-state/sync/` (U2), keyed PER CLONE (remote
//      URL + checkout root — PR#13 review item 4), so two clones under ONE home keep separate
//      state files (the dedicated cross-clone isolation tests below drive exactly that, the
//      agent-worktree same-machine shape). Scenarios simulating two DIFFERENT founders on two
//      machines still scope EACH clone's HOME separately (mirrors `auth-cli.test.ts`'s
//      `withHome`) — per-machine credential/state separation is a real thing to model even
//      though the keying alone would now keep the files apart.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import {
  buildConvergeMessage,
  cap,
  convergeDocLine,
  convergeHelp,
  entryLabel,
  ffSwallowToError,
  pickHelp,
  pushFailureMessage,
  sync,
  toIncomingRows,
  PUSH_FAIL_SAFETY_MESSAGE,
  SYNC_LOCAL_ONLY_MESSAGE,
  SYNC_REMOTE_STATE_UNKNOWN_MESSAGE,
  syncLocalOnlyNote,
  syncRemoteStateUnknownNote,
} from "../src/commands/sync.js";
import {
  originDocsBetween,
  provisionAnnouncement,
  singleActor,
  toDeltaRows,
  type DocChange,
} from "@superbee/board-git";
import { cliInvocation } from "../src/invocation.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import { REANCHOR_NOTE, readSyncState, bundleKey, syncExportsDir, syncStateDir, writeCursor } from "../src/cursor.js";
import {
  BUNDLE_DIR,
  boardHead,
  commitBoard,
  danglingCursorSha,
  divergeSameDoc,
  gitTry,
  isMidRebase,
  makeTwoCloneTopology,
  modifyBoardDoc,
  originBoardHead,
  pushBoard,
  readBoardFile,
  wedgeMidRebase,
  writeBoardDoc,
  git,
  type BoardRepo,
} from "../../board-git/test/git-harness.js";

// ── test scaffolding ───────────────────────────────────────────────────────────

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  return withIsolatedUserEnv(home, run);
}

async function inDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(original);
  }
}

/** Capture everything `sync()` writes to its injected stdout, joined as one string. */
function captureStdout(): { stdout: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { stdout: (s: string) => chunks.push(s), text: () => chunks.join("") };
}

/**
 * Run `sync(argv)` under an isolated per-call HOME (a distinct "machine"). Returns captured stdout.
 * `hookInstalled` is pinned true so the one-time onboarding hint (its OWN suite: autopull.test.ts)
 * never perturbs this file's exact-receipt assertions — a temp HOME has no hook by construction.
 */
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

async function tempHomes(n: number): Promise<{ homes: string[]; cleanup: () => Promise<void> }> {
  const homes = await Promise.all(
    Array.from({ length: n }, () => mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-home-"))),
  );
  return { homes, cleanup: async () => Promise.all(homes.map((h) => rm(h, { recursive: true, force: true }))).then(() => undefined) };
}

function docChange(partial: Partial<DocChange> & Pick<DocChange, "docId" | "verb">): DocChange {
  return { kind: "Note", title: partial.docId, actor: "unknown", ...partial };
}

/**
 * Author a board doc through the REAL CLI write path (`doc write … --actor <name> --dir <board>`)
 * — NOT the harness's `writeBoardDoc` engine hand-seeding. This is what pins actor attribution
 * end-to-end: the CLI itself must persist the edition-appropriate advisory attribution into
 * frontmatter, because portable document bytes are the per-doc source sync enriches.
 */
async function cliDocWrite(boardDir: string, id: string, args: string[]): Promise<void> {
  await doc(["write", id, ...args, "--dir", boardDir, "--json"], {
    stdout: () => {},
    readStdin: async () => undefined,
  });
}

test("bare binding-selected sync commits only the proven private board owner", async () => {
  const topology = await makeTwoCloneTopology();
  const homes = await tempHomes(1);
  try {
    await writeFile(
      path.join(topology.a.root, ".superbee.json"),
      JSON.stringify({ bundle: topology.b.board }),
    );
    await writeBoardDoc(topology.b, "tasks/bound-owner", {
      frontmatter: { type: "Task", title: "Bound owner", actor: "private-owner" },
      body: "# Bound owner\n",
    });
    const publicHead = boardHead(topology.a);

    const result = await inDir(topology.a.root, () => runSync(homes.homes[0]!, []));
    assert.equal(result.err, undefined, result.err?.message);
    assert.notEqual(boardHead(topology.b), publicHead, "the private board received the sync commit");
    assert.equal(boardHead(topology.a), publicHead, "the public checkout's stale board was never selected");
    assert.match(result.out, /committed: 1/);
  } finally {
    await topology.cleanup();
    await homes.cleanup();
  }
});

test("plain bare binding remains a selected local bundle and never probes either board", async () => {
  const topology = await makeTwoCloneTopology();
  const homes = await tempHomes(1);
  try {
    const invalid = path.join(topology.b.root, "not-a-board");
    await mkdir(invalid);
    await writeFile(path.join(invalid, "index.md"), "---\nokf_version: 0.2\n---\n");
    await writeFile(path.join(topology.a.root, ".superbee.json"), JSON.stringify({ bundle: invalid }));
    const publicHead = boardHead(topology.a);

    const result = await inDir(topology.a.root, () => runSync(homes.homes[0]!, []));
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /nothing to sync/);
    assert.equal(boardHead(topology.a), publicHead, "plain binding never falls back to public sync");
  } finally {
    await topology.cleanup();
    await homes.cleanup();
  }
});

test("bare binding-selected show-incoming reads the private board ref", async () => {
  const topology = await makeTwoCloneTopology();
  const homes = await tempHomes(1);
  try {
    await writeFile(path.join(topology.a.root, ".superbee.json"), JSON.stringify({ bundle: topology.b.board }));
    await writeBoardDoc(topology.b, "tasks/private-incoming", {
      frontmatter: { type: "Task", title: "Private incoming", actor: "private-owner" },
      body: "# Private incoming\n",
    });
    commitBoard(topology.b, "board: private incoming");
    pushBoard(topology.b);
    git(topology.b.board, ["fetch", "origin"]);
    const publicHead = boardHead(topology.a);

    const result = await inDir(topology.a.root, () => runSync(homes.homes[0]!, ["--show-incoming", "tasks/private-incoming"]));
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /id: tasks\/private-incoming/);
    assert.equal(boardHead(topology.a), publicHead, "show-incoming never retargeted to the public board");
  } finally {
    await topology.cleanup();
    await homes.cleanup();
  }
});

// ── pure-function unit tests ───────────────────────────────────────────────────

test("cap: shows all rows under the limit; caps + reports total over it; 0 means unlimited", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(cap(rows, 20), { shown: 3, total: 3, rows });
  assert.deepEqual(cap(rows, 2), { shown: 2, total: 3, rows: rows.slice(0, 2) });
  assert.deepEqual(cap(rows, 0), { shown: 3, total: 3, rows });
  assert.deepEqual(cap([], 20), { shown: 0, total: 0, rows: [] });
});

test("convergeDocLine: concept doc, EXACT test-pinned per-doc string (adjudication D)", () => {
  assert.equal(
    convergeDocLine({ entry: "tasks/seed-one", isDoc: true, exportPath: "/x/tasks/seed-one.md", bodyExportPath: "/x/tasks/seed-one.body.md", landed: true }),
    "doc tasks/seed-one — teammate's version kept; yours saved at /x/tasks/seed-one.md — reconcile with doc update",
  );
});

test("entryLabel: driven by the EXPLICIT isDoc discriminator — a dotted doc id labels as a doc (round-2 REQUIRED 2)", () => {
  assert.equal(entryLabel({ entry: "log.md", isDoc: false }), "log.md");
  assert.equal(entryLabel({ entry: "tasks/seed-one", isDoc: true }), "doc tasks/seed-one");
  // The retired string-shape heuristic misread this as a raw path; the discriminator cannot.
  assert.equal(entryLabel({ entry: "notes/v1.2", isDoc: true }), "doc notes/v1.2");
});

test("convergeDocLine: a reserved-file entry (log.md) renders VERBATIM — never 'doc log.md' — and drops the reconcile suffix", () => {
  const line = convergeDocLine({ entry: "log.md", isDoc: false, exportPath: "/x/log.md", bodyExportPath: null, landed: true });
  assert.equal(line, "log.md — teammate's version kept; yours saved at /x/log.md");
  assert.ok(!line.includes("doc log.md"), `expected no "doc log.md" in: ${line}`);
  assert.ok(!line.includes("reconcile with doc update"), "no doc-update reconcile hint for a reserved file");
});

test("convergeDocLine: a local-side deletion (no export) says so honestly instead of naming a missing file", () => {
  assert.equal(
    convergeDocLine({ entry: "tasks/seed-one", isDoc: true, exportPath: null, bodyExportPath: null, landed: true }),
    "doc tasks/seed-one — teammate's version kept (your side deleted it; nothing to save)",
  );
});

test("convergeDocLine: a doc DELETED UPSTREAM says 'deletion kept' and points at doc write, never doc update (review fix 2)", () => {
  const line = convergeDocLine({ entry: "tasks/seed-one", isDoc: true, exportPath: "/x/tasks/seed-one.md", bodyExportPath: "/x/tasks/seed-one.body.md", landed: false });
  assert.equal(
    line,
    "doc tasks/seed-one — teammate's deletion kept; yours saved at /x/tasks/seed-one.md — re-create with doc write",
  );
  assert.ok(!line.includes("doc update"), "doc update on a deleted doc fails NOT_FOUND — never suggested here");
});

test("convergeDocLine: NO body export (unparseable/non-roundtrippable local blob) — the fixing-verb suffix is DROPPED (round-3 LOW 1)", () => {
  // Only the FULL export exists; telling the user to `doc update --body-file` with it would nest
  // YAML frontmatter into the body — so no verb is suggested at all (mirrors the deletion case).
  const landedLine = convergeDocLine({ entry: "tasks/weird", isDoc: true, exportPath: "/x/tasks/weird.md", bodyExportPath: null, landed: true });
  assert.equal(landedLine, "doc tasks/weird — teammate's version kept; yours saved at /x/tasks/weird.md");
  assert.ok(!landedLine.includes("doc update"), "no doc-update suffix without a body export");
  const deletedLine = convergeDocLine({ entry: "tasks/weird", isDoc: true, exportPath: "/x/tasks/weird.md", bodyExportPath: null, landed: false });
  assert.equal(deletedLine, "doc tasks/weird — teammate's deletion kept; yours saved at /x/tasks/weird.md");
  assert.ok(!deletedLine.includes("doc write"), "no doc-write suffix without a body export");
});

test("buildConvergeMessage: multiple entries join with '; ', and the DROPPED phrase stays dropped (amended pack c)", () => {
  const msg = buildConvergeMessage([
    { entry: "tasks/seed-one", isDoc: true, exportPath: "/x/tasks/seed-one.md", bodyExportPath: "/x/tasks/seed-one.body.md", landed: true },
    { entry: "log.md", isDoc: false, exportPath: "/x/log.md", bodyExportPath: null, landed: true },
  ]);
  assert.equal(
    msg,
    "doc tasks/seed-one — teammate's version kept; yours saved at /x/tasks/seed-one.md — reconcile with doc update; " +
      "log.md — teammate's version kept; yours saved at /x/log.md",
  );
  assert.ok(!msg.includes("nothing was overwritten"), "the amended pack DROPS this phrase");
});

test("convergeHelp: the documented reconcile chain — show-incoming → doc update --body-file → sync", () => {
  assert.equal(
    convergeHelp("aslite", "tasks/seed-one", "/x/tasks/seed-one.md"),
    "aslite sync --show-incoming tasks/seed-one → aslite doc update tasks/seed-one --body-file /x/tasks/seed-one.md → aslite sync",
  );
});

test("pickHelp: prefers a LANDED doc; falls back to the doc-write re-create chain; none usable → no help (review fix 2 + round-2 REQUIRED 3)", () => {
  const landed = {
    relPath: "tasks/a.md", entry: "tasks/a", isDoc: true,
    exportPath: "/x/tasks/a.md", bodyExportPath: "/x/tasks/a.body.md", landed: true,
  };
  const deletedUpstream = {
    relPath: "tasks/b.md", entry: "tasks/b", isDoc: true,
    exportPath: "/x/tasks/b.md", bodyExportPath: "/x/tasks/b.body.md", landed: false,
  };
  const localDeletion = {
    relPath: "tasks/c.md", entry: "tasks/c", isDoc: true,
    exportPath: null, bodyExportPath: null, landed: true,
  };
  const unparseable = {
    relPath: "tasks/d.md", entry: "tasks/d", isDoc: true,
    exportPath: "/x/tasks/d.md", bodyExportPath: null, landed: true,
  };

  // A deleted-upstream doc listed FIRST must not win over a landed one — and the chain names the
  // BODY-ONLY export (round-2 REQUIRED 3: `--body-file` input, literally executable).
  assert.equal(
    pickHelp("aslite", [deletedUpstream, landed]),
    "aslite sync --show-incoming tasks/a → aslite doc update tasks/a --body-file /x/tasks/a.body.md → aslite sync",
  );
  // Every conflicted doc deleted upstream → the doc-write re-create chain (body export again).
  assert.equal(
    pickHelp("aslite", [deletedUpstream]),
    "aslite doc write tasks/b --type <Type> --body-file /x/tasks/b.body.md → aslite sync",
  );
  // Nothing usable at all (no export, or no BODY export to feed --body-file) → no help.
  assert.equal(pickHelp("aslite", [localDeletion]), undefined);
  assert.equal(pickHelp("aslite", [unparseable]), undefined);
});

test("ffSwallowToError: git-missing / no-upstream reuse the EXACT test-pinned wording (message pack f)", () => {
  const missing = ffSwallowToError("git-missing", "agentstate-lite");
  assert.equal(missing.code, "GIT_MISSING");
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.message, "sync needs git, which isn't installed on this machine");

  // Pull-only reports the missing pull source without implying that local-only use is invalid.
  const noUpstream = ffSwallowToError("no-upstream", "agentstate-lite");
  assert.equal(noUpstream.code, "NO_UPSTREAM");
  assert.equal(noUpstream.exitCode, 1);
  assert.equal(
    noUpstream.message,
    "the board branch isn't linked to a remote — there is nothing to pull from or push to " +
      "(a local-only board is a supported mode; sharing needs a remote 'board' branch)",
  );
  assert.ok(noUpstream.help && noUpstream.help.length > 0, "no-upstream carries a fixing hint");
  assert.match(noUpstream.help!, /local-only/, "the fixing hint names local-only as supported");
});

test("ffSwallowToError: auth is exit 4, network/busy/dirty/diverged classify sensibly", () => {
  assert.equal(ffSwallowToError("auth", "aslite").exitCode, 4);
  assert.equal(ffSwallowToError("auth", "aslite").code, "AUTH_REQUIRED");
  assert.equal(ffSwallowToError("network", "aslite").exitCode, 1);
  assert.equal(ffSwallowToError("network", "aslite").code, "TRANSIENT");
  assert.equal(ffSwallowToError("busy", "aslite").code, "GIT_BUSY");
  assert.equal(ffSwallowToError("diverged", "aslite").code, "CONFLICT");
  assert.equal(ffSwallowToError("diverged", "aslite").exitCode, 5);
  assert.equal(ffSwallowToError("dirty", "aslite").code, "RUNTIME");
  assert.equal(ffSwallowToError("totally-unknown-reason", "aslite").code, "RUNTIME");
});

test("pushFailureMessage: auth and connectivity failures get the exact pinned safety string", () => {
  const auth = new CliError("AUTH_REQUIRED", "git push was denied access to the remote");
  const network = new CliError("TRANSIENT", "git push could not reach the remote — offline; retry");
  assert.equal(pushFailureMessage(auth), PUSH_FAIL_SAFETY_MESSAGE);
  assert.equal(pushFailureMessage(network), PUSH_FAIL_SAFETY_MESSAGE);
  assert.equal(
    PUSH_FAIL_SAFETY_MESSAGE,
    "committed to the board locally — your work is saved. The push failed (offline or auth); " +
      "re-run sync when you're back online or your access is restored.",
  );
});

test("pushFailureMessage: a non-fast-forward TRANSIENT keeps its actionable retry guidance", () => {
  const race = new CliError(
    "TRANSIENT",
    "a teammate pushed to the board at the same time — re-run sync to incorporate their changes and retry",
    { details: { op: "push", retryable: true, reason: "non-fast-forward" } },
  );
  assert.equal(
    pushFailureMessage(race),
    "committed to the board locally — your work is saved. " +
      "a teammate pushed to the board at the same time — re-run sync to incorporate their changes and retry",
  );
});

test("pushFailureMessage: any OTHER push-failure code still reassures, with its own classified message", () => {
  const busy = new CliError("GIT_BUSY", "another git process is using this repository — retry once it finishes");
  const msg = pushFailureMessage(busy);
  assert.notEqual(msg, PUSH_FAIL_SAFETY_MESSAGE, "not the auth/network-specific exact string");
  assert.ok(msg.startsWith("committed to the board locally — your work is saved."));
  assert.ok(msg.includes(busy.message));
});

test("singleActor: one actor across all committed docs, none when multiple (or zero) docs", () => {
  const one = [docChange({ docId: "a", verb: "added", actor: "mike" }), docChange({ docId: "b", verb: "updated", actor: "mike" })];
  const two = [docChange({ docId: "a", verb: "added", actor: "mike" }), docChange({ docId: "b", verb: "updated", actor: "brian" })];
  assert.equal(singleActor(one), "mike");
  assert.equal(singleActor(two), undefined);
  assert.equal(singleActor([]), undefined);
});

test("toIncomingRows / toDeltaRows: project DocChange into each consumer's own row shape", () => {
  const changes = [docChange({ docId: "tasks/x", verb: "added", kind: "Task", title: "X", actor: "mike" })];
  assert.deepEqual(toIncomingRows(changes), [{ verb: "added", kind: "Task", id: "tasks/x", title: "X", actor: "mike" }]);
  assert.deepEqual(toDeltaRows(changes), [{ docId: "tasks/x", verb: "added", kind: "Task", title: "X", actor: "mike" }]);
});

test("provisionAnnouncement: decisions/board-branch-sync rider 2 — a mutation is ALWAYS announceable, a no-op never is", () => {
  assert.deepEqual(
    provisionAnnouncement({ kind: "provisioned", boardPath: "/x/.agentstate-lite", source: "remote" }),
    { provisioned: "/x/.agentstate-lite — materialized from origin/board" },
  );
  // review SHOULD-FIX: a board materialized from an ALREADY-EXISTING local branch (greenfield
  // combo 2 / establish's own empty-root branch) never claims a remote origin it never touched.
  assert.deepEqual(
    provisionAnnouncement({ kind: "provisioned", boardPath: "/x/.agentstate-lite", source: "local" }),
    { provisioned: "/x/.agentstate-lite — materialized from the local board branch" },
  );
  assert.deepEqual(provisionAnnouncement({ kind: "repaired", boardPath: "/x/.agentstate-lite" }), {
    repaired: "/x/.agentstate-lite — worktree pointers repaired",
  });
  assert.equal(provisionAnnouncement({ kind: "already", boardPath: "/x/.agentstate-lite" }), undefined);
  assert.equal(provisionAnnouncement({ kind: "no_repo" }), undefined);
  assert.equal(provisionAnnouncement({ kind: "no_board", remoteState: "absent" }), undefined);
});

// ── integration tests over the U0 git harness ──────────────────────────────────

test("sync: no git repo at all -> the definitive 'nothing to sync' empty state, exit 0", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const plainDir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-plain-"));
  try {
    const { out, err } = await runSync(homes[0]!, ["--dir", plainDir]);
    assert.equal(err, undefined);
    assert.equal(out, "sync: nothing to sync\n");
  } finally {
    await cleanup();
    await rm(plainDir, { recursive: true, force: true });
  }
});

test("sync: a git repo with no board branch anywhere AND no bundle is ALSO 'nothing to sync'", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const lone = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-lone-"));
  try {
    git(lone, ["init", "-b", "main"]);
    const { out, err } = await runSync(homes[0]!, ["--dir", lone]);
    assert.equal(err, undefined);
    assert.equal(out, "sync: nothing to sync\n");
  } finally {
    await cleanup();
    await rm(lone, { recursive: true, force: true });
  }
});

/** A git repo carrying a conventional bundle folder (index.md signature) but NO board branch anywhere. */
async function makeLocalOnlyRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-localonly-"));
  git(repo, ["init", "-b", "main"]);
  await mkdir(path.join(repo, BUNDLE_DIR), { recursive: true });
  await writeFile(path.join(repo, BUNDLE_DIR, "index.md"), '---\nokf_version: "0.1"\n---\n');
  return repo;
}

test("sync: a repo whose bundle exists but has no board branch gets the local-only state", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const repo = await makeLocalOnlyRepo();
  try {
    const { out, err } = await runSync(homes[0]!, ["--dir", repo]);
    assert.equal(err, undefined, err?.message);
    assert.ok(out.includes(SYNC_LOCAL_ONLY_MESSAGE), `pinned local-only line missing from: ${out}`);
    assert.ok(out.includes(syncLocalOnlyNote(cliInvocation())), `pinned local-only note missing from: ${out}`);
    assert.ok(out.includes("sync --establish"), "the note routes sharing to the REAL verb");
    assert.ok(!out.includes("nothing to sync"), "must not reuse the no-repo/no-bundle empty state");
    assert.ok(!out.includes("already up to date"), "must not reuse the clean shared-board empty state");
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("sync: LOCAL board changes present → the local-only state still appears, sync mutates nothing and never claims a commit", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const repo = await makeLocalOnlyRepo();
  try {
    // Real local work must not be answered with a bare "nothing to sync".
    await cliDocWrite(path.join(repo, BUNDLE_DIR), "notes/local-work", [
      "--type", "Note", "--title", "Local work", "--body", "# local\n", "--actor", "mike",
    ]);
    const before = git(repo, ["status", "--porcelain"]);

    const { out, err } = await runSync(homes[0]!, ["--dir", repo]);
    assert.equal(err, undefined, err?.message);
    assert.ok(out.includes(SYNC_LOCAL_ONLY_MESSAGE), `pinned local-only line missing from: ${out}`);
    assert.ok(!/committed/.test(out.replace("sync committed nothing", "")), "never claims a commit happened");
    assert.ok(out.includes("sync committed nothing"), "the note states the no-commit fact explicitly");
    // And it genuinely didn't: the repo's git state is byte-identical.
    assert.equal(git(repo, ["status", "--porcelain"]), before, "sync mutated no git state");
    assert.ok(existsSync(path.join(repo, BUNDLE_DIR, "notes", "local-work.md")), "the local doc is untouched");
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("sync: a failed first fetch reports remote state as unknown and never recommends establishing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-unknown-"));
  const remote = path.join(root, "origin.git");
  const offlineRemote = path.join(root, "origin.offline.git");
  const seed = path.join(root, "seed");
  const repo = path.join(root, "repo");
  const { homes, cleanup } = await tempHomes(1);
  try {
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "-b", "board", seed]);
    await writeFile(path.join(seed, "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(seed, ["add", "index.md"]);
    git(seed, ["commit", "-m", "shared board"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "board"]);

    git(root, ["init", "-b", "main", repo]);
    git(repo, ["remote", "add", "origin", remote]);
    await mkdir(path.join(repo, BUNDLE_DIR), { recursive: true });
    await writeFile(path.join(repo, BUNDLE_DIR, "index.md"), '---\nokf_version: "0.1"\n---\n');
    await rename(remote, offlineRemote);

    const before = git(repo, ["status", "--porcelain"]);
    const { out, err } = await runSync(homes[0]!, ["--dir", repo]);
    assert.equal(err, undefined, err?.message);
    assert.ok(out.includes(SYNC_REMOTE_STATE_UNKNOWN_MESSAGE));
    assert.ok(out.includes(syncRemoteStateUnknownNote(cliInvocation(), true)));
    assert.ok(!out.includes(SYNC_LOCAL_ONLY_MESSAGE));
    assert.ok(!out.includes("--establish"), "must not recommend publication while remote state is unknown");
    assert.notEqual(
      gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/board"]).status,
      0,
      "the clone never fetched the remote board ref",
    );
    assert.equal(git(repo, ["status", "--porcelain"]), before);
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("sync: a single-branch clone discovers a remote board despite its refspec and a stale board/* tracking ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-single-branch-"));
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const repo = path.join(root, "repo");
  const { homes, cleanup } = await tempHomes(1);
  try {
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "# project\n");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "main"]);
    git(seed, ["checkout", "-b", "board"]);
    await writeFile(path.join(seed, "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(seed, ["add", "index.md"]);
    git(seed, ["commit", "-m", "shared board"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "origin", "main", "board"]);

    git(root, ["clone", "--single-branch", "--branch", "main", remote, repo]);
    assert.match(
      git(repo, ["config", "--get-all", "remote.origin.fetch"]),
      /refs\/heads\/main:refs\/remotes\/origin\/main/,
    );
    git(repo, ["update-ref", "refs/remotes/origin/board/old", "HEAD"]);
    await mkdir(path.join(repo, BUNDLE_DIR), { recursive: true });
    await writeFile(path.join(repo, BUNDLE_DIR, "index.md"), '---\nokf_version: "0.1"\n---\n');

    const { out, err } = await runSync(homes[0]!, ["--dir", repo]);
    assert.equal(err?.code, "RUNTIME", "the local bundle conflicts with the discovered shared board");
    assert.ok(!out.includes(SYNC_LOCAL_ONLY_MESSAGE));
    assert.ok(!`${out}\n${err?.message ?? ""}\n${err?.help ?? ""}`.includes("--establish"));
    assert.equal(
      gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/board"]).status,
      0,
      "the explicit board fetch bypasses the main-only refspec",
    );
    assert.notEqual(
      gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/board/old"]).status,
      0,
      "the impossible stale child namespace was removed before fetching exact board",
    );
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("sync: two-clone founder e2e — A writes+syncs (full), B --pull-only sees the attributed delta, both idempotent", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // The REAL authoring path (was harness hand-seeded actor frontmatter, which masked the
    // attribution gap this suite now pins — see the dedicated actor-attribution e2e below).
    await cliDocWrite(topo.a.board, "notes/founder", ["--type", "Note", "--title", "Founder note", "--body", "# hi\n", "--actor", "mike"]);

    const first = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(first.err, undefined, first.err?.message);
    assert.match(first.out, /committed: 1/);
    assert.match(first.out, /pushed: 1/);
    assert.match(first.out, /actor: mike/);
    // Finding 2: A is the AUTHOR of notes/founder, not a recipient of it — A's own receipt must
    // report pulled:0 and must NOT list its own just-committed doc as "incoming" (nothing arrived
    // FROM ORIGIN this run; see the dedicated finding-2 regression test below for the isolated case).
    assert.match(first.out, /pulled: 0/);
    assert.ok(!first.out.includes("notes/founder"), "A's own authored doc must not appear as its own incoming");

    // Idempotent re-run on A: nothing new, definitive "already up to date".
    const again = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(again.out, "sync: already up to date\n");

    // B's FIRST-EVER sync (no stored cursor yet) — must still see the attributed delta, not an
    // empty one, since the diff baseline falls back to B's own pre-sync HEAD.
    const bFirst = await runSync(homeB!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(bFirst.err, undefined, bFirst.err?.message);
    assert.match(bFirst.out, /committed: 0/);
    assert.match(bFirst.out, /pushed: 0/);
    assert.match(bFirst.out, /pulled: 1/);
    assert.match(bFirst.out, /notes\/founder/);
    assert.match(bFirst.out, /mike/);

    // Idempotent re-run on B: nothing new.
    const bAgain = await runSync(homeB!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(bAgain.out, "sync: already up to date\n");

    // The awareness cache/cursor really landed under B's own home (U4's future read path).
    const key = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board });
    const state = await readSyncState(key, homeB!);
    assert.ok(state.cursor, "B's cursor was written");
    assert.equal(state.cursor!.token, boardHead(topo.b));
    assert.equal(state.cache?.unpushedCount, 0);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: actor attribution e2e — `doc write --actor alice` through the REAL CLI path renders 'alice' (never 'unknown') in the receipt, the commit subject, and B's incoming rows", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // NO harness hand-seeding: the portable attribution must come from the CLI write path itself,
    // or sync's per-doc enrichment falls back to "unknown" everywhere.
    await cliDocWrite(topo.a.board, "notes/attributed", [
      "--type", "Note", "--title", "Attributed note", "--body", "# hi\n", "--actor", "alice",
    ]);

    const a = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(a.err, undefined, a.err?.message);
    assert.match(a.out, /committed: 1/);
    assert.match(a.out, /actor: alice/, "the receipt's actor comes per-doc from frontmatter, via the real CLI write");
    assert.ok(!a.out.includes("unknown"), `no 'unknown' anywhere in A's receipt:\n${a.out}`);

    // The commit subject is the human mirror of the same enrichment — it must name alice too.
    const subject = git(topo.a.board, ["log", "-1", "--format=%s"]).trim();
    assert.equal(subject, "board: alice — added notes/attributed");

    // B's incoming rows attribute the change to alice, never unknown.
    const b = await runSync(homeB!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(b.err, undefined, b.err?.message);
    assert.match(b.out, /pulled: 1/);
    assert.match(b.out, /notes\/attributed/);
    assert.match(b.out, /alice/, "B's incoming row carries the author");
    assert.ok(!b.out.includes("unknown"), `no 'unknown' anywhere in B's incoming rows:\n${b.out}`);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: explicit v0.2 write keeps actor attribution without a legacy top-level actor", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await writeFile(
      path.join(topo.a.board, "index.md"),
      "---\nokf_version: '0.2'\n---\n# v0.2 board\n",
      "utf8",
    );
    await cliDocWrite(topo.a.board, "notes/v02-attributed", [
      "--type", "Note", "--title", "Attributed v0.2 note", "--body", "# hi\n", "--actor", "alice",
    ]);

    const stored = await readBoardFile(topo.a, "notes/v02-attributed.md");
    assert.match(stored, /^superbee_updated_by: alice$/m);
    assert.doesNotMatch(stored, /^actor:/m, "v0.2 bytes do not restore the legacy attribution field");

    const a = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(a.err, undefined, a.err?.message);
    assert.match(a.out, /actor: alice/);
    assert.equal(git(topo.a.board, ["log", "-1", "--format=%s"]).trim(), "board: alice — added notes/v02-attributed");

    const b = await runSync(homeB!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(b.err, undefined, b.err?.message);
    assert.match(b.out, /notes\/v02-attributed/);
    assert.match(b.out, /alice/);
    assert.ok(!b.out.includes("unknown"), `no unknown attribution in B's rows:\n${b.out}`);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: CONVERGING conflict (pre-committed divergence) — exit 5, upstream kept, yours exported, pristine worktree, the exact string", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // `divergeSameDoc` already COMMITS both sides (A pushes; B commits LOCALLY but does not push)
    // — so B arrives at `sync` with a real, already-committed, unpushed divergent commit. This
    // means `stageAndCommit` is a skip-empty no-op here (committedThisRun = false), so the
    // converge message arrives WITHOUT the post-commit safety prefix — pinned EXACTLY below.
    const div = await divergeSameDoc(topo);
    const localBytes = await readBoardFile(topo.b, div.docPath);
    assert.equal(gitTry(topo.b.board, ["status", "--porcelain"]).stdout, "", "sanity: B's divergent edit is already committed, not left dirty");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "CONFLICT");
    assert.equal(result.err!.exitCode, 5);

    const exportPath = path.join(syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), homeB!), div.docPath);
    assert.equal(
      result.err!.message,
      `doc ${div.docId} — teammate's version kept; yours saved at ${exportPath} — reconcile with doc update`,
    );
    assert.ok(!result.err!.message.includes("nothing was overwritten"), "the amended pack DROPS this phrase");

    // The teammate's version was KEPT: the rebase COMPLETED (B's now-empty commit was dropped)
    // and the landed content is exactly origin/board's.
    assert.equal(isMidRebase(topo.b), false, "the rebase completed — never left mid-state");
    assert.equal(boardHead(topo.b), div.aHead, "B's board converged onto origin/board's tip");
    assert.match(git(topo.b.board, ["show", `HEAD:${div.docPath}`]), /changed by A/);
    assert.equal(gitTry(topo.b.board, ["status", "--porcelain"]).stdout, "", "worktree pristine after the completed rebase");

    // YOURS was saved: the export file is BYTE-IDENTICAL to B's local version.
    const exported = await readFile(exportPath, "utf8");
    assert.equal(exported, localBytes, "export file byte-identical to the local version");

    // The envelope rows carry {id, kind, title, yours, yours_body, theirs} + the help chain
    // (amended pack c; round-2 REQUIRED 3: the chain consumes the BODY-ONLY export).
    const bodyExportPath = exportPath.replace(/\.md$/, ".body.md");
    const conflicts = (result.err!.details as { conflicts: { rows: Record<string, unknown>[] } }).conflicts;
    assert.equal(conflicts.rows.length, 1);
    assert.equal(conflicts.rows[0]!.id, div.docId);
    assert.equal(conflicts.rows[0]!.kind, "Task");
    assert.equal(conflicts.rows[0]!.title, "Seed one");
    assert.equal(conflicts.rows[0]!.yours, exportPath);
    assert.equal(conflicts.rows[0]!.yours_body, bodyExportPath);
    assert.equal(conflicts.rows[0]!.theirs, "kept");
    assert.ok(result.err!.help!.includes(`sync --show-incoming ${div.docId}`), "help chain step 1");
    assert.ok(result.err!.help!.includes(`doc update ${div.docId} --body-file ${bodyExportPath}`), "help chain step 2 (body-only input)");
    // The body-only companion really is body-only (no YAML frontmatter to nest).
    const bodyExport = await readFile(bodyExportPath, "utf8");
    assert.ok(!bodyExport.startsWith("---"), "body export carries no frontmatter block");
    assert.match(bodyExport, /changed by B/);

    // Nothing moved on origin's side.
    assert.equal(originBoardHead(topo), div.aHead, "origin/board untouched by B's conflicted sync");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: commit-then-conflict — the run's OWN commit lands, then the envelope composes the safety framing with the EXACT converge string", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [, homeB] = homes;
  try {
    // A commits + pushes a change to the shared seed doc.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA's version.\n" });
    commitBoard(topo.a, "board: alice — updated tasks/seed-one");
    pushBoard(topo.a);
    const originAfterA = originBoardHead(topo);

    // B edits the SAME doc but does NOT commit. Unlike the pre-committed-divergence test above
    // (where divergeSameDoc pre-commits both sides and stageAndCommit no-ops), sync's own commit
    // step must land B's work THIS run (committedThisRun = true) BEFORE the rebase hits the
    // conflict — the most common real entry into a conflict: a founder's `doc update` leaves
    // uncommitted changes and sync sweeps them up.
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB's conflicting version.\n" });
    const localBytes = await readBoardFile(topo.b, "tasks/seed-one.md");
    assert.notEqual(gitTry(topo.b.board, ["status", "--porcelain"]).stdout, "", "sanity: B's edit is UNCOMMITTED before sync");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "CONFLICT");
    assert.equal(result.err!.exitCode, 5);
    // The composite, pinned EXACTLY: safety framing first — made TRUE by the commit (B's version
    // was committed, then exported when the converging rebase kept upstream) — then the converge
    // terminal string passes through UNCHANGED as the suffix.
    const exportPath = path.join(
      syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), homeB!),
      "tasks/seed-one.md",
    );
    assert.equal(
      result.err!.message,
      "committed to the board locally — your work is saved. " +
        `doc tasks/seed-one — teammate's version kept; yours saved at ${exportPath} — reconcile with doc update`,
    );
    assert.ok(JSON.stringify(result.err!.details ?? {}).includes("tasks/seed-one"), "conflict rows carry the doc id");

    // "your work is saved" is TRUE twice over: B's version is in the export file byte-for-byte,
    // and the board itself CONVERGED onto the teammate's version (the rebase completed).
    assert.equal(await readFile(exportPath, "utf8"), localBytes, "export byte-identical to B's version");
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), /A's version/);

    // Every converge invariant holds on the composite path too: rebase completed, pristine
    // worktree, origin untouched (the conflicted run never pushes).
    assert.equal(isMidRebase(topo.b), false);
    assert.equal(gitTry(topo.b.board, ["status", "--porcelain"]).stdout, "", "worktree pristine after the completed rebase");
    assert.equal(originBoardHead(topo), originAfterA, "origin/board untouched by B's conflicted sync");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: push-fail after a successful commit -> PARTIAL envelope leading with safety, exit 1, work stays committed locally", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    await writeBoardDoc(topo.a, "notes/pushfail", { frontmatter: { type: "Note", title: "Push fail", actor: "brian" }, body: "# x\n" });

    // Deterministic push failure: a rejecting pre-receive hook on the bare origin (no network
    // flakiness needed). classifyGitError has no specific pattern for a hook rejection, so this
    // exercises the GENERALIZED (non-auth/network) branch of pushFailureMessage — see that
    // function's own unit test above for the auth/network EXACT-string case.
    const hookPath = path.join(topo.origin, "hooks", "pre-receive");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(hookPath, "#!/bin/sh\necho 'rejecting all pushes (test fixture)' >&2\nexit 1\n", { mode: 0o755 }),
    );

    const before = boardHead(topo.a);
    const result = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.ok(result.err, "expected a thrown (handled) CliError");
    assert.equal(result.err!.exitCode, 1);
    assert.match(result.out, /^warning:/);
    assert.match(result.out, /committed to the board locally — your work is saved\./);
    assert.match(result.out, /committed: 1/);
    assert.match(result.out, /pushed: 0/);

    // The commit really landed locally, just never reached origin.
    const after = boardHead(topo.a);
    assert.notEqual(after, before, "a new local commit was made");
    assert.equal(originBoardHead(topo), before, "origin never received it");

    // Recovery: remove the hook, re-run — should push cleanly now (no "already up to date": a
    // real push of the previously-stuck commit happens).
    await import("node:fs/promises").then((fs) => fs.rm(hookPath));
    const recovered = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.equal(recovered.err, undefined, recovered.err?.message);
    assert.match(recovered.out, /committed: 0/);
    assert.match(recovered.out, /pushed: 1/);
    assert.equal(originBoardHead(topo), after);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: a stale mid-rebase state at ENTRY self-heals (adjudication C) before reaching its terminal outcome", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Plant a real same-doc divergence and ACTUALLY wedge B's board worktree mid-rebase (a
    // crash/kill mid-run) — the exact U0 fixture built for this.
    const div = await wedgeMidRebase(topo);
    assert.equal(isMidRebase(topo.b), true, "sanity: really wedged");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);

    // The self-heal must have run BEFORE anything else: the worktree is never left mid-rebase,
    // regardless of the outcome below.
    assert.equal(isMidRebase(topo.b), false, "self-healed — never left stuck mid-rebase");

    // The underlying divergence is REAL (same doc, both sides), so a fresh rebase attempt hits it
    // again immediately after healing — and since U3b the fresh attempt CONVERGES (upstream kept,
    // local exported, rebase completed) and reaches the CONFLICT(5) terminal envelope; the command
    // never hangs or re-wedges.
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "CONFLICT");
    assert.equal(result.err!.exitCode, 5);
    assert.ok(result.err!.message.includes(div.docId));
    assert.ok(result.err!.message.includes("teammate's version kept"), "the converging terminal string");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: git-missing exit taxonomy — a broken PATH surfaces GIT_MISSING/exit 1 with the exact message", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const plainDir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-nogit-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = ""; // no `git` binary resolvable
    const { err } = await runSync(homes[0]!, ["--dir", plainDir]);
    assert.ok(err, "expected a thrown CliError");
    assert.equal(err!.code, "GIT_MISSING");
    assert.equal(err!.exitCode, 1);
    assert.equal(err!.message, "sync needs git, which isn't installed on this machine");
  } finally {
    process.env.PATH = originalPath;
    await cleanup();
    await rm(plainDir, { recursive: true, force: true });
  }
});

test("sync: exit taxonomy sanity — CONFLICT=5, GIT_MISSING/handled-push-fail=1 (already covered above), USAGE=2 for a bad --limit", async () => {
  const { homes, cleanup } = await tempHomes(1);
  try {
    const { err } = await runSync(homes[0]!, ["--limit", "-1"]);
    assert.ok(err);
    assert.equal(err!.code, "USAGE");
    assert.equal(err!.exitCode, 2);
  } finally {
    await cleanup();
  }
});

// ── cold-review findings (post-hoc regression tests) ───────────────────────────

test("sync: FINDING 1 regression — a pre-migration repo's PLAIN .agentstate-lite dir is never mistaken for a board worktree; a wedged PARENT rebase is left completely untouched", async () => {
  // Reproduces the exact vulnerability the reviewer found: `.agentstate-lite` as a plain directory
  // committed on `main` (THIS project's own on-disk shape today, before U5 ever runs) has no `.git`
  // of its own — `git -C .agentstate-lite rev-parse --git-path rebase-merge` used to walk UP into
  // the PARENT repo's shared git dir, so the self-heal probe would find (and abort!) the user's OWN
  // in-progress rebase on `main`, entirely unrelated to sync.
  const repo = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-test-finding1-"));
  const { homes, cleanup } = await tempHomes(1);
  try {
    git(repo, ["init", "-b", "main"]);
    await mkdir(path.join(repo, ".agentstate-lite"), { recursive: true });
    await writeFile(path.join(repo, ".agentstate-lite", "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "initial (pre-migration bundle committed on main)"]);

    // Wedge the MAIN repo (NOT .agentstate-lite) mid-rebase via a real conflicting history.
    git(repo, ["checkout", "-b", "feature"]);
    await writeFile(path.join(repo, "conflict.txt"), "feature version\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "feature change"]);
    git(repo, ["checkout", "main"]);
    await writeFile(path.join(repo, "conflict.txt"), "main version\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main change"]);
    const r = gitTry(repo, ["rebase", "feature"]);
    assert.notEqual(r.status, 0, "sanity: this rebase is expected to conflict");
    const rebaseMergePath = git(repo, ["rev-parse", "--git-path", "rebase-merge"]).trim();
    const wedgedPath = path.resolve(repo, rebaseMergePath);
    assert.ok(existsSync(wedgedPath), "sanity: the PARENT repo is really wedged mid-rebase");

    await runSync(homes[0]!, ["--dir", repo]);

    assert.ok(existsSync(wedgedPath), "the parent repo's rebase state must be COMPLETELY UNTOUCHED");
  } finally {
    await cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("sync: FINDING 2 regression — an authoring-only full sync reports pulled:0 and never lists its own committed doc as incoming", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    await writeBoardDoc(topo.a, "notes/self-authored", {
      frontmatter: { type: "Note", title: "Self authored", actor: "mike" },
      body: "# x\n",
    });

    const result = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /committed: 1/);
    assert.match(result.out, /pushed: 1/);
    assert.match(result.out, /pulled: 0/);
    assert.ok(!result.out.includes("notes/self-authored"), "the self-authored doc must never appear as its own incoming");

    // Direct unit coverage of the underlying primitive too: diffing origin/board against ITSELF
    // (nothing fetched) always yields an empty result, regardless of local commit history.
    assert.deepEqual(originDocsBetween(topo.a.board, "HEAD", "HEAD"), []);
    assert.deepEqual(originDocsBetween(topo.a.board, null, "HEAD"), []);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: the central happy path — a genuine local commit AND a real remote doc both land in one full sync, correctly attributed", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    // Replicates divergeDifferentDoc's shape (A edits+pushes tasks/seed-one; B has an unpushed
    // local commit on the DIFFERENT tasks/seed-two — no content conflict) WITHOUT that fixture's
    // own trailing `fetchBoard(topo.b)` call — that fetch would let B "already know" about A's
    // push BEFORE sync() ever runs, making sync's own fetch a no-op and defeating the point of this
    // test: THIS sync call's own fetch must be what pulls tasks/seed-one in.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# tasks/seed-one\n\nchanged by A\n" });
    commitBoard(topo.a, "board: A edits tasks/seed-one", { author: { name: "alice", email: "alice@example.invalid" } });
    pushBoard(topo.a);

    await modifyBoardDoc(topo.b, "tasks/seed-two", { body: "# tasks/seed-two\n\nchanged by B\n" });
    commitBoard(topo.b, "board: B edits tasks/seed-two", { author: { name: "bob", email: "bob@example.invalid" } });

    // B ALSO has a genuinely NEW, uncommitted doc — THIS sync run's own commit step must create it.
    await writeBoardDoc(topo.b, "notes/b-own", {
      frontmatter: { type: "Note", title: "B's own note", actor: "brian" },
      body: "# hi\n",
    });

    const result = await runSync(homes[0]!, ["--dir", topo.b.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /committed: 1/, "only notes/b-own is NEW this run");
    assert.match(result.out, /pushed: 2/, "notes/b-own PLUS the pre-existing unpushed tasks/seed-two commit");
    assert.match(result.out, /pulled: 1/, "only tasks/seed-one arrived from origin");
    assert.match(result.out, /actor: brian/, "the local commit's own actor");
    assert.match(result.out, /tasks\/seed-one/, "the real incoming doc");
    assert.ok(!result.out.includes("notes/b-own"), "B's own new doc must not appear as incoming");
    assert.ok(!result.out.includes("tasks/seed-two"), "B's PRE-EXISTING committed doc must not appear as incoming either");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: FINDING 3 — a commit that lands, then a fetch failure, still gets the safety framing + an honest cache write (stranded-commit path)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    // B is already provisioned (the topology's default) — break its origin AFTER provisioning, so
    // THIS run's commit step (purely local) still succeeds, and only the fetch/rebase step fails.
    // provisionBoardWorktree short-circuits to "already" for an already-provisioned worktree
    // WITHOUT re-fetching, so the broken URL is never touched until fetchRebase's own throwing fetch.
    const badOrigin = "/nonexistent-origin-path-xyz";
    git(topo.b.root, ["remote", "set-url", "origin", badOrigin]);
    await writeBoardDoc(topo.b, "notes/stranded", {
      frontmatter: { type: "Note", title: "Stranded", actor: "brian" },
      body: "# x\n",
    });

    const before = boardHead(topo.b);
    const result = await runSync(homes[0]!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.match(result.err!.message, /committed to the board locally — your work is saved/);
    const after = boardHead(topo.b);
    assert.notEqual(after, before, "the commit genuinely landed locally despite the fetch failure");

    // The cache was written with honest (post-commit) backstop counts BEFORE the throw.
    const key = bundleKey({ remoteUrl: badOrigin, subpath: "", checkoutRoot: topo.b.board });
    const state = await readSyncState(key, homes[0]!);
    assert.ok(state.cache, "cache was written despite the thrown error");
    assert.equal(state.cache!.unpushedCount, 1, "the stranded commit is honestly reflected as unpushed");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── review round 2: wrong-target-git-operation regressions ─────────────────────

test("sync: an independent NESTED git repo at .agentstate-lite is NEVER healed — its in-progress rebase survives (round-2 finding 1)", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "agentstate-lite-sync-nested-"));
  try {
    const idc = ["-c", "user.name=t", "-c", "user.email=t@t.test"];
    // Outer project repo (no board anywhere).
    git(outer, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(outer, "README.md"), "outer\n");
    git(outer, [...idc, "add", "-A"]);
    git(outer, [...idc, "commit", "-q", "-m", "outer initial"]);

    // An UNRELATED standalone repo squatting at exactly `.agentstate-lite` (its own `git init`,
    // NOT a linked board worktree), wedged mid-rebase with a real conflict.
    const nested = path.join(outer, ".agentstate-lite");
    await mkdir(nested);
    git(nested, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(nested, "a.txt"), "one\n");
    git(nested, [...idc, "add", "-A"]);
    git(nested, [...idc, "commit", "-q", "-m", "base"]);
    git(nested, ["checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(nested, "a.txt"), "two\n");
    git(nested, [...idc, "commit", "-q", "-am", "feature change"]);
    git(nested, ["checkout", "-q", "main"]);
    await writeFile(path.join(nested, "a.txt"), "three\n");
    git(nested, [...idc, "commit", "-q", "-am", "main change"]);
    git(nested, ["checkout", "-q", "feature"]);
    const rebase = gitTry(nested, [...idc, "rebase", "main"]);
    assert.notEqual(rebase.status, 0, "sanity: the nested repo's rebase stopped on a conflict");
    const rebaseState = path.join(nested, ".git", "rebase-merge");
    assert.ok(existsSync(rebaseState), "sanity: the nested repo is genuinely mid-rebase");
    const wedgedHead = gitTry(nested, ["rev-parse", "HEAD"]).stdout.trim();

    // sync in the OUTER repo: must not touch the nested repo, and reports nothing to sync.
    const { homes, cleanup } = await tempHomes(1);
    try {
      const result = await runSync(homes[0]!, ["--dir", outer]);
      assert.equal(result.err, undefined, result.err?.message);
      assert.match(result.out, /nothing to sync/);
      assert.ok(existsSync(rebaseState), "the nested repo's in-progress rebase is UNTOUCHED");
      assert.equal(gitTry(nested, ["rev-parse", "HEAD"]).stdout.trim(), wedgedHead, "nested HEAD unmoved");
    } finally {
      await cleanup();
    }
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

// ── PR#13 review item 4: per-CLONE state keying (same origin, same machine, ONE HOME) ───────────

test("sync: cross-clone isolation — clone A's clean sync must NOT erase clone B's stranded-unpushed backstop state (one origin, ONE HOME)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const home = homes[0]!; // ONE home — the same-machine multi-clone shape (agent worktrees) the bug lived in
  try {
    // B strands TWO committed-but-unpushed board commits: a rejecting pre-receive hook on origin
    // makes B's full sync fail at the push step — the exact empirical PR#13 shape ("clone B had 2
    // stranded unpushed commits; cache unpushed: 2").
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB's first stranded edit\n" });
    commitBoard(topo.b, "board: B edit one");
    await modifyBoardDoc(topo.b, "tasks/seed-two", { body: "# Seed two\n\nB's second stranded edit\n" });
    commitBoard(topo.b, "board: B edit two");
    const hookPath = path.join(topo.origin, "hooks", "pre-receive");
    await writeFile(hookPath, "#!/bin/sh\necho 'rejecting all pushes (test fixture)' >&2\nexit 1\n", { mode: 0o755 });
    const bResult = await runSync(home, ["--dir", topo.b.root]);
    assert.ok(bResult.err, "B's push was rejected — the commits are genuinely stranded");

    const keyB = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board });
    const bBefore = await readSyncState(keyB, home);
    assert.equal(bBefore.cache?.unpushedCount, 2, "B's backstop honestly records the 2 stranded commits");
    const bCursor = bBefore.cursor?.token;
    assert.equal(bCursor, boardHead(topo.b), "B's cursor is B's OWN board HEAD");

    // A's CLEAN sync under the SAME home (hook removed first, so A is genuinely clean end to end).
    await rm(hookPath);
    const aResult = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(aResult.err, undefined, aResult.err?.message);
    assert.equal(aResult.out, "sync: already up to date\n");

    // A got its OWN state file under its OWN key…
    const keyA = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.a.board });
    assert.notEqual(keyA, keyB, "same origin, same machine, two clones → two keys (the fix)");
    const aState = await readSyncState(keyA, home);
    assert.equal(aState.cache?.unpushedCount, 0, "A's own state is honestly clean");

    // …and the bug's exact target case: B's stranded state SURVIVED A's clean sync.
    const bAfter = await readSyncState(keyB, home);
    assert.equal(bAfter.cache?.unpushedCount, 2, "B's 'unpushed: 2' backstop survives A's clean sync");
    assert.equal(bAfter.cursor?.token, bCursor, "B's cursor untouched by A's sync");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: same-clone key stability — syncs from the repo root, a subdirectory, and inside the board worktree all reuse ONE state file", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const home = homes[0]!;
  try {
    const first = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(first.err, undefined, first.err?.message);
    const stateFiles = async () => (await readdir(syncStateDir(home))).filter((f) => f.endsWith(".json")).sort();
    const afterFirst = await stateFiles();
    assert.equal(afterFirst.length, 1, "one clone → one state file");

    // Different invocation directories inside the SAME clone must derive the SAME key: the repo
    // root, a plain subdirectory, and the board-interior retarget path all resolve one board.
    const fromSubdir = await runSync(home, ["--dir", path.join(topo.a.root, "src")]);
    assert.equal(fromSubdir.err, undefined, fromSubdir.err?.message);
    const fromBoardInterior = await runSync(home, ["--dir", topo.a.board]);
    assert.equal(fromBoardInterior.err, undefined, fromBoardInterior.err?.message);
    assert.deepEqual(await stateFiles(), afterFirst, "no second state file ever appeared for this clone");

    // And the file is readable under the key sync derives: remote + THIS checkout's board root.
    const key = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.a.board });
    const state = await readSyncState(key, home);
    assert.equal(state.cursor?.token, boardHead(topo.a), "cursor persisted and re-read under the stable per-clone key");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: a dangling stored cursor under the per-clone key still re-anchors with the HONEST note through the real sync flow", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const home = homes[0]!;
  try {
    // Plant the cursor under the SAME key sync derives — if resolveBundleKey and this key ever
    // disagreed, sync would silently fall back to the first-sync baseline (no note) and this fails.
    const key = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.a.board });
    const dangling = await danglingCursorSha(topo.a);
    await writeCursor(key, { tier: "git", token: dangling }, home);

    const result = await runSync(home, ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /delta unavailable \(history rewritten or repositioned\)/, "the honest re-anchor note reaches the receipt");

    const state = await readSyncState(key, home);
    assert.equal(state.cursor?.token, boardHead(topo.a), "cursor re-anchored to HEAD");
    assert.equal(state.cache?.note, REANCHOR_NOTE);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: run from INSIDE the board worktree retargets to the enclosing project and just works (round-2 finding 2)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    await writeBoardDoc(topo.a, "notes/from-inside", { frontmatter: { type: "Note", title: "From inside", actor: "brian" }, body: "# x\n" });

    // `--dir` pointed AT the board worktree itself — where an agent sits right after
    // `doc write --dir .agentstate-lite`. Previously: RUNTIME with a leaked doubled path.
    const result = await runSync(homes[0]!, ["--dir", topo.a.board]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /committed: 1/);
    assert.match(result.out, /pushed: 1/);
    assert.equal(gitTry(topo.a.board, ["status", "--porcelain"]).stdout, "", "board worktree clean after the sync");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── worktree portability + loud provisioning (2026-07-08 field finding + rider 2) ──────────────
//
// decisions/board-branch-sync rider 2 (binding): "provisioning is detection-gated and loud … says
// so in structured output — never a silent git mutation." These tests pin the exact announcement
// strings sync's envelope must carry whenever provisioning itself did something, and prove the
// mount-move field finding (a sandbox/devcontainer remount snaps a board worktree's ABSOLUTE
// pointers) self-repairs end-to-end through the REAL `sync()` entry point — not just the
// lower-level `provisionBoardWorktree` unit covered in git-porcelain.test.ts.

test("sync: loud provisioning — a fresh unprovisioned clone's FIRST sync announces 'provisioned', never silently", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const { homes, cleanup } = await tempHomes(1);
  try {
    const result = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.ok(
      result.out.includes(`provisioned: ${topo.a.board} — materialized from origin/board`),
      `expected the provisioned announcement in: ${result.out}`,
    );
    // A fresh clone with nothing else pending still hits the "already up to date" shortcut — the
    // very regression this rider closes (previously: a bare 'sync: already up to date', silent
    // about the provisioning that just happened).
    assert.match(result.out, /sync: already up to date/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: loud provisioning — THE MOUNT-MOVE FIELD FINDING end-to-end — a moved/remounted repo self-repairs through the REAL sync() entry point and announces 'repaired'", async () => {
  // provision:true — the harness's own raw `worktree add` (no relative-paths config) writes
  // ABSOLUTE pointers, reproducing the pre-2.48-shaped state a sandbox/CI/devcontainer mount-move
  // breaks (empirically verified live, board task sync-worktree-portability).
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  try {
    const staleGitFile = (await readFile(path.join(topo.a.board, ".git"), "utf8")).trim();
    assert.match(staleGitFile, /^gitdir:\s*\//, "precondition: the harness's own provisioning wrote ABSOLUTE pointers");

    const movedRoot = path.join(path.dirname(topo.a.root), `moved-${path.basename(topo.a.root)}`);
    await rename(topo.a.root, movedRoot);
    const movedBoard = path.join(movedRoot, BUNDLE_DIR);

    // Plant a genuine local change BEFORE syncing, so a clean run through the repaired worktree
    // proves it is fully FUNCTIONAL (commit + push), not merely self-consistent.
    await cliDocWrite(movedBoard, "notes/post-move", [
      "--type",
      "Note",
      "--title",
      "Post-move",
      "--body",
      "# hi\n",
      "--actor",
      "mike",
    ]);

    const result = await runSync(homes[0]!, ["--dir", movedRoot]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.ok(
      result.out.includes(`repaired: ${movedBoard} — worktree pointers repaired`),
      `expected the repaired announcement in: ${result.out}`,
    );
    assert.match(result.out, /committed: 1/);
    assert.match(result.out, /pushed: 1/);

    // End-to-end, the OTHER side: B (never moved) picks up the repaired-and-pushed doc via an
    // ordinary pull-only sync — proving the repaired worktree's push genuinely reached origin.
    const b = await runSync(homes[1]!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(b.err, undefined, b.err?.message);
    assert.match(b.out, /pulled: 1/);
    assert.match(b.out, /notes\/post-move/);

    // And the repaired worktree is usable by ordinary git too, not just this CLI.
    assert.equal(gitTry(movedBoard, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "board");

    // Steady-state re-run from the (now healthy) moved location: NEITHER announcement key appears.
    const again = await runSync(homes[0]!, ["--dir", movedRoot]);
    assert.equal(again.out, "sync: already up to date\n", "no provisioned/repaired key on a steady-state re-run");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: moved/remounted repo still repairs when invoked from INSIDE the stale board checkout", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  let movedRoot: string | undefined;
  try {
    movedRoot = path.join(path.dirname(topo.a.root), `moved-${path.basename(topo.a.root)}`);
    await rename(topo.a.root, movedRoot);
    const movedBoard = path.join(movedRoot, BUNDLE_DIR);

    const result = await runSync(homes[0]!, ["--dir", movedBoard]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.ok(
      result.out.includes(`repaired: ${movedBoard} — worktree pointers repaired`),
      `expected repair announcement instead of a false empty state: ${result.out}`,
    );
    assert.match(result.out, /sync: already up to date/);
    assert.equal(gitTry(movedBoard, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "board");
  } finally {
    await cleanup();
    if (movedRoot) await rm(movedRoot, { recursive: true, force: true });
    await topo.cleanup();
  }
});

test("sync: steady state carries NEITHER 'provisioned' NOR 'repaired' — an already-healthy worktree's sync stays exactly 'sync: already up to date'", async () => {
  const topo = await makeTwoCloneTopology(); // provision:true, healthy pointers, no move
  const { homes, cleanup } = await tempHomes(1);
  try {
    const result = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.equal(result.out, "sync: already up to date\n");
    assert.ok(!result.out.includes("provisioned:"));
    assert.ok(!result.out.includes("repaired:"));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── review round 2 (post cold-review), gap #4: loud provisioning on the OTHER two entry points ─

test("sync: loud provisioning — a fresh unprovisioned clone's FIRST `--pull-only` run ALSO announces 'provisioned' (not just the full-sync path)", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const { homes, cleanup } = await tempHomes(1);
  try {
    const result = await runSync(homes[0]!, ["--dir", topo.a.root, "--pull-only"]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.ok(
      result.out.includes(`provisioned: ${topo.a.board} — materialized from origin/board`),
      `expected the provisioned announcement in: ${result.out}`,
    );
    assert.match(result.out, /sync: already up to date/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: loud provisioning — a FRESH provision followed by a broken-origin failure still carries 'provisioned' in the thrown error's details (AUTH_REQUIRED)", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const { homes, cleanup } = await tempHomes(1);
  try {
    // Break origin AFTER the initial clone already fetched refs/remotes/origin/board (mirrors
    // FINDING 3's own technique): provisioning succeeds from that pre-fetched local ref (needs no
    // network), but STEP 3's own `fetch` inside fetchRebaseResolving then fails for real.
    git(topo.a.root, ["remote", "set-url", "origin", "/nonexistent-origin-xyz"]);
    const result = await runSync(homes[0]!, ["--dir", topo.a.root]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "AUTH_REQUIRED");
    assert.equal(
      result.err!.details?.provisioned,
      `${topo.a.board} — materialized from origin/board`,
      "the fresh provision is announced even though the run ultimately failed",
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("sync: THE HEAL-ORDERING EDGE — a repaired worktree that was ALSO wedged mid-rebase gets healed before the commit/pull step, converging cleanly instead of failing on 'rebase already in progress'", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  try {
    // Wedge B mid-rebase on a genuine same-doc conflict (tasks/seed-one), THEN move the entire
    // repo — reproducing a worse-case composite: `healStaleRebaseBeforeProvisioning`'s entry-heal
    // (STEP 0) correctly SKIPS this worktree at entry (its stale pointers make repoTopLevel(...)
    // resolve to nothing, reading as "not a linked worktree yet" rather than "wedged") — so without
    // the heal-ordering fix, provisioning's own repair would fix the POINTERS but leave the wedge
    // behind, and the next `git rebase` attempt would fail outright ("a rebase is already in
    // progress") instead of cleanly reaching the converging conflict mechanic.
    const div = await wedgeMidRebase(topo);
    assert.ok(isMidRebase(topo.b), "sanity: genuinely wedged before the move");

    const movedRoot = path.join(path.dirname(topo.b.root), `moved-${path.basename(topo.b.root)}`);
    await rename(topo.b.root, movedRoot);
    const movedBoard = path.join(movedRoot, BUNDLE_DIR);

    const result = await runSync(homes[0]!, ["--dir", movedRoot]);
    // The healed wedge lets STEP 3 start a FRESH rebase, which re-hits the SAME same-doc conflict —
    // resolved by the CONVERGING mechanic (U3b), a clean CONFLICT(5) terminal, never a raw
    // "rebase already in progress" RUNTIME failure.
    assert.ok(result.err, "expected the converging CONFLICT terminal");
    assert.equal(result.err!.code, "CONFLICT");
    assert.ok(result.err!.message.includes(div.docId), result.err!.message);
    // Loud provisioning still applies on this (error) path too — rider 2 is not receipt-only.
    assert.equal(result.err!.details?.repaired, `${movedBoard} — worktree pointers repaired`);

    // And the heal genuinely ran: the worktree is no longer wedged mid-rebase.
    const movedRepo: BoardRepo = { name: "B-moved", root: movedRoot, board: movedBoard };
    assert.equal(isMidRebase(movedRepo), false, "the wedge was healed before the pull step reached it");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});
