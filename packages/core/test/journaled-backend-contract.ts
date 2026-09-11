/**
 * Journal rows of the adapter contract kit: what any {@link JournaledBackend} must do beyond
 * `StorageBackend` for the browser-local sync runtime to run over it. The rows state the seam's
 * transaction and compare-and-swap promises once, adapter-agnostically; an adapter's own suite
 * attacks the mechanics behind them (an aborted IndexedDB transaction, a schema refusal).
 *
 * The kit is module-graph neutral: it imports the seam only as types and takes the seam's error
 * classes from the fixture (`seam`), so the same rows run in core over `src` and in a consumer
 * package over the built `dist`, each against the class identities its adapter throws.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { IntentHoldConflict, IntentStateConflict, JournaledBackend, JournaledReadResult, NewIntentRecord } from "../src/journaled-backend.js";
import type { OkfDocument, Version } from "../src/types.js";
import type { OperationState } from "../src/uncertain-write.js";
import type { VersionConflict } from "../src/versioning.js";

export interface JournaledBackendFixture {
  backend: JournaledBackend;
  cleanup(): Promise<void>;
}

/** The seam's error classes as the fixture's module graph resolves them. */
export interface JournaledSeam {
  IntentStateConflict: typeof IntentStateConflict;
  IntentHoldConflict: typeof IntentHoldConflict;
  VersionConflict: typeof VersionConflict;
}

export interface JournaledBackendContractOptions {
  name: string;
  create(): Promise<JournaledBackendFixture> | JournaledBackendFixture;
  seam: JournaledSeam;
}

const TIMESTAMP = "2026-09-10T00:00:00.000Z";
const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Journal contract\n";
const STALE: Version = "sha256:" + "0".repeat(64);
const UNSETTLED: readonly OperationState[] = ["pending", "in_flight", "conflict", "refused", "unknown"];

function doc(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "JournalFixture", timestamp: TIMESTAMP }, body };
}

function newIntent(requestId: string, target: string, base: Version | null, after?: string): NewIntentRecord {
  return { requestId, kind: "document.write", target, base, baseContent: null, createdAt: TIMESTAMP, ...(after === undefined ? {} : { after }) };
}

async function withFixture(create: JournaledBackendContractOptions["create"], run: (backend: JournaledBackend) => Promise<void>): Promise<void> {
  const fixture = await create();
  try {
    await fixture.backend.writeReserved("", "index.md", ROOT_INDEX);
    await run(fixture.backend);
  } finally {
    await fixture.cleanup();
  }
}

export function registerJournaledBackendContract(options: JournaledBackendContractOptions): void {
  const { name, create, seam } = options;

  test(`${name} journal contract: a journaled write records the document, its intent, and its meta rows together, and a failed document CAS records none of them`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/atomic";
      const base = `base:${id}`;
      const first = await backend.writeJournaled(id, doc(id, "v1"), {
        expectedVersion: null,
        intent: newIntent("req-1", id, null),
        meta: ({ version, raw }) => [{ key: base, value: { version, content: raw } }],
      });
      assert.ok(first.intent, "the write reports the intent it recorded");
      assert.equal(first.intent.requestId, "req-1");
      assert.equal(first.intent.state, "pending");
      assert.equal(first.intent.attempts, 0);
      assert.equal(first.intent.local, first.version, "the intent's local version is the written bytes' version");
      assert.equal(first.intent.content, first.raw, "the intent carries the written bytes");
      assert.equal(first.intent.sequence, 1);
      assert.equal((await backend.read(id)).version, first.version);
      assert.equal((await backend.read(id)).doc.body.trimEnd(), "v1");
      assert.deepEqual((await backend.listIntents("pending")).map((row) => row.requestId), ["req-1"]);
      assert.deepEqual(await backend.readMeta(base), { version: first.version, content: first.raw }, "the meta function saw the written bytes");

      // A failed document CAS records no intent and no meta row, and consumes no sequence number.
      await assert.rejects(
        backend.writeJournaled(id, doc(id, "stale"), { expectedVersion: STALE, intent: newIntent("req-stale", id, null), meta: [{ key: "never", value: 1 }] }),
        (error: unknown) => {
          assert.ok(error instanceof seam.VersionConflict);
          assert.equal(error.expected, STALE);
          assert.equal(error.actual, first.version);
          return true;
        },
      );
      assert.equal((await backend.read(id)).version, first.version);
      assert.equal(await backend.readIntent("req-stale"), undefined);
      assert.equal(await backend.readMeta("never"), undefined);
      const second = await backend.writeJournaled(id, doc(id, "v2"), { expectedVersion: first.version, intent: newIntent("req-2", id, first.version) });
      assert.equal(second.intent?.sequence, 2, "the sequence advances only for a write that commits");

      // Without an intent the write is the plain document CAS plus meta; the journal is untouched.
      const plain = await backend.writeJournaled(id, doc(id, "v3"), { expectedVersion: second.version, meta: [{ key: "plain", value: true }] });
      assert.equal(plain.intent, null);
      assert.equal(await backend.readMeta("plain"), true);
      assert.deepEqual((await backend.listIntents()).map((row) => row.requestId), ["req-1", "req-2"]);
    });
  });

  test(`${name} journal contract: superseding an intent is a compare-and-swap on its state and attempts, and a failed supersede leaves the document unwritten`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/supersede";
      const { version } = await backend.writeJournaled(id, doc(id, "first edit"), { expectedVersion: null, intent: newIntent("req-1", id, null) });
      await backend.updateIntent("req-1", "pending", { state: "in_flight", attempts: 1 });

      // State moved: the whole write fails, so the document keeps its bytes and no new intent exists.
      await assert.rejects(
        backend.writeJournaled(id, doc(id, "composed"), {
          expectedVersion: version,
          intent: newIntent("req-2", id, null),
          supersede: { requestId: "req-1", expectedState: "pending", expectedAttempts: 0 },
          meta: [{ key: "never", value: 1 }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof seam.IntentStateConflict);
          assert.equal(error.requestId, "req-1");
          assert.equal(error.expected, "pending");
          assert.equal(error.actual, "in_flight");
          return true;
        },
      );
      assert.equal((await backend.read(id)).version, version);
      assert.equal(await backend.readIntent("req-2"), undefined);
      assert.equal((await backend.readIntent("req-1"))?.state, "in_flight");
      assert.equal(await backend.readMeta("never"), undefined);

      // Attempts moved while the state matches: the same refusal.
      await backend.updateIntent("req-1", "in_flight", { state: "pending", attempts: 1 });
      await assert.rejects(
        backend.writeJournaled(id, doc(id, "composed"), {
          expectedVersion: version,
          intent: newIntent("req-2", id, null),
          supersede: { requestId: "req-1", expectedState: "pending", expectedAttempts: 0 },
        }),
        (error: unknown) => error instanceof seam.IntentStateConflict,
      );
      assert.equal((await backend.read(id)).version, version);
      assert.equal(await backend.readIntent("req-2"), undefined);

      // A missing intent is a conflict with no actual state.
      await assert.rejects(
        backend.writeJournaled(id, doc(id, "composed"), {
          expectedVersion: version,
          intent: newIntent("req-2", id, null),
          supersede: { requestId: "req-gone", expectedState: "pending", expectedAttempts: 0 },
        }),
        (error: unknown) => error instanceof seam.IntentStateConflict && error.actual === null,
      );

      // With matching state and attempts the old intent is deleted and the new one recorded, in one write.
      await backend.updateIntent("req-1", "pending", { attempts: 0 });
      const composed = await backend.writeJournaled(id, doc(id, "composed"), {
        expectedVersion: version,
        intent: newIntent("req-2", id, null),
        supersede: { requestId: "req-1", expectedState: "pending", expectedAttempts: 0 },
      });
      assert.equal(composed.intent?.requestId, "req-2");
      assert.equal(await backend.readIntent("req-1"), undefined);
      assert.deepEqual((await backend.listIntents()).map((row) => row.requestId), ["req-2"]);
      assert.equal((await backend.read(id)).version, composed.version);
    });
  });

  test(`${name} journal contract: requireSettled refuses a write while an unsettled intent holds the target, and only then`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/held";
      const other = "journal/other";
      const base = `base:${id}`;
      const { version } = await backend.writeJournaled(id, doc(id, "local edit"), { expectedVersion: null, intent: newIntent("req-hold", id, null) });
      await backend.writeJournaled(other, doc(other, "other edit"), { expectedVersion: null, intent: newIntent("req-other", other, null) });
      await backend.writeMeta(base, { version: null, content: null });

      for (const state of UNSETTLED) {
        const previous = (await backend.readIntent("req-hold"))!.state;
        await backend.updateIntent("req-hold", previous, { state });
        await assert.rejects(
          backend.writeJournaled(id, doc(id, "refresh"), { requireSettled: true, meta: [{ key: base, value: { version: STALE, content: "refresh" } }] }),
          (error: unknown) => {
            assert.ok(error instanceof seam.IntentHoldConflict);
            assert.equal(error.target, id);
            assert.equal(error.requestId, "req-hold");
            assert.equal(error.state, state);
            return true;
          },
        );
        assert.equal((await backend.read(id)).version, version, "the held document keeps its bytes");
        assert.deepEqual(await backend.readMeta(base), { version: null, content: null }, "the refused write put no meta row");
      }

      // An acknowledged intent does not hold; the hold is per target.
      await backend.updateIntent("req-hold", "unknown", { state: "acknowledged" });
      const refreshed = await backend.writeJournaled(id, doc(id, "refresh"), { requireSettled: true, meta: [{ key: base, value: { version: STALE, content: "refresh" } }] });
      assert.equal((await backend.read(id)).version, refreshed.version);
      assert.deepEqual(await backend.readMeta(base), { version: STALE, content: "refresh" });
      assert.equal((await backend.readIntent("req-other"))?.state, "pending");

      // Without the option the write is the plain journaled CAS, hold or not.
      await backend.updateIntent("req-other", "pending", { state: "in_flight" });
      await backend.writeJournaled(other, doc(other, "overwritten"), {});
      assert.equal((await backend.read(other)).doc.body.trimEnd(), "overwritten");
    });
  });

  test(`${name} journal contract: a journaled delete removes the document with its meta changes in one operation, is refused while an unsettled intent holds the target, is a compare-and-swap on the version, and answers absence with false`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/deleted";
      const base = `base:${id}`;
      const { version } = await backend.writeJournaled(id, doc(id, "shared"), { expectedVersion: null, meta: [{ key: base, value: { version: "shared-1", content: null } }] });

      // A stale premise refuses the whole operation: the document, its base, and the offered meta are untouched.
      await assert.rejects(
        backend.deleteJournaled(id, { expectedVersion: STALE, removeMeta: [base], meta: [{ key: "never", value: 1 }] }),
        (error: unknown) => {
          assert.ok(error instanceof seam.VersionConflict);
          assert.equal(error.expected, STALE);
          assert.equal(error.actual, version);
          return true;
        },
      );
      assert.equal((await backend.read(id)).version, version);
      assert.deepEqual(await backend.readMeta(base), { version: "shared-1", content: null });
      assert.equal(await backend.readMeta("never"), undefined);

      // An unsettled intent holds the target against a settled-only deletion, in every unsettled state.
      const held = await backend.writeJournaled(id, doc(id, "local edit"), { expectedVersion: version, intent: newIntent("req-hold", id, version) });
      for (const state of UNSETTLED) {
        const previous = (await backend.readIntent("req-hold"))!.state;
        await backend.updateIntent("req-hold", previous, { state });
        await assert.rejects(
          backend.deleteJournaled(id, { requireSettled: true, removeMeta: [base] }),
          (error: unknown) => {
            assert.ok(error instanceof seam.IntentHoldConflict);
            assert.equal(error.target, id);
            assert.equal(error.requestId, "req-hold");
            assert.equal(error.state, state);
            return true;
          },
        );
        assert.equal((await backend.read(id)).version, held.version, "the held document keeps its bytes");
        assert.deepEqual(await backend.readMeta(base), { version: "shared-1", content: null }, "the refused delete removed no meta row");
      }

      // Acknowledged, the intent does not hold: the record, its base row, and the offered meta change together.
      await backend.updateIntent("req-hold", "unknown", { state: "acknowledged" });
      assert.equal(await backend.deleteJournaled(id, { expectedVersion: held.version, requireSettled: true, removeMeta: [base], meta: [{ key: "pull", value: { deleted: [id] } }] }), true);
      await assert.rejects(backend.read(id), (error: unknown) => (error as { code?: unknown }).code === "ENOENT");
      assert.equal(await backend.exists(id), false);
      assert.equal(await backend.readMeta(base), undefined);
      assert.deepEqual(await backend.readMeta("pull"), { deleted: [id] });
      assert.deepEqual((await backend.listIntents()).map((row) => row.requestId), ["req-hold"], "the journal keeps its acknowledged record");

      // Absence is a normal result, even under a premise: false, with the meta changes still applied.
      assert.equal(await backend.deleteJournaled(id, { expectedVersion: held.version, requireSettled: true, meta: [{ key: "again", value: true }], removeMeta: ["pull"] }), false);
      assert.equal(await backend.readMeta("again"), true);
      assert.equal(await backend.readMeta("pull"), undefined);
    });
  });

  test(`${name} journal contract: updateIntent is a compare-and-swap on state that two callers cannot both win, and its meta rows ride the same write`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/settle";
      const base = `base:${id}`;
      const written = await backend.writeJournaled(id, doc(id, "edit"), { expectedVersion: null, intent: newIntent("req-race", id, null) });
      const claimed = await backend.updateIntent("req-race", "pending", { state: "in_flight", attempts: 1 });
      assert.equal(claimed.requestId, "req-race");
      assert.equal(claimed.sequence, written.intent!.sequence, "the patch cannot move the sequence");
      assert.equal(claimed.state, "in_flight");
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.createdAt, TIMESTAMP);

      // Wrong state: nothing changes, not even the meta rows offered with the patch.
      await assert.rejects(
        backend.updateIntent("req-race", "pending", { state: "acknowledged" }, { meta: [{ key: base, value: "never" }] }),
        (error: unknown) => {
          assert.ok(error instanceof seam.IntentStateConflict);
          assert.equal(error.expected, "pending");
          assert.equal(error.actual, "in_flight");
          return true;
        },
      );
      assert.equal((await backend.readIntent("req-race"))?.state, "in_flight");
      assert.equal(await backend.readMeta(base), undefined);

      // Two concurrent settlements of one in-flight intent: exactly one wins, and only the
      // winner's meta row lands.
      const results = await Promise.allSettled(
        [0, 1].map((index) =>
          backend.updateIntent(
            "req-race",
            "in_flight",
            { state: "acknowledged", acknowledgedVersion: `sha256:${String(index).repeat(64)}` },
            { meta: [{ key: base, value: { peer: index } }] },
          ),
        ),
      );
      const wins = results.filter((r) => r.status === "fulfilled");
      const losses = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(wins.length, 1);
      assert.equal(losses.length, 1);
      assert.ok(losses[0]!.reason instanceof seam.IntentStateConflict);
      assert.equal(losses[0]!.reason.actual, "acknowledged");
      const winner = results.findIndex((r) => r.status === "fulfilled");
      const settled = await backend.readIntent("req-race");
      assert.equal(settled?.state, "acknowledged");
      assert.equal(settled?.acknowledgedVersion, `sha256:${String(winner).repeat(64)}`);
      assert.deepEqual(await backend.readMeta(base), { peer: winner });

      // A missing intent is the same refusal, with no actual state.
      await assert.rejects(backend.updateIntent("req-missing", "pending", { state: "in_flight" }), (error: unknown) => {
        assert.ok(error instanceof seam.IntentStateConflict);
        assert.equal(error.requestId, "req-missing");
        assert.equal(error.actual, null);
        return true;
      });
    });
  });

  test(`${name} journal contract: readWithJournal is one snapshot of the document, its intents, and the named meta rows, consistent under a concurrent journaled write`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/snapshot";
      const base = `base:${id}`;
      assert.deepEqual(await backend.readWithJournal(id, { meta: [base] }), { document: null, raw: null, intents: [], meta: new Map() });

      const first = await backend.writeJournaled(id, doc(id, "v1"), { expectedVersion: null, meta: [{ key: base, value: { version: "shared-1", content: null } }] });
      const snapshot = await backend.readWithJournal(id, { meta: [base, "absent:key"] });
      assert.equal(snapshot.document?.version, first.version);
      assert.equal(snapshot.document?.doc.id, id);
      assert.equal(snapshot.document?.doc.body.trimEnd(), "v1");
      assert.equal(snapshot.raw, first.raw, "raw is the exact serialization the version names");
      assert.deepEqual(snapshot.intents, []);
      assert.deepEqual([...snapshot.meta.entries()], [[base, { version: "shared-1", content: null }]], "an absent key has no entry");

      const consistent = (snap: JournaledReadResult, after: { version: Version } | null): "before" | "after" => {
        if (after && snap.document?.version === after.version) {
          assert.equal(snap.intents.length, 1, "after the write, the intent is in the snapshot");
          assert.equal(snap.intents[0]!.local, after.version);
          assert.deepEqual(snap.meta.get(base), { version: "shared-2", content: null });
          return "after";
        }
        assert.equal(snap.document?.version, first.version);
        assert.deepEqual(snap.intents, [], "before the write, no intent");
        assert.deepEqual(snap.meta.get(base), { version: "shared-1", content: null });
        return "before";
      };
      const readFirst = backend.readWithJournal(id, { meta: [base] });
      const write = backend.writeJournaled(id, doc(id, "v2"), {
        expectedVersion: first.version,
        intent: newIntent("req-snapshot", id, "shared-1"),
        meta: [{ key: base, value: { version: "shared-2", content: null } }],
      });
      const readSecond = backend.readWithJournal(id, { meta: [base] });
      const [early, written, late] = await Promise.all([readFirst, write, readSecond]);
      const moments = [consistent(early, written), consistent(late, written)];
      assert.ok(!(moments[0] === "after" && moments[1] === "before"), "a snapshot started after the write cannot predate one started before it");
      assert.equal(consistent(await backend.readWithJournal(id, { meta: [base] }), written), "after");

      // Every intent for the id, whatever its state, in local commit order; other targets excluded.
      await backend.updateIntent("req-snapshot", "pending", { state: "acknowledged" });
      const third = await backend.writeJournaled(id, doc(id, "v3"), { expectedVersion: written.version, intent: newIntent("req-later", id, written.version, "req-snapshot") });
      await backend.writeJournaled("journal/elsewhere", doc("journal/elsewhere", "x"), { expectedVersion: null, intent: newIntent("req-elsewhere", "journal/elsewhere", null) });
      const full = await backend.readWithJournal(id);
      assert.deepEqual(full.intents.map((row) => [row.requestId, row.state, row.after ?? null]), [["req-snapshot", "acknowledged", null], ["req-later", "pending", "req-snapshot"]]);
      assert.equal(full.raw, third.raw);
      assert.deepEqual(full.meta, new Map(), "no keys asked, no rows");
    });
  });

  test(`${name} journal contract: listIntents orders by sequence and filters by one state or several; readIntent finds one record or nothing`, async () => {
    await withFixture(create, async (backend) => {
      const ids = ["journal/c", "journal/a", "journal/b"];
      for (const [index, id] of ids.entries()) {
        await backend.writeJournaled(id, doc(id, `edit ${index}`), { expectedVersion: null, intent: newIntent(`req-${index}`, id, null) });
      }
      const all = await backend.listIntents();
      assert.deepEqual(all.map((row) => row.requestId), ["req-0", "req-1", "req-2"], "commit order, not key order");
      assert.deepEqual(all.map((row) => row.sequence), [1, 2, 3]);
      assert.deepEqual(all.map((row) => row.target), ids);

      await backend.updateIntent("req-1", "pending", { state: "in_flight", attempts: 1 });
      await backend.updateIntent("req-2", "pending", { state: "conflict" });
      assert.deepEqual((await backend.listIntents("pending")).map((row) => row.requestId), ["req-0"]);
      assert.deepEqual((await backend.listIntents(["in_flight", "conflict"])).map((row) => row.requestId), ["req-1", "req-2"]);
      assert.deepEqual((await backend.listIntents(["conflict", "in_flight"])).map((row) => row.requestId), ["req-1", "req-2"], "order is by sequence whatever the filter order");
      assert.deepEqual(await backend.listIntents("acknowledged"), []);
      assert.deepEqual(await backend.listIntents([]), []);

      const one = await backend.readIntent("req-1");
      assert.equal(one?.requestId, "req-1");
      assert.equal(one?.state, "in_flight");
      assert.equal(one?.attempts, 1);
      assert.equal(await backend.readIntent("req-none"), undefined);

      // A record read back is the caller's copy: mutating it changes nothing in the journal.
      one!.state = "acknowledged";
      assert.equal((await backend.readIntent("req-1"))?.state, "in_flight");
    });
  });

  test(`${name} journal contract: meta rows round-trip as opaque values`, async () => {
    await withFixture(create, async (backend) => {
      assert.equal(await backend.readMeta("absent"), undefined);
      await backend.writeMeta("flag", true);
      assert.equal(await backend.readMeta("flag"), true);
      const marker = { generation: 1, complete: false, held: ["journal/a"] };
      await backend.writeMeta("bootstrap", marker);
      assert.deepEqual(await backend.readMeta("bootstrap"), marker);
      // The store holds the value as written, not a live reference to the caller's object.
      marker.complete = true;
      assert.deepEqual(await backend.readMeta("bootstrap"), { generation: 1, complete: false, held: ["journal/a"] });
      await backend.writeMeta("bootstrap", { generation: 2, complete: true });
      assert.deepEqual(await backend.readMeta("bootstrap"), { generation: 2, complete: true });
      await backend.writeMeta("nothing", null);
      assert.equal(await backend.readMeta("nothing"), null, "a null value is a row, not an absent one");
    });
  });

  test(`${name} journal contract: the refusals are the seam's own error classes`, async () => {
    await withFixture(create, async (backend) => {
      const id = "journal/errors";
      await backend.writeJournaled(id, doc(id, "edit"), { expectedVersion: null, intent: newIntent("req-1", id, null) });

      const hold = await backend.writeJournaled(id, doc(id, "refresh"), { requireSettled: true }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(hold instanceof seam.IntentHoldConflict);
      assert.ok(hold instanceof Error);
      assert.equal(hold.name, "IntentHoldConflict");
      assert.deepEqual({ target: hold.target, requestId: hold.requestId, state: hold.state }, { target: id, requestId: "req-1", state: "pending" });

      const state = await backend.updateIntent("req-1", "acknowledged", { state: "pending" }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(state instanceof seam.IntentStateConflict);
      assert.ok(state instanceof Error);
      assert.equal(state.name, "IntentStateConflict");
      assert.deepEqual({ requestId: state.requestId, expected: state.expected, actual: state.actual }, { requestId: "req-1", expected: "acknowledged", actual: "pending" });
    });
  });
}
