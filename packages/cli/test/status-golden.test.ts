/**
 * Byte-identity for `superbee status` across the bundle shapes its findings depend on. Every golden
 * under fixtures/status-golden/goldens was captured from the command before its findings moved into
 * `@superbee/core/bundle-health`; a diff here is a change to the status contract, not a fixture
 * refresh. Capture (only against the unchanged command):
 *
 *   SUPERBEE_CAPTURE_STATUS_GOLDENS=1 npm test -w @superbee/cli -- test/status-golden.test.ts
 *
 * Fixtures (fixtures/status-golden/bundles):
 *   - every-finding (v0.2) fires every finding section, cross-bundle rows included; it declares
 *     four dependencies: `beers` (the sibling copy), `wines` (no path), `gone` (a missing path) and
 *     `far` (a path outside the repository).
 *   - upgrade-blocked (v0.1): two Kinds with workflow `status` enums, so `okf_upgrade` is present,
 *     plus one unresolved link so its position before the row blocks is pinned.
 *   - local-edge-typed (v0.1): a local edge under a qualified declaration and no dependencies, so
 *     `cross_bundle_link_type_violations_rows` appears without the `cross_bundle_*` counts.
 *   - undeclared-edition: a root index without `okf_version` (no `okf_upgrade`, no `trust`, no v0.2
 *     timestamp families).
 *
 * Each run copies the bundles to a temporary root (a subdirectory, never a repository's committed
 * bundle folder, so the home stays local), fixes the clock, and substitutes that root with `<dir>`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { status } from "../src/commands/status.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLES = path.join(here, "fixtures", "status-golden", "bundles");
const GOLDEN_DIR = path.join(here, "fixtures", "status-golden", "goldens");
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const CAPTURE = process.env.SUPERBEE_CAPTURE_STATUS_GOLDENS === "1";
const noPull = async (): Promise<void> => {};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface GoldenCase {
  golden: string;
  fixture: string;
  flags: (repo: string) => string[];
  /** Commit the copied bundles into a Git repository and create `<root>/far` outside it. */
  git?: boolean;
}

const CASES: GoldenCase[] = [];
const formats = [
  { suffix: "toon", flags: [] as string[] },
  { suffix: "json", flags: ["--json"] },
];
for (const { suffix, flags } of formats) {
  CASES.push({ golden: `every-finding.${suffix}`, fixture: "every-finding", flags: () => flags });
  CASES.push({ golden: `every-finding.limit-1.${suffix}`, fixture: "every-finding", flags: () => ["--limit", "1", ...flags] });
  CASES.push({
    golden: `every-finding.with.${suffix}`,
    fixture: "every-finding",
    flags: (repo) => ["--with", `beers=${path.join(repo, "beers")}`, ...flags],
  });
  CASES.push({ golden: `every-finding.with-deps.${suffix}`, fixture: "every-finding", flags: () => ["--with-deps", ...flags], git: true });
  CASES.push({ golden: `upgrade-blocked.${suffix}`, fixture: "upgrade-blocked", flags: () => flags });
  CASES.push({ golden: `upgrade-blocked.limit-1.${suffix}`, fixture: "upgrade-blocked", flags: () => ["--limit", "1", ...flags] });
  CASES.push({ golden: `local-edge-typed.${suffix}`, fixture: "local-edge-typed", flags: () => flags });
  CASES.push({ golden: `undeclared-edition.${suffix}`, fixture: "undeclared-edition", flags: () => flags });
}
CASES.push({ golden: "every-finding.limit-0.json", fixture: "every-finding", flags: () => ["--limit", "0", "--json"] });

for (const { golden, fixture, flags, git: inGit } of CASES) {
  test(`status golden: ${golden} is byte-identical`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-status-golden-")));
    try {
      const repo = path.join(root, "repo");
      const home = path.join(root, "home");
      await cp(BUNDLES, repo, { recursive: true });
      await mkdir(home, { recursive: true });
      if (inGit) {
        git(repo, "init", "-q", "-b", "main");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "fixtures");
        await mkdir(path.join(root, "far"), { recursive: true });
      }
      let out = "";
      // Findings are reports: the command resolves (exit 0) on every fixture.
      await status(["--dir", path.join(repo, fixture), ...flags(repo)], { stdout: (s) => (out += s), autoPull: noPull, home });
      const normalized = out.split(root).join("<dir>");
      const file = path.join(GOLDEN_DIR, golden);
      if (CAPTURE) {
        await mkdir(GOLDEN_DIR, { recursive: true });
        await writeFile(file, normalized);
      }
      assert.equal(normalized, await readFile(file, "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
