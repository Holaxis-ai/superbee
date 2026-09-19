import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateJson, evaluateResults } from "./evaluate.mjs";

const actionPath = path.dirname(fileURLToPath(import.meta.url));
const engine = ["runtime", "aliasing-host", "smoke-node-20", "distribution", "browser", "scripts"];
const hosted = ["scope", "check", "storage", "core", "browser", "application-tests"];
const windows = ["inputs", "consumer-build", "native-installed", "native-readme-build"];
const policyFor = (jobs) => jobs.map((job) => ({ job, required: true }));
const resultsFor = (jobs) => Object.fromEntries(jobs.map((job) => [job, { result: "success", outputs: {} }]));
const badStates = ["failure", "cancelled", "timed_out", "neutral", "pending", "", undefined, null, true, 1, {}, []];

for (const [repo, jobs] of Object.entries({ engine, hosted, windows })) {
  test(`${repo} policy requires every result and rejects all non-success states`, () => {
    const policy = policyFor(jobs);
    const good = resultsFor(jobs);
    assert.deepEqual(evaluateResults(good, policy), { ok: true, errors: [] });
    for (const job of jobs) {
      for (const result of [...badStates, "skipped"]) {
        assert.equal(evaluateResults({ ...good, [job]: { result } }, policy).ok, false, `${job}: ${String(result)}`);
      }
      for (const malformed of [null, [], "success", 1, {}, { outputs: { result: "success" } }]) {
        assert.equal(evaluateResults({ ...good, [job]: malformed }, policy).ok, false);
      }
      const missing = { ...good };
      delete missing[job];
      assert.equal(evaluateResults(missing, policy).ok, false);
      assert.equal(evaluateResults({ ...missing, [`${job}-renamed`]: good[job] }, policy).ok, false);
    }
    assert.equal(evaluateResults({ ...good, extra: { result: "success" } }, policy).ok, false);
  });
}

test("hosted truth table requires scope/check and validates every conditional selection", () => {
  const good = resultsFor(hosted);
  const policy = policyFor(hosted);
  for (const job of hosted.slice(2)) {
    for (const required of [true, false, "true", "false"]) {
      const selected = policy.map((row) => row.job === job ? { job, required } : row);
      for (const result of ["success", "skipped", ...badStates]) {
        assert.equal(
          evaluateResults({ ...good, [job]: { result } }, selected).ok,
          result === "success" || (result === "skipped" && [false, "false"].includes(required)),
          `${job}: ${required}/${String(result)}`,
        );
      }
    }
    for (const required of ["", "TRUE", "False", " false", "false ", 0, 1, null, undefined, {}, []]) {
      assert.equal(evaluateResults(good, policy.map((row) => row.job === job ? { job, required } : row)).ok, false);
    }
  }
  const skipped = { ...good };
  const unselected = policy.map((row) => {
    if (["scope", "check"].includes(row.job)) return row;
    skipped[row.job] = { result: "skipped" };
    return { ...row, required: "false" };
  });
  assert.equal(evaluateResults(skipped, unselected).ok, true);
  for (const job of ["scope", "check"]) {
    for (const result of ["skipped", ...badStates]) {
      assert.equal(evaluateResults({ ...skipped, [job]: { result } }, unselected).ok, false);
    }
    const missing = { ...skipped };
    delete missing[job];
    assert.equal(evaluateResults(missing, unselected).ok, false);
  }
});

test("malformed inputs, selectors, duplicates and unknown fields fail closed", () => {
  for (const needs of [null, [], true, "", 3]) {
    assert.equal(evaluateResults(needs, policyFor(["check"])).ok, false);
  }
  for (const policy of [null, {}, true, "", [], [null], [[]], [{}], [{ job: "check" }],
    [{ job: "check", required: true, fallback: true }], [{ job: "", required: true }],
    [{ job: "a b", required: true }], [{ job: 1, required: true }],
    [{ job: "check", required: true }, { job: "check", required: false }]]) {
    assert.equal(evaluateResults(resultsFor(["check"]), policy).ok, false);
  }
  for (const input of ["", "{", "undefined", undefined]) {
    assert.equal(evaluateJson(input, "[]").ok, false);
    assert.equal(evaluateJson("{}", input).ok, false);
  }
  assert.equal(evaluateResults({}, policyFor(["toString"])).ok, false, "prototype properties are not job results");
  assert.equal(evaluateResults({ check: Object.create({ result: "success" }) }, policyFor(["check"])).ok, false);
});

test("bundled composite runs from a foreign checkout and treats hostile input as inert data", async () => {
  const source = await readFile(path.join(actionPath, "action.yml"), "utf8");
  assert.match(source, /CI_GATE_ACTION_PATH: \$\{\{ github.action_path \}\}/);
  assert.match(source, /CI_GATE_NEEDS_JSON: \$\{\{ inputs.needs-json \}\}/);
  assert.match(source, /CI_GATE_POLICY_JSON: \$\{\{ inputs.policy-json \}\}/);
  const run = /^ {6}run: (.+)$/m.exec(source)?.[1];
  assert.equal(run, 'node "$CI_GATE_ACTION_PATH/evaluate.mjs"');
  assert.equal((source.match(/^    - /gm) ?? []).length, 1, "no extra action steps");
  assert.doesNotMatch(source, /\buses:|\bif:|continue-on-error|working-directory/);
  const scratch = await mkdtemp(path.join(tmpdir(), "ci-gate-foreign-"));
  try {
    await writeFile(path.join(scratch, "evaluate.mjs"), 'throw new Error("wrong evaluator")');
    const runAction = (needs, policy) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
      cwd: scratch, encoding: "utf8", env: { ...process.env, CI_GATE_ACTION_PATH: actionPath,
        CI_GATE_NEEDS_JSON: JSON.stringify(needs), CI_GATE_POLICY_JSON: JSON.stringify(policy) },
    });
    assert.equal(runAction(resultsFor(windows), policyFor(windows)).status, 0);
    const hostile = '$(touch OWNED)`touch OWNED`\n::error::payload';
    const alias = path.join(scratch, "action-alias");
    await symlink(actionPath, alias, "junction");
    const viaAlias = spawnSync(process.execPath, [path.join(alias, "evaluate.mjs")], {
      cwd: scratch, encoding: "utf8", env: { ...process.env, CI_GATE_NEEDS_JSON: "{}", CI_GATE_POLICY_JSON: "[]" },
    });
    assert.equal(viaAlias.status, 1, "a symlinked entrypoint must evaluate and reject malformed policy");
    const rejected = runAction({ check: { result: hostile } }, policyFor(["check"]));
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stderr, /^::error::/m, "untrusted newlines must not become workflow commands");
    assert.equal(runAction(resultsFor(["check"]), [{ job: hostile, required: true }]).status, 1);
    await assert.rejects(access(path.join(scratch, "OWNED")));
    for (const key of ["CI_GATE_NEEDS_JSON", "CI_GATE_POLICY_JSON"]) {
      const env = { ...process.env, CI_GATE_ACTION_PATH: actionPath,
        CI_GATE_NEEDS_JSON: JSON.stringify(resultsFor(["check"])), CI_GATE_POLICY_JSON: JSON.stringify(policyFor(["check"])) };
      env[key] = "{";
      assert.equal(spawnSync("bash", ["-c", run], { cwd: scratch, env }).status, 1);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
