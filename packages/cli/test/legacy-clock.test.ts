import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, readDoc, writeDoc, parseTimestamp } from "@superbee/core";
import { serve } from "@superbee/server";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { status } from "../src/commands/status.js";
import { CliError } from "../src/errors.js";

const INVALID = ["2026-09-08", "2026-09-08T12:30:00", "September 8, 2026", "2026-02-30T12:30:00Z", "", "   "];
const VALID = ["2026-09-08T12:30:00Z", "2026-09-08T12:30:00-06:00"];
type Command = "write" | "update" | "new";

async function fixture(edition: "0.1" | "0.2" = "0.2") {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-legacy-clock-"));
  const bundle = await initBundle(dir, { okfVersion: edition });
  await writeDoc(bundle, { id: "conventions/note", frontmatter: {
    type: "Convention", governs: "Note", fields: { optional: ["title", "timestamp"] },
  }, body: "" });
  // Imported clock deliberately bypasses normal create metadata to exercise no-op validation.
  await writeFile(path.join(dir, "existing.md"), '---\ntype: Note\ntitle: Keep\ntimestamp: "2026-09-08"\n---\nKeep body\n');
  return { dir, bundle };
}

async function run(command: Command, route: string[], timestamp: string, id = command === "update" ? "existing" : "created") {
  let output = "";
  const args = [...route, "--timestamp", timestamp, "--actor", "process:clock-test", "--json"];
  const deps = { stdout: (s: string) => { output += s; }, readStdin: async () => undefined };
  if (command === "new") await newCommand(["Note", id, ...args], deps);
  else await doc([command, id, ...(command === "write" ? ["--type", "Note", "--body", "Keep body\n"] : []), ...args], deps);
  return JSON.parse(output) as Record<string, unknown>;
}

for (const remote of [false, true]) {
  for (const command of ["write", "new"] as const) {
    test(`${command}: v0.2 raw legacy clock validates before normalization/no-op (${remote ? "remote" : "local"})`, async () => {
      const { dir, bundle } = await fixture();
      const server = remote ? await serve({ bundle, port: 0 }) : undefined;
      const route = server ? ["--remote", `http://${server.host}:${server.port}`] : ["--dir", dir];
      try {
        const before = await readFile(path.join(dir, "existing.md"), "utf8");
        for (const value of INVALID) {
          await assert.rejects(run(command, route, value), (err: unknown) => {
            assert.ok(err instanceof CliError);
            assert.equal(err.code, "USAGE");
            assert.match(err.message, /timestamp.*explicit UTC offset/);
            return true;
          }, `must refuse raw ${JSON.stringify(value)}`);
          assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
          await assert.rejects(readFile(path.join(dir, "created.md")), { code: "ENOENT" });
          if (command === "write") {
            await assert.rejects(run(command, route, value, "existing"), /timestamp/);
            assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
          }
        }
        for (const [index, value] of VALID.entries()) {
          const id = `valid-${index}`;
          const receipt = await run(command, route, value, id);
          assert.equal(receipt.id, id);
          const saved = await readDoc(bundle, id);
          assert.equal(Date.parse(String(saved.frontmatter.timestamp)), Date.parse(value));
          let readOutput = "";
          await doc(["read", id, ...route, "--json"], { stdout: (s) => { readOutput += s; } });
          assert.equal(Date.parse(String(JSON.parse(readOutput).timestamp)), Date.parse(value));
        }
      } finally {
        await server?.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

for (const command of ["write", "new"] as const) {
  test(`${command}: v0.1 legacy date-only compatibility stays available`, async () => {
    const { dir, bundle } = await fixture("0.1");
    try {
      const receipt = await run(command, ["--dir", dir], "2026-09-08");
      assert.ok(await readDoc(bundle, String(receipt.id)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("status: effective invalid legacy clocks are separate, bounded, edition-aware and read-only", async () => {
  for (const edition of ["0.1", "0.2"] as const) {
    const { dir, bundle } = await fixture(edition);
    const server = await serve({ bundle, port: 0 });
    try {
      const rows: Record<string, string> = {
        existing: 'timestamp: "2026-09-08"',
        blank: 'timestamp: ""',
        shadowed: 'timestamp: "2026-09-08"\ngenerated: {at: "2026-09-08T12:30:00Z"}',
        standard: 'timestamp: "2026-09-08"\ngenerated: {at: "invalid"}',
        absent: '',
        valid: 'timestamp: "2026-09-08T12:30:00-06:00"',
      };
      for (const [id, fields] of Object.entries(rows)) {
        await writeFile(path.join(dir, `${id}.md`), `---\ntype: Ungoverned\n${fields}\n---\nKeep body\n`);
      }
      const before = await Promise.all(Object.keys(rows).map((id) => readFile(path.join(dir, `${id}.md`), "utf8")));
      for (const route of [["--dir", dir], ["--remote", `http://${server.host}:${server.port}`]]) {
        let output = "";
        await status([...route, "--limit", "1", "--json"], { stdout: (s) => { output += s; } });
        const result = JSON.parse(output);
        if (edition === "0.2") {
          assert.equal(result.invalid_legacy_timestamps, 2);
          assert.equal(result.invalid_timestamps, 1);
          assert.equal(result.no_timestamp, 0);
          assert.equal(result.invalid_legacy_timestamp_fields.total, 2);
          assert.equal(result.invalid_legacy_timestamp_fields.shown, 1);
          assert.equal(result.invalid_legacy_timestamp_fields.rows[0].field, "timestamp");
          assert.match(result.invalid_legacy_timestamp_fields.help, /intended instant/);
        } else {
          assert.equal(result.invalid_legacy_timestamps, undefined);
          assert.equal(result.invalid_legacy_timestamp_fields, undefined);
        }
      }
      assert.deepEqual(await Promise.all(Object.keys(rows).map((id) => readFile(path.join(dir, `${id}.md`), "utf8"))), before);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

for (const edition of ["0.1", "0.2"] as const) {
  test(`update: ${edition} continues refusing Kind-declared timestamp assignment`, async () => {
    const { dir } = await fixture(edition);
    try {
      const before = await readFile(path.join(dir, "existing.md"), "utf8");
      for (const value of [...INVALID, ...VALID]) {
        await assert.rejects(run("update", ["--dir", dir], value), /timestamp.*managed metadata/);
        assert.equal(await readFile(path.join(dir, "existing.md"), "utf8"), before);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("legacy clock authoring and status help explain the edition-specific rule", async () => {
  const { dir } = await fixture();
  try {
    for (const [command, args] of [
      [doc, ["write", "--help"]],
      [newCommand, ["--help"]],
      [newCommand, ["Note", "--help", "--dir", dir]],
    ] as const) {
      let output = "";
      await command([...args], { stdout: (s) => { output += s; } });
      assert.match(output, /timestamp/);
      assert.match(output, /0\.2/);
      assert.match(output, /explicit UTC offset/);
    }
    let output = "";
    await status(["--help"], { stdout: (s) => { output += s; } });
    assert.match(output, /invalid_legacy_timestamps/);
    assert.match(output, /ungoverned/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const remote of [false, true]) {
  test(`write: repairing an imported date-only clock is substantive (${remote ? "remote" : "local"})`, async () => {
    const { dir, bundle } = await fixture();
    const server = remote ? await serve({ bundle, port: 0 }) : undefined;
    const route = server ? ["--remote", `http://${server.host}:${server.port}`] : ["--dir", dir];
    try {
      await writeFile(path.join(dir, "existing.md"), '---\ntype: Note\ntimestamp: "2026-09-08"\n---\nKeep body\n');
      const repaired = "2026-09-08T00:00:00Z";
      const receipt = await run("write", route, repaired, "existing");
      assert.equal(receipt.changed, true);
      assert.equal((await readDoc(bundle, "existing")).frontmatter.timestamp, repaired);
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const remote of [false, true]) {
  for (const command of ["write", "new"] as const) {
    test(`${command}: v0.2 hour-only offsets and equivalent no-ops (${remote ? "remote" : "local"})`, async () => {
      const { dir, bundle } = await fixture();
      const server = remote ? await serve({ bundle, port: 0 }) : undefined;
      const route = server ? ["--remote", `http://${server.host}:${server.port}`] : ["--dir", dir];
      try {
        for (const [suffix, expectedUtc] of [["+06", "2026-09-08T06:30:00Z"], ["-06", "2026-09-08T18:30:00Z"]]) {
          const value = `2026-09-08T12:30:00${suffix}`;
          const id = suffix === "+06" ? "positive" : "negative";
          await run(command, route, value, id);
          const saved = await readDoc(bundle, id);
          assert.equal(saved.frontmatter.timestamp, value);
          assert.equal(parseTimestamp(saved.frontmatter.timestamp, "0.2"), Date.parse(expectedUtc!));
          const before = await readFile(path.join(dir, `${id}.md`), "utf8");
          for (const equivalent of [`${value}:00`, value]) {
            let output = "";
            await doc(["write", id, "--type", "Note", "--body", saved.body, "--timestamp", equivalent,
              "--actor", "process:clock-test", "--json", ...route], { stdout: (s) => { output += s; } });
            assert.equal(JSON.parse(output).changed, false);
            assert.equal(await readFile(path.join(dir, `${id}.md`), "utf8"), before);
          }
        }
      } finally {
        await server?.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("write: v0.1 retains blank defaults, whitespace trimming, and legacy invalid-date errors", async () => {
  const { dir, bundle } = await fixture("0.1");
  try {
    for (const [index, value] of ["", "   ", " 2026-09-08T12:30:00Z "].entries()) {
      const id = `legacy-${index}`;
      await run("write", ["--dir", dir], value, id);
      const saved = await readDoc(bundle, id);
      assert.equal(typeof saved.frontmatter.timestamp, "string");
      assert.ok(Number.isFinite(Date.parse(String(saved.frontmatter.timestamp))));
      if (index === 2) assert.equal(Date.parse(String(saved.frontmatter.timestamp)), Date.parse(value.trim()));
    }
    for (const value of ["bad date", "2026-09-08T12:30:00+06", "2026-09-08T12:30:00-06"]) {
      await assert.rejects(run("write", ["--dir", dir], value), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /timestamp.*is not a valid date\/time/);
        assert.match(String(err.help), /doc write created --timestamp <iso>/);
        return true;
      });
      await assert.rejects(readFile(path.join(dir, "created.md")), { code: "ENOENT" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const remote of [false, true]) {
  test(`write: v0.2 validates trimmed inputs while preserving strict instant rules (${remote ? "remote" : "local"})`, async () => {
    const { dir, bundle } = await fixture();
    const server = remote ? await serve({ bundle, port: 0 }) : undefined;
    const route = server ? ["--remote", `http://${server.host}:${server.port}`] : ["--dir", dir];
    try {
      for (const [index, instant] of ["2026-09-08T12:30:00Z", "2026-09-08T12:30:00+06"].entries()) {
        const id = `trimmed-${index}`;
        assert.equal((await run("write", route, ` \n${instant}\t `, id)).changed, true);
        assert.equal((await readDoc(bundle, id)).frontmatter.timestamp, instant);
        const before = await readFile(path.join(dir, `${id}.md`), "utf8");
        const equivalent = instant.endsWith("Z") ? instant.replace(/Z$/, "+00:00") : `${instant}:00`;
        assert.equal((await run("write", route, ` \t${equivalent}\n`, id)).changed, false);
        assert.equal(await readFile(path.join(dir, `${id}.md`), "utf8"), before);
        for (const invalid of [" \n2026-09-08\t ", " \n2026-09-08T12:30:00\t ", " \t\n "]) {
          await assert.rejects(run("write", route, invalid, id), /timestamp.*explicit UTC offset/);
          assert.equal(await readFile(path.join(dir, `${id}.md`), "utf8"), before);
          await assert.rejects(run("write", route, invalid, "invalid"), /timestamp.*explicit UTC offset/);
          await assert.rejects(readFile(path.join(dir, "invalid.md")), { code: "ENOENT" });
        }
      }
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
