import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(root, ".github", "workflows");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const dependabot = readFileSync(path.join(root, ".github", "dependabot.yml"), "utf8");

// This reviewed literal is deliberately independent of the mutable registry. A pin renewal must
// update both authorities after the proposed upstream tag and commit have been inspected.
const REVIEWED_PINS = [
  { key: "attest_build_provenance_v4", identity: "actions/attest-build-provenance", revision: "4d101475d8b20a2381f78447822ac1eab6504dd8", version: "v4.2.2" },
  { key: "cache_restore_v4", identity: "actions/cache/restore", revision: "0057852bfaa89a56745cba8c7296529d2fc39830", version: "v4.3.0" },
  { key: "cache_save_v4", identity: "actions/cache/save", revision: "0057852bfaa89a56745cba8c7296529d2fc39830", version: "v4.3.0" },
  { key: "checkout_v4", identity: "actions/checkout", revision: "11d5960a326750d5838078e36cf38b85af677262", version: "v4.4.0" },
  { key: "checkout_v7", identity: "actions/checkout", revision: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  { key: "codeql_analyze_v4", identity: "github/codeql-action/analyze", revision: "cdf488f595d80d6e07e03d4674febd5ab45fa938", version: "v4.37.9" },
  { key: "codeql_init_v4", identity: "github/codeql-action/init", revision: "cdf488f595d80d6e07e03d4674febd5ab45fa938", version: "v4.37.9" },
  { key: "download_artifact_v8", identity: "actions/download-artifact", revision: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" },
  { key: "setup_node_v4", identity: "actions/setup-node", revision: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" },
  { key: "setup_node_v7", identity: "actions/setup-node", revision: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" },
  { key: "upload_artifact_v4", identity: "actions/upload-artifact", revision: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" },
  { key: "upload_artifact_v7", identity: "actions/upload-artifact", revision: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" },
];

const REMOTE_ACTION = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{40})$/;
const CANONICAL_REMOTE_LINE = /^\s*(?:-\s+)?uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/;
const CANONICAL_LOCAL_LINE = /^\s*(?:-\s+)?uses:\s+(\.\/\S+)\s*(?:#.*)?$/;
const ANY_USES_KEY = /^\s*(?:-\s*)?uses\s*:|[{,]\s*(?:["']uses["']|uses)\s*:/;
const ALIASED_MAPPING = /^\s*(?:-\s*)?(?:<<:\s*)?\*[A-Za-z0-9_-]+\s*$/;

function yamlMapping(text, subject) {
  let parsed;
  try {
    parsed = yaml.safeLoad(text);
  } catch (error) {
    assert.fail(`${subject} must be valid YAML: ${error.message}`);
  }
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${subject} must be a YAML mapping`);
  return parsed;
}

function workflowTexts() {
  return new Map(
    readdirSync(workflowDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => [name, readFileSync(path.join(workflowDirectory, name), "utf8")]),
  );
}

function semanticUses(text, subject) {
  const document = yamlMapping(text, subject);
  const found = [];
  const jobs = document.jobs;
  if (jobs === undefined) return found;
  assert.ok(jobs && typeof jobs === "object" && !Array.isArray(jobs), `${subject} jobs must be a mapping`);
  const add = (value, location) => {
    assert.equal(typeof value, "string", `${subject} ${location} uses must be a scalar string`);
    found.push({ value, location });
  };
  for (const [jobName, job] of Object.entries(jobs)) {
    assert.ok(job && typeof job === "object" && !Array.isArray(job), `${subject} job ${jobName} must be a mapping`);
    if (Object.hasOwn(job, "uses")) add(job.uses, `jobs.${jobName}`);
    if (job.steps === undefined) continue;
    assert.ok(Array.isArray(job.steps), `${subject} jobs.${jobName}.steps must be an array`);
    job.steps.forEach((step, index) => {
      assert.ok(step && typeof step === "object" && !Array.isArray(step), `${subject} jobs.${jobName}.steps[${index}] must be a mapping`);
      if (Object.hasOwn(step, "uses")) add(step.uses, `jobs.${jobName}.steps[${index}]`);
    });
  }
  return found;
}

function canonicalRemoteUses(text, subject) {
  const lines = text.split(/\r?\n/);
  const found = [];
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsAt === -1) return found;
  let inJob = false;
  let inSteps = false;
  let inStep = false;

  const inspectUsesLine = (line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const remote = line.match(CANONICAL_REMOTE_LINE);
    if (remote) {
      found.push({ value: `${remote[1]}@${remote[2]}`, version: remote[3], line: index + 1 });
      return;
    }
    if (CANONICAL_LOCAL_LINE.test(line)) return;
    if (ANY_USES_KEY.test(line)) {
      assert.fail(`${subject}:${index + 1} uses fields must use canonical same-line action@sha # vX.Y.Z syntax`);
    }
  };

  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) break;
    assert.doesNotMatch(line, ALIASED_MAPPING, `${subject}:${index + 1} aliased workflow mappings are not canonical uses sources`);

    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      inJob = true;
      inSteps = false;
      inStep = false;
      continue;
    }
    if (!inJob) continue;
    if (/^ {4}uses\s*:/.test(line)) {
      inspectUsesLine(line, index);
      continue;
    }
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      inStep = false;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inSteps = false;
      inStep = false;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {6}-\s*/.test(line)) {
      inStep = true;
      if (/^ {6}-\s*uses\s*:/.test(line)) inspectUsesLine(line, index);
      continue;
    }
    if (inStep && /^ {8}uses\s*:/.test(line)) inspectUsesLine(line, index);
  }
  return found;
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function validateRegistry(pins, reviewedPins) {
  assert.ok(Array.isArray(pins), "manifest github_actions.pins must be an array");
  assert.deepEqual(pins, reviewedPins, "manifest action registry must equal the independent reviewed pin table");
  const keys = new Set();
  const pairs = new Set();
  for (const row of pins) {
    assert.deepEqual(Object.keys(row), ["key", "identity", "revision", "version"], `invalid registry row ${row.key ?? "<missing key>"}`);
    assert.match(row.key, /^[a-z0-9_]+$/, "registry keys must be stable lowercase identifiers");
    assert.match(`${row.identity}@${row.revision}`, REMOTE_ACTION, `invalid immutable registry row ${row.key}`);
    assert.match(row.version, /^v\d+\.\d+\.\d+$/, `invalid semantic version for ${row.key}`);
    assert.equal(keys.has(row.key), false, `duplicate registry key ${row.key}`);
    keys.add(row.key);
    const pair = `${row.identity}@${row.revision}`;
    assert.equal(pairs.has(pair), false, `duplicate registry identity/revision pair ${pair}`);
    pairs.add(pair);
  }
  return new Map(pins.map((row) => [`${row.identity}@${row.revision}`, row]));
}

function validateDependabot(text) {
  const document = yamlMapping(text, "Dependabot configuration");
  assert.equal(document.version, 2, "Dependabot configuration must use version 2");
  assert.ok(Array.isArray(document.updates), "Dependabot updates must be an array");
  const actionUpdaters = document.updates.filter((entry) => entry?.["package-ecosystem"] === "github-actions");
  assert.equal(actionUpdaters.length, 1, "Dependabot must declare exactly one github-actions updater");
  const updater = actionUpdaters[0];
  assert.equal(updater.directory, "/", "github-actions Dependabot updater must cover the repository root");
  assert.equal(updater.schedule?.interval, "weekly", "github-actions Dependabot updater must run weekly");
  for (const option of ["ignore", "allow", "exclude-paths", "target-branch"]) {
    assert.equal(
      Object.hasOwn(updater, option),
      false,
      `github-actions Dependabot updater must not set ${option}`,
    );
  }
  if (Object.hasOwn(updater, "open-pull-requests-limit")) {
    assert.ok(updater["open-pull-requests-limit"] > 0, "github-actions Dependabot updater must not disable pull requests");
  }
  return actionUpdaters.length;
}

function validateActionPolicy({
  workflows = workflowTexts(),
  pins = manifest.github_actions?.pins,
  reviewedPins = REVIEWED_PINS,
  dependabotText = dependabot,
} = {}) {
  const registry = validateRegistry(pins, reviewedPins);
  const semanticRemote = [];
  const canonicalRemote = [];
  for (const [name, text] of workflows) {
    for (const occurrence of semanticUses(text, name)) {
      if (occurrence.value.startsWith("./")) continue;
      const match = occurrence.value.match(REMOTE_ACTION);
      assert.ok(match, `${name} ${occurrence.location} must use repository syntax with a full lowercase 40-hex revision`);
      assert.ok(registry.has(occurrence.value), `${name} ${occurrence.location} uses unreviewed action pin ${occurrence.value}`);
      semanticRemote.push(occurrence.value);
    }
    for (const occurrence of canonicalRemoteUses(text, name)) {
      const row = registry.get(occurrence.value);
      assert.ok(row, `${name}:${occurrence.line} documents an unreviewed action pin ${occurrence.value}`);
      assert.equal(occurrence.version, row.version, `${name}:${occurrence.line} version comment must match ${row.key}`);
      canonicalRemote.push(occurrence.value);
    }
  }
  assert.deepEqual(
    multiset(canonicalRemote),
    multiset(semanticRemote),
    "semantic remote uses must equal canonical same-line source uses as a multiset",
  );
  const observedPairs = new Set(semanticRemote);
  for (const pair of registry.keys()) assert.ok(observedPairs.has(pair), `registry row is not observed: ${pair}`);
  const identities = new Set(semanticRemote.map((value) => value.slice(0, value.lastIndexOf("@"))));
  return {
    remoteUses: semanticRemote.length,
    identities: identities.size,
    pairs: observedPairs.size,
    mutableRefs: 0,
    actionUpdaters: validateDependabot(dependabotText),
  };
}

const CHECKOUT_REF = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const CHECKOUT_LINE = `      - uses: ${CHECKOUT_REF} # v4.4.0`;
const fixtureWorkflow = (usesLine = CHECKOUT_LINE) => `name: fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${usesLine}\n`;
const fixturePins = [REVIEWED_PINS.find((row) => row.key === "checkout_v4")];
const fixturePolicy = (overrides = {}) => validateActionPolicy({
  workflows: new Map([["fixture.yml", fixtureWorkflow()]]),
  pins: fixturePins,
  reviewedPins: fixturePins,
  dependabotText: dependabot,
  ...overrides,
});

test("all workflows use 58 immutable reviewed references across 9 identities and 12 pairs", () => {
  assert.deepEqual(validateActionPolicy(), {
    remoteUses: 58,
    identities: 9,
    pairs: 12,
    mutableRefs: 0,
    actionUpdaters: 1,
  });
});

test("remote references fail closed on ref, identity, registry, and source-comment drift", () => {
  const otherSha = "a".repeat(40);
  const newRef = `actions/checkout@${otherSha}`;
  const staleRow = { key: "checkout_v5", identity: "actions/checkout", revision: otherSha, version: "v5.0.0" };
  for (const [label, run, expected] of [
    ["mutable ref", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow("      - uses: actions/checkout@v4 # v4.4.0")]]) }), /full lowercase 40-hex revision|canonical/],
    ["abbreviated SHA", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow("      - uses: actions/checkout@11d5960 # v4.4.0")]]) }), /full lowercase 40-hex revision|canonical/],
    ["expression ref", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow("      - uses: actions/checkout@${{ inputs.revision }} # v4.4.0")]]) }), /full lowercase 40-hex revision|canonical/],
    ["unsupported remote form", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow("      - uses: docker://alpine:3.20 # v3.20.0")]]) }), /full lowercase 40-hex revision|canonical/],
    ["different SHA", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: ${newRef} # v4.4.0`)]]) }), /unreviewed action pin/],
    ["changed identity", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(CHECKOUT_LINE.replace("actions/checkout", "attacker/checkout"))]]) }), /unreviewed action pin/],
    ["new identity", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: owner/new-action@${otherSha} # v1.0.0`)]]) }), /unreviewed action pin/],
    ["missing registry row", () => fixturePolicy({ pins: [], reviewedPins: [] }), /unreviewed action pin/],
    ["stale registry row", () => fixturePolicy({ pins: [...fixturePins, staleRow], reviewedPins: [...fixturePins, staleRow] }), /registry row is not observed/],
    ["coordinated workflow and manifest drift", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: ${newRef} # v4.5.0`)]]), pins: [{ ...fixturePins[0], revision: otherSha, version: "v4.5.0" }] }), /independent reviewed pin table/],
    ["missing comment", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: ${CHECKOUT_REF}`)]]) }), /canonical same-line/],
    ["misplaced comment", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      # v4.4.0\n      - uses: ${CHECKOUT_REF}`)]]) }), /canonical same-line/],
    ["quoted value", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: "${CHECKOUT_REF}" # v4.4.0`)]]) }), /canonical same-line/],
    ["multiline value", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      - uses: >-\n          ${CHECKOUT_REF} # v4.4.0`)]]) }), /full lowercase 40-hex revision|canonical same-line/],
    ["wrong version comment", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(CHECKOUT_LINE.replace("v4.4.0", "v4.3.0"))]]) }), /version comment must match/],
    ["comment decoy", () => fixturePolicy({ workflows: new Map([["fixture.yml", fixtureWorkflow(`      # uses: ${CHECKOUT_REF} # v4.4.0\n      - uses: ${CHECKOUT_REF}`)]]) }), /canonical same-line/],
  ]) assert.throws(run, expected, label);

  const aliasWorkflow = `name: fixture\non: push\nx-action: &action ${CHECKOUT_REF}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: *action\n`;
  assert.throws(() => fixturePolicy({ workflows: new Map([["fixture.yml", aliasWorkflow]]) }), /canonical same-line/, "aliased value");

  const mergedAliasWorkflow = `name: fixture\non: push\nx-step: &step\n  uses: ${CHECKOUT_REF} # v4.4.0\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - <<: *step\n`;
  assert.throws(() => fixturePolicy({ workflows: new Map([["fixture.yml", mergedAliasWorkflow]]) }), /aliased workflow mappings/, "aliased mapping");

  const rootJobAliasWorkflow = `name: fixture\non: push\nx-job: &job\n  runs-on: ubuntu-latest\n  steps:\n    - uses: ${CHECKOUT_REF} # v4.4.0\njobs:\n  check: *job\n`;
  assert.throws(
    () => fixturePolicy({ workflows: new Map([["fixture.yml", rootJobAliasWorkflow]]) }),
    /semantic remote uses must equal canonical same-line source uses/,
    "root job mapping alias",
  );

  const flowMergeWorkflow = `name: fixture\non: push\nx-step: &step\n  uses: ${CHECKOUT_REF} # v4.4.0\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - { <<: *step }\n`;
  assert.throws(
    () => fixturePolicy({ workflows: new Map([["fixture.yml", flowMergeWorkflow]]) }),
    /semantic remote uses must equal canonical same-line source uses/,
    "flow-form merged step",
  );
});

test("semantic traversal covers job-level reusable workflows and exempts local actions", () => {
  const reusableRow = { key: "reusable_v1", identity: "owner/repository/.github/workflows/reusable.yml", revision: "b".repeat(40), version: "v1.2.3" };
  const reusable = `name: reusable\non: push\njobs:\n  call:\n    uses: ${reusableRow.identity}@${reusableRow.revision} # v1.2.3\n`;
  assert.equal(fixturePolicy({ workflows: new Map([["reusable.yml", reusable]]), pins: [reusableRow], reviewedPins: [reusableRow] }).remoteUses, 1);
  assert.throws(
    () => fixturePolicy({ workflows: new Map([["reusable.yml", reusable.replace(reusableRow.revision, "v1")]]), pins: [reusableRow], reviewedPins: [reusableRow] }),
    /full lowercase 40-hex revision|canonical/,
  );

  const local = "name: local\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/local\n";
  assert.deepEqual(fixturePolicy({ workflows: new Map([["local.yml", local]]), pins: [], reviewedPins: [] }), {
    remoteUses: 0,
    identities: 0,
    pairs: 0,
    mutableRefs: 0,
    actionUpdaters: 1,
  });
});

test("registry keys and identity/revision pairs are unique", () => {
  const duplicateKey = { ...fixturePins[0], revision: "d".repeat(40) };
  assert.throws(
    () => fixturePolicy({ pins: [...fixturePins, duplicateKey], reviewedPins: [...fixturePins, duplicateKey] }),
    /duplicate registry key/,
  );
  const duplicatePair = { ...fixturePins[0], key: "checkout_duplicate_v4" };
  assert.throws(
    () => fixturePolicy({ pins: [...fixturePins, duplicatePair], reviewedPins: [...fixturePins, duplicatePair] }),
    /duplicate registry identity\/revision pair/,
  );
});

test("Dependabot has one effective root weekly updater and permits distinct ecosystems", () => {
  const base = "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n";
  for (const [label, text, expected] of [
    ["missing", "version: 2\nupdates: []\n", /exactly one/],
    ["duplicate", `${base}  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n`, /exactly one/],
    ["wrong directory", base.replace("directory: /", "directory: /.github/workflows"), /repository root/],
    ["wrong interval", base.replace("interval: weekly", "interval: monthly"), /run weekly/],
    ["ignored action", `${base}    ignore:\n      - dependency-name: actions/checkout\n`, /must not set ignore/],
    ["allow list", `${base}    allow:\n      - dependency-name: actions/checkout\n`, /must not set allow/],
    ["excluded paths", `${base}    exclude-paths:\n      - .github\/workflows\/**\n`, /must not set exclude-paths/],
    ["redirected branch", `${base}    target-branch: maintenance\n`, /must not set target-branch/],
    ["disabled PRs", `${base}    open-pull-requests-limit: 0\n`, /must not disable/],
  ]) assert.throws(() => fixturePolicy({ dependabotText: text }), expected, label);

  const withNpm = `${base}  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n`;
  assert.equal(fixturePolicy({ dependabotText: withNpm }).actionUpdaters, 1);
});

test("invalid YAML and non-mapping workflow roots fail closed", () => {
  assert.throws(() => fixturePolicy({ workflows: new Map([["invalid.yml", "jobs: [\n"]]) }), /valid YAML/);
  assert.throws(() => fixturePolicy({ workflows: new Map([["list.yml", "- jobs\n"]]) }), /YAML mapping/);
});

test("a reviewed coordinated renewal of workflow, registry, and literal passes", () => {
  const renewedSha = "c".repeat(40);
  const renewedVersion = "v4.5.0";
  const renewedWorkflows = new Map(
    [...workflowTexts()].map(([name, text]) => [name, text.replaceAll(`${CHECKOUT_REF} # v4.4.0`, `actions/checkout@${renewedSha} # ${renewedVersion}`)]),
  );
  const renew = (row) => row.key === "checkout_v4" ? { ...row, revision: renewedSha, version: renewedVersion } : row;
  assert.deepEqual(validateActionPolicy({
    workflows: renewedWorkflows,
    pins: manifest.github_actions.pins.map(renew),
    reviewedPins: REVIEWED_PINS.map(renew),
  }), {
    remoteUses: 58,
    identities: 9,
    pairs: 12,
    mutableRefs: 0,
    actionUpdaters: 1,
  });
});
