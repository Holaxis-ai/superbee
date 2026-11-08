// Classifying saved conflict copies reads every upstream version in one git call, so `status` on a
// board with many copies does not spawn git once per copy. The classification itself must match
// what reading each copy's upstream version on its own gives.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDocBytesAtRef, saveCopyWithBody } from "@superbee/board-git";
import { withIsolatedUserEnv } from "./support/user-env.js";
import { unsettledConflicts, type UnsettledConflict } from "../src/saved-conflicts.js";
import { bundleKey, syncExportsDir } from "../src/cursor.js";
import { deleteBoardDoc, makeTwoCloneTopology, modifyBoardDoc } from "../../board-git/test/git-harness.js";

const mine = (title: string): Buffer => Buffer.from(`---\ntype: Task\ntitle: ${title}\n---\n# ${title}\n\nmy words\n`);

/** Run `fn` with a `git` on PATH that records each invocation, and return how many there were. */
async function countingGit<T>(scratch: string, fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const log = path.join(scratch, "git-calls.log");
  const shim = path.join(scratch, "shim");
  await mkdir(shim, { recursive: true });
  const original = process.env.PATH ?? "";
  await writeFile(path.join(shim, "git"), `#!/bin/sh\necho x >> '${log}'\nPATH='${original}' exec git "$@"\n`);
  await chmod(path.join(shim, "git"), 0o755);
  process.env.PATH = `${shim}${path.delimiter}${original}`;
  try {
    const result = await fn();
    const calls = existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean).length : 0;
    return { result, calls };
  } finally {
    process.env.PATH = original;
  }
}

test("saved copies are classified with one upstream read, exactly as reading each copy alone", { skip: process.platform === "win32" }, async () => {
  const topo = await makeTwoCloneTopology();
  const home = await mkdtemp(path.join(tmpdir(), "sb-saved-batch-"));
  try {
    const board = topo.b.board;
    const key = bundleKey({ remoteUrl: topo.origin, subpath: "", checkoutRoot: board });
    const exportsDir = syncExportsDir(key, home);
    // tasks/seed-one: unchanged locally, so take. A second copy equal to the document is carried.
    saveCopyWithBody(exportsDir, "tasks/seed-one.md", mine("One"), true);
    saveCopyWithBody(exportsDir, "tasks/seed-one.md", await readFile(path.join(board, "tasks/seed-one.md")), true);
    // tasks/seed-two: edited locally, so revise.
    await modifyBoardDoc(topo.b, "tasks/seed-two", { body: "# Seed two\n\nlocal edit\n" });
    saveCopyWithBody(exportsDir, "tasks/seed-two.md", mine("Two"), true);
    // notes/welcome: deleted locally but upstream, so remove.
    await deleteBoardDoc(topo.b, "notes/welcome");
    saveCopyWithBody(exportsDir, "notes/welcome.md", mine("Welcome"), true);
    // A local document upstream lacks: revise. A document absent on both sides: take.
    await writeFile(path.join(board, "tasks/local-only.md"), mine("Local"));
    saveCopyWithBody(exportsDir, "tasks/local-only.md", mine("Local mine"), true);
    saveCopyWithBody(exportsDir, "tasks/gone.md", mine("Gone"), true);
    // A raw file, and a name with a space.
    saveCopyWithBody(exportsDir, "assets/raw.txt", Buffer.from("raw\n"), false);
    saveCopyWithBody(exportsDir, "tasks/with space.md", mine("Space"), true);
    // Enough further copies that one git call per copy would be unmistakable.
    for (let index = 0; index < 20; index++) saveCopyWithBody(exportsDir, `tasks/extra-${index}.md`, mine(`Extra ${index}`), true);

    const { result: unsettled, calls } = await withIsolatedUserEnv(home, () => countingGit(home, () => unsettledConflicts(board, key)));
    const shape = (rows: UnsettledConflict[]) =>
      rows.map((row) => ({ relPath: row.relPath, id: row.id, copies: row.copies.length, discardWith: row.discardWith, unreadable: row.unreadable ?? false }));
    assert.deepEqual(
      shape(unsettled).filter((row) => !row.relPath.startsWith("tasks/extra-")).sort((x, y) => x.relPath.localeCompare(y.relPath)),
      [
        { relPath: "assets/raw.txt", id: null, copies: 1, discardWith: "take", unreadable: false },
        { relPath: "notes/welcome.md", id: "notes/welcome", copies: 1, discardWith: "remove", unreadable: false },
        { relPath: "tasks/gone.md", id: "tasks/gone", copies: 1, discardWith: "take", unreadable: false },
        { relPath: "tasks/local-only.md", id: "tasks/local-only", copies: 1, discardWith: "revise", unreadable: false },
        { relPath: "tasks/seed-one.md", id: "tasks/seed-one", copies: 1, discardWith: "take", unreadable: false },
        { relPath: "tasks/seed-two.md", id: "tasks/seed-two", copies: 1, discardWith: "revise", unreadable: false },
        { relPath: "tasks/with space.md", id: "tasks/with space", copies: 1, discardWith: "take", unreadable: false },
      ],
    );

    // The same verdicts from reading each copy's upstream version on its own.
    for (const row of unsettled) {
      const current = existsSync(path.join(board, row.relPath)) ? await readFile(path.join(board, row.relPath)) : null;
      const upstream = readDocBytesAtRef(board, "refs/remotes/origin/board", row.relPath);
      const expected = current === null ? (upstream === null ? "take" : "remove") : upstream === null || !current.equals(upstream) ? "revise" : "take";
      assert.equal(row.discardWith, expected, row.relPath);
    }

    assert.equal(unsettled.filter((row) => row.relPath.startsWith("tasks/extra-") && row.discardWith === "take").length, 20);

    // One branch lookup, one batch read and the claim policy's own reads, however many copies there
    // are. Reading each copy on its own cost two or three git calls per copy, 59 here.
    assert.ok(calls <= 4, `expected at most 4 git calls for ${unsettled.length} files, saw ${calls}`);
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
