/** Synthetic offline GitHub normalization double. Not an admitted or production provider profile. */
import { unsupportedContent } from "@superbee/core/source-engine";

export const GITHUB_FIELD_COVERAGE = Object.freeze({
  mapped: ["node_id", "number", "repository_url", "title", "html_url", "state", "state_reason", "type", "created_at", "updated_at", "closed_at", "labels", "assignees"],
  properties: ["number"],
  ignored: ["id", "url", "body", "user", "comments", "reactions", "locked", "active_lock_reason", "author_association", "closed_by", "draft", "performed_via_github_app", "milestone", "sub_issues_summary", "issue_field_values"],
  skipped: ["pull_request"],
});

/** Every explicit field is accounted for; navigation URLs are deliberately not followed. */
export function uncoveredGithubFields(issue) {
  const covered = new Set(Object.values(GITHUB_FIELD_COVERAGE).flat());
  return Object.keys(issue).filter((key) => !covered.has(key) && !key.endsWith("_url"));
}

/** Produce only the reviewed scalar and list paths; source descriptions and arbitrary fields stay out. */
export function normalizeGithubIssue(issue, parameters) {
  if (Object.hasOwn(issue, "pull_request")) return null;
  const repository = new URL(issue.repository_url);
  const expected = `/repos/${parameters.owner}/${parameters.repo}`;
  if (repository.origin !== "https://api.github.com" || repository.pathname !== expected || repository.search || repository.hash) {
    throw new Error("synthetic issue is outside the bound repository");
  }
  const normalized = {
    owner: parameters.owner, repo: parameters.repo, node_id: issue.node_id,
    repository: `${parameters.owner}/${parameters.repo}`,
    key: `${parameters.owner}/${parameters.repo}#${issue.number}`,
    labels: issue.labels.map((label) => typeof label === "string" ? label : label.name),
    assignees: issue.assignees.map((assignee) => `github:${assignee.login}`),
    number: issue.number, title: issue.title, html_url: issue.html_url, state: issue.state,
    state_key: issue.state_reason == null ? issue.state : `${issue.state}:${issue.state_reason}`,
    close_reason: issue.state === "closed" ? issue.state_reason : null,
    created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
  };
  if (typeof issue.type?.name === "string") normalized.type_name = issue.type.name;
  return normalized;
}

// Intentionally a one-page fixture: cursor/paging and actual GitHub transport belong to E1b.
export default {
  id: "github-issues", version: 1, kind: "extension",
  validateSpec(spec) {
    return spec !== null && typeof spec === "object" && !Array.isArray(spec) && Object.keys(spec).length === 0
      ? { ok: true, spec: {} } : { ok: false, errors: [{ path: "", message: "this fixture takes an empty spec" }] };
  },
  hostsFor: () => ["api.github.com"],
  async observe({ bound, transport }) {
    const { owner, repo } = bound.parameters;
    const response = await transport.request({
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&sort=updated&direction=asc&per_page=100`,
      method: "GET", headers: { accept: "application/vnd.github+json" },
    });
    let issues;
    try { issues = JSON.parse(response.body); } catch { unsupportedContent("invalid synthetic GitHub JSON"); }
    if (!Array.isArray(issues) || response.headers.link) unsupportedContent("fixture expects one complete issue page");
    const records = [];
    let skipped = 0;
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) unsupportedContent("issue must be an object");
      const normalized = normalizeGithubIssue(issue, bound.parameters);
      if (normalized) records.push(normalized); else skipped += 1;
    }
    return {
      records, nextCursor: null, more: false, complete: true,
      diagnostics: skipped ? [{ code: "PULL_REQUEST_SKIPPED", message: "pull requests excluded from synthetic issue listing", count: skipped }] : [],
    };
  },
};
