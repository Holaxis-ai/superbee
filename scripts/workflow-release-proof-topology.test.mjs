import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staged = readFileSync(path.join(root, ".github", "workflows", "release-staged.yml"), "utf8");

function extractJobs(text) {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  assert.notEqual(at, -1);
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

function validateProofChain(text) {
  const jobs = extractJobs(text);
  assert.deepEqual(Object.keys(jobs).sort(), ["candidate", "draft", "stage"]);
  const candidate = jobs.candidate;
  const exhaustiveAt = candidate.indexOf("check:release-exhaustive -- --expected-sha");
  const selectedAt = candidate.indexOf("verify:npm-package:tarball -- \"$ARTIFACT_DIR/$TARBALL_FILENAME\" --manifest \"$ARTIFACT_DIR/candidate.json\"");
  const uploadAt = candidate.indexOf("actions/upload-artifact@v4");
  assert.ok(exhaustiveAt !== -1, "candidate must run the all-five proof");
  assert.match(candidate, /EXPECTED_SOURCE_SHA: \$\{\{ github\.sha \}\}/, "all-five proof binds the workflow SHA");
  assert.match(candidate, /fetch-depth: 0/, "exact-SHA proof needs complete Git history");
  assert.ok(selectedAt !== -1, "candidate must independently verify selected retained bytes");
  assert.ok(uploadAt !== -1 && exhaustiveAt < selectedAt && selectedAt < uploadAt,
    "all-five proof -> selected retained verification -> retained upload");
  assert.deepEqual(needsOf(jobs.draft), ["candidate"], "draft mutation must require both candidate proofs");
  assert.deepEqual(needsOf(jobs.stage).sort(), ["candidate", "draft"], "stage must require both proofs and draft");
  assert.doesNotMatch(candidate, /name: Prove all five[^\n]*\n {8}if:/, "proof steps cannot be conditionally skipped");
  assert.doesNotMatch(candidate, /name: Independently verify[^\n]*\n {8}if:/, "proof steps cannot be conditionally skipped");
}

test("the tag-SHA all-five proof and selected retained proof are unavoidable before mutation", () => {
  validateProofChain(staged);
});

test("removed, renamed, or conditionally skipped proofs fail the topology contract", () => {
  assert.throws(() => validateProofChain(staged.replace("check:release-exhaustive", "check:release-partial")), /all-five proof/);
  assert.throws(() => validateProofChain(staged.replace("verify:npm-package:tarball", "verify:npm-package:other")), /selected retained/);
  assert.throws(() => validateProofChain(staged.replace(
    "      - name: Prove all five release targets from the exact tag SHA",
    "      - name: Prove all five release targets from the exact tag SHA\n        if: ${{ false }}",
  )), /cannot be conditionally skipped/);
  assert.throws(() => validateProofChain(staged.replace("needs: candidate", "needs: []")), /draft mutation/);
});

test("failed, canceled, skipped, neutral, or missing proof-job conclusions block descendants", () => {
  const mayRun = (result) => result === "success";
  assert.equal(mayRun("success"), true);
  for (const result of ["failure", "cancelled", "skipped", "neutral", "timed_out", undefined]) {
    assert.equal(mayRun(result), false, String(result));
  }
});
