import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "@superbee/server";
import { FilesystemBackend } from "../src/backend.js";
import { query, queryHeads } from "../src/engine.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { parseRecipeFiles } from "../src/recipes.js";
import { versionOfBytes } from "../src/versioning.js";

const clocks = [
  { scalar: "2026-01-02", value: "2026-01-02", legacy: "2026-01-02T00:00:00.000Z" },
  { scalar: "'2026-01-02'", value: "2026-01-02", legacy: "2026-01-02T00:00:00.000Z" },
  { scalar: "2026-01-02T03:04:05", value: "2026-01-02T03:04:05", legacy: "2026-01-02T03:04:05.000Z" },
  { scalar: "'2026-01-02T03:04:05'", value: "2026-01-02T03:04:05", legacy: "2026-01-02T03:04:05.000Z" },
  { scalar: "0", value: 0, legacy: "1970-01-01T00:00:00.000Z" },
];

for (const edition of [undefined, "0.1", "0.2"]) {
  test(`filesystem and server-backed remote preserve edition ${edition ?? "absent"} clock policy`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "superbee-clock-codec-"));
    try {
      if (edition) await writeFile(path.join(root, "index.md"), `---\nokf_version: '${edition}'\n---\n`);
      const backend = new FilesystemBackend(root);
      const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: createRouter({ root, backend }) });
      for (const [index, clock] of clocks.entries()) {
        const id = `clock-${index}`;
        const raw = `---\ntype: Note\ntimestamp: ${clock.scalar}\n---\nOriginal\n`;
        await writeFile(path.join(root, `${id}.md`), raw);
        for (const reader of [backend, remote]) {
          const read = await reader.read(id);
          assert.equal(read.doc.frontmatter.timestamp, edition === "0.2" ? clock.value : clock.legacy);
          assert.equal(read.version, versionOfBytes(raw));
        }
      }
      for (const reader of [backend, remote]) {
        const rows = await query(reader);
        const heads = await queryHeads(reader);
        assert.equal(rows.length, clocks.length);
        assert.deepEqual(rows.map((doc) => doc.frontmatter.timestamp), clocks.map((clock) => edition === "0.2" ? clock.value : clock.legacy));
        assert.deepEqual(heads.map((doc) => doc.frontmatter.timestamp), rows.map((doc) => doc.frontmatter.timestamp));
      }
      // A malformed sibling exercises the filesystem scan fallback without changing valid rows.
      await writeFile(path.join(root, "malformed.md"), "---\ntype: [\n---\n");
      const skipped: string[] = [];
      assert.equal((await query(backend, {}, { onSkip: (row) => skipped.push(row.id) })).length, clocks.length);
      assert.deepEqual(skipped, ["malformed"]);
      assert.equal((await queryHeads(backend, {}, { onSkip: () => {} }))[0].frontmatter.timestamp, edition === "0.2" ? clocks[0].value : clocks[0].legacy);
      // The adapter must observe a changed root edition, not retain a cached mode.
      await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n");
      assert.equal((await backend.read("clock-0")).doc.frontmatter.timestamp, clocks[0].value);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("structured memory reads retain their historical v0.1 values", async () => {
  const backend = new MemoryBackend();
  for (const [index, clock] of clocks.entries()) {
    const id = `clock-${index}`;
    await backend.write(id, { id, frontmatter: { type: "Note", timestamp: clock.value }, body: "" });
    assert.equal((await backend.read(id)).doc.frontmatter.timestamp, clock.value);
  }
});

test("recipe decoding offers lossless v0.2 definitions without changing standalone legacy defaults", () => {
  for (const clock of clocks) {
    const files = [
      { path: "recipe.md", bytes: "---\ntype: Recipe\nid: clock\ntitle: Clock\nversion: '1'\nsummary: Clock\ncontent_policy: definitions-only\npages:\n  - registry: views-registry/clock.md\n    entry: views/clock.html\nreferences:\n  - references/clock.md\n---\n" },
      { path: "conventions/note.md", bytes: `---\ntype: Convention\ntitle: Note\ngoverns: Note\ntimestamp: ${clock.scalar}\n---\n` },
      { path: "views-registry/clock.md", bytes: `---\ntype: View\ntitle: Clock\nentry: views/clock.html\naccess: none\ntimestamp: ${clock.scalar}\n---\n` },
      { path: "views/clock.html", bytes: "<!doctype html><title>Clock</title>" },
      { path: "references/clock.md", bytes: `---\ntype: Reference\ntitle: Clock\ntimestamp: ${clock.scalar}\n---\n` },
    ];
    for (const edition of [undefined, "0.1", "0.2"]) {
      const result = parseRecipeFiles(files, "fixture", { okfVersion: edition });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) {
        for (const doc of [result.recipe.docs[0], result.recipe.pages[0].registry, result.recipe.references[0].doc]) {
          assert.equal(doc.frontmatter.timestamp, edition === "0.2" ? clock.value : clock.legacy);
        }
      }
    }
  }
});


test("malformed root metadata retains legacy decoding, while root I/O errors still propagate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "superbee-clock-root-"));
  try {
    await writeFile(path.join(root, "index.md"), "---\nokf_version: [\n---\n");
    await writeFile(path.join(root, "note.md"), "---\ntype: Note\ntimestamp: 2026-01-02\n---\n");
    assert.equal((await new FilesystemBackend(root).read("note")).doc.frontmatter.timestamp, clocks[0].legacy);
    const ioError = Object.assign(new Error("denied root marker"), { code: "EACCES" });
    class UnreadableRootBackend extends FilesystemBackend {
      async readReserved(): Promise<never> { throw ioError; }
    }
    await assert.rejects(new UnreadableRootBackend(root).read("note"), (error) => error === ioError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
