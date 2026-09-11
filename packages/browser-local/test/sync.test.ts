/**
 * The browser-local sync claim in Node over fake-indexeddb and the disposable remote fixture:
 * local writes journal a durable intent with the record; push settles intents only against a
 * known shared outcome; a changed shared head becomes an explicit conflict that preserves base,
 * local, and remote; lost acknowledgements and pre-apply failures reconcile through request
 * identity without a second application; revocation pauses and resume redelivers what it
 * refused; two handles cannot double-settle; an interrupted bootstrap never reports complete;
 * an edit committed while pull or bootstrap is fetching is held inside the refreshing write's
 * own transaction; a crash between claim and settlement leaves a possibly-delivered record that
 * a later edit chains behind; a deadline shorter than the authority's latency still applies the
 * write exactly once; bootstrap and pull fetch their batches concurrently, producing the same
 * working copy as one batch at a time in a fraction of the wall time, and a failed batch leaves
 * the marker incomplete with nothing left in flight. Over a wire authority that reports them,
 * bootstrap hydrates from one streamed snapshot (byte-identical to the list path, with the
 * digest on the marker; a cut snapshot leaves the marker incomplete) and pull reconciles from
 * one conditional heads request (a 304 fetches nothing, a 200 fetches only changed documents
 * and removes deleted ones unless a local edit holds them); a listing whose rows do not digest
 * to the digest it serves is rejected before anything is diffed, and a verified listing that
 * would empty the working copy or remove more than half of it is refused as a whole and
 * reported; a snapshot bootstrap over an earlier generation reconciles what the snapshot did
 * not carry the same way; a plain backend, and a wire authority without the features, still
 * walk the list. The Chromium unit runs the same runtime in a real page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import { RemoteBackend, type ConceptId, type OkfDocument, type StorageBackend } from "@superbee/core";
import { IntentStateConflict } from "@superbee/core/journaled-backend";
import { headsDigest, type DocumentHead, type RemoteError } from "@superbee/core/remote";
import { InvalidInputError } from "@superbee/core/storage";
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
  type BootstrapMarker,
  type LocalBundle,
  type SharedBase,
} from "../src/local-bundle.ts";
import { hostLocks, pushRoleName, withPushRole } from "../src/push-role.ts";
import { BASE_URL, BUNDLE, createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";

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

/** A create through the engine's patch path, for an id the working copy does not hold yet. */
function create(body: string): { mode: "patch"; onAbsent: "create"; buildCandidate: () => { frontmatter: Record<string, unknown>; body: string }; now: () => string } {
  return {
    mode: "patch",
    onAbsent: "create",
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "Created locally" }, body }),
    now: () => NOW,
  };
}

/** Poll `condition` on real timers until it holds; the wait itself is bounded. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The fixture's read side with its document fetch held open, whether that is `readMany` (the
 * list path, and a pull's changed documents) or `snapshot` (a bootstrap over the wire):
 * `entered` resolves when the first fetch arrives, and it proceeds only after `release`. What a
 * slow authority looks like to pull and bootstrap, with a hook to commit locally in the middle
 * of the round trip.
 */
function heldRemote(remote: StorageBackend): { remote: StorageBackend; entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const gate = deferred();
  let first = true;
  const hold = async (): Promise<void> => {
    if (!first) return;
    first = false;
    entered.resolve();
    await gate.promise;
  };
  const proxy = new Proxy(remote, {
    get(target, prop) {
      if (prop === "readMany") {
        return async (ids: string[]) => {
          await hold();
          return target.readMany(ids);
        };
      }
      if (prop === "snapshot") {
        return async () => {
          await hold();
          return (target as RemoteBackend).snapshot();
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StorageBackend;
  return { remote: proxy, entered: entered.promise, release: () => gate.resolve() };
}

/** The fixture's authority behind a fresh wire adapter whose every request is recorded with the status it drew. */
function countingRemote(fixture: RemoteFixture, answer: (request: Request) => Promise<Response> = fixture.hosted): { remote: RemoteBackend; requests: Array<{ method: string; path: string; status: number }> } {
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    const response = await answer(request);
    requests.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
    return response;
  };
  return { remote: new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl, maxRetries: 0 }), requests };
}

/** The digest the authority would answer now, by the wire recipe over its own heads. */
async function authorityDigest(fixture: RemoteFixture): Promise<string> {
  const heads = [];
  for (const id of await fixture.authority.list()) heads.push({ id, version: (await fixture.authority.read(id)).version });
  return headsDigest(heads);
}

/**
 * The fixture's hosted side with every `GET /heads` rewritten: the request is forwarded without
 * its `If-None-Match`, so the authority always lists, and `rewrite` receives the rows it would
 * serve and returns the rows and digest to serve instead, internally consistent by count. What
 * a misrouted, shortened or emptied listing looks like to pull.
 */
function rewritingHeads(fixture: RemoteFixture, rewrite: (heads: DocumentHead[]) => { heads: DocumentHead[]; digest: string }): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== HEADS) return fixture.hosted(request);
    const headers = new Headers(request.headers);
    headers.delete("If-None-Match");
    const response = await fixture.hosted(new Request(request.url, { method: request.method, headers }));
    if (response.status !== 200) return response;
    const payload = (await response.json()) as { heads: DocumentHead[] };
    const served = rewrite(payload.heads);
    return new Response(JSON.stringify({ count: served.heads.length, digest: served.digest, heads: served.heads }), {
      status: 200,
      headers: { "content-type": "application/json", ETag: `"${served.digest}"` },
    });
  };
}

const SNAPSHOT = `/v0/bundles/${BUNDLE}/snapshot`;
const HEADS = `/v0/bundles/${BUNDLE}/heads`;
const READ_MANY = `/v0/bundles/${BUNDLE}/docs:read-many`;
const LIST = `/v0/bundles/${BUNDLE}/docs`;
const CAPABILITIES = "/v0/capabilities";
const ROOT_INDEX = `/v0/bundles/${BUNDLE}/reserved/index.md`;

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

test("settleIntent applies the own-version rule itself: a raw conflict whose actual is the intent's local version is acknowledged and moves base, a conflict at another version stays a conflict", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/gamma", edit("gamma v2\n"));
    const requestId = committed.intent!.requestId;
    await local.backend.updateIntent(requestId, "pending", { state: "in_flight" });

    // Bypass the primitive: hand settleIntent the transport's raw answer for a post-expiry 412.
    const settled = await settleIntent(local, requestId, { kind: "conflict", actual: committed.version }, 1);
    assert.equal(settled.state, "acknowledged");
    assert.equal(settled.acknowledgedVersion, committed.version);
    assert.equal(settled.finding, undefined);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/gamma")))?.version, committed.version);

    const other = await commitLocal(local, "notes/beta", edit("beta v2\n"));
    await local.backend.updateIntent(other.intent!.requestId, "pending", { state: "in_flight" });
    const movedHead = (await fixture.authority.read("notes/beta")).version;
    const conflict = await settleIntent(local, other.intent!.requestId, { kind: "conflict", actual: movedHead }, 1, { remote: fixture.remote });
    assert.equal(conflict.state, "conflict");
    assert.equal(conflict.remote?.version, movedHead);
  } finally {
    local.close();
  }
});

test("lost acknowledgement, lookup unreachable, then retention expired: the post-expiry 412 at the intent's own version settles as acknowledged, nothing is applied twice", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/gamma", edit("gamma v2\n"));
    const requestId = committed.intent!.requestId;
    const base = (await local.backend.readMeta<SharedBase>(baseKey("notes/gamma")))?.version;

    // The authority applies and records the write, the response is lost, and the lookup route
    // is unreachable: the outcome stays unknown and the intent returns to pending with one attempt.
    fixture.knobs.dropAfterApply = true;
    fixture.knobs.lookupFails = true;
    const first = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(first.settled.map((row) => row.state), ["pending"]);
    assert.equal((await local.backend.readIntent(requestId))?.attempts, 1);
    assert.equal(fixture.history.length, 1);
    assert.equal((await fixture.authority.read("notes/gamma")).version, committed.version);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/gamma")))?.version, base);

    // Retention expires before the network is back: the lookup answers 404 as if never recorded,
    // so the primitive resubmits the same identity, and the router's compare-and-swap answers 412
    // whose `actual` is the version the client itself committed.
    fixture.knobs.dropAfterApply = false;
    fixture.knobs.lookupFails = false;
    fixture.clock.skewMs = 25 * 60 * 60 * 1000;
    const second = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.equal(fixture.history.length, 2);
    assert.equal(fixture.history[1]!.requestId, requestId);
    assert.equal(fixture.history[1]!.status, 412);
    assert.deepEqual(fixture.outcomes.get(requestId), { kind: "conflict", actual: committed.version });
    assert.deepEqual(second.settled.map((row) => row.state), ["acknowledged"]);
    const settled = await local.backend.readIntent(requestId);
    assert.equal(settled?.state, "acknowledged");
    assert.equal(settled?.acknowledgedVersion, committed.version);
    assert.equal(settled?.finding, undefined);
    assert.equal(settled?.remote, undefined);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/gamma")))?.version, committed.version);
    assert.equal((await fixture.authority.versions("notes/gamma")).length, 2);
    assert.equal((await local.backend.read("notes/gamma")).doc.body, "gamma v2\n");
    assert.deepEqual((await syncStatus(local)).counts, { pending: 0, in_flight: 0, acknowledged: 1, conflict: 0, refused: 0, unknown: 0 });

    // Nothing is left to deliver.
    const third = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(third.settled, []);
    assert.equal(fixture.history.length, 2);
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

/** Which lock manager the default path uses on this Node: Web Locks arrived in Node 22, older hosts fall back. */
const ROLE_HOST = hostLocks() ? "the host LockManager (navigator.locks is present on this Node)" : "the in-process fallback (this Node has no navigator.locks)";

test(`push role over ${ROLE_HOST}: one holder per name, release on settle, and pushWithRole reports the other side`, async () => {
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

test("push role over the in-process fallback, forced with locks null: 50 concurrent callers run exactly one, a throw releases, and pushWithRole reports the other side", async () => {
  const fallback = { locks: null };
  const name = pushRoleName("fallback-store");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ran = 0;
  // All 50 are started before any settles; the fallback decides at call time, so exactly one body runs.
  const callers = Array.from({ length: 50 }, () =>
    withPushRole(
      name,
      async () => {
        ran += 1;
        await gate;
        return ran;
      },
      fallback,
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, 1);
  release();
  const outcomes = await Promise.all(callers);
  assert.equal(outcomes.filter((row) => row.held).length, 1);
  assert.equal(outcomes.filter((row) => !row.held).length, 49);
  assert.deepEqual(outcomes.find((row) => row.held), { held: true, result: 1 });
  assert.equal(ran, 1);
  // The fallback is per process, not per host lock: a name held here is free again once the body settles.
  assert.deepEqual(await withPushRole(name, async () => "again", fallback), { held: true, result: "again" });
  // A rejecting body still releases the role.
  await assert.rejects(withPushRole(name, async () => {
    throw new Error("boom");
  }, fallback), /boom/);
  assert.deepEqual(await withPushRole(name, async () => "after throw", fallback), { held: true, result: "after throw" });

  // pushWithRole over the fallback: a contender finds the role held and delivers nothing.
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory, "fallback-store");
  try {
    await bootstrap(fixture.remote, local);
    await commitLocal(local, "notes/alpha", edit("alpha under the fallback role\n"));
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withPushRole(name, async () => {
      await holding;
      return "done";
    }, fallback);
    assert.deepEqual(await pushWithRole(local, fixture.transport, { write: immediate }, fallback), { held: false, reason: "held-elsewhere" });
    assert.equal(fixture.history.length, 0);
    releaseHolder();
    assert.deepEqual(await holder, { held: true, result: "done" });
    const delivered = await pushWithRole(local, fixture.transport, { write: immediate }, fallback);
    assert.deepEqual(delivered.held && delivered.result.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal(fixture.history.length, 1);
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

test("a local edit committed while pull is fetching is held: the refreshing write checks the journal inside its own transaction", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const base = (await fixture.authority.read("notes/alpha")).version;
    // The shared head moves, so pull has a refresh to write for alpha.
    const moved = await fixture.authority.write("notes/alpha", doc("notes/alpha", "alpha remote v2\n"), { expectedVersion: base });
    const held = heldRemote(fixture.remote);

    const pulling = pull(local, held.remote);
    await held.entered;
    // pull computed its held set before the round trip; this edit lands during it.
    const committed = await commitLocal(local, "notes/alpha", edit("alpha edited during pull\n"));
    assert.equal(committed.intent?.state, "pending");
    held.release();
    const report = await pulling;

    assert.deepEqual(report.held, ["notes/alpha"]);
    assert.ok(!report.refreshed.includes("notes/alpha"));
    const read = await local.backend.read("notes/alpha");
    assert.equal(read.doc.body, "alpha edited during pull\n");
    assert.equal(read.version, committed.version);
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, base);
    const intent = await local.backend.readIntent(committed.intent!.requestId);
    assert.equal(intent?.state, "pending");
    assert.equal(intent?.base, base);
    assert.notEqual(intent?.base, moved);
    // The divergence is push's to report, with the original base intact.
    const pushed = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(pushed.settled.map((row) => row.state), ["conflict"]);
    assert.equal((await local.backend.readIntent(committed.intent!.requestId))?.remote?.version, moved);
  } finally {
    local.close();
  }
});

test("a local create committed while bootstrap is fetching that id is held: the hydrating write does not replace it and the marker says so", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    const held = heldRemote(fixture.remote);
    const bootstrapping = bootstrap(held.remote, local);
    await held.entered;
    // bootstrap's upfront refusal saw no intents; beta is not hydrated yet when this lands.
    const committed = await commitLocal(local, "notes/beta", create("beta created before hydration\n"));
    assert.equal(committed.intent?.state, "pending");
    assert.equal(committed.intent?.base, null);
    held.release();
    const marker = await bootstrapping;

    assert.equal(marker.complete, true);
    assert.deepEqual(marker.held, ["notes/beta"]);
    assert.equal(marker.documentCount, 3);
    const read = await local.backend.read("notes/beta");
    assert.equal(read.doc.body, "beta created before hydration\n");
    assert.equal(read.version, committed.version);
    assert.equal(await local.backend.readMeta(baseKey("notes/beta")), undefined);
    assert.equal((await local.backend.readIntent(committed.intent!.requestId))?.state, "pending");
    // The other documents hydrated normally.
    assert.equal((await local.backend.read("notes/alpha")).doc.body, "alpha v1\n");
    assert.equal((await local.backend.read("notes/gamma")).doc.body, "gamma v1\n");
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, (await fixture.authority.read("notes/alpha")).version);
  } finally {
    local.close();
  }
});

/** A transport that delivers through the fixture and then never answers: the page dies mid-push. */
function crashAfterDelivery(fixture: RemoteFixture, deliver: boolean): { transport: OperationTransport; delivered: Promise<void> } {
  const delivered = deferred();
  return {
    delivered: delivered.promise,
    transport: {
      submit: async (intent, options) => {
        if (deliver) await fixture.transport.submit(intent, options);
        delivered.resolve();
        return new Promise<never>(() => {});
      },
      lookup: (requestId) => fixture.transport.lookup(requestId),
    },
  };
}

test("crash between claim and settlement: the claim recorded the attempt, reclaim keeps it, the next edit chains, and push resolves the original by lookup", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const first = openLocal(factory);
  await bootstrap(fixture.remote, first);
  const committed = await commitLocal(first, "notes/gamma", edit("gamma v2\n"));
  const requestId = committed.intent!.requestId;
  const crash = crashAfterDelivery(fixture, true);
  void push(first, crash.transport, { write: immediate });
  await crash.delivered;
  // The authority applied it; the journal already says one attempt, before any outcome is known.
  assert.equal(fixture.history.length, 1);
  const inFlight = await first.backend.readIntent(requestId);
  assert.equal(inFlight?.state, "in_flight");
  assert.equal(inFlight?.attempts, 1);
  first.close();

  const reopened = openLocal(factory);
  try {
    assert.equal(await reclaimInFlight(reopened), 1);
    const reclaimed = await reopened.backend.readIntent(requestId);
    assert.equal(reclaimed?.state, "pending");
    assert.equal(reclaimed?.attempts, 1);

    // A possibly-delivered intent is frozen: the new edit chains behind it.
    const chained = await commitLocal(reopened, "notes/gamma", edit("gamma v3\n"));
    assert.equal(chained.intent?.after, requestId);
    assert.equal(chained.intent?.base, committed.version);
    assert.equal((await reopened.backend.readIntent(requestId))?.state, "pending");
    assert.equal((await reopened.backend.listIntents("pending")).length, 2);

    const submissionsBefore = fixture.submissions.length;
    const report = await push(reopened, fixture.transport, { write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["acknowledged", "acknowledged"]);
    // The original was looked up, not submitted again; only the chained edit was submitted.
    assert.deepEqual(fixture.lookups, [requestId]);
    assert.deepEqual(fixture.submissions.slice(submissionsBefore), [chained.intent!.requestId]);
    assert.deepEqual(fixture.deduplicated, []);
    assert.equal(fixture.history.length, 2);
    const original = await reopened.backend.readIntent(requestId);
    assert.equal(original?.acknowledgedVersion, committed.version);
    // Two claims, one delivery: the count is what may have been submitted, never fewer.
    assert.equal(original?.attempts, 2);
    assert.equal((await fixture.authority.read("notes/gamma")).doc.body, "gamma v3\n");
    assert.equal((await reopened.backend.readMeta<SharedBase>(baseKey("notes/gamma")))?.version, chained.version);
  } finally {
    reopened.close();
  }
});

test("crash before delivery: push after reclaim starts with a lookup, finds nothing, and submits the same identity once", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const first = openLocal(factory);
  await bootstrap(fixture.remote, first);
  const committed = await commitLocal(first, "notes/beta", edit("beta v2\n"));
  const requestId = committed.intent!.requestId;
  const crash = crashAfterDelivery(fixture, false);
  void push(first, crash.transport, { write: immediate });
  await crash.delivered;
  assert.equal((await first.backend.readIntent(requestId))?.attempts, 1);
  first.close();

  const reopened = openLocal(factory);
  try {
    assert.equal(await reclaimInFlight(reopened), 1);
    const report = await push(reopened, fixture.transport, { write: immediate });
    assert.deepEqual(report.settled.map((row) => row.state), ["acknowledged"]);
    assert.deepEqual(fixture.lookups, [requestId]);
    assert.deepEqual(fixture.submissions, [requestId]);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0]!.requestId, requestId);
    assert.equal((await reopened.backend.readIntent(requestId))?.attempts, 2);
    assert.equal((await fixture.authority.read("notes/beta")).doc.body, "beta v2\n");
  } finally {
    reopened.close();
  }
});

test("resume requeues the intents a revocation refused: push delivers them with no further local edit", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/alpha", edit("alpha retained\n"));
    const requestId = committed.intent!.requestId;
    fixture.knobs.unauthorized = true;
    const refused = await push(local, fixture.transport, { write: immediate });
    assert.equal(refused.paused, true);
    assert.deepEqual(refused.settled.map((row) => row.state), ["refused"]);
    // The authority never admitted the request: nothing is recorded under its identity.
    assert.equal(fixture.outcomes.has(requestId), false);
    assert.equal(fixture.history.length, 0);

    fixture.knobs.unauthorized = false;
    assert.deepEqual((await push(local, fixture.transport, { write: immediate })).settled, []);
    const { requeued } = await resume(local);
    assert.equal(requeued, 1);
    const pending = await local.backend.readIntent(requestId);
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.attempts, 1);
    assert.equal((await syncStatus(local)).paused, false);

    const delivered = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(delivered.settled.map((row) => row.state), ["acknowledged"]);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0]!.requestId, requestId);
    assert.equal((await fixture.authority.read("notes/alpha")).doc.body, "alpha retained\n");
    assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/alpha")))?.version, committed.version);
    assert.equal((await syncStatus(local)).counts.refused, 0);
  } finally {
    local.close();
  }
});

test("a deadline shorter than the authority's latency: the aborted submission, its lookup and the resubmission apply the write exactly once", async () => {
  const fixture = await seededFixture();
  const factory = new IDBFactory();
  const local = openLocal(factory);
  try {
    await bootstrap(fixture.remote, local);
    const committed = await commitLocal(local, "notes/beta", edit("beta under latency\n"));
    const requestId = committed.intent!.requestId;
    fixture.knobs.delayMs = 40;
    // Real timers. The first submission is abandoned at 5 ms while the authority is still
    // applying it; its lookup finds nothing recorded yet, so the primitive resubmits the same
    // identity, which arrives during that application and is abandoned at its own deadline.
    // The call ends unknown with both submissions counted; nothing here decides otherwise.
    const first = await push(local, fixture.transport, { write: { deadlineMs: 5, lookupDelayMs: 0, maxSubmissions: 2 } });
    assert.deepEqual(first.settled.map((row) => row.state), ["pending"]);
    assert.deepEqual(fixture.submissions, [requestId, requestId]);
    assert.equal((await local.backend.readIntent(requestId))?.attempts, 2);

    // Once the authority has finished, the next push resolves the identity by lookup: the
    // duplicate was answered from the one application, never applied as a second write.
    await waitFor(() => fixture.history.length > 0);
    const second = await push(local, fixture.transport, { write: immediate });
    assert.deepEqual(second.settled.map((row) => row.state), ["acknowledged"]);
    assert.deepEqual(fixture.submissions, [requestId, requestId]);
    // The abandoned duplicate reaches the router only after the fixture's latency, where the
    // reference store answers it from the record; wait for that arrival before reading the count.
    await waitFor(() => fixture.deduplicated.length > 0);
    assert.deepEqual(fixture.deduplicated, [requestId]);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0]!.requestId, requestId);
    assert.deepEqual(fixture.outcomes.get(requestId), { kind: "committed", version: committed.version });
    assert.equal((await fixture.authority.read("notes/beta")).version, committed.version);
    assert.equal((await fixture.authority.versions("notes/beta")).length, 2);
    assert.equal((await local.backend.readIntent(requestId))?.state, "acknowledged");
  } finally {
    local.close();
  }
});

// ── concurrent batch fetch ─────────────────────────────────────────────────────────────────

/** `count` notes under `notes/`, ids zero-padded so the authority lists them in a known order. */
async function seedMany(fixture: RemoteFixture, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const id = `notes/n${String(n).padStart(4, "0")}`;
    await fixture.authority.write(id, doc(id, `${id} v1\n`));
    ids.push(id);
  }
  return ids;
}

/** Move every remote head once, so a pull has one refresh to write per document. */
async function editAllRemote(fixture: RemoteFixture): Promise<void> {
  for (const id of await fixture.authority.list()) {
    const { version } = await fixture.authority.read(id);
    await fixture.authority.write(id, doc(id, `${id} v2\n`), { expectedVersion: version });
  }
}

/** Everything a working copy holds that sync owns: each document's version and shared base, in id order. */
async function snapshot(local: LocalBundle): Promise<Array<{ id: string; version: string; base: SharedBase | undefined }>> {
  const rows = [];
  for (const id of (await local.backend.list()).sort()) {
    rows.push({ id, version: (await local.backend.read(id)).version, base: await local.backend.readMeta<SharedBase>(baseKey(id)) });
  }
  return rows;
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
}

/**
 * The batch fetch is what the concurrency claim bounds; the paginated list and the root index
 * read are serial round trips either way. Small batches make the batch term dominate at 200
 * documents. The asserted property is structural (how many readMany calls overlap), which is
 * deterministic; the wall-time ratio is reported as a diagnostic because a loaded CI runner
 * can compress it without anything being wrong.
 */
const TIMING = { documents: 200, latencyMs: 30, batchSize: 5 };

/** The fixture's read side with overlapping `readMany` calls counted, so concurrency is asserted, not inferred from time. */
function overlapProbe(remote: StorageBackend): { remote: StorageBackend; overlap: { current: number; max: number } } {
  const overlap = { current: 0, max: 0 };
  const proxy = new Proxy(remote, {
    get(target, property, receiver) {
      if (property !== "readMany") return Reflect.get(target, property, receiver);
      return async (ids: ConceptId[]) => {
        overlap.current += 1;
        overlap.max = Math.max(overlap.max, overlap.current);
        try {
          return await target.readMany(ids);
        } finally {
          overlap.current -= 1;
        }
      };
    },
  });
  return { remote: proxy, overlap };
}

test("bootstrap with concurrency 8 produces the same working copy as concurrency 1 in a fraction of the wall time", async (t) => {
  const fixture = await createRemoteFixture();
  await seedMany(fixture, TIMING.documents);
  fixture.knobs.latencyMs = TIMING.latencyMs;
  const serial = openLocal(new IDBFactory());
  const concurrent = openLocal(new IDBFactory());
  try {
    const serialProbe = overlapProbe(fixture.remote);
    const concurrentProbe = overlapProbe(fixture.remote);
    // The list path, explicitly: a snapshot is one stream and has no batches to overlap.
    const one = await timed(() => bootstrap(serialProbe.remote, serial, { batchSize: TIMING.batchSize, concurrency: 1, wire: { snapshot: false } }));
    const eight = await timed(() => bootstrap(concurrentProbe.remote, concurrent, { batchSize: TIMING.batchSize, concurrency: 8, wire: { snapshot: false } }));
    assert.equal(serialProbe.overlap.max, 1, "concurrency 1 never overlaps readMany calls");
    assert.equal(concurrentProbe.overlap.max, 8, "concurrency 8 keeps eight readMany calls in flight");
    assert.equal(one.result.complete, true);
    assert.equal(eight.result.complete, true);
    assert.equal(one.result.documentCount, TIMING.documents);
    assert.equal(eight.result.documentCount, TIMING.documents);
    assert.equal(one.result.held, undefined);
    assert.equal(eight.result.held, undefined);
    assert.equal(await isComplete(serial), true);
    assert.equal(await isComplete(concurrent), true);
    const expected = await snapshot(serial);
    assert.equal(expected.length, TIMING.documents);
    assert.deepEqual(await snapshot(concurrent), expected);
    assert.equal(await concurrent.backend.readReserved("", "index.md").then((row) => row?.content), (await serial.backend.readReserved("", "index.md"))?.content);
    const speedup = one.ms / eight.ms;
    t.diagnostic(`bootstrap at ${TIMING.documents} documents, ${TIMING.latencyMs} ms latency, batch ${TIMING.batchSize}: concurrency 1 ${one.ms.toFixed(0)} ms, concurrency 8 ${eight.ms.toFixed(0)} ms, ${speedup.toFixed(2)}x`);
  } finally {
    serial.close();
    concurrent.close();
  }
});

test("pull with concurrency 8 refreshes the same documents as concurrency 1 in a fraction of the wall time", async (t) => {
  const fixture = await createRemoteFixture();
  await seedMany(fixture, TIMING.documents);
  const serial = openLocal(new IDBFactory());
  const concurrent = openLocal(new IDBFactory());
  try {
    await bootstrap(fixture.remote, serial);
    await bootstrap(fixture.remote, concurrent);
    await editAllRemote(fixture);
    fixture.knobs.latencyMs = TIMING.latencyMs;
    const serialProbe = overlapProbe(fixture.remote);
    const concurrentProbe = overlapProbe(fixture.remote);
    const one = await timed(() => pull(serial, serialProbe.remote, { batchSize: TIMING.batchSize, concurrency: 1 }));
    const eight = await timed(() => pull(concurrent, concurrentProbe.remote, { batchSize: TIMING.batchSize, concurrency: 8 }));
    assert.equal(serialProbe.overlap.max, 1, "concurrency 1 never overlaps readMany calls");
    assert.equal(concurrentProbe.overlap.max, 8, "concurrency 8 keeps eight readMany calls in flight");
    assert.equal(one.result.refreshed.length, TIMING.documents);
    assert.deepEqual([...eight.result.refreshed].sort(), [...one.result.refreshed].sort());
    assert.deepEqual(eight.result.held, []);
    assert.deepEqual(eight.result.unchanged, []);
    const expected = await snapshot(serial);
    assert.deepEqual(await snapshot(concurrent), expected);
    for (const row of expected) assert.equal(row.base?.version, (await fixture.authority.read(row.id)).version);
    const status = await syncStatus(concurrent);
    assert.equal(status.lastPull?.refreshed, TIMING.documents);
    assert.notEqual(status.lastPull?.completedAt, null);
    const speedup = one.ms / eight.ms;
    t.diagnostic(`pull at ${TIMING.documents} documents, ${TIMING.latencyMs} ms latency, batch ${TIMING.batchSize}: concurrency 1 ${one.ms.toFixed(0)} ms, concurrency 8 ${eight.ms.toFixed(0)} ms, ${speedup.toFixed(2)}x`);
  } finally {
    serial.close();
    concurrent.close();
  }
});

test("onHydrated receives a unique index per document under concurrency even when the hook awaits", async () => {
  const fixture = await createRemoteFixture();
  await seedMany(fixture, 60);
  const local = openLocal(new IDBFactory());
  try {
    const seen: number[] = [];
    const marker = await bootstrap(fixture.remote, local, {
      batchSize: 5,
      concurrency: 8,
      onHydrated: async (_id, index, total) => {
        assert.equal(total, 60);
        seen.push(index);
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    assert.equal(marker.complete, true);
    assert.equal(seen.length, 60);
    assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i));
  } finally {
    local.close();
  }
});

/** The fixture's read side with `readMany` failing for the batch that carries `poison`; every call is counted. */
function poisonedRemote(remote: StorageBackend, poison: string): { remote: StorageBackend; calls: { count: number } } {
  const calls = { count: 0 };
  const proxy = new Proxy(remote, {
    get(target, prop) {
      if (prop === "readMany") {
        return async (ids: string[]) => {
          calls.count += 1;
          if (ids.includes(poison)) throw new TypeError("fetch failed: batch dropped");
          return target.readMany(ids);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StorageBackend;
  return { remote: proxy, calls };
}

test("a batch that fails under concurrency 8 leaves the marker incomplete, nothing in flight and no unhandled rejection; a retry completes", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 200);
  fixture.knobs.latencyMs = 5;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const local = openLocal(new IDBFactory());
  try {
    // Batch size 25: the third batch is ids[50..74]. All eight batches are in flight together.
    const poisoned = poisonedRemote(fixture.remote, ids[60]!);
    await assert.rejects(bootstrap(poisoned.remote, local, { batchSize: 25, concurrency: 8, wire: { snapshot: false } }), /batch dropped/);
    const callsAtRejection = poisoned.calls.count;
    assert.equal(await isComplete(local), false);
    const marker = await local.backend.readMeta<{ complete: boolean; generation: number; completedAt?: string }>("bootstrap");
    assert.equal(marker?.complete, false);
    assert.equal(marker?.generation, 1);
    assert.equal(marker?.completedAt, undefined);
    // The seven other batches were already in flight when the third failed; each ran to its end
    // and was written whole, so what landed is exactly those batches, none of them partial.
    const landed = (await local.backend.list()).sort();
    assert.equal(landed.length, 175);
    assert.deepEqual(landed, ids.filter((_, index) => index < 50 || index >= 75));
    for (const id of landed) assert.equal((await local.backend.readMeta<SharedBase>(baseKey(id)))?.version, (await fixture.authority.read(id)).version);
    // Nothing was left pending: no further fetch arrives after the rejection, and no rejection
    // surfaced anywhere but at the caller.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(poisoned.calls.count, callsAtRejection);
    assert.equal(callsAtRejection, 8);
    assert.deepEqual(unhandled, []);

    const repaired = await bootstrap(fixture.remote, local, { batchSize: 25, concurrency: 8 });
    assert.equal(repaired.complete, true);
    assert.equal(repaired.generation, 2);
    assert.equal(repaired.documentCount, 200);
    assert.equal((await local.backend.list()).length, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    local.close();
  }
});

test("an authority that stops serving reads part-way still leaves a concurrent bootstrap incomplete, with only whole batches landed", async () => {
  const fixture = await createRemoteFixture();
  await seedMany(fixture, 200);
  fixture.knobs.readBudget = 100;
  const local = openLocal(new IDBFactory());
  try {
    await assert.rejects(bootstrap(fixture.remote, local, { batchSize: 25, concurrency: 8, wire: { snapshot: false } }), /stopped serving reads/);
    assert.equal(await isComplete(local), false);
    assert.equal((await syncStatus(local)).generation, 1);
    const landed = await local.backend.list();
    // Every document the authority served was written, in whole batches, and no more than the budget.
    assert.equal(landed.length, fixture.served.documents);
    assert.ok(landed.length > 0 && landed.length <= 100 && landed.length % 25 === 0, `landed ${landed.length}`);

    fixture.knobs.readBudget = null;
    const repaired = await bootstrap(fixture.remote, local, { concurrency: 8 });
    assert.equal(repaired.complete, true);
    assert.equal(repaired.generation, 2);
    assert.equal((await local.backend.list()).length, 200);
  } finally {
    local.close();
  }
});

test("concurrency below 1 or not an integer is refused before anything is written", async () => {
  const fixture = await seededFixture();
  const local = openLocal(new IDBFactory());
  try {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(bootstrap(fixture.remote, local, { concurrency }), (error: unknown) => error instanceof InvalidInputError);
      await assert.rejects(pull(local, fixture.remote, { concurrency }), (error: unknown) => error instanceof InvalidInputError);
    }
    assert.equal(await local.backend.readMeta("bootstrap"), undefined);
    assert.equal(await local.backend.readMeta("pull"), undefined);
    assert.deepEqual(await local.backend.list(), []);
    // The minimum is one batch at a time: the sequential shape, still valid.
    assert.equal((await bootstrap(fixture.remote, local, { concurrency: 1 })).complete, true);
  } finally {
    local.close();
  }
});

// ── snapshot and heads ─────────────────────────────────────────────────────────────────────

test("bootstrap by snapshot yields the working copy bootstrap by list yields, with the digest on the marker, in one capabilities, one index and one snapshot request", async () => {
  const fixture = await createRemoteFixture();
  await seedMany(fixture, 60);
  const bySnapshot = openLocal(new IDBFactory(), "by-snapshot");
  const byList = openLocal(new IDBFactory(), "by-list");
  try {
    const counted = countingRemote(fixture);
    const marker = await bootstrap(counted.remote, bySnapshot, { batchSize: 25 });
    assert.deepEqual(counted.requests, [
      { method: "GET", path: ROOT_INDEX, status: 200 },
      { method: "GET", path: CAPABILITIES, status: 200 },
      { method: "GET", path: SNAPSHOT, status: 200 },
    ]);
    assert.equal(marker.complete, true);
    assert.equal(marker.documentCount, 60);
    assert.equal(marker.headsDigest, await authorityDigest(fixture));
    assert.equal(marker.held, undefined);
    assert.equal(marker.findings, undefined);
    assert.equal(await isComplete(bySnapshot), true);

    const listed = countingRemote(fixture);
    const listMarker = await bootstrap(listed.remote, byList, { batchSize: 25, wire: { snapshot: false } });
    assert.equal(listMarker.headsDigest, undefined, "the list path records no digest");
    assert.ok(listed.requests.some((row) => row.path === READ_MANY));
    assert.ok(!listed.requests.some((row) => row.path === SNAPSHOT || row.path === CAPABILITIES), "a refused feature costs no capabilities read");
    const expected = await snapshot(byList);
    assert.equal(expected.length, 60);
    assert.deepEqual(await snapshot(bySnapshot), expected, "versions and shared bases agree document for document");
    assert.equal((await bySnapshot.backend.readReserved("", "index.md"))?.content, (await byList.backend.readReserved("", "index.md"))?.content);
    for (const row of expected) assert.equal(row.base?.content, (await bySnapshot.backend.readMeta<SharedBase>(baseKey(row.id)))?.content);

    // The capabilities are kept on the bundle: a second verb over it sends no capabilities request.
    const again = countingRemote(fixture);
    await pull(bySnapshot, again.remote);
    assert.deepEqual(again.requests.map((row) => row.path), [HEADS]);
  } finally {
    bySnapshot.close();
    byList.close();
  }
});

test("a snapshot the authority cuts short leaves the marker incomplete with whole batches landed, and a retry completes", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 60);
  const local = openLocal(new IDBFactory());
  try {
    // The header line plus 30 document lines: one whole batch of 25 arrives before the cut.
    fixture.knobs.snapshotCutAfter = 31;
    await assert.rejects(bootstrap(fixture.remote, local, { batchSize: 25 }), (error: unknown) => {
      assert.equal((error as RemoteError).name, "RemoteError");
      assert.equal((error as RemoteError).code, "SNAPSHOT_TRUNCATED");
      return true;
    });
    assert.equal(await isComplete(local), false);
    const marker = await local.backend.readMeta<BootstrapMarker>("bootstrap");
    assert.equal(marker?.complete, false);
    assert.equal(marker?.generation, 1);
    assert.equal(marker?.headsDigest, undefined);
    assert.deepEqual((await local.backend.list()).sort(), ids.slice(0, 25));
    assert.equal(fixture.served.documents, 30);
    // No digest is offered from an incomplete bootstrap: a pull now asks unconditionally.
    const counted = countingRemote(fixture);
    await pull(local, counted.remote);
    assert.deepEqual(counted.requests.map((row) => [row.path, row.status]), [[HEADS, 200], [READ_MANY, 200], [READ_MANY, 200]]);
    assert.equal((await local.backend.list()).length, 60);

    fixture.knobs.snapshotCutAfter = null;
    const repaired = await bootstrap(fixture.remote, local, { batchSize: 25 });
    assert.equal(repaired.complete, true);
    assert.equal(repaired.generation, 2);
    assert.equal(repaired.documentCount, 60);
    assert.equal(repaired.headsDigest, await authorityDigest(fixture));
    assert.equal((await local.backend.list()).length, 60);
  } finally {
    local.close();
  }
});

test("pull with nothing changed is one conditional heads request answered 304, with no document read and the marker saying unchanged", async () => {
  const fixture = await seededFixture();
  const local = openLocal(new IDBFactory());
  try {
    const marker = await bootstrap(fixture.remote, local);
    const counted = countingRemote(fixture);
    const report = await pull(local, counted.remote);
    assert.deepEqual(counted.requests, [{ method: "GET", path: HEADS, status: 304 }]);
    assert.deepEqual(report, { refreshed: [], held: [], unchanged: ["notes/alpha", "notes/beta", "notes/gamma"], deleted: [] });
    const status = await syncStatus(local);
    assert.equal(status.lastPull?.unchanged, true);
    assert.equal(status.lastPull?.refreshed, 0);
    assert.equal(status.lastPull?.headsDigest, marker.headsDigest);
    assert.notEqual(status.lastPull?.completedAt, null);
    // The digest a later pull offers is the one this pull matched; nothing changed, so 304 again.
    const again = countingRemote(fixture);
    await pull(local, again.remote);
    assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
  } finally {
    local.close();
  }
});

test("pull after 5 remote edits and 2 remote creates fetches exactly those 7 documents in one read-many batch and records the new digest", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 40);
  const local = openLocal(new IDBFactory());
  try {
    const marker = await bootstrap(fixture.remote, local);
    const edited = [ids[3]!, ids[7]!, ids[11]!, ids[19]!, ids[39]!];
    for (const id of edited) {
      const { version } = await fixture.authority.read(id);
      await fixture.authority.write(id, doc(id, `${id} v2\n`), { expectedVersion: version });
    }
    const created = ["notes/new-a", "notes/new-b"];
    for (const id of created) await fixture.authority.write(id, doc(id, `${id} created remotely\n`));
    const changed = [...edited, ...created].sort();

    const counted = countingRemote(fixture);
    const report = await pull(local, counted.remote);
    assert.deepEqual(counted.requests.map((row) => [row.path, row.status]), [[HEADS, 200], [READ_MANY, 200]]);
    assert.deepEqual([...report.refreshed].sort(), changed);
    assert.equal(report.unchanged.length, 35);
    assert.deepEqual(report.held, []);
    assert.deepEqual(report.deleted, []);
    for (const id of changed) {
      const held = await fixture.authority.read(id);
      assert.equal((await local.backend.read(id)).doc.body, held.doc.body);
      assert.equal((await local.backend.readMeta<SharedBase>(baseKey(id)))?.version, held.version);
    }
    assert.equal((await local.backend.list()).length, 42);
    const status = await syncStatus(local);
    assert.equal(status.lastPull?.refreshed, 7);
    assert.equal(status.lastPull?.unchanged, false);
    assert.notEqual(status.lastPull?.headsDigest, marker.headsDigest);
    assert.equal(status.lastPull?.headsDigest, await authorityDigest(fixture));
    // The pull's digest, newer than the bootstrap's, is what the next pull offers.
    const again = countingRemote(fixture);
    await pull(local, again.remote);
    assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
  } finally {
    local.close();
  }
});

test("pull removes documents the authority deleted, with their base, and retains one a pending edit holds with its base marked absent; push then records the conflict against no remote", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 10);
  const local = openLocal(new IDBFactory());
  try {
    await bootstrap(fixture.remote, local);
    const editedId = ids[3]!;
    const sharedVersion = (await fixture.authority.read(editedId)).version;
    const previousBase = await local.backend.readMeta<SharedBase>(baseKey(editedId));
    const committed = await commitLocal(local, editedId, edit("edited before the authority deleted it\n"));
    const gone = [ids[0]!, ids[1]!, ids[2]!];
    for (const id of [...gone, editedId]) assert.equal(await fixture.authority.delete(id), true);

    const counted = countingRemote(fixture);
    const report = await pull(local, counted.remote);
    assert.deepEqual(counted.requests.map((row) => [row.path, row.status]), [[HEADS, 200]], "nothing changed among the listed heads, so nothing is read");
    assert.deepEqual(report.deleted, gone);
    assert.deepEqual(report.held, [editedId]);
    assert.deepEqual(report.refreshed, []);
    assert.equal(report.unchanged.length, 6);
    for (const id of gone) {
      await assert.rejects(local.backend.read(id), (error: unknown) => (error as { code?: unknown }).code === "ENOENT");
      assert.equal(await local.backend.readMeta(baseKey(id)), undefined, "the base row went with the document");
    }
    assert.equal((await local.backend.list()).length, 7);
    const retained = await local.backend.read(editedId);
    assert.equal(retained.doc.body, "edited before the authority deleted it\n");
    assert.equal(retained.version, committed.version);
    assert.deepEqual(await local.backend.readMeta<SharedBase>(baseKey(editedId)), { version: null, content: previousBase?.content ?? null });
    const intent = await local.backend.readIntent(committed.intent!.requestId);
    assert.equal(intent?.state, "pending");
    assert.equal(intent?.base, sharedVersion, "the intent still names the base the edit was made against");
    assert.equal((await syncStatus(local)).lastPull?.headsDigest, await authorityDigest(fixture));

    // Nothing changed since: a 304 removes nothing further, and the retained document stays.
    const again = countingRemote(fixture);
    const second = await pull(local, again.remote);
    assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
    assert.deepEqual(second.deleted, []);
    assert.equal((await local.backend.list()).length, 7);
    assert.equal((await local.backend.read(editedId)).version, committed.version);

    // Push delivers the edit at its base and the authority, holding nothing, answers a conflict
    // whose remote is absent: the runtime's `remote: null` conflict.
    const pushed = await push(local, fixture.transport, { remote: fixture.remote, write: immediate });
    assert.deepEqual(pushed.settled.map((row) => row.state), ["conflict"]);
    const conflict = await local.backend.readIntent(committed.intent!.requestId);
    assert.equal(conflict?.state, "conflict");
    assert.deepEqual(conflict?.remote, { version: null, content: null });
    assert.equal((await local.backend.read(editedId)).doc.body, "edited before the authority deleted it\n");
    assert.equal(await fixture.authority.exists(editedId), false);
  } finally {
    local.close();
  }
});

test("a heads answer with the first 100 of 197 rows, count 100 and the real digest is rejected before anything is diffed: nothing deleted, no digest recorded; the untampered answer then yields the normal outcome and a 304", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 200);
  const local = openLocal(new IDBFactory());
  try {
    const marker = await bootstrap(fixture.remote, local);
    assert.equal(marker.headsDigest, await authorityDigest(fixture));
    const committed = await commitLocal(local, ids[7]!, edit("local edit on n0007\n"));
    for (const id of [ids[7]!, ids[8]!, ids[9]!]) assert.equal(await fixture.authority.delete(id), true);
    const tenth = await fixture.authority.read(ids[10]!);
    await fixture.authority.write(ids[10]!, doc(ids[10]!, "n0010 v2\n"), { expectedVersion: tenth.version });
    const realDigest = await authorityDigest(fixture);

    // Whole by its own count, under the digest of the full 197-row listing.
    const shortened = countingRemote(fixture, rewritingHeads(fixture, (heads) => ({ heads: heads.slice(0, 100), digest: realDigest })));
    await assert.rejects(pull(local, shortened.remote), (error: unknown) => {
      assert.equal((error as RemoteError).name, "RemoteError");
      assert.equal((error as RemoteError).code, "RUNTIME");
      assert.equal((error as RemoteError).status, 502);
      assert.match((error as RemoteError).message, /digest/);
      return true;
    });
    assert.deepEqual(shortened.requests, [{ method: "GET", path: HEADS, status: 200 }], "the listing was rejected before any document was read");
    assert.equal((await local.backend.list()).length, 200, "nothing deleted");
    for (const id of [ids[150]!, ids[199]!]) assert.equal((await local.backend.readMeta<SharedBase>(baseKey(id)))?.version, (await fixture.authority.read(id)).version, "base rows of unlisted documents stand");
    const status = await syncStatus(local);
    assert.equal(status.lastPull?.completedAt, null, "the pull never completed");
    assert.equal(status.lastPull?.headsDigest, undefined, "no digest recorded");

    // The untampered answer: n0008 and n0009 deleted, n0007 held with its base marked absent, n0010 refreshed.
    const counted = countingRemote(fixture);
    const report = await pull(local, counted.remote);
    assert.deepEqual(counted.requests.map((row) => [row.path, row.status]), [[HEADS, 200], [READ_MANY, 200]]);
    assert.deepEqual(report.deleted, [ids[8]!, ids[9]!]);
    assert.deepEqual(report.held, [ids[7]!]);
    assert.deepEqual(report.refreshed, [ids[10]!]);
    assert.equal(report.refused, undefined);
    assert.equal(report.unchanged.length, 196);
    assert.equal((await local.backend.list()).length, 198);
    assert.equal((await local.backend.read(ids[7]!)).version, committed.version);
    assert.deepEqual((await local.backend.readMeta<SharedBase>(baseKey(ids[7]!)))?.version, null);
    assert.equal((await local.backend.read(ids[10]!)).doc.body, "n0010 v2\n");
    assert.equal((await syncStatus(local)).lastPull?.headsDigest, realDigest);
    const again = countingRemote(fixture);
    await pull(local, again.remote);
    assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
  } finally {
    local.close();
  }
});

test("a verified listing that would empty the working copy, or remove more than half of it, is refused as a whole: nothing deleted, refreshes applied, the refusal on the report and the marker, no digest recorded; the next pull asks unconditionally", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 200);
  const local = openLocal(new IDBFactory());
  try {
    await bootstrap(fixture.remote, local);
    for (const id of ids.slice(0, 3)) assert.equal(await fixture.authority.delete(id), true);
    const settled = await pull(local, fixture.remote);
    assert.deepEqual(settled.deleted, ids.slice(0, 3));
    assert.equal((await local.backend.list()).length, 197);
    const matched = (await syncStatus(local)).lastPull?.headsDigest;
    assert.equal(matched, await authorityDigest(fixture));

    // An internally consistent empty listing: count 0 under the digest of the empty recipe.
    const emptied = countingRemote(fixture, rewritingHeads(fixture, () => ({ heads: [], digest: headsDigest([]) })));
    const refusedEmpty = await pull(local, emptied.remote);
    assert.deepEqual(emptied.requests, [{ method: "GET", path: HEADS, status: 200 }]);
    assert.deepEqual(refusedEmpty.refused, { deletions: 197, reason: "empty-listing" });
    assert.deepEqual(refusedEmpty.deleted, []);
    assert.deepEqual(refusedEmpty.held, []);
    assert.equal((await local.backend.list()).length, 197, "the working copy keeps every document");
    let status = await syncStatus(local);
    assert.notEqual(status.lastPull?.completedAt, null, "the pull completed");
    assert.deepEqual(status.lastPull?.refused, { deletions: 197, reason: "empty-listing" });
    assert.equal(status.lastPull?.headsDigest, undefined, "no digest recorded for a listing that was not applied");

    // A consistent listing of 60 of the 197 rows, with one of them edited at the authority so
    // the refresh is seen to apply while the deletions are refused.
    const edited = ids[100]!;
    const before = await fixture.authority.read(edited);
    await fixture.authority.write(edited, doc(edited, "n0100 v2\n"), { expectedVersion: before.version });
    const halved = countingRemote(
      fixture,
      rewritingHeads(fixture, (heads) => {
        const kept = heads.slice(60, 120);
        return { heads: kept, digest: headsDigest(kept) };
      }),
    );
    const refusedHalf = await pull(local, halved.remote);
    assert.deepEqual(halved.requests.map((row) => [row.path, row.status]), [[HEADS, 200], [READ_MANY, 200]]);
    assert.deepEqual(refusedHalf.refused, { deletions: 137, reason: "over-half" });
    assert.deepEqual(refusedHalf.refreshed, [edited], "the refresh in the same pull applied");
    assert.deepEqual(refusedHalf.deleted, []);
    assert.equal((await local.backend.list()).length, 197);
    assert.equal((await local.backend.read(edited)).doc.body, "n0100 v2\n");
    status = await syncStatus(local);
    assert.deepEqual(status.lastPull?.refused, { deletions: 137, reason: "over-half" });
    assert.equal(status.lastPull?.headsDigest, undefined);

    // With no digest from the refused pulls, the next pull asks the authority for its real
    // listing, which names every document the working copy holds: nothing to remove, and the
    // digest is matched again.
    const real = countingRemote(fixture);
    const repaired = await pull(local, real.remote);
    assert.deepEqual(real.requests, [{ method: "GET", path: HEADS, status: 200 }]);
    assert.equal(repaired.refused, undefined);
    assert.deepEqual(repaired.deleted, []);
    assert.equal(repaired.unchanged.length, 197);
    assert.equal((await syncStatus(local)).lastPull?.headsDigest, await authorityDigest(fixture));
    const again = countingRemote(fixture);
    await pull(local, again.remote);
    assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
  } finally {
    local.close();
  }
});

test("a snapshot bootstrap over an earlier generation removes the documents the snapshot did not carry, records the digest, and the next pull is a 304; one that would remove more than half refuses, records no digest, and the next pull asks unconditionally", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 50);
  const local = openLocal(new IDBFactory());
  try {
    const first = await bootstrap(fixture.remote, local, { batchSize: 25 });
    assert.equal(first.generation, 1);
    const gone = ids.slice(10, 15);
    for (const id of gone) assert.equal(await fixture.authority.delete(id), true);

    const second = await bootstrap(fixture.remote, local, { batchSize: 25 });
    assert.equal(second.generation, 2);
    assert.equal(second.complete, true);
    assert.equal(second.documentCount, 45);
    assert.deepEqual(second.deleted, gone);
    assert.equal(second.refused, undefined);
    assert.equal(second.headsDigest, await authorityDigest(fixture));
    assert.equal((await local.backend.list()).length, 45);
    for (const id of gone) {
      await assert.rejects(local.backend.read(id), (error: unknown) => (error as { code?: unknown }).code === "ENOENT");
      assert.equal(await local.backend.readMeta(baseKey(id)), undefined, "the base row went with the document");
    }
    const counted = countingRemote(fixture);
    await pull(local, counted.remote);
    assert.deepEqual(counted.requests, [{ method: "GET", path: HEADS, status: 304 }]);

    // The authority shrinks to 20 of the 45: a snapshot bootstrap hydrates those 20 and refuses
    // to remove the 25 others, and says so on the marker.
    for (const id of ids.slice(20, 45)) assert.equal(await fixture.authority.delete(id), true);
    const third = await bootstrap(fixture.remote, local, { batchSize: 25 });
    assert.equal(third.generation, 3);
    assert.equal(third.complete, true);
    assert.equal(third.documentCount, 20);
    assert.deepEqual(third.refused, { deletions: 25, reason: "over-half" });
    assert.equal(third.deleted, undefined);
    assert.equal(third.headsDigest, undefined, "the working copy does not match the snapshot's digest");
    assert.equal((await local.backend.list()).length, 45);
    const unconditional = countingRemote(fixture);
    const report = await pull(local, unconditional.remote);
    assert.deepEqual(unconditional.requests, [{ method: "GET", path: HEADS, status: 200 }]);
    assert.deepEqual(report.refused, { deletions: 25, reason: "over-half" });
    assert.equal((await local.backend.list()).length, 45);
  } finally {
    local.close();
  }
});

test("a snapshot whose rows do not digest to its header leaves the marker incomplete with no digest, and nothing is reconciled on its word", async () => {
  const fixture = await createRemoteFixture();
  const ids = await seedMany(fixture, 30);
  const local = openLocal(new IDBFactory());
  try {
    await bootstrap(fixture.remote, local, { batchSize: 10 });
    await fixture.authority.delete(ids[0]!);
    const lying = async (request: Request): Promise<Response> => {
      const response = await fixture.hosted(request);
      if (new URL(request.url).pathname !== SNAPSHOT || response.status !== 200) return response;
      const text = (await response.text()).replace(/"digest":"sha256:[0-9a-f]{64}"/, `"digest":"sha256:${"e".repeat(64)}"`);
      return new Response(text, { status: 200, headers: response.headers });
    };
    const counted = countingRemote(fixture, lying);
    await assert.rejects(bootstrap(counted.remote, local, { batchSize: 10 }), (error: unknown) => {
      assert.equal((error as RemoteError).name, "RemoteError");
      assert.equal((error as RemoteError).code, "SNAPSHOT_DIGEST_MISMATCH");
      return true;
    });
    assert.equal(await isComplete(local), false);
    const marker = await local.backend.readMeta<BootstrapMarker>("bootstrap");
    assert.equal(marker?.generation, 2);
    assert.equal(marker?.headsDigest, undefined);
    assert.equal(marker?.deleted, undefined);
    assert.equal((await local.backend.list()).length, 30, "the deleted document is still held: the snapshot's listing was not trusted");
  } finally {
    local.close();
  }
});

test("a plain storage backend as the authority walks the list: no capabilities, no digest, and deletions are not reconciled", async () => {
  const fixture = await seededFixture();
  const local = openLocal(new IDBFactory());
  try {
    const authority: StorageBackend = fixture.authority;
    const marker = await bootstrap(authority, local);
    assert.equal(marker.complete, true);
    assert.equal(marker.documentCount, 3);
    assert.equal(marker.headsDigest, undefined);
    assert.equal(local.capabilities, undefined, "no wire adapter, no capabilities read");
    const base = (await fixture.authority.read("notes/alpha")).version;
    await fixture.authority.write("notes/alpha", doc("notes/alpha", "alpha v2\n"), { expectedVersion: base });
    await fixture.authority.delete("notes/gamma");
    const report = await pull(local, authority);
    assert.deepEqual(report.refreshed, ["notes/alpha"]);
    assert.deepEqual(report.unchanged, ["notes/beta"]);
    assert.deepEqual(report.deleted, [], "the list path fetches heads; only a pull by heads removes anything");
    assert.equal((await local.backend.read("notes/gamma")).doc.body, "gamma v1\n");
    const status = await syncStatus(local);
    assert.equal(status.lastPull?.headsDigest, undefined);
    assert.equal(status.lastPull?.unchanged, false);
  } finally {
    local.close();
  }
});

test("a wire authority that reports neither heads nor snapshot takes the list path for both verbs", async () => {
  const fixture = await seededFixture();
  const local = openLocal(new IDBFactory());
  try {
    const withoutFeatures = async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname !== CAPABILITIES) return fixture.hosted(request);
      const answered = await fixture.hosted(request);
      const payload = (await answered.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...payload, heads: false, snapshot: false }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const counted = countingRemote(fixture, withoutFeatures);
    const marker = await bootstrap(counted.remote, local);
    assert.equal(marker.complete, true);
    assert.equal(marker.headsDigest, undefined);
    assert.deepEqual(counted.requests.map((row) => row.path), [ROOT_INDEX, CAPABILITIES, LIST, READ_MANY]);
    counted.requests.length = 0;
    const base = (await fixture.authority.read("notes/beta")).version;
    await fixture.authority.write("notes/beta", doc("notes/beta", "beta v2\n"), { expectedVersion: base });
    const report = await pull(local, counted.remote);
    assert.deepEqual(counted.requests.map((row) => row.path), [LIST, READ_MANY], "the capabilities answer was kept on the bundle");
    assert.deepEqual(report.refreshed, ["notes/beta"]);
    assert.equal((await syncStatus(local)).lastPull?.headsDigest, undefined);
    assert.equal((await local.backend.read("notes/beta")).doc.body, "beta v2\n");
  } finally {
    local.close();
  }
});

test("a capabilities read that fails is not kept: the next verb asks again and proceeds over the wire", async () => {
  const fixture = await seededFixture();
  const local = openLocal(new IDBFactory());
  try {
    let refuse = true;
    const flaky = async (request: Request): Promise<Response> => {
      if (refuse && new URL(request.url).pathname === CAPABILITIES) throw new TypeError("fetch failed: offline");
      return fixture.hosted(request);
    };
    const counted = countingRemote(fixture, flaky);
    await assert.rejects(bootstrap(counted.remote, local), /offline/);
    assert.equal(await isComplete(local), false);
    assert.equal(local.capabilities, undefined, "a rejected read is dropped");
    refuse = false;
    const marker = await bootstrap(counted.remote, local);
    assert.equal(marker.complete, true);
    assert.ok(marker.headsDigest);
    assert.deepEqual(counted.requests.filter((row) => row.path === CAPABILITIES).length, 1);
  } finally {
    local.close();
  }
});
