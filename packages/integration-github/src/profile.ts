/** Trusted provider adapter. Runtime services are supplied by the host. */
import type { ConnectorSource } from "@superbee/core/connectors";
import type { SourceProfile, ObserveContext } from "@superbee/core/source-engine";
import type { SourcePluginHelpers, RestJsonCursor } from "@superbee/core/source-profiles";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const GITHUB_FIELD_COVERAGE = Object.freeze({
  mapped: Object.freeze(["node_id", "number", "repository_url", "title", "html_url", "state", "state_reason", "type", "labels", "assignees", "created_at", "updated_at", "closed_at"]),
  properties: Object.freeze(["number"]),
  ignored: Object.freeze(["id", "url", "body", "user", "comments", "reactions", "locked", "active_lock_reason", "author_association", "closed_by", "draft", "performed_via_github_app", "milestone", "sub_issues_summary", "issue_field_values", "assignee", "repository"]),
  skipped: Object.freeze(["pull_request"]),
});

/** Navigation URLs are accounted for but never followed by the normalizer. */
export function uncoveredGithubFields(issue: Record<string, unknown>): string[] {
  const covered = new Set<string>(Object.values(GITHUB_FIELD_COVERAGE).flat());
  return Object.keys(issue).filter(key => !covered.has(key) && !key.endsWith("_url"));
}

/** GitHub REST issue projection; the singular assignee is deliberately ignored. */
export function normalizeGithubIssue(issue: Record<string, unknown>, parameters: Readonly<Record<string, string>>, {unsupportedContent}: Pick<SourcePluginHelpers, "unsupportedContent">): Record<string, unknown> | null {
  const {owner, repo} = parameters;
  const expected = `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
  if (!owner || !repo || issue.repository_url !== expected) unsupportedContent("issue outside bound repository");
  if (Object.hasOwn(issue, "pull_request")) return null;
  for (const name of ["node_id", "title", "html_url", "state", "created_at", "updated_at"]) {
    if (typeof issue[name] !== "string" || !issue[name]) unsupportedContent(`invalid issue ${name}`);
  }
  if (!Number.isSafeInteger(issue.number) || Number(issue.number) < 1) unsupportedContent("invalid issue number");
  for (const name of ["state_reason", "closed_at"]) if (issue[name] !== null && typeof issue[name] !== "string") unsupportedContent(`invalid issue ${name}`);
  if (!Array.isArray(issue.labels) || !Array.isArray(issue.assignees)) unsupportedContent("invalid issue lists");
  const names = (values: unknown[], key: string, prefix = ""): string[] => values.map(value => {
    const name = object(value) ? value[key] : key === "name" ? value : undefined;
    if (typeof name !== "string" || !name) unsupportedContent(`invalid issue ${key}`);
    return prefix + name;
  });
  const normalized: Record<string, unknown> = {
    owner, repo, node_id: issue.node_id, repository: `${owner}/${repo}`, key: `${owner}/${repo}#${issue.number}`,
    number: issue.number, title: issue.title, html_url: issue.html_url, state: issue.state,
    state_key: issue.state_reason === null ? issue.state : `${issue.state}:${issue.state_reason}`,
    close_reason: issue.state === "closed" ? issue.state_reason : null,
    labels: [...new Set(names(issue.labels as unknown[], "name"))].sort(),
    assignees: [...new Set(names(issue.assignees as unknown[], "login", "github:"))].sort(),
    created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
  };
  if (issue.type !== undefined && issue.type !== null) {
    if (!object(issue.type) || typeof issue.type.name !== "string" || !issue.type.name) unsupportedContent("invalid issue type");
    normalized.type_name = (issue.type as Record<string, unknown>).name;
  }
  return normalized;
}

/** Repository-scoped REST issues, sharing the declarative request and paging implementation. */
export function createSourceProfile(helpers: SourcePluginHelpers): SourceProfile<ConnectorSource, RestJsonCursor> {
  const {restJsonProfile, nextLinkTarget, unsupportedContent} = helpers;
  return Object.freeze({
  id: "github-issues", version: 1, kind: "extension",
  validateSpec(value: unknown) {
    const validated = restJsonProfile.validateSpec(value);
    if (!validated.ok) return validated;
    const source = validated.spec;
    const r = source.request!;
    const errors: Array<{path: string; message: string}> = [];
    const problem = (path: string, message: string) => { errors.push({path, message}); };
    if (source.identity.resource !== "https://github.com/{owner}/{repo}") problem("/identity/resource", "github-issues requires a repository identity");
    if (r.host !== "api.github.com" || r.method !== "GET" || r.path !== "/repos/{owner}/{repo}/issues" || r.items !== "") problem("/request", "github-issues requires the repository issues REST listing");
    if (r.paging?.kind !== "link-header" || r.complete !== "always" || r.query?.state !== "all") problem("/request", "github-issues requires state=all, Link paging and complete=always");
    if (r.paging && Object.keys(r.paging).some(key => key !== "kind")) problem("/request/paging", "github-issues uses provider Link paging only");
    if (r.query?.per_page !== undefined && (!Number.isSafeInteger(Number(r.query.per_page)) || Number(r.query.per_page) < 1 || Number(r.query.per_page) > 100)) problem("/request/query/per_page", "page size is an integer from 1 to 100");
    if (r.fields || r.skip || r.body || r.graphql) problem("/request", "github-issues owns provider normalization and filtering");
    if (Object.keys(r.query ?? {}).some(key => !["state", "sort", "direction", "per_page"].includes(key))) problem("/request/query", "unsupported issue filter or paging query");
    if (r.watermark && (r.watermark.field !== "updated_at" || r.watermark.param !== "since")) problem("/request/watermark", "github-issues watermark is updated_at through since");
    return errors.length ? {ok: false as const, errors} : validated;
  },
  hostsFor: () => ["api.github.com"],
  async observe(ctx: ObserveContext<ConnectorSource, RestJsonCursor>) {
    // Link page numbers are unstable between runs. Restart without claiming absence on resume.
    const page = await restJsonProfile.observe({...ctx, cursor: ctx.resumed ? null : ctx.cursor,
      transport: {request: async input => {
        const response = await ctx.transport.request(input);
        const next = nextLinkTarget(response.headers.link ?? "", response.url);
        if (next === undefined) return response;
        const target = new URL(next);
        const numeric = /^\/repositories\/[1-9][0-9]*\/issues$/.test(target.pathname);
        const boundPath = `/repos/${encodeURIComponent(ctx.bound.parameters.owner!)}/${encodeURIComponent(ctx.bound.parameters.repo!)}/issues`;
        if (target.origin !== "https://api.github.com" || !numeric && target.pathname !== boundPath) return response;
        const pageNumber = target.searchParams.get("page");
        if (pageNumber === null ? !target.searchParams.has("after") : target.searchParams.getAll("page").length !== 1 || !/^[1-9][0-9]*$/.test(pageNumber) || !Number.isSafeInteger(Number(pageNumber))) unsupportedContent("invalid GitHub next page");
        const size = ctx.spec.request!.query?.per_page;
        if (target.searchParams.getAll("per_page").length > 1 || target.searchParams.has("per_page") && target.searchParams.get("per_page") !== String(size ?? 30)) unsupportedContent("GitHub next page changed page size");
        if (!numeric) return response;
        // Numeric repository ids in Link headers grant no identity authority. Only their paging
        // query is reused, against the original bound repository and the engine's request guard.
        target.pathname = boundPath;
        return {...response, headers: {...response.headers, link: `<${target.href}>; rel="next"`}};
      }},
    });
    const records: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const item of page.records) {
      const normalized = normalizeGithubIssue(item, ctx.bound.parameters, helpers);
      if (normalized) records.push(normalized); else skipped++;
    }
    return {...page, records, complete: page.complete && ctx.mode === "complete" && !ctx.resumed,
      ...(skipped ? {diagnostics: [{code: "PULL_REQUEST_SKIPPED", message: "pull requests excluded from issue listing", count: skipped}]} : {}),
    };
  },
});
}
