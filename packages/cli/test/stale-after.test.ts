import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, readDoc, writeDoc } from "@superbee/core";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { CliError } from "../src/errors.js";
import { CLI_COMMAND_GROUPS } from "../src/command-spec.js";

const INSTANT = "2026-09-07T12:34:56.123456789-06:00";
const COMMANDS = ["write", "update", "new"] as const;
type Command = typeof COMMANDS[number];

async function fixture(edition: "0.1" | "0.2" = "0.2") {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-stale-after-"));
  await initBundle(dir, { okfVersion: edition });
  await writeDoc({ root: dir }, {
    id: "conventions/note", frontmatter: {
      type: "Convention", governs: "Note", fields: { optional: ["title"] },
    }, body: "",
  });
  await writeDoc({ root: dir }, {
    id: "existing", frontmatter: { type: "Note", title: "Keep", stale_after: "opaque legacy date" }, body: "Keep body\n",
  });
  return dir;
}

async function run(command: Command, dir: string, flags: string[], id = command === "update" ? "existing" : "created") {
  const args = ["--dir", dir, "--actor", "test/stale-after", ...flags];
  const deps = { stdout: (_s: string) => {}, readStdin: async (): Promise<undefined> => { throw new Error("unexpected stdin read"); } };
  if (command === "new") await newCommand(["Note", id, ...args], deps);
  else await doc([command, id, ...(command === "write" ? ["--type", "Note", "--body", "Keep body\n"] : []), ...args], deps);
}

for (const command of COMMANDS) {
  test(`${command}: --stale-after accepts exact zoned instants without a Kind field`, async () => {
    const dir = await fixture();
    try {
      await run(command, dir, ["--stale-after", INSTANT]);
      const saved = await readDoc({ root: dir }, command === "update" ? "existing" : "created");
      assert.equal(saved.frontmatter.stale_after, INSTANT);
      if (command === "update") {
        assert.equal(saved.frontmatter.title, "Keep");
        assert.equal(saved.body, "Keep body\n");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test(`${command}: invalid or missing --stale-after refuses before writing`, async () => {
    const dir = await fixture();
    try {
      const before = await readFile(path.join(dir, "existing.md"), "utf8");
      for (const flags of [
        ["--stale-after", ""], ["--stale-after", "2026-09-07"],
        ["--stale-after", "2026-09-07T12:00:00"], ["--stale-after", "2026-02-30T12:00:00Z"],
        ["--stale-after", "bad"], ["--stale-after"], ["--stale-after", "--json"],
      ]) {
        await assert.rejects(run(command, dir, flags), (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.match(err.message, /stale-after/);
          return true;
        });
        assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
        await assert.rejects(readFile(path.join(dir, "created.md")), { code: "ENOENT" });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test(`${command}: explicit --stale-after rejects v0.1 without writing`, async () => {
    const dir = await fixture("0.1");
    try {
      const before = await readFile(path.join(dir, "existing.md"), "utf8");
      await assert.rejects(run(command, dir, ["--stale-after", INSTANT]), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /0\.2/);
        return true;
      });
      assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
      await assert.rejects(readFile(path.join(dir, "created.md")), { code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("update: absent --stale-after preserves opaque existing values in both editions", async () => {
  for (const edition of ["0.1", "0.2"] as const) {
    const dir = await fixture(edition);
    try {
      await run("update", dir, ["--title", "Changed"]);
      assert.equal((await readDoc({ root: dir }, "existing")).frontmatter.stale_after, "opaque legacy date");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("--stale-after is documented on all command and Kind help surfaces", async () => {
  const dir = await fixture();
  try {
    for (const args of [["write", "--help"], ["update", "--help"]]) {
      let output = "";
      await doc(args, { stdout: (s) => { output += s; } });
      assert.match(output, /--stale-after <iso>/);
      assert.match(output, /zone/);
    }
    for (const args of [["--help"], ["Note", "--help", "--dir", dir]]) {
      let output = "";
      await newCommand(args, { stdout: (s) => { output += s; } });
      assert.match(output, /--stale-after <iso>/);
      assert.match(output, /0\.2/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  for (const id of ["docWrite", "docUpdate", "new"]) {
    const usages = CLI_COMMAND_GROUPS.flatMap((group) => group.commands.filter((row) => row.id === id).map((row) => row.usage));
    assert.equal(usages.length, 1);
    assert.match(usages[0]!, /\[--stale-after <iso>\]/);
  }
});

test("new: reserved --stale-after is not interpreted twice by a colliding Kind field", async () => {
  const dir = await fixture();
  try {
    await writeDoc({ root: dir }, {
      id: "conventions/note", frontmatter: {
        type: "Convention", governs: "Note", fields: {
          required: ["stale-after"], optional: ["title"], values: { "stale-after": ["domain value"] },
        },
      }, body: "",
    });
    await run("new", dir, ["--stale-after", INSTANT]);
    const saved = await readDoc({ root: dir }, "created");
    assert.equal(saved.frontmatter.stale_after, INSTANT);
    assert.equal(Object.hasOwn(saved.frontmatter, "stale-after"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const command of ["new", "update"] as const) {
  test(`${command}: dedicated --stale-after satisfies a required stale_after Kind field and rejects duplicate coordinates`, async () => {
    const dir = await fixture();
    try {
      await writeDoc({ root: dir }, {
        id: "conventions/note", frontmatter: {
          type: "Convention", governs: "Note", fields: { required: ["stale_after"], optional: ["title"] },
        }, body: "",
      });
      const before = await readFile(path.join(dir, "existing.md"), "utf8");
      for (const flags of [
        ["--stale-after", INSTANT, "--stale_after", "invalid"],
        ["--stale_after", "invalid", "--stale-after", INSTANT],
      ]) {
        await assert.rejects(run(command, dir, flags), (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "USAGE");
          assert.match(err.message, /stale_after.*more than once/);
          return true;
        });
        assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
        await assert.rejects(readFile(path.join(dir, "created.md")), { code: "ENOENT" });
      }
      await run(command, dir, ["--stale-after", INSTANT]);
      assert.equal((await readDoc({ root: dir }, command === "update" ? "existing" : "created")).frontmatter.stale_after, INSTANT);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
