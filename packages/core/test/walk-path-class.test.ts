import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemBackend, classifyWalkPath, initBundle } from "../src/index.js";

// The class a watcher acts on must agree with what the walk actually returns, row by row.
const ROWS = [
  { file: "docs/a.md", walkClass: "markdown", listed: "doc" },
  { file: "scratch.log", walkClass: "other", listed: "blob" },
  { file: "views/board.html", walkClass: "other", listed: "blob" },
  { file: "shouted.MD", walkClass: "markdown", listed: null },
  { file: ".git/index", walkClass: "hidden", listed: null },
  { file: ".git/refs.md", walkClass: "hidden", listed: null },
  { file: "docs/.tmp-write", walkClass: "hidden", listed: null },
  { file: ".hidden/views/deep.html", walkClass: "hidden", listed: null },
] as const;

test("classifyChangedPath agrees with what the filesystem walk lists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-walk-class-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initBundle(root);
  for (const { file } of ROWS) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file.endsWith(".md") ? "---\ntype: Doc\n---\n" : "x");
  }
  const backend = new FilesystemBackend(root);
  const docs = await backend.list();
  const blobs = await backend.listBlobs();
  for (const { file, walkClass, listed } of ROWS) {
    assert.equal(backend.classifyChangedPath(file), walkClass, file);
    assert.equal(docs.includes(file.replace(/\.md$/u, "")), listed === "doc", `${file} as a document`);
    assert.equal(blobs.includes(file), listed === "blob", `${file} as a blob`);
  }
});

test("classifyWalkPath normalizes a Windows separator and leaves an empty path visible", () => {
  assert.equal(classifyWalkPath(".git\\index"), "hidden");
  assert.equal(classifyWalkPath("docs\\a.md"), "markdown");
  assert.equal(classifyWalkPath(""), "other");
});
