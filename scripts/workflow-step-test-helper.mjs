import assert from "node:assert/strict";
import yaml from "js-yaml";

export function extractJobs(text) {
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

function parseStepField(step, source) {
  const field = /^([A-Za-z0-9_-]+):(?:\s(.*))?$/.exec(source);
  assert.ok(field, `unsupported workflow step field: ${source}`);
  assert.equal(
    Object.hasOwn(step.fields, field[1]),
    false,
    `workflow step ${step.position + 1} must not repeat field ${field[1]}`,
  );
  step.fields[field[1]] = field[2] ?? "";
  return field[1];
}

// This intentionally parses only the job-level step sequence used by topology assertions.
// Nested `with`, `env`, and block-scalar bodies are opaque. Unknown sequence-item shapes fail
// closed instead of being guessed as YAML semantics.
export function stepsOf(job) {
  const lines = job.split("\n");
  const stepsAt = lines.indexOf("    steps:");
  assert.notEqual(stepsAt, -1, "workflow job must declare steps");
  const steps = [];
  let current = null;
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {4}[A-Za-z0-9_-]+:/.test(line)) break;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^ {6}- (.+)$/.exec(line);
    if (item) {
      current = {
        position: steps.length,
        fields: Object.create(null),
        nested: Object.create(null),
        nestedContainer: null,
        source: line,
      };
      parseStepField(current, item[1]);
      steps.push(current);
      continue;
    }
    assert.doesNotMatch(line, /^ {6}-/, "workflow step sequence items must declare one field inline");
    if (current) current.source += `\n${line}`;
    const field = /^ {8}(\S.*)$/.exec(line);
    if (field && current) {
      const key = parseStepField(current, field[1]);
      current.nestedContainer = null;
      if (current.fields[key] === "") {
        current.nested[key] = Object.create(null);
        current.nestedContainer = key;
      }
      continue;
    }
    const child = /^ {10}([A-Za-z0-9_-]+):(?:\s(.*))?$/.exec(line);
    if (child && current) {
      const container = current.nestedContainer;
      assert.ok(container, `workflow step ${current.position + 1} has an unowned nested field`);
      assert.equal(
        Object.hasOwn(current.nested[container], child[1]),
        false,
        `workflow step ${current.position + 1} must not repeat ${container}.${child[1]}`,
      );
      current.nested[container][child[1]] = child[2] ?? "";
      continue;
    }
    if (/^ {10}/.test(line)) continue;
    assert.fail(`unsupported workflow step line: ${line}`);
  }
  assert.ok(steps.length > 0, "workflow job must declare at least one step");
  return steps;
}

export function requiredTrustedReleasePrefix(text, {
  label,
  checkoutInputs = {},
  checkoutAction,
  setupNodeAction,
  nodeVersion,
  preflightName,
  preflightRun,
  runsOn,
}) {
  let workflow;
  try {
    workflow = yaml.safeLoad(text);
  } catch (error) {
    assert.fail(`${label} must be valid, unambiguous YAML: ${error.message}`);
  }
  assert.ok(workflow && typeof workflow === "object" && !Array.isArray(workflow), `${label} must be a YAML mapping`);
  for (const field of ["env", "defaults"]) {
    assert.equal(Object.hasOwn(workflow, field), false, `${label} workflow must not set ${field}`);
  }
  const job = workflow.jobs?.build;
  assert.ok(job && typeof job === "object" && !Array.isArray(job), `${label} must declare a build job mapping`);
  for (const field of ["env", "defaults", "container", "services", "continue-on-error"]) {
    assert.equal(Object.hasOwn(job, field), false, `${label} build job must not set ${field}`);
  }
  assert.equal(job["runs-on"], runsOn, `${label} build job must use the reviewed runs-on target`);

  const steps = job.steps;
  assert.ok(Array.isArray(steps), `${label} build job must declare a steps sequence`);
  const checkout = Object.keys(checkoutInputs).length > 0
    ? { uses: checkoutAction, with: checkoutInputs }
    : { uses: checkoutAction };
  const expectedPrefix = [
    checkout,
    { uses: setupNodeAction, with: { "node-version": nodeVersion, cache: "npm" } },
    { name: preflightName, run: preflightRun },
  ];
  assert.deepEqual(
    steps.slice(0, expectedPrefix.length),
    expectedPrefix,
    `${label} build job must begin with the exact reviewed checkout, setup-node, and policy steps`,
  );
  assert.equal(
    steps.filter((step) => step?.name === preflightName).length,
    1,
    `${label} Node policy preflight must be declared exactly once by name`,
  );
  assert.equal(
    steps.filter((step) => step?.run === preflightRun).length,
    1,
    `${label} Node policy preflight command must execute exactly once`,
  );
  return { workflow, job, steps, preflightPosition: 2 };
}

export function requiredUnconditionalStep(steps, expected) {
  const named = steps.filter((step) => step.fields.name === expected.name);
  assert.equal(named.length, 1, `${expected.label} must be declared exactly once by name`);
  const step = named[0];
  assert.equal(step.fields.run, expected.run, `${expected.label} command drifted`);
  for (const field of ["if", "continue-on-error", "working-directory", "env", "shell"]) {
    assert.equal(step.fields[field], undefined, `${expected.label} must not set ${field}`);
  }
  assert.deepEqual(
    Object.keys(step.fields).sort(),
    ["name", "run"],
    `${expected.label} may declare only the reviewed name and run fields`,
  );
  assert.equal(
    steps.filter((candidate) => candidate.fields.run === expected.run).length,
    1,
    `${expected.label} command must execute exactly once`,
  );
  return step;
}
