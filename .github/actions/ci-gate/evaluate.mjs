import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const jobName = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// The caller owns scope provenance and must include its scope job as unconditionally required.
// This primitive owns complete job-set matching and the result/selection decision table.
export function evaluateResults(results, policy) {
  if (!isRecord(results)) {
    return { ok: false, errors: ["required job results are missing or malformed"] };
  }
  if (!Array.isArray(policy) || policy.length === 0) {
    return { ok: false, errors: ["job policy must be a nonempty array"] };
  }

  const errors = [];
  const expected = new Map();
  for (const [index, row] of policy.entries()) {
    if (!isRecord(row) || Object.keys(row).sort().join(",") !== "job,required" ||
        typeof row.job !== "string" || !jobName.test(row.job)) {
      errors.push(`malformed job policy at index ${index}`);
      continue;
    }
    if (expected.has(row.job)) {
      errors.push(`duplicate job policy: ${row.job}`);
      continue;
    }
    if (![true, false, "true", "false"].includes(row.required)) {
      errors.push(`${row.job}: required must be a boolean or exact true/false string`);
      continue;
    }
    expected.set(row.job, row.required === true || row.required === "true");
  }
  for (const name of Object.keys(results).sort()) {
    if (!expected.has(name)) errors.push(`unexpected required job result: ${JSON.stringify(name)}`);
  }
  for (const [name, required] of expected) {
    if (!Object.hasOwn(results, name)) errors.push(`missing required job result: ${name}`);
    const record = Object.hasOwn(results, name) ? results[name] : undefined;
    const result = isRecord(record) && Object.hasOwn(record, "result") ? record.result : undefined;
    if (result !== "success" && (required || result !== "skipped")) {
      // Serialize data before logging so embedded newlines cannot create workflow commands.
      errors.push(`${name}: expected ${required ? "success" : "success or skipped"}, received ${JSON.stringify(result) ?? "undefined"}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateJson(needsJson, policyJson) {
  let results;
  let policy;
  try {
    results = JSON.parse(needsJson);
    policy = JSON.parse(policyJson);
  } catch {
    return { ok: false, errors: ["CI gate inputs must both be valid JSON"] };
  }
  return evaluateResults(results, policy);
}

function main() {
  const verdict = evaluateJson(process.env.CI_GATE_NEEDS_JSON ?? "", process.env.CI_GATE_POLICY_JSON ?? "");
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error(`required CI lane rejected: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("all declared CI lanes satisfied their policy");
  }
}

// A composite is distributed without repository scripts. Resolve both paths here so a symlinked
// action directory cannot accidentally turn CLI execution into a successful, inert import.
if (process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
