import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackend } from "@superbee/core/indexeddb-backend";
import type { OperationTransport } from "@superbee/core/uncertain-write";
import { openLocalBundle, bootstrap, commitBodyLocal, commitLocal, push, reclaimInFlight, resume, syncStatus, settleIntent, inspectConflict, resolveConflict } from "../src/local-bundle.ts";
import { admitBodyMode, bodyRecordKey, BODY_MODE_KEY, bodySnapshot, assertBodyCapacity, projectBodyGuard, jsonBytes, BODY_RUNTIME_LIMITS, writeBodyControl } from "../src/body-journal.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createBodyAuthority } from "./fixtures/body-authority.ts";

const exact: OperationTransport = { submit: async () => { throw new Error("Unexpected exact-document submission"); }, lookup: async () => { throw new Error("Unexpected exact-document lookup"); } };
const immediate = { sleep: async () => {}, lookupDelayMs: 0, maxLookups: 1 };
for (const adapter of ["memory", "indexeddb"] as const) {
  async function setup(okfVersion: "0.1" | "0.2" = "0.2") {
    const backend = adapter === "memory" ? new MemoryJournaledBackend() : new IndexedDbBackend({ databaseName: crypto.randomUUID(), indexedDB: new IDBFactory() });
    const local = openLocalBundle("body-test", { backend, bodyDelivery: { scope: "fixture", okfVersion, dedicated: true } });
    const authority = await createBodyAuthority(undefined, okfVersion);
    await bootstrap(authority.backend, local);
    const runtime = createBrowserLocalRuntime({ local, remote: authority.backend, transport: exact, bodyTransport: authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate });
    return { local, backend, authority, runtime, close: () => local.close() };
  }
  test(`${adapter}: explicit body commits settle canonical authority content and retain original history`, async () => {
    const s = await setup();
    try {
      const before = await s.runtime.read("notes/example");
      await s.runtime.commit("notes/example", { body: "Edited locally", expectedVersion: before.provenance.version });
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "local-pending");
      const intent = (await s.backend.listIntents())[0]!;
      const status = await s.runtime.sync();
      assert.equal(status.pending, 0);
      const confirmed = await s.runtime.read("notes/example");
      assert.equal(confirmed.provenance.state, "shared-confirmed");
      assert.equal(confirmed.doc.frontmatter.generated && (confirmed.doc.frontmatter.generated as { by: string }).by, "process:authority");
      assert.equal((await s.backend.readIntent(intent.requestId))!.content, intent.content);
      assert.notEqual(confirmed.provenance.version, intent.local);
      assert.equal(s.authority.counts.applied, 1);
      await assert.rejects(commitLocal(s.backend, "notes/example", { buildCandidate: doc => doc! }), /explicit body commit/);
      await assert.rejects(settleIntent(s.backend, intent.requestId, { kind: "committed", version: intent.local }, 1), /content evidence/);
    } finally { s.close(); }
  });
  test(`${adapter}: v0.1 timestamp codec remains compatible with plain guarded persistence`, async () => {
    const s = await setup("0.1");
    try {
      await s.runtime.commit("notes/example", { body: "Timestamp edition" });
      await s.runtime.sync();
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
      assert.equal((await s.backend.listIntents())[0]!.state, "acknowledged");
    } finally { s.close(); }
  });
  test(`${adapter}: queued successor derives its premise from the durable receipt and preserves newer typing`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "First" });
      let release!: () => void, started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
      const delivering = push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
      await reached;
      await s.runtime.commit("notes/example", { body: "Second" });
      const second = (await s.backend.listIntents()).at(-1)!;
      release(); await delivering;
      assert.equal((await s.runtime.read("notes/example")).doc.body.trim(), "Second");
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "local-pending");
      s.authority.knobs.delay = undefined;
      await s.runtime.sync();
      const record = await s.backend.readMeta<{ prepared: { expectedVersion: string } }>(bodyRecordKey(second.requestId));
      const predecessor = (await s.backend.listIntents())[0]!;
      assert.equal(record!.prepared.expectedVersion, predecessor.acknowledgedVersion);
      assert.notEqual(record!.prepared.expectedVersion, predecessor.local);
      assert.equal(s.authority.counts.applied, 2);
    } finally { s.close(); }
  });
  test(`${adapter}: uncertain delivery survives close and lookup-only recovery`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "Lost response" });
      s.authority.knobs.dropNextResponse = true; s.authority.knobs.lookupUnavailable = true;
      await push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
      const intent = (await s.backend.listIntents())[0]!, evidence = await s.backend.readMeta(bodyRecordKey(intent.requestId));
      s.close();
      const reloaded = openLocalBundle("body-test", { backend: s.backend, bodyDelivery: { scope: "fixture", okfVersion: "0.2", dedicated: true } });
      await reclaimInFlight(reloaded);
      s.authority.knobs.lookupUnavailable = false;
      await push(reloaded, exact, { bodyTransport: s.authority.transport, write: immediate });
      assert.equal(s.authority.counts.submitted, 1);
      assert.equal(s.authority.counts.applied, 1);
      assert.deepEqual((await s.backend.readMeta<{ prepared: unknown }>(bodyRecordKey(intent.requestId)))!.prepared, (evidence as { prepared: unknown }).prepared);
    } finally { s.close(); }
  });
  test(`${adapter}: same-code refusal recheck distinguishes recorded refusal by lookup without inventing origin`, async () => {
    for (const terminal of [false, true]) {
      const s = await setup();
      try {
        await s.runtime.commit("notes/example", { body: "Refusal" });
        s.authority.knobs.terminalRefusal = terminal; s.authority.knobs.unauthorized = !terminal;
        await s.runtime.sync();
        assert.equal((await syncStatus(s.local)).counts.refused, 1);
        s.authority.knobs.unauthorized = false;
        await resume(s.backend);
        assert.ok((await s.backend.listIntents())[0]!.refusal);
        const submissions = s.authority.counts.submitted;
        const status = await s.runtime.sync();
        assert.equal(status.refused, terminal ? 1 : 0);
        assert.equal(s.authority.counts.submitted, submissions + (terminal ? 0 : 1));
        assert.equal(status.lastSync?.ok, !terminal);
      } finally { s.close(); }
    }
  });
  test(`${adapter}: coalescing retires only unprepared descriptors and corruption refuses before transport`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "One" });
      const first = (await s.backend.listIntents())[0]!;
      await s.runtime.commit("notes/example", { body: "Two" });
      assert.equal((await s.backend.listIntents()).length, 1);
      assert.equal((await s.backend.readWithJournal("notes/example", { meta: [bodyRecordKey(first.requestId)] })).meta.has(bodyRecordKey(first.requestId)), false);
      await assert.rejects(push(s.backend, exact), /explicit body delivery transport/);
      const latest = (await s.backend.listIntents())[0]!;
      await s.backend.writeMeta(bodyRecordKey(latest.requestId), undefined);
      await assert.rejects(s.runtime.read("notes/example"));
      await assert.rejects(push(s.backend, exact, { bodyTransport: s.authority.transport }));
      assert.equal(s.authority.counts.submitted, 0);
    } finally { s.close(); }
  });
  test(`${adapter}: composite controls preserve concurrent field updates and corrupt identity cannot fall back`, async () => {
    const s = await setup();
    try {
      const mode = (await admitBodyMode(s.backend))!;
      await Promise.all([writeBodyControl(s.backend, mode, "sync", { paused: true }), writeBodyControl(s.backend, mode, "pull", { startedAt: "now", completedAt: null })]);
      const control = await s.backend.readMeta<{ controls: { sync: { paused: boolean }; pull: unknown } }>(BODY_MODE_KEY);
      assert.equal(control!.controls.sync.paused, true); assert.ok(control!.controls.pull);
      assert.equal(await s.backend.readMeta("sync"), undefined);
      await assert.rejects(writeBodyControl(s.backend, mode, "sync", { paused: true, reason: "x".repeat(BODY_RUNTIME_LIMITS.controlBytes) }));
      await s.backend.writeMeta(BODY_MODE_KEY, undefined);
      await assert.rejects(s.runtime.query());
      await assert.rejects(resume(s.backend));
    } finally { s.close(); }
  });
  test(`${adapter}: every governed conflict choice preserves document, complete history, evidence and controls`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "Retain this work" });
      const remote = await s.authority.backend.read("notes/example");
      await s.authority.backend.write("notes/example", { ...remote.doc, body: "Concurrent authority edit" });
      await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const mode = (await admitBodyMode(s.backend))!;
      const before = (await bodySnapshot(s.backend, "notes/example", mode)).guard;
      const calls = { ...s.authority.counts };
      for (const choice of [{ kind: "keep-local" }, { kind: "take-remote" }, { kind: "revise", body: "Replacement" }] as const) {
        await assert.rejects(resolveConflict(s.local, s.authority.backend, review, choice), /Inspect or export retained work; no automatic recovery/);
        assert.deepEqual((await bodySnapshot(s.backend, "notes/example", mode)).guard, before);
        assert.deepEqual(s.authority.counts, calls);
      }
    } finally { s.close(); }
  });
  test(`${adapter}: oversized edits, malformed history and absent mode cannot silently adopt legacy delivery`, async () => {
    const s = await setup();
    try {
      const mode = (await admitBodyMode(s.backend))!;
      const before = (await bodySnapshot(s.backend, "notes/example", mode)).guard;
      await assert.rejects(commitBodyLocal(s.local, "notes/example", { body: "x".repeat(65537) }));
      assert.deepEqual((await bodySnapshot(s.backend, "notes/example", mode)).guard, before);
      await s.runtime.commit("notes/example", { body: "Valid" });
      const intent = (await s.backend.listIntents())[0]!;
      await s.backend.updateIntent(intent.requestId, "pending", { attempts: -1 });
      const control = await s.backend.readMeta(BODY_MODE_KEY);
      await assert.rejects(s.runtime.read("notes/example"), /Invalid body journal state/);
      await assert.rejects(push(s.local, exact, { bodyTransport: s.authority.transport }));
      await assert.rejects(resume(s.backend), /Invalid body journal state/);
      assert.deepEqual(await s.backend.readMeta(BODY_MODE_KEY), control);
      assert.equal(s.authority.counts.submitted, 0);
    } finally { s.close(); }
  });
  test(`${adapter}: capacity reserves preparation and receipt without consuming later recovery room`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "Reserved delivery" });
      const mode = (await admitBodyMode(s.backend))!;
      const snap = await bodySnapshot(s.backend, "notes/example", mode);
      assert.doesNotThrow(() => assertBodyCapacity(snap.guard));
      const row = snap.read.intents[0]!;
      assert.throws(() => projectBodyGuard(snap.guard, { intents: [row, { ...row, requestId: "second", sequence: 2 }, { ...row, requestId: "third", sequence: 3 }] }), /capacity/);
      assert.throws(() => projectBodyGuard(snap.guard, { document: { version: row.local, raw: "\\".repeat(1024 * 1024) } }), /capacity/);
      // Many individually bounded retained receipts still count in the complete named metadata array.
      const large = structuredClone(snap.guard);
      for (let i = 0; i < 20; i++) large.meta.push({ key: `body-delivery:request:retained-${i}`, expected: { present: true, value: { receipt: "x".repeat(2 * 1024 * 1024 - 100) } } });
      assert.throws(() => assertBodyCapacity(large), /capacity/);
      await s.runtime.sync();
      const settled = await bodySnapshot(s.backend, "notes/example", mode);
      assert.ok(settled.records.get(row.requestId)!.receipt);
      assert.ok(jsonBytes(settled.guard) < BODY_RUNTIME_LIMITS.guardedBytes);
    } finally { s.close(); }
  });
  test(`${adapter}: identical-byte successor and concurrent pause survive receipt settlement`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "Same bytes" });
      const first = (await s.backend.listIntents())[0]!;
      let release!: () => void, started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      s.authority.knobs.delay = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
      const running = push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
      await reached;
      await s.runtime.commit("notes/example", { body: "Different" });
      await s.runtime.commit("notes/example", { body: "Same bytes" });
      const successor = (await s.backend.listIntents()).at(-1)!;
      assert.equal(successor.local, first.local);
      assert.notEqual(successor.requestId, first.requestId);
      const mode = (await admitBodyMode(s.backend))!;
      const update = s.backend.updateIntent.bind(s.backend);
      let raced = false;
      s.backend.updateIntent = async (...args) => {
        if (!raced && args[2].state === "acknowledged") {
          raced = true;
          await writeBodyControl(s.backend, mode, "sync", { paused: true, reason: "Concurrent pause" });
        }
        return update(...args);
      };
      release(); await running;
      assert.equal((await s.backend.read("notes/example")).version, successor.local);
      assert.equal((await syncStatus(s.local)).paused, true);
      assert.equal((await s.backend.readIntent(first.requestId))!.state, "acknowledged");
      assert.equal((await s.backend.readIntent(successor.requestId))!.state, "pending");
      assert.equal(s.authority.counts.submitted, 1);
    } finally { s.close(); }
  });
}

test("capacity measures exact UTF-8 serialized boundaries and consumes reserved evidence monotonically", () => {
  const E = 2 * 1024 * 1024;
  const guard = { target: "notes/example", document: null, intents: [], meta: [{ key: "retained", expected: { present: true as const, value: "" } }] };
  // No unsettled work: document + shared + transition + full control headroom are reserved.
  const reserve = 3 * E - jsonBytes(null) * 2 + BODY_RUNTIME_LIMITS.controlBytes - jsonBytes(null);
  const padding = BODY_RUNTIME_LIMITS.guardedBytes - reserve - jsonBytes(guard);
  guard.meta[0]!.expected.value = "x".repeat(padding);
  assert.doesNotThrow(() => assertBodyCapacity(guard));
  guard.meta[0]!.expected.value += "x";
  assert.throws(() => assertBodyCapacity(guard), /capacity/);
  guard.meta[0]!.expected.value = "\\".repeat(Math.floor(padding / 2));
  assert.doesNotThrow(() => assertBodyCapacity(guard));
  guard.meta[0]!.expected.value += "\\";
  assert.throws(() => assertBodyCapacity(guard), /capacity/);
});

test("explicit body namespace leaves the exact store untouched and refuses incompatible admission", async () => {
  const factory = new IDBFactory();
  const exactLocal = openLocalBundle("partition-test", { indexedDB: factory });
  const authority = await createBodyAuthority();
  await bootstrap(authority.backend, exactLocal);
  await commitLocal(exactLocal, "notes/example", { buildCandidate: doc => ({ ...doc!, body: "Legacy retained edit" }) });
  const before = await exactLocal.backend.readWithJournal("notes/example");
  const bodyLocal = openLocalBundle("partition-test", { indexedDB: factory, bodyDelivery: { scope: "separate", okfVersion: "0.2" } });
  try {
    await bootstrap(authority.backend, bodyLocal);
    assert.deepEqual(await exactLocal.backend.readWithJournal("notes/example"), before);
    assert.equal((await bodyLocal.backend.listIntents()).length, 0);
    assert.equal((await bodyLocal.backend.read("notes/example")).doc.body.trim(), "Original body");
  } finally { exactLocal.close(); bodyLocal.close(); }
  const incompatible = new MemoryJournaledBackend();
  await incompatible.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
  const selected = openLocalBundle("incompatible", { backend: incompatible, bodyDelivery: { scope: "separate", okfVersion: "0.2", dedicated: true } });
  await assert.rejects(admitBodyMode(incompatible), /edition is incompatible/);
  assert.equal((await incompatible.readWithJournal("runtime-state", { meta: [BODY_MODE_KEY] })).meta.has(BODY_MODE_KEY), false);
  selected.close();
});
