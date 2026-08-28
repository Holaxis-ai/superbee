/**
 * The recipe-evolution receipt promises one exact transactional continuation. Exercise that
 * promise against the built artifact: the printed command must stay bound to the executable that
 * created the plan, even when that executable is not reachable through PATH, and must apply when
 * executed character-for-character.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle } from "@superbee/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");
const cliSource = path.join(cliPackageRoot, "src", "index.ts");
const sourceLoader = path.join(here, "ts-loader.mjs");

before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCliJson(launcher: string[], args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [...launcher, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ASLITE_NO_UPDATE_CHECK: "1",
      SUPERBEE_NO_AUTOPULL: "1",
    },
  });
  assert.equal(
    result.status,
    0,
    `CLI failed (${args.join(" ")}): stdout=${result.stdout} stderr=${result.stderr}`,
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function exerciseExactApply(launcher: string[], expectedPrefix: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-recipe-evolve-exact-"));
  const bundleDir = path.join(root, "bundle");
  const recipeDir = path.join(root, "widget-recipe");
  const conventionPath = path.join(recipeDir, "conventions", "widget.md");
  const manifest = (version: string) =>
    `---\ntype: Recipe\nid: widget-workflow\ntitle: Widget workflow\nversion: "${version}"\nsummary: Widget definitions.\n---\n`;
  const convention = (withColour: boolean) =>
    "---\ntype: Convention\ntitle: Widget\ngoverns: Widget\npath: widgets/\nfields:\n" +
    "  required: [title]\n" +
    (withColour ? "  optional: [colour]\n" : "  optional: []\n") +
    "---\n# Widget\n";

  try {
    await initBundle(bundleDir);
    await mkdir(path.dirname(conventionPath), { recursive: true });
    await writeFile(path.join(recipeDir, "recipe.md"), manifest("1"), "utf8");
    await writeFile(conventionPath, convention(false), "utf8");
    runCliJson(launcher, ["recipe", "add", recipeDir, "--dir", bundleDir, "--json"]);

    await writeFile(path.join(recipeDir, "recipe.md"), manifest("2"), "utf8");
    await writeFile(conventionPath, convention(true), "utf8");

    const plan = runCliJson(launcher, ["recipe", "evolve", recipeDir, "--dir", bundleDir, "--json"]);
    assert.equal(plan.ready, true);
    assert.equal(plan.changed, true);
    const command = String((plan.commands as Record<string, unknown>).apply);
    const expected =
      expectedPrefix +
      ` recipe evolve ${shellArg(recipeDir)} --dir ${shellArg(bundleDir)} --apply ${String(plan.plan_token)}`;
    assert.equal(command, expected);

    const applied = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        ASLITE_NO_UPDATE_CHECK: "1",
        SUPERBEE_NO_AUTOPULL: "1",
      },
    });
    assert.equal(
      applied.status,
      0,
      `exact apply command failed: stdout=${applied.stdout} stderr=${applied.stderr}`,
    );
    assert.match(applied.stdout, /recipe: evolved/);
    assert.match(
      await readFile(path.join(bundleDir, "conventions", "widget.md"), "utf8"),
      /optional:\n\s+- colour/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("built CLI: recipe evolve exact apply command remains bound to the planning artifact", async () => {
  await exerciseExactApply(
    [cliBin],
    `${shellArg(realpathSync(process.execPath))} ${shellArg(realpathSync(cliBin))}`,
  );
});

test("loader-driven source CLI: recipe evolve exact apply command preserves required Node arguments", async () => {
  await exerciseExactApply(
    ["--import", sourceLoader, cliSource],
    [realpathSync(process.execPath), "--import", sourceLoader, realpathSync(cliSource)].map(shellArg).join(" "),
  );
});
