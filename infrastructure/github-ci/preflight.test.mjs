import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSnapshot, evaluateSnapshot, ENGINE, WINDOWS, LEGACY_CHECKS, RELEASE_TAGS, SOURCE_FILES, WORKFLOW_JOBS } from "./preflight.mjs";

function fixture() {
  const mainSha = "a".repeat(40);
  const run = (names) => ({ event: "push", head_sha: mainSha, status: "completed", conclusion: "success", jobs: names.map((name) => ({ name, head_sha: mainSha, status: "completed", conclusion: "success" })) });
  return {
    repository: ENGINE, defaultBranch: "main", mainSha, reviewedSha: "b".repeat(40), comparison: "ahead", clean: true,
    matchingFiles: Object.fromEntries(SOURCE_FILES.map((file) => [file, true])),
    reviewedFiles: Object.fromEntries(SOURCE_FILES.map((file) => [file, { sha: "e".repeat(40), type: "blob", mode: "100644", checkoutMatches: true, indexVisible: true }])),
    protection: { required_status_checks: { strict: true, checks: LEGACY_CHECKS.map((context) => ({ context, app_id: 15368 })) } },
    engineRulesets: [{ id: 20914366, enforcement: "active", target: "tag", source_type: "Repository", source: ENGINE,
      conditions: { ref_name: { include: [...RELEASE_TAGS], exclude: [] } }, bypass_actors: [], rules: [{ type: "update" }, { type: "deletion" }] }], windowsRulesets: [],
    workflows: { ...Object.fromEntries(Object.entries(WORKFLOW_JOBS).map(([file, names]) => [file, run(names)])) },
  };
}

test("queue readiness requires reviewed main source and all main push evidence", () => {
  assert.equal(evaluateSnapshot(fixture()).ready, true);
});

for (const [name, mutate] of Object.entries({
  "wrong repository": (s) => { s.repository = "Holaxis-ai/superbee-windows-cli"; },
  "unmerged source": (s) => { s.comparison = "diverged"; },
  "dirty source": (s) => { s.clean = false; },
  "changed workflow": (s) => { s.matchingFiles[SOURCE_FILES[0]] = false; },
  "missing source comparison": (s) => { delete s.matchingFiles; },
  "missing Git source attestation": (s) => { delete s.reviewedFiles; },
  "missing reviewed blob": (s) => { delete s.reviewedFiles[SOURCE_FILES[0]].sha; },
  "nonregular reviewed source": (s) => { s.reviewedFiles[SOURCE_FILES[0]].mode = "120000"; },
  "checkout byte or mode mismatch": (s) => { s.reviewedFiles[SOURCE_FILES[0]].checkoutMatches = false; },
  "hidden source index flag": (s) => { s.reviewedFiles[SOURCE_FILES[0]].indexVisible = false; },
  "missing legacy protection": (s) => { delete s.protection; },
  "wrong check application": (s) => { s.protection.required_status_checks.checks[0].app_id = 1; },
  "weakened strict policy": (s) => { s.protection.required_status_checks.strict = false; },
  "lost tag protection": (s) => { s.engineRulesets = []; },
  "empty tag restrictions": (s) => { s.engineRulesets[0].rules = []; },
  "missing deletion restriction": (s) => { s.engineRulesets[0].rules.pop(); },
  "narrowed tag scope": (s) => { s.engineRulesets[0].conditions.ref_name.include = ["refs/tags/unrelated/*"]; },
  "tag scope exclusion": (s) => { s.engineRulesets[0].conditions.ref_name.exclude = ["refs/tags/v1*"]; },
  "tag bypass added": (s) => { s.engineRulesets[0].bypass_actors.push({ actor_id: 1, actor_type: "Integration", bypass_mode: "always" }); },
  "unknown tag bypasses": (s) => { delete s.engineRulesets[0].bypass_actors; },
  "wrong tag rule source": (s) => { s.engineRulesets[0].source = "other/repo"; },
  "malformed tag rule": (s) => { s.engineRulesets = [null]; },
  "malformed engine inventory": (s) => { s.engineRulesets = {}; },
  "unknown Windows inventory": (s) => { delete s.windowsRulesets; },
  "incomplete Windows inventory": (s) => { s.windowsRulesets = [{ enforcement: "active" }]; },
  "Windows queue enabled": (s) => { s.windowsRulesets = [{ enforcement: "active", rules: [{ type: "merge_queue" }] }]; },
  "duplicate engine queue": (s) => { s.engineRulesets.push({ name: "Superbee merge queue" }, { name: "Superbee merge queue" }); },
  "missing workflow run": (s) => { delete s.workflows["ci-tests.yml"]; },
  "stale successful run": (s) => { s.workflows["ci-tests.yml"].head_sha = "c".repeat(40); },
  "PR evidence only": (s) => { s.workflows["ci-tests.yml"].event = "pull_request"; },
  "failed latest attempt": (s) => { s.workflows["ci-tests.yml"].conclusion = "failure"; },
  "pending latest attempt": (s) => { s.workflows["ci-tests.yml"].status = "in_progress"; },
  "missing required status": (s) => { s.workflows["ci-tests.yml"].jobs.pop(); },
  "ambiguous status identity": (s) => { s.workflows["ci-tests.yml"].jobs.push(s.workflows["ci-tests.yml"].jobs[0]); },
  "skipped required status": (s) => { s.workflows["ci-tests.yml"].jobs[0].conclusion = "skipped"; },
  "stale job SHA": (s) => { s.workflows["ci-tests.yml"].jobs[0].head_sha = "d".repeat(40); },
  "failed CodeQL": (s) => { s.workflows["codeql.yml"].conclusion = "failure"; },
})) {
  test(`refuses activation evidence: ${name}`, () => {
    const snapshot = fixture(); mutate(snapshot);
    assert.equal(evaluateSnapshot(snapshot).ready, false);
  });
}

function squashFixture() {
  const snapshot = fixture();
  snapshot.comparison = "diverged";
  snapshot.mergedPullRequests = [{ state: "closed", merged_at: "2026-09-19T22:22:28Z", head: { sha: snapshot.reviewedSha },
    base: { ref: "main", repo: { full_name: ENGINE } }, merge_commit_sha: "c".repeat(40), mergeComparison: "ahead" }];
  return snapshot;
}

test("accepts rewritten squash/rebase identity only with merged PR and integration ancestry", () => {
  for (const comparison of ["ahead", "identical"]) {
    const snapshot = squashFixture(); snapshot.mergedPullRequests[0].mergeComparison = comparison;
    assert.equal(evaluateSnapshot(snapshot).ready, true);
  }
});

for (const [name, mutate] of Object.entries({
  "open PR": (s) => { s.mergedPullRequests[0].state = "open"; },
  "unmerged closed PR": (s) => { s.mergedPullRequests[0].merged_at = null; },
  "wrong reviewed head": (s) => { s.mergedPullRequests[0].head.sha = "d".repeat(40); },
  "wrong base": (s) => { s.mergedPullRequests[0].base.ref = "other"; },
  "wrong base repository": (s) => { s.mergedPullRequests[0].base.repo.full_name = "other/repo"; },
  "missing integration SHA": (s) => { delete s.mergedPullRequests[0].merge_commit_sha; },
  "integration removed from main": (s) => { s.mergedPullRequests[0].mergeComparison = "diverged"; },
  "unrelated receipt": (s) => { s.mergedPullRequests = [null]; },
  "source changed after merge": (s) => { s.matchingFiles[".github/codeql/codeql-config.yml"] = false; },
})) {
  test(`refuses rewritten provenance: ${name}`, () => {
    const snapshot = squashFixture(); mutate(snapshot);
    assert.equal(evaluateSnapshot(snapshot).ready, false);
  });
}


test("readiness inventory retains all maintained shards, lanes and security analyses", () => {
  assert.deepEqual(WORKFLOW_JOBS, {
    "ci-tests.yml": [
      "runtime compatibility (node 22, shard 1/2)", "runtime compatibility (node 22, shard 2/2)",
      "runtime compatibility (node 26, shard 1/2)", "runtime compatibility (node 26, shard 2/2)",
      "host-class proofs on an aliasing host (macos, node 26)",
      "built-CLI smoke on the engines floor (node 20)",
      "distribution package and installed behavior", "browser and UI", "repository scripts and CI topology",
      "CI required lanes", "gate (node 22)", "gate (node 26)",
    ],
    "codeql.yml": ["CodeQL JavaScript/TypeScript", "CodeQL GitHub Actions", "CodeQL required analyses"],
  });
});

for (const [file, names] of Object.entries(WORKFLOW_JOBS)) {
  for (const name of names) {
    test(`requires unique successful exact-main proof: ${name}`, () => {
      for (const mutate of [
        (jobs) => jobs.splice(jobs.findIndex((job) => job.name === name), 1),
        (jobs) => { jobs.find((job) => job.name === name).conclusion = "skipped"; },
        (jobs) => { jobs.find((job) => job.name === name).head_sha = "c".repeat(40); },
        (jobs) => jobs.push({ ...jobs.find((job) => job.name === name) }),
      ]) {
        const snapshot = fixture();
        mutate(snapshot.workflows[file].jobs);
        const verdict = evaluateSnapshot(snapshot);
        assert.equal(verdict.ready, false);
        assert.ok(verdict.errors.includes(`required status not proven on main: ${name}`));
      }
    });
  }
}

function collectedFixture(mutate = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "engine-source-test-"));
  const bin = mkdtempSync(path.join(os.tmpdir(), "engine-source-gh-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const previousPath = process.env.PATH;
  try {
    for (const file of SOURCE_FILES) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `reviewed ${file}\n`);
    }
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "reviewed source");
    const reviewedSha = git("rev-parse", "HEAD");
    const mainSha = mutate({ root, git, reviewedSha }) ?? reviewedSha;
    const data = {};
    const snapshot = fixture();
    snapshot.mainSha = mainSha;
    data[`repos/${ENGINE}`] = { full_name: ENGINE, default_branch: "main" };
    data[`repos/${ENGINE}/commits/main`] = { sha: mainSha };
    data[`repos/${ENGINE}/compare/${reviewedSha}...${mainSha}`] = { status: mainSha === reviewedSha ? "identical" : "ahead" };
    for (const file of SOURCE_FILES) data[`repos/${ENGINE}/contents/${file}?ref=${mainSha}`] = {
      type: "file", encoding: "base64", content: execFileSync("git", ["-C", root, "show", `${mainSha}:${file}`]).toString("base64"),
    };
    for (const [file, names] of Object.entries(WORKFLOW_JOBS)) {
      const id = file === "ci-tests.yml" ? 1 : 2;
      data[`repos/${ENGINE}/actions/workflows/${file}/runs?event=push&head_sha=${mainSha}&per_page=100&page=1`] = { workflow_runs: [
        { id, run_number: 1, run_attempt: 1, event: "push", head_sha: mainSha, status: "completed", conclusion: "success" },
      ] };
      data[`repos/${ENGINE}/actions/runs/${id}/attempts/1/jobs?per_page=100&page=1`] = { jobs: names.map((name) => ({
        name, head_sha: mainSha, status: "completed", conclusion: "success",
      })) };
    }
    data[`repos/${ENGINE}/branches/main/protection`] = snapshot.protection;
    data[`repos/${ENGINE}/rulesets?per_page=100&page=1`] = [{ id: 20914366 }];
    data[`repos/${ENGINE}/rulesets/20914366`] = snapshot.engineRulesets[0];
    data[`repos/${WINDOWS}/rulesets?per_page=100&page=1`] = [];
    writeFileSync(path.join(bin, "data.json"), JSON.stringify(data));
    writeFileSync(path.join(bin, "gh"), '#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");const data=JSON.parse(fs.readFileSync(path.join(__dirname,"data.json")));const key=process.argv[3];if(!(key in data))process.exit(3);console.log(JSON.stringify(data[key]));\n', { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + previousPath;
    return collectSnapshot(root);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true });
  }
}

test("collector accepts clean owning source equal to reviewed Git blobs and main", () => {
  assert.equal(evaluateSnapshot(collectedFixture()).ready, true);
});

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`collector rejects hidden matching-main byte drift: ${flag}`, () => {
    const snapshot = collectedFixture(({ root, git, reviewedSha }) => {
      const file = SOURCE_FILES[0];
      writeFileSync(path.join(root, file), "unreviewed main source\n");
      git("add", file);
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "changed main source");
      const mainSha = git("rev-parse", "HEAD");
      git("reset", "--hard", reviewedSha);
      git("update-index", flag, file);
      writeFileSync(path.join(root, file), "unreviewed main source\n");
      assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
      assert.equal(git("merge-base", "--is-ancestor", reviewedSha, mainSha), "");
      return mainSha;
    });
    assert.equal(snapshot.clean, true);
    assert.equal(snapshot.matchingFiles[SOURCE_FILES[0]], false, "remote agreement must use reviewed blob, not disk");
    assert.equal(evaluateSnapshot(snapshot).ready, false);
  });
  test(`collector rejects hidden index flag even with unchanged bytes: ${flag}`, () => {
    const snapshot = collectedFixture(({ git }) => { git("update-index", flag, SOURCE_FILES[0]); });
    assert.equal(snapshot.clean, true);
    assert.equal(evaluateSnapshot(snapshot).ready, false);
  });
}

for (const [name, mutate] of Object.entries({
  "hidden byte drift with reviewed main": ({ root, git }) => { git("update-index", "--skip-worktree", SOURCE_FILES[0]); writeFileSync(path.join(root, SOURCE_FILES[0]), "changed checkout\n"); },
  "executable mode drift ignored by Git": ({ root, git }) => { git("config", "core.filemode", "false"); chmodSync(path.join(root, SOURCE_FILES[0]), 0o755); },
  "same-byte symlink": ({ root }) => { const file = path.join(root, SOURCE_FILES[0]); writeFileSync(path.join(root, "target"), readFileSync(file)); rmSync(file); symlinkSync(path.join(root, "target"), file); },
  "symlink parent directory": ({ root }) => { const directory = path.join(root, ".github/workflows"); const target = path.join(root, "workflow-target"); mkdirSync(target); for (const file of ["ci-tests.yml", "codeql.yml"]) writeFileSync(path.join(target, file), readFileSync(path.join(directory, file))); rmSync(directory, { recursive: true }); symlinkSync(target, directory); },
  "missing source": ({ root }) => rmSync(path.join(root, SOURCE_FILES[0])),
})) {
  test(`collector refuses checkout source type, mode or byte mismatch: ${name}`, () => {
    const snapshot = collectedFixture(mutate);
    assert.equal(snapshot.reviewedFiles[SOURCE_FILES[0]].checkoutMatches, false);
    assert.equal(evaluateSnapshot(snapshot).ready, false);
  });
}
