// Tests for U3b (plans/sync-verb-implementation §U3b) — the CONVERGING conflict mechanic and the
// `sync --show-incoming <id>` conflict viewer, over the U0 git harness.
//
// The BINDING convergence acceptance test lives here: follow the documented reconcile chain
// (show-incoming → doc update --body-file → sync) and assert ALL THREE:
//   (i)   landed content == origin/board's version,
//   (ii)  the export file is BYTE-IDENTICAL to the local version,
//   (iii) the teammate's version is NOT clobbered in a two-founder e2e (their pushed content
//         survives on origin after the subsequent push).
// Plus: the multi-commit local stack terminates (the LOOP — rebase-merge gone), the reserved-file
// (log.md) conflict (kept-upstream + exported + verbatim label), non-conflicted docs in the same
// sync still landing, and the full show-incoming state/byte-channel matrix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";
import { parseMarkdown, versionOfBytes } from "@superbee/core";

import { sync, SHOW_INCOMING_AS_OF, SHOW_INCOMING_ABSENT_STATE, SHOW_INCOMING_NO_UPSTREAM } from "../src/commands/sync.js";
import { convergeHelp } from "../src/commands/sync/converge.js";
import { doc } from "../src/commands/doc.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { bundleKey, syncExportsDir } from "../src/cursor.js";
import {
  boardHead,
  commitBoard,
  deleteBoardDoc,
  fetchBoard,
  git,
  gitTry,
  isMidRebase,
  makeTwoCloneTopology,
  modifyBoardDoc,
  originBoardHead,
  pushBoard,
  readBoardFile,
  writeBoardDoc,
  type TwoCloneTopology,
} from "../../board-git/test/git-harness.js";
import { parseCommandLine, rendered } from "./support/rendered-command.js";

// ── scaffolding (mirrors sync.test.ts; adds stderr + byte capture for --out -) ──

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  return withIsolatedUserEnv(home, run);
}

interface RunResult {
  out: string;
  errOut: string;
  bytes: Buffer;
  err?: CliError;
}

/** Run `sync(argv)` under an isolated HOME, capturing stdout, stderr, AND raw stdout bytes. */
async function runSync(home: string, argv: string[]): Promise<RunResult> {
  const out: string[] = [];
  const errOut: string[] = [];
  const byteChunks: Buffer[] = [];
  const deps = {
    stdout: (s: string) => void out.push(s),
    stderr: (s: string) => void errOut.push(s),
    writeStdoutBytes: (d: Uint8Array) => void byteChunks.push(Buffer.from(d)),
  };
  const result = (err?: CliError): RunResult => ({
    out: out.join(""),
    errOut: errOut.join(""),
    bytes: Buffer.concat(byteChunks),
    ...(err ? { err } : {}),
  });
  try {
    await withHome(home, () => sync(argv, deps));
    return result();
  } catch (err) {
    if (err instanceof CliError) return result(err);
    throw err;
  }
}

/** Run a `doc` subcommand (the reconcile chain's `doc update` step), capturing stdout. */
async function runDoc(argv: string[]): Promise<{ out: string; err?: CliError }> {
  const out: string[] = [];
  try {
    await doc(argv, { stdout: (s: string) => void out.push(s) });
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

async function tempHomes(n: number): Promise<{ homes: string[]; cleanup: () => Promise<void> }> {
  const homes = await Promise.all(
    Array.from({ length: n }, () => mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-test-home-"))),
  );
  return {
    homes,
    cleanup: async () =>
      Promise.all(homes.map((h) => rm(h, { recursive: true, force: true }))).then(() => undefined),
  };
}

/**
 * The export path sync uses for `relPath` under `home` — for CLONE B, the conflicting side in
 * every scenario in this suite (exports are keyed per-clone now: remote + checkout root).
 */
function exportPathFor(topo: TwoCloneTopology, home: string, relPath: string): string {
  return path.join(
    syncExportsDir(bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: topo.b.board }), home),
    relPath,
  );
}

/** Assert a board worktree ended a sync pristine: no mid-rebase state, no uncommitted changes. */
function assertPristine(repo: { name: string; board: string }, topoLabel: string): void {
  assert.equal(gitTry(repo.board, ["status", "--porcelain"]).stdout, "", `${topoLabel}: worktree clean`);
}

// ── the BINDING convergence acceptance test ─────────────────────────────────────

test("U3b BINDING: converge → show-incoming → doc update → sync — all three asserts, teammate never clobbered", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Founder A (the teammate) edits the shared doc, syncs it out.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA's half of the story.\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    const aHead = originBoardHead(topo);

    // Founder B edits the SAME doc (uncommitted — sync's own commit step sweeps it up).
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB's half of the story.\n" });
    const localBytes = await readBoardFile(topo.b, "tasks/seed-one.md");

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");
    assert.equal(conflicted.err!.exitCode, 5);
    assert.ok(
      conflicted.err!.message.startsWith("committed to the board locally — your work is saved."),
      "composite safety framing (this run committed B's version first)",
    );

    // (i) landed content == origin/board's version (the teammate's).
    const landed = git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]);
    const upstream = git(topo.b.board, ["show", "refs/remotes/origin/board:tasks/seed-one.md"]);
    assert.equal(landed, upstream, "(i) landed content is exactly origin/board's version");
    assert.match(landed, /A's half of the story/);

    // (ii) the export file is BYTE-IDENTICAL to B's local version.
    const exportPath = exportPathFor(topo, homeB!, "tasks/seed-one.md");
    assert.equal(await readFile(exportPath, "utf8"), localBytes, "(ii) export byte-identical to the local version");

    assert.equal(isMidRebase(topo.b), false, "rebase completed — never left mid-state");
    assertPristine(topo.b, "B after converge");

    // ── the documented reconcile chain ──
    // Step 1: view the kept incoming version (labeled "as of last fetch").
    const incoming = await runSync(homeB!, ["--show-incoming", "tasks/seed-one", "--dir", topo.b.root]);
    assert.equal(incoming.err, undefined, incoming.err?.message);
    assert.match(incoming.out, /A's half of the story/);
    assert.ok(incoming.out.includes(SHOW_INCOMING_AS_OF), 'labeled "as of last fetch"');

    // Step 2: write the MERGED body on top as a NEW doc update (a fresh write — CAS semantics).
    const mergedFile = path.join(homeB!, "merged-body.md");
    await writeFile(mergedFile, "# Seed one\n\nA's half of the story.\n\nB's half of the story.\n");
    const updated = await runDoc(["update", "tasks/seed-one", "--body-file", mergedFile, "--dir", topo.b.board]);
    assert.equal(updated.err, undefined, updated.err?.message);

    // Step 3: sync again — the conflict is CLEARED; the merged version pushes cleanly, exit 0.
    const cleared = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(cleared.err, undefined, `the reconcile chain must clear the conflict: ${cleared.err?.message}`);
    assert.match(cleared.out, /committed: 1/);
    assert.match(cleared.out, /pushed: /);
    assertPristine(topo.b, "B after reconcile sync");

    // (iii) the teammate is NOT clobbered: A's pushed commit is still an ancestor of origin/board,
    // and the content that now lives on origin carries A's half too.
    assert.equal(
      gitTry(topo.origin, ["merge-base", "--is-ancestor", aHead, "board"]).status,
      0,
      "(iii) A's pushed commit survives in origin's board history",
    );
    const originContent = git(topo.origin, ["show", "board:tasks/seed-one.md"]);
    assert.match(originContent, /A's half of the story/, "(iii) A's content survives on origin");
    assert.match(originContent, /B's half of the story/, "the merged reconcile carries B's half as well");

    // And A can pull the merged result cleanly.
    const aPull = await runSync(homeA!, ["--dir", topo.a.root, "--pull-only"]);
    assert.equal(aPull.err, undefined, aPull.err?.message);
    assert.match(git(topo.a.board, ["show", "HEAD:tasks/seed-one.md"]), /B's half of the story/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── the LOOP: a multi-commit local stack stops the rebase more than once ────────

test("U3b: multi-commit local stack — the converging loop terminates, every conflicted doc kept-upstream + exported", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  try {
    // A pushes changes to BOTH docs.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA rewrote one.\n" });
    await modifyBoardDoc(topo.a, "tasks/seed-two", { body: "# Seed two\n\nA rewrote two.\n" });
    commitBoard(topo.a, "board: alice — 2 docs", { author: { name: "alice", email: "alice@example.invalid" } });
    pushBoard(topo.a);
    const aHead = originBoardHead(topo);

    // B stacks TWO local commits, each touching one of the same docs — each replay stops the rebase.
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB rewrote one.\n" });
    commitBoard(topo.b, "board: bob — updated tasks/seed-one", { author: { name: "bob", email: "bob@example.invalid" } });
    const bSeedOne = await readBoardFile(topo.b, "tasks/seed-one.md");
    await modifyBoardDoc(topo.b, "tasks/seed-two", { body: "# Seed two\n\nB rewrote two.\n" });
    commitBoard(topo.b, "board: bob — updated tasks/seed-two", { author: { name: "bob", email: "bob@example.invalid" } });
    const bSeedTwo = await readBoardFile(topo.b, "tasks/seed-two.md");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(result.err!.code, "CONFLICT");

    // The LOOP terminated: no rebase state left, worktree pristine, board converged onto A's tip
    // (both of B's commits became empty after keep-upstream and were dropped).
    assert.equal(isMidRebase(topo.b), false, "rebase-merge is GONE — the loop terminated");
    assertPristine(topo.b, "B after multi-stop converge");
    assert.equal(boardHead(topo.b), aHead, "both empty replays dropped — converged onto origin/board");

    // BOTH docs: upstream kept, local exported byte-identically; both rows reported.
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), /A rewrote one/);
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-two.md"]), /A rewrote two/);
    assert.equal(await readFile(exportPathFor(topo, homeB!, "tasks/seed-one.md"), "utf8"), bSeedOne);
    assert.equal(await readFile(exportPathFor(topo, homeB!, "tasks/seed-two.md"), "utf8"), bSeedTwo);
    const rows = (result.err!.details as { conflicts: { rows: Array<{ id?: string }> } }).conflicts.rows;
    assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(["tasks/seed-one", "tasks/seed-two"]));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── reserved-file conflict (log.md) ─────────────────────────────────────────────

test("U3b: a reserved-file (log.md) conflict — kept-upstream, exported, labeled VERBATIM (never 'doc log.md')", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Both sides rewrite log.md's tail differently (same region → a genuine content conflict).
    const base = await readBoardFile(topo.a, "log.md").catch(() => "");
    await writeFile(path.join(topo.a.board, "log.md"), `${base}- A's provenance line\n`);
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    await writeFile(path.join(topo.b.board, "log.md"), `${base}- B's provenance line\n`);
    const bLog = await readBoardFile(topo.b, "log.md");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(result.err!.code, "CONFLICT");
    assert.ok(result.err!.message.includes("log.md — teammate's version kept"), "verbatim label");
    assert.ok(!result.err!.message.includes("doc log.md"), "NEVER 'doc log.md'");

    // Kept-upstream + exported, identically to a concept doc.
    assert.match(git(topo.b.board, ["show", "HEAD:log.md"]), /A's provenance line/);
    const exportPath = exportPathFor(topo, homeB!, "log.md");
    assert.equal(await readFile(exportPath, "utf8"), bLog, "log.md export byte-identical to B's version");
    const rows = (result.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    const logRow = rows.find((r) => r.path === "log.md");
    assert.ok(logRow, "the reserved entry reports `path`, not `id`");
    assert.equal(logRow!.yours, exportPath);
    assert.equal(logRow!.theirs, "kept");
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after reserved-file converge");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── non-conflicted docs in the same sync still land ─────────────────────────────

test("U3b: non-conflicted docs in the SAME sync still land locally, and the NEXT sync pushes them (exit 0)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA's take.\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    const originAfterA = originBoardHead(topo);

    // B's ONE pending batch: a conflicting edit AND an unrelated brand-new doc.
    await modifyBoardDoc(topo.b, "tasks/seed-one", { body: "# Seed one\n\nB's take.\n" });
    await writeBoardDoc(topo.b, "notes/unrelated", {
      frontmatter: { type: "Note", title: "Unrelated", actor: "brian" },
      body: "# Unrelated\n\nno conflict here\n",
    });

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(result.err!.code, "CONFLICT");

    // The non-conflicted doc LANDED: it survives at HEAD on top of origin/board's tip.
    assert.match(git(topo.b.board, ["show", "HEAD:notes/unrelated.md"]), /no conflict here/);
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), /A's take/);
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after mixed-batch converge");
    // The conflicted run never pushes — origin is untouched until the reconciling sync.
    assert.equal(originBoardHead(topo), originAfterA, "origin untouched by the conflicted run");

    // The NEXT sync (no new edits — B accepts the kept version) pushes the landed work, exit 0.
    const next = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(next.err, undefined, next.err?.message);
    assert.match(next.out, /pushed: 1/);
    assert.match(git(topo.origin, ["show", "board:notes/unrelated.md"]), /no conflict here/);
    assert.equal(
      gitTry(topo.origin, ["merge-base", "--is-ancestor", originAfterA, "board"]).status,
      0,
      "A's history survives on origin",
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── review fix 1: non-ASCII paths through the FULL converge path ────────────────

test("U3b fix 1: a NON-ASCII doc id (tasks/café) converges — no quotepath corruption, export byte-identical, reconcile chain clears", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Seed the non-ASCII doc on the shared board first (A authors it, pushes; B pulls).
    await writeBoardDoc(topo.a, "tasks/café", {
      frontmatter: { type: "Task", title: "Café", actor: "mike" },
      body: "# Café\n\nbase\n",
    });
    const seeded = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(seeded.err, undefined, seeded.err?.message);
    const bPull = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(bPull.err, undefined, bPull.err?.message);

    // Diverge it on both sides. With core.quotepath at git's default, the conflict list came back
    // C-QUOTED ("tasks/caf\\303\\251.md", quotes included) and every per-path op then missed the
    // real file — the export silently failed (a FALSE "your side deleted it"), cat-file misrouted
    // modify→delete, and `git rm` failed pathspec → RUNTIME exit 1 on EVERY retry (the stuck-loop
    // class this unit exists to kill).
    await modifyBoardDoc(topo.a, "tasks/café", { body: "# Café\n\nA's café\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    await modifyBoardDoc(topo.b, "tasks/café", { body: "# Café\n\nB's café\n" });
    const localBytes = await readBoardFile(topo.b, "tasks/café.md");

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope, not a RUNTIME pathspec failure");
    assert.equal(conflicted.err!.code, "CONFLICT", `got ${conflicted.err!.code}: ${conflicted.err!.message}`);
    assert.ok(!conflicted.err!.message.includes("your side deleted it"), "no FALSE local-deletion claim");
    assert.ok(!conflicted.err!.message.includes("\\303"), "no C-quoted escapes leak into the message");

    // Kept upstream + exported byte-identically, exactly like an ASCII path.
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/café.md"]), /A's café/);
    const exportPath = exportPathFor(topo, homeB!, "tasks/café.md");
    assert.equal(await readFile(exportPath, "utf8"), localBytes, "export byte-identical to the local version");
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after non-ASCII converge");

    // The reconcile chain CLEARS it (the exact loop that used to be stuck forever).
    const mergedFile = path.join(homeB!, "café-merged.md");
    await writeFile(mergedFile, "# Café\n\nA's café\n\nB's café\n");
    const updated = await runDoc(["update", "tasks/café", "--body-file", mergedFile, "--dir", topo.b.board]);
    assert.equal(updated.err, undefined, updated.err?.message);
    const cleared = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(cleared.err, undefined, `the reconcile chain must clear the conflict: ${cleared.err?.message}`);
    assert.match(git(topo.origin, ["show", "board:tasks/café.md"]), /A's café[\s\S]*B's café/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── review fix 2 + note 3: deletion conflicts, BOTH directions ──────────────────

test("U3b deletion conflict (upstream deleted, local edited): deletion kept, yours exported, help points at doc write, re-create clears", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // A deletes the shared doc and pushes.
    await deleteBoardDoc(topo.a, "tasks/seed-two");
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    // B edits the SAME doc (uncommitted) — a modify/delete conflict on B's sync.
    await modifyBoardDoc(topo.b, "tasks/seed-two", { body: "# Seed two\n\nB's edit of a doc A deleted\n" });
    const localBytes = await readBoardFile(topo.b, "tasks/seed-two.md");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(result.err!.code, "CONFLICT");
    assert.ok(result.err!.message.includes("teammate's deletion kept"), `deletion framing in: ${result.err!.message}`);
    assert.ok(result.err!.message.includes("re-create with doc write"), "points at doc write");
    assert.ok(!result.err!.message.includes("reconcile with doc update"), "doc update would fail NOT_FOUND — never suggested");

    // REVIEW FIX 2: the help chain must NOT emit `doc update` for a doc whose file is gone.
    assert.ok(result.err!.help, "a re-create chain is offered");
    assert.ok(result.err!.help!.includes("doc write tasks/seed-two"), `help: ${result.err!.help}`);
    assert.ok(!result.err!.help!.includes("doc update"), "no doc-update chain for a deleted-upstream doc");

    // The deletion LANDED (keep-upstream = the file is gone), yours exported byte-identically.
    assert.notEqual(gitTry(topo.b.board, ["cat-file", "-e", "HEAD:tasks/seed-two.md"]).status, 0, "file gone at HEAD");
    const exportPath = exportPathFor(topo, homeB!, "tasks/seed-two.md");
    assert.equal(await readFile(exportPath, "utf8"), localBytes, "export byte-identical to the local version");
    const rows = (result.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    assert.equal(rows[0]!.theirs, "kept (deleted upstream)");
    assert.equal(rows[0]!.yours, exportPath);
    const bodyExportPath = exportPath.replace(/\.md$/, ".body.md");
    assert.equal(rows[0]!.yours_body, bodyExportPath, "the body-only companion rides the row");
    assert.ok(
      result.err!.help!.includes(`--body-file ${rendered(bodyExportPath)}`),
      `the chain consumes the BODY export (round-2 REQUIRED 3): ${result.err!.help}`,
    );
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after upstream-deletion converge");

    // The re-create chain clears it: doc write over the BODY-ONLY export (a fresh doc) → sync
    // pushes, exit 0 — and the re-created doc's frontmatter is CLEAN (no nested YAML).
    const recreated = await runDoc([
      "write", "tasks/seed-two", "--type", "Task", "--title", "Seed two", "--body-file", bodyExportPath, "--dir", topo.b.board,
    ]);
    assert.equal(recreated.err, undefined, recreated.err?.message);
    const cleared = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(cleared.err, undefined, cleared.err?.message);
    const originDoc = git(topo.origin, ["show", "board:tasks/seed-two.md"]);
    assert.match(originDoc, /B's edit of a doc A deleted/);
    assert.equal(originDoc.split("---").length, 3, "exactly one frontmatter block — no YAML nested into the body");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("U3b deletion conflict (local deleted, upstream edited): teammate's version restored, honest nothing-to-save line, no help chain", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // A edits the shared doc and pushes.
    await modifyBoardDoc(topo.a, "tasks/seed-two", { body: "# Seed two\n\nA's edit of a doc B deleted\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    // B DELETES the same doc (uncommitted) — the inverted modify/delete conflict.
    await deleteBoardDoc(topo.b, "tasks/seed-two");

    const result = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(result.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(result.err!.code, "CONFLICT");
    assert.ok(
      result.err!.message.includes("teammate's version kept (your side deleted it; nothing to save)"),
      `honest nothing-to-save line in: ${result.err!.message}`,
    );
    // No stage-3 blob existed → nothing exportable → no help chain (the line carries the story).
    assert.equal(result.err!.help, undefined);

    // The teammate's version was RESTORED on the board; nothing to export.
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-two.md"]), /A's edit of a doc B deleted/);
    const rows = (result.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    assert.equal(rows[0]!.theirs, "kept");
    assert.equal(rows[0]!.yours, "deleted locally — nothing to save");
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after local-deletion converge");

    // Next sync is clean (B accepts the restoration) — nothing stranded.
    const next = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(next.err, undefined, next.err?.message);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── `sync --show-incoming <id>` — the conflict viewer matrix ────────────────────

test("show-incoming: an existing upstream doc renders parsed frontmatter + body, labeled as of last fetch", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  try {
    const result = await runSync(homeB!, ["--show-incoming", "tasks/seed-one", "--dir", topo.b.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /tasks\/seed-one/);
    assert.match(result.out, /Task/);
    assert.match(result.out, /Seed one/);
    assert.match(result.out, /seed body/);
    assert.ok(result.out.includes(SHOW_INCOMING_AS_OF), 'labeled "as of last fetch"');
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── review fix (item 7, tasks/sync-receipt-edge-polish): a reserved file never classifies as a
// doc, under ANY spelling — the guard is on the DERIVED path (the doc/delete + link idiom), so
// `log`, `log.md`, and nested `tasks/index.md` all render an honest `path:`, while a
// `.md`-suffixed NON-reserved doc id stays a parsed DOC exactly like `doc read` ────────────────

test("show-incoming: a reserved file renders `path:`, never `id:`, under every spelling; .md-spelled doc ids stay docs", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  try {
    await writeFile(path.join(topo.a.board, "log.md"), "- 2026-07-18T00:00:00.000Z mike wrote tasks/seed-one\n");
    commitBoard(topo.a, "board: seed log.md");
    pushBoard(topo.a);
    // A NESTED reserved file (index.md/log.md are reserved at ANY directory level, gate 2).
    await writeFile(path.join(topo.a.board, "tasks", "index.md"), "# nested reserved index\n");
    // A distinct ordinary concept at canonical id tasks/index.md also exists physically beside
    // it. The shorter `tasks/index.md` spelling must still mean the reserved path; the concept is
    // addressed explicitly as `tasks/index.md.md`.
    await writeFile(
      path.join(topo.a.board, "tasks", "index.md.md"),
      "---\ntype: Note\ntitle: Literal index.md concept\n---\n# Literal\n",
    );
    // Two adjacent levels in a `.md` identity chain pin the leading-`./` physical-path escape.
    await writeFile(
      path.join(topo.a.board, "tasks", "chain.md.md"),
      "---\ntype: Note\ntitle: Middle chain.md concept\n---\n# Middle\n",
    );
    await writeFile(
      path.join(topo.a.board, "tasks", "chain.md.md.md"),
      "---\ntype: Note\ntitle: Deep chain.md.md concept\n---\n# Deep\n",
    );
    commitBoard(topo.a, "board: seed nested tasks/index.md");
    pushBoard(topo.a);
    fetchBoard(topo.b);

    const rootLog = await runSync(homeB!, ["--show-incoming", "log.md", "--dir", topo.b.root]);
    assert.equal(rootLog.err, undefined, rootLog.err?.message);
    assert.match(rootLog.out, /^path: log\.md$/m, "reserved root file renders `path:`");
    assert.doesNotMatch(rootLog.out, /^id: log\.md$/m, "never `id: log.md` — no fabricated concept identity");
    assert.match(rootLog.out, /mike wrote tasks\/seed-one/, "raw content, no frontmatter parse attempted");

    const nestedIndex = await runSync(homeB!, ["--show-incoming", "tasks/index.md", "--dir", topo.b.root]);
    assert.equal(nestedIndex.err, undefined, nestedIndex.err?.message);
    assert.match(nestedIndex.out, /^path: tasks\/index\.md$/m, "a NESTED reserved file renders `path:` too");
    assert.doesNotMatch(nestedIndex.out, /^id: tasks\/index\.md$/m);

    const literalIndex = await runSync(homeB!, ["--show-incoming", "tasks/index.md.md", "--dir", topo.b.root]);
    assert.equal(literalIndex.err, undefined, literalIndex.err?.message);
    assert.match(literalIndex.out, /^id: tasks\/index\.md$/m);
    assert.match(literalIndex.out, /Literal index\.md concept/);

    const bareChain = await runSync(homeB!, ["--show-incoming", "tasks/chain.md.md", "--dir", topo.b.root]);
    assert.equal(bareChain.err, undefined, bareChain.err?.message);
    assert.match(bareChain.out, /^id: tasks\/chain\.md\.md$/m, "bare spelling prefers the existing literal id");
    assert.match(bareChain.out, /Deep chain\.md\.md concept/);

    const physicalChain = await runSync(homeB!, ["--show-incoming", "./tasks/chain.md.md", "--dir", topo.b.root]);
    assert.equal(physicalChain.err, undefined, physicalChain.err?.message);
    assert.match(physicalChain.out, /^id: tasks\/chain\.md$/m, "leading ./ selects the exact physical path");
    assert.match(physicalChain.out, /Middle chain\.md concept/);

    // The BARE spelling resolves through the concept derivation to the same reserved file —
    // still raw, and the render names the file it actually read (`log.md`, not an input echo).
    const bareLog = await runSync(homeB!, ["--show-incoming", "log", "--dir", topo.b.root]);
    assert.equal(bareLog.err, undefined, bareLog.err?.message);
    assert.match(bareLog.out, /^path: log\.md$/m, "bare `log` renders the DERIVED reserved path");
    assert.doesNotMatch(bareLog.out, /^id: log$/m, "no fabricated concept identity via the bare spelling");
    assert.match(bareLog.out, /mike wrote tasks\/seed-one/);

    // A `.md`-suffixed NON-reserved doc id collapses onto its own path but stays a DOC — the
    // same classification `doc read tasks/seed-one.md` gives that spelling.
    const mdDoc = await runSync(homeB!, ["--show-incoming", "tasks/seed-one.md", "--dir", topo.b.root]);
    assert.equal(mdDoc.err, undefined, mdDoc.err?.message);
    assert.match(mdDoc.out, /^id: tasks\/seed-one$/m, ".md path alias renders the canonical id actually read");
    assert.doesNotMatch(mdDoc.out, /^path: tasks\/seed-one\.md$/m);
    assert.match(mdDoc.out, /Task/, "parsed frontmatter fields present");
    assert.match(mdDoc.out, /Seed one/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("show-incoming: a doc that is NEW upstream (never pulled locally) renders from the last-fetched ref", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await writeBoardDoc(topo.a, "notes/fresh", {
      frontmatter: { type: "Note", title: "Fresh from A", actor: "mike" },
      body: "# Fresh\n\nbrand new upstream\n",
    });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    // B FETCHES (adjudication G: the viewer itself never fetches) but never pulls into the board.
    fetchBoard(topo.b);
    assert.equal(gitTry(topo.b.board, ["cat-file", "-e", "HEAD:notes/fresh.md"]).status !== 0, true, "sanity: not on B's board yet");

    const result = await runSync(homeB!, ["--show-incoming", "notes/fresh", "--dir", topo.b.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /brand new upstream/);
    assert.match(result.out, /Fresh from A/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("show-incoming: absent upstream (deleted, or never pushed) is an EXPECTED STATE — exit 0, honest state string", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Deleted upstream: A deletes seed-two and pushes; B fetches.
    await deleteBoardDoc(topo.a, "tasks/seed-two");
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    fetchBoard(topo.b);

    const deleted = await runSync(homeB!, ["--show-incoming", "tasks/seed-two", "--dir", topo.b.root]);
    assert.equal(deleted.err, undefined, "deleted-upstream is a STATE, not a fatal");
    assert.ok(deleted.out.includes(SHOW_INCOMING_ABSENT_STATE), `state string in: ${deleted.out}`);

    // Never-pushed (a doc that only exists locally) reads the same honest absence.
    await writeBoardDoc(topo.b, "notes/local-only", {
      frontmatter: { type: "Note", title: "Local only", actor: "brian" },
      body: "# local\n",
    });
    const localOnly = await runSync(homeB!, ["--show-incoming", "notes/local-only", "--dir", topo.b.root]);
    assert.equal(localOnly.err, undefined);
    assert.ok(localOnly.out.includes(SHOW_INCOMING_ABSENT_STATE));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("show-incoming: --out <file> writes the raw upstream bytes; --out - streams bytes with the receipt on stderr", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  const outDir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-out-"));
  try {
    const upstream = git(topo.b.board, ["show", "refs/remotes/origin/board:tasks/seed-one.md"]);

    // --out <file>: raw bytes to disk, receipt on stdout.
    const outFile = path.join(outDir, "incoming.md");
    const toFile = await runSync(homeB!, ["--show-incoming", "tasks/seed-one.md", "--out", outFile, "--dir", topo.b.root]);
    assert.equal(toFile.err, undefined, toFile.err?.message);
    assert.equal(await readFile(outFile, "utf8"), upstream, "raw upstream bytes on disk");
    assert.match(toFile.out, /size_bytes/);
    assert.match(toFile.out, /id: tasks\/seed-one\b/, "receipt reports the canonical id actually read");

    // --out -: raw bytes on stdout's byte channel, receipt on STDERR, nothing else on stdout.
    const toStdout = await runSync(homeB!, ["--show-incoming", "tasks/seed-one.md", "--out", "-", "--dir", topo.b.root]);
    assert.equal(toStdout.err, undefined, toStdout.err?.message);
    assert.equal(toStdout.bytes.toString("utf8"), upstream, "byte stream is the raw doc");
    assert.equal(toStdout.out, "", "stdout carries ONLY the byte stream");
    assert.match(toStdout.errOut, /size_bytes/);
    assert.match(toStdout.errOut, /id: tasks\/seed-one\b/, "stream receipt reports the canonical id actually read");
  } finally {
    await cleanup();
    await rm(outDir, { recursive: true, force: true });
    await topo.cleanup();
  }
});

test("show-incoming: --body-out writes ONLY the parsed upstream body; '-' keeps stdout body-only", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  const outDir = await mkdtemp(path.join(tmpdir(), "superbee-show-incoming-body-out-"));
  try {
    const upstream = git(topo.b.board, ["show", "refs/remotes/origin/board:tasks/seed-one.md"]);
    const expectedBody = parseMarkdown(upstream, "tasks/seed-one.md").body;
    const expectedVersion = versionOfBytes(upstream);

    const outFile = path.join(outDir, "incoming-body.md");
    const toFile = await runSync(homeB!, [
      "--show-incoming", "tasks/seed-one", "--body-out", outFile, "--dir", topo.b.root,
    ]);
    assert.equal(toFile.err, undefined, toFile.err?.message);
    assert.equal(await readFile(outFile, "utf8"), expectedBody, "file contains the complete parsed body only");
    assert.doesNotMatch(await readFile(outFile, "utf8"), /^---$/m, "frontmatter is never embedded in the edit body");
    assert.match(toFile.out, /body_out:/);
    assert.match(toFile.out, /content_type: text\/markdown; charset=utf-8/);
    assert.ok(toFile.out.includes(expectedVersion), "receipt carries the incoming document's exact version");

    const toStdout = await runSync(homeB!, [
      "--show-incoming", "tasks/seed-one", "--body-out", "-", "--dir", topo.b.root,
    ]);
    assert.equal(toStdout.err, undefined, toStdout.err?.message);
    assert.equal(toStdout.bytes.toString("utf8"), expectedBody, "stdout byte channel contains only the parsed body");
    assert.equal(toStdout.out, "", "text stdout stays empty");
    assert.match(toStdout.errOut, /body_out: "-"/);
    assert.ok(toStdout.errOut.includes(expectedVersion));
  } finally {
    await cleanup();
    await rm(outDir, { recursive: true, force: true });
    await topo.cleanup();
  }
});

test("show-incoming: --body-out refuses raw and malformed incoming blobs and points at exact --out", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(1);
  const [homeB] = homes;
  const outDir = await mkdtemp(path.join(tmpdir(), "superbee-show-incoming-body-refusal-"));
  try {
    const raw = "- 2026-08-30T00:00:00.000Z mike wrote tasks/seed-one\n";
    const malformed = "---\ntype: [unclosed\n---\nbody that has no trustworthy boundary\n";
    const unterminated = "---\ntype: Note\ntitle: Missing close\n# Body that must not disappear\n";
    await writeFile(path.join(topo.a.board, "log.md"), raw);
    await writeFile(path.join(topo.a.board, "notes", "malformed.md"), malformed);
    await writeFile(path.join(topo.a.board, "notes", "unterminated.md"), unterminated);
    commitBoard(topo.a, "board: add raw and malformed show-incoming fixtures");
    pushBoard(topo.a);
    fetchBoard(topo.b);

    for (const [id, code, targetName] of [
      ["log.md", "USAGE", "raw-body.md"],
      ["notes/malformed", "RUNTIME", "malformed-body.md"],
      ["notes/unterminated", "RUNTIME", "unterminated-body.md"],
    ] as const) {
      const target = path.join(outDir, targetName);
      const result = await runSync(homeB!, ["--show-incoming", id, "--body-out", target, "--dir", topo.b.root]);
      assert.equal(result.err?.code, code);
      assert.match(result.err?.help ?? "", /--out <file>/, "refusal points at the exact-byte recovery channel");
      assert.equal(existsSync(target), false, "an unavailable body channel writes nothing");
    }

    const rawTarget = path.join(outDir, "malformed-raw.md");
    const rawResult = await runSync(homeB!, [
      "--show-incoming", "notes/malformed", "--out", rawTarget, "--dir", topo.b.root,
    ]);
    assert.equal(rawResult.err, undefined, rawResult.err?.message);
    assert.equal(await readFile(rawTarget, "utf8"), malformed, "--out remains exact for malformed documents");
  } finally {
    await cleanup();
    await rm(outDir, { recursive: true, force: true });
    await topo.cleanup();
  }
});

test("show-incoming: --body-out - reserves stdout before sync argument validation", async () => {
  const { homes, cleanup } = await tempHomes(1);
  try {
    const result = await runSync(homes[0]!, [
      "--show-incoming", "tasks/seed-one", "--body-out", "-", "--pull-only", "--dir", "/does/not/matter",
    ]);
    assert.equal(result.err?.code, "USAGE");
    assert.equal(result.err?.handled, true, "outer sync boundary already emitted the envelope");
    assert.equal(result.out, "", "text stdout stays reserved for body bytes even on an early error");
    assert.equal(result.bytes.byteLength, 0);
    assert.match(result.errOut, /code: USAGE/);
    assert.match(result.errOut, /--show-incoming and --pull-only cannot be combined/);
  } finally {
    await cleanup();
  }
});

test("show-incoming: no fetched origin/board ref returns the viewer-specific NO_UPSTREAM", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const lone = await mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-localonly-"));
  try {
    git(lone, ["init", "-b", "main"]);
    const result = await runSync(homes[0]!, ["--show-incoming", "tasks/seed-one", "--dir", lone]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "NO_UPSTREAM");
    assert.equal(result.err!.message, SHOW_INCOMING_NO_UPSTREAM);
    assert.match(result.err!.help ?? "", /--pull-only/, "the hint names the fetch path for shared boards");
  } finally {
    await cleanup();
    await rm(lone, { recursive: true, force: true });
  }
});

test("show-incoming: --out - routes an ERROR envelope to STDERR (stdout stays pure) and exits handled", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const lone = await mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-lone-"));
  try {
    // A repo with NO origin/board anywhere: the viewer's no-upstream error, in stream mode.
    git(lone, ["init", "-b", "main"]);
    const result = await runSync(homes[0]!, ["--show-incoming", "tasks/seed-one", "--out", "-", "--dir", lone]);
    assert.ok(result.err, "expected a thrown CliError");
    assert.equal(result.err!.code, "NO_UPSTREAM");
    assert.equal(result.err!.handled, true, "handled — the bin wrapper must not re-emit on stdout");
    assert.equal(result.out, "", "stdout stays pure");
    assert.equal(result.bytes.length, 0, "no bytes were streamed");
    assert.match(result.errOut, /NO_UPSTREAM/);
  } finally {
    await cleanup();
    await rm(lone, { recursive: true, force: true });
  }
});

test("show-incoming: a large upstream body TRUNCATES and points at the safe --body-out edit channel", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    const bigBody = `# Big\n\n${"x".repeat(5000)}\n`;
    await writeBoardDoc(topo.a, "notes/big", {
      frontmatter: { type: "Note", title: "Big", actor: "mike" },
      body: bigBody,
    });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    fetchBoard(topo.b);

    const result = await runSync(homeB!, ["--show-incoming", "notes/big", "--dir", topo.b.root]);
    assert.equal(result.err, undefined, result.err?.message);
    assert.match(result.out, /body_truncated/);
    assert.ok(!result.out.includes("x".repeat(2000)), "the full body never hits stdout");
    assert.match(result.out, /--body-out <path-outside-bundle>/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("show-incoming: usage guards — empty id, combinations, egress without --show-incoming, no repo", async () => {
  const { homes, cleanup } = await tempHomes(1);
  const plain = await mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-plain-"));
  try {
    const empty = await runSync(homes[0]!, ["--show-incoming", "  ", "--dir", plain]);
    assert.equal(empty.err?.code, "USAGE");

    const combined = await runSync(homes[0]!, ["--show-incoming", "tasks/x", "--pull-only", "--dir", plain]);
    assert.equal(combined.err?.code, "USAGE");

    const strayOut = await runSync(homes[0]!, ["--out", "somewhere.md", "--dir", plain]);
    assert.equal(strayOut.err?.code, "USAGE");

    const strayBodyOut = await runSync(homes[0]!, ["--body-out", "somewhere.md", "--dir", plain]);
    assert.equal(strayBodyOut.err?.code, "USAGE");

    const channels = await runSync(homes[0]!, [
      "--show-incoming", "tasks/x", "--out", "whole.md", "--body-out", "body.md", "--dir", plain,
    ]);
    assert.equal(channels.err?.code, "USAGE");

    const blankBodyOut = await runSync(homes[0]!, ["--show-incoming", "tasks/x", "--body-out", "", "--dir", plain]);
    assert.equal(blankBodyOut.err?.code, "USAGE");

    const noRepo = await runSync(homes[0]!, ["--show-incoming", "tasks/x", "--dir", plain]);
    assert.equal(noRepo.err?.code, "RUNTIME");
    assert.match(noRepo.err!.message, /not inside a git repository/);
  } finally {
    await cleanup();
    await rm(plain, { recursive: true, force: true });
  }
});

// ── round-2 REQUIRED 1: byte-safety — invalid-UTF-8 blobs round-trip exactly ────

test("U3b round-2 REQUIRED 1: an invalid-UTF-8 blob round-trips BYTE-IDENTICALLY through the conflict export AND show-incoming --out", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  const outDir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-u3b-bytes-"));
  try {
    // Two DIFFERENT blobs, both invalid UTF-8 (0xff / lone continuation bytes): a utf8-string
    // round-trip rewrites these to U+FFFD (and changes the byte length) — the corruption this
    // test pins closed.
    const blobA = Buffer.from([0x62, 0x6c, 0x6f, 0x62, 0x20, 0xff, 0xfe, 0x80, 0x0a]);
    const blobB = Buffer.from([0x62, 0x6c, 0x6f, 0x62, 0x20, 0xc0, 0xaf, 0x81, 0x0a]);
    assert.notEqual(Buffer.from(blobA.toString("utf8"), "utf8").compare(blobA), 0, "sanity: blobA is NOT utf8-round-trippable");

    // Both founders add the SAME raw path with different binary content (an add/add conflict).
    await writeFile(path.join(topo.a.board, "data.bin"), blobA);
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    await writeFile(path.join(topo.b.board, "data.bin"), blobB);
    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");

    // (a) The conflict export is the local blob's EXACT bytes.
    const exportPath = exportPathFor(topo, homeB!, "data.bin");
    assert.equal(Buffer.compare(await readFile(exportPath), blobB), 0, "(a) export byte-identical to the local blob");
    // ...and the kept (upstream) blob landed byte-identically in the worktree.
    assert.equal(Buffer.compare(await readFile(path.join(topo.b.board, "data.bin")), blobA), 0, "kept blob byte-identical to upstream");
    assertPristine(topo.b, "B after binary converge");

    // (b) show-incoming --out delivers the upstream blob's EXACT bytes — file and stdout modes.
    const outFile = path.join(outDir, "incoming.bin");
    const toFile = await runSync(homeB!, ["--show-incoming", "data.bin", "--out", outFile, "--dir", topo.b.root]);
    assert.equal(toFile.err, undefined, toFile.err?.message);
    assert.equal(Buffer.compare(await readFile(outFile), blobA), 0, "(b) --out <file> byte-identical");
    assert.match(toFile.out, new RegExp(`size_bytes: ${blobA.byteLength}`), "size_bytes computed from the Buffer");

    const toStdout = await runSync(homeB!, ["--show-incoming", "data.bin", "--out", "-", "--dir", topo.b.root]);
    assert.equal(toStdout.err, undefined, toStdout.err?.message);
    assert.equal(Buffer.compare(toStdout.bytes, blobA), 0, "(b) --out - streams the exact bytes");
    assert.equal(toStdout.out, "", "stdout carries ONLY the byte stream");
  } finally {
    await cleanup();
    await rm(outDir, { recursive: true, force: true });
    await topo.cleanup();
  }
});

test("U3b round-3 LOW 1+2: a doc that PARSES but does not utf8-round-trip gets NO body companion, NO verb suffix, NO chain", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Valid OKF frontmatter, but the BODY carries a raw invalid-UTF-8 byte: the blob PARSES after
    // a lossy decode (the bad byte becomes U+FFFD), yet its bytes do not round-trip — writing a
    // .body.md from the decode would silently corrupt the body the chain then applies.
    const fm = `---\ntype: Task\ntitle: Weird bytes\n---\n# Weird\n\n${"x".repeat(5000)}\n`;
    const blobA = Buffer.concat([Buffer.from(fm, "utf8"), Buffer.from([0x41, 0x20, 0xff, 0x0a])]);
    const blobB = Buffer.concat([Buffer.from(fm, "utf8"), Buffer.from([0x42, 0x20, 0xfe, 0x0a])]);
    assert.notEqual(Buffer.from(blobB.toString("utf8"), "utf8").compare(blobB), 0, "sanity: parses-but-non-roundtrippable");

    await writeFile(path.join(topo.a.board, "tasks/weird.md"), blobA);
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);

    await writeFile(path.join(topo.b.board, "tasks/weird.md"), blobB);
    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");

    // The FULL export stays byte-exact; the body companion is SKIPPED (LOW 2).
    const exportPath = exportPathFor(topo, homeB!, "tasks/weird.md");
    assert.equal(Buffer.compare(await readFile(exportPath), blobB), 0, "full export byte-identical");
    assert.equal(existsSync(exportPath.replace(/\.md$/, ".body.md")), false, "no corrupted .body.md is ever written");

    // No runnable artifact → no fixing-verb suffix on the line (LOW 1), no chain, no yours_body.
    assert.ok(conflicted.err!.message.includes("doc tasks/weird — teammate's version kept; yours saved at"), conflicted.err!.message);
    assert.ok(!conflicted.err!.message.includes("reconcile with doc update"), "no doc-update suffix without a body export");
    assert.equal(conflicted.err!.help, undefined, "no chain over a corrupted body");
    const rows = (conflicted.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    assert.equal(rows[0]!.id, "tasks/weird");
    assert.equal(rows[0]!.yours_body, undefined, "no body companion on the row");
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after non-roundtrippable converge");

    // The sibling viewer makes the same safety decision: no lossy decoded body channel, and its
    // default preview points at the byte-exact hatch instead of advertising --body-out.
    const bodyOut = await runSync(homeB!, ["--show-incoming", "tasks/weird", "--body-out", "-", "--dir", topo.b.root]);
    assert.equal(bodyOut.err?.code, "RUNTIME");
    assert.equal(bodyOut.out, "");
    assert.equal(bodyOut.bytes.byteLength, 0);
    assert.match(bodyOut.errOut, /not valid UTF-8/);
    assert.match(bodyOut.err?.help ?? "", /--out <file>/);

    const preview = await runSync(homeB!, ["--show-incoming", "tasks/weird", "--dir", topo.b.root]);
    assert.equal(preview.err, undefined, preview.err?.message);
    assert.match(preview.out, /--out <file>/);
    assert.doesNotMatch(preview.out, /--body-out/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── round-2 REQUIRED 2: dotted concept ids are docs, not raw paths ──────────────

test("U3b round-2 REQUIRED 2: a DOTTED doc id (notes/v1.2) conflicts as a DOC — labeled 'doc notes/v1.2', export + reconcile work", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // Seed the dotted-id doc on the shared board (A authors, pushes; B pulls).
    await writeBoardDoc(topo.a, "notes/v1.2", {
      frontmatter: { type: "Note", title: "Spec v1.2", actor: "mike" },
      body: "# v1.2\n\nbase\n",
    });
    const seeded = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(seeded.err, undefined, seeded.err?.message);
    const bPull = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(bPull.err, undefined, bPull.err?.message);

    // Diverge it on both sides.
    await modifyBoardDoc(topo.a, "notes/v1.2", { body: "# v1.2\n\nA's revision\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    await modifyBoardDoc(topo.b, "notes/v1.2", { body: "# v1.2\n\nB's revision\n" });
    const localBytes = await readBoardFile(topo.b, "notes/v1.2.md");

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");
    // The retired string-shape heuristic labeled this a raw path; the explicit discriminator
    // carried from resolution time labels it a DOC.
    assert.ok(conflicted.err!.message.includes("doc notes/v1.2 — teammate's version kept"), `doc label in: ${conflicted.err!.message}`);
    const rows = (conflicted.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    assert.equal(rows[0]!.id, "notes/v1.2", "reported under `id`, not `path`");
    assert.equal(rows[0]!.kind, "Note");

    // Export byte-identical; the chain (over the BODY export) reconciles and pushes clean.
    const exportPath = exportPathFor(topo, homeB!, "notes/v1.2.md");
    assert.equal(await readFile(exportPath, "utf8"), localBytes);
    assert.ok(conflicted.err!.help!.includes("doc update notes/v1.2 --body-file"), "the doc-update chain names the dotted id");

    // show-incoming prefers the CONCEPT interpretation for the dotted id.
    const incoming = await runSync(homeB!, ["--show-incoming", "notes/v1.2", "--dir", topo.b.root]);
    assert.equal(incoming.err, undefined, incoming.err?.message);
    assert.match(incoming.out, /A's revision/);
    assert.match(incoming.out, /Spec v1\.2/, "parsed as a doc (frontmatter rendered), not a raw path");

    const mergedFile = path.join(homeB!, "v12-merged.md");
    await writeFile(mergedFile, "# v1.2\n\nA's revision\n\nB's revision\n");
    const updated = await runDoc(["update", "notes/v1.2", "--body-file", mergedFile, "--dir", topo.b.board]);
    assert.equal(updated.err, undefined, updated.err?.message);
    const cleared = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.equal(cleared.err, undefined, cleared.err?.message);
    assert.match(git(topo.origin, ["show", "board:notes/v1.2.md"]), /A's revision[\s\S]*B's revision/);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── round-2 REQUIRED 3: the emitted chain is LITERALLY executable ───────────────

/** Execute one emitted help-chain step EXACTLY as printed (prefix-checked, split on spaces). */
async function runChainStep(home: string, cwd: string, command: string): Promise<void> {
  const inv = cliInvocation();
  assert.ok(command.startsWith(`${inv} `), `chain step must start with the invocation verbatim: ${command}`);
  // Tokenise the way a shell would. Splitting on spaces keeps a rendered token's quotes in
  // the argv element, which on Windows makes the path unopenable — a harness failure that
  // reads exactly like the emitted chain being wrong.
  const argv = parseCommandLine(command.slice(inv.length + 1));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    await withHome(home, async () => {
      if (argv[0] === "sync") {
        await sync(argv.slice(1), { stdout: () => {}, stderr: () => {}, writeStdoutBytes: () => {} });
      } else if (argv[0] === "doc") {
        await doc(argv.slice(1), { stdout: () => {}, readStdin: async () => undefined });
      } else {
        assert.fail(`unexpected chain verb: ${argv[0]}`);
      }
    });
  } finally {
    process.chdir(prevCwd);
  }
}

test("U3b round-2 REQUIRED 3: the emitted help chain executes CHARACTER-FOR-CHARACTER — clean frontmatter, local frontmatter diff SURFACED", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    // A changes the body; B changes the body AND the frontmatter (a retitle) — the exact case
    // where a body-only reconcile would silently drop the local frontmatter change.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nA's body\n" });
    const aSync = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aSync.err, undefined, aSync.err?.message);
    await modifyBoardDoc(topo.b, "tasks/seed-one", {
      frontmatter: { title: "B's retitle" },
      body: "# Seed one\n\nB's body\n",
    });

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");

    // Constraint (b): the local frontmatter difference is SURFACED, never silently dropped.
    const rows = (conflicted.err!.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
    assert.ok(Array.isArray(rows[0]!.frontmatter_differs), `frontmatter_differs surfaced: ${JSON.stringify(rows[0])}`);
    assert.ok((rows[0]!.frontmatter_differs as string[]).includes("title"), "the retitle is named");

    // Constraint (a): execute the emitted chain EXACTLY as printed — every step, verbatim.
    const help = conflicted.err!.help!;
    const steps = help.split(" → ");
    assert.equal(steps.length, 3, `the chain has three steps: ${help}`);
    for (const step of steps) {
      await runChainStep(homeB!, topo.b.root, step);
    }

    // The chain cleared the conflict and pushed; the doc's frontmatter is CLEAN (no nested YAML).
    const originDoc = git(topo.origin, ["show", "board:tasks/seed-one.md"]);
    assert.equal(originDoc.split("---").length, 3, "exactly one frontmatter block — no YAML nested into the body");
    assert.match(originDoc, /B's body/, "the chain applied B's body on top");
    assert.ok(!/\n# Seed one[\s\S]*type:/.test(originDoc), "no frontmatter keys leaked into the body");
    // The kept title is upstream's ("Seed one") — the local retitle did NOT silently apply, and
    // that is exactly why the envelope surfaced it for an explicit re-apply.
    assert.match(originDoc, /title: Seed one/);
    assert.ok(!originDoc.includes("B's retitle"), "the local retitle is not silently merged");
    assertPristine(topo.b, "B after literal chain execution");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── converge speaks OWNERSHIP (research/atomic-shared-task-claim-design F7/F8, its test 8) ─────
//
// Losing a claim race is an ownership outcome, not a content divergence. These rows pin that the
// CONFLICT(5) terminal names the winner and the ref it was arbitrated at, and — the RED PROBE —
// that the envelope no longer prints the one command that takes the task back from that winner.

const OWNER_A = "anthropic/claude/agent-a";
const OWNER_B = "anthropic/claude/agent-b";

/**
 * The Task convention these rows install. `state_field` is the LOGICAL name, so the edition's real
 * `superbee_progress_status` coordinate has to be RESOLVED — a hardcoded field name would not
 * reach it.
 */
function taskConvention(declareClaim: boolean): { frontmatter: Record<string, unknown>; body: string } {
  return {
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      fields: {
        required: ["title", "superbee_progress_status"],
        optional: ["assignee", "description"],
        values: { superbee_progress_status: ["todo", "in_progress", "done", "canceled"] },
      },
      ...(declareClaim ? { claim: { owner_field: "assignee", state_field: "progress_status" } } : {}),
    },
    body: "# Task\n\nA unit of work.\n",
  };
}

/**
 * Publish a Task convention (with or without a `claim:` declaration) plus one claimable task from
 * clone A, then bring clone B up to date. Both clones then hold the SAME base — exactly the state
 * two agents race from.
 */
async function seedClaimableTask(
  topo: TwoCloneTopology,
  homeA: string,
  homeB: string,
  declareClaim: boolean,
): Promise<void> {
  await writeBoardDoc(topo.a, "conventions/task", taskConvention(declareClaim));
  await modifyBoardDoc(topo.a, "tasks/seed-one", {
    frontmatter: { superbee_progress_status: "todo" },
    body: "# Seed one\n\nseed body\n",
  });
  const seeded = await runSync(homeA, ["--dir", topo.a.root]);
  assert.equal(seeded.err, undefined, seeded.err?.message);
  const pulled = await runSync(homeB, ["--dir", topo.b.root, "--pull-only"]);
  assert.equal(pulled.err, undefined, pulled.err?.message);
}

/** A claim written the way the product documents one today: an unguarded owner/state patch. */
async function claimTask(repo: TwoCloneTopology["a"], owner: string, body?: string): Promise<void> {
  await modifyBoardDoc(repo, "tasks/seed-one", {
    frontmatter: {
      assignee: owner,
      superbee_progress_status: "in_progress",
      superbee_updated_by: owner,
    },
    ...(body ? { body } : {}),
  });
}

/** Everything the CONFLICT(5) envelope puts in front of the caller, as one searchable string. */
function emittedGuidance(err: CliError): string {
  return `${err.message}\n${err.help ?? ""}\n${JSON.stringify(err.details)}`;
}

function conflictRows(err: CliError): Array<Record<string, unknown>> {
  return (err.details as { conflicts: { rows: Array<Record<string, unknown>> } }).conflicts.rows;
}

test("claim converge: B loses the race — CONFLICT(5) rows carry claim_lost naming the upstream owner and the origin/board provenance", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);

    // A claims and publishes first; B claims the same task from the same base.
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);
    const arbitratedAt = originBoardHead(topo);

    await claimTask(topo.b, OWNER_B);
    const lost = await runSync(homeB!, ["--dir", topo.b.root]);

    assert.ok(lost.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(lost.err!.code, "CONFLICT");
    assert.equal(lost.err!.exitCode, 5);

    const row = conflictRows(lost.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row, `the contended task is reported: ${JSON.stringify(conflictRows(lost.err!))}`);
    assert.equal(
      row!.claim_lost,
      `owner is ${OWNER_A} as of origin/board@${arbitratedAt}; your claim was not arbitrated`,
      "the row names the recorded actor string verbatim and the ref it was arbitrated at",
    );
    assert.ok(
      lost.err!.message.includes(`claim_lost: tasks/seed-one — owner is ${OWNER_A}`),
      `the envelope message speaks ownership: ${lost.err!.message}`,
    );

    // Arbitration held: A's claim is what lives on the board, and B never pushed over it.
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), new RegExp(`assignee: ${OWNER_A}`));
    assert.equal(originBoardHead(topo), arbitratedAt, "origin still carries A's claim");
    assert.equal(isMidRebase(topo.b), false);
    assertPristine(topo.b, "B after a lost claim");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge RED PROBE: the lost-claim envelope emits NEITHER the owner field name NOR any doc update flag that would re-apply it", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);
    await claimTask(topo.b, OWNER_B);
    const bLocalBytes = await readBoardFile(topo.b, "tasks/seed-one.md");

    const lost = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(lost.err, "expected the CONFLICT(5) terminal envelope");
    const guidance = emittedGuidance(lost.err!);

    // The steal instruction is the owner field name reachable through a `doc update` flag. Neither
    // half may survive anywhere the caller reads: message, help, or rows.
    assert.ok(
      !guidance.includes("assignee"),
      `the declared owner field name must not appear anywhere in the envelope: ${guidance}`,
    );
    assert.ok(!guidance.includes("doc update"), `no doc update chain is offered: ${guidance}`);
    assert.equal(lost.err!.help, undefined, "a claim-only conflict is offered no reconcile chain at all");

    const row = conflictRows(lost.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);
    assert.equal(row!.frontmatter_differs, undefined, "no re-apply list survives for a claim-only conflict");
    assert.equal(row!.yours_body, undefined, "the body-merge input is not named — there is no body to merge");
    // The local bytes stay recoverable: withdrawing the steal never withdraws the evidence.
    assert.equal(row!.yours, exportPathFor(topo, homeB!, "tasks/seed-one.md"));
    assert.equal(await readFile(row!.yours as string, "utf8"), bLocalBytes, "B's losing claim is exported byte-identically");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge: a MIXED conflict keeps the body reconcile chain while the claim fields stay suppressed", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);
    const arbitratedAt = originBoardHead(topo);

    // B claims AND rewrites the body and the title — a real content divergence beside the race.
    await claimTask(topo.b, OWNER_B, "# Seed one\n\nB's genuinely different body.\n");
    await modifyBoardDoc(topo.b, "tasks/seed-one", { frontmatter: { title: "B's retitle" } });

    const lost = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(lost.err, "expected the CONFLICT(5) terminal envelope");
    const row = conflictRows(lost.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);

    assert.equal(
      row!.claim_lost,
      `owner is ${OWNER_A} as of origin/board@${arbitratedAt}; your claim was not arbitrated`,
      "ownership is still reported for the claim half",
    );
    const differs = row!.frontmatter_differs as string[];
    assert.ok(
      Array.isArray(differs) && differs.includes("title"),
      `the ordinary field keeps today's guidance: ${JSON.stringify(row)}`,
    );
    assert.ok(!differs.includes("assignee"), "the declared owner field is never offered for re-application");
    assert.equal(row!.yours_body, exportPathFor(topo, homeB!, "tasks/seed-one.body.md"));

    // The body-merge chain is still offered — and still runnable — because a body really diverged.
    const help = lost.err!.help;
    assert.ok(help, "the mixed conflict keeps the reconcile chain for its body");
    assert.equal(
      help,
      convergeHelp(cliInvocation(), "tasks/seed-one", exportPathFor(topo, homeB!, "tasks/seed-one.body.md")),
    );
    assert.ok(!help!.includes("assignee"), "the chain never carries the owner field");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge: a STATE-ONLY divergence is not a lost claim — the ordinary report is kept in full (review F-1)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);

    // One owner, agreed by both sides. Only the workflow STATE diverges — nobody's ownership is
    // contested, so this is an ordinary content conflict and must be reported as one.
    await claimTask(topo.a, OWNER_A);
    const claimed = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(claimed.err, undefined, claimed.err?.message);
    const synced = await runSync(homeB!, ["--dir", topo.b.root, "--pull-only"]);
    assert.equal(synced.err, undefined, synced.err?.message);

    await modifyBoardDoc(topo.a, "tasks/seed-one", { frontmatter: { superbee_progress_status: "done" } });
    const advanced = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(advanced.err, undefined, advanced.err?.message);
    await modifyBoardDoc(topo.b, "tasks/seed-one", { frontmatter: { superbee_progress_status: "canceled" } });

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    const row = conflictRows(conflicted.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);

    assert.equal(row!.claim_lost, undefined, "no claim was made, so none was lost");
    assert.ok(!conflicted.err!.message.includes("claim_lost"), "and none is asserted in the message");
    assert.ok(
      (row!.frontmatter_differs as string[]).includes("superbee_progress_status"),
      `the diverging state field keeps its ordinary guidance: ${JSON.stringify(row)}`,
    );
    assert.equal(row!.yours_body, exportPathFor(topo, homeB!, "tasks/seed-one.body.md"));
    assert.equal(
      conflicted.err!.help,
      convergeHelp(cliInvocation(), "tasks/seed-one", exportPathFor(topo, homeB!, "tasks/seed-one.body.md")),
      "the reconcile chain is still offered — there is a real divergence to reconcile",
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge: a MULTI-STOP rebase still withdraws the steal advice and attributes to origin/board (review F-2)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);
    const arbitratedAt = originBoardHead(topo);

    // B stacks TWO commits: the losing claim, then a clean body append far from the frontmatter.
    // The second replays cleanly ON TOP of the kept-upstream version, so the board's HEAD blob is
    // no longer origin/board's — the case where the report used to degrade and re-advertise the steal.
    await claimTask(topo.b, OWNER_B);
    commitBoard(topo.b, "board: bob claims seed-one", { author: { name: "bob", email: "bob@example.invalid" } });
    await modifyBoardDoc(topo.b, "tasks/seed-one", {
      body: "# Seed one\n\nseed body\n\nA later paragraph, far from the frontmatter.\n",
    });
    commitBoard(topo.b, "board: bob appends to seed-one", { author: { name: "bob", email: "bob@example.invalid" } });

    const lost = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(lost.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(lost.err!.code, "CONFLICT");

    // The board's HEAD really did move past origin/board for this path — the topology under test.
    assert.notEqual(
      git(topo.b.board, ["rev-parse", "HEAD:tasks/seed-one.md"]).trim(),
      git(topo.b.board, ["rev-parse", "refs/remotes/origin/board:tasks/seed-one.md"]).trim(),
      "the later local commit replayed on top — the kept blob is not origin/board's",
    );

    const guidance = emittedGuidance(lost.err!);
    assert.ok(
      !guidance.includes("assignee"),
      `suppression does not depend on attributability: ${guidance}`,
    );
    const row = conflictRows(lost.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);
    assert.ok(
      !(row!.frontmatter_differs as string[] | undefined)?.includes("assignee"),
      `the owner field is never offered for re-application: ${JSON.stringify(row)}`,
    );
    // Attribution survives too, because it is read from the arbiter itself rather than from HEAD.
    assert.equal(
      row!.claim_lost,
      `owner is ${OWNER_A} as of origin/board@${arbitratedAt}; your claim was not arbitrated`,
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

/**
 * Rewrite the contended task WITHOUT an owner — a release. `modifyBoardDoc` merges, so it can
 * never remove a key; the release has to author the whole frontmatter.
 */
async function releaseTask(repo: TwoCloneTopology["a"], owner: string, assignee?: unknown): Promise<void> {
  await writeBoardDoc(repo, "tasks/seed-one", {
    frontmatter: {
      type: "Task",
      title: "Seed one",
      actor: "mike",
      superbee_progress_status: "todo",
      superbee_updated_by: owner,
      ...(assignee !== undefined ? { assignee } : {}),
    },
    body: "# Seed one\n\nseed body\n",
  });
}

/** Land `owner`'s claim on the shared board so a takeover has something to take over. */
async function establishOwner(
  topo: TwoCloneTopology,
  homeA: string,
  homeB: string,
  owner: string,
): Promise<void> {
  await claimTask(topo.a, owner);
  const claimed = await runSync(homeA, ["--dir", topo.a.root]);
  assert.equal(claimed.err, undefined, claimed.err?.message);
  const pulled = await runSync(homeB, ["--dir", topo.b.root, "--pull-only"]);
  assert.equal(pulled.err, undefined, pulled.err?.message);
}

test("claim converge A1: a RELEASE that loses to a takeover still withdraws the steal advice, and is never told it lost a claim (review N-1)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);
    await establishOwner(topo, homeA!, homeB!, OWNER_B);

    // A takes the task over upstream; B, from the same base, RELEASES its own claim locally.
    // A release is an ownership write like any other — the steal route must close for it too.
    await claimTask(topo.a, OWNER_A);
    const takeover = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(takeover.err, undefined, takeover.err?.message);
    await releaseTask(topo.b, OWNER_B);

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");

    // SUPPRESSION applies — it does not depend on what this side's owner value happens to be.
    const guidance = emittedGuidance(conflicted.err!);
    assert.ok(!guidance.includes("assignee"), `the steal route is closed for a release too: ${guidance}`);
    const row = conflictRows(conflicted.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);
    assert.ok(
      !(row!.frontmatter_differs as string[] | undefined)?.includes("assignee"),
      `the owner field is never offered for re-application: ${JSON.stringify(row)}`,
    );

    // ATTRIBUTION does not — the releaser gave its claim up deliberately and must not be told it
    // lost one. The choice pinned here is SILENCE, not a reworded sentence: a release and a side
    // that merely predates someone else's claim are indistinguishable without the merge base.
    assert.equal(row!.claim_lost, undefined, "no claim-loss sentence for a side that holds no claim");
    assert.ok(!conflicted.err!.message.includes("claim_lost"));
    assert.ok(!guidance.includes("your claim was not arbitrated"));

    // Arbitration still held: A owns it upstream.
    assert.match(git(topo.b.board, ["show", "HEAD:tasks/seed-one.md"]), new RegExp(`assignee: ${OWNER_A}`));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge A2: a NON-SCALAR local owner withdraws the steal advice without crashing or naming a claim (review N-1)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);
    await establishOwner(topo, homeA!, homeB!, OWNER_B);

    await claimTask(topo.a, OWNER_A);
    const takeover = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(takeover.err, undefined, takeover.err?.message);
    // A list is not an actor string. It must not read as an owner, and it must not throw.
    await releaseTask(topo.b, OWNER_B, [OWNER_B, "someone-else"]);

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope — not a crash");
    assert.equal(conflicted.err!.code, "CONFLICT");

    const guidance = emittedGuidance(conflicted.err!);
    assert.ok(!guidance.includes("assignee"), `the steal route is closed: ${guidance}`);
    const row = conflictRows(conflicted.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);
    assert.equal(row!.claim_lost, undefined, "a non-scalar is not an actor string, so no claim is named");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge: a side that never recorded an owner has the advice withdrawn but is told nothing about a claim (review N-1)", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, true);

    // A claims an unowned task. B, still on the pre-claim base, only moves the workflow state —
    // it never writes an owner. The owner field DOES diverge (absent vs A), so the advice goes;
    // B has no claim to have lost, so no sentence is asserted about one.
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);
    await modifyBoardDoc(topo.b, "tasks/seed-one", { frontmatter: { superbee_progress_status: "blocked" } });

    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    const row = conflictRows(conflicted.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);

    const guidance = emittedGuidance(conflicted.err!);
    assert.ok(!guidance.includes("assignee"), `the steal route is closed: ${guidance}`);
    assert.equal(row!.claim_lost, undefined, "B made no claim, so B is told of none");
    assert.ok(!conflicted.err!.message.includes("claim_lost"));

    // The suppressed-and-unattributed line: kept upstream, your bytes saved, and no fixing verb —
    // the chain is not offered for a conflict whose only divergence is withdrawn.
    assert.equal(
      conflicted.err!.help,
      undefined,
      "no reconcile chain is offered when every remaining divergence is a withdrawn claim field",
    );
    assert.ok(
      conflicted.err!.message.includes(
        `doc tasks/seed-one — teammate's version kept; yours saved at ${exportPathFor(topo, homeB!, "tasks/seed-one.md")}`,
      ),
      `the line states the disposition without a verb: ${conflicted.err!.message}`,
    );
    assert.ok(!conflicted.err!.message.includes("reconcile with doc update"));
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("claim converge REGRESSION LOCK: a kind with NO claim declaration reports exactly as it did before", async () => {
  const topo = await makeTwoCloneTopology();
  const { homes, cleanup } = await tempHomes(2);
  const [homeA, homeB] = homes;
  try {
    await seedClaimableTask(topo, homeA!, homeB!, false);
    await claimTask(topo.a, OWNER_A);
    const aClaim = await runSync(homeA!, ["--dir", topo.a.root]);
    assert.equal(aClaim.err, undefined, aClaim.err?.message);

    await claimTask(topo.b, OWNER_B);
    const conflicted = await runSync(homeB!, ["--dir", topo.b.root]);
    assert.ok(conflicted.err, "expected the CONFLICT(5) terminal envelope");
    assert.equal(conflicted.err!.code, "CONFLICT");

    const row = conflictRows(conflicted.err!).find((r) => r.id === "tasks/seed-one");
    assert.ok(row);
    assert.equal(row!.claim_lost, undefined, "no ownership vocabulary without a declaration");
    assert.ok(!conflicted.err!.message.includes("claim_lost"), "no ownership vocabulary in the message");
    assert.ok(
      (row!.frontmatter_differs as string[]).includes("assignee"),
      `the owner field stays an ordinary divergence: ${JSON.stringify(row)}`,
    );
    assert.equal(row!.yours_body, exportPathFor(topo, homeB!, "tasks/seed-one.body.md"));
    assert.equal(row!.theirs, "kept");
    assert.equal(
      conflicted.err!.help,
      convergeHelp(cliInvocation(), "tasks/seed-one", exportPathFor(topo, homeB!, "tasks/seed-one.body.md")),
      "the pre-claim reconcile chain is unchanged",
    );
    assert.ok(
      conflicted.err!.message.includes(
        `doc tasks/seed-one — teammate's version kept; yours saved at ${exportPathFor(topo, homeB!, "tasks/seed-one.md")} — reconcile with doc update`,
      ),
      `the pre-claim per-doc line is unchanged: ${conflicted.err!.message}`,
    );
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});
