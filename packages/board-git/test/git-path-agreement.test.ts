import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { conceptIdFromPath } from "@superbee/core";
import {
  countUncommitted, fetchRebase, fetchRebaseResolving, isConceptDocPath,
  malformedOutgoingDocuments, privateStateInOutgoingWorktree, stageAndCommit, statusRows,
} from "../src/index.js";
import { commitBoard, git, makeTwoCloneTopology, pushBoard, type BoardRepo } from "./git-harness.js";

process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Path Suite";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "paths@example.invalid";

// One native-Git agreement table for every path projection. The final two rows distinguish
// spaces inside a concept path from trailing spaces on a raw (non-.md) filename.
const PATHS = [
  "notes/plain.md", "notes/café.md", "notes/tab\tname.md", "notes/line\nbreak.md",
  "notes/space /doc.md", "notes/raw.md ",
] as const;
const content = (side: string): string => `---\ntype: Note\ntitle: Path\nactor: paths\n---\n${side}\n`;
const entry = (file: string): string => isConceptDocPath(file) ? conceptIdFromPath(file) : file;
async function writePaths(repo: BoardRepo, bytes: string): Promise<void> {
  for (const file of PATHS) {
    await mkdir(path.dirname(path.join(repo.board, file)), { recursive: true });
    await writeFile(path.join(repo.board, file), bytes);
  }
}

test("path agreement: status, outgoing checks and commit retain native filenames", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writePaths(topo.a, content("base"));
    commitBoard(topo.a, "path base");
    await writePaths(topo.a, "---\ntitle: [unclosed\n---\nlocal\n");
    assert.deepEqual(statusRows(topo.a.board).map((row) => row.path).sort(), [...PATHS].sort());
    assert.equal(countUncommitted(topo.a.board), PATHS.length);
    assert.deepEqual(malformedOutgoingDocuments(topo.a.board).map((row) => row.relPath).sort(),
      PATHS.filter(isConceptDocPath).sort());
    await writePaths(topo.a, '{"product":"superbee","schema_version":1}\n');
    assert.deepEqual(privateStateInOutgoingWorktree(topo.a.board).map((row) => row.path).sort(), [...PATHS].sort());
    await writePaths(topo.a, content("local"));
    const committed = stageAndCommit(topo.a.board);
    assert.equal(committed.committed, true);
    assert.deepEqual(committed.docs.map((doc) => doc.docId).sort(), PATHS.filter(isConceptDocPath).map(entry).sort());
    for (const file of PATHS) assert.equal(git(topo.a.board, ["show", `HEAD:${file}`]), content("local"));
    assert.equal(countUncommitted(topo.a.board), 0);
  } finally { await topo.cleanup(); }
});

test("path agreement: detect-only and converging conflicts report the same identities", async () => {
  const topo = await makeTwoCloneTopology();
  const exports = await mkdtemp(path.join(tmpdir(), "board-path-exports-"));
  try {
    await writePaths(topo.a, content("base"));
    commitBoard(topo.a, "path base"); pushBoard(topo.a);
    git(topo.b.board, ["fetch", "origin"]);
    git(topo.b.board, ["merge", "--ff-only", "origin/board"]);
    await writePaths(topo.a, content("upstream"));
    commitBoard(topo.a, "upstream paths"); pushBoard(topo.a);
    await writePaths(topo.b, content("local"));
    const before = commitBoard(topo.b, "local paths");
    const detected = fetchRebase(topo.b.board);
    assert.equal(detected.status, "conflict");
    if (detected.status !== "conflict") assert.fail("expected conflicts");
    assert.deepEqual(detected.conflictedDocIds.sort(), PATHS.map(entry).sort());
    assert.equal(git(topo.b.board, ["rev-parse", "HEAD"]).trim(), before, "detect-only abort restores HEAD");
    const resolved = fetchRebaseResolving(topo.b.board, exports);
    assert.equal(resolved.status, "resolved");
    if (resolved.status !== "resolved") assert.fail("expected resolution");
    assert.deepEqual(resolved.conflicts.map((row) => row.entry).sort(), PATHS.map(entry).sort());
    for (const row of resolved.conflicts) {
      assert.equal(await readFile(row.exportPath!, "utf8"), content("local"));
      assert.equal(await readFile(path.join(topo.b.board, row.relPath), "utf8"), content("upstream"));
    }
  } finally { await topo.cleanup(); await rm(exports, { recursive: true, force: true }); }
});

test("path agreement: status preserves rename counts while outgoing and commit use path identities", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    const from = "notes/old\tname.md"; const to = "notes/new\nname.md";
    await writeFile(path.join(topo.a.board, from), content("same bytes"));
    commitBoard(topo.a, "rename base");
    git(topo.a.board, ["config", "status.renames", "true"]);
    git(topo.a.board, ["mv", "--", from, to]);
    assert.deepEqual(statusRows(topo.a.board), [{ status: "R", path: to, originalPath: from }]);
    assert.equal(countUncommitted(topo.a.board), 1, "awareness retains configured rename row count");
    await writeFile(path.join(topo.a.board, to), "---\ntitle: [unclosed\n---\nlocal\n");
    assert.deepEqual(malformedOutgoingDocuments(topo.a.board).map((row) => row.relPath), [to]);
    await writeFile(path.join(topo.a.board, to), '{"product":"superbee","schema_version":1}\n');
    assert.deepEqual(privateStateInOutgoingWorktree(topo.a.board).map((row) => row.path), [to]);
    await writeFile(path.join(topo.a.board, to), content("same bytes"));
    git(topo.a.board, ["config", "status.renames", "false"]);
    assert.deepEqual(statusRows(topo.a.board).sort((a, b) => a.path.localeCompare(b.path)),
      [{ status: "D", path: from }, { status: "A", path: to }].sort((a, b) => a.path.localeCompare(b.path)));
    assert.equal(countUncommitted(topo.a.board), 2, "disabled native rename detection retains two rows");
    assert.deepEqual(stageAndCommit(topo.a.board).docs.map((doc) => [doc.docId, doc.verb]).sort(),
      [[entry(from), "deleted"], [entry(to), "added"]].sort());
  } finally { await topo.cleanup(); }
});

test("status tolerance and ordinary untracked-directory count remain unchanged", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await mkdir(path.join(topo.a.board, "untracked"));
    await writeFile(path.join(topo.a.board, "untracked", "one.txt"), "one");
    await writeFile(path.join(topo.a.board, "untracked", "two.txt"), "two");
    assert.deepEqual(statusRows(topo.a.board), [{ status: "??", path: "untracked/" }]);
    assert.equal(countUncommitted(topo.a.board), 1);
    assert.deepEqual(statusRows(topo.dir), [], "ordinary nonzero status remains tolerated");
  } finally { await topo.cleanup(); }
});
