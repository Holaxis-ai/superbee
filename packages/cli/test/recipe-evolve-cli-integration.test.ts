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
import { fileURLToPath, pathToFileURL } from "node:url";

import { initBundle } from "@superbee/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");
const cliSource = path.join(cliPackageRoot, "src", "index.ts");
const sourceLoader = path.join(here, "ts-loader.mjs");

before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

function commandArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const normalized = value.replaceAll("\\", "/");
    assert.doesNotMatch(normalized, /[\x00-\x1f\x7f"%!$`]/);
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(normalized) ? normalized : `"${normalized}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandArgs(values: string[], platform: NodeJS.Platform = process.platform): string {
  return values.map((value) => commandArg(value, platform)).join(" ");
}

function hostShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === "win32") {
    const file = env.ComSpec ?? env.COMSPEC;
    assert.ok(file && path.win32.isAbsolute(file), "Windows exact command proof requires an absolute ComSpec");
    // The final argument is already a complete cmd.exe command line. Node's normal Windows argv
    // serializer would quote that argument again and escape its embedded quotes, causing those
    // quotes to reach the CLI literally. Pass the generated characters through unchanged, just
    // as an interactive paste does.
    return { file, args: ["/d", "/s", "/c", command], windowsVerbatimArguments: true };
  }
  return { file: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}

test("exact apply commands use the native host shell contract", () => {
  assert.deepEqual(hostShell("superbee recipe evolve", "linux"), {
    file: "/bin/sh",
    args: ["-c", "superbee recipe evolve"],
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(
    hostShell("superbee recipe evolve", "win32", { ComSpec: String.raw`C:\Windows\System32\cmd.exe` }),
    {
      file: String.raw`C:\Windows\System32\cmd.exe`,
      args: ["/d", "/s", "/c", "superbee recipe evolve"],
      windowsVerbatimArguments: true,
    },
  );
  assert.throws(
    () => hostShell("superbee recipe evolve", "win32", { ComSpec: "cmd.exe" }),
    /absolute ComSpec/,
  );
  assert.equal(commandArg("/tmp/recipe with spaces", "linux"), "'/tmp/recipe with spaces'");
  assert.equal(
    commandArg(String.raw`C:\Program Files\Superbee\recipe`, "win32"),
    '"C:/Program Files/Superbee/recipe"',
  );
  assert.equal(
    commandArgs([String.raw`C:\Program Files\node.exe`, "--import", "file:///C:/loader.mjs"], "win32"),
    '"C:/Program Files/node.exe" --import file:///C:/loader.mjs',
  );
});

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
      ` recipe evolve ${commandArg(recipeDir)} --dir ${commandArg(bundleDir)} --apply ${String(plan.plan_token)}`;
    assert.equal(command, expected);

    const shell = hostShell(command);
    const applied = spawnSync(shell.file, shell.args, {
      encoding: "utf8",
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      env: {
        ...process.env,
        PATH: process.platform === "win32" ? path.dirname(realpathSync(process.execPath)) : "/usr/bin:/bin",
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
    `${commandArg(realpathSync(process.execPath))} ${commandArg(realpathSync(cliBin))}`,
  );
});

test("loader-driven source CLI: recipe evolve exact apply command preserves required Node arguments", async () => {
  const sourceLoaderUrl = pathToFileURL(sourceLoader).href;
  await exerciseExactApply(
    ["--import", sourceLoaderUrl, cliSource],
    commandArgs([realpathSync(process.execPath), "--import", sourceLoaderUrl, realpathSync(cliSource)]),
  );
});
