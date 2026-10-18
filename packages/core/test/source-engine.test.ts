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

function boundFor(connector: Connector, feed: Record<string, unknown> = FEED_FRONTMATTER): BoundFeed {
  const registry = buildKindRegistry([TICKET_CONVENTION], [], { okfVersion: "0.2" });
  return bindSourceFeed(connector, { id: FEED_ID, frontmatter: feed as never }, registry, { okfVersion: "0.2" });
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
  const github = ticketConnector(CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github"));
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
  const github = ticketConnector(CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github"));
  const profile: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, hostsFor: () => ["api.github.com", HOST] };
  const h = harness((request) => (new URL(request.url).hostname === "api.github.com"
    ? { status: 302, headers: { location: ITEMS }, body: "" }
    : json([])), { connector: github });
  const receipt = await h.run({ profile, spec: { ...SPEC, host: "api.github.com" } });
  assert.equal(receipt.reason, "redirect_refused");
  assert.deepEqual(h.peer.received.map((r) => new URL(r.url).hostname), ["api.github.com"]);
});

// ------------------------------------------------------------------------------- method and headers

test("a POST is refused unless a rule admits it; a GET with a body is refused; a POST is never redirected", async () => {
  const post = harness(() => json([]));
  assert.equal((await post.run({ spec: { ...SPEC, method: "POST" } })).reason, "method_refused");
  assert.deepEqual(post.peer.received, []);

  const admitted = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : json([T1])));
  const receipt = await admitted.run({ spec: { ...SPEC, method: "POST" }, rules: { post: (url) => url.pathname === "/boards/main/items" } });
  assert.equal(receipt.outcome, "observed");
  assert.equal(admitted.peer.received.at(-1)!.method, "POST");

  const bodied: SourceProfile<JsonPagesSpec, unknown> = { ...jsonPagesProfile, async observe({ transport }) { await transport.request({ url: ITEMS, body: "{}" }); return { records: [], nextCursor: null, more: false, complete: false }; } };
  assert.equal((await harness(() => json([])).run({ profile: bodied })).reason, "body_refused");

  const moved = harness((request) => (new URL(request.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 307, headers: { location: `${ITEMS}-2` }, body: "" }));
  assert.equal((await moved.run({ spec: { ...SPEC, method: "POST" }, rules: { post: () => true } })).reason, "redirect_refused");
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

  const github = ticketConnector(CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github"));
  const api = harness(() => json([]), { connector: github });
  await api.run({ spec: { ...SPEC, host: "api.github.com" } });
  assert.deepEqual(api.peer.received.map((r) => new URL(r.url).pathname), ["/boards/main/items"]);
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

test("a held record keeps its stored entry while the cursor advances, so the next observation plans it again", async () => {
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
