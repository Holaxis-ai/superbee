/**
 * Byte-identity for bundles that declare no `fields.types`: `status`, `kinds` and `new "<Kind>"
 * --help` render exactly the bytes they rendered before Convention field types existed. The golden
 * files were captured from the parent commit's CLI on the same fixtures; a diff here is a contract
 * change for untyped bundles (AXI-CONTRACT, "Kind field types are additive"), not a fixture refresh.
 * The `kind-site-types-only` fixture carries `x_field_types` and `x_field_values`, which core ignores.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { status } from "../src/commands/status.js";
import { kinds } from "../src/commands/kinds.js";
import { newCommand } from "../src/commands/new.js";

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
