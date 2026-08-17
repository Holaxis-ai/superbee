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

test("CI runs every lane unconditionally with the declared runtime topology", () => {
  const jobs = extractJobs(workflow);
  for (const required of manifest.required_jobs) assert.ok(jobs[required], `missing required job ${required}`);
  assert.match(jobs.runtime, /node-version: \[22, 26\]/);
  assert.match(jobs.runtime, /run: npm run ci:runtime/);
  for (const [job, script] of [
    ["distribution", "ci:distribution"],
    ["browser", "ci:browser"],
    ["release-policy", "ci:release-policy"],
  ]) {
    assert.match(jobs[job], /node-version: 26/);
    assert.match(jobs[job], new RegExp(`run: npm run ${script.replace(":", "\\:")}`));
  }
  assert.match(jobs["release-exhaustive"], /check:release-exhaustive -- --expected-sha "\$EXPECTED_SOURCE_SHA"/);
  assert.match(jobs["release-exhaustive"], /fetch-depth: 0/, "exact-SHA proof needs complete history");
  assert.doesNotMatch(workflow, /^\s*paths(?:-ignore)?:/m, "required workflow cannot skip based on paths");
  assert.doesNotMatch(workflow, /^\s*merge_group:/m, "merge_group remains deferred without repository support evidence");
});

test("canonical and legacy compatibility contexts are identical fail-closed aggregators", () => {
  const jobs = extractJobs(workflow);
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
