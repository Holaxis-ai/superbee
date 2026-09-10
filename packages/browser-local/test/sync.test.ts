/**
 * The browser-local sync claim in Node over fake-indexeddb and the disposable remote fixture:
 * local writes journal a durable intent with the record; push settles intents only against a
 * known shared outcome; a changed shared head becomes an explicit conflict that preserves base,
 * local, and remote; lost acknowledgements and pre-apply failures reconcile through request
 * identity without a second application; revocation pauses; two handles cannot double-settle;
 * an interrupted bootstrap never reports complete. The Chromium unit runs the same runtime in
 * a real page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import type { OkfDocument } from "@superbee/core";
import { IntentStateConflict } from "@superbee/core/indexeddb-backend";
import { performUncertainWrite, type OperationTransport } from "@superbee/core/uncertain-write";

import {
  baseKey,
  bootstrap,
  commitLocal,
  isComplete,
  openLocalBundle,
  pull,
  push,
  pushWithRole,
  reclaimInFlight,
  resume,
  settleIntent,
  syncStatus,
  type LocalBundle,
  type SharedBase,
} from "../src/local-bundle.ts";
import { pushRoleName, withPushRole } from "../src/push-role.ts";
import { createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";

const NOW = "2026-09-10T12:00:00.000Z";
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };

function doc(id: string, body: string, extra: Record<string, unknown> = {}): OkfDocument {
  return { id, frontmatter: { type: "Note", title: `Note ${id}`, ...extra }, body };
}

async function seed(fixture: RemoteFixture, ...docs: OkfDocument[]): Promise<void> {
  for (const value of docs) await fixture.authority.write(value.id, value);
}

async function seededFixture(): Promise<RemoteFixture> {
  const fixture = await createRemoteFixture();
  await seed(fixture, doc("notes/alpha", "alpha v1\n"), doc("notes/beta", "beta v1\n"), doc("notes/gamma", "gamma v1\n"));
  return fixture;
}

function openLocal(factory: IDBFactory, name = "working-copy"): LocalBundle {
  return openLocalBundle(name, { indexedDB: factory });
}

/** A body edit through the engine's patch path. */
function edit(body: string): { buildCandidate: (existing: OkfDocument | undefined) => { frontmatter: Record<string, unknown>; body: string }; now: () => string } {
  return {
    buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body }),
    now: () => NOW,
  };
}

const offline: OperationTransport = {
  submit: async () => {
    throw new TypeError("fetch failed: offline");
  },
  lookup: async () => {
    throw new TypeError("fetch failed: offline");
  },
};

test("bootstrap then commitLocal offline: the edit is readable locally with one pending intent carrying the shared base", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    const marker = await bootstrap(fixture.remote, local);
    assert.equal(marker.complete, true);
    assert.equal(marker.documentCount, 3);
    assert.equal(marker.findings, undefined);
    assert.equal(await isComplete(local), true);
    const sharedAlpha = (await fixture.authority.read("notes/alpha")).version;
    assert.equal((await local.backend.read("notes/alpha")).version, sharedAlpha);
    assert.deepEqual((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, sharedAlpha);

    const committed = await commitLocal(local, "notes/alpha", edit("alpha v2 (local)\n"));
    assert.equal(committed.changed, true);
    assert.ok(committed.intent);
    assert.equal(committed.intent.state, "pending");
    assert.equal(committed.intent.base, sharedAlpha);
    assert.equal(committed.intent.local, committed.version);
    assert.equal(committed.intent.attempts, 0);
    assert.equal((await local.backend.read("notes/alpha")).doc.body, "alpha v2 (local)\n");

    // Offline: the transport throws on submit and on lookup; the intent stays pending with one attempt.
    const report = await push(local, offline, { write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["pending"]);
    const status = await syncStatus(local);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.paused, false);
    assert.equal((await local.backend.readIntent(committed.intent.requestId))?.attempts, 1);
    // The authority never saw it.
    assert.equal((await fixture.authority.read("notes/alpha")).doc.body, "alpha v1\n");
  } finally {
    local.close();
  }
});

test("reopening a fresh handle on the same database finds the document, the pending intent, and a complete bootstrap", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const first = openLocal(factory);
  await bootstrap(fixture.remote, first);
  const committed = await commitLocal(first, "notes/beta", edit("beta v2 (local)\n"));
  first.close();

  const second = openLocal(factory);
  try {
    assert.equal(await isComplete(second), true);
    assert.equal((await second.backend.read("notes/beta")).doc.body, "beta v2 (local)\n");
    const pending = await second.backend.listIntents("pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.requestId, committed.intent!.requestId);
    assert.equal(pending[0]!.base, (await fixture.authority.read("notes/beta")).version);
    assert.equal((await syncStatus(second)).counts.pending, 1);
  } finally {
    second.close();
  }
});

test("push acknowledges through a healthy fixture and a second client observes the change after pull", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const one = openLocal(factory, "client-one");
  const two = openLocal(factory, "client-two");
  try {
    await bootstrap(fixture.remote, one);
    await bootstrap(fixture.remote, two);
    const committed = await commitLocal(one, "notes/alpha", edit("alpha v2 from one\n"));
    const report = await push(one, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["acknowledged"]);
    const settled = await one.backend.readIntent(committed.intent!.requestId);
    assert.equal(settled?.state, "acknowledged");
    assert.equal(settled?.acknowledgedVersion, committed.version);
    assert.equal(settled?.finding, undefined);
    assert.equal((await fixture.authority.read("notes/alpha")).version, committed.version);
    assert.deepEqual((await one.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, committed.version);
    assert.equal((await syncStatus(one)).counts.acknowledged, 1);

    const pulled = await pull(two, fixture.remote);
    assert.deepEqual(pulled.refreshed, ["notes/alpha"]);
    assert.deepEqual(pulled.unchanged, ["notes/beta", "notes/gamma"]);
    assert.equal((await two.backend.read("notes/alpha")).doc.body, "alpha v2 from one\n");
    assert.equal((await two.backend.read("notes/alpha")).version, committed.version);
    assert.deepEqual((await two.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, committed.version);
    assert.equal((await syncStatus(two)).lastPull?.refreshed, 1);
  } finally {
    one.close();
    two.close();
  }
});

test("a conflicting remote edit before push yields an explicit conflict with base, local and remote; nothing is overwritten", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const base = (await fixture.authority.read("notes/alpha")).version;
    const committed = await commitLocal(local, "notes/alpha", edit("alpha local edit\n"));
    // Someone else moves the shared head first.
    const remoteVersion = await fixture.authority.write("notes/alpha", doc("notes/alpha", "alpha remote edit\n"), { expectedVersion: base });

    // A pull before push must not replace the base under the pending edit.
    const pulled = await pull(local, fixture.remote);
    assert.deepEqual(pulled.held, ["notes/alpha"]);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, base);

    const report = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["conflict"]);
    const conflict = await local.backend.readIntent(committed.intent!.requestId);
    assert.equal(conflict?.state, "conflict");
    assert.equal(conflict?.base, base);
    assert.match(conflict?.baseContent ?? "", /alpha v1/);
    assert.equal(conflict?.local, committed.version);
    assert.match(conflict?.content ?? "", /alpha local edit/);
    assert.equal(conflict?.remote?.version, remoteVersion);
    assert.match(conflict?.remote?.content ?? "", /alpha remote edit/);
    // Local content untouched, remote untouched, and the base still the original.
    assert.equal((await local.backend.read("notes/alpha")).doc.body, "alpha local edit\n");
    assert.equal((await fixture.authority.read("notes/alpha")).version, remoteVersion);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0]!.status, 412);
    assert.equal((await syncStatus(local)).counts.conflict, 1);
  } finally {
    local.close();
  }
});

test("lost acknowledgement: the fixture applies then drops the response; lookup finds committed and nothing is applied twice", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/gamma", edit("gamma v2\n"));
    fixture.knobs.dropAfterApply = true;

    // The primitive alone: the submission is unknown, the lookup settles it, no resubmission.
    const claimed = await local.backend.updateIntent(committed.intent!.requestId, "pending", { state: "in_flight" });
    const result = await performUncertainWrite(fixture.transport, claimed, immediate);
    assert.deepEqual(result.outcome, { kind: "committed", version: committed.version });
    assert.equal(result.lookups, 1);
    assert.equal(result.intent.attempts, 1);
    assert.equal(fixture.history.length, 1);
    assert.deepEqual(fixture.deduplicated, []);

    const settled = await settleIntent(local, claimed.requestId, result.outcome, result.intent.attempts);
    assert.equal(settled.state, "acknowledged");
    assert.equal((await fixture.authority.read("notes/gamma")).version, committed.version);
    assert.equal((await fixture.authority.versions("notes/gamma")).length, 2);
  } finally {
    local.close();
  }
});

test("network failure before apply: lookup returns null and a resubmission with the same requestId succeeds once", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/beta", edit("beta v2\n"));
    const requestId = committed.intent!.requestId;
    fixture.knobs.failBeforeApply = true;

    // First push: submission fails before apply, lookup says null, the bounded resubmission fails
    // the same way, and the intent returns to pending with its attempts recorded.
    const first = await push(local, fixture.transport, { write: { ...immediate, maxSubmissions: 1 } });
    assert.deepEqual(first.settled.map((row) => row.state), ["pending"]);
    assert.equal((await local.backend.readIntent(requestId))?.attempts, 1);
    assert.equal(fixture.history.length, 0);

    // Network back: the next push starts with a lookup (null), then resubmits the SAME identity.
    fixture.knobs.failBeforeApply = false;
    const second = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(second.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0]!.requestId, requestId);
    assert.equal((await local.backend.readIntent(requestId))?.attempts, 2);
    assert.equal((await fixture.authority.read("notes/beta")).version, committed.version);

    // A duplicate delivery of the same identity is answered from the record, not applied again.
    const replayed = await fixture.transport.submit({ ...committed.intent!, attempts: 3, state: "in_flight" });
    assert.deepEqual(replayed, { kind: "committed", version: committed.version });
    assert.equal(fixture.history.length, 1);
    assert.deepEqual(fixture.deduplicated, [requestId]);
  } finally {
    local.close();
  }
});

test("revocation: a 401 marks the intent refused and pauses; later local commits still journal; push does nothing while paused", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const first = await commitLocal(local, "notes/alpha", edit("alpha after revocation\n"));
    fixture.knobs.unauthorized = true;
    const report = await push(local, fixture.transport, { write: immediate });
    assert.equal(report.paused, true);
    assert.deepEqual(report.settled.map((row) => row.state), ["refused"]);
    const refused = await local.backend.readIntent(first.intent!.requestId);
    assert.equal(refused?.state, "refused");
    assert.equal(refused?.refusal?.code, "AUTH_REQUIRED");
    let status = await syncStatus(local);
    assert.equal(status.paused, true);
    assert.match(status.pausedReason ?? "", /AUTH_REQUIRED/);

    // Local work continues: the edit persists with an intent; the refused predecessor is superseded
    // (the authority definitely did not apply it), so one pending intent carries the original base.
    const second = await commitLocal(local, "notes/alpha", edit("alpha still editing\n"));
    assert.ok(second.intent);
    assert.equal(second.intent.state, "pending");
    assert.equal(second.intent.base, refused?.base);
    assert.equal(await local.backend.readIntent(first.intent!.requestId), undefined);
    assert.equal((await local.backend.read("notes/alpha")).doc.body, "alpha still editing\n");
    status = await syncStatus(local);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.refused, 0);

    // Paused: no pushes reach the fixture even when the credential is back.
    fixture.knobs.unauthorized = false;
    const paused = await push(local, fixture.transport, { write: immediate });
    assert.equal(paused.paused, true);
    assert.deepEqual(paused.settled, []);
    assert.equal(fixture.history.length, 0);

    // An explicit resume delivers the pending intent.
    await resume(local);
    const resumed = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(resumed.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal((await fixture.authority.read("notes/alpha")).doc.body, "alpha still editing\n");
  } finally {
    local.close();
  }
});

test("stale tab: two handles on one store both try to settle one intent; exactly one succeeds, the other does not double-apply", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const tabA = openLocal(factory);
  const tabB = openLocal(factory);
  try {
    await bootstrap(fixture.remote, tabA);
    const committed = await commitLocal(tabA, "notes/gamma", edit("gamma from tab A\n"));
    const requestId = committed.intent!.requestId;
    // Tab A claims and delivers.
    const claimed = await tabA.backend.updateIntent(requestId, "pending", { state: "in_flight" });
    const result = await performUncertainWrite(fixture.transport, claimed, immediate);
    assert.equal(result.outcome.kind, "committed");
    // Both tabs try to settle with the same outcome.
    const settles = await Promise.allSettled([
      settleIntent(tabA, requestId, result.outcome, result.intent.attempts),
      settleIntent(tabB, requestId, result.outcome, result.intent.attempts),
    ]);
    const wins = settles.filter((entry) => entry.status === "fulfilled");
    const losses = settles.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.ok(losses[0]!.reason instanceof IntentStateConflict);
    assert.equal(losses[0]!.reason.actual, "acknowledged");
    assert.equal((await tabB.backend.readIntent(requestId))?.state, "acknowledged");
    assert.equal(fixture.history.length, 1);

    // The stale tab's push finds nothing pending and never re-delivers.
    const stale = await push(tabB, fixture.transport, { write: immediate });
    assert.deepEqual(stale.settled, []);
    assert.equal(fixture.history.length, 1);
    // And a concurrent claim race is decided the same way: one claims, one is skipped.
    const again = await commitLocal(tabA, "notes/gamma", edit("gamma again\n"));
    const [pushA, pushB] = await Promise.all([
      push(tabA, fixture.transport, { write: immediate }),
      push(tabB, fixture.transport, { write: immediate }),
    ]);
    const settledStates = [...pushA.settled, ...pushB.settled].map((row) => row.state);
    assert.deepEqual(settledStates, ["acknowledged"]);
    assert.deepEqual([...pushA.skipped, ...pushB.skipped].map((row) => row.reason), ["claimed-elsewhere"]);
    assert.equal(fixture.history.length, 2);
    assert.equal((await fixture.authority.read("notes/gamma")).version, again.version);
  } finally {
    tabA.close();
    tabB.close();
  }
});

test("compose-per-id: a second local edit before delivery supersedes the first intent but keeps the original base; an edit during flight stays pending", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const base = (await fixture.authority.read("notes/alpha")).version;
    const first = await commitLocal(local, "notes/alpha", edit("alpha edit one\n"));
    const second = await commitLocal(local, "notes/alpha", edit("alpha edit two\n"));
    assert.notEqual(second.intent!.requestId, first.intent!.requestId);
    assert.equal(second.intent!.base, base);
    assert.equal(second.intent!.after, undefined);
    assert.equal(await local.backend.readIntent(first.intent!.requestId), undefined);
    assert.equal((await local.backend.listIntents("pending")).length, 1);

    // The second intent goes in flight; a third edit lands while it is out.
    const claimed = await local.backend.updateIntent(second.intent!.requestId, "pending", { state: "in_flight" });
    const third = await commitLocal(local, "notes/alpha", edit("alpha edit three\n"));
    assert.equal(third.intent!.after, second.intent!.requestId);
    assert.equal(third.intent!.base, second.version);
    assert.equal((await local.backend.readIntent(second.intent!.requestId))?.state, "in_flight");

    // The earlier acknowledgement settles only its own record; the third edit remains pending.
    const result = await performUncertainWrite(fixture.transport, claimed, immediate);
    await settleIntent(local, claimed.requestId, result.outcome, result.intent.attempts);
    let status = await syncStatus(local);
    assert.equal(status.counts.acknowledged, 1);
    assert.equal(status.counts.pending, 1);
    assert.equal((await local.backend.read("notes/alpha")).doc.body, "alpha edit three\n");

    // Push delivers the chained edit with If-Match on the acknowledged version.
    const report = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal((await fixture.authority.read("notes/alpha")).doc.body, "alpha edit three\n");
    status = await syncStatus(local);
    assert.equal(status.counts.pending, 0);
    assert.equal(status.counts.acknowledged, 2);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, third.version);
  } finally {
    local.close();
  }
});

test("an interrupted bootstrap never reports complete, and a partial working copy is not an empty complete bundle", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await assert.rejects(
      bootstrap(fixture.remote, local, {
        onHydrated: (_id, index) => {
          if (index === 1) throw new Error("tab closed mid-hydrate");
        },
      }),
      /tab closed mid-hydrate/,
    );
    assert.equal(await isComplete(local), false);
    const status = await syncStatus(local);
    assert.equal(status.bootstrapComplete, false);
    assert.equal(status.generation, 1);
    // Partial state is visible as partial: two of three documents landed, and the marker says so.
    assert.equal((await local.backend.list()).length, 2);
    const marker = await local.backend.readMeta<{ complete: boolean; completedAt?: string }>("bootstrap");
    assert.equal(marker?.complete, false);
    assert.equal(marker?.completedAt, undefined);

    // A fresh handle sees the same incomplete answer, and a completed bootstrap repairs it.
    local.close();
    const reopened = openLocal(factory);
    try {
      assert.equal(await isComplete(reopened), false);
      const marker2 = await bootstrap(fixture.remote, reopened);
      assert.equal(marker2.generation, 2);
      assert.equal(await isComplete(reopened), true);
      assert.equal((await reopened.backend.list()).length, 3);
    } finally {
      reopened.close();
    }
  } finally {
    local.close();
  }
});

test("bootstrap refuses to discard unsettled intents", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    await commitLocal(local, "notes/beta", edit("beta unsent\n"));
    await assert.rejects(bootstrap(fixture.remote, local), /unsettled intent/);
    assert.equal((await local.backend.read("notes/beta")).doc.body, "beta unsent\n");
    assert.equal(await isComplete(local), true);
  } finally {
    local.close();
  }
});

test("push role in Node: the in-process fallback admits one holder per name, releases on settle, and pushWithRole reports the other side", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory, "role-store");
  try {
    await bootstrap(fixture.remote, local);
    await commitLocal(local, "notes/alpha", edit("alpha under the role\n"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withPushRole(pushRoleName("role-store"), async () => {
      await gate;
      return "done";
    });
    const contender = await pushWithRole(local, fixture.transport, { write: immediate });
    assert.deepEqual(contender, { held: false, reason: "held-elsewhere" });
    assert.equal(fixture.history.length, 0);
    // A different store's role is independent.
    assert.deepEqual(await withPushRole(pushRoleName("another-store"), async () => 1), { held: true, result: 1 });
    release();
    assert.deepEqual(await holder, { held: true, result: "done" });
    const delivered = await pushWithRole(local, fixture.transport, { write: immediate });
    assert.equal(delivered.held, true);
    assert.deepEqual(delivered.held && delivered.result.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal(fixture.history.length, 1);
    // A rejecting body still releases the role.
    await assert.rejects(withPushRole(pushRoleName("role-store"), async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal((await withPushRole(pushRoleName("role-store"), async () => true)).held, true);
  } finally {
    local.close();
  }
});

test("reclaimInFlight marks a reclaimed intent as attempted, so the next push looks the request up before resubmitting", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/beta", edit("beta from a dead realm\n"));
    const requestId = committed.intent!.requestId;
    // The dead realm claimed and delivered, and the authority applied it; nobody settled.
    const claimed = await local.backend.updateIntent(requestId, "pending", { state: "in_flight" });
    await fixture.transport.submit({ ...claimed, attempts: 1 });
    assert.equal(fixture.history.length, 1);

    assert.equal(await reclaimInFlight(local), 1);
    const reclaimed = await local.backend.readIntent(requestId);
    assert.equal(reclaimed?.state, "pending");
    assert.equal(reclaimed?.attempts, 1);
    const report = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["acknowledged"]);
    // Settled by lookup: the authority saw no second submission, deduplicated or otherwise.
    assert.equal(fixture.history.length, 1);
    assert.deepEqual(fixture.deduplicated, []);
    assert.equal((await local.backend.readIntent(requestId))?.acknowledgedVersion, committed.version);
    assert.equal(await reclaimInFlight(local), 0);
  } finally {
    local.close();
  }
});
