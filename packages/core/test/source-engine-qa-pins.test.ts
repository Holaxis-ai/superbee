/**
 * Adversarial QA pins for the source engine: lookalike and normalized hosts on the first
 * request, on a redirect hop and on robots.txt; the engine-owned credential flag; the POST, method
 * and byte-bound rules toward a credential host; robots.txt 5xx; redirects that keep or change host
 * inside the host set; a replay the commit holds for good; and transports the conformance suite
 * must fail. Each test fails when the guard it names is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectSourceFiles, egressViolations } from "../../../scripts/source-egress-check.mjs";

import { bindSourceFeed, type BoundFeed, type Connector } from "../src/connectors.js";
import { buildKindRegistry } from "../src/kinds.js";
import {
  fetchIdentity,
  MemoryMachineState,
  observeSource,
  type FetchIdentity,
  type ObserveSourceOptions,
  type PageCommit,
  type SourceProfile,
  type TransportRequest,
  type TransportResult,
} from "../src/source-engine/index.js";
import {
  peerTransport,
  runTransportConformance,
  ScriptedPeer,
  type PeerRequest,
  type PeerResponse,
  type TransportConformanceTarget,
  type TransportCredential,
} from "../src/source-harness/index.js";
import { robotsDecision } from "../src/source-engine/robots.js";
import { loadKinds } from "../src/kinds-load.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { mutateDocument } from "../src/document-mutation.js";
import { HOLD_STORE, RETRYABLE } from "../src/record-overlay/errors.js";
import { applyRecordOverlay } from "../src/record-overlay/apply.js";
import { planRecordOverlay } from "../src/record-overlay/plan.js";
import type { OverlayBundle, OverlayReceipt } from "../src/record-overlay/types.js";
import type { MachineState } from "../src/source-engine/index.js";
import { jsonPagesProfile, type JsonPagesSpec } from "./fixtures/source-engine/json-pages-profile.js";
import { CONNECTOR_MD, FEED_FRONTMATTER, FEED_ID, HOST, ITEMS, SPEC, TICKET_CONVENTION, ticket, ticketConnector, ticketDocuments } from "./fixtures/source-engine/tickets.js";

const IDENTITY = fetchIdentity("SuperbeeQa/1 (+https://superbee.example.org/qa)") as FetchIdentity;
const API = "api.github.com";
const GITHUB_MD = CONNECTOR_MD.replace("auth:\n  kind: none", "auth:\n  kind: token\n  provider: github");
const MIRROR = "mirror.example.org";
const TWO_KEYLESS_MD = CONNECTOR_MD.replace(`domains:\n  - ${HOST}`, `domains:\n  - ${HOST}\n  - ${MIRROR}`);

function boundFor(connector: Connector): BoundFeed {
  const registry = buildKindRegistry([TICKET_CONVENTION], [], { okfVersion: "0.2" });
  return bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED_FRONTMATTER as never }, registry, { okfVersion: "0.2" });
}

const ok = (body = JSON.stringify({ items: [] }), status = 200, headers: Record<string, string> = {}): TransportResult =>
  ({ ok: true, status, headers, body, bytes: new TextEncoder().encode(body).length });

/** A transport that records the URL and the engine's flag of every request, answering from `answer`. */
function recorder(answer: (url: URL) => TransportResult = () => ok()) {
  const sent: Array<{ url: string; credentialHost: boolean; method: string }> = [];
  return {
    sent,
    transport: { async request(input: TransportRequest) { sent.push({ url: input.url, credentialHost: input.credentialHost, method: input.method }); return answer(new URL(input.url)); } },
  };
}

/** One profile request of `url` (and its options) through the engine, toward both declared hosts. */
function oneRequest(url: string, extra: Record<string, unknown> = {}): SourceProfile<JsonPagesSpec, unknown> {
  return {
    ...jsonPagesProfile,
    hostsFor: () => [API, HOST],
    async observe({ transport }) {
      await transport.request({ url, ...extra } as never);
      return { records: [], nextCursor: null, more: false, complete: false };
    },
  };
}

function run(options: Partial<ObserveSourceOptions<JsonPagesSpec, unknown>> & Pick<ObserveSourceOptions<JsonPagesSpec, unknown>, "transport">, connector = ticketConnector(GITHUB_MD)) {
  return observeSource({
    connector, bound: boundFor(connector), profile: jsonPagesProfile, spec: SPEC, state: new MemoryMachineState(), identity: IDENTITY,
    now: () => new Date("2026-03-01T12:00:00.000Z"), commit: async () => {}, ...options,
  });
}

/** Hosts and forms that are not the declared hosts, however they are written. */
const LOOKALIKES = [
  `https://${API}./x`, `https://${API}%2e/x`, `https://${API}．/x`, `https://${API}:8443/x`, `http://${API}/x`, `wss://${API}/x`,
  `https://${API}.evil.example.net/x`, `https://${API}。evil.example.net/x`, `https://evil${API}/x`, `https://${API}@evil.example.net/x`,
  `https://evil.example.net\\@${API}/x`, "https://аpi.github.com/x", `https://${HOST}./x`, `https://${HOST}.evil.example.net/x`,
  "https://[::ffff:127.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://[::1]/x", "https://2130706433/x", "https://0x7f000001/x", "https://127.1/x",
  "https://169.254.169.254/latest/meta-data/", "https://metadata.google.internal/x", "https://localhost/x",
];

test("a lookalike or private host is refused unsent on the first request, whatever its spelling", async () => {
  for (const url of LOOKALIKES) {
    const { sent, transport } = recorder();
    const receipt = await run({ profile: oneRequest(url), transport });
    assert.equal(receipt.outcome, "refused", url);
    assert.deepEqual(sent, [], url);
  }
});

test("a spelling that normalizes to a declared host reaches only that host, flagged by the engine's own decision", async () => {
  for (const [url, host] of [[`https://API.GITHUB.COM/x`, API], [`https://${API}:443/x`, API], ["https://api%2egithub%2ecom/x", API], ["https://ａｐｉ.github.com/x", API], [`https://TICKETS.example.org/boards/main/items`, HOST]] as const) {
    const { sent, transport } = recorder((u) => (u.pathname === "/robots.txt" ? ok("", 404) : ok()));
    await run({ profile: oneRequest(url), transport });
    assert.ok(sent.length > 0, url);
    for (const row of sent) {
      assert.equal(new URL(row.url).hostname, host, url);
      assert.equal(row.credentialHost, host === API, `${url}: ${row.url}`);
    }
  }
});

test("a redirect hop to a lookalike or private host is refused unsent, from a keyless host and from the credential host", async () => {
  for (const from of [ITEMS, `https://${API}/repos/o/r/issues`]) {
    for (const to of LOOKALIKES) {
      const { sent, transport } = recorder((u) => (u.pathname === "/robots.txt" ? ok("", 404) : u.href === from ? ok("", 302, { location: to }) : ok()));
      const receipt = await run({ profile: oneRequest(from), transport });
      assert.equal(receipt.outcome, "refused", `${from} -> ${to}`);
      assert.deepEqual(sent.map((r) => r.url).filter((u) => u !== from && !u.endsWith("/robots.txt")), [], `${from} -> ${to}`);
    }
  }
});

test("robots.txt is never sent with the credential flag, and a robots redirect to the credential host is refused unsent", async () => {
  const { sent, transport } = recorder((u) => (u.pathname === "/robots.txt" && u.hostname === HOST ? ok("", 301, { location: `https://${API}/robots.txt` }) : ok()));
  const receipt = await run({ profile: oneRequest(ITEMS), transport });
  assert.equal(receipt.reason, "robots_unavailable");
  assert.deepEqual(sent.map((r) => [r.url, r.credentialHost]), [[`https://${HOST}/robots.txt`, false]]);
});

test("a profile cannot set the credential flag: the engine's host decision is the only source", async () => {
  const { sent, transport } = recorder((u) => (u.pathname === "/robots.txt" ? ok("", 404) : ok()));
  await run({ profile: oneRequest(ITEMS, { credentialHost: true }), transport });
  assert.deepEqual(sent.map((r) => [r.url, r.credentialHost]), [[`https://${HOST}/robots.txt`, false], [ITEMS, false]]);
});

test("a POST to the credential host is refused unsent unless rules.post admits it", async () => {
  for (const rules of [{}, { post: () => false }, { post: () => "yes" as unknown as boolean }]) {
    const { sent, transport } = recorder();
    const receipt = await run({ profile: oneRequest(`https://${API}/graphql`, { method: "POST", body: "{}" }), transport, rules });
    assert.equal(receipt.reason, "method_refused", JSON.stringify(rules));
    assert.deepEqual(sent, []);
  }
});

test("a method other than GET or POST is refused unsent", async () => {
  for (const method of ["DELETE", "PUT", "PATCH", "get", "HEAD"]) {
    const { sent, transport } = recorder();
    const receipt = await run({ profile: oneRequest(`https://${API}/repos/o/r`, { method }), transport, rules: { post: () => true } });
    assert.equal(receipt.reason, "method_refused", method);
    assert.deepEqual(sent, [], method);
  }
});

test("a profile byte bound that is not a positive integer is refused unsent, so it cannot lift the run's bound", async () => {
  for (const maxBytes of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, "100"]) {
    const { sent, transport } = recorder();
    const receipt = await run({ profile: oneRequest(`https://${API}/x`, { maxBytes }), transport });
    assert.equal(receipt.reason, "request_invalid", String(maxBytes));
    assert.deepEqual(sent, [], String(maxBytes));
  }
});

test("robots.txt answering any 5xx, 500 included, refuses the keyless host", async () => {
  for (const status of [500, 502, 503, 599]) {
    const { sent, transport } = recorder((u) => (u.pathname === "/robots.txt" ? ok("", status) : ok()));
    const receipt = await run({ profile: oneRequest(ITEMS), transport });
    assert.equal(receipt.reason, "robots_unavailable", String(status));
    assert.deepEqual(sent.map((r) => r.url), [`https://${HOST}/robots.txt`], String(status));
  }
});

test("a same-host redirect on the credential host is followed, and so is one between two declared keyless hosts", async () => {
  const api = recorder((u) => (u.pathname === "/a" ? ok("", 301, { location: `https://${API}/b` }) : ok()));
  assert.equal((await run({ profile: oneRequest(`https://${API}/a`), transport: api.transport })).outcome, "observed");
  assert.deepEqual(api.sent.map((r) => [r.url, r.credentialHost]), [[`https://${API}/a`, true], [`https://${API}/b`, true]]);

  const keyless = recorder((u) => (u.pathname === "/robots.txt" ? ok("", 404) : u.hostname === HOST ? ok("", 302, { location: `https://${MIRROR}/items` }) : ok()));
  const profile: SourceProfile<JsonPagesSpec, unknown> = { ...oneRequest(ITEMS), hostsFor: () => [HOST, MIRROR] };
  assert.equal((await run({ profile, transport: keyless.transport }, ticketConnector(TWO_KEYLESS_MD))).outcome, "observed");
  assert.deepEqual(keyless.sent.map((r) => r.url), [`https://${HOST}/robots.txt`, ITEMS, `https://${MIRROR}/robots.txt`, `https://${MIRROR}/items`]);
});

test("a replayed change the commit holds for good leaves the stored entry where it was and is no longer pending", async () => {
  const state = new MemoryMachineState();
  const peer = (items: unknown[]) => peerTransport(new ScriptedPeer((r: PeerRequest): PeerResponse => (new URL(r.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 200, body: JSON.stringify({ items }) })));
  const connector = ticketConnector();
  await run({ state, transport: peer([ticket("t1", "First")]), mode: "complete" }, connector);
  await run({ state, transport: peer([ticket("t1", "Renamed")]), mode: "complete", commit: async (p: PageCommit) => ({ retry: p.changes.map((c) => c.external_id) }) }, connector);
  assert.ok((await state.read(FEED_ID))!.state.pending?.t1);
  const receipt = await run({ state, transport: peer([]), mode: "incremental", commit: async (p: PageCommit) => (p.replay ? { hold: ["t1"] } : {}) }, connector);
  const stored = (await state.read(FEED_ID))!.state;
  assert.equal(stored.records.t1!.after.title, "First");
  assert.equal(stored.pending, undefined);
  assert.equal(receipt.held, 1);
});

/** A transport whose credential decision is `send` over the URL and the engine's flag. */
function deciding(name: string, send: (url: URL, flag: boolean, credential: TransportCredential) => boolean): TransportConformanceTarget {
  return {
    name,
    create(peer, credential) {
      const inner = peerTransport(peer);
      return {
        request(input) {
          const headers = send(new URL(input.url), input.credentialHost, credential) ? { ...input.headers, [credential.header.toLowerCase()]: credential.value } : input.headers;
          return inner.request({ ...input, headers, credentialHost: false });
        },
      };
    },
  };
}

for (const target of [
  deciding("trusts the engine's flag alone", (_url, flag) => flag),
  deciding("matches the credential host as a suffix", (url, flag, c) => flag && c.hosts.some((h) => url.hostname.endsWith(h))),
  deciding("strips a trailing dot before matching", (url, flag, c) => flag && url.protocol === "https:" && c.hosts.includes(url.hostname.replace(/\.$/, ""))),
  deciding("ignores the port", (url, flag, c) => flag && url.protocol === "https:" && c.hosts.includes(url.hostname)),
  deciding("ignores the scheme", (url, flag, c) => flag && url.port === "" && c.hosts.includes(url.hostname)),
]) {
  test(`the conformance suite fails a transport that ${target.name}`, async () => {
    const rows = await runTransportConformance(target);
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.scenario), ["credential-stays-on-its-host"], JSON.stringify(rows));
  });
}

test("a robots line that is not a key and value pair does not end a User-agent group, as in hosted", () => {
  for (const line of ["foo bar: x", "Dis allow: /y", "x y z", ": /z"]) {
    const text = `User-agent: a\n${line}\nUser-agent: b\nDisallow: /\n`;
    assert.equal(robotsDecision(text, "/x", "a").allow, false, line);
  }
});

test("the egress walk scans modules in nested directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "egress-qa-"));
  try {
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    writeFileSync(path.join(root, "a", "b", "deep.ts"), "export const go = () => fetch(\"x\");\n");
    const files = collectSourceFiles([root]);
    assert.deepEqual(files.map((f: { path: string }) => path.relative(root, f.path)), [path.join("a", "b", "deep.ts")]);
    assert.ok(egressViolations(files, { roots: [root] }).some((v: string) => /global fetch/.test(v)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The fixture's overlay commit over a MemoryBackend bundle. */
async function overlayWorld() {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# QA\n");
  const bundle = { root: "memory://qa", backend };
  for (const doc of ticketDocuments()) await backend.write(doc.id, { id: doc.id, frontmatter: structuredClone(doc.frontmatter), body: doc.body });
  const registry = await loadKinds(bundle);
  const overlay: OverlayBundle = { bundle, registry, okfVersion: "0.2" };
  const connector = ticketConnector();
  const bound = bindSourceFeed(connector, (await backend.read(FEED_ID)).doc, registry, { okfVersion: "0.2" });
  const receipts: OverlayReceipt[] = [];
  const commit = async (page: PageCommit) => {
    const plan = await planRecordOverlay({ content: overlay, ops: overlay, policy: bound.policy, changes: page.changes, observedAt: page.observed_at, records: page.records, sameBundle: true, observation: { baseline: page.baseline } });
    const applied = await applyRecordOverlay(plan, { content: overlay, ops: overlay, policy: bound.policy, actor: "process:qa" });
    receipts.push(applied);
    const refused = applied.results.filter((r) => r.outcome === "refused" && r.code !== undefined);
    return { retry: refused.filter((r) => RETRYABLE.has(r.code!)).map((r) => r.external_id), hold: refused.filter((r) => HOLD_STORE.has(r.code!) && !RETRYABLE.has(r.code!)).map((r) => r.external_id) };
  };
  const observe = (state: MachineState, items: unknown[], c: (p: PageCommit) => Promise<unknown>, at: string) => observeSource({
    connector, bound, profile: jsonPagesProfile, spec: SPEC, state, identity: IDENTITY, transport: peerTransport(new ScriptedPeer((r: PeerRequest): PeerResponse =>
      (new URL(r.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 200, body: JSON.stringify({ items }) }))), mode: "incremental",
    now: () => new Date(at), commit: c as never,
  });
  const edit = (id: string, set: Record<string, unknown>) => mutateDocument({ bundle, id, mode: "patch", registry, strict: false, actor: "human:qa-editor",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter, ...set } as never, body: existing!.body }) });
  const signals = async () => (await backend.list()).filter((id) => id.startsWith("signals/")).length;
  return { backend, receipts, commit, observe, edit, signals };
}

test("a replayed change never overwrites a person's edit made after it was held", async () => {
  const w = await overlayWorld();
  const state = new MemoryMachineState();
  await w.observe(state, [ticket("t1", "First")], w.commit, "2026-03-01T10:00:00.000Z");
  await w.observe(state, [ticket("t1", "Second name")], async (p) => ({ retry: p.changes.map((c) => c.external_id) }), "2026-03-01T11:00:00.000Z");
  await w.edit("tickets/t1", { title: "Editor's title" });
  await w.observe(state, [], w.commit, "2026-03-01T12:00:00.000Z");
  assert.equal((await w.backend.read("tickets/t1")).doc.frontmatter.title, "Editor's title");
  assert.ok(w.receipts.some((receipt) => receipt.refusals.some((r) => r.code === "OVERLAY_DOC_CONFLICT" && r.external_id === "t1")), "the replay meets the edit as a conflict");
});

test("a replay written before a crash is replayed again without a second write or a second Signal", async () => {
  const w = await overlayWorld();
  const memory = new MemoryMachineState();
  let crash = false;
  const state: MachineState = { read: (k) => memory.read(k), async write(k, v, e) { if (crash) { crash = false; throw new Error("process ended"); } return memory.write(k, v, e); } };
  await w.observe(state, [ticket("t1", "First")], w.commit, "2026-03-01T10:00:00.000Z");
  await w.observe(state, [ticket("t1", "Second name")], async (p) => ({ retry: p.changes.map((c) => c.external_id) }), "2026-03-01T11:00:00.000Z");
  const crashed = await w.observe(state, [], async (p) => { const r = await w.commit(p); if (p.replay) crash = true; return r; }, "2026-03-01T12:00:00.000Z");
  assert.equal(crashed.reason, "state_unwritable");
  assert.equal((await w.backend.read("tickets/t1")).doc.frontmatter.title, "Second name");
  const signals = await w.signals();
  w.receipts.length = 0;
  const again = await w.observe(state, [], w.commit, "2026-03-01T13:00:00.000Z");
  assert.equal(again.outcome, "observed");
  assert.equal(again.pending, 0);
  assert.equal(await w.signals(), signals, "no second Signal");
  assert.ok(w.receipts[0]!.results.every((r) => r.outcome !== "applied" || r.op !== "apply-owned-fields"), JSON.stringify(w.receipts[0]!.results));
});
