import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackend } from "@superbee/core/indexeddb-backend";
import type { OperationTransport } from "@superbee/core/uncertain-write";
import { BODY_DELIVERY_LIMITS } from "@superbee/core/governed-body-write";
import { openLocalBundle, bootstrap, commitBodyLocal, commitLocal, push, pull, reclaimInFlight, resume, syncStatus, settleIntent, inspectConflict, resolveConflict, conflictResolutionKey, type ConflictChoice } from "../src/local-bundle.ts";
import { admitBodyMode, bodyRecordKey, BODY_MODE_KEY, bodySnapshot, assertBodyCapacity, projectBodyGuard, jsonBytes, BODY_RUNTIME_LIMITS, writeBodyControl, validateBodyRecord, validateBodyResolutionReceipt } from "../src/body-journal.ts";
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
  /** A local body edit the authority answers with a moved head (`conflict`) or a content refusal (`refused`). */
  async function contested(s: Awaited<ReturnType<typeof setup>>, head: "conflict" | "refused") {
    await s.runtime.commit("notes/example", { body: "Retain this work" });
    if (head === "conflict") {
      const remote = await s.authority.backend.read("notes/example");
      await s.authority.backend.write("notes/example", { ...remote.doc, body: "Concurrent authority edit" });
    } else s.authority.knobs.contentRefusal = true;
    await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
    s.authority.knobs.contentRefusal = false;
    const chain = (await s.backend.listIntents()).filter(row => row.state !== "acknowledged");
    assert.deepEqual(chain.map(row => row.state), [head]);
    return chain[0]!;
  }
  const guardOf = async (s: Awaited<ReturnType<typeof setup>>) => (await bodySnapshot(s.backend, "notes/example", (await admitBodyMode(s.backend))!)).guard;
  /** The authority's read side with its document reads counted, so a local refusal can be shown to cost no network read. */
  const countingRemote = (s: Awaited<ReturnType<typeof setup>>) => {
    const reads = { count: 0 };
    const remote = new Proxy(s.authority.backend, { get(inner, key) {
      if (key === "read") return async (...args: Parameters<typeof inner.read>) => { reads.count += 1; return inner.read(...args); };
      const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
    } });
    return { remote, reads };
  };
  const choices = [{ kind: "keep-local" }, { kind: "take-remote" }, { kind: "revise", body: "Replacement" }] as const;
  test(`${adapter}: a content refusal reads local-pending, counts as refused without a pause, and is inspectable`, async () => {
    const s = await setup();
    try {
      const head = await contested(s, "refused");
      const read = await s.runtime.read("notes/example");
      assert.equal(read.provenance.state, "local-pending");
      assert.equal((read.provenance as { requestId: string }).requestId, head.requestId);
      const status = await s.runtime.syncStatus();
      assert.equal(status.refused, 1); assert.equal(status.paused, false); assert.equal(status.conflicts, 0);
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.deepEqual(review.intents.map(row => [row.requestId, row.state, row.refusal?.code]), [[head.requestId, "refused", "validation_failed"]]);
      assert.equal(review.local.content, head.content);
      assert.deepEqual(review.base, { version: head.base, content: head.baseContent });
      assert.equal(review.remote.version, s.authority.initial.version);
    } finally { s.close(); }
  });
  for (const head of ["conflict", "refused"] as const) for (const choice of choices) {
    test(`${adapter}: ${choice.kind} retires a ${head} head with its descriptors, keeps a bounded receipt and leaves the document deliverable`, async () => {
      const s = await setup();
      try {
        const headRow = await contested(s, head);
        await s.runtime.commit("notes/example", { body: "Later local edit" });
        assert.equal((await s.runtime.read("notes/example")).provenance.state, head === "conflict" ? "local-conflict" : "local-pending");
        const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
        assert.deepEqual(review.intents.map(row => row.state), [head, "pending"]);
        const patches: unknown[] = [];
        const update = s.backend.updateIntent.bind(s.backend);
        s.backend.updateIntent = async (...args) => { patches.push(args[2]); return update(...args); };
        const calls = { ...s.authority.counts };
        const result = await resolveConflict(s.local, s.authority.backend, review, choice);
        s.backend.updateIntent = update;
        assert.deepEqual(patches, [], "the head is retired as it was, never rewritten");
        assert.deepEqual(s.authority.counts, calls, "resolution sends nothing");
        for (const row of review.intents) {
          assert.equal(await s.backend.readIntent(row.requestId), undefined);
          assert.equal(await s.backend.readMeta(bodyRecordKey(row.requestId)), undefined);
        }
        const receipt = validateBodyResolutionReceipt(await s.backend.readMeta(conflictResolutionKey(headRow.requestId)));
        assert.deepEqual(receipt, result.receipt);
        assert.equal(receipt.id, headRow.requestId);
        assert.equal(receipt.choice, choice.kind);
        assert.deepEqual(receipt.chain.map(row => [row.requestId, row.state, row.attempts, row.refusalCode, row.remoteVersion]),
          review.intents.map(row => [row.requestId, row.state, row.attempts, head === "refused" && row.state === "refused" ? "validation_failed" : undefined, row.state === "conflict" ? review.remote.version : undefined]));
        assert.deepEqual(receipt.served, { version: review.remote.version });
        assert.equal(receipt.expectedLocalVersion, review.local.version);
        assert.ok(!JSON.stringify(receipt).includes("Retain this work") && !JSON.stringify(receipt).includes("Later local edit"), "the receipt carries no content");
        const after = await s.runtime.read("notes/example");
        const base = await s.backend.readMeta<{ version: string; content: string }>("base:notes/example");
        assert.equal(base!.version, review.remote.version);
        if (choice.kind === "take-remote") {
          assert.equal(result.intent, null);
          assert.equal(after.provenance.state, "shared-confirmed");
          assert.equal(after.doc.body.trim(), head === "conflict" ? "Concurrent authority edit" : "Original body");
          assert.equal(base!.content, (await s.backend.readWithJournal("notes/example")).raw, "the base names the adopted bytes");
          assert.deepEqual(await s.backend.listIntents(), []);
        } else {
          const fresh = result.intent!;
          assert.equal(after.provenance.state, "local-pending");
          assert.equal((after.provenance as { requestId: string }).requestId, fresh.requestId);
          assert.equal(after.doc.body.trim(), choice.kind === "revise" ? "Replacement" : "Later local edit");
          assert.equal(fresh.after, undefined);
          assert.deepEqual([fresh.base, fresh.attempts, fresh.state], [review.remote.version, 0, "pending"]);
          assert.equal(receipt.replacementRequestId, fresh.requestId);
          const record = validateBodyRecord((await admitBodyMode(s.backend))!, fresh, await s.backend.readMeta(bodyRecordKey(fresh.requestId)));
          assert.equal(record.initialVersion, review.remote.version);
          assert.equal(record.body, choice.kind === "revise" ? "Replacement" : "Later local edit");
          const status = await s.runtime.sync();
          assert.deepEqual([status.pending, status.refused, status.conflicts, status.lastSync?.ok], [0, 0, 0, true]);
          assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
          assert.equal((await s.authority.backend.read("notes/example")).doc.body.trim(), choice.kind === "revise" ? "Replacement" : "Later local edit");
        }
        await s.runtime.commit("notes/example", { body: "Next edit" });
        assert.equal((await syncStatus(s.local)).counts.pending, 1);
      } finally { s.close(); }
    });
  }
  for (const head of ["conflict", "refused"] as const) test(`${adapter}: an absent served head over a ${head} head is taken as a deletion; keep-local and revise refuse without mutation`, async () => {
    const s = await setup();
    try {
      const headRow = await contested(s, head);
      await s.authority.backend.delete("notes/example");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.deepEqual(review.remote, { version: null, content: null });
      const before = await guardOf(s);
      for (const choice of choices) {
        if (choice.kind === "take-remote") continue;
        await assert.rejects(resolveConflict(s.local, s.authority.backend, review, choice), { name: "BodyRuntimeError" });
        assert.deepEqual(await guardOf(s), before);
      }
      const taken = await resolveConflict(s.local, s.authority.backend, review, { kind: "take-remote" });
      assert.deepEqual([taken.version, taken.intent], [null, null]);
      await assert.rejects(s.backend.read("notes/example"), { code: "ENOENT" });
      assert.deepEqual(await s.backend.listIntents(), []);
      assert.equal(await s.backend.readMeta(bodyRecordKey(headRow.requestId)), undefined);
      assert.deepEqual(await s.backend.readMeta("base:notes/example"), { version: null, content: null });
      assert.deepEqual(validateBodyResolutionReceipt(await s.backend.readMeta(conflictResolutionKey(headRow.requestId))), taken.receipt);
      assert.deepEqual((await s.runtime.query()).map(row => row.id), []);
      assert.equal((await s.runtime.syncStatus()).unconfirmed, 0);
    } finally { s.close(); }
  });
  test(`${adapter}: an authorization refusal is not a resolvable head; resume keeps its path`, async () => {
    const s = await setup();
    try {
      await s.runtime.commit("notes/example", { body: "Refused by permission" });
      s.authority.knobs.terminalRefusal = true;
      await s.runtime.sync();
      s.authority.knobs.terminalRefusal = false;
      assert.deepEqual([(await syncStatus(s.local)).counts.refused, (await syncStatus(s.local)).paused], [1, true]);
      const head = (await s.backend.listIntents())[0]!;
      const before = await guardOf(s);
      await assert.rejects(inspectConflict(s.local, s.authority.backend, "notes/example"), { name: "InvalidInputError" });
      const forged = { id: "notes/example", local: { version: head.local, content: head.content }, base: { version: head.base, content: head.baseContent }, remote: { version: null, content: null }, intents: [head] };
      const { remote, reads } = countingRemote(s);
      for (const choice of choices) await assert.rejects(resolveConflict(s.local, remote, forged, choice), { name: "InvalidInputError" });
      assert.equal(reads.count, 0, "a head outside recovery is refused before the authority is asked");
      assert.deepEqual(await guardOf(s), before);
      assert.equal((await resume(s.backend)).requeued, 1);
      const status = await s.runtime.sync();
      assert.deepEqual([status.refused, status.lastSync?.ok], [1, false], "a recorded refusal stays refused after resume");
    } finally { s.close(); }
  });
  test(`${adapter}: a stale review refuses every choice without mutation, and a guard that keeps moving reports the review stale`, async () => {
    const s = await setup();
    try {
      await contested(s, "refused");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const remote = await s.authority.backend.read("notes/example");
      await s.authority.backend.write("notes/example", { ...remote.doc, body: "Moved since review" });
      let before = await guardOf(s);
      for (const choice of choices) {
        await assert.rejects(resolveConflict(s.local, s.authority.backend, review, choice), { name: "ConflictReviewStaleError" });
        assert.deepEqual(await guardOf(s), before);
      }
      const fresh = await inspectConflict(s.local, s.authority.backend, "notes/example");
      await s.runtime.commit("notes/example", { body: "Edited since review" });
      before = await guardOf(s);
      const { remote: counted, reads } = countingRemote(s);
      for (const choice of choices) {
        await assert.rejects(resolveConflict(s.local, counted, fresh, choice), { name: "JournalSnapshotConflict" });
        assert.deepEqual(await guardOf(s), before);
      }
      assert.equal(reads.count, 0, "a review the working copy no longer matches is refused before the authority is asked");
      const current = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const mode = (await admitBodyMode(s.backend))!;
      const write = s.backend.writeJournaled.bind(s.backend);
      let moves = 0;
      s.backend.writeJournaled = async (...args) => { moves += 1; await writeBodyControl(s.backend, mode, "pull", { startedAt: `move-${moves}`, completedAt: null }); return write(...args); };
      await assert.rejects(resolveConflict(s.local, s.authority.backend, current, { kind: "revise", body: "Never lands" }), { name: "ConflictReviewStaleError" });
      s.backend.writeJournaled = write;
      assert.equal(moves, 3, "the guarded write is retried up to the compose limit");
      assert.deepEqual((await s.backend.readWithJournal("notes/example")).intents.map(row => row.requestId), current.intents.map(row => row.requestId));
      assert.equal(await s.backend.readMeta(conflictResolutionKey(current.intents[0]!.requestId)), undefined);
    } finally { s.close(); }
  });
  test(`${adapter}: concurrent resolutions of one review accept exactly one and leave one consistent state`, async () => {
    for (const head of ["conflict", "refused"] as const) {
      const s = await setup();
      try {
        const headRow = await contested(s, head);
        const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
        const results = await Promise.allSettled(choices.map(choice => resolveConflict(s.local, s.authority.backend, review, choice)));
        const winners = results.filter((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveConflict>>> => row.status === "fulfilled");
        assert.equal(winners.length, 1);
        for (const row of results) if (row.status === "rejected") assert.ok(["JournalSnapshotConflict", "ConflictReviewStaleError", "VersionConflict"].includes((row.reason as Error).name), String(row.reason));
        const receipt = validateBodyResolutionReceipt(await s.backend.readMeta(conflictResolutionKey(headRow.requestId)));
        assert.deepEqual(receipt, winners[0]!.value.receipt);
        assert.equal(await s.backend.readIntent(headRow.requestId), undefined);
        const unsettled = (await s.backend.listIntents()).filter(row => row.state !== "acknowledged");
        assert.deepEqual(unsettled.map(row => row.requestId), receipt.replacementRequestId === null ? [] : [receipt.replacementRequestId]);
        await guardOf(s);
        assert.equal((await s.runtime.syncStatus()).unconfirmed, 0);
        assert.equal(s.authority.counts.applied, 0);
      } finally { s.close(); }
    }
  });
  test(`${adapter}: the resolution receipt is strictly shaped and bounded, and capacity refuses before mutation`, async () => {
    const s = await setup();
    try {
      const head = await contested(s, "refused");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const valid = { schema: 1, mode: "document.body.update", id: head.requestId, target: "notes/example", choice: "take-remote", resolvedAt: "2026-09-15T00:00:00.000Z", replacementRequestId: null,
        served: { version: review.remote.version }, expectedLocalVersion: review.local.version, chain: [{ requestId: head.requestId, sequence: head.sequence, state: "refused", attempts: 1, base: head.base, local: head.local, refusalCode: "validation_failed" }] };
      assert.deepEqual(validateBodyResolutionReceipt(valid), valid);
      const row = valid.chain[0]!;
      for (const bad of [{ ...valid, content: "x" }, { ...valid, chain: [] }, { ...valid, choice: "merge" }, { ...valid, served: { version: "moved" } }, { ...valid, resolvedAt: "yesterday" },
        { ...valid, chain: [{ ...row, remote: { version: null, content: "x" } }] }, { ...valid, chain: [{ ...row, state: "settled" }] }, { ...valid, chain: [{ ...row, local: "sha256:short" }] }]) {
        assert.throws(() => validateBodyResolutionReceipt(bad), { name: "BodyRuntimeError" });
      }
      assert.throws(() => validateBodyResolutionReceipt({ ...valid, chain: Array.from({ length: 40 }, (_, index) => ({ ...row, sequence: index, refusalCode: "x".repeat(2000) })) }), { name: "BodyCapacityError" });
      // A served head beyond the envelope bound can be neither adopted nor recorded as a base: refused before any mutation.
      const remote = await s.authority.backend.read("notes/example");
      await s.authority.backend.write("notes/example", { ...remote.doc, body: "y".repeat(BODY_DELIVERY_LIMITS.envelopeBytes + 16) });
      const oversized = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const before = await guardOf(s);
      for (const choice of choices) {
        await assert.rejects(resolveConflict(s.local, s.authority.backend, oversized, choice), { name: "BodyCapacityError" });
        assert.deepEqual(await guardOf(s), before);
      }
      assert.equal(await s.backend.readMeta(conflictResolutionKey(head.requestId)), undefined);
    } finally { s.close(); }
  });
  test(`${adapter}: revise validates its input before reading the target journal and writes nothing`, async () => {
    const s = await setup();
    try {
      await contested(s, "refused");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const before = await guardOf(s);
      const reads: string[] = [];
      const read = s.backend.readWithJournal.bind(s.backend);
      s.backend.readWithJournal = async (...args) => { reads.push(args[0]); return read(...args); };
      for (const choice of [{ kind: "revise", body: "x".repeat(65537) }, { kind: "revise", body: "Typed", frontmatter: { type: "Note" } }, { kind: "revise", body: 42 }]) {
        await assert.rejects(resolveConflict(s.local, s.authority.backend, review, choice as ConflictChoice), { name: "BodyRuntimeError" });
      }
      s.backend.readWithJournal = read;
      assert.ok(!reads.includes("notes/example"), "the input is refused before the target journal is read");
      assert.deepEqual(await guardOf(s), before);
    } finally { s.close(); }
  });
  test(`${adapter}: a resolution receipt survives reopening the working copy and the fresh update delivers`, async () => {
    const s = await setup();
    try {
      const head = await contested(s, "refused");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const result = await resolveConflict(s.local, s.authority.backend, review, { kind: "revise", body: "Revised after refusal" });
      s.close();
      const reopened = openLocalBundle("body-test", { backend: s.backend, bodyDelivery: { scope: "fixture", okfVersion: "0.2", dedicated: true } });
      const receipt = validateBodyResolutionReceipt(await reopened.backend.readMeta(conflictResolutionKey(head.requestId)));
      assert.deepEqual(receipt, result.receipt);
      assert.equal(receipt.replacementRequestId, result.intent!.requestId);
      assert.equal((await reopened.backend.readIntent(result.intent!.requestId))!.state, "pending");
      await push(reopened, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
      assert.equal(s.authority.counts.applied, 1);
      assert.equal((await s.authority.backend.read("notes/example")).doc.body.trim(), "Revised after refusal");
      assert.equal((await reopened.backend.readIntent(result.intent!.requestId))!.state, "acknowledged");
      assert.deepEqual(await reopened.backend.readMeta(conflictResolutionKey(head.requestId)), receipt, "the receipt outlives the acknowledgement");
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
  test(`${adapter}: pre-fetch content guards reject stale reads after acknowledgment, including identical bytes`, async () => {
    for (const sameBytes of [false, true]) {
      const s = await setup();
      try {
        if (sameBytes) { await s.runtime.commit("notes/example", { body: "Returning body" }); await s.runtime.sync(); }
        const original = await s.backend.readWithJournal("notes/example");
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const remote = new Proxy(s.authority.backend, { get(inner, key) {
          if (key === "readMany") return async (ids: string[]) => { const rows = await inner.readMany(ids); started(); await blocked; return rows; };
          const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
        } });
        const pulling = pull(s.local, remote);
        const rejected = assert.rejects(pulling, /journal guard/);
        await reached;
        await s.runtime.commit("notes/example", { body: "New acknowledged body" });
        await push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
        if (sameBytes) { await s.runtime.commit("notes/example", { body: "Returning body" }); await push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate }); }
        const before = await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] });
        if (sameBytes) { assert.equal(before.raw, original.raw); assert.ok(before.intents.length > original.intents.length); }
        release(); await rejected;
        assert.deepEqual(await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] }), before);
        const control = await s.backend.readMeta<{ controls: { pull: { completedAt: string | null } } }>(BODY_MODE_KEY);
        assert.equal(control!.controls.pull.completedAt, null);
      } finally { s.close(); }
    }
  });
  test(`${adapter}: stale inventory cannot delete newly acknowledged work`, async () => {
    const s = await setup();
    try {
      let release!: () => void, started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      // Structural inventory adapter: an older complete empty listing is withheld in transit.
      const remote = new Proxy(s.authority.backend, { get(inner, key) {
        if (key === "wireCapabilities") return async () => ({ heads: true, snapshot: false });
        if (key === "snapshot") return async () => { throw new Error("Unused snapshot"); };
        if (key === "heads") return async () => { started(); await blocked; return { heads: [], digest: "old-empty-listing" }; };
        const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
      } });
      const pulling = pull(s.local, remote), rejected = assert.rejects(pulling, /journal guard/);
      await reached;
      await s.runtime.commit("notes/example", { body: "New acknowledged body" });
      await push(s.local, exact, { bodyTransport: s.authority.transport, write: immediate });
      const before = await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] });
      release(); await rejected;
      assert.deepEqual(await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] }), before);
      assert.equal((await s.backend.readMeta<any>(BODY_MODE_KEY)).controls.pull.completedAt, null);
    } finally { s.close(); }
  });
  test(`${adapter}: snapshot bootstrap cannot overwrite a newer refresh or delete its new target`, async () => {
    for (const scenario of ["content", "deletion", "new-target"]) {
      const s = await setup();
      try {
        const omit = scenario === "deletion", target = scenario === "new-target" ? "notes/new" : "notes/example";
        if (scenario === "new-target") await s.authority.backend.write(target, { id: target, frontmatter: { type: "Note" }, body: "Original new target" });
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const remote = new Proxy(s.authority.backend, { get(inner, key) {
          if (key === "wireCapabilities") return async () => ({ heads: true, snapshot: true });
          if (key === "heads") return async () => { throw new Error("Unused heads"); };
          if (key === "snapshot") return async () => {
            const old = await inner.read(target); started(); await blocked;
            return { header: { count: omit ? 0 : 1, digest: "old-snapshot" }, docs: (async function* () { if (!omit) yield { ...old.doc, version: old.version }; })() };
          };
          const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
        } });
        const booting = bootstrap(remote, s.local), rejected = assert.rejects(booting, /journal guard/);
        await reached;
        const current = await s.authority.backend.read(target);
        await s.authority.backend.write(target, { ...current.doc, body: "Fresh authority observation" });
        await pull(s.local, s.authority.backend);
        const before = await s.backend.readWithJournal(target, { meta: [`base:${target}`] });
        release(); await rejected;
        assert.deepEqual(await s.backend.readWithJournal(target, { meta: [`base:${target}`] }), before);
        assert.equal((await s.backend.readMeta<any>(BODY_MODE_KEY)).controls.bootstrap.complete, false);
      } finally { s.close(); }
    }
  });
  test(`${adapter}: body bootstrap preserves custom local root across delayed remote metadata`, async () => {
    const s = await setup();
    try {
      const custom = "---\nokf_version: '0.2'\nname: Local custom metadata\n---\n# Keep this local root\n";
      await s.backend.writeReserved("", "index.md", custom);
      let release!: () => void, started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const remote = new Proxy(s.authority.backend, { get(inner, key) {
        if (key === "readReserved") return async (...args: Parameters<typeof inner.readReserved>) => { const old = await inner.readReserved(...args); started(); await blocked; return old; };
        const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
      } });
      const older = bootstrap(remote, s.local);
      await reached;
      await s.authority.backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\nname: New remote metadata\n---\n# New\n");
      await bootstrap(s.authority.backend, s.local);
      assert.equal((await s.backend.readReserved("", "index.md"))!.content, custom);
      release(); await older;
      assert.equal((await s.backend.readReserved("", "index.md"))!.content, custom);
    } finally { s.close(); }
  });
  test(`${adapter}: simultaneous absent-root initializers seed identical local bytes`, async () => {
    const backend = adapter === "memory" ? new MemoryJournaledBackend() : new IndexedDbBackend({ databaseName: crypto.randomUUID(), indexedDB: new IDBFactory() });
    const local = openLocalBundle("root-initializers", { backend, bodyDelivery: { scope: "root", okfVersion: "0.2", dedicated: true } });
    const remote = new MemoryJournaledBackend();
    await remote.writeReserved("", "index.md", "---\nokf_version: '0.2'\nname: Do not import\n---\n# Remote root\n");
    try {
      await Promise.all([bootstrap(remote, local), bootstrap(remote, local)]);
      assert.equal((await backend.readReserved("", "index.md"))!.content, "---\nokf_version: '0.2'\n---\n");
    } finally { local.close(); }
  });
  test(`${adapter}: every import refuses incompatible or malformed declared editions without replacing roots`, async () => {
    const s = await setup();
    try {
      const originalRoot = await s.backend.readReserved("", "index.md");
      const original = await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] });
      for (const root of ["---\nokf_version: '0.1'\n---\n", "---\nokf_version: '0.9'\n---\n", "---\nokf_version: 0.2\n---\n", "---\nokf_version: [\n---\n"]) {
        await s.authority.backend.writeReserved("", "index.md", root);
        await assert.rejects(pull(s.local, s.authority.backend));
        assert.equal((await s.backend.readMeta<any>(BODY_MODE_KEY)).controls.pull.completedAt, null);
        await assert.rejects(bootstrap(s.authority.backend, s.local));
        assert.equal((await s.backend.readMeta<any>(BODY_MODE_KEY)).controls.bootstrap.complete, false);
        assert.deepEqual(await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] }), original);
        assert.deepEqual(await s.backend.readReserved("", "index.md"), originalRoot);
      }
      await s.authority.backend.writeReserved("", "index.md", originalRoot!.content);
      await s.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n# Retain incompatible root\n");
      const incompatible = await s.backend.readReserved("", "index.md");
      await assert.rejects(bootstrap(s.authority.backend, s.local), /edition differs/);
      assert.deepEqual(await s.backend.readReserved("", "index.md"), incompatible);
    } finally { s.close(); }
  });
  test(`${adapter}: edition changes during a content fetch are refused at import`, async () => {
    for (const operation of ["pull", "bootstrap"]) {
      const s = await setup();
      try {
        const original = await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] });
        let release!: () => void, started!: () => void;
        const reached = new Promise<void>(resolve => { started = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const remote = new Proxy(s.authority.backend, { get(inner, key) {
          if (key === "readMany") return async (ids: string[]) => { const rows = await inner.readMany(ids); started(); await blocked; return rows; };
          const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
        } });
        const importing = operation === "pull" ? pull(s.local, remote) : bootstrap(remote, s.local);
        const rejected = assert.rejects(importing, /Authority edition differs/);
        await reached;
        await s.authority.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
        release(); await rejected;
        assert.deepEqual(await s.backend.readWithJournal("notes/example", { meta: ["base:notes/example"] }), original);
      } finally { s.close(); }
    }
  });
  test(`${adapter}: incompatible empty inventories, unchanged answers and streams cannot delete or complete`, async () => {
    for (const response of ["heads-empty", "heads-304", "snapshot-empty", "list-empty"]) {
      const s = await setup();
      try {
        await s.runtime.commit("notes/example", { body: "Retained acknowledged evidence" });
        await s.runtime.sync();
        const requestId = (await s.backend.listIntents())[0]!.requestId;
        const keys = ["base:notes/example", bodyRecordKey(requestId)];
        const before = await s.backend.readWithJournal("notes/example", { meta: keys });
        const changeEdition = () => s.authority.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
        const remote = new Proxy(s.authority.backend, { get(inner, key) {
          if (key === "wireCapabilities" && response !== "list-empty") return async () => ({ heads: true, snapshot: true });
          if (key === "heads" && response !== "list-empty") return async () => { await changeEdition(); return response === "heads-304" ? null : { heads: [], digest: "empty-new-edition" }; };
          if (key === "snapshot" && response !== "list-empty") return async () => ({ header: { count: 0, digest: "empty-new-edition" }, docs: (async function* () { await changeEdition(); })() });
          if (key === "list" && response === "list-empty") return async () => { await changeEdition(); return []; };
          const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
        } });
        await assert.rejects(response === "snapshot-empty" ? bootstrap(remote, s.local) : pull(s.local, remote), /Authority edition differs/);
        assert.deepEqual(await s.backend.readWithJournal("notes/example", { meta: keys }), before);
        const controls = (await s.backend.readMeta<any>(BODY_MODE_KEY)).controls;
        if (response === "snapshot-empty") assert.equal(controls.bootstrap.complete, false);
        else assert.equal(controls.pull.completedAt, null);
      } finally { s.close(); }
    }
  });
}

test("legacy bootstrap still mirrors root metadata; missing edition legitimately defaults to v0.1", async () => {
  const authority = await createBodyAuthority(undefined, "0.1");
  const root = "---\nname: Legacy root without edition marker\n---\n# Preserve legacy import\n";
  await authority.backend.writeReserved("", "index.md", root);
  const legacy = openLocalBundle("legacy-root", { backend: new MemoryJournaledBackend() });
  const body = openLocalBundle("body-root", { backend: new MemoryJournaledBackend(), bodyDelivery: { scope: "fallback", okfVersion: "0.1", dedicated: true } });
  try {
    await bootstrap(authority.backend, legacy);
    assert.equal((await legacy.backend.readReserved("", "index.md"))!.content, root);
    await bootstrap(authority.backend, body);
    assert.equal((await body.backend.readReserved("", "index.md"))!.content, "---\nokf_version: '0.1'\n---\n");
  } finally { legacy.close(); body.close(); }
});

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
