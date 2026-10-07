import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { CrashSweepProgress } from "./support/crash-sweep-progress.js";
import { selectedCrashCaseKeys } from "./support/qa-r2-crash-cases.js";

test("crash sweep rejects failure, missing counts, unexpected signals and exhausted caps", () => {
  const result = { code: 0, signal: null, stderr: "QA_STEPS 1" };
  const sweep = new CrashSweepProgress();
  sweep.observe(1, { code: null, signal: "SIGKILL", stderr: "QA_KILL 1 write" });
  assert.throws(() => sweep.assertComplete(), /exhausted/);
  sweep.observe(2, result);
  sweep.assertComplete();
  for (const bad of [
    { ...result, code: 1 }, { ...result, signal: "SIGTERM" as const },
    { ...result, stderr: "" }, { ...result, stderr: "QA_STEPS 0" },
    { ...result, stderr: "QA_STEPS 2" },
    { code: null, signal: "SIGKILL" as const, stderr: "QA_KILL 8 write" },
  ]) assert.throws(() => new CrashSweepProgress().observe(2, bad));
});

test("a selected kill point beyond the last side effect permits successful completion only", () => {
  const result = { code: 0, signal: null, stderr: "QA_STEPS 3" };
  const selected = new CrashSweepProgress({ singlePoint: true });
  selected.observe(399, result);
  selected.assertComplete();
  assert.throws(() => new CrashSweepProgress().observe(399, result), /final kill point/);
  for (const bad of [
    { ...result, code: 1 }, { ...result, signal: "SIGTERM" as const },
    { ...result, stderr: "" }, { ...result, stderr: "QA_STEPS 0" },
    { ...result, stderr: "QA_STEPS 399" },
  ]) assert.throws(() => new CrashSweepProgress({ singlePoint: true }).observe(399, bad));
});

test("QA_ONLY retains name-prefix selection and numeric selection excludes the qa-r2 sweeps", async () => {
  const directory = new URL("./", import.meta.url);
  const wrappers = (await readdir(directory)).filter(name => /^qa-r2-crash-.*\.test\.ts$/.test(name));
  assert.equal(selectedCrashCaseKeys("").length, 6);
  assert.deepEqual(selectedCrashCaseKeys("399"), []);
  assert.deepEqual(selectedCrashCaseKeys("deletion in conflict, --resolve keep"), ["conflict-keep"]);
  assert.deepEqual(selectedCrashCaseKeys("deletion in conflict").sort(), ["conflict-keep", "conflict-take"]);
  assert.deepEqual(selectedCrashCaseKeys("does-not-exist"), []);
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  // A numeric selector must not execute any qa-r2 scenario, even without a runner name filter.
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    "--import", "./test/ts-loader.mjs", ...wrappers.map(name => `./test/${name}`)], {
    cwd: new URL("../", import.meta.url), env: { ...env, QA_ONLY: "399" }, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const selected = [...child.stdout.matchAll(/# Subtest: SIGKILL at every step: (.*)/g)].map(match => match[1]);
  assert.deepEqual(selected, []);
});

test("each crash scenario has exactly one independent test file", async () => {
  const directory = new URL("./", import.meta.url);
  const wrappers = (await readdir(directory)).filter(name => /^qa-r2-crash-.*\.test\.ts$/.test(name));
  const keys = await Promise.all(wrappers.map(async name => {
    const source = await readFile(new URL(name, directory), "utf8");
    assert.equal((source.match(/registerCrashCase\(/g) ?? []).length, 1);
    return /registerCrashCase\("([^"]+)"\)/.exec(source)?.[1];
  }));
  assert.deepEqual(keys.sort(), ["bulk-window", "conflict-keep", "conflict-take", "own-recreate", "remote-recreate", "scan-delete"]);
  const original = await readFile(new URL("hosted-sync-crash.test.ts", directory), "utf8");
  assert.match(original, /progress\.assertComplete\(\)/);
  const helper = await readFile(new URL("support/qa-r2-crash-cases.ts", directory), "utf8");
  const cases = [...helper.matchAll(/key: "([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(cases, keys.sort());
  assert.doesNotMatch(helper, /concurrency:\s*true/);
});
