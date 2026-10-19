import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_PROVIDER_REQUEST_RULES, bindSourceFeed, connectorPinDigest, parseConnectorDoc, validateConnectorRequest, type Connector, type ConnectorRequest } from "../src/connectors.js";
import { graphqlReadProblem } from "../src/connector-request.js";
import { buildKindRegistry } from "../src/kinds.js";
import { fetchIdentity, MemoryMachineState, observeSource, type SourceProfile } from "../src/source-engine/index.js";
import { getSourceProfile, restJsonProfile, SOURCE_PROFILES } from "../src/source-profiles/index.js";
import { peerTransport, ScriptedPeer, type PeerRequest, type PeerResponse } from "../src/source-harness/index.js";

const identity = fetchIdentity("SourceProfileTest/1 (+https://example.org/profile)")!;
const registry = buildKindRegistry([{id: "conventions/issue", body: "", frontmatter: {type: "Convention", title: "Issue", governs: "Issue", path: "issues/", fields: {required: ["title"], optional: ["count", "date", "url", "tag"]}}}], [], {okfVersion: "0.2"});
const baseRequest = (): ConnectorRequest => ({host: "api.github.com", method: "GET", path: "/repos/{owner}/{repo}/issues", items: "", complete: "always"});
function connector(request: ConnectorRequest = baseRequest(), github = true): Connector {
  const parsed = parseConnectorDoc({id: "connectors/issues", body: "", frontmatter: {
    type: "Connector", title: "Issues", auth: github ? {kind: "token", provider: "github"} : {kind: "none"}, domains: github ? [] : [request.host],
    record_sources: [{name: "issues", profile: "rest-json", target_kind: "Issue", identity: {resource: `https://${request.host}/repos/{owner}/{repo}`, id: "{id}"}, fields: {title: "title", count: "count", date: "date", url: "url", tag: "tag"}, completeness: "complete", request}],
  }}, {kinds: registry});
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.errors));
  return parsed.connector;
}
function world(c: Connector, answer: (r: PeerRequest) => PeerResponse, state = new MemoryMachineState()) {
  const bound = bindSourceFeed(c, {id: "source-feeds/issues", frontmatter: {type: "Source Feed", connector: c.id, source: "issues", url: `https://${c.sources[0]!.request?.host ?? "api.github.com"}/repos/octo/project`, owned_fields: ["title", "count", "date", "url", "tag"], auto_apply: ["new", "changed"], missing_threshold: 2}}, registry, {okfVersion: "0.2"});
  const peer = new ScriptedPeer(r => new URL(r.url).pathname === "/robots.txt" ? {status: 404, body: ""} : answer(r));
  const commits: unknown[] = [];
  return {bound, peer, state, commits, run: (overrides: Record<string, unknown> = {}) => observeSource({connector: c, bound, profile: restJsonProfile, spec: c.sources[0], transport: peerTransport(peer), state, identity, now: () => new Date("2026-10-19T00:00:00Z"), mode: "complete", commit: async page => {commits.push(page);}, ...overrides})};
}
const json = (body: unknown, headers: Record<string, string> = {}): PeerResponse => ({status: 200, body: JSON.stringify(body), headers});

test("public catalog is inert/frozen and rest-json normalizes typed scalars through existing mapping", async () => {
  assert.equal(getSourceProfile("rest-json"), restJsonProfile);
  assert.equal(getSourceProfile("github-issues"), undefined);
  assert.ok(Object.isFrozen(SOURCE_PROFILES) && Object.isFrozen(SOURCE_PROFILES[0]));
  const request = {...baseRequest(), fields: {count: {from: "native_count", type: "integer" as const}, date: {from: "epoch", type: "epoch-date" as const}, title: {from: "name", type: "text" as const}, url: {from: "html_url", type: "url" as const}, tag: {const: "issue"}}, skip: [{path: "pull_request", present: true as const}]};
  const h = world(connector(request), () => json([{id: 1, name: 42, native_count: "12", epoch: 0, html_url: "https://example.org/i"}, {id: 2, pull_request: {}}]));
  const receipt = await h.run();
  assert.equal(receipt.outcome, "observed");
  assert.equal(receipt.pass.complete, true);
  assert.equal(receipt.changes.new, 1);
  assert.equal(receipt.profile_diagnostics[0]?.count, 1);
  const state = (await h.state.read("source-feeds/issues"))!.state;
  assert.deepEqual(state.records["1"]!.after, {title: "42", count: 12, date: "1970-01-01T00:00:00.000Z", url: "https://example.org/i", tag: "issue"});
});

test("provider rows are frozen at every depth and github-app shares their scope", () => {
  const visit = (value: unknown): void => {if (value && typeof value === "object") {assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) visit(child);}};
  visit(AUTH_PROVIDER_REQUEST_RULES);
  const c = connector();
  assert.deepEqual(validateConnectorRequest(c.sources[0]!, {...c, auth: {kind: "github-app"}}), []);
  assert.ok(validateConnectorRequest(c.sources[0]!, {...c, auth: {kind: "token", provider: "absent"}}).length);
});

test("closed nested grammar refuses unknown keys, secret/env templates, unbound resources and unsafe methods", () => {
  const c = connector();
  const cases: Array<(r: any) => void> = [r => r.extra = true, r => r.paging = {kind: "none", extra: true}, r => r.watermark = {field: "updated", param: "since", overlap_seconds: 0, extra: true}, r => r.errors = {extra: []}, r => r.rate = {requests: 1, extra: true}, r => r.fields = {x: {from: "a", extra: true}}, r => r.skip = [{path: "x", present: true, extra: true}], r => r.complete = {when_path: "end", equals: true, extra: true}, r => r.query = {x: "{secret}"}, r => r.query = {x: "{env.TOKEN}"}, r => r.query = {x: "%7Bcursor%7D"}, r => r.path = "/repos/{owner}/../{repo}/issues", r => r.path = "/repos/{owner}/{repo}/pulls", r => r.method = "POST", r => r.headers = {"x-http-method-override": "DELETE"}];
  for (const edit of cases) {const source = structuredClone(c.sources[0]!); edit(source.request); assert.ok(validateConnectorRequest(source, c).length, JSON.stringify(source.request));}
  const source = structuredClone(c.sources[0]!); source.identity.resource += "/{other}";
  assert.ok(validateConnectorRequest(source, c).some(e => e.message.includes("every resource")));
  const keyless = {...c, auth: {kind: "none" as const}, domains: ["api.github.com"]};
  assert.ok(validateConnectorRequest({...c.sources[0]!, request: {...baseRequest(), method: "POST"}}, keyless).length);
});

test("AST parsing refuses mutation, multi-operation, literal string/id and variable defaults", () => {
  const good = "query Issues($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { issues(first: 100, after: $cursor) { totalCount } } }";
  assert.equal(graphqlReadProblem(good, {owner: "{owner}", repo: "{repo}", cursor: "{cursor}"}), undefined);
  for (const query of ["mutation { x }", "query A{x} query B{y}", 'query { repository(owner: "octo", name: "project") { id } }', 'query Q($owner: String = "octo") { repository(owner:$owner){id} }', "subscription { x }"])
    assert.ok(graphqlReadProblem(query, {owner: "{owner}"}), query);
  assert.ok(graphqlReadProblem("query Q($id: ID!){node(id:$id){id}}", {id: "literal"}));
});

test("every request nested key affects its pin while absent-request golden remains owned by connectors tests", () => {
  const c = connector(); const before = connectorPinDigest(c);
  c.sources[0]!.request!.query = {state: "all"};
  assert.notEqual(connectorPinDigest(c), before);
});

test("credentialed legacy source needs a declaration; deployed table and binding are revalidated before transport", async () => {
  const c = connector(); delete c.sources[0]!.request;
  const h = world(c, () => json([]));
  const extension: SourceProfile = {...restJsonProfile as SourceProfile, validateSpec: spec => ({ok: true, spec}), hostsFor: () => ["api.github.com"]};
  const receipt = await h.run({profile: extension});
  assert.equal(receipt.reason, "declaration_required"); assert.deepEqual(h.peer.received, []);
  const narrowed = connector(); const n = world(narrowed, () => json([])); narrowed.auth.provider = "retired";
  assert.equal((await n.run()).reason, "declaration_invalid"); assert.deepEqual(n.peer.received, []);
  const missing = world(connector(), () => json([])); delete missing.bound.parameters.repo;
  assert.equal((await missing.run()).outcome, "refused"); assert.deepEqual(missing.peer.received, []);
});

test("extension requests cannot widen pinned paths, headers or GraphQL body through caller hooks", async () => {
  const r = {...baseRequest(), method: "POST" as const, path: "/graphql", graphql: {query: "query Q($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id}}", variables: {owner: "{owner}", repo: "{repo}"}}};
  for (const body of [JSON.stringify({query: "mutation {x}", variables: {owner: "octo", repo: "project"}}), JSON.stringify({query: r.graphql.query, variables: {owner: "other", repo: "project"}})]) {
    const c = connector(r); const h = world(c, () => json({}));
    const p: SourceProfile = {...restJsonProfile as SourceProfile, validateSpec: spec => ({ok: true, spec}), hostsFor: () => ["api.github.com"], observe: async ({transport}) => {await transport.request({url: "https://api.github.com/graphql", method: "POST", body}); return {records: [], nextCursor: null, more: false, complete: false};}};
    assert.equal((await h.run({profile: p, rules: {post: () => true, url: () => true}})).outcome, "refused"); assert.deepEqual(h.peer.received, []);
  }
  for (const input of [{url: "https://api.github.com/repos/octo/other/issues"}, {url: "https://api.github.com/repos/octo/project/issues", headers: {"x-http-method-override": "DELETE"}}]) {
    const h = world(connector(), () => json([]));
    const p: SourceProfile = {...restJsonProfile as SourceProfile, observe: async ({transport}) => {await transport.request(input); return {records: [], nextCursor: null, more: false, complete: false};}};
    assert.equal((await h.run({profile: p, rules: {url: () => true, header: () => true}})).outcome, "refused"); assert.deepEqual(h.peer.received, []);
  }
});

test("well-formed bound GraphQL remains explicitly unsupported before transport", async () => {
  const r = {...baseRequest(), method: "POST" as const, path: "/graphql", graphql: {query: "query Q($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id}}", variables: {owner: "{owner}", repo: "{repo}"}}};
  const h = world(connector(r), () => json({}));
  const profile: SourceProfile = {...restJsonProfile as SourceProfile, validateSpec: spec => ({ok: true, spec}), hostsFor: () => ["api.github.com"], observe: async ({transport}) => {await transport.request({url: "https://api.github.com/graphql", method: "POST", body: JSON.stringify({query: r.graphql.query, variables: {owner: "octo", repo: "project"}})}); return {records: [], nextCursor: null, more: false, complete: false};}};
  const result = await h.run({profile, rules: {post: () => true, url: () => true}});
  assert.equal(result.reason, "graphql_scope_unsupported"); assert.deepEqual(h.peer.received, []);
});

for (const token of ['&other=1', '/', '"', '@evil.example.org', '..']) test(`opaque cursor encoded whole: ${token}`, async () => {
  const request = {...baseRequest(), host: "tickets.example.org", items: "items", query: {after: "{cursor}"}, paging: {kind: "cursor" as const, cursor_path: "next"}};
  let page = 0;
  const h = world(connector(request, false), () => ++page === 1 ? json({items: [{id: 1, title: "one"}], next: token}) : json({items: []}));
  assert.equal((await h.run()).outcome, "observed");
  const url = new URL(h.peer.received.at(-1)!.url);
  assert.equal(url.searchParams.get("after"), token); assert.equal(url.pathname, "/repos/octo/project/issues"); assert.equal([...url.searchParams.keys()].length, 1);
});

for (const kind of ["page-number", "offset"] as const) test(`partial ${kind} commits keep last cursor; resumed passes restart and never count complete`, async () => {
  const name = kind === "offset" ? "offset" : "page";
  const initial = kind === "offset" ? "0" : "1";
  const r = {...baseRequest(), host: "tickets.example.org", items: "items", paging: {kind, page_param: "page", offset_param: "offset", size: 1, size_param: "per_page"}};
  const h = world(connector(r, false), request => new URL(request.url).searchParams.get(name) === initial ? json({items: [{id: 1, title: "one"}]}) : {status: 429, body: ""});
  const first = await h.run(); assert.equal(first.outcome, "deferred"); assert.deepEqual(first.cursor, {...(kind === "offset" ? {offset: 1} : {page: 2}), since: ""}); assert.equal(first.pages, 1);
  const resumed = world(connector(r, false), () => json({items: []}), h.state);
  const second = await resumed.run({mode: "incremental"}); assert.equal(second.pass.resumed, true); assert.equal(second.pass.complete, false);
  assert.equal(new URL(resumed.peer.received.at(-1)!.url).searchParams.get(name), initial);
});

test("watermark overlap is fixed during a pass and retained only after committed pages", async () => {
  const r = {...baseRequest(), host: "tickets.example.org", items: "items", query: {after: "{cursor}"}, paging: {kind: "cursor" as const, cursor_path: "next"}, watermark: {field: "updated", param: "since", overlap_seconds: 60}};
  let calls = 0;
  const h = world(connector(r, false), () => ++calls === 1 ? json({items: [{id: 1, title: "one", updated: "2026-01-01T00:00:00Z"}], next: "two"}) : json({items: [{id: 2, title: "two", updated: "2026-01-02T00:00:00Z"}]}));
  const first = await h.run(); assert.equal(first.outcome, "observed");
  assert.ok(h.peer.received.filter(r => !r.url.endsWith("robots.txt")).every(r => !new URL(r.url).searchParams.has("since")));
  await h.run({mode: "incremental"}); assert.equal(new URL(h.peer.received.at(-1)!.url).searchParams.get("since"), "2026-01-01T23:59:00.000Z");
});

test("numeric GitHub next requires verified matching first-page metadata and fixed id throughout the pass", async () => {
  // Conditional metadata fixture: GitHub's issues listing does not guarantee repository.id.
  // Official pagination form: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
  for (const metadata of [false, true]) {
    let page = 0;
    const h = world(connector({...baseRequest(), paging: {kind: "link-header"}}), () => ++page === 1 ? json([{id: 1, title: "one", ...(metadata ? {repository: {id: 123, full_name: "octo/project"}} : {})}], {link: '<https://api.github.com/repositories/123/issues?page=2>; rel="next"'}) : json([]));
    const result = await h.run();
    assert.equal(result.outcome, metadata ? "observed" : "refused");
    assert.equal(h.peer.received.length, metadata ? 2 : 1);
  }
  const h = world(connector({...baseRequest(), query: {page: "{page}"}, paging: {kind: "link-header", page_param: "page"}}), () => json([{id: 1, title: "one", repository: {id: 123, full_name: "octo/project"}}], {link: '<https://api.github.com/repositories/999/issues?page=2>; rel="next"'}));
  assert.equal((await h.run()).outcome, "refused"); assert.equal(h.peer.received.length, 1);
});


test("Link relations preserve commas inside URLs and malformed links cannot claim completeness", async () => {
  let calls = 0;
  const request = {...baseRequest(), host: "tickets.example.org", query: {after: "{cursor}"}, paging: {kind: "link-header" as const}};
  const h = world(connector(request, false), () => ++calls === 1 ? json([{id: 1, title: "one"}], {link: '<https://tickets.example.org/repos/octo/project/issues?after=a,b>; type="application/json"; rel="next last"'}) : json([]));
  assert.equal((await h.run()).outcome, "observed");
  assert.equal(new URL(h.peer.received.at(-1)!.url).searchParams.get("after"), "a,b");
  const malformed = world(connector(request, false), () => json([], {link: '<https://tickets.example.org/x; rel="next"'}));
  const receipt = await malformed.run(); assert.equal(receipt.outcome, "unsupported_content"); assert.equal(receipt.pass.complete, false); assert.equal(receipt.pages, 0);
});

for (const relation of ["next", "Next", "NEXT", "nExT", "prev NEXT"]) test(`Link ${relation} traverses pages before accounting for absence`, async () => {
  const c = connector({...baseRequest(), paging: {kind: "link-header"}});
  let phase = "seed";
  const h = world(c, input => {
    const second = new URL(input.url).searchParams.has("page");
    return phase === "seed" ? json([{id: 1, title: "one"}, {id: 2, title: "two"}]) : second ? json([{id: 2, title: "two"}]) : json([{id: 1, title: "one"}], {link: `<https://api.github.com/repos/octo/project/issues?page=2>; rel="${relation}"`});
  });
  h.bound.policy.missing_threshold = 1;
  await h.run(); phase = "paged";
  const result = await h.run();
  assert.equal(result.pages, 2); assert.equal(result.pass.complete, true); assert.equal(result.changes.disappeared, 0);
});

test("normalization path reordering preserves pins and records; ancestor collisions are refused in either order", async () => {
  for (const paths of [["normalized", "normalized.title"], ["normalized.title", "normalized"], ["x.y", "x.y.z"], ["a", "a-b", "a.b"]]) {
    const c = connector(); c.sources[0]!.request!.fields = Object.fromEntries(paths.map(path => [path, {const: "value"}]));
    assert.equal(restJsonProfile.validateSpec(c.sources[0]).ok, false, paths.join(","));
    assert.ok(validateConnectorRequest(c.sources[0]!, c).some(e => e.path.includes("/fields/")));
    const parsed = parseConnectorDoc({id: c.id, body: "", frontmatter: {type: "Connector", title: c.title, auth: c.auth, domains: c.domains, record_sources: c.sources}});
    assert.equal(parsed.ok, false);
  }
  const a = connector({...baseRequest(), fields: {"normalized.title": {const: "one"}, "normalized.count": {const: 2}}});
  const b = structuredClone(a); b.sources[0]!.request!.fields = Object.fromEntries(Object.entries(b.sources[0]!.request!.fields!).reverse());
  assert.equal(connectorPinDigest(a), connectorPinDigest(b));
  const normalize = async (c: Connector) => {
    const h = world(c, () => json([]));
    return restJsonProfile.observe({spec: c.sources[0]!, bound: h.bound, cursor: null, resumed: false, mode: "complete", budget: {requests: 1, maxBytes: 1000}, now: new Date(), validators: null, transport: {request: async () => ({status: 200, body: '[{"id":1,"title":"one"}]', headers: {}, url: "https://api.github.com/repos/octo/project/issues"})}});
  };
  assert.deepEqual((await normalize(a)).records, (await normalize(b)).records);
  const first = world(a, () => json([{id: 1, title: "one"}]));
  const second = world(b, () => json([{id: 1, title: "one"}]));
  await first.run(); await second.run();
  assert.deepEqual((await first.state.read("source-feeds/issues"))!.state.records, (await second.state.read("source-feeds/issues"))!.state.records);
});

for (const phase of ["url", "header"] as const) test(`narrowing ${phase} callback cannot change execution or authority through its view or captured declaration`, async () => {
  const c = connector({...baseRequest(), query: {state: "open"}, headers: {"x-github-api-version": "2026-03-10"}, fields: {title: {const: "pinned"}}});
  const h = world(c, () => json([{id: 1, title: "raw"}]));
  const mutate = (url: URL): boolean => {url.searchParams.set("state", "all"); c.sources[0]!.request!.query!.state = "all"; h.bound.parameters.repo = "other"; c.sources[0]!.request!.fields!.title = {const: "changed"}; c.sources[0]!.fields.title!.from = "wrong"; return true;};
  const result = await h.run({rules: phase === "url" ? {url: mutate} : {header: (_name: string, url: URL) => mutate(url)}});
  assert.equal(result.outcome, "observed"); assert.equal(h.peer.received.length, 1);
  assert.equal(new URL(h.peer.received[0]!.url).searchParams.get("state"), "open");
  assert.equal(new URL(h.peer.received[0]!.url).pathname, "/repos/octo/project/issues");
  assert.equal((await h.state.read("source-feeds/issues"))!.state.records["1"]!.after.title, "pinned");
});

for (const attributes of [
  'title="hint; rel=prev"; rel="next"',
  'title="hint, <other>; rel=prev"; ReL=Next',
  'title="hint\\"; rel=prev, more"; rel="prev NEXT"',
  'title="trailing slash\\\\"; rel=next',
  'rel=next; title="after; rel=prev"',
  'title*=UTF-8\'en\'hint; custom-flag; rel="next"',
]) test(`parsed Link parameters preserve traversal and absence accounting: ${attributes}`, async () => {
  const c = connector({...baseRequest(), paging: {kind: "link-header"}});
  let phase = "seed";
  const h = world(c, input => phase === "seed" ? json([{id: 1, title: "one"}, {id: 2, title: "two"}]) : new URL(input.url).searchParams.has("page") ? json([{id: 2, title: "two"}]) : json([{id: 1, title: "one"}], {link: `<https://api.github.com/repos/octo/project/issues?page=2>; ${attributes}`}));
  h.bound.policy.missing_threshold = 1; await h.run(); phase = "paged";
  const result = await h.run(); assert.equal(result.pages, 2); assert.equal(result.pass.complete, true); assert.equal(result.changes.disappeared, 0);
});

test("provider-owned after paging is bounded centrally for rest-json too", async () => {
  for (const token of ["opaque-token", "", "x".repeat(2049)]) {
    let calls = 0;
    const h = world(connector({...baseRequest(), query: {state: "all"}, paging: {kind: "link-header"}}), () => ++calls === 1
      ? json([{id: 1, title: "one"}], {link: `<https://api.github.com/repos/octo/project/issues?state=all&after=${token}>; rel="next"`}) : json([]));
    const result = await h.run(); assert.equal(result.outcome, token === "opaque-token" ? "observed" : "refused");
    assert.equal(h.peer.received.length, token === "opaque-token" ? 2 : 1);
  }
});
