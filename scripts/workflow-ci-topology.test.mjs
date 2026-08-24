import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci-tests.yml"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));

function extractJobs(text) {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  assert.notEqual(at, -1, "workflow must declare jobs");
  const jobs = {};
  let current = null;
  for (let index = at + 1; index < lines.length; index += 1) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (lines[index] && !/^ {3,}/.test(lines[index]) && !/^ {0,2}#/.test(lines[index])) break;
    if (current) jobs[current].push(lines[index]);
  }
  return Object.fromEntries(Object.entries(jobs).map(([name, lines]) => [name, lines.join("\n")]));
}

function needsOf(job) {
  const list = /^ {4}needs: \[([^\]]*)\]\s*$/m.exec(job);
  if (list) return list[1].split(",").map((name) => name.trim()).filter(Boolean);
  const scalar = /^ {4}needs: ([A-Za-z0-9_-]+)\s*$/m.exec(job);
  return scalar ? [scalar[1]] : [];
}

function assertAggregator(job, label) {
  assert.deepEqual(needsOf(job).sort(), [...manifest.required_jobs].sort(), `${label} needs every required lane`);
  assert.match(job, /^ {4}if: \$\{\{ always\(\) \}\}\s*$/m, `${label} must run after every conclusion`);
  assert.match(job, /REQUIRED_RESULTS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(job, /run: npm run ci:aggregate/);
}

function displayNameOf(job) {
  return /^ {4}name: (.+)\s*$/m.exec(job)?.[1] ?? null;
}

function assertSmokeJob(job, lane) {
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 2, "floor smoke needs build and floor runtimes");
  assert.deepEqual(
    [...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => match[1]),
    [String(manifest.singleton_node), String(lane.runtime_setup_node)],
    "the second setup-node invocation must select the declared engine floor",
  );
  assert.ok(job.includes(lane.version_guard), "floor smoke must self-check the active Node major");
  assert.match(job, new RegExp(`CLI=${lane.built_cli.replaceAll("/", "\\/")}`));
  const commands = [...job.matchAll(/^ {10}node "\$CLI" (.+)$/gm)].map((match) => match[1]);
  const surface = [...new Set(commands.map((argv) => {
    return [...lane.built_cli_commands]
      .sort((left, right) => right.length - left.length)
      .find((command) => argv === command || argv.startsWith(`${command} `)) ?? `<unknown:${argv}>`;
  }))].sort();
  assert.deepEqual(surface, [...lane.built_cli_commands].sort(), "floor smoke built-CLI command surface drifted");
}

// Every lane that declares a host-class expectation must run on the pinned runner, export the
// expectation to the tests, and self-check the filesystem before any test can observe it.
function assertHostExpectations(jobs, candidate) {
  const variable = candidate.host_expectation_variable;
  assert.equal(typeof variable, "string", "manifest must name the host-class expectation variable");
  const expectations = {};
  for (const [name, lane] of Object.entries(candidate.lanes)) {
    if (lane.expect_aliasing_host === undefined) continue;
    expectations[name] = lane.expect_aliasing_host;
    const job = jobs[name];
    assert.match(job, new RegExp(`^ {4}runs-on: ${lane.runs_on}\\s*$`, "m"), `${name} must run on ${lane.runs_on}`);
    assert.match(job, /^ {4}env:\s*$/m, `${name} must export the host-class expectation at job level`);
    assert.match(
      job,
      new RegExp(`^ {6}${variable}: "${lane.expect_aliasing_host}"\\s*$`, "m"),
      `${name} must pin the host-class expectation`,
    );
    assert.ok(job.includes(lane.host_guard), `${name} must self-check its host class`);
    assert.match(job, /run: npm run ci:runtime/, `${name} must run the runtime contract`);
  }
  assert.deepEqual(expectations, { runtime: "0", "aliasing-host": "1" }, "both host classes must be pinned");
}

function validateCiTopology(text, candidate = manifest) {
  const jobs = extractJobs(text);
  assert.deepEqual(
    [...candidate.required_jobs].sort(),
    Object.keys(candidate.lanes).sort(),
    "required_jobs must equal the complete lane set",
  );
  assert.doesNotMatch(text, /^\s+continue-on-error:/m, "required CI jobs cannot mask a failing step");
  for (const required of candidate.required_jobs) {
    assert.ok(jobs[required], `missing required job ${required}`);
    assert.equal(displayNameOf(jobs[required]), candidate.lanes[required].display_name, `${required} display name drifted`);
  }
  assert.match(jobs.runtime, /node-version: \[22, 26\]/);
  assert.match(jobs.runtime, /run: npm run ci:runtime/);
  assert.match(jobs["aliasing-host"], /node-version: 26/);
  assertHostExpectations(jobs, candidate);
  for (const [job, script] of [
    ["distribution", "ci:distribution"],
    ["browser", "ci:browser"],
    ["scripts", "ci:scripts"],
  ]) {
    assert.match(jobs[job], /node-version: 26/);
    assert.match(jobs[job], new RegExp(`run: npm run ${script.replace(":", "\\:")}`));
  }
  assertSmokeJob(jobs["smoke-node-20"], candidate.lanes["smoke-node-20"]);
  assert.doesNotMatch(text, /^\s*paths(?:-ignore)?:/m, "required workflow cannot skip based on paths");
  assert.equal(
    /^ {2}merge_group:/m.test(text),
    candidate.merge_queue.enabled,
    "workflow trigger must match the recorded current merge-queue posture",
  );
  assert.equal(typeof candidate.merge_queue.evidence, "string");
  assert.equal(typeof candidate.merge_queue.enablement_requirement, "string");
  return jobs;
}

test("CI runs every lane unconditionally with the declared runtime topology", () => {
  validateCiTopology(workflow);
});

test("canonical and legacy compatibility contexts are identical fail-closed aggregators", () => {
  const jobs = validateCiTopology(workflow);
  assert.match(jobs.required, /name: CI required lanes/);
  assert.match(jobs["compatibility-gate-node-22"], /name: gate \(node 22\)/);
  assert.match(jobs["compatibility-gate-node-26"], /name: gate \(node 26\)/);
  for (const [name, job] of [
    ["required", jobs.required],
    ["compatibility-gate-node-22", jobs["compatibility-gate-node-22"]],
    ["compatibility-gate-node-26", jobs["compatibility-gate-node-26"]],
  ]) assertAggregator(job, name);
});

test("renamed or removed aggregator dependencies are detected statically", () => {
  const jobs = extractJobs(workflow);
  const removed = jobs.required.replace("runtime, ", "");
  assert.throws(() => assertAggregator(removed, "removed"), /needs every required lane/);
  const renamed = jobs.required.replace("runtime,", "runtime-renamed,");
  assert.throws(() => assertAggregator(renamed, "renamed"), /needs every required lane/);
  const conditional = jobs.required.replace("if: ${{ always() }}", "if: ${{ success() }}");
  assert.throws(() => assertAggregator(conditional, "conditional"), /must run after every conclusion/);
});

test("workflow mutation attacks cannot hide failures or weaken required job identity", () => {
  assert.throws(
    () => validateCiTopology(workflow.replace("        run: npm run ci:runtime", "        run: npm run ci:runtime\n        continue-on-error: true")),
    /cannot mask a failing step/,
  );
  assert.throws(
    () => validateCiTopology(workflow.replace("name: distribution package and installed behavior", "name: distribution")),
    /distribution display name drifted/,
  );
  for (const [from, to, error] of [
    ["    runs-on: macos-latest", "    runs-on: ubuntu-latest", /aliasing-host must run on macos-latest/],
    ['      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "1"', '      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "0"', /aliasing-host must pin the host-class expectation/],
    ['      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "0"', '      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "1"', /runtime must pin the host-class expectation/],
    ['test -e "$RUNNER_TEMP/host-probe/PROBE-NAME"', "true", /aliasing-host must self-check its host class/],
    ['test ! -e "$RUNNER_TEMP/host-probe/PROBE-NAME"', "true", /runtime must self-check its host class/],
    ["          node-version: 20", "          node-version: 22", /second setup-node/],
    ["          node --version | grep -q '^v20\\.'", "          node --version", /self-check/],
    ["          node \"$CLI\" status --dir \"$DIR\"", "          node --version", /command surface/],
  ]) {
    assert.throws(() => validateCiTopology(workflow.replace(from, to)), error);
  }
  const incomplete = structuredClone(manifest);
  incomplete.required_jobs.pop();
  assert.throws(() => validateCiTopology(workflow, incomplete), /required_jobs must equal the complete lane set/);
});

test("merge-queue posture is current configuration, not a permanent prohibition", () => {
  assert.equal(manifest.merge_queue.enabled, false);
  const enabled = structuredClone(manifest);
  enabled.merge_queue.enabled = true;
  const withMergeGroup = workflow.replace("on:\n", "on:\n  merge_group:\n");
  assert.doesNotThrow(() => validateCiTopology(withMergeGroup, enabled));
  assert.throws(() => validateCiTopology(workflow, enabled), /merge-queue posture/);
});
