import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateRequiredResults, REQUIRED_JOBS } from "./ci-aggregate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");
const okfBundleSource = readFileSync(path.join(root, "packages", "core", "src", "bundle.ts"), "utf8");
const meaningfulChangeSource = readFileSync(
  path.join(root, "packages", "core", "src", "meaningful-change-time.ts"),
  "utf8",
);
const linkSource = readFileSync(path.join(root, "packages", "core", "src", "links.ts"), "utf8");
const sampleOkfReference = readFileSync(
  path.join(root, "examples", "sample-bundle", "references", "okf-spec.md"),
  "utf8",
);
const wrapperSources = Object.fromEntries(
  Object.values(manifest.lanes)
    .filter((lane) => lane.wrapper)
    .map((lane) => [lane.wrapper, readFileSync(path.join(root, lane.wrapper), "utf8")]),
);

function projectionRows(text, name) {
  const start = `<!-- contributing-${name}:start -->`;
  const end = `<!-- contributing-${name}:end -->`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  assert.ok(startAt >= 0, `missing ${name} projection start`);
  assert.ok(endAt > startAt, `missing ${name} projection end`);
  return text
    .slice(startAt + start.length, endAt)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim().replaceAll("`", "")));
}

function validateContributorAuthority(
  text,
  candidateManifest = manifest,
  packageJson = pkg,
  sources = { okfBundleSource, meaningfulChangeSource, linkSource, sampleOkfReference },
) {
  for (const heading of ["## OKF compatibility", "## Findings and commitments", "## Assurance evolution"]) {
    assert.match(text, new RegExp(`^${heading}$`, "m"), `missing exact contributor anchor ${heading}`);
  }
  for (const pointer of [
    "scripts/ci-lanes.json",
    ".github/workflows/ci-tests.yml",
    "conventions/task",
    "conventions/review",
  ]) {
    assert.ok(text.includes(pointer), `missing contributor pointer ${pointer}`);
  }

  const laneRows = candidateManifest.required_jobs.map((name) => {
    const lane = candidateManifest.lanes[name];
    assert.ok(lane, `required contributor lane ${name} is missing`);
    if (lane.script) {
      assert.ok(packageJson.scripts[lane.script], `contributor lane ${name} references missing package script`);
    }
    return [name, lane.script ? `npm run ${lane.script}` : "workflow only", name, lane.nodes.join(", ")];
  });
  assert.deepEqual(
    projectionRows(text, "ci-lanes"),
    laneRows,
    "the contributor lane projection must match the executable manifest and package scripts",
  );

  assert.deepEqual(projectionRows(text, "okf-matrix"), [
    ["0.1", "--okf-version 0.1", "retain 0.1", "top-level timestamp", "this section plus core edition tests"],
    [
      "0.2",
      "default",
      "retain 0.2",
      "generated.at when present, with legacy timestamp fallback for reads",
      "this section plus core edition tests",
    ],
  ]);
  assert.match(sources.okfBundleSource, /SUPPORTED_OKF_AUTHORING_VERSIONS = \["0\.1", "0\.2"\]/);
  assert.match(sources.okfBundleSource, /DEFAULT_OKF_AUTHORING_VERSION = "0\.2"/);
  assert.match(sources.meaningfulChangeSource, /if \(at !== undefined\) return at;[\s\S]*return frontmatter\.timestamp;/);
  assert.match(sources.linkSource, /return `\$\{rel\}\.md`;/);
  assert.match(sources.sampleOkfReference, /description: A version-scoped OKF v0\.1 interop reference/);
  assert.match(sources.sampleOkfReference, /This reference is scoped to OKF v0\.1 interop/);

  for (const policy of [
    /A specification statement is not a work commitment/,
    /every release-relevant `VIOLATED` or `UNKNOWN` statement must link to/,
    /Missing, stale, unavailable, or unqueryable evidence is not an\s+approval/,
    /five most recent completed units of the same change type and assurance stage within[\s\S]*previous 180 days/,
    /Fewer than three comparable Review records is insufficient evidence/,
    /persist the exact selection at[\s\S]*with a report of verdicts/,
    /Review that report as a `subject_kind: process` Review/,
    /leaves the current assurance stage unchanged/,
  ]) {
    assert.match(text, policy, `missing contributor workflow policy ${policy}`);
  }
}

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

test("the contributor authority agrees with CI topology and both OKF editions", () => {
  validateContributorAuthority(contributing);
});

test("contributor projections fail red on lane, edition, pointer, and assurance drift", () => {
  const renamedLane = structuredClone(manifest);
  renamedLane.lanes.runtime.script = "ci:runtime-renamed";
  assert.throws(
    () => validateContributorAuthority(contributing, renamedLane),
    /missing package script/,
  );

  assert.throws(
    () => validateContributorAuthority(contributing.replace("npm run ci:runtime", "npm run test")),
    /contributor lane projection/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("retain 0.2", "upgrade to 0.2")),
    /strictly deep-equal/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace(".github/workflows/ci-tests.yml", "CI")),
    /missing contributor pointer/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("persist the exact selection at", "inspect a sample at")),
    /missing contributor workflow policy/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("leaves the current assurance stage unchanged", "permits an exception")),
    /missing contributor workflow policy/,
  );
});

test("lane ownership is pinned to executing scripts", () => {
  const scriptMutations = [
    ["ci:distribution", "npm run verify:npm-package", /skill-drift-proof/],
    ["ci:scripts", "npm run build", /script-tests/],
    ["ci:browser", "npm run build && npm run test:browser -w @superbee\/mcp-app", /ui-end-to-end/],
  ];
  for (const [script, replacement, error] of scriptMutations) {
    const changedPackage = structuredClone(pkg);
    changedPackage.scripts[script] = replacement;
    assert.throws(() => validateLaneManifest(manifest, changedPackage), error, script);
  }

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

test("the aliasing-host lane pins a fail-closed host expectation on both host classes", () => {
  assert.equal(manifest.host_expectation_variable, "SUPERBEE_TEST_EXPECT_ALIASING_HOST");
  const lane = manifest.lanes["aliasing-host"];
  assert.equal(lane.script, "ci:aliasing-host", "the lane runs the scoped host-class target");
  assert.deepEqual(lane.components, [], "scoped coverage is proven by aliasing-host-coverage, not owned components");
  assert.equal(lane.runs_on, "macos-latest");
  assert.equal(lane.expect_aliasing_host, "1");
  assert.equal(manifest.lanes.runtime.expect_aliasing_host, "0");
  for (const name of ["runtime", "aliasing-host"]) {
    assert.match(manifest.lanes[name].host_guard, /PROBE-NAME/, `${name} must probe the host class before testing`);
  }
  assert.ok(manifest.required_jobs.includes("aliasing-host"), "the aliasing-host lane must be required");
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
