import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./ci-lanes.json", import.meta.url)), "utf8"));

export const REQUIRED_JOBS = Object.freeze([...manifest.required_jobs]);

export function evaluateRequiredResults(results, expectedJobs = REQUIRED_JOBS) {
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    return { ok: false, errors: ["required job results are missing or malformed"] };
  }

  const expected = [...expectedJobs].sort();
  const actual = Object.keys(results).sort();
  const errors = [];
  for (const missing of expected.filter((name) => !actual.includes(name))) {
    errors.push(`missing required job result: ${missing}`);
  }
  for (const unexpected of actual.filter((name) => !expected.includes(name))) {
    errors.push(`unexpected required job result: ${unexpected}`);
  }
  for (const name of expected) {
    const result = results[name]?.result;
    if (result !== "success") errors.push(`${name}: expected success, received ${String(result)}`);
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  let results;
  try {
    results = JSON.parse(process.env.REQUIRED_RESULTS_JSON ?? "");
  } catch {
    console.error("required CI result payload is missing or invalid JSON");
    process.exitCode = 1;
    return;
  }
  const verdict = evaluateRequiredResults(results);
  if (!verdict.ok) {
    for (const error of verdict.errors) console.error(`required CI lane rejected: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`all ${REQUIRED_JOBS.length} required CI lanes succeeded`);
}

if (isMainModule(import.meta.url)) main();
