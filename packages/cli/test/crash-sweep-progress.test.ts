import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { CrashSweepProgress } from "./support/crash-sweep-progress.js";

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
