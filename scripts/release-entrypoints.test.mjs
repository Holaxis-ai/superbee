import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isMainModule } from "./is-main-module.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_CLI_PATHS = [
  "scripts/release-audit-tags.mjs",
  "scripts/release-candidate.mjs",
  "scripts/release-emit-receipt.mjs",
  "scripts/release-inspect.mjs",
  "scripts/release-reconcile.mjs",
  "scripts/release-resolve-target.mjs",
  "scripts/release-run-operations.mjs",
  "scripts/release-verify-chain.mjs",
  "scripts/release-verify-ordering.mjs",
  "scripts/release-verify-registry.mjs",
  "scripts/verify-npm-package.mjs",
];

const PURE_RELEASE_MODULE_PATHS = [
  "scripts/release-inspect-recovery.mjs",
  "scripts/release-operations.mjs",
  "scripts/release-ordering.mjs",
  "scripts/release-receipts.mjs",
  "scripts/release-state.mjs",
  "scripts/release-targets.mjs",
];

const representativeCli = path.join(repoRoot, "scripts", "release-resolve-target.mjs");

test("release entrypoint inventory classifies every release script", async () => {
  const releaseScripts = (await readdir(path.join(repoRoot, "scripts")))
    .filter((entry) => /^release-[A-Za-z0-9-]+\.mjs$/.test(entry))
    .map((entry) => `scripts/${entry}`)
    .sort();
  const expected = [...RELEASE_CLI_PATHS, ...PURE_RELEASE_MODULE_PATHS]
    .filter((entry) => entry.startsWith("scripts/release-"))
    .sort();

  assert.deepEqual(releaseScripts, expected);
  assert.equal(RELEASE_CLI_PATHS.length, 11);
});

test("every executable release CLI delegates main authority to the shared helper", async () => {
  for (const relativePath of RELEASE_CLI_PATHS) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.match(source, /from "\.\/is-main-module\.mjs"/, relativePath);
    assert.match(source, /await isMainModule\(import\.meta\.url\)/, relativePath);
    assert.doesNotMatch(source, /process\.argv\[1\]/, relativePath);
  }
});

test("isMainModule distinguishes direct execution, imports, and symlinked execution", async (t) => {
  const moduleUrl = pathToFileURL(representativeCli).href;
  assert.equal(await isMainModule(moduleUrl, { argv1: representativeCli }), true);
  assert.equal(await isMainModule(moduleUrl, { argv1: path.join(repoRoot, "package.json") }), false);
  assert.equal(await isMainModule(moduleUrl, { argv1: undefined }), false);

  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-release-entrypoint-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const linkedCli = path.join(scratch, "release-resolve-target.mjs");
  await symlink(representativeCli, linkedCli);
  assert.equal(await isMainModule(moduleUrl, { argv1: linkedCli }), true);

  await import(moduleUrl);
});

test("isMainModule rejects realpath authority failures", async () => {
  await assert.rejects(
    isMainModule(pathToFileURL(representativeCli).href, {
      argv1: representativeCli,
      realpathImpl: async () => {
        throw new Error("access denied");
      },
    }),
    /entrypoint authority.*access denied/i,
  );
});

test("a symlinked release CLI has the same observable result as direct execution", async (t) => {
  const direct = await execFileAsync(process.execPath, [representativeCli, "--target", "bridge", "--json"], {
    cwd: repoRoot,
  });
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-release-entrypoint-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const linkedCli = path.join(scratch, "release-resolve-target.mjs");
  await symlink(representativeCli, linkedCli);
  const linked = await execFileAsync(process.execPath, [linkedCli, "--target", "bridge", "--json"], {
    cwd: repoRoot,
  });

  assert.equal(linked.stdout, direct.stdout);
  assert.equal(linked.stderr, direct.stderr);
});
