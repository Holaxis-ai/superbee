/**
 * Adversarial QA's findings at 259cc0ba, one probe per finding, kept as pins: a disappearance or a
 * newer sighting supersedes a pending change, a replay keeps the record's missing count, a failing
 * replay does not stop the feed, a crash between commit and store replays nothing stale, the
 * conformance suite finds a credential anywhere in a request, a cycling cursor is stuck, and the
 * egress check refuses destructured keys, descriptor walks and modules behind a symlinked directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectSourceFiles, egressViolations } from "../../../scripts/source-egress-check.mjs";

import { bindSourceFeed, type BoundFeed, type Connector } from "../src/connectors.js";
import { buildKindRegistry } from "../src/kinds.js";
import { loadKinds } from "../src/kinds-load.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { HOLD_STORE, RETRYABLE } from "../src/record-overlay/errors.js";
import { applyRecordOverlay } from "../src/record-overlay/apply.js";
import { planRecordOverlay } from "../src/record-overlay/plan.js";
import type { OverlayBundle, OverlayReceipt } from "../src/record-overlay/types.js";
import {
  fetchIdentity,
  MemoryMachineState,
  observeSource,
  type FetchIdentity,
  type MachineState,
  type ObserveSourceOptions,
  type PageCommit,
  type SourceProfile,
} from "../src/source-engine/index.js";
import { peerTransport, runTransportConformance, ScriptedPeer, type PeerRequest, type PeerResponse, type TransportConformanceTarget } from "../src/source-harness/index.js";
import { jsonPagesProfile, type JsonPagesSpec } from "./fixtures/source-engine/json-pages-profile.js";
import { FEED_FRONTMATTER, FEED_ID, ITEMS, SPEC, TICKET_CONVENTION, ticket, ticketConnector, ticketDocuments } from "./fixtures/source-engine/tickets.js";

const IDENTITY = fetchIdentity("SuperbeeQa/1 (+https://superbee.example.org/qa)") as FetchIdentity;

function boundFor(connector: Connector): BoundFeed {
  const registry = buildKindRegistry([TICKET_CONVENTION], [], { okfVersion: "0.2" });
  return bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED_FRONTMATTER as never }, registry, { okfVersion: "0.2" });
}

const listing = (items: unknown[]) => peerTransport(new ScriptedPeer((r: PeerRequest): PeerResponse =>
  (new URL(r.url).pathname === "/robots.txt" ? { status: 404, body: "" } : { status: 200, body: JSON.stringify({ items }) })));

function run(state: MachineState, items: unknown[], options: Partial<ObserveSourceOptions<JsonPagesSpec, unknown>> = {}) {
  const connector = ticketConnector();
  return observeSource({
    connector, bound: boundFor(connector), profile: jsonPagesProfile, spec: SPEC, state, identity: IDENTITY, transport: listing(items),
    mode: "complete", now: () => new Date("2026-03-01T12:00:00.000Z"), commit: async () => {}, ...options,
  });
}

const T1 = ticket("t1", "First");
const T2 = ticket("t2", "Second");

test("pending/disappear: a written disappearance supersedes the record's pending change, so no later replay resurrects it", async () => {
  const state = new MemoryMachineState();
  let claimed = true;
  const changes: Array<[boolean, string, string]> = [];
  // A claimed Signal holds updates to the record; a disappearance opens a new Signal and is written.
  const commit = async (p: PageCommit) => {
    for (const c of p.changes) changes.push([p.replay, c.external_id, c.change_kind]);
    return { retry: claimed ? p.changes.filter((c) => c.change_kind !== "disappeared").map((c) => c.external_id) : [] };
  };
  await run(state, [T1, T2]);
  await run(state, [ticket("t1", "Renamed"), T2], { commit });
  await run(state, [T2], { commit });
  await run(state, [T2], { commit });
  let stored = (await state.read(FEED_ID))!.state;
  assert.equal(stored.records.t1!.gone, true, "t1 disappeared after two complete observations");
  assert.equal(stored.pending?.t1, undefined, "the written disappearance superseded the pending change");
  claimed = false;
  await run(state, [T2], { commit });
  stored = (await state.read(FEED_ID))!.state;
  assert.equal(stored.pending?.t1, undefined, "no change stays pending for a record that disappeared");
  assert.equal(stored.records.t1!.gone, true, "a replay does not bring a disappeared record back");
});

test("pending/missing: a replay keeps the record's missing count, so disappearance is not delayed", async () => {
  const state = new MemoryMachineState();
  let claimed = true;
  const commit = async (p: PageCommit) => ({ retry: claimed ? p.changes.map((c) => c.external_id) : [] });
  await run(state, [T1, T2]);
  await run(state, [ticket("t1", "Renamed"), T2], { commit });
  await run(state, [T2], { commit });
  assert.equal((await state.read(FEED_ID))!.state.records.t1!.missing, 1);
  claimed = false;
  const fourth = await run(state, [T2], { commit });
  assert.equal(fourth.changes.disappeared, 1, "two complete observations without t1: disappeared");
});

test("pending/poison: a replay the commit cannot take does not stop every later run from reading the provider", async () => {
  const state = new MemoryMachineState();
  await run(state, [T1]);
  await run(state, [ticket("t1", "Renamed")], { commit: async (p) => ({ retry: p.changes.map((c) => c.external_id) }) });
  const poisoned = async (p: PageCommit) => { if (p.replay) throw new Error("cannot plan this change"); };
  const later = await run(state, [ticket("t1", "Newest")], { commit: poisoned });
  assert.ok(later.requests.length > 0, "the run reads the provider, whose newer value would supersede the pending change");
});

/** The fixture's overlay commit over a MemoryBackend bundle, with a state the test can break. */
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
    connector, bound, profile: jsonPagesProfile, spec: SPEC, state, identity: IDENTITY, transport: listing(items), mode: "incremental",
    now: () => new Date(at), commit: c as never,
  });
  return { backend, receipts, commit, observe };
}

test("pending/crash: after a crash between commit and store, the replay does not plan a change older than what the commit already wrote", async () => {
  const w = await overlayWorld();
  const memory = new MemoryMachineState();
  let crash = false;
  const state: MachineState = {
    read: (key) => memory.read(key),
    async write(key, value, expected) { if (crash) { crash = false; throw new Error("process ended"); } return memory.write(key, value, expected); },
  };
  await w.observe(state, [T1], w.commit, "2026-03-01T10:00:00.000Z");
  // A lost compare-and-swap: nothing written, the change is pending.
  await w.observe(state, [ticket("t1", "Second name")], async (p) => ({ retry: p.changes.map((c) => c.external_id) }), "2026-03-01T11:00:00.000Z");
  // The replay is lost again; the page then writes the newer title, and the process ends before the store.
  await w.observe(state, [ticket("t1", "Third name")], async (p) => {
    if (p.replay) return { retry: p.changes.map((c) => c.external_id) };
    const result = await w.commit(p);
    crash = true;
    return result;
  }, "2026-03-01T12:00:00.000Z");
  assert.equal((await w.backend.read("tickets/t1")).doc.frontmatter.title, "Third name");
  w.receipts.length = 0;
  await w.observe(state, [ticket("t1", "Third name")], w.commit, "2026-03-01T13:00:00.000Z");
  assert.equal((await w.backend.read("tickets/t1")).doc.frontmatter.title, "Third name", "the document converges");
  const conflicts = w.receipts.flatMap((r) => r.refusals).filter((r) => r.code === "OVERLAY_DOC_CONFLICT");
  assert.deepEqual(conflicts, [], "no one edited t1, so no conflict Signal is raised");
});

test("conformance: a transport that carries the credential in the URL toward another host fails the suite", async () => {
  const leaking: TransportConformanceTarget = {
    name: "puts the credential in the query string of every request",
    create(peer, credential) {
      const inner = peerTransport(peer, { credential });
      return {
        request(input) {
          const url = new URL(input.url);
          url.searchParams.set("access_token", credential.value);
          return inner.request({ ...input, url: url.href });
        },
      };
    },
  };
  const rows = await runTransportConformance(leaking);
  assert.ok(rows.some((r) => r.scenario === "credential-stays-on-its-host" && !r.ok), JSON.stringify(rows));
});

test("stuck cursor: a cursor that cycles between two values ends cursor_stuck with a finding rather than burning the budget", async () => {
  let calls = 0;
  const cycling: SourceProfile<JsonPagesSpec, unknown> = {
    ...jsonPagesProfile,
    async observe({ transport, cursor }) {
      calls += 1;
      await transport.request({ url: ITEMS });
      return { records: [T1], nextCursor: { after: (cursor as { after?: string } | null)?.after === "a" ? "b" : "a" }, more: true, complete: false };
    },
  };
  const receipt = await run(new MemoryMachineState(), [], { profile: cycling, mode: "incremental" });
  assert.equal(receipt.reason, "cursor_stuck", `ended ${receipt.outcome}/${receipt.reason} after ${calls} pages with ${receipt.findings.length} findings`);
});

for (const [name, text] of [
  ["a destructured constructor", "const { constructor: Make } = (() => 0);\nexport const go = () => (Make as any)(\"return fetch\")();"],
  ["a destructured prototype", "const { prototype: p } = Set;\nexport const go = () => Object.assign(p, { has: () => true });"],
  ["a constructor in an assignment pattern", "let F: any;\n({ constructor: F } = (() => 0));\nexport const go = () => F(\"return fetch\")();"],
  ["a prototype reached through its descriptors", "const d = Object.values(Object.getOwnPropertyDescriptors(Set)).find((x: any) => typeof x.value?.has === \"function\");\nexport const go = () => Object.assign(d!.value, { has: () => true });"],
] as const) {
  test(`egress: the check refuses ${name}`, () => {
    assert.notDeepEqual(egressViolations([{ path: "planted.ts", text }]), [], "passes the check");
  });
}

test("egress: a symlinked directory inside a root is scanned, and an import into it is checked", () => {
  const base = mkdtempSync(path.join(tmpdir(), "egress-qa-"));
  try {
    const root = path.join(base, "profiles");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "net.mjs"), "export const f = fetch;\n");
    symlinkSync(path.join(base, "outside"), path.join(root, "linked"));
    writeFileSync(path.join(root, "profile.ts"), "export { f } from \"./linked/net.mjs\";\n");
    const files = collectSourceFiles([root]);
    assert.notDeepEqual(egressViolations(files, { roots: [root] }), [], `${files.length} module(s) checked, no violation`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
