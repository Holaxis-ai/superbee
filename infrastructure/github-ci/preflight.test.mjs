import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSnapshot, ENGINE, LEGACY_CHECKS, RELEASE_TAGS, SOURCE_FILES } from "./preflight.mjs";

function fixture() {
  const mainSha = "a".repeat(40);
  const run = (names) => ({ event: "push", head_sha: mainSha, status: "completed", conclusion: "success", jobs: names.map((name) => ({ name, head_sha: mainSha, status: "completed", conclusion: "success" })) });
  return {
    repository: ENGINE, defaultBranch: "main", mainSha, reviewedSha: "b".repeat(40), comparison: "ahead", clean: true,
    matchingFiles: Object.fromEntries(SOURCE_FILES.map((file) => [file, true])),
    protection: { required_status_checks: { strict: true, checks: LEGACY_CHECKS.map((context) => ({ context, app_id: 15368 })) } },
    engineRulesets: [{ id: 20914366, enforcement: "active", target: "tag", source_type: "Repository", source: ENGINE,
      conditions: { ref_name: { include: [...RELEASE_TAGS], exclude: [] } }, bypass_actors: [], rules: [{ type: "update" }, { type: "deletion" }] }], windowsRulesets: [],
    workflows: { "ci-tests.yml": run(["CI required lanes", ...LEGACY_CHECKS]), "codeql.yml": run(["CodeQL required analyses"]) },
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
