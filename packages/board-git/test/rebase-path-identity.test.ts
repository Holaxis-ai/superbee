// The board's rebases treat a document's path as its identity, in every state a rebase can reach:
// the first replay, a replay after `--continue`, and a replay after `--skip`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchRebase, fetchRebaseResolving } from "../src/index.js";
import {
  commitBoard,
  deleteBoardDoc,
  fetchBoard,
  git,
  gitTry,
  makeTwoCloneTopology,
  modifyBoardDoc,
  pushBoard,
  readBoardFile,
  writeBoardDoc,
  type BoardRepo,
  type TwoCloneTopology,
} from "./git-harness.js";

const BODY = "line0\nline1\nline2\nline3\nline4\nline5\n";
const FIXTURES = ["notes/first", "notes/empties", "notes/last"];
const note = (title: string, body = BODY) => ({ frontmatter: { type: "Note", title, actor: "suite" }, body });

/** Both clones hold every fixture document; clone A then appends TEAM words to each and pushes. */
async function teammateEditsAll(topo: TwoCloneTopology): Promise<void> {
  for (const id of FIXTURES) await writeBoardDoc(topo.a, id, note(id));
  commitBoard(topo.a, "fixtures");
  pushBoard(topo.a);
  git(topo.b.board, ["pull", "--ff-only", "origin", "board"]);
  for (const id of FIXTURES) await modifyBoardDoc(topo.a, id, { body: `${BODY}TEAM ${id}\n` });
  commitBoard(topo.a, "teammate edits");
  pushBoard(topo.a);
}

async function renameAndCommit(repo: BoardRepo, from: string, to: string): Promise<void> {
  await writeBoardDoc(repo, to, note(to));
  await deleteBoardDoc(repo, from);
  commitBoard(repo, `rename ${from} to ${to}`);
}

test("fetchRebaseResolving: renames stay add+delete across --continue and --skip, even with a host merge.renames", async () => {
  const topo = await makeTwoCloneTopology();
  const exportDir = await mkdtemp(path.join(tmpdir(), "rebase-path-identity-"));
  try {
    await teammateEditsAll(topo);
    git(topo.b.board, ["config", "merge.renames", "true"]);
    await renameAndCommit(topo.b, "notes/first", "notes/first-moved");
    // Deleting and nothing else: keeping the teammate's version empties this commit, so `--skip`.
    await deleteBoardDoc(topo.b, "notes/empties");
    commitBoard(topo.b, "delete empties");
    await renameAndCommit(topo.b, "notes/last", "notes/last-moved");

    const outcome = fetchRebaseResolving(topo.b.board, exportDir);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") assert.fail("expected resolution");
    assert.deepEqual(outcome.conflicts.map((c) => c.relPath).sort(), FIXTURES.map((id) => `${id}.md`).sort());
    assert.ok(outcome.conflicts.every((c) => c.exportPath === null), "the local side deleted each; nothing to save");

    for (const id of FIXTURES) {
      assert.ok((await readBoardFile(topo.b, `${id}.md`)).includes(`TEAM ${id}`), `${id} keeps the teammate's words`);
    }
    for (const id of ["notes/first-moved", "notes/last-moved"]) {
      const moved = await readBoardFile(topo.b, `${id}.md`);
      assert.ok(moved.includes(`title: ${id}`), `${id} holds the local document`);
      assert.ok(!moved.includes("TEAM"), `${id} stayed the local version`);
    }
  } finally {
    await topo.cleanup();
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("fetchRebase: a rename crossing a teammate's edit reports the old path, the one that diverged", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await teammateEditsAll(topo);
    await renameAndCommit(topo.b, "notes/first", "notes/first-moved");
    const before = git(topo.b.board, ["rev-parse", "HEAD"]).trim();
    fetchBoard(topo.b);
    assert.deepEqual(fetchRebase(topo.b.board), { status: "conflict", conflictedDocIds: ["notes/first"] });
    assert.equal(git(topo.b.board, ["rev-parse", "HEAD"]).trim(), before, "detect-only abort restores HEAD");
  } finally {
    await topo.cleanup();
  }
});

test("fetchRebaseResolving: a teammate's rename keeps the local edit in a saved copy at the old path", async () => {
  const topo = await makeTwoCloneTopology();
  const exportDir = await mkdtemp(path.join(tmpdir(), "rebase-path-identity-"));
  try {
    await writeBoardDoc(topo.a, "notes/first", note("first"));
    commitBoard(topo.a, "fixture");
    pushBoard(topo.a);
    git(topo.b.board, ["pull", "--ff-only", "origin", "board"]);
    await renameAndCommit(topo.a, "notes/first", "notes/first-moved");
    pushBoard(topo.a);
    await modifyBoardDoc(topo.b, "notes/first", { body: `${BODY}LOCAL WORDS\n` });
    commitBoard(topo.b, "local edit");

    const outcome = fetchRebaseResolving(topo.b.board, exportDir);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") assert.fail("expected resolution");
    assert.deepEqual(outcome.conflicts.map((c) => c.relPath), ["notes/first.md"]);
    assert.ok((await readFile(outcome.conflicts[0]!.exportPath!, "utf8")).includes("LOCAL WORDS"), "the local words are saved");
    assert.notEqual(gitTry(topo.b.board, ["cat-file", "-e", "HEAD:notes/first.md"]).status, 0, "the teammate's removal stands");
    assert.ok((await readBoardFile(topo.b, "notes/first-moved.md")).includes("title: notes/first-moved"), "the teammate's new document stands");
  } finally {
    await topo.cleanup();
    await rm(exportDir, { recursive: true, force: true });
  }
});
