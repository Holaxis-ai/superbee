/**
 * `@superbee/core/source-engine`: the guarded transport (host set, address rule, per-hop recheck,
 * method and header rules, robots.txt, budget, deadline, status mapping), the cursor rule, the
 * completeness rule behind disappearance, and the machine state. Each guard has a test that fails
 * when the guard is removed. The fixture is the synthetic ticket board over the `json-pages` test
 * profile, with a scripted peer as the network and a commit that records what it was given.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bindSourceFeed, type BoundFeed, type Connector } from "../src/connectors.js";
import { buildKindRegistry } from "../src/kinds.js";
import {
  DEFAULT_MISSING_THRESHOLD,
  fetchIdentity,
  MAX_REPLAY_FAILURES,
  isSourceState,
  MachineStateConflict,
  MemoryMachineState,
  observeSource,
  sourceHostSet,
  type FetchIdentity,
  type ObserveSourceOptions,
  type PageCommit,
  type SourceProfile,
  type SourceState,
} from "../src/source-engine/index.js";
import { ExchangePeer, peerTransport, ScriptedPeer, type PeerRequest, type PeerResponse, type ScriptedExchange } from "../src/source-harness/index.js";
import { jsonPagesProfile, type JsonPagesSpec } from "./fixtures/source-engine/json-pages-profile.js";
import { CONNECTOR_MD, FEED_FRONTMATTER, FEED_ID, HOST, ITEMS, SPEC, TICKET_CONVENTION, ticket, ticketConnector } from "./fixtures/source-engine/tickets.js";

const IDENTITY = fetchIdentity("SuperbeeTest/1 (+https://superbee.example.org/test)") as FetchIdentity;
const AT = "2026-03-01T12:00:00.000Z";
const T1 = ticket("t1", "First");
const T2 = ticket("t2", "Second");
const T3 = ticket("t3", "Third");

function githubConnector(): Connector {
  const c = ticketConnector(CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github"));
  c.sources[0]!.identity.resource = "https://api.github.com/repos/{owner}/{repo}";
  c.sources[0]!.request = {host: "api.github.com", method: "GET", path: "/repos/{owner}/{repo}/issues", items: "items"};
  return c;
}

function boundFor(connector: Connector, feed: Record<string, unknown> = FEED_FRONTMATTER): BoundFeed {
  const registry = buildKindRegistry([TICKET_CONVENTION], [], { okfVersion: "0.2" });
  const scopedFeed = connector.sources[0]?.request?.host === "api.github.com" ? {...feed, url: "https://api.github.com/repos/o/r"} : feed;
  return bindSourceFeed(connector, { id: FEED_ID, frontmatter: scopedFeed as never }, registry, { okfVersion: "0.2" });
}

const json = (items: unknown[], extra: Record<string, unknown> = {}): PeerResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ items, ...extra }) });
const page = (url: string, items: unknown[], extra: Record<string, unknown> = {}): ScriptedExchange => ({ request: { url }, response: json(items, extra) });
const after = (token: string): string => `${ITEMS}?after=${encodeURIComponent(token)}`;

interface Harness {
  peer: ScriptedPeer;
  state: MemoryMachineState;
  commits: PageCommit[];
  run(overrides?: Partial<ObserveSourceOptions<JsonPagesSpec, unknown>>): ReturnType<typeof observeSource>;
}

/** A run over the ticket board. `answer` is the network; `commit` defaults to recording the page. */
function harness(answer: ScriptedExchange[] | ((request: PeerRequest) => PeerResponse), options: { connector?: Connector; feed?: Record<string, unknown>; state?: MemoryMachineState } = {}): Harness {
  const peer = Array.isArray(answer) ? new ExchangePeer(answer) : new ScriptedPeer(answer);
  const state = options.state ?? new MemoryMachineState();
  const commits: PageCommit[] = [];
  const connector = options.connector ?? ticketConnector();
  const bound = boundFor(connector, options.feed);
  return {
    peer, state, commits,
    run: (overrides = {}) => observeSource({
      connector, bound, profile: jsonPagesProfile, spec: SPEC, transport: peerTransport(peer), state, identity: IDENTITY,
      now: () => new Date(AT), commit: async (p) => { commits.push(p); }, ...overrides,
    }),
  };
}

const pages = (peer: ScriptedPeer): string[] => peer.received.filter((r) => new URL(r.url).pathname !== "/robots.txt").map((r) => r.url);

// ------------------------------------------------------------------------------------- host guard

test("hostsFor naming a host outside the credential hosts and domains refuses the run before any request", async () => {
  const h = harness(() => json([]));
  const receipt = await h.run({ spec: { ...SPEC, host: "elsewhere.example.net" } });
  assert.equal(receipt.outcome, "refused");
  assert.equal(receipt.reason, "hosts_undeclared");
  assert.equal(receipt.detail, "elsewhere.example.net");
  assert.deepEqual(h.peer.received, []);
});

test("a profile requesting a host outside its hostsFor is refused unsent, even when the connector declares it", async () => {
  const connector = ticketConnector(CONNECTOR_MD.replace(`  - ${HOST}\n`, `  - ${HOST}\n  - other.example.org\n`));
  const sneaky: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      await transport.request({ url: "https://other.example.org/items" });
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
  const h = harness(() => json([]), { connector });
  const receipt = await h.run({ profile: sneaky });
  assert.equal(receipt.reason, "host_refused");
  assert.deepEqual(h.peer.received, []);
  assert.deepEqual(receipt.requests.map((r) => r.refused), ["host_refused"]);
});

test("sourceHostSet: credential hosts get no robots gate; keyless domains do; an undeclared host is named", () => {
  const github = githubConnector();
  const set = sourceHostSet(github, ["api.github.com", HOST]);
  assert.ok(set.ok);
  assert.deepEqual([...set.hosts.credential], ["api.github.com"]);
  assert.deepEqual([...set.hosts.keyless], [HOST]);
  assert.deepEqual(sourceHostSet(github, ["api.github.com", "x.example.net"]), { ok: false, undeclared: ["x.example.net"] });
});

for (const target of ["https://evil.example.net/x", "https://127.0.0.1/x", "https://[::ffff:127.0.0.1]/x", "https://metadata.google.internal/x", "http://tickets.example.org/x", "https://tickets.example.org:8443/x", "https://u:p@tickets.example.org/x"]) {
  test(`a redirect hop to ${target} is re-checked and refused unsent`, async () => {
    const h = harness([{ request: { url: ITEMS }, response: { status: 302, headers: { location: target }, body: "" } }]);
    const receipt = await h.run();
    assert.equal(receipt.outcome, "refused");
    assert.deepEqual(pages(h.peer), [ITEMS], "only the first hop reached the network");
    assert.equal(receipt.pages, 0);
    assert.deepEqual(h.commits, []);
  });
}

test("a same-host redirect is followed with the guard re-run, and the page commits", async () => {
  const h = harness([
    { request: { url: ITEMS }, response: { status: 301, headers: { location: "/boards/main/items-v2" }, body: "" } },
    page(`https://${HOST}/boards/main/items-v2`, [T1]),
  ]);
  const receipt = await h.run();
  assert.equal(receipt.outcome, "observed");
  assert.deepEqual(receipt.requests.map((r) => [r.purpose, r.status]), [["robots", 404], ["page", 301], ["page", 200]]);
});

test("redirects past the budget's limit are refused", async () => {
  const h = harness((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/robots.txt") return { status: 404, body: "" };
    const n = Number(url.searchParams.get("n") ?? 0);
    return { status: 302, headers: { location: `${ITEMS}?n=${n + 1}` }, body: "" };
  });
  const receipt = await h.run({ budget: { redirects: 2 } });
  assert.equal(receipt.reason, "redirect_limit");
  assert.equal(pages(h.peer).length, 3);
});

test("a credentialed request never follows a redirect to another host, even a declared one", async () => {
  const github = githubConnector();
  const profile: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, hostsFor: () => ["api.github.com", HOST] };
  const h = harness((request) => (new URL(request.url).hostname === "api.github.com"
    ? { status: 302, headers: { location: ITEMS }, body: "" }
    : json([])), { connector: github });
  const receipt = await h.run({ profile, spec: API_SPEC });
  assert.equal(receipt.reason, "redirect_refused");
  assert.deepEqual(h.peer.received.map((r) => new URL(r.url).hostname), ["api.github.com"]);
});

// ------------------------------------------------------------------------------- method and headers

const GITHUB_MD = CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github");
const API_SPEC: JsonPagesSpec = { ...SPEC, host: "api.github.com", path: "/repos/{owner}/{repo}/issues" };

test("a POST is refused outside the provider read_posts even when caller rules admit it; a keyless host is GET only", async () => {
  const post = harness(() => json([]));
  assert.equal((await post.run({ spec: { ...SPEC, method: "POST" } })).reason, "method_refused");
  assert.deepEqual(post.peer.received, []);

  const keyless = harness(() => json([T1]));
  assert.equal((await keyless.run({ spec: { ...SPEC, method: "POST" }, rules: { post: () => true } })).reason, "method_refused");
  assert.deepEqual(keyless.peer.received, []);

  const admitted = harness(() => json([T1]), { connector: githubConnector() });
  const receipt = await admitted.run({ spec: { ...API_SPEC, method: "POST" }, rules: { post: () => true } });
  assert.equal(receipt.reason, "method_refused");
  assert.deepEqual(admitted.peer.received, []);
});

test("a GET with a body is refused; a read-shaped GraphQL POST awaits scoped semantics", async () => {
  const bodied: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe({ transport }) { await transport.request({ url: ITEMS, body: "{}" }); return { records: [], nextCursor: null, more: false, complete: false }; } };
  assert.equal((await harness(() => json([])).run({ profile: bodied })).reason, "body_refused");

  const graph = githubConnector();
  graph.sources[0]!.request = {host: "api.github.com", method: "POST", path: "/graphql", items: "items", graphql: {query: "query Q($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id}}", variables: {owner: "{owner}", repo: "{repo}"}}};
  const graphProfile: SourceProfile<JsonPagesSpec, unknown> = {...jsonPagesProfile, async observe({transport}) {await transport.request({url: "https://api.github.com/graphql", method: "POST", body: JSON.stringify({query: graph.sources[0]!.request!.graphql!.query, variables: {owner: "o", repo: "r"}})}); return {records: [], nextCursor: null, more: false, complete: false};}};
  const moved = harness((request) => ({ status: 307, headers: { location: `${request.url}-2` }, body: "" }), { connector: graph });
  assert.equal((await moved.run({ profile: graphProfile, spec: { ...API_SPEC, method: "POST" }, rules: { post: () => true } })).reason, "graphql_scope_unsupported");
});

for (const [name, headers, rules] of [
  ["authorization, even when a rule admits it", { authorization: "Bearer x" }, { header: () => true }],
  ["cookie", { Cookie: "s=1" }, { header: () => true }],
  ["a method override", { "X-HTTP-Method-Override": "DELETE" }, { header: () => true }],
  ["user-agent", { "user-agent": "spoof" }, { header: () => true }],
  ["an unlisted header", { "x-custom": "1" }, {}],
  ["a header value with a line break", { accept: "a\r\nx-injected: 1" }, {}],
] as const) {
  test(`a profile header is refused unsent: ${name}`, async () => {
    const profile: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe({ transport }) { await transport.request({ url: ITEMS, headers }); return { records: [], nextCursor: null, more: false, complete: false }; } };
    const h = harness(() => json([]));
    const receipt = await h.run({ profile, rules });
    assert.equal(receipt.reason, "header_refused");
    assert.deepEqual(h.peer.received, []);
  });
}

test("a rule admits a provider's version header; the engine sends its own user-agent", async () => {
  const profile: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe({ transport }) { await transport.request({ url: ITEMS, headers: { "X-Api-Version": "2", accept: "application/json" } }); return { records: [], nextCursor: null, more: false, complete: false }; } };
  const h = harness(() => ({ status: 404, body: "" }));
  await h.run({ profile, rules: { header: (name, url) => name === "x-api-version" && url.hostname === HOST } });
  const sent = h.peer.received.find((r) => r.url === ITEMS)!;
  assert.deepEqual(sent.headers, { "x-api-version": "2", accept: "application/json", "user-agent": IDENTITY.userAgent });
});

// --------------------------------------------------------------------------------------- robots.txt

test("robots.txt: a disallowed path on a keyless host is refused before the page request", async () => {
  const h = harness((request) => (new URL(request.url).pathname === "/robots.txt"
    ? { status: 200, body: "User-agent: *\nDisallow: /boards/\n" }
    : json([])));
  const receipt = await h.run();
  assert.equal(receipt.reason, "robots_disallowed");
  assert.equal(receipt.detail, "Disallow: /boards/");
  assert.deepEqual(h.peer.received.map((r) => new URL(r.url).pathname), ["/robots.txt"]);
  assert.deepEqual(receipt.requests.map((r) => [r.purpose, r.url, r.status ?? r.refused]), [["robots", `https://${HOST}/robots.txt`, 200], ["page", ITEMS, "robots_disallowed"]]);
});

test("robots.txt: the product token's group wins; 4xx allows; 5xx, a challenge or a redirect off the host set disallows", async () => {
  const cases: Array<[string, PeerResponse, string | undefined]> = [
    ["token group", { status: 200, body: "User-agent: *\nDisallow: /\n\nUser-agent: SuperbeeTest\nAllow: /\n" }, undefined],
    ["404", { status: 404, body: "" }, undefined],
    ["503", { status: 503, body: "" }, "robots_unavailable"],
    ["challenge", { status: 403, body: "<title>Just a moment...</title>" }, "bot_challenge"],
    ["off-set redirect", { status: 301, headers: { location: "https://robots.example.net/robots.txt" }, body: "" }, "robots_unavailable"],
  ];
  for (const [name, robots, reason] of cases) {
    const h = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? robots : json([T1])));
    const receipt = await h.run();
    assert.equal(receipt.reason, reason, name);
    if (reason) assert.deepEqual(pages(h.peer), [], `${name}: no page request`);
    assert.ok(h.peer.received.every((r) => new URL(r.url).hostname === HOST), `${name}: never left the host set`);
  }
});

test("robots.txt is read once per origin per run and never for a credential host", async () => {
  const h = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2])]);
  await h.run();
  assert.equal(h.peer.received.filter((r) => r.url.endsWith("/robots.txt")).length, 1);

  const github = githubConnector();
  const api = harness(() => json([]), { connector: github });
  await api.run({ spec: API_SPEC });
  assert.deepEqual(api.peer.received.map((r) => new URL(r.url).pathname), ["/repos/o/r/issues"]);
});

// ----------------------------------------------------------------------------- statuses and budget

for (const [code, outcome, retry] of [
  [401, "credential_refused", false], [403, "credential_refused", false], [404, "not_found", false], [410, "not_found", false],
  [429, "deferred", true], [500, "provider_unavailable", true], [503, "provider_unavailable", true], [400, "provider_unavailable", false],
] as const) {
  test(`status ${code} ends the run ${outcome}`, async () => {
    const h = harness([{ request: { url: ITEMS }, response: { status: code, body: "" } }]);
    const receipt = await h.run();
    assert.equal(receipt.outcome, outcome);
    assert.equal(receipt.status, code);
    assert.equal(receipt.retry, retry);
    assert.deepEqual(h.commits, []);
    assert.equal(receipt.findings.filter((f) => f.key.startsWith("source:")).length, 1);
  });
}

test("the declaration's status sets move a status between outcomes", async () => {
  const h = harness([{ request: { url: ITEMS }, response: { status: 503, headers: { "retry-after": "Wed, 01 Apr 2026 00:00:00 GMT" }, body: "" } }]);
  const receipt = await h.run({ statuses: { deferred: [429, 503] } });
  assert.equal(receipt.outcome, "deferred");
  assert.equal(receipt.retry_after, "2026-04-01T00:00:00.000Z");
});

test("the request budget counts robots.txt and every hop; exhausting it defers with no finding", async () => {
  const h = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2], { next: "c2" }), page(after("c2"), [T3])]);
  const receipt = await h.run({ budget: { requests: 3 } });
  assert.equal(receipt.outcome, "deferred");
  assert.equal(receipt.reason, "budget");
  assert.equal(receipt.pages, 2);
  assert.equal(h.peer.received.length, 3);
  assert.deepEqual(receipt.findings, []);
  assert.deepEqual((await h.state.read(FEED_ID))?.state.cursor, { after: "c2" });
});

test("the page budget defers after that many committed pages", async () => {
  const h = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2], { next: "c2" })]);
  const receipt = await h.run({ budget: { pages: 1 } });
  assert.equal(receipt.reason, "budget");
  assert.equal(receipt.pages, 1);
});

test("an aborted deadline starts no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness(() => json([]));
  const receipt = await h.run({ signal: controller.signal });
  assert.equal(receipt.reason, "deadline");
  assert.deepEqual(h.peer.received, []);
});

test("a transport failure is provider_unavailable; a transport breaking the byte bound is too_large", async () => {
  const failing = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { fail: true }));
  assert.equal((await failing.run()).outcome, "provider_unavailable");

  const bound = harness(() => json([]));
  const liar = { async request() { return { ok: true as const, status: 200, headers: {}, body: "x".repeat(100), bytes: 10 }; } };
  assert.equal((await bound.run({ transport: liar, budget: { maxBytes: 50 } })).outcome, "too_large");
});

// ---------------------------------------------------------------------------- the profile's limits

test("a stop the profile catches and swallows still ends the run, and its page is discarded", async () => {
  const swallowing: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      try { await transport.request({ url: "https://evil.example.net/x" }); } catch { /* swallowed */ }
      return { records: [T1], nextCursor: { after: "forged" }, more: false, complete: true };
    },
  };
  const h = harness(() => json([]));
  const receipt = await h.run({ profile: swallowing });
  assert.equal(receipt.reason, "host_refused");
  assert.deepEqual(h.commits, []);
  assert.equal(await h.state.read(FEED_ID), null);
});

test("after a stop every further request is refused, so a profile cannot keep fetching", async () => {
  let second: unknown;
  const persistent: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      try { await transport.request({ url: "https://evil.example.net/x" }); } catch { /* swallowed */ }
      try { await transport.request({ url: ITEMS }); } catch (error) { second = error; }
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
  const h = harness(() => json([]));
  await h.run({ profile: persistent });
  assert.ok(second instanceof Error);
  assert.deepEqual(h.peer.received, []);
});

test("the profile must be the one the source names, its spec must pass, and its cursor must be bounded JSON", async () => {
  const other: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, id: "other-profile" };
  assert.equal((await harness(() => json([])).run({ profile: other })).reason, "profile_mismatch");
  assert.equal((await harness(() => json([])).run({ spec: { host: HOST } })).reason, "spec_invalid");
  for (const cursor of [() => 1, { deep: "x".repeat(9000) }, { n: Number.NaN }]) {
    const odd: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe() { return { records: [], nextCursor: cursor, more: true, complete: false }; } };
    const h = harness(() => json([]));
    const receipt = await h.run({ profile: odd });
    assert.equal(receipt.reason, "cursor_invalid");
    assert.deepEqual(h.commits, []);
  }
});

test("a profile that cannot read the body ends unsupported_content with nothing written", async () => {
  const h = harness([{ request: { url: ITEMS }, response: { status: 200, body: "not json" } }]);
  const receipt = await h.run();
  assert.equal(receipt.outcome, "unsupported_content");
  assert.equal(receipt.detail, "invalid_json");
  assert.deepEqual(h.commits, []);
});

// -------------------------------------------------------------------------------- the cursor rule

test("the cursor is stored only after its page commits: a commit failing on page 2 leaves page 1's cursor and records", async () => {
  const h = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2], { next: "c2" }), page(after("c2"), [T3])]);
  let calls = 0;
  const receipt = await h.run({ commit: async () => { if (++calls === 2) throw new Error("store unavailable"); } });
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.reason, "commit_failed");
  const stored = (await h.state.read(FEED_ID))!.state;
  assert.deepEqual(stored.cursor, { after: "c1" });
  assert.deepEqual(Object.keys(stored.records), ["t1"]);
  assert.equal(stored.open, true);
  assert.deepEqual(receipt.cursor, { after: "c1" });
});

test("the cursor is not stored when the next page fails, and the next run resumes from it", async () => {
  const state = new MemoryMachineState();
  const first = harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 500, body: "" } }], { state });
  await first.run();
  assert.deepEqual((await state.read(FEED_ID))!.state.cursor, { after: "c1" });
  const second = harness([page(after("c1"), [T2])], { state });
  const receipt = await second.run();
  assert.equal(receipt.pass.resumed, true);
  assert.deepEqual(pages(second.peer), [after("c1")]);
});

test("a commit receives the page's changes before anything is stored", async () => {
  const h = harness([page(ITEMS, [T1, T2])]);
  let storedAtCommit: unknown = "unread";
  await h.run({ commit: async (p) => { storedAtCommit = await h.state.read(FEED_ID); assert.deepEqual(p.changes.map((c) => c.change_kind), ["new", "new"]); } });
  assert.equal(storedAtCommit, null);
});

test("a held record keeps its stored entry while the cursor advances, and is planned again when next observed", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1])], { state }).run({ mode: "complete" });
  const h = harness([page(ITEMS, [ticket("t1", "Renamed")])], { state });
  await h.run({ mode: "complete", commit: async (p) => ({ hold: p.changes.map((c) => c.external_id) }) });
  assert.equal((await state.read(FEED_ID))!.state.records.t1!.after.title, "First");
  const again = harness([page(ITEMS, [ticket("t1", "Renamed")])], { state });
  await again.run({ mode: "complete", commit: async (p) => { again.commits.push(p); } });
  assert.deepEqual(again.commits[0]!.changes.map((c) => [c.external_id, c.change_kind, c.changed_fields]), [["t1", "changed", ["title"]]]);
});

test("a duplicate id on one page is diffed once, the last occurrence against the stored entry", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1])], { state }).run();
  const h = harness([page(ITEMS, [ticket("t1", "Middle"), ticket("t1", "Last")])], { state });
  const receipt = await h.run();
  const [change] = h.commits[0]!.changes;
  assert.deepEqual([change!.before!.title, change!.after!.title], ["First", "Last"]);
  assert.deepEqual(receipt.profile_diagnostics.map((d) => d.code), ["RECORD_DUPLICATE"]);
});

test("a state write that loses its compare-and-swap fails the run", async () => {
  const state = new MemoryMachineState();
  const h = harness([page(ITEMS, [T1])], { state });
  const receipt = await h.run({ commit: async () => { await state.write(FEED_ID, { v: 1, profile: { id: "json-pages", version: 1 }, cursor: null, open: false, records: {}, complete_observations: 0 }, null); } });
  assert.equal(receipt.reason, "state_conflict");
  await assert.rejects(state.write(FEED_ID, { v: 1, profile: { id: "json-pages", version: 1 }, cursor: null, open: false, records: {}, complete_observations: 0 }, null), MachineStateConflict);
});

test("a cursor from another profile version is never handed back; the run lists completely", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 500, body: "" } }], { state }).run();
  const v2: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, version: 2 };
  const h = harness([page(ITEMS, [T1, T2])], { state });
  const receipt = await h.run({ profile: v2 });
  assert.equal(receipt.cursor_reset, "profile_version");
  assert.equal(receipt.mode, "complete");
  assert.deepEqual(pages(h.peer), [ITEMS]);
  assert.equal(receipt.pass.complete, true);
});

// ------------------------------------------------------------------ completeness and disappearance

async function observeAll(state: MemoryMachineState, items: unknown[], mode: "incremental" | "complete" = "complete", feed?: Record<string, unknown>) {
  const h = harness([page(ITEMS, items)], { state, ...(feed ? { feed } : {}) });
  const receipt = await h.run({ mode });
  return { receipt, changes: h.commits.flatMap((c) => c.changes) };
}

test("a record disappears after missing_threshold complete observations, never sooner", async () => {
  const state = new MemoryMachineState();
  await observeAll(state, [T1, T2]);
  const first = await observeAll(state, [T1]);
  assert.deepEqual(first.changes, []);
  assert.equal((await state.read(FEED_ID))!.state.records.t2!.missing, 1);
  const second = await observeAll(state, [T1]);
  assert.deepEqual(second.changes.map((c) => [c.external_id, c.change_kind, c.missing_count]), [["t2", "disappeared", 2]]);
  assert.equal(second.changes[0]!.after, null);
  const third = await observeAll(state, [T1]);
  assert.deepEqual(third.changes, [], "a disappearance is reported once");
  const back = await observeAll(state, [T1, T2]);
  assert.deepEqual(back.changes.map((c) => [c.external_id, c.change_kind]), [["t2", "new"]]);
});

test("missing_threshold comes from the feed; the default is two", async () => {
  assert.equal(DEFAULT_MISSING_THRESHOLD, 2);
  const state = new MemoryMachineState();
  const feed = { ...FEED_FRONTMATTER, missing_threshold: 1 };
  await observeAll(state, [T1, T2], "complete", feed);
  const once = await observeAll(state, [T1], "complete", feed);
  assert.deepEqual(once.changes.map((c) => c.change_kind), ["disappeared"]);
});

for (const [name, run] of [
  ["an incremental pass", (state: MemoryMachineState) => observeAll(state, [T1], "incremental")],
  ["a complete-mode pass the profile does not claim complete", (state: MemoryMachineState) => harness([page(ITEMS, [T1])], { state }).run({ mode: "complete", spec: { ...SPEC, complete: false } })],
  ["a pass interrupted after its first page", (state: MemoryMachineState) => harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 503, body: "" } }], { state }).run({ mode: "complete" })],
  ["a resumed pass", async (state: MemoryMachineState) => {
    await harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 503, body: "" } }], { state }).run({ mode: "incremental" });
    return harness([page(after("c1"), [T1])], { state }).run({ mode: "incremental" });
  }],
] as const) {
  test(`${name} never counts a record missing`, async () => {
    const state = new MemoryMachineState();
    await observeAll(state, [T1, T2]);
    await observeAll(state, [T1]);
    for (let i = 0; i < 3; i++) await run(state);
    const stored = (await state.read(FEED_ID))!.state;
    assert.equal(stored.records.t2!.missing, 1);
    assert.equal(stored.records.t2!.gone, undefined);
  });
}

test("a source declared partial never counts a record missing, even from a complete pass", async () => {
  const partial = ticketConnector(CONNECTOR_MD.replace("completeness: complete", "completeness: partial"));
  const state = new MemoryMachineState();
  for (const items of [[T1, T2], [T1], [T1], [T1]]) await harness([page(ITEMS, items)], { state, connector: partial }).run({ mode: "complete" });
  assert.equal((await state.read(FEED_ID))!.state.records.t2!.missing, 0);
});

test("a record seen in any pass resets its missing count; a refused but present record counts as seen", async () => {
  const strict = ticketConnector(CONNECTOR_MD.replace("unmapped: keep", "unmapped: refuse"));
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1, T2])], { state, connector: strict }).run({ mode: "complete" });
  await harness([page(ITEMS, [T1])], { state, connector: strict }).run({ mode: "complete" });
  await harness([page(ITEMS, [T1, ticket("t2", "Second", "BLOCKED")])], { state, connector: strict }).run({ mode: "incremental" });
  assert.equal((await state.read(FEED_ID))!.state.records.t2!.missing, 0);
  const receipt = await harness([page(ITEMS, [T1, ticket("t2", "Second", "BLOCKED")])], { state, connector: strict }).run({ mode: "complete" });
  assert.equal(receipt.changes.disappeared, 0);
});

test("a complete pass across pages counts every page's records as seen", async () => {
  const state = new MemoryMachineState();
  await observeAll(state, [T1, T2, T3]);
  for (let i = 0; i < 3; i++) {
    const again = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2], { next: "c2" }), page(after("c2"), [T3])], { state });
    const receipt = await again.run({ mode: "complete" });
    assert.equal(receipt.pass.complete, true);
    assert.equal(receipt.changes.disappeared, 0);
  }
  assert.ok(Object.values((await state.read(FEED_ID))!.state.records).every((entry) => entry.missing === 0));
});

test("validators are handed back in incremental mode and withheld in complete mode", async () => {
  const seen: Array<unknown> = [];
  const profile: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe(ctx) {
      seen.push(ctx.validators);
      return { records: [], nextCursor: null, more: false, complete: true, validators: { etag: "\"v1\"" } };
    },
  };
  const state = new MemoryMachineState();
  const h = harness(() => json([]), { state });
  await h.run({ profile });
  await h.run({ profile });
  await h.run({ profile, mode: "complete" });
  assert.deepEqual(seen, [null, { etag: "\"v1\"" }, null]);
});

test("a complete observation sends no validator, and a not-modified answer stops it rather than reading as an empty listing", async () => {
  const conditional: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      const response = await transport.request({ url: ITEMS, headers: { "if-none-match": "\"v1\"" } });
      return { records: response.status === 304 ? [] : JSON.parse(response.body).items, nextCursor: null, more: false, complete: true };
    },
  };
  const state = new MemoryMachineState();
  await observeAll(state, [T1, T2]);
  const refused = harness(() => ({ status: 304, body: "" }), { state });
  assert.equal((await refused.run({ profile: conditional, mode: "complete" })).reason, "header_refused");
  assert.deepEqual(refused.peer.received, []);

  const unprompted = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 304, body: "" }), { state });
  const receipt = await unprompted.run({ mode: "complete" });
  assert.equal(receipt.outcome, "provider_unavailable");
  assert.equal(receipt.reason, "not_modified");
  assert.deepEqual(unprompted.commits, []);
  assert.equal((await state.read(FEED_ID))!.state.records.t2!.missing, 0);

  const incremental = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 304, body: "" }), { state });
  const unchanged = await incremental.run({ profile: conditional });
  assert.equal(unchanged.outcome, "observed");
  assert.equal(incremental.peer.received.find((r) => r.url === ITEMS)!.headers["if-none-match"], "\"v1\"");
});

test("the stored state is plain JSON the engine recognizes", async () => {
  const state = new MemoryMachineState();
  await observeAll(state, [T1, T2]);
  await observeAll(state, [T1]);
  const stored = (await state.read(FEED_ID))!.state as SourceState;
  assert.ok(isSourceState(stored));
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored);
  assert.equal(isSourceState({ ...stored, v: 2 }), false);
  const corrupt = new MemoryMachineState();
  await corrupt.write(FEED_ID, { ...stored, records: { t1: { after: "x" } } } as never, null);
  const receipt = await harness(() => json([]), { state: corrupt }).run();
  assert.equal(receipt.reason, "state_invalid");
});

// ------------------------------------------------------------------- review follow-up: new guards

test("the engine marks each request toward a credential host, and only those", async () => {
  const flags: Array<[string, boolean]> = [];
  const spy = { async request(input: { url: string; credentialHost: boolean }) { flags.push([input.url, input.credentialHost]); return { ok: true as const, status: 200, headers: {}, body: JSON.stringify({ items: [] }), bytes: 12 }; } };
  const github = githubConnector();
  const profile: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    hostsFor: () => ["api.github.com", HOST],
    async observe({ transport }) {
      await transport.request({ url: "https://api.github.com/repos/o/r/issues" });
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
  await harness(() => json([]), { connector: github }).run({ profile, transport: spy as never, spec: API_SPEC });
  await harness(() => json([])).run({transport: spy as never});
  assert.deepEqual(flags, [["https://api.github.com/repos/o/r/issues", true], [`https://${HOST}/robots.txt`, false], [ITEMS, false]]);
});

test("rules.url refuses a redirect hop before it is sent", async () => {
  const h = harness([
    { request: { url: ITEMS }, response: { status: 302, headers: { location: `${ITEMS}-moved` }, body: "" } },
    page(`${ITEMS}-moved`, [T1]),
  ]);
  const receipt = await h.run({ rules: { url: (_url, hop) => !hop.redirect } });
  assert.equal(receipt.reason, "url_refused");
  assert.deepEqual(pages(h.peer), [ITEMS]);
});

test("a complete run after an interrupted incremental pass lists from page 1 and counts nothing missing", async () => {
  const state = new MemoryMachineState();
  await observeAll(state, [T1, T2, T3]);
  await harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 503, body: "" } }], { state }).run({ mode: "incremental" });
  assert.equal((await state.read(FEED_ID))!.state.open, true);
  const h = harness([page(ITEMS, [T1], { next: "c1" }), page(after("c1"), [T2, T3])], { state });
  const receipt = await h.run({ mode: "complete" });
  assert.deepEqual(pages(h.peer), [ITEMS, after("c1")]);
  assert.equal(receipt.pass.complete, true);
  assert.ok(Object.values((await state.read(FEED_ID))!.state.records).every((entry) => entry.missing === 0));
});

test("a bot-mitigation page from a keyless host is refused, never read as content or retried", async () => {
  for (const [name, response] of [
    ["a 200 marked as a challenge", { status: 200, headers: { "cf-mitigated": "challenge" }, body: JSON.stringify({ items: [T1] }) }],
    ["a 429 challenge page", { status: 429, headers: { "retry-after": "5" }, body: "<html><title>Just a moment...</title></html>" }],
  ] as const) {
    const h = harness([{ request: { url: ITEMS }, response }]);
    const receipt = await h.run();
    assert.equal(receipt.outcome, "refused", name);
    assert.equal(receipt.reason, "bot_challenge", name);
    assert.equal(receipt.retry, false, name);
    assert.deepEqual(h.commits, [], name);
  }
});

test("a page that promises more with no cursor, or with the cursor it was asked for, fails as a stuck cursor", async () => {
  for (const next of [null, "same"]) {
    let calls = 0;
    const stuck: SourceProfile<JsonPagesSpec, unknown> = {
      ...jsonPagesProfile,
      async observe({ transport, cursor }) {
        calls += 1;
        await transport.request({ url: ITEMS });
        return { records: [T1], nextCursor: next === null ? null : cursor ?? { after: "x" }, more: true, complete: false };
      },
    };
    const h = harness(() => json([]));
    const receipt = await h.run({ profile: stuck });
    assert.equal(receipt.reason, "cursor_stuck", String(next));
    assert.ok(calls <= 2, `stopped after ${calls} pages`);
    assert.ok(receipt.findings.some((f) => f.key === "source:tickets:failed:cursor_stuck"));
  }
});

test("the deadline bounds profile code: a page still pending when the signal aborts is discarded", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const hung: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe() {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    },
  };
  const h = harness(() => json([]));
  const receipt = await h.run({ profile: hung, signal: controller.signal });
  assert.equal(receipt.outcome, "deferred");
  assert.equal(receipt.reason, "deadline");
  assert.deepEqual(h.commits, []);
});

test("without a signal the budget's run deadline and per-request timeout apply", { timeout: 5000 }, async () => {
  const hung: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe() { return new Promise(() => {}); } };
  const run = await harness(() => json([])).run({ profile: hung, budget: { deadlineMs: 20 } });
  assert.equal(run.reason, "deadline");

  const silent = { async request(input: { url: string }) { return input.url.endsWith("/robots.txt") ? { ok: true as const, status: 404, headers: {}, body: "", bytes: 0 } : new Promise<never>(() => {}); } };
  const request = await harness(() => json([])).run({ transport: silent as never, budget: { requestTimeoutMs: 20 } });
  assert.equal(request.outcome, "provider_unavailable");
  assert.equal(request.reason, "timeout");
  assert.equal(request.requests.at(-1)!.refused, "timeout");
});

test("after the deadline no request starts, even through a transport that ignores the signal", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const sent: string[] = [];
  const blind = { async request(input: { url: string }) { sent.push(input.url); return { ok: true as const, status: 200, headers: {}, body: "{}", bytes: 2 }; } };
  const twice: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      await transport.request({ url: "https://api.github.com/repos/o/r/issues" });
      controller.abort();
      try { await transport.request({ url: "https://api.github.com/repos/o/r/issues" }); } catch { /* the deadline */ }
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
  const receipt = await harness(() => json([]), { connector: githubConnector() }).run({ profile: twice, transport: blind as never, signal: controller.signal, spec: API_SPEC });
  assert.deepEqual(sent, ["https://api.github.com/repos/o/r/issues"]);
  assert.equal(receipt.reason, "deadline");
});

test("a profile request is read once: a getter cannot widen the byte bound on a second read", async () => {
  let reads = 0;
  const shifty: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) {
      await transport.request({ url: ITEMS, get maxBytes() { reads += 1; return reads === 1 ? 100 : Number.NaN; } } as never);
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
  const h = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 200, body: "x".repeat(5000) }));
  const receipt = await h.run({ profile: shifty });
  assert.equal(reads, 1);
  assert.equal(receipt.outcome, "too_large");
});

test("a page whose record throws on read ends the run failed instead of rejecting", async () => {
  const throwing: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe() {
      return { records: [{ get id() { throw new Error("boom"); } }], nextCursor: null, more: false, complete: true };
    },
  };
  const h = harness(() => json([]));
  const receipt = await h.run({ profile: throwing });
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.reason, "page_invalid");
  assert.deepEqual(h.commits, []);
});

test("a transport a profile kept is closed when the run ends", async () => {
  let kept: { request(input: { url: string }): Promise<unknown> } | undefined;
  const keeper: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport }) { kept = transport; return { records: [], nextCursor: null, more: false, complete: false }; },
  };
  const h = harness(() => json([]));
  assert.equal((await h.run({ profile: keeper })).outcome, "observed");
  await assert.rejects(kept!.request({ url: ITEMS }), /run_ended/);
  assert.deepEqual(h.peer.received, []);
});

test("a robots.txt over 512 KiB is parsed up to that point rather than refusing the host", async () => {
  const long = `User-agent: *\nDisallow: /boards/\n${"# padding\n".repeat(60_000)}Allow: /boards/\n`;
  const h = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 200, body: long } : json([T1])));
  const receipt = await h.run();
  assert.equal(receipt.reason, "robots_disallowed", "the rule past 512 KiB is not read");
});

// --------------------------------------------------------------- held changes and pending replays

/** A commit that refuses to write the named ids with `retry` (or `hold`) while `blocked` holds them. */
function blockingCommit(blocked: Set<string>, kind: "retry" | "hold", seen: PageCommit[]) {
  return async (p: PageCommit) => {
    seen.push(p);
    const ids = p.changes.map((c) => c.external_id).filter((id) => blocked.has(id));
    return { [kind]: ids };
  };
}

test("an incremental-only feed applies a retried change once the hold clears, though the provider never lists it again", async () => {
  const state = new MemoryMachineState();
  const seen: PageCommit[] = [];
  const blocked = new Set(["t1"]);
  // One page per run, as a feed reading a long listing a little at a time: no run lists t1 again.
  const onePage = { pages: 1 };
  await harness([page(ITEMS, [T1], { next: "c1" })], { state }).run({ budget: onePage, commit: blockingCommit(new Set(), "retry", seen) });
  const second = await harness([page(after("c1"), [ticket("t1", "Renamed"), T2], { next: "c2" })], { state }).run({ budget: onePage, commit: blockingCommit(blocked, "retry", seen) });
  assert.equal(second.held, 1);
  assert.equal(second.pending, 1);
  let stored = (await state.read(FEED_ID))!.state;
  assert.equal(stored.records.t1!.after.title, "First");
  assert.deepEqual(stored.cursor, { after: "c2" }, "the cursor moved on past the held record");

  const third = await harness([page(after("c2"), [T3], { next: "c3" })], { state }).run({ budget: onePage, commit: blockingCommit(blocked, "retry", seen) });
  assert.equal(third.pending, 1, "still held: still pending");
  assert.equal(seen.at(-2)!.replay, true);
  assert.deepEqual(seen.at(-2)!.changes.map((c) => [c.external_id, c.after!.title]), [["t1", "Renamed"]]);

  blocked.clear();
  const fourth = await harness([page(after("c3"), [], { next: "c4" })], { state }).run({ budget: onePage, commit: blockingCommit(blocked, "retry", seen) });
  assert.equal(fourth.pending, 0);
  assert.equal(fourth.held, 0);
  stored = (await state.read(FEED_ID))!.state;
  assert.equal(stored.records.t1!.after.title, "Renamed");
  assert.equal(stored.pending, undefined);
});

test("a newer observation supersedes a pending change; a held change is not pending", async () => {
  const state = new MemoryMachineState();
  const seen: PageCommit[] = [];
  await harness([page(ITEMS, [T1])], { state }).run({ mode: "complete" });
  await harness([page(ITEMS, [ticket("t1", "Second name")])], { state }).run({ mode: "complete", commit: blockingCommit(new Set(["t1"]), "retry", seen) });
  assert.equal((await state.read(FEED_ID))!.state.pending?.t1?.change.after?.title, "Second name");
  // The replay is still refused, then the page lists a newer value, which replaces the pending one.
  seen.length = 0;
  const receipt = await harness([page(ITEMS, [ticket("t1", "Third name")])], { state }).run({ mode: "complete", commit: async (p) => {
    seen.push(p);
    return p.replay ? { retry: ["t1"] } : {};
  } });
  assert.deepEqual(seen.map((p) => [p.replay, p.changes.map((c) => c.after?.title)]), [[true, ["Second name"]], [false, ["Third name"]]]);
  assert.deepEqual(seen[1]!.changes[0]!.before, { ...seen[0]!.changes[0]!.before }, "the newer change is diffed against the stored entry");
  assert.equal(receipt.pending, 0);
  assert.equal((await state.read(FEED_ID))!.state.records.t1!.after.title, "Third name");

  const held = await harness([page(ITEMS, [ticket("t1", "Fourth name")])], { state }).run({ mode: "complete", commit: blockingCommit(new Set(["t1"]), "hold", [])});
  assert.equal(held.held, 1);
  assert.equal(held.pending, 0);
  assert.equal((await state.read(FEED_ID))!.state.records.t1!.after.title, "Third name");
});

// -------------------------------------------------------------------- QA follow-up: smaller rules

test("a caller signal keeps each request's timeout", { timeout: 5000 }, async () => {
  const silent = { async request(input: { url: string }) { return input.url.endsWith("/robots.txt") ? { ok: true as const, status: 404, headers: {}, body: "", bytes: 0 } : new Promise<never>(() => {}); } };
  const receipt = await harness(() => json([])).run({ transport: silent as never, signal: new AbortController().signal, budget: { requestTimeoutMs: 20 } });
  assert.equal(receipt.reason, "timeout");
});

test("an aborted deadline skips the replay of pending changes", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1])], { state }).run({ mode: "complete" });
  await harness([page(ITEMS, [ticket("t1", "Renamed")])], { state }).run({ mode: "complete", commit: async (p) => ({ retry: p.changes.map((c) => c.external_id) }) });
  const controller = new AbortController();
  controller.abort();
  const seen: PageCommit[] = [];
  const receipt = await harness(() => json([]), { state }).run({ signal: controller.signal, commit: async (p) => { seen.push(p); } });
  assert.equal(receipt.reason, "deadline");
  assert.deepEqual(seen, []);
  assert.equal(receipt.pending, 1);
});

test("a replay that keeps failing is dropped with a finding after MAX_REPLAY_FAILURES, and each failure lets the run read on", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1], { next: "c1" })], { state }).run({ budget: { pages: 1 } });
  await harness([page(after("c1"), [ticket("t1", "Renamed")], { next: "c2" })], { state }).run({ budget: { pages: 1 }, commit: async (p) => ({ retry: p.changes.map((c) => c.external_id) }) });
  const failing = async (p: PageCommit) => { if (p.replay) throw new Error("cannot plan"); };
  for (let n = 1; n <= MAX_REPLAY_FAILURES; n++) {
    const h = harness([page(after(`c${n + 1}`), [], { next: `c${n + 2}` })], { state });
    const receipt = await h.run({ budget: { pages: 1 }, commit: failing });
    assert.equal(receipt.pages, 1, `run ${n} read the provider`);
    const keys = receipt.findings.map((f) => f.key);
    if (n < MAX_REPLAY_FAILURES) {
      assert.deepEqual(keys, ["source:tickets:replay_failed"]);
      assert.equal((await state.read(FEED_ID))!.state.pending?.t1?.replay_failures, n);
    } else {
      assert.deepEqual(keys, ["source:tickets:replay_failed", "source:tickets:replay_dropped"]);
      assert.equal((await state.read(FEED_ID))!.state.pending, undefined);
      assert.equal((await state.read(FEED_ID))!.state.records.t1!.after.title, "First");
    }
  }
});

test("a profile id change resets the cursor like a version change", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1], { next: "c1" }), { request: { url: after("c1") }, response: { status: 500, body: "" } }], { state }).run();
  const renamed: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, id: "json-pages-2" };
  const connector = ticketConnector(CONNECTOR_MD.replace("profile: json-pages", "profile: json-pages-2"));
  const h = harness([page(ITEMS, [T1])], { state, connector });
  const receipt = await h.run({ profile: renamed });
  assert.equal(receipt.cursor_reset, "profile_version");
  assert.deepEqual(pages(h.peer), [ITEMS]);
});

test("robots.txt redirects past the limit, without a location, or over the bound leave the host unreadable", async () => {
  const loop = harness((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/robots")) return { status: 302, headers: { location: `/robots-${Number(url.searchParams.get("n") ?? 0) + 1}.txt` }, body: "" };
    return json([T1]);
  });
  assert.equal((await loop.run()).reason, "robots_unavailable");
  assert.equal(loop.peer.received.length, 6, "the robots read follows five redirects, then gives up");
  for (const robots of [{ status: 301, body: "" }, { status: 200, body: "x".repeat(600_000) }] as const) {
    const h = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? robots : json([T1])));
    assert.equal((await h.run({ budget: { maxBytes: 1000 } })).reason, "robots_unavailable");
    assert.deepEqual(pages(h.peer), []);
  }
});

test("the receipt counts written changes by kind and held ones apart", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1, T2])], { state }).run({ mode: "complete" });
  const receipt = await harness([page(ITEMS, [ticket("t1", "Renamed"), ticket("t3", "Third")])], { state }).run({ mode: "complete", commit: async () => ({ retry: ["t3"] }) });
  assert.deepEqual(receipt.changes, { new: 0, changed: 1, disappeared: 0 });
  assert.equal(receipt.held, 1);
  assert.equal(receipt.pending, 1);
});

test("a replay keeps the stored missing count and never replays a record that disappeared", async () => {
  const state = new MemoryMachineState();
  await harness([page(ITEMS, [T1, T2])], { state }).run({ mode: "complete" });
  const { state: stored, version } = (await state.read(FEED_ID))!;
  const entry = (title: string) => ({ after: { ...stored.records.t1!.after, title }, digest: "sha256:x", missing: 0, seen_at: AT });
  const change = (id: string, title: string) => ({ external_id: id, change_kind: "changed", changed_fields: ["title"], before: stored.records[id]!.after, after: { ...stored.records[id]!.after, title }, content_digest: "sha256:x" });
  await state.write(FEED_ID, {
    ...stored,
    records: { ...stored.records, t1: { ...stored.records.t1!, missing: 1, first_missing_at: AT }, t2: { ...stored.records.t2!, missing: 2, gone: true } },
    pending: { t1: { change: change("t1", "Renamed"), entry: entry("Renamed"), held_at: AT }, t2: { change: change("t2", "Gone"), entry: entry("Gone"), held_at: AT } },
  }, version);
  const seen: PageCommit[] = [];
  await harness(() => json([]), { state }).run({ commit: async (p) => { seen.push(p); } });
  assert.deepEqual(seen[0]!.changes.map((c) => c.external_id), ["t1"], "the disappeared t2 is not replayed");
  const after = (await state.read(FEED_ID))!.state;
  assert.equal(after.records.t1!.after.title, "Renamed");
  assert.equal(after.records.t1!.missing, 1);
  assert.equal(after.records.t1!.first_missing_at, AT);
  assert.equal(after.records.t2!.gone, true);
  assert.equal(after.pending, undefined);
});

const establishmentFor = (p: PageCommit) => ({ contract: 1 as const, generation: "synthetic-v1", group: "original-group", target: "tickets/canonical", kind: "adopt" as const, expectedVersion: "approved-version", observed_at: p.observed_at });
test("establishment write-ahead CAS loss prevents effects and preserves old observation", async () => {
  const h = harness([page(ITEMS, [T1])]); let effects = 0;
  const receipt = await h.run({ state: { read: h.state.read.bind(h.state), async write() { throw new MachineStateConflict(FEED_ID); } },
    prepareCommit: async p => ({ establishments: { t1: establishmentFor(p) } }), commit: async () => { effects++; } });
  assert.equal(receipt.reason, "state_conflict"); assert.equal(effects, 0); assert.equal(await h.state.read(FEED_ID), null);
});
test("marked establishments remain literal and block acquisition beyond ordinary replay exhaustion", async () => {
  const h = harness([page(ITEMS, [T1])]); let literal: PageCommit | undefined;
  const first = await h.run({ prepareCommit: async p => ({ establishments: { t1: establishmentFor(p) } }), commit: async p => { literal = structuredClone(p); throw new Error("unknown"); } });
  assert.equal(first.reason, "commit_failed"); const original = (await h.state.read(FEED_ID))!;
  assert.equal(original.state.records.t1, undefined); assert.equal(original.state.complete_observations, 0);
  for (let i = 0; i < MAX_REPLAY_FAILURES + 2; i++) {
    const replay = harness(() => { throw new Error("provider must not be read"); }, { state: h.state });
    const receipt = await replay.run({ now: () => new Date("2026-10-24T19:00:00Z"), prepareCommit: async () => { throw new Error("must not prepare replay"); }, commit: async p => {
      assert.deepEqual(p.establishments, literal!.establishments); assert.deepEqual(p.changes, literal!.changes); return { hold: ["t1"] };
    } });
    assert.equal(receipt.reason, "establishment_pending"); assert.equal(replay.peer.received.length, 0);
    assert.deepEqual(await h.state.read(FEED_ID), original);
  }
});
test("establishment bounds and malformed descriptors refuse before pending publication or effects", async () => {
  for (const make of [
    (p: PageCommit) => ({ unknown: establishmentFor(p) }),
    (p: PageCommit) => ({ t1: { ...establishmentFor(p), target: "../escape" } }),
    (p: PageCommit) => ({ t1: { ...establishmentFor(p), kind: "create", expectedVersion: null } }),
  ]) {
    const h = harness([page(ITEMS, [T1])]); let effects = 0;
    const receipt = await h.run({ prepareCommit: async p => ({ establishments: make(p) as never }), commit: async () => { effects++; } });
    assert.equal(receipt.reason, "commit_failed"); assert.equal(effects, 0); assert.equal(await h.state.read(FEED_ID), null);
  }
});
