import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateResults } from "../.github/actions/ci-gate/evaluate.mjs";
import { isMainModule } from "./is-main-module.mjs";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./ci-lanes.json", import.meta.url)), "utf8"));

export const REQUIRED_JOBS = Object.freeze([...manifest.required_jobs]);

export function evaluateRequiredResults(results, expectedJobs = REQUIRED_JOBS) {
  return evaluateResults(results, expectedJobs.map((job) => ({ job, required: true })));
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
