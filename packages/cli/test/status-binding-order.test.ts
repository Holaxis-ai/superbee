/**
 * Where `status` binds `--with` and `--with-deps`: after its own lenient read of the bundle, from
 * the one parse of `docs/dependencies` that also feeds the `dependencies` rows. These states were
 * captured from the command before its findings moved into `@superbee/core/bundle-health`, and pin
 * the exit codes a different binding point would change: a strict pre-read of the declaration turns
 * a malformed or absent one into a RUNTIME failure, and a parse without this bundle's own id keeps a
 * self alias that `DEP_SELF` drops.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { status } from "../src/commands/status.js";
import { CliError, EXIT, toExit } from "../src/errors.js";

const noPull = async (): Promise<void> => {};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface Fixture {
  root: string;
  home: string;
  /** The referring bundle, a subdirectory of `root` (never a repository's committed bundle folder). */
  town: string;
  /** A copy declaring `docs/bundle` id `golden-beers`. */
  beers: string;
}

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(options: { dependencies?: string; bundleId?: string; git?: boolean }): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-status-binding-")));
  const home = path.join(root, "home");
  const town = path.join(root, "town");
  const beers = path.join(root, "beers");
  await mkdir(home, { recursive: true });
  await write(path.join(town, "index.md"), "---\nokf_version: '0.1'\n---\n# Town\n");
  await write(path.join(town, "menus", "whale.md"), "---\ntype: Menu Item\ntitle: Whale\n---\n[pours](okf://beers/beers/little-whale.md)\n");
  if (options.bundleId !== undefined) {
    await write(path.join(town, "docs", "bundle.md"), `---\ntype: Bundle Name\ntitle: Town\nbundle_id: ${options.bundleId}\n---\n`);
  }
  if (options.dependencies !== undefined) await write(path.join(town, "docs", "dependencies.md"), options.dependencies);
  await write(path.join(beers, "index.md"), "---\nokf_version: '0.1'\n---\n# Beers\n");
  await write(path.join(beers, "docs", "bundle.md"), "---\ntype: Bundle Name\ntitle: Beers\nbundle_id: golden-beers\n---\n");
  await write(path.join(beers, "beers", "little-whale.md"), "---\ntype: Beer\ntitle: Little Whale\n---\n");
  if (options.git) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");
  }
  return { root, home, town, beers };
}

async function run(fx: Fixture, flags: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await status(["--dir", fx.town, "--json", ...flags], { stdout: (s) => (out += s), autoPull: noPull, home: fx.home });
  return JSON.parse(out) as Record<string, unknown>;
}

async function refusedAsUsage(fn: () => Promise<unknown>, match?: RegExp): Promise<void> {
  await assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE");
    assert.equal(toExit(error).exitCode, EXIT.USAGE);
    if (match) assert.match(error.message, match);
    return true;
  });
}

const MALFORMED_DEPENDENCIES = "---\ntype: Bundle Dependencies\ndependencies: [unclosed\n---\n";

test("binding order: a malformed docs/dependencies with --with is a USAGE refusal naming the undeclared alias", async () => {
  const fx = await fixture({ dependencies: MALFORMED_DEPENDENCIES });
  try {
    await refusedAsUsage(() => run(fx, ["--with", `beers=${fx.beers}`]), /does not declare/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("binding order: an absent docs/dependencies with --with is a USAGE refusal", async () => {
  const fx = await fixture({});
  try {
    await refusedAsUsage(() => run(fx, ["--with", `beers=${fx.beers}`]), /does not declare/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("binding order: an alias naming this bundle's own id is dropped as DEP_SELF before binding", async () => {
  const fx = await fixture({
    bundleId: "golden-town",
    dependencies: "---\ntype: Bundle Dependencies\ndependencies:\n  me:\n    bundle_id: golden-town\n    path: .\n---\n",
  });
  try {
    await refusedAsUsage(() => run(fx, ["--with", `me=${fx.town}`]), /does not declare/);
    const report = await run(fx, []);
    const problems = (report.dependency_problems as { rows: Record<string, unknown>[] }).rows;
    assert.deepEqual(problems.map(({ code, alias }) => ({ code, alias })), [{ code: "DEP_SELF", alias: "me" }]);
    const dependencies = (report.dependencies as { rows: Record<string, unknown>[] } | undefined)?.rows ?? [];
    assert.equal(dependencies.some((row) => row.alias === "me"), false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("binding order: a malformed docs/dependencies with --with-deps inside Git resolves, reporting the malformed document", async () => {
  const fx = await fixture({ dependencies: MALFORMED_DEPENDENCIES, git: true });
  try {
    const report = await run(fx, ["--with-deps"]);
    assert.equal(report.malformed, 1);
    const malformed = (report.malformed_docs as { rows: Record<string, unknown>[] }).rows;
    assert.deepEqual(malformed.map((row) => row.id), ["docs/dependencies"]);
    assert.equal("dependencies" in report, false);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
