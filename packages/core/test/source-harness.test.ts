/**
 * `@superbee/core/source-harness`: the required scenarios through the `json-pages` test profile,
 * each held to its outcome rule; the rules failing for a run that breaks them; and the transport
 * conformance suite passing for the memory transport and failing for transports that follow
 * redirects, forward the credential, truncate a body or never send it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkScenario,
  CONFORMANCE_SCENARIOS,
  missingScenarios,
  peerTransport,
  REQUIRED_SCENARIOS,
  runSourceFixture,
  runSourceScenario,
  runTransportConformance,
  ScriptedPeer,
  type ScenarioResult,
  type TransportConformanceTarget,
  type TransportCredential,
} from "../src/source-harness/index.js";
import type { Transport, TransportResult } from "../src/source-engine/index.js";
import { HOSTILE, ITEMS, SCENARIOS, ticketFixture } from "./fixtures/source-engine/tickets.js";

const byName = new Map<string, ScenarioResult>();
async function scenario(name: string): Promise<ScenarioResult> {
  let result = byName.get(name);
  if (!result) {
    const script = SCENARIOS.find((s) => s.name === name);
    assert.ok(script, name);
    result = await runSourceScenario(ticketFixture(), script);
    byName.set(name, result);
  }
  return result;
}

test("the ticket fixture covers every required scenario and passes every outcome rule", async () => {
  const { problems, missing, results } = await runSourceFixture(ticketFixture(), SCENARIOS);
  assert.deepEqual(missing, []);
  assert.deepEqual(problems, {});
  assert.equal(results.length, SCENARIOS.length);
});

test("missingScenarios names what a fixture lacks and counts a variant toward its base", () => {
  assert.deepEqual(missingScenarios(REQUIRED_SCENARIOS.filter((name) => name !== "cursor.resume")), ["cursor.resume"]);
  assert.deepEqual(missingScenarios([...REQUIRED_SCENARIOS.filter((name) => name !== "cursor.resume"), "cursor.resume.page-number"]), []);
  assert.deepEqual(missingScenarios(["cursor.resumed"]).includes("cursor.resume"), true);
});

test("errors: 401 is credential_refused with no retry and nothing written; 429 after page 1 defers with the cursor at page 1", async () => {
  const auth = (await scenario("errors.auth")).runs[0]!;
  assert.equal(auth.receipt.outcome, "credential_refused");
  assert.equal(auth.receipt.retry, false);
  assert.equal(auth.state, null);
  assert.deepEqual(auth.receipt.findings.map((f) => f.key), ["source:tickets:credential_refused"]);
  assert.deepEqual(auth.findings.results.map((r) => [r.op, r.outcome]), [["create-signal", "applied"]]);

  const rate = (await scenario("errors.rate-limit")).runs[0]!;
  assert.equal(rate.receipt.outcome, "deferred");
  assert.equal(rate.receipt.pages, 1);
  assert.deepEqual(rate.state?.cursor, { after: "c1" });
  assert.equal(rate.state?.open, true);
  assert.equal(rate.receipt.retry_after, "2026-01-01T00:02:00.000Z");
  assert.deepEqual(Object.keys(rate.state!.records), ["t1"]);
});

test("page.incomplete: page 2 of a complete pass times out, page 1 stays committed and the pass is partial", async () => {
  const run = (await scenario("page.incomplete")).runs[0]!;
  assert.equal(run.receipt.outcome, "deferred");
  assert.equal(run.receipt.reason, "deadline");
  assert.deepEqual(run.state?.cursor, { after: "c1" });
  assert.equal(run.state?.complete_observations, 0);
  assert.deepEqual(run.receipt.findings, [], "a deadline is a scheduling matter, not a finding");
});

test("cursor.resume: run 2 asks only for what the cursor admits and the overlap record yields no change", async () => {
  const [first, second] = (await scenario("cursor.resume")).runs;
  assert.deepEqual(first!.state?.cursor, { after: "c1" });
  assert.equal(second!.receipt.pass.resumed, true);
  assert.deepEqual(second!.received.filter((r) => !r.url.endsWith("/robots.txt")).map((r) => r.url), [`${ITEMS}?after=c1`]);
  assert.deepEqual(second!.changes.map((c) => [c.external_id, c.change_kind]), [["t3", "new"]]);
  assert.equal(second!.receipt.pass.complete, false);
});

test("cursor.resume.page-number: the resumed pass restarts at page 1 and never counts as complete", async () => {
  const [, second] = (await scenario("cursor.resume.page-number")).runs;
  assert.deepEqual(second!.received.filter((r) => !r.url.endsWith("/robots.txt")).map((r) => new URL(r.url).search), ["?page=1", "?page=2"]);
  assert.equal(second!.receipt.pass.ended, true);
  assert.equal(second!.receipt.pass.complete, false);
  assert.equal(second!.state?.complete_observations, 0);
});

test("cursor.hostile: a hostile token stays one query value; a next URL to another host or with userinfo is refused unsent", async () => {
  const [token, otherHost, userinfo] = (await scenario("cursor.hostile")).runs;
  const second = new URL(token!.received.at(-1)!.url);
  assert.equal(second.hostname, "tickets.example.org");
  assert.equal(second.pathname, "/boards/main/items");
  assert.deepEqual([...second.searchParams.keys()], ["after"]);
  assert.equal(second.searchParams.get("after"), HOSTILE);
  assert.equal(otherHost!.receipt.reason, "host_refused");
  assert.equal(userinfo!.receipt.reason, "address_refused");
  for (const run of [otherHost!, userinfo!]) {
    assert.ok(run.received.every((r) => new URL(r.url).hostname === "tickets.example.org"));
    assert.equal(run.receipt.pages, 1, "the page carrying the hostile next URL committed; nothing after it did");
  }
});

test("complete.disappear: disappeared after exactly two complete observations, the partial and resumed passes not counting", async () => {
  const runs = (await scenario("complete.disappear")).runs;
  assert.deepEqual(runs.map((run) => run.receipt.pass.complete), [true, true, false, false, true]);
  assert.deepEqual(runs.map((run) => run.state?.records.t3?.missing), [0, 1, 1, 1, 2]);
  assert.deepEqual(runs.map((run) => run.changes.filter((c) => c.change_kind === "disappeared").map((c) => c.external_id)), [[], [], [], [], ["t3"]]);
  assert.equal(runs[4]!.changes.find((c) => c.change_kind === "disappeared")!.first_missing_at, "2026-01-01T01:00:00.000Z");
});

test("fields: an editor's value wins a conflict; an unmapped value is kept; null clears an optional field and keeps a required one", async () => {
  const conflict = (await scenario("fields.owned-conflict")).runs[1]!;
  assert.equal(conflict.documents["tickets/t1"]!.title, "Editor's title");
  assert.ok(conflict.overlay[0]!.refusals.some((r) => r.code === "OVERLAY_DOC_CONFLICT" && r.field === "title"));

  const unmapped = (await scenario("fields.unmapped")).runs[1]!;
  assert.equal(unmapped.documents["tickets/t2"]!.state, "open");
  assert.ok(unmapped.receipt.findings.some((f) => f.key.startsWith("mapping:tickets:state:VALUE_UNMAPPED")));

  const empty = (await scenario("fields.null")).runs[1]!;
  assert.equal(Object.hasOwn(empty.documents["tickets/t1"]!, "priority"), false);
  assert.equal(empty.documents["tickets/t3"]!.title, "Third");
  assert.equal(empty.documents["tickets/t3"]!.priority, "high");
});

test("hosts: a redirect to another host and an undeclared host are refused with no request to them; a POST is refused unsent", async () => {
  const redirect = (await scenario("hosts.redirect")).runs[0]!;
  assert.equal(redirect.receipt.reason, "host_refused");
  assert.equal(redirect.received.filter((r) => new URL(r.url).hostname === "cdn.example.net").length, 0);
  const undeclared = (await scenario("hosts.undeclared")).runs[0]!;
  assert.equal(undeclared.receipt.reason, "hosts_undeclared");
  assert.deepEqual(undeclared.received, []);
  const post = (await scenario("hosts.undeclared.post")).runs[0]!;
  assert.equal(post.receipt.reason, "method_refused");
  assert.deepEqual(post.received, []);
});

test("an outcome rule fails for a run that breaks it", async () => {
  const clone = (result: ScenarioResult): ScenarioResult => structuredClone(result);
  const resume = clone(await scenario("cursor.resume"));
  resume.runs[1]!.receipt.pass.complete = true;
  assert.ok(checkScenario(resume).some((p) => /counted it complete/.test(p)));

  const disappear = clone(await scenario("complete.disappear"));
  disappear.runs[2]!.state!.records.t3!.missing = 2;
  assert.ok(checkScenario(disappear).some((p) => /not complete and counted t3 missing/.test(p)));

  const incomplete = clone(await scenario("page.incomplete"));
  incomplete.runs[0]!.state!.cursor = { after: "c2" };
  assert.ok(checkScenario(incomplete).length > 0);

  const auth = clone(await scenario("errors.auth"));
  auth.runs[0]!.receipt.retry = true;
  assert.ok(checkScenario(auth).length > 0);

  const redirect = clone(await scenario("hosts.redirect"));
  redirect.runs[0]!.received.push({ url: "https://cdn.example.net/items.json", method: "GET", headers: {} });
  assert.ok(checkScenario(redirect).some((p) => /undeclared host cdn\.example\.net/.test(p)));
});

test("a fixture whose profile makes an unscripted request fails", async () => {
  const result = await runSourceScenario(ticketFixture(), { name: "errors.server", runs: [{ exchanges: [] }] });
  assert.ok(checkScenario(result).some((p) => /unscripted request: GET https:\/\/tickets\.example\.org\/boards\/main\/items/.test(p)));
});

// ------------------------------------------------------------------------------------- conformance

const memory: TransportConformanceTarget = { name: "memory", create: (peer, credential) => peerTransport(peer, { credential }) };

test("the memory transport passes every conformance scenario", async () => {
  const rows = await runTransportConformance(memory);
  assert.deepEqual(rows.map((r) => r.scenario), [...CONFORMANCE_SCENARIOS]);
  assert.deepEqual(rows.filter((r) => !r.ok), []);
});

/** A transport that follows redirects itself, as `fetch` does by default. */
const following: TransportConformanceTarget = {
  name: "follows redirects",
  create(peer, credential) {
    const inner = peerTransport(peer, { credential });
    return {
      async request(input) {
        let result = await inner.request(input);
        for (let hop = 0; hop < 5 && result.ok && [301, 302, 303, 307, 308].includes(result.status) && result.headers.location; hop++) {
          result = await inner.request({ ...input, url: new URL(result.headers.location, input.url).href });
        }
        return result;
      },
    };
  },
};

/** A transport whose credential decision is `send` over the URL and the engine's flag. */
function deciding(name: string, send: (url: URL, credentialHost: boolean, credential: TransportCredential) => boolean): TransportConformanceTarget {
  return {
    name,
    create(peer, credential): Transport {
      const inner = peerTransport(peer);
      return {
        request(input) {
          const url = new URL(input.url);
          const headers = send(url, input.credentialHost, credential) ? { ...input.headers, [credential.header.toLowerCase()]: credential.value } : input.headers;
          return inner.request({ ...input, headers, credentialHost: false });
        },
      };
    },
  };
}

/** A transport that sends the credential with every request. */
const forwarding = deciding("forwards the credential", () => true);
/** A transport that matches credential hosts by prefix. */
const prefixing = deciding("matches the credential host by prefix", (url, flag, credential) => flag && credential.hosts.some((host) => url.hostname.startsWith(host)));
/** A transport that ignores the engine's decision and trusts its own exact match alone. */
const unflagged = deciding("ignores the engine's credential decision", (url, _flag, credential) => url.protocol === "https:" && credential.hosts.includes(url.hostname));

/** A transport that truncates a long body instead of refusing it. */
const truncating: TransportConformanceTarget = {
  name: "truncates",
  create(peer, credential): Transport {
    const inner = peerTransport(peer, { credential });
    return {
      async request(input): Promise<TransportResult> {
        const result = await inner.request({ ...input, maxBytes: Number.MAX_SAFE_INTEGER });
        if (!result.ok) return result;
        const body = result.body.slice(0, Math.floor(input.maxBytes / 2));
        return { ...result, body, bytes: new TextEncoder().encode(body).length };
      },
    };
  },
};

/** A transport that drops the credential altogether. */
const silent: TransportConformanceTarget = { name: "never sends the credential", create: (peer) => peerTransport(peer) };

/** A custom-header credential sent under `authorization` only. */
const renaming: TransportConformanceTarget = {
  name: "renames the credential header",
  create: (peer, credential: TransportCredential) => peerTransport(peer, { credential: { ...credential, header: "authorization" } }),
};

for (const [target, failing] of [
  [following, ["redirect-returned-unfollowed", "cross-host-redirect-refused", "private-redirect-refused"]],
  [forwarding, ["credential-stays-on-its-host", "cross-host-redirect-refused"]],
  [prefixing, ["credential-stays-on-its-host"]],
  [unflagged, ["credential-stays-on-its-host"]],
  [truncating, ["body-over-bound-refused"]],
  [silent, ["credential-reaches-its-host"]],
  [renaming, ["credential-reaches-its-host"]],
] as const) {
  test(`the conformance suite fails a transport that ${target.name}`, async () => {
    const rows = await runTransportConformance(target);
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.scenario), [...failing], JSON.stringify(rows, null, 2));
  });
}

test("the scripted peer records exactly what a transport sent; the memory transport needs the engine's flag and its own match", async () => {
  const peer = new ScriptedPeer(() => ({ status: 200, body: "{}" }));
  const transport = peerTransport(peer, { credential: { hosts: ["api.github.com"], header: "Authorization", value: "Bearer t" } });
  await transport.request({ url: "https://api.github.com/x", method: "GET", headers: { Accept: "application/json" }, maxBytes: 10, credentialHost: true });
  await transport.request({ url: "https://api.github.com/y", method: "GET", headers: {}, maxBytes: 10, credentialHost: false });
  await transport.request({ url: "https://api.github.com.collector.example.net/z", method: "GET", headers: {}, maxBytes: 10, credentialHost: true });
  assert.deepEqual(peer.received, [
    { url: "https://api.github.com/x", method: "GET", headers: { accept: "application/json", authorization: "Bearer t" } },
    { url: "https://api.github.com/y", method: "GET", headers: {} },
    { url: "https://api.github.com.collector.example.net/z", method: "GET", headers: {} },
  ]);
});

test("cursor.hostile needs a refused provider-steered request, not a plain listing", async () => {
  const plain = await runSourceScenario(ticketFixture(), { name: "cursor.hostile", runs: [{ exchanges: [{ request: { url: ITEMS }, response: { status: 200, body: JSON.stringify({ items: [] }) } }] }] });
  assert.ok(checkScenario(plain).some((p) => /provider-steered/.test(p)));
});
