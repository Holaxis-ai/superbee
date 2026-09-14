/**
 * The platform contract kit in Node: every row of `platform-contract.ts` against a
 * request-driven runtime over the in-process remote fixture and browser-local runtimes over
 * both its wire backend and a structural host read adapter. Each session is a fresh authority seeded
 * with the synthetic bundle; the carrier can be cut off per session, and the fixture's write
 * knobs are flipped from here.
 *
 * One further, Node-only test puts the browser-local runtime over a filesystem authority with
 * hand-authored files, the case where the authority's token and the working copy's differ, to
 * prove the two token spaces the contract states: a commit at the `version` a read reports
 * succeeds, and `acknowledged` is the authority's own token.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import ts from "typescript";

import { FilesystemBackend, RemoteBackend } from "@superbee/core";
import { readDocVersioned } from "@superbee/core/bundle-ops";
import type { ExecutionMode, PlatformRuntime } from "@superbee/core/platform";
import { createRemoteOperationTransport } from "@superbee/core/remote-operations";
import type { OperationTransport } from "@superbee/core/uncertain-write";
import { createRouter, MemoryOperationOutcomeStore } from "@superbee/server";

import { bootstrap, openLocalBundle, UNSETTLED_STATES, type LocalBundle } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime, createRequestDrivenRuntime } from "../src/platform/index.ts";
import { BASE_URL, BUNDLE, createRemoteFixture, type FixtureKnobs } from "./fixtures/remote-fixture.ts";
import { hostReadAdapter } from "./fixtures/host-read-adapter.ts";
import {
  authorityHandle,
  CONTRACT_ACTOR,
  CONTRACT_NOW,
  MODES,
  platformContractRows,
  runRow,
  seedSyntheticBundle,
  type ContractHarness,
  type ContractSession,
  type WriteKnob,
} from "./platform-contract.ts";

const immediate = { sleep: async () => {}, lookupDelayMs: 0 };
const now = () => CONTRACT_NOW;

const makeHarness = (structural: boolean): ContractHarness => ({
  async open(mode: ExecutionMode): Promise<ContractSession> {
    const fixture = await createRemoteFixture();
    await seedSyntheticBundle(fixture.authority);
    const offline = { flag: false };
    const carrier = (request: Request): Promise<Response> =>
      offline.flag ? Promise.reject(new TypeError("fetch failed: client is offline")) : fixture.hosted(request);
    const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: carrier, maxRetries: 0 });
    const factory = new IDBFactory();
    const locals: LocalBundle[] = [];
    const adapter = hostReadAdapter(remote, remote);
    const readSide = structural ? adapter.backend : remote;
    let submissions = 0;
    let lookups = 0;
    let needsLookup = false;

    const runtimeOf = async (name: string): Promise<PlatformRuntime> => {
      if (mode === "request-driven") return createRequestDrivenRuntime({ remote, actor: CONTRACT_ACTOR, now });
      const local = openLocalBundle(name, { indexedDB: factory });
      locals.push(local);
      await bootstrap(readSide, local);
      const wireTransport = createRemoteOperationTransport(remote);
      const transport: OperationTransport = {
        submit: async (intent, options) => {
          submissions += 1;
          const recorded = (await local.backend.listIntents()).find((row) => row.requestId === intent.requestId);
          assert.ok(recorded, "the injected transport receives an existing durable identity");
          for (const key of ["requestId", "kind", "target", "base", "local", "content", "createdAt"] as const) {
            assert.equal(intent[key], recorded[key], `submission preserves the journal's original ${key}`);
          }
          return wireTransport.submit(intent, options);
        },
        lookup: async (requestId) => {
          lookups += 1;
          assert.ok((await local.backend.listIntents()).some((row) => row.requestId === requestId), "lookup preserves the durable identity");
          return wireTransport.lookup(requestId);
        },
      };
      return createBrowserLocalRuntime({ local, remote: readSide, transport, write: immediate, actor: CONTRACT_ACTOR, now });
    };

    const runtime = await runtimeOf("first");
    const absent = new Set<string>();
    return {
      mode,
      runtime,
      authority: authorityHandle(fixture.authority, absent),
      expectedAbsent: () => [...absent],
      secondClient: () => runtimeOf("second"),
      setOffline: async (flag) => {
        offline.flag = flag;
      },
      setKnob: async (name: WriteKnob, flag) => {
        (fixture.knobs as FixtureKnobs)[name] = flag;
        if (flag && (name === "dropAfterApply" || name === "failBeforeApply")) needsLookup = true;
      },
      unsettled: async (id) => {
        const local = locals[0];
        if (!local) return [];
        return (await local.backend.listIntents(UNSETTLED_STATES)).filter((row) => row.target === id).map((row) => ({ requestId: row.requestId, state: row.state }));
      },
      restore: async () => {
        offline.flag = false;
        fixture.knobs.unauthorized = false;
        fixture.knobs.dropAfterApply = false;
        fixture.knobs.failBeforeApply = false;
      },
      close: async () => {
        for (const local of locals) local.close();
        assert.deepEqual(adapter.mutations, [], "all mutations bypass the host read adapter");
        if (mode === "browser-local" && needsLookup) {
          assert.ok(submissions > 0, "uncertain write was submitted through the injected transport");
          assert.ok(lookups > 0, "uncertain write was looked up through the injected transport");
        }
      },
    };
  },
});

const rows = platformContractRows();

test(`the contract kit covers ${rows.length} rows across ${MODES.length} modes`, () => {
  if (rows.length < 10) throw new Error(`expected at least ten rows, found ${rows.length}`);
});

for (const structural of [false, true]) {
  for (const row of rows) {
    test(`${structural ? "host read adapter" : "wire"}: ${row.verb}: ${row.name}`, async () => {
      await runRow(makeHarness(structural), row);
    });
  }
}

test("a structural host read adapter constructs the runtime under the TypeScript checker", () => {
  const program = ts.createProgram([fileURLToPath(new URL("./fixtures/host-read-construction.ts", import.meta.url))], {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
});

test("bare StorageBackend refresh retains missing remote documents: fallback is not deletion-complete SaaS sync", async () => {
  const fixture = await createRemoteFixture();
  await seedSyntheticBundle(fixture.authority);
  const adapter = hostReadAdapter(fixture.authority);
  const local = openLocalBundle("bare-read-adapter", { indexedDB: new IDBFactory() });
  try {
    assert.equal("heads" in adapter.backend, false);
    assert.equal("snapshot" in adapter.backend, false);
    assert.equal("wireCapabilities" in adapter.backend, false);
    await bootstrap(adapter.backend, local);
    const runtime = createBrowserLocalRuntime({ local, remote: adapter.backend, transport: {
      submit: async () => { throw new Error("read-only refresh must not submit"); },
      lookup: async () => { throw new Error("read-only refresh must not lookup"); },
    } });
    const before = await runtime.read("notes/alpha");
    const authority = authorityHandle(fixture.authority, new Set());
    await authority.write("notes/alpha", "updated by authority\n");
    await authority.delete("tasks/one");
    await runtime.sync();
    const after = await runtime.read("notes/alpha");
    assert.notEqual(after.provenance.version, before.provenance.version);
    assert.equal(after.doc.body, "updated by authority\n");
    assert.equal((await runtime.read("tasks/one")).doc.id, "tasks/one", "list fallback does not establish deletion authority");
    assert.deepEqual(adapter.mutations, []);
  } finally { local.close(); }
});

// ── two token spaces: a filesystem authority over hand-authored files ──────────────────────

/** Flow-style `tags` re-serialize as a block list, so the authority's token (the on-disk bytes) is not the working copy's. */
const HAND_AUTHORED = "---\ntype: Note\ntitle: Hand authored\nstatus: draft\ntags: [proof, hand]\n---\nhand-authored v1\n";
const ALSO_HAND_AUTHORED = "---\ntype: Note\ntitle: Also hand authored\nstatus: final\ntags: [proof, hand]\n---\nalso hand-authored v1\n";

for (const structural of [false, true]) test(`${structural ? "host read adapter" : "wire"} over a filesystem authority: version is the working copy's token, acknowledged the authority's, and a commit at version succeeds`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-platform-fs-"));
  const local = openLocalBundle("filesystem-authority", { indexedDB: new IDBFactory() });
  try {
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# Filesystem authority\n");
    await writeFile(path.join(root, "notes", "hand.md"), HAND_AUTHORED);
    await writeFile(path.join(root, "notes", "other.md"), ALSO_HAND_AUTHORED);
    const authority = new FilesystemBackend(root);
    // The reference router over the filesystem, served the same way the fixture serves memory.
    const hosted = createRouter({ root, backend: authority }, { outcomes: new MemoryOperationOutcomeStore() });
    const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: hosted, maxRetries: 0 });
    const adapter = hostReadAdapter(remote, remote);
    const readSide = structural ? adapter.backend : remote;
    await bootstrap(readSide, local);
    const runtime = createBrowserLocalRuntime({ local, remote: readSide, transport: createRemoteOperationTransport(remote), write: immediate, actor: CONTRACT_ACTOR, now });

    const before = await runtime.read("notes/hand");
    assert.equal(before.provenance.state, "shared-confirmed");
    const shared = before.provenance as Extract<typeof before.provenance, { state: "shared-confirmed" }>;
    const working = (await readDocVersioned(local.bundle, "notes/hand")).version;
    const held = (await authority.read("notes/hand")).version;
    assert.notEqual(held, working, "the fixture is only a proof if the authority's token differs from the working copy's");
    assert.equal(shared.version, working, "version is the working copy's own token");
    assert.equal(shared.acknowledged, held, "acknowledged is the authority's token");
    const [row] = (await runtime.query({ type: "Note" })).filter((candidate) => candidate.id === "notes/hand");
    assert.equal(row?.version, row?.provenance.version, "a query row's version is the same token the provenance carries");

    // The premise a read reports is the premise a commit accepts.
    const commit = await runtime.commit("notes/hand", { body: "hand-authored v2\n", expectedVersion: before.provenance.version });
    assert.equal(commit.changed, true);
    assert.equal(commit.provenance.state, "local-pending");
    const status = await runtime.sync();
    assert.equal(status.pending, 0);
    assert.equal(status.conflicts, 0);
    assert.equal(status.unconfirmed, 0);

    const after = await runtime.read("notes/hand");
    const confirmed = after.provenance as Extract<typeof after.provenance, { state: "shared-confirmed" }>;
    assert.equal(confirmed.state, "shared-confirmed");
    assert.equal(after.doc.body, "hand-authored v2\n");
    assert.equal(confirmed.version, (await readDocVersioned(local.bundle, "notes/hand")).version, "version is still the working copy's token");
    assert.equal(confirmed.acknowledged, (await authority.read("notes/hand")).version, "acknowledged is what the authority now calls it");
    assert.equal((await authority.read("notes/hand")).doc.body, "hand-authored v2\n");

    // The document never committed keeps differing tokens through the sync's pull: the two
    // spaces are a standing fact of the runtime, not an artefact of bootstrap.
    const other = (await runtime.read("notes/other")).provenance as Extract<typeof after.provenance, { state: "shared-confirmed" }>;
    assert.equal(other.state, "shared-confirmed");
    assert.equal(other.version, (await readDocVersioned(local.bundle, "notes/other")).version);
    assert.equal(other.acknowledged, (await authority.read("notes/other")).version);
    assert.notEqual(other.version, other.acknowledged, "the authority's token and the working copy's differ for the untouched hand-authored file");
    assert.deepEqual(adapter.mutations, []);
  } finally {
    local.close();
    await rm(root, { recursive: true, force: true });
  }
});
