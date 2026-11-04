// Saved conflict copies never replace one another, including across racing processes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listSavedCopies, saveBodyCompanion, saveConflictCopy } from "../src/saved-copies.js";

async function scratch(): Promise<{ exportDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "sb-saved-copies-"));
  return { exportDir: path.join(root, "abc"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a repeat copy lands beside the first, an identical one adds nothing, and the list runs oldest first", async () => {
  const { exportDir, cleanup } = await scratch();
  try {
    const first = saveConflictCopy(exportDir, "tasks/a.md", Buffer.from("one"));
    assert.equal(first, path.join(exportDir, "tasks/a.md"));
    const second = saveConflictCopy(exportDir, "tasks/a.md", Buffer.from("two"));
    assert.notEqual(second, first);
    assert.equal(saveConflictCopy(exportDir, "tasks/a.md", Buffer.from("one")), first);
    assert.equal(await readFile(first, "utf8"), "one");
    assert.equal(await readFile(second, "utf8"), "two");
    assert.deepEqual(listSavedCopies(exportDir).map((copy) => copy.file), [first, second]);
  } finally {
    await cleanup();
  }
});

test("a dotted document id is never mistaken for a repeat copy of its neighbor", async () => {
  const { exportDir, cleanup } = await scratch();
  try {
    saveConflictCopy(exportDir, "notes/v1.md", Buffer.from("plain one"));
    saveConflictCopy(exportDir, "notes/v1.md", Buffer.from("plain two"));
    saveConflictCopy(exportDir, "notes/v1.2.md", Buffer.from("dotted"));
    assert.deepEqual(listSavedCopies(exportDir).map((copy) => copy.relPath).sort(), ["notes/v1.2.md", "notes/v1.md", "notes/v1.md"]);
  } finally {
    await cleanup();
  }
});

test("a slot left free by a settled copy is not reused ahead of a newer copy", async () => {
  const { exportDir, cleanup } = await scratch();
  try {
    const first = saveConflictCopy(exportDir, "a.md", Buffer.from("one"));
    const second = saveConflictCopy(exportDir, "a.md", Buffer.from("two"));
    await rm(first);
    const third = saveConflictCopy(exportDir, "a.md", Buffer.from("three"));
    assert.deepEqual(listSavedCopies(exportDir).map((copy) => copy.file), [second, third]);
  } finally {
    await cleanup();
  }
});

test("a raw file's copy is its own path, and a companion only pairs with the copy whose body it holds", async () => {
  const { exportDir, cleanup } = await scratch();
  try {
    const raw = saveConflictCopy(exportDir, "data.json", Buffer.from("{}"));
    assert.deepEqual(listSavedCopies(exportDir).map((copy) => [copy.file, copy.bodyFile]), [[raw, null]]);

    const doc = saveConflictCopy(exportDir, "a.md", Buffer.from("---\ntype: Note\n---\nmine\n"));
    const body = saveBodyCompanion(doc, "mine\n");
    assert.equal(listSavedCopies(exportDir).find((copy) => copy.relPath === "a.md")?.bodyFile, body);
    assert.equal(listSavedCopies(exportDir).some((copy) => copy.relPath === "a.body.md"), false);

    await rm(body!);
    await writeFile(body!, "---\ntype: Note\n---\nanother document\n");
    assert.equal(saveBodyCompanion(doc, "mine\n"), null, "what the path holds stays");
    assert.equal(await readFile(body!, "utf8"), "---\ntype: Note\n---\nanother document\n");
    assert.equal(listSavedCopies(exportDir).find((copy) => copy.relPath === "a.md")?.bodyFile, null);
    assert.equal(listSavedCopies(exportDir).some((copy) => copy.relPath === "a.body.md"), true);
  } finally {
    await cleanup();
  }
});

test("racing processes each keep their own copy", async () => {
  const { exportDir, cleanup } = await scratch();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(path.dirname(exportDir), "writer.mts");
  const racers = 8;
  try {
    await mkdir(path.dirname(exportDir), { recursive: true });
    await writeFile(
      script,
      `import { saveConflictCopy } from ${JSON.stringify(path.join(here, "../src/saved-copies.ts"))};\n` +
        `const start = Number(process.argv[3]);\nwhile (Date.now() < start) {}\n` +
        `saveConflictCopy(process.argv[2], "tasks/a.md", Buffer.from("racer " + process.argv[4]));\n`,
    );
    const start = Date.now() + 3000;
    const loader = path.join(here, "ts-loader.mjs");
    const exits = await Promise.all(
      Array.from({ length: racers }, (_, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, ["--import", loader, script, exportDir, String(start), String(index)], { stdio: "inherit" });
          child.on("close", resolve);
        }),
      ),
    );
    assert.deepEqual(exits, Array(racers).fill(0));
    const saved = await Promise.all(listSavedCopies(exportDir).map((copy) => readFile(copy.file, "utf8")));
    assert.deepEqual(saved.sort(), Array.from({ length: racers }, (_, index) => `racer ${index}`).sort());
    const leftovers = (await readdir(path.join(exportDir, "tasks"))).filter((name) => name.startsWith(".saving-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await cleanup();
  }
});
