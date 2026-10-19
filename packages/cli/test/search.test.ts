import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeDoc } from "@superbee/core";
import { search } from "../src/commands/search.js";
import { CliError } from "../src/errors.js";

async function run(args: string[]) { let output = ""; await search([...args, "--json"], { stdout: (s) => { output += s; } }); return JSON.parse(output); }

test("search CLI pages filtered local text, shows facets, and sees unsent file edits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-search-"));
  try {
    const bundle = await initBundle(dir);
    for (let i = 0; i < 3; i++) await writeDoc(bundle, { id: `notes/${i}`, frontmatter: { type: "Note", title: "Alpha", tags: ["blue"] }, body: "alpha ".repeat(50) });
    const args = ["alpha", "--dir", dir, "--type", "Note", "--tag", "blue", "--prefix", "notes/", "--facets", "type,tags", "--limit", "1"];
    const first = await run(args);
    assert.equal(first.count, 3); assert.equal(first.shown, 1); assert.ok(first.next_cursor);
    assert.equal(first.docs.length, 1); assert.ok(first.docs[0].excerpt.length <= 81);
    assert.deepEqual(first.facets.type, [{ value: "Note", count: 3 }]);
    const second = await run([...args, "--cursor", first.next_cursor]);
    assert.notEqual(first.docs[0].id, second.docs[0].id);
    await writeFile(path.join(dir, "notes/0.md"), "---\ntype: Note\n---\nunsentneedle\n");
    assert.equal((await run(["unsentneedle", "--dir", dir])).count, 1);
    await assert.rejects(run([...args, "--cursor", first.next_cursor]), (e: unknown) => e instanceof CliError && e.code === "USAGE");
    assert.equal((await run(["nomatches", "--dir", dir])).count, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("search malformed inputs and remote refuse as usage before opening a folder", async () => {
  for (const args of [[], ["alpha", "extra"], ["!!!"], ["alpha", "--limit", "0"], ["alpha", "--limit", "51"], ["alpha", "--limit", "1.5"], ["alpha", "--prefix", "../"], ["alpha", "--facets", "kind"], ["alpha", "--cursor", "!"], ["alpha", "--remote", "http://127.0.0.1:1"]]) {
    await assert.rejects(run([...args, "--dir", "/does-not-exist-search"]), (e: unknown) => e instanceof CliError && e.code === "USAGE", JSON.stringify(args));
  }
});
