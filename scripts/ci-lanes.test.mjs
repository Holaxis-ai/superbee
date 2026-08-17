import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateRequiredResults, REQUIRED_JOBS } from "./ci-aggregate.mjs";
import { parseExpectedSha } from "./ci-release-exhaustive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));

test("the lane manifest owns every complete local-check component exactly once", () => {
  assert.equal(manifest.schema, "superbee.ci-lanes.v1");
  assert.equal(manifest.path_skipping, false, "the first implementation cannot skip by path");
  const checkCommands = pkg.scripts.check.split(" && ");
  assert.deepEqual(manifest.components.map((row) => row.command), checkCommands);

  const ids = manifest.components.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "component ids must be unique");
  const claimed = new Map(ids.map((id) => [id, []]));
  for (const [laneName, lane] of Object.entries(manifest.lanes)) {
    for (const id of lane.components) {
      assert.ok(claimed.has(id), `${laneName} claims unknown component ${id}`);
      claimed.get(id).push(laneName);
    }
    if (lane.script) assert.ok(pkg.scripts[lane.script], `${laneName} references missing package script ${lane.script}`);
  }
  for (const component of manifest.components) {
    assert.deepEqual(claimed.get(component.id), [component.owner], `${component.id} must have one intentional owner`);
  }
});

test("runtime-sensitive suites are identical on Node 22 and 26 and singleton lanes use Node 26", () => {
  assert.deepEqual(manifest.runtime_nodes, [22, 26]);
  assert.deepEqual(manifest.lanes.runtime.nodes, manifest.runtime_nodes);
  assert.equal(
    pkg.scripts[manifest.lanes.runtime.script],
    "npm run build && npm run typecheck --workspaces --if-present --ignore-scripts && npm test --workspaces --if-present --ignore-scripts",
  );
  assert.equal(cliPkg.scripts.pretest, "node build.mjs local-dev", "ordinary npm test must keep its build prerequisite");
  assert.doesNotMatch(cliPkg.scripts.test, /build\.mjs/, "the CI runtime lane must be able to skip the pretest rebuild");
  for (const [name, lane] of Object.entries(manifest.lanes)) {
    if (name === "runtime" || name === "smoke-node-20") continue;
    assert.deepEqual(lane.nodes, [manifest.singleton_node], `${name} must not amplify across runtime versions`);
  }
});

test("the fail-closed result contract accepts success only", () => {
  const green = Object.fromEntries(REQUIRED_JOBS.map((name) => [name, { result: "success", outputs: {} }]));
  assert.deepEqual(evaluateRequiredResults(green), { ok: true, errors: [] });
  for (const rejected of ["failure", "cancelled", "timed_out", "neutral", "skipped", undefined]) {
    const results = structuredClone(green);
    results[REQUIRED_JOBS[0]] = rejected === undefined ? {} : { result: rejected };
    assert.equal(evaluateRequiredResults(results).ok, false, `${String(rejected)} must fail closed`);
  }
  const missing = structuredClone(green);
  delete missing[REQUIRED_JOBS[0]];
  assert.equal(evaluateRequiredResults(missing).ok, false, "a removed dependency must fail closed");
  const renamed = structuredClone(green);
  renamed[`${REQUIRED_JOBS[0]}-renamed`] = renamed[REQUIRED_JOBS[0]];
  delete renamed[REQUIRED_JOBS[0]];
  assert.equal(evaluateRequiredResults(renamed).ok, false, "a renamed dependency must fail closed");
});

test("the exact-SHA wrapper accepts only an explicit 40-hex identity", () => {
  assert.equal(parseExpectedSha([]), null);
  assert.equal(parseExpectedSha(["--expected-sha", "a".repeat(40)]), "a".repeat(40));
  for (const argv of [["--expected-sha"], ["--expected-sha", "HEAD"], ["--other", "a".repeat(40)]]) {
    assert.throws(() => parseExpectedSha(argv), /usage/);
  }
});
