/**
 * Body-mode conflict resolution under adversarial interleavings, over both adapters: a guard
 * that moves once, a local commit or a pull racing the resolution, supersession chains and
 * acknowledged siblings, the body grammar and its bounds, receipts over many resolutions, a
 * paused store, a moved authority edition, and a taken deletion the authority later re-creates.
 * The ordinary rows of each choice live in `body-delivery.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BODY_DELIVERY_LIMITS } from "@superbee/core/governed-body-write";
import { commitBodyLocal, push, pull, resume, syncStatus, inspectConflict, resolveConflict, conflictResolutionKey, type ConflictChoice } from "../src/local-bundle.ts";
import { admitBodyMode, bodyRecordKey, writeBodyControl, validateBodyRecord, validateBodyResolutionReceipt, jsonBytes } from "../src/body-journal.ts";
import { ADAPTERS, setup, contested, guardOf, choices, exact, immediate } from "./fixtures/body-resolution.ts";

for (const adapter of ADAPTERS) {
  // One guard move between the local verification and the guarded write: the retry lands once.
  for (const choice of choices) test(`${adapter}: ${choice.kind} lands on the second attempt after one guard move, with one fresh identity and no leftovers`, async () => {
    const s = await setup(adapter);
    try {
      const head = await contested(s, "refused");
      await s.runtime.commit("notes/example", { body: "Later local edit" });
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const mode = (await admitBodyMode(s.backend))!;
      const write = s.backend.writeJournaled.bind(s.backend), remove = s.backend.deleteJournaled.bind(s.backend);
      let moves = 0;
      const moveOnce = async () => { if (moves === 0) { moves += 1; await writeBodyControl(s.backend, mode, "pull", { startedAt: "moved-once", completedAt: null }); } };
      s.backend.writeJournaled = async (...args) => { await moveOnce(); return write(...args); };
      s.backend.deleteJournaled = async (...args) => { await moveOnce(); return remove(...args); };
      const result = await resolveConflict(s.local, s.authority.backend, review, choice);
      s.backend.writeJournaled = write; s.backend.deleteJournaled = remove;
      assert.equal(moves, 1);
      const receipt = validateBodyResolutionReceipt(await s.backend.readMeta(conflictResolutionKey(head.requestId)));
      assert.deepEqual(receipt, result.receipt);
      const unsettled = (await s.backend.listIntents()).filter(row => row.state !== "acknowledged");
      if (choice.kind === "take-remote") assert.deepEqual(unsettled, []);
      else {
        assert.equal(unsettled.length, 1);
        assert.equal(unsettled[0]!.requestId, result.intent!.requestId);
        assert.equal(receipt.replacementRequestId, result.intent!.requestId);
        validateBodyRecord(mode, unsettled[0]!, await s.backend.readMeta(bodyRecordKey(unsettled[0]!.requestId)));
      }
      for (const row of review.intents) assert.equal(await s.backend.readMeta(bodyRecordKey(row.requestId)), undefined);
      await guardOf(s);
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.conflicts], [0, 0, 0]);
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
    } finally { s.close(); }
  });

  // A local commit lands while the authority is being read: the resolution refuses without mutation.
  for (const head of ["conflict", "refused"] as const) for (const choice of choices) test(`${adapter}: ${choice.kind} over a ${head} head refuses when a local edit lands during the authority read`, async () => {
    const s = await setup(adapter);
    try {
      await contested(s, head);
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      let commits = 0;
      const remote = new Proxy(s.authority.backend, { get(inner, key) {
        if (key === "read") return async (...args: Parameters<typeof inner.read>) => {
          if (commits === 0) { commits += 1; await commitBodyLocal(s.local, "notes/example", { body: "Edited during the read" }); }
          return inner.read(...args);
        };
        const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
      } });
      // Take-remote sees the journal move; keep-local and revise are refused by the mutation's own CAS, before any write.
      await assert.rejects(resolveConflict(s.local, remote, review, choice), (error: Error) => ["JournalSnapshotConflict", "VersionConflict", "ConflictReviewStaleError"].includes(error.name));
      assert.equal(commits, 1);
      const after = await guardOf(s);
      const chain = after.intents.filter(row => row.state !== "acknowledged");
      assert.deepEqual(chain.map(row => row.state), [head, "pending"]);
      assert.equal(chain[1]!.after, chain[0]!.requestId);
      assert.equal(await s.backend.readMeta(conflictResolutionKey(review.intents[0]!.requestId)), undefined);
      assert.equal((await s.runtime.read("notes/example")).doc.body.trim(), "Edited during the read");
      const fresh = await inspectConflict(s.local, s.authority.backend, "notes/example");
      await resolveConflict(s.local, s.authority.backend, fresh, choice);
      await guardOf(s);
    } finally { s.close(); }
  });

  // A real pull runs at the same time as the resolution; whichever order, the store ends consistent and the pull never replaces held work.
  for (const order of ["pull-first", "resolve-first"] as const) for (const choice of choices) test(`${adapter}: ${choice.kind} racing a real pull (${order}) ends consistent`, async () => {
    const s = await setup(adapter);
    try {
      const head = await contested(s, "conflict");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const work = order === "pull-first"
        ? [pull(s.local, s.authority.backend), resolveConflict(s.local, s.authority.backend, review, choice)]
        : [resolveConflict(s.local, s.authority.backend, review, choice), pull(s.local, s.authority.backend)];
      const results = await Promise.allSettled(work);
      const resolution = results[order === "pull-first" ? 1 : 0]!;
      const guard = await guardOf(s);
      const unsettled = guard.intents.filter(row => row.state !== "acknowledged");
      const receipt = await s.backend.readMeta(conflictResolutionKey(head.requestId));
      if (resolution.status === "fulfilled") {
        assert.deepEqual(validateBodyResolutionReceipt(receipt), (resolution.value as { receipt: unknown }).receipt);
        assert.deepEqual(unsettled.map(row => row.requestId), choice.kind === "take-remote" ? [] : [(resolution.value as { intent: { requestId: string } }).intent.requestId]);
      } else {
        assert.ok(["JournalSnapshotConflict", "ConflictReviewStaleError", "VersionConflict"].includes((resolution.reason as Error).name), String(resolution.reason));
        assert.equal(receipt, undefined);
        assert.deepEqual(unsettled.map(row => row.requestId), [head.requestId], "a refused resolution leaves the chain as it was");
        assert.equal((await s.runtime.read("notes/example")).doc.body.trim(), "Retain this work", "the pull never replaced the held edit");
      }
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.lastSync?.ok], [0, 0, true]);
    } finally { s.close(); }
  });

  // Chains: a superseded successor never returns; an acknowledged sibling row on the same target is untouched.
  test(`${adapter}: keep-local requeues the latest surviving successor after a supersession, never the retired one`, async () => {
    const s = await setup(adapter);
    try {
      const head = await contested(s, "refused");
      await s.runtime.commit("notes/example", { body: "First successor" });
      const first = (await s.backend.listIntents()).at(-1)!;
      await s.runtime.commit("notes/example", { body: "Second successor" });
      const second = (await s.backend.listIntents()).at(-1)!;
      assert.equal(await s.backend.readIntent(first.requestId), undefined, "the first successor was superseded by the commit");
      assert.equal(await s.backend.readMeta(bodyRecordKey(first.requestId)), undefined);
      assert.deepEqual([second.after, second.base], [head.requestId, head.local]);
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.deepEqual(review.intents.map(row => row.requestId), [head.requestId, second.requestId]);
      const result = await resolveConflict(s.local, s.authority.backend, review, { kind: "keep-local" });
      const receipt = result.receipt as { chain: { requestId: string }[] };
      assert.deepEqual(receipt.chain.map(row => row.requestId), [head.requestId, second.requestId]);
      const record = await s.backend.readMeta<{ body: string }>(bodyRecordKey(result.intent!.requestId));
      assert.equal(record!.body, "Second successor");
      assert.equal(await s.backend.readMeta(bodyRecordKey(first.requestId)), undefined);
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused], [0, 0]);
      assert.equal((await s.authority.backend.read("notes/example")).doc.body.trim(), "Second successor");
    } finally { s.close(); }
  });
  for (const choice of choices) test(`${adapter}: ${choice.kind} leaves an acknowledged sibling row, its descriptor and its receipt untouched`, async () => {
    const s = await setup(adapter);
    try {
      await s.runtime.commit("notes/example", { body: "Acknowledged first" });
      await s.runtime.sync();
      const acknowledged = (await s.backend.listIntents())[0]!;
      assert.equal(acknowledged.state, "acknowledged");
      const evidence = await s.backend.readMeta(bodyRecordKey(acknowledged.requestId));
      assert.ok((evidence as { receipt?: unknown }).receipt, "the acknowledged row carries its receipt");
      const head = await contested(s, "refused", "Refused second");
      assert.equal(head.after, undefined, "a head after acknowledged history starts a fresh chain");
      assert.equal(head.base, acknowledged.acknowledgedVersion);
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.deepEqual(review.intents.map(row => row.requestId), [head.requestId]);
      await resolveConflict(s.local, s.authority.backend, review, choice);
      assert.deepEqual(await s.backend.readIntent(acknowledged.requestId), acknowledged);
      assert.deepEqual(await s.backend.readMeta(bodyRecordKey(acknowledged.requestId)), evidence);
      assert.equal(await s.backend.readIntent(head.requestId), undefined);
      assert.equal(await s.backend.readMeta(bodyRecordKey(head.requestId)), undefined);
      await guardOf(s);
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.conflicts], [0, 0, 0]);
      assert.equal(s.authority.counts.applied, choice.kind === "take-remote" ? 1 : 2);
    } finally { s.close(); }
  });

  // The body grammar and its bounds, and the review's shape.
  test(`${adapter}: revise at exactly the body bound resolves and delivers; over, empty, surrogate and frontmatter-shaped bodies keep the journal readable`, async () => {
    const s = await setup(adapter);
    try {
      await contested(s, "refused");
      let review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const mode = (await admitBodyMode(s.backend))!;
      const atBound = "y".repeat(BODY_DELIVERY_LIMITS.bodyBytes);
      const result = await resolveConflict(s.local, s.authority.backend, review, { kind: "revise", body: atBound });
      validateBodyRecord(mode, result.intent!, await s.backend.readMeta(bodyRecordKey(result.intent!.requestId)));
      let status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.lastSync?.ok], [0, 0, true]);
      assert.equal((await s.authority.backend.read("notes/example")).doc.body.trim(), atBound);
      // A multi-byte body one byte over in bytes, though shorter in code units.
      await contested(s, "refused", "again");
      review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const before = await guardOf(s);
      const overInBytes = "é".repeat(BODY_DELIVERY_LIMITS.bodyBytes / 2) + "a";
      assert.ok(overInBytes.length < BODY_DELIVERY_LIMITS.bodyBytes);
      await assert.rejects(resolveConflict(s.local, s.authority.backend, review, { kind: "revise", body: overInBytes }), { name: "BodyRuntimeError" });
      // A non-string body is refused before any target read; an object carrying a function fails the clone before validation.
      for (const body of [null, undefined, ["x"], { toString: () => "x" }, 1n] as unknown[]) {
        await assert.rejects(resolveConflict(s.local, s.authority.backend, review, { kind: "revise", body } as ConflictChoice), (error: Error) => error.name === "BodyRuntimeError" || error.name === "DataCloneError");
      }
      assert.deepEqual(await guardOf(s), before);
      // A lone surrogate, a frontmatter-shaped body and an empty body are strings within the bound; whatever the outcome, the journal stays readable and the body cannot smuggle metadata.
      for (const body of ["lone \uD800 surrogate", "---\ntype: Injected\n---\nsmuggled", ""]) {
        const current = await inspectConflict(s.local, s.authority.backend, "notes/example");
        let resolved = true;
        try { await resolveConflict(s.local, s.authority.backend, current, { kind: "revise", body }); }
        catch (error) { resolved = false; assert.equal((error as Error).name, "BodyRuntimeError", String(error)); }
        await guardOf(s);
        if (!resolved) continue;
        const fresh = (await s.backend.listIntents()).filter(row => row.state !== "acknowledged");
        assert.equal(fresh.length, 1);
        validateBodyRecord(mode, fresh[0]!, await s.backend.readMeta(bodyRecordKey(fresh[0]!.requestId)));
        s.authority.knobs.contentRefusal = true;
        await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
        s.authority.knobs.contentRefusal = false;
        assert.equal((await s.runtime.read("notes/example")).doc.frontmatter.type, "Note", "the body cannot smuggle metadata");
      }
      // Reordered review intents still resolve at the true head.
      await s.runtime.commit("notes/example", { body: "successor" });
      const ordered = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.equal(ordered.intents.length, 2);
      const reordered = { ...ordered, intents: [ordered.intents[1]!, ordered.intents[0]!] };
      const taken = await resolveConflict(s.local, s.authority.backend, reordered, { kind: "take-remote" });
      assert.equal((taken.receipt as { id: string }).id, ordered.intents[0]!.requestId);
      assert.equal((taken.receipt as { chain: { sequence: number }[] }).chain[0]!.sequence, ordered.intents[0]!.sequence);
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
      status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused], [0, 0]);
    } finally { s.close(); }
  });

  // The served document is byte-identical to the working copy's document: take-remote and keep-local both settle it as shared.
  for (const choice of [choices[0], choices[1]]) test(`${adapter}: ${choice.kind} over a served head identical to the working document settles as shared`, async () => {
    const s = await setup(adapter);
    try {
      await contested(s, "refused");
      // The successor reverts the working copy to the served bytes; the chain still heads with the refusal.
      const served = await s.authority.backend.read("notes/example");
      await s.runtime.commit("notes/example", { body: served.doc.body });
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.equal(review.intents.length, 2);
      const result = await resolveConflict(s.local, s.authority.backend, review, choice);
      await guardOf(s);
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.conflicts, status.lastSync?.ok], [0, 0, 0, true]);
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
      if (choice.kind === "keep-local") assert.equal((await s.backend.readIntent(result.intent!.requestId))!.state, "acknowledged");
    } finally { s.close(); }
  });

  // A served head near the envelope bound: every choice either lands whole or refuses with the guard unchanged.
  test(`${adapter}: a served head near the envelope bound lands whole or refuses before mutation`, async () => {
    const s = await setup(adapter);
    try {
      await contested(s, "refused");
      const remote = await s.authority.backend.read("notes/example");
      const overhead = jsonBytes({ version: "sha256:" + "0".repeat(64), raw: "" });
      let landed = false;
      for (const slack of [4096, 256, 64]) {
        const body = "z".repeat(BODY_DELIVERY_LIMITS.envelopeBytes - overhead - 200 - slack);
        await s.authority.backend.write("notes/example", { ...remote.doc, body });
        const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
        const before = await guardOf(s);
        for (const choice of [choices[0], choices[2]]) {
          try { await resolveConflict(s.local, s.authority.backend, review, choice); landed = true; break; }
          catch (error) { assert.equal((error as Error).name, "BodyCapacityError", String(error)); assert.deepEqual(await guardOf(s), before); }
        }
        if (landed) break;
      }
      assert.ok(landed, "a served head within the envelope bound lands");
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.lastSync?.ok], [0, 0, true]);
    } finally { s.close(); }
  });

  // Frontmatter drift: keep-local carries the local frontmatter to a served head whose metadata moved; the authority's metadata wins on acknowledgement.
  for (const choice of [choices[0], choices[2]]) test(`${adapter}: ${choice.kind} over a served head whose frontmatter moved delivers and reconciles to the authority's metadata`, async () => {
    const s = await setup(adapter);
    try {
      await s.runtime.commit("notes/example", { body: "Retain this work" });
      const remote = await s.authority.backend.read("notes/example");
      await s.authority.backend.write("notes/example", { ...remote.doc, frontmatter: { ...remote.doc.frontmatter, title: "Renamed at the authority" }, body: "Concurrent authority edit" });
      await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      assert.equal(review.intents[0]!.state, "conflict");
      const result = await resolveConflict(s.local, s.authority.backend, review, choice);
      const mode = (await admitBodyMode(s.backend))!;
      validateBodyRecord(mode, result.intent!, await s.backend.readMeta(bodyRecordKey(result.intent!.requestId)));
      const base = await s.backend.readMeta<{ version: string; content: string }>("base:notes/example");
      assert.equal(base!.version, review.remote.version);
      assert.match(base!.content, /Renamed at the authority/);
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.conflicts, status.lastSync?.ok], [0, 0, 0, true]);
      const read = await s.runtime.read("notes/example");
      assert.equal(read.provenance.state, "shared-confirmed");
      assert.equal(read.doc.frontmatter.title, "Renamed at the authority");
      assert.equal(read.doc.body.trim(), choice.kind === "revise" ? "Replacement" : "Retain this work");
    } finally { s.close(); }
  });

  // Receipts accumulate per resolution; they stay outside the guard and the capacity budget.
  test(`${adapter}: receipts accumulate across repeated resolutions of one id and stay outside the snapshot guard`, async () => {
    const s = await setup(adapter);
    try {
      const heads: string[] = [];
      for (let round = 0; round < 24; round++) {
        const head = await contested(s, "refused", `Round ${round}`);
        heads.push(head.requestId);
        const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
        await resolveConflict(s.local, s.authority.backend, review, { kind: "take-remote" });
        const guard = await guardOf(s);
        assert.ok(!guard.meta.some(row => row.key.startsWith("conflict-resolution:")), "receipts are not part of the snapshot guard");
      }
      for (const head of heads) assert.equal(validateBodyResolutionReceipt(await s.backend.readMeta(conflictResolutionKey(head))).id, head);
      assert.equal((await s.runtime.read("notes/example")).provenance.state, "shared-confirmed");
    } finally { s.close(); }
  });

  // Pause, edition and resume around a content-refused head.
  test(`${adapter}: a paused store still resolves a content refusal locally, delivers after resume, and resume touches no fresh row`, async () => {
    const s = await setup(adapter);
    try {
      await contested(s, "refused");
      const mode = (await admitBodyMode(s.backend))!;
      await writeBodyControl(s.backend, mode, "sync", { paused: true, reason: "AUTH_REQUIRED: elsewhere", since: "2026-09-15T00:00:00.000Z" });
      assert.equal((await syncStatus(s.local)).paused, true);
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      const result = await resolveConflict(s.local, s.authority.backend, review, { kind: "keep-local" });
      const report = await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
      assert.deepEqual([report.paused, report.settled, s.authority.counts.submitted], [true, [], 1]);
      assert.equal((await resume(s.local)).requeued, 0);
      assert.equal((await s.backend.readIntent(result.intent!.requestId))!.state, "pending");
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.refused, status.paused, status.lastSync?.ok], [0, 0, false, true]);
    } finally { s.close(); }
  });
  test(`${adapter}: an authorization-refused head stays out of recovery when the authority's edition moves; resume keeps its path`, async () => {
    const s = await setup(adapter);
    try {
      await s.runtime.commit("notes/example", { body: "Refused by permission" });
      s.authority.knobs.terminalRefusal = true;
      await s.runtime.sync();
      s.authority.knobs.terminalRefusal = false;
      const head = (await s.backend.listIntents())[0]!;
      await s.backend.updateIntent(head.requestId, "refused", { refusal: { code: "PERMISSION_DENIED", message: "denied" } });
      await s.authority.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n# Moved edition\n");
      const before = await guardOf(s);
      await assert.rejects(inspectConflict(s.local, s.authority.backend, "notes/example"), { name: "InvalidInputError" });
      const forged = { id: "notes/example", local: { version: head.local, content: head.content }, base: { version: head.base, content: head.baseContent }, remote: { version: null, content: null }, intents: [(await s.backend.readIntent(head.requestId))!] };
      for (const choice of choices) await assert.rejects(resolveConflict(s.local, s.authority.backend, forged, choice), { name: "InvalidInputError" });
      assert.deepEqual(await guardOf(s), before);
      assert.equal((await resume(s.local)).requeued, 1);
      const submissions = s.authority.counts.submitted;
      const report = await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
      assert.deepEqual([report.settled.map(row => row.state), s.authority.counts.submitted], [["refused"], submissions], "a recorded refusal is answered by lookup, never resubmitted");
      assert.equal((await s.backend.readIntent(head.requestId))!.refusal!.code, "AUTH_REQUIRED", "the authority's recorded answer replaces the local code");
    } finally { s.close(); }
  });

  // A taken served deletion, then the authority re-creates the id; a list-path pull hydrates it again (the snapshot path is in body-delivery.test.ts).
  test(`${adapter}: a list-path pull re-hydrates an id whose served deletion was taken`, async () => {
    const s = await setup(adapter);
    try {
      const head = await contested(s, "conflict");
      await s.authority.backend.delete("notes/example");
      const review = await inspectConflict(s.local, s.authority.backend, "notes/example");
      await resolveConflict(s.local, s.authority.backend, review, { kind: "take-remote" });
      assert.deepEqual([await s.backend.list(), await s.backend.readMeta("base:notes/example")], [[], undefined]);
      await s.authority.backend.write("notes/example", { id: "notes/example", frontmatter: { type: "Note", title: "Example" }, body: "Re-created" });
      const report = await pull(s.local, s.authority.backend);
      assert.deepEqual(report.refreshed, ["notes/example"]);
      const read = await s.runtime.read("notes/example");
      assert.deepEqual([read.provenance.state, read.doc.body.trim()], ["shared-confirmed", "Re-created"]);
      assert.ok(await s.backend.readMeta(conflictResolutionKey(head.requestId)));
      await s.runtime.commit("notes/example", { body: "After re-creation" });
      const status = await s.runtime.sync();
      assert.deepEqual([status.pending, status.lastSync?.ok], [0, true]);
    } finally { s.close(); }
  });
}
