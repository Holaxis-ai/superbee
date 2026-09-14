import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, readDoc } from "@superbee/core";
import { promote } from "../src/commands/promote.js";

test("promote: generic frontmatter enforces timestamp offsets without partial writes", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-timestamp-authoring-"));
  const dir = path.join(scratch, "bundle");
  const source = path.join(scratch, "source.md");
  try {
    const bundle = await initBundle(dir, { okfVersion: "0.2" });
    const run = async (): Promise<Record<string, unknown>> => {
      let output = "";
      await promote([source, "--doc-key", "note.md", "--dir", dir, "--json"], {
        stdout: (value) => { output += value; },
      });
      return JSON.parse(output) as Record<string, unknown>;
    };
    await writeFile(source, "---\ntype: Note\nverified: {by: 'human:reader', at: '2026-09-08T12:30:00'}\n---\nBody.\n");
    await assert.rejects(run, /verified\.at.*explicit UTC offset/);
    await assert.rejects(() => readFile(path.join(dir, "note.md")), { code: "ENOENT" });

    const validAt = "2026-09-08T12:30:00-06:00";
    await writeFile(source, `---\ntype: Note\nverified: {by: 'human:reader', at: '${validAt}'}\n---\nBody.\n`);
    await run();
    assert.deepEqual((await readDoc(bundle, "note")).frontmatter.verified, { by: "human:reader", at: validAt });
    const before = await readFile(path.join(dir, "note.md"), "utf8");
    await writeFile(source, "---\ntype: Note\ngenerated: {at: '2026-09-08'}\n---\nChanged body.\n");
    await assert.rejects(run, /generated\.at.*explicit UTC offset/);
    assert.equal(await readFile(path.join(dir, "note.md"), "utf8"), before);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("promote: v0.2 imports preserve raw ambiguous legacy clocks and seed a usable standard clock", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-import-legacy-clock-"));
  const dir = path.join(scratch, "bundle");
  const source = path.join(scratch, "source.md");
  try {
    const bundle = await initBundle(dir, { okfVersion: "0.2" });
    for (const [index, value] of ["2026-09-08", "2026-09-08T12:30:00", "September 8, 2026", "2026-02-30T12:30:00Z", "", 1e20].entries()) {
      // Source scalars stay unchanged: parsing cannot infer a zone before edition policy runs.
      await writeFile(source, `---\ntype: Note\ntimestamp: ${JSON.stringify(value)}\n---\nBody.\n`);
      await promote([source, "--doc-key", `note-${index}.md`, "--dir", dir, "--json"], { stdout: () => {} });
      const saved = await readDoc(bundle, `note-${index}`);
      assert.equal(saved.frontmatter.timestamp, value);
      assert.equal(typeof (saved.frontmatter.generated as { at?: unknown } | undefined)?.at, "string");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
