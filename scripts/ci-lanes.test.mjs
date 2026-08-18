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
const wrapperSources = Object.fromEntries(
  Object.values(manifest.lanes)
    .filter((lane) => lane.wrapper)
    .map((lane) => [lane.wrapper, readFileSync(path.join(root, lane.wrapper), "utf8")]),
);

function validateLaneManifest(candidate, packageJson = pkg, sources = wrapperSources) {
  assert.equal(candidate.schema, "superbee.ci-lanes.v1");
  assert.equal(candidate.path_skipping, false, "the first implementation cannot skip by path");
  assert.deepEqual(candidate.components.map((row) => row.command), packageJson.scripts.check.split(" && "));
  assert.deepEqual(
    [...candidate.required_jobs].sort(),
    Object.keys(candidate.lanes).sort(),
    "required_jobs must equal the complete lane set",
  );

  const ids = candidate.components.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "component ids must be unique");
  const components = new Map(candidate.components.map((row) => [row.id, row]));
  const claimed = new Map(ids.map((id) => [id, []]));
  for (const [laneName, lane] of Object.entries(candidate.lanes)) {
    assert.equal(typeof lane.display_name, "string", `${laneName} must pin its workflow display name`);
    assert.ok(lane.display_name.length > 0, `${laneName} display name cannot be blank`);
    for (const id of lane.components) {
      assert.ok(claimed.has(id), `${laneName} claims unknown component ${id}`);
      claimed.get(id).push(laneName);
    }
    if (!lane.script) continue;
    const command = packageJson.scripts[lane.script];
    assert.ok(command, `${laneName} references missing package script ${lane.script}`);
    if (lane.wrapper) {
      assert.ok(command.includes(lane.wrapper), `${laneName} package script does not invoke wrapper ${lane.wrapper}`);
      const source = sources[lane.wrapper];
      assert.equal(typeof source, "string", `${laneName} wrapper source ${lane.wrapper} is unavailable`);
      for (const id of lane.components) {
        const literal = lane.wrapper_component_literals?.[id];
        assert.ok(literal, `${laneName} does not declare a wrapper literal for ${id}`);
        assert.ok(source.includes(literal), `${laneName} wrapper does not reach ${id} through literal ${literal}`);
      }
      continue;
    }
    for (const id of [...lane.components, ...(lane.prerequisites ?? [])]) {
      const component = components.get(id);
      assert.ok(component, `${laneName} references unknown executable component ${id}`);
      assert.ok(
        command.includes(component.command),
        `${laneName} script ${lane.script} does not execute ${id}: ${component.command}`,
      );
    }
  }
  for (const component of candidate.components) {
    assert.deepEqual(claimed.get(component.id), [component.owner], `${component.id} must have one intentional owner`);
  }
}

test("the lane manifest owns every complete local-check component exactly once", () => {
  validateLaneManifest(manifest);
  assert.deepEqual(REQUIRED_JOBS, manifest.required_jobs);
});

test("lane ownership is pinned to executing scripts and the exhaustive wrapper", () => {
  const scriptMutations = [
    ["ci:distribution", "npm run verify:npm-package", /skill-drift-proof/],
    ["ci:release-policy", "npm run build", /script-and-release-tests/],
    ["ci:browser", "npm run build && npm run test:browser -w @superbee\/mcp-app", /ui-end-to-end/],
    ["check:release-exhaustive", "node -e \"process.exit(0)\"", /does not invoke wrapper/],
  ];
  for (const [script, replacement, error] of scriptMutations) {
    const changedPackage = structuredClone(pkg);
    changedPackage.scripts[script] = replacement;
    assert.throws(() => validateLaneManifest(manifest, changedPackage), error, script);
  }

  const changedWrapper = {
    ...wrapperSources,
    [manifest.lanes["release-exhaustive"].wrapper]: wrapperSources[manifest.lanes["release-exhaustive"].wrapper]
      .replaceAll("test:packet-candidates", "test:one-packet-candidate"),
  };
  assert.throws(() => validateLaneManifest(manifest, pkg, changedWrapper), /wrapper does not reach all-release-targets/);

  const incomplete = structuredClone(manifest);
  incomplete.required_jobs.pop();
  assert.throws(() => validateLaneManifest(incomplete), /required_jobs must equal the complete lane set/);
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
