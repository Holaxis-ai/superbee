/**
 * Byte-identity for bundles that declare no `fields.types`: `status`, `kinds` and `new "<Kind>"
 * --help` render exactly the bytes they rendered before Convention field types existed. The golden
 * files were captured from the parent commit's CLI on the same fixtures; a diff here is a contract
 * change for untyped bundles (AXI-CONTRACT, "Kind field types are additive"), not a fixture refresh.
 * The `kind-site-types-only` fixture carries `x_field_types` and `x_field_values`, which core ignores.
 * The write-path goldens run `doc update`, `doc field set` and `doc write` on a copy of that fixture
 * under a fixed clock and pin each receipt plus the resulting document bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { status } from "../src/commands/status.js";
import { kinds } from "../src/commands/kinds.js";
import { newCommand } from "../src/commands/new.js";
import { doc } from "../src/commands/doc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(here, "fixtures", "kind-field-types-golden");
const FIXTURES: Record<string, string> = {
  sample: path.resolve(here, "../../../examples/sample-bundle"),
  review: path.join(here, "fixtures", "review-workflow-legacy-v1"),
  "site-types": path.join(here, "fixtures", "kind-site-types-only"),
};
const noPull = async (): Promise<void> => {};

type Capture = (stdout: (s: string) => void, home: string) => Promise<void>;

const CASES: Array<{ golden: string; run: Capture }> = [];
for (const [name, dir] of Object.entries(FIXTURES)) {
  for (const json of [false, true]) {
    const flags = json ? ["--json"] : [];
    const suffix = json ? "json" : "toon";
    CASES.push({
      golden: `${name}.status.${suffix}`,
      run: (stdout, home) => status(["--dir", dir, ...flags], { stdout, autoPull: noPull, home }),
    });
    CASES.push({ golden: `${name}.kinds.${suffix}`, run: (stdout) => kinds(["--dir", dir, ...flags], { stdout }) });
  }
}
CASES.push({
  golden: "review.new-help.txt",
  run: (stdout) => newCommand(["Review Request", "--help", "--dir", FIXTURES.review!], { stdout }),
});
CASES.push({
  golden: "site-types.new-help.txt",
  run: (stdout) => newCommand(["Venue", "--help", "--dir", FIXTURES["site-types"]!], { stdout }),
});

for (const { golden, run } of CASES) {
  test(`golden: ${golden} is byte-identical for a bundle without fields.types`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "superbee-kind-golden-home-"));
    try {
      let out = "";
      await run((s) => (out += s), home);
      assert.equal(out, await readFile(path.join(GOLDEN_DIR, golden), "utf8"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

const WRITE_STEPS: Array<{ label: string; argv: string[]; file: string }> = [
  {
    label: "doc update",
    argv: ["update", "venues/riverside-hall", "--title", "Riverside Hall East", "--latitude", "44.2", "--topics", "history"],
    file: "venues/riverside-hall.md",
  },
  { label: "doc field set", argv: ["field", "set", "venues/riverside-hall", "website", "https://example.org/east"], file: "venues/riverside-hall.md" },
  { label: "doc field set", argv: ["field", "set", "venues/riverside-hall", "opened", "2020"], file: "venues/riverside-hall.md" },
  { label: "doc write", argv: ["write", "venues/new-hall", "--type", "Venue", "--title", "New Hall", "--body", "# New Hall\n"], file: "venues/new-hall.md" },
  { label: "doc write", argv: ["write", "venues/old-mill", "--type", "Venue", "--title", "Old Mill", "--body", "Rewritten.\n"], file: "venues/old-mill.md" },
];

test("golden: site-types.writes.txt — doc update, doc field set and doc write are byte-identical without fields.types", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T12:00:00.000Z") });
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-kind-golden-writes-"));
  try {
    await cp(FIXTURES["site-types"]!, dir, { recursive: true });
    const deps = { readStdin: async () => undefined };
    let transcript = "";
    for (const { label, argv, file } of WRITE_STEPS) {
      let out = "";
      try {
        await doc([...argv, "--dir", dir, "--actor", "human:golden", "--json"], { ...deps, stdout: (s: string) => (out += s) });
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        out = `refused ${failure.code}: ${failure.message}\n`;
      }
      transcript += `## ${label} ${argv.slice(1).join(" ")}\n${out}--- ${file}\n${await readFile(path.join(dir, file), "utf8")}\n`;
    }
    assert.equal(transcript.split(dir).join("<dir>"), await readFile(path.join(GOLDEN_DIR, "site-types.writes.txt"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
