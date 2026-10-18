/**
 * The transport conformance suite. The engine's guard cannot see headers a transport adds after
 * it, so every transport proves against a scripted peer that it sends the credential only when the
 * engine's `credentialHost` and its own exact host match agree (lookalike hosts included), returns
 * redirects unfollowed and refuses a body over the bound, and, behind the engine, that a
 * cross-host or private-address redirect reaches nothing. It returns rows rather than asserting,
 * so it runs under any test runner.
 */
import { bindSourceFeed, credentialHosts, parseConnectorDoc, type BoundFeed, type Connector } from "../connectors.js";
import { buildKindRegistry } from "../kinds.js";
import { MemoryMachineState } from "../source-engine/machine-state.js";
import { observeSource } from "../source-engine/observe.js";
import { fetchIdentity, type FetchIdentity } from "../source-engine/robots.js";
import type { SourceProfile, SourceRunReceipt, Transport, TransportResult } from "../source-engine/types.js";
import { ScriptedPeer, type PeerRequest, type PeerResponse, type TransportCredential } from "./peer.js";

export interface TransportConformanceTarget {
  name: string;
  /** The transport under test, delivering its requests to `peer` and holding `credential`. */
  create(peer: ScriptedPeer, credential: TransportCredential): Transport;
}

export interface ConformanceRow {
  scenario: string;
  ok: boolean;
  detail?: string;
}

export const CONFORMANCE_SCENARIOS = Object.freeze([
  "credential-reaches-its-host",
  "credential-stays-on-its-host",
  "redirect-returned-unfollowed",
  "cross-host-redirect-refused",
  "body-over-bound-refused",
  "private-redirect-refused",
] as const);

const CREDENTIAL_HOST = "api.github.com";
const KEYLESS_HOST = "feeds.example.org";
const OUTSIDE_HOST = "collector.example.net";
const PROBE = "conformance-probe";
const IDENTITY = fetchIdentity("SuperbeeConformance/1 (+https://superbee.example.org/conformance)") as FetchIdentity;
const PRIVATE_TARGETS = Object.freeze([
  "https://127.0.0.1/latest",
  "https://10.0.0.5/internal",
  "https://[::1]/x",
  "https://[::ffff:127.0.0.1]/x",
  "https://169.254.169.254/latest/meta-data/",
  "https://metadata.google.internal/computeMetadata/v1/",
  "https://localhost/x",
  "https://api.github.com:8443/x",
  "http://api.github.com/x",
]);

/**
 * Requests that must never carry the credential: hosts that only look like the credential host,
 * whatever the engine says, and the credential host itself when the engine says it is not one.
 */
const CREDENTIAL_PROBES: ReadonlyArray<{ name: string; url: string; credentialHost: boolean }> = Object.freeze([
  { name: "a declared keyless host", url: `https://${KEYLESS_HOST}/feed.json`, credentialHost: true },
  { name: "an undeclared host", url: `https://${OUTSIDE_HOST}/collect`, credentialHost: true },
  { name: "the credential host over http", url: `http://${CREDENTIAL_HOST}/repos/octo/probe/issues`, credentialHost: true },
  { name: "a host starting with the credential host", url: `https://${CREDENTIAL_HOST}.${OUTSIDE_HOST}/x`, credentialHost: true },
  { name: "a host ending with the credential host without a dot", url: `https://evil${CREDENTIAL_HOST}/x`, credentialHost: true },
  { name: "the credential host with a trailing dot", url: `https://${CREDENTIAL_HOST}./x`, credentialHost: true },
  { name: "the credential host as userinfo", url: `https://${CREDENTIAL_HOST}@${OUTSIDE_HOST}/x`, credentialHost: true },
  { name: "the credential host on another port", url: `https://${CREDENTIAL_HOST}:8443/x`, credentialHost: true },
  { name: "the credential host when the engine says otherwise", url: `https://${CREDENTIAL_HOST}/repos/octo/probe/issues`, credentialHost: false },
]);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Requests the probe profile makes: one GET of `spec.url`, its host and `spec.also` declared. */
const probe: SourceProfile<{ url: string; also: string[] }, null> = {
  id: PROBE,
  version: 1,
  kind: "generic",
  validateSpec(spec) {
    if (!record(spec) || typeof spec.url !== "string") return { ok: false, errors: [{ path: "/url", message: "is a URL" }] };
    const also = Array.isArray(spec.also) ? spec.also.filter((host): host is string => typeof host === "string") : [];
    return { ok: true, spec: { url: spec.url, also } };
  },
  hostsFor: (spec) => [new URL(spec.url).hostname, ...spec.also],
  async observe({ spec, transport }) {
    await transport.request({ url: spec.url, headers: { accept: "application/json" } });
    return { records: [], nextCursor: null, more: false, complete: false };
  },
};

let world: { connector: Connector; bound: BoundFeed } | undefined;

function probeWorld(): { connector: Connector; bound: BoundFeed } {
  if (world) return world;
  const registry = buildKindRegistry([{ id: "conventions/probe", body: "", frontmatter: { type: "Convention", title: "Probe", governs: "Probe", fields: { required: ["title"] } } }], [], { okfVersion: "0.2" });
  const parsed = parseConnectorDoc({ id: "connectors/conformance", body: "", frontmatter: {
    type: "Connector", title: "Transport conformance probe", auth: { kind: "token", provider: "github" }, domains: [KEYLESS_HOST],
    sources: [{ name: "probe", profile: PROBE, target_kind: "Probe", identity: { resource: `https://${CREDENTIAL_HOST}/repos/{owner}/{repo}`, id: "{id}" }, fields: { title: "title" }, completeness: "complete" }],
  } }, { kinds: registry });
  if (!parsed.ok) throw new Error(`conformance connector refused: ${parsed.errors.map((e) => e.code).join(", ")}`);
  const bound = bindSourceFeed(parsed.connector, { id: "source-feeds/conformance", frontmatter: {
    type: "Source Feed", connector: parsed.connector.id, source: "probe", url: `https://${CREDENTIAL_HOST}/repos/octo/probe`, owned_fields: ["title"],
  } }, registry, { okfVersion: "0.2" });
  return (world = { connector: parsed.connector, bound });
}

const CREDENTIALS = (): TransportCredential[] => [
  { hosts: credentialHosts({ kind: "token", provider: "github" }), header: "authorization", value: "Bearer conformance-secret-1" },
  // A provider's own header (Vagaro's `accessToken`), so a check on `authorization` alone cannot pass.
  { hosts: credentialHosts({ kind: "token", provider: "github" }), header: "accessToken", value: "conformance-secret-2" },
];

/**
 * Whether a request carries the credential anywhere: a header, the URL (decoded, so an encoded
 * copy counts) or the body. The secret is the value's last word, so `Bearer x` is found as `x`.
 */
function carries(request: PeerRequest, credential: TransportCredential): boolean {
  const secret = credential.value.split(/\s+/).at(-1)!;
  let url = request.url;
  try { url = decodeURIComponent(request.url.replaceAll("+", " ")); } catch { /* keep the raw URL */ }
  return [...Object.values(request.headers), url, request.url, request.body ?? ""].some((text) => text.includes(secret));
}

/** Every request that carried the credential's value toward a host it does not belong to. */
function leaks(peer: ScriptedPeer, credential: TransportCredential): string[] {
  return peer.received.filter((request) => {
    const url = new URL(request.url);
    const allowed = url.protocol === "https:" && credential.hosts.includes(url.hostname);
    return !allowed && carries(request, credential);
  }).map((request) => `${request.method} ${request.url}`);
}

const answer = (routes: Record<string, PeerResponse>) => (request: PeerRequest): PeerResponse => {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") return { status: 404, body: "" };
  return routes[`${url.origin}${url.pathname}`] ?? { status: 404, body: "" };
};

async function throughEngine(target: TransportConformanceTarget, credential: TransportCredential, routes: Record<string, PeerResponse>, spec: { url: string; also?: string[] }, maxBytes?: number): Promise<{ receipt: SourceRunReceipt; peer: ScriptedPeer }> {
  const { connector, bound } = probeWorld();
  const peer = new ScriptedPeer(answer(routes));
  const receipt = await observeSource({
    connector, bound, profile: probe, spec, transport: target.create(peer, credential), state: new MemoryMachineState(), identity: IDENTITY,
    mode: "complete", budget: { requests: 20, ...(maxBytes !== undefined ? { maxBytes } : {}) }, commit: async () => {},
  });
  return { receipt, peer };
}

async function direct(transport: Transport, url: string, options: { maxBytes?: number; credentialHost?: boolean } = {}): Promise<TransportResult | Error> {
  try {
    return await transport.request({ url, method: "GET", headers: { accept: "application/json" }, maxBytes: options.maxBytes ?? 4096, credentialHost: options.credentialHost ?? false });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

type Check = (target: TransportConformanceTarget) => Promise<string[]>;

const CHECKS: Record<(typeof CONFORMANCE_SCENARIOS)[number], Check> = {
  async "credential-reaches-its-host"(target) {
    const problems: string[] = [];
    for (const credential of CREDENTIALS()) {
      const peer = new ScriptedPeer(() => ({ status: 200, body: "[]" }));
      await direct(target.create(peer, credential), `https://${CREDENTIAL_HOST}/repos/octo/probe/issues`, { credentialHost: true });
      const sent = peer.received[0]?.headers[credential.header.toLowerCase()];
      if (sent !== credential.value) problems.push(`the ${credential.header} credential did not reach ${CREDENTIAL_HOST}`);
      const { peer: engine } = await throughEngine(target, credential, { [`https://${CREDENTIAL_HOST}/x`]: { status: 200, body: "{}" } }, { url: `https://${CREDENTIAL_HOST}/x` });
      if (engine.received[0]?.headers[credential.header.toLowerCase()] !== credential.value) problems.push(`behind the engine the ${credential.header} credential did not reach ${CREDENTIAL_HOST}`);
    }
    return problems;
  },

  async "credential-stays-on-its-host"(target) {
    const problems: string[] = [];
    for (const credential of CREDENTIALS()) {
      const peer = new ScriptedPeer(() => ({ status: 200, body: "[]" }));
      const transport = target.create(peer, credential);
      for (const probe of CREDENTIAL_PROBES) {
        const before = peer.received.length;
        await direct(transport, probe.url, { credentialHost: probe.credentialHost });
        const carried = peer.received.slice(before).filter((request) => carries(request, credential));
        if (carried.length) problems.push(`${credential.header} sent toward ${probe.name}`);
      }
    }
    return problems;
  },

  async "redirect-returned-unfollowed"(target) {
    const [credential] = CREDENTIALS();
    const peer = new ScriptedPeer(answer({
      [`https://${CREDENTIAL_HOST}/a`]: { status: 302, headers: { Location: `https://${CREDENTIAL_HOST}/b` }, body: "" },
      [`https://${CREDENTIAL_HOST}/b`]: { status: 200, body: "{}" },
    }));
    const result = await direct(target.create(peer, credential!), `https://${CREDENTIAL_HOST}/a`, { credentialHost: true });
    const problems: string[] = [];
    if (result instanceof Error || !result.ok || result.status !== 302) problems.push("the 302 was not returned as the answer");
    else if (result.headers.location !== `https://${CREDENTIAL_HOST}/b`) problems.push("the 302's location header was not returned under a lowercase name");
    if (peer.received.length !== 1) problems.push(`the transport sent ${peer.received.length} requests for one call`);
    return problems;
  },

  async "cross-host-redirect-refused"(target) {
    const problems: string[] = [];
    const cases: Array<{ name: string; from: string; to: string; also?: string[] }> = [
      { name: "credential host to an undeclared host", from: `https://${CREDENTIAL_HOST}/x`, to: `https://${OUTSIDE_HOST}/steal` },
      { name: "keyless host to an undeclared host", from: `https://${KEYLESS_HOST}/x`, to: `https://${OUTSIDE_HOST}/steal` },
      { name: "credential host to a declared keyless host", from: `https://${CREDENTIAL_HOST}/x`, to: `https://${KEYLESS_HOST}/y`, also: [KEYLESS_HOST] },
      { name: "declared keyless host to the credential host", from: `https://${KEYLESS_HOST}/x`, to: `https://${CREDENTIAL_HOST}/y`, also: [CREDENTIAL_HOST] },
    ];
    for (const credential of CREDENTIALS()) {
      for (const c of cases) {
        const toHost = new URL(c.to).hostname;
        const { receipt, peer } = await throughEngine(target, credential, {
          [c.from]: { status: 302, headers: { location: c.to }, body: "" },
          [c.to]: { status: 200, body: "{}" },
        }, { url: c.from, ...(c.also ? { also: c.also } : {}) });
        const reached = peer.received.filter((request) => request.url.startsWith(c.to)).length;
        if (receipt.outcome !== "refused") problems.push(`${c.name}: the run ended ${receipt.outcome}, not refused`);
        if (reached) problems.push(`${c.name}: ${reached} request(s) reached ${toHost}`);
        for (const leak of leaks(peer, credential)) problems.push(`${c.name}: ${credential.header} sent with ${leak}`);
      }
    }
    return problems;
  },

  async "body-over-bound-refused"(target) {
    const [credential] = CREDENTIALS();
    const problems: string[] = [];
    // 600 characters, 1200 bytes: a bound read in characters would pass it.
    const over = "é".repeat(600);
    const exact = "a".repeat(1000);
    const peer = new ScriptedPeer(answer({
      [`https://${CREDENTIAL_HOST}/over`]: { status: 200, body: over },
      [`https://${CREDENTIAL_HOST}/exact`]: { status: 200, body: exact },
    }));
    const transport = target.create(peer, credential!);
    const refused = await direct(transport, `https://${CREDENTIAL_HOST}/over`, { maxBytes: 1000, credentialHost: true });
    if (refused instanceof Error || refused.ok || refused.refused !== "too_large") problems.push("a 1200-byte body under a 1000-byte bound was not refused as too_large");
    const admitted = await direct(transport, `https://${CREDENTIAL_HOST}/exact`, { maxBytes: 1000, credentialHost: true });
    if (admitted instanceof Error || !admitted.ok || admitted.body !== exact || admitted.bytes !== 1000) problems.push("a body exactly at the bound was not returned whole");
    const { receipt } = await throughEngine(target, credential!, { [`https://${CREDENTIAL_HOST}/over`]: { status: 200, body: over } }, { url: `https://${CREDENTIAL_HOST}/over` }, 1000);
    if (receipt.outcome !== "too_large") problems.push(`behind the engine the run ended ${receipt.outcome}, not too_large`);
    return problems;
  },

  async "private-redirect-refused"(target) {
    const [credential] = CREDENTIALS();
    const problems: string[] = [];
    for (const from of [`https://${CREDENTIAL_HOST}/x`, `https://${KEYLESS_HOST}/x`]) {
      for (const to of PRIVATE_TARGETS) {
        const { receipt, peer } = await throughEngine(target, credential!, { [from]: { status: 302, headers: { location: to }, body: "" } }, { url: from });
        const toUrl = new URL(to);
        const reached = peer.received.filter((request) => {
          const url = new URL(request.url);
          return url.hostname === toUrl.hostname && url.port === toUrl.port && url.protocol === toUrl.protocol;
        }).length;
        if (receipt.outcome !== "refused") problems.push(`${from} to ${to}: the run ended ${receipt.outcome}, not refused`);
        if (reached) problems.push(`${from} to ${to}: ${reached} request(s) reached it`);
      }
    }
    return problems;
  },
};

/** Run every conformance scenario against one transport. */
export async function runTransportConformance(target: TransportConformanceTarget): Promise<ConformanceRow[]> {
  const rows: ConformanceRow[] = [];
  for (const scenario of CONFORMANCE_SCENARIOS) {
    try {
      const problems = await CHECKS[scenario](target);
      rows.push(problems.length ? { scenario, ok: false, detail: problems.join("; ") } : { scenario, ok: true });
    } catch (error) {
      rows.push({ scenario, ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return rows;
}
