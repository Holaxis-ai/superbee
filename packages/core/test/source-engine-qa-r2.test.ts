/**
 * QA round 2 probes on the replay code of 42580620: a reappeared record's held `new` change, a
 * pending `new` change and a complete pass that omits it, and relative imports from inside a symlinked
 * directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  type MachineState,
  type ObserveSourceOptions,
  type PageCommit,
} from "../src/source-engine/index.js";
import { peerTransport, ScriptedPeer, type PeerRequest, type PeerResponse } from "../src/source-harness/index.js";
import { jsonPagesProfile, type JsonPagesSpec } from "./fixtures/source-engine/json-pages-profile.js";
import { FEED_FRONTMATTER, FEED_ID, SPEC, TICKET_CONVENTION, ticket, ticketConnector } from "./fixtures/source-engine/tickets.js";

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
const retryAll = async (p: PageCommit) => ({ retry: p.changes.map((c) => c.external_id) });

test("a reappeared record's held new change is replayed, though the record had disappeared", async () => {
  const state = new MemoryMachineState();
  await run(state, [T1, T2]);
  await run(state, [T2]);
  await run(state, [T2]);
  assert.equal((await state.read(FEED_ID))!.state.records.t1!.gone, true);
  // An incremental run lists t1 again; its `new` change is held.
  await run(state, [T1, T2], { mode: "incremental", commit: retryAll });
  assert.equal((await state.read(FEED_ID))!.state.pending?.t1?.change.change_kind, "new");
  // The next incremental run does not list t1; the hold has cleared.
  const seen: PageCommit[] = [];
  await run(state, [T2], { mode: "incremental", commit: async (p) => { seen.push(p); } });
  assert.ok(seen.some((p) => p.replay && p.changes.some((c) => c.external_id === "t1" && c.change_kind === "new")), "t1's held change was replayed");
  assert.notEqual((await state.read(FEED_ID))!.state.records.t1!.gone, true, "t1 is present again");
});

test("a complete pass that omits a record supersedes its pending new change, as for a stored record", async () => {
  const state = new MemoryMachineState();
  await run(state, [T2]);
  await run(state, [T1, T2], { commit: retryAll });
  assert.equal((await state.read(FEED_ID))!.state.pending?.t1?.change.change_kind, "new");
  await run(state, [T2], { commit: async (p) => (p.replay ? { retry: p.changes.map((c) => c.external_id) } : {}) });
  assert.equal((await state.read(FEED_ID))!.state.pending?.t1, undefined);
});

test("a relative import from a module behind a symlinked directory is judged from where the runtime resolves it", () => {
  // A real path, as a profile directory usually is (on macOS the temporary directory is behind a link).
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "egress-qa-r2-")));
  try {
    const root = path.join(base, "profiles");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "helper.mjs"), "export { f } from \"../net.mjs\";\n");
    writeFileSync(path.join(base, "net.mjs"), "export const f = fetch;\n");
    symlinkSync(path.join(base, "outside"), path.join(root, "linked"));
    writeFileSync(path.join(root, "profile.ts"), "export { f } from \"./linked/helper.mjs\";\n");
    const files = collectSourceFiles([root]);
    assert.notDeepEqual(egressViolations(files, { roots: [root] }), [], `${files.length} module(s) checked, no violation`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
