import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE = "Holaxis-ai/superbee";
export const WINDOWS = "Holaxis-ai/superbee-windows-cli";
export const LEGACY_CHECKS = [
  "gate (node 22)",
  "gate (node 26)",
  "built-CLI smoke on the engines floor (node 20)",
];
export const SOURCE_FILES = [
  ".github/workflows/ci-tests.yml",
  ".github/workflows/codeql.yml",
  ".github/actions/ci-gate/action.yml",
  ".github/actions/ci-gate/evaluate.mjs",
  ".github/codeql/codeql-config.yml",
  "scripts/ci-aggregate.mjs",
  "scripts/ci-lanes.json",
  "infrastructure/github-ci/main.tf",
  "infrastructure/github-ci/.terraform.lock.hcl",
  "infrastructure/github-ci/preflight.mjs",
];
export const RELEASE_TAGS = ["refs/tags/v*", "refs/tags/libraries/v*", "refs/tags/cli/v*"];
const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const onMain = (comparison) => ["ahead", "identical"].includes(comparison);
const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && expected.every((value) => actual.includes(value));

// GitHub rewrites commit identities for squash/rebase merges. A merged PR binds
// the reviewed head to its integration commit; that commit must still be on main.
function isMergedReview(pr, reviewedSha) {
  return pr?.state === "closed" && typeof pr.merged_at === "string" && Number.isFinite(Date.parse(pr.merged_at)) &&
    pr.head?.sha === reviewedSha && pr.base?.ref === "main" && pr.base?.repo?.full_name === ENGINE && isSha(pr.merge_commit_sha);
}

function preservesReleaseTags(rule) {
  return rule?.id === 20914366 && rule.enforcement === "active" && rule.target === "tag" &&
    rule.source_type === "Repository" && rule.source === ENGINE &&
    sameSet(rule.conditions?.ref_name?.include, RELEASE_TAGS) && sameSet(rule.conditions?.ref_name?.exclude, []) &&
    sameSet(rule.bypass_actors, []) && Array.isArray(rule.rules) &&
    ["update", "deletion"].every((type) => rule.rules.some((entry) => entry?.type === type));
}
const WORKFLOWS = {
  "ci-tests.yml": ["CI required lanes", ...LEGACY_CHECKS],
  "codeql.yml": ["CodeQL required analyses"],
};

// The preflight is advisory evidence for an exact saved-plan review, never an
// approval transport or an alternative writer of GitHub repository settings.
export function evaluateSnapshot(snapshot) {
  const errors = [];
  if (snapshot.repository !== ENGINE || snapshot.defaultBranch !== "main") {
    errors.push("unexpected repository or default branch");
  }
  if (!isSha(snapshot.mainSha) || !isSha(snapshot.reviewedSha)) {
    errors.push("missing exact source identities");
  }
  const mergedReview = Array.isArray(snapshot.mergedPullRequests) && snapshot.mergedPullRequests.some((pr) => isMergedReview(pr, snapshot.reviewedSha) && onMain(pr.mergeComparison));
  if (!onMain(snapshot.comparison) && !mergedReview) errors.push("reviewed source has no merged provenance on main");
  if (!snapshot.clean) errors.push("reviewed checkout has uncommitted changes");
  for (const file of SOURCE_FILES) {
    if (snapshot.matchingFiles?.[file] !== true) errors.push(`main differs from reviewed source: ${file}`);
  }
  const protection = snapshot.protection?.required_status_checks;
  if (protection?.strict !== true) errors.push("legacy strict branch protection changed");
  for (const context of LEGACY_CHECKS) {
    if (!protection?.checks?.some((check) => check.context === context && check.app_id === 15368)) {
      errors.push(`legacy Actions-owned required check missing: ${context}`);
    }
  }
  if (!Array.isArray(snapshot.engineRulesets) || !snapshot.engineRulesets.some(preservesReleaseTags)) {
    errors.push("existing release-tag protection changed or is incomplete");
  }
  if (!Array.isArray(snapshot.windowsRulesets) || snapshot.windowsRulesets.some((rule) => !rule || !["active", "disabled", "evaluate"].includes(rule.enforcement) || !Array.isArray(rule.rules))) errors.push("Windows ruleset inventory missing or incomplete");
  else if (snapshot.windowsRulesets.some((rule) => rule.enforcement === "active" && rule.rules?.some((entry) => entry.type === "merge_queue"))) {
    errors.push("Windows has an active merge queue");
  }
  const queueRules = Array.isArray(snapshot.engineRulesets) ? snapshot.engineRulesets.filter((rule) => rule?.name === "Superbee merge queue") : [];
  if (queueRules.length > 1) errors.push("multiple engine queue rulesets require reconciliation");
  for (const [file, requiredNames] of Object.entries(WORKFLOWS)) {
    const run = snapshot.workflows?.[file];
    if (run?.event !== "push" || run.head_sha !== snapshot.mainSha || run.status !== "completed" || run.conclusion !== "success") {
      errors.push(`latest main push workflow is not successful: ${file}`);
      continue;
    }
    for (const name of requiredNames) {
      const jobs = run.jobs?.filter((job) => job.name === name) ?? [];
      if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success" || jobs[0].head_sha !== snapshot.mainSha) {
        errors.push(`required status not proven on main: ${name}`);
      }
    }
  }
  return { ready: errors.length === 0, errors, mainSha: snapshot.mainSha, reviewedSha: snapshot.reviewedSha };
}

function api(endpoint) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

function paged(endpoint, field) {
  const values = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = field ? response[field] : response;
    if (!Array.isArray(rows)) throw new Error("provider returned an incomplete inventory");
    values.push(...rows);
    if (rows.length < 100) return values;
  }
  throw new Error("provider inventory exceeds preflight bound");
}

function rulesets(repository) {
  return paged(`repos/${repository}/rulesets`).map((rule) => api(`repos/${repository}/rulesets/${rule.id}`));
}

export function collectSnapshot(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const reviewedSha = git("rev-parse", "HEAD");
  const repository = api(`repos/${ENGINE}`);
  const mainSha = api(`repos/${ENGINE}/commits/main`).sha;
  const comparison = api(`repos/${ENGINE}/compare/${reviewedSha}...${mainSha}`).status;
  const mergedPullRequests = onMain(comparison) ? [] : paged(`repos/${ENGINE}/commits/${reviewedSha}/pulls`)
    .filter((pr) => isMergedReview(pr, reviewedSha))
    .map((pr) => ({ ...pr, mergeComparison: api(`repos/${ENGINE}/compare/${pr.merge_commit_sha}...${mainSha}`).status }));
  const matchingFiles = {};
  for (const file of SOURCE_FILES) {
    const remote = api(`repos/${ENGINE}/contents/${file}?ref=${mainSha}`);
    matchingFiles[file] = remote.encoding === "base64" && Buffer.from(remote.content, "base64").equals(readFileSync(path.join(root, file)));
  }
  const workflows = {};
  for (const file of Object.keys(WORKFLOWS)) {
    const runs = paged(`repos/${ENGINE}/actions/workflows/${file}/runs?event=push&head_sha=${mainSha}`, "workflow_runs");
    const latest = runs.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
    workflows[file] = latest ? { ...latest, jobs: paged(`repos/${ENGINE}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs`, "jobs") } : null;
  }
  return {
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    mainSha,
    reviewedSha,
    comparison,
    mergedPullRequests,
    clean: git("status", "--porcelain", "--untracked-files=all") === "",
    matchingFiles,
    protection: api(`repos/${ENGINE}/branches/main/protection`),
    engineRulesets: rulesets(ENGINE),
    windowsRulesets: rulesets(WINDOWS),
    workflows,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const verdict = evaluateSnapshot(collectSnapshot(root));
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.ready) process.exitCode = 1;
  } catch (error) {
    console.error(`Queue readiness is unknown: ${error.message}`);
    process.exitCode = 1;
  }
}
