/**
 * Exact-mode pull fenced by its own marker, over both journaled adapters, with two handles on one
 * store standing for two realms (tabs) of one working copy. A pull marks with a fresh run token
 * as a compare-and-swap over the marker its digest was read from; every refresh and deletion is
 * guarded by one snapshot that pins the pull's marker and the acknowledgement row; completion is
 * a compare-and-swap on the pull's own marker. So an older pull cannot overwrite a newer refresh
 * or an acknowledged edit, a stale listing cannot delete a create an acknowledgement just brought
 * in, and a pull's digest is never recorded over another pull's stale deletion. A superseded pull
 * returns its report with `superseded`, and the runtime's sync stays online and ok. A lone pull,
 * the 304 path and an adapter without `journalSnapshotCas` behave as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

import { RemoteBackend, type OkfDocument, type StorageBackend } from "@superbee/core";
import { IndexedDbBackend } from "@superbee/core/indexeddb-backend";
import type { JournaledBackend, MetaWriteOptions } from "@superbee/core/journaled-backend";

import { baseKey, bootstrap, commitLocal, openLocalBundle, pull, pushWithRole, syncStatus, type LocalBundle, type PullMarker, type SharedBase } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime, PullSupersededError } from "../src/platform/browser-local.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { BASE_URL, BUNDLE, createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";

const NOW = "2026-09-10T12:00:00.000Z";
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };
const ADAPTERS = ["indexeddb", "memory"] as const;
type Adapter = (typeof ADAPTERS)[number];
const HEADS = `/v0/bundles/${BUNDLE}/heads`;
const READ_MANY = `/v0/bundles/${BUNDLE}/docs:read-many`;

function doc(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title: `Note ${id}` }, body };
}

function edit(body: string) {
  return { buildCandidate: (existing: OkfDocument | undefined) => ({ frontmatter: existing!.frontmatter, body }), now: () => NOW };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Two handles on one store: two realms of the same working copy. */
function twoRealms(adapter: Adapter): { a: LocalBundle; b: LocalBundle; close: () => void } {
  if (adapter === "memory") {
    const backend = new MemoryJournaledBackend();
    const a = openLocalBundle("fence", { backend }), b = openLocalBundle("fence", { backend });
    return { a, b, close: () => { a.close(); b.close(); } };
  }
  const factory = new IDBFactory();
  const a = openLocalBundle("fence", { backend: new IndexedDbBackend({ databaseName: "fence", indexedDB: factory }) });
  const b = openLocalBundle("fence", { backend: new IndexedDbBackend({ databaseName: "fence", indexedDB: factory }) });
  return { a, b, close: () => { a.close(); b.close(); } };
}

/**
 * The read side with one verb held open after the authority answered: `entered` resolves once
 * the first call has its answer, which is returned only after `release`.
 */
function holdAfter(remote: StorageBackend, verb: "readMany" | "heads"): { remote: StorageBackend; entered: Promise<void>; release: () => void } {
  const entered = deferred(), gate = deferred();
  let first = true;
  const proxy = new Proxy(remote, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== verb || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const answer = await value.apply(target, args);
        if (first) {
          first = false;
          entered.resolve();
          await gate.promise;
        }
        return answer;
      };
    },
  }) as StorageBackend;
  return { remote: proxy, entered: entered.promise, release: () => gate.resolve() };
}

/**
 * The read side with `hook` run after each of the first `times` heads answers, before the
 * answer is returned: the pull asking has marked and listed, and writes nothing yet.
 */
function afterEachHeads(remote: StorageBackend, times: number, hook: () => Promise<void>): StorageBackend {
  let calls = 0;
  return new Proxy(remote, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "heads" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const answer = await value.apply(target, args);
        if (calls++ < times) await hook();
        return answer;
      };
    },
  }) as StorageBackend;
}

/** A fresh wire adapter over the fixture recording each request, its status, and the `If-None-Match` it carried. */
function countingRemote(fixture: RemoteFixture): { remote: RemoteBackend; requests: Array<{ method: string; path: string; status: number }>; ifNoneMatch: Array<string | null> } {
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const ifNoneMatch: Array<string | null> = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    const response = await fixture.hosted(request);
    requests.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
    ifNoneMatch.push(request.headers.get("If-None-Match"));
    return response;
  };
  return { remote: new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl, maxRetries: 0 }), requests, ifNoneMatch };
}

async function body(local: LocalBundle, id: string): Promise<string> {
  return (await local.backend.read(id)).doc.body;
}

async function lastPull(local: LocalBundle): Promise<PullMarker | null> {
  return (await syncStatus(local)).lastPull;
}

/** Freeze the clock (`new Date()` and `Date.now`) at one instant; returns the restore. */
function freezeClock(at: string): () => void {
  const Real = Date;
  const instant = Real.parse(at);
  class Frozen extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(instant);
      else super(...(args as [number]));
    }
    static override now(): number {
      return instant;
    }
  }
  globalThis.Date = Frozen as DateConstructor;
  return () => {
    globalThis.Date = Real;
  };
}

for (const adapter of ADAPTERS) {
  test(`${adapter}: an older pull cannot overwrite a newer refresh; it stops superseded, the newer pull's digest stands, and the next pull is a 304 over the authority's state`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const held = holdAfter(fixture.remote, "readMany");
      const older = pull(b, held.remote);
      await held.entered; // b now holds x at v1
      const v2 = await fixture.authority.write("notes/x", doc("notes/x", "x v2\n"));
      const newer = await pull(a, fixture.remote);
      assert.deepEqual(newer.refreshed, ["notes/x"]);
      const newerMarker = await lastPull(a);
      held.release();
      const report = await older;

      assert.equal(report.superseded, true);
      assert.deepEqual(report.refreshed, []);
      assert.equal(await body(a, "notes/x"), "x v2\n");
      assert.equal((await a.backend.readMeta<SharedBase>(baseKey("notes/x")))?.version, v2);
      assert.deepEqual(await lastPull(a), newerMarker, "the superseded pull recorded no marker");
      const again = countingRemote(fixture);
      await pull(a, again.remote);
      assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
      assert.equal(await body(a, "notes/x"), "x v2\n");
    } finally {
      close();
    }
  });

  test(`${adapter}: an older pull overlapping another realm's pull and acknowledged edit keeps the edit and its base`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const held = holdAfter(fixture.remote, "readMany");
      const older = pull(b, held.remote);
      await held.entered; // b holds x at v1
      await pull(a, fixture.remote);
      const committed = await commitLocal(a, "notes/x", edit("x v2 (local edit)\n"));
      const pushed = await pushWithRole(a, fixture.transport, { write: immediate });
      assert.deepEqual(pushed.result?.settled.map((row) => row.state), ["acknowledged"]);
      held.release();
      const report = await older;

      assert.equal(report.superseded, true);
      assert.equal(await body(a, "notes/x"), "x v2 (local edit)\n");
      assert.equal((await a.backend.readMeta<SharedBase>(baseKey("notes/x")))?.version, committed.version);
      assert.equal((await fixture.authority.read("notes/x")).version, committed.version);
    } finally {
      close();
    }
  });

  test(`${adapter}: a stale listing does not delete a create another realm's acknowledgement brought in while the pull was listing`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await commitLocal(a, "notes/y", { mode: "patch", onAbsent: "create", buildCandidate: () => ({ frontmatter: { type: "Note", title: "y" }, body: "mine\n" }), now: () => NOW });
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const held = holdAfter(fixture.remote, "heads");
      const stale = pull(b, held.remote);
      await held.entered; // b's listing predates y at the authority
      const pushed = await pushWithRole(a, fixture.transport, { write: immediate });
      assert.deepEqual(pushed.result?.settled.map((row) => row.state), ["acknowledged"]);
      held.release();
      const report = await stale;

      assert.equal(report.superseded, true);
      assert.deepEqual(report.deleted, []);
      assert.equal(await body(a, "notes/y"), "mine\n");
      // The next pull converges on the authority, which holds y.
      const next = await pull(a, fixture.remote);
      assert.equal(next.superseded, undefined);
      assert.deepEqual((await a.backend.list()).sort(), (await fixture.authority.list()).sort());
      assert.equal(await body(a, "notes/x"), "x v1\n");
    } finally {
      close();
    }
  });

  test(`${adapter}: QA: an acknowledgement at the same clock reading as the one a pull fenced on still supersedes that pull's stale deletion`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    const restore = freezeClock(NOW);
    try {
      await bootstrap(fixture.remote, a);
      await commitLocal(a, "notes/x", edit("x v1 (local edit)\n"));
      assert.deepEqual((await pushWithRole(a, fixture.transport, { write: immediate })).result?.settled.map((row) => row.state), ["acknowledged"]);
      await commitLocal(a, "notes/y", { mode: "patch", onAbsent: "create", buildCandidate: () => ({ frontmatter: { type: "Note", title: "y" }, body: "mine\n" }), now: () => NOW });
      const held = holdAfter(fixture.remote, "heads");
      const stale = pull(b, held.remote);
      await held.entered; // b fenced on the first acknowledgement; its listing predates y
      assert.deepEqual((await pushWithRole(a, fixture.transport, { write: immediate })).result?.settled.map((row) => row.state), ["acknowledged"]);
      held.release();
      const report = await stale;

      assert.equal(report.superseded, true);
      assert.deepEqual(report.deleted, []);
      assert.equal(await body(a, "notes/y"), "mine\n");
    } finally {
      restore();
      close();
    }
  });

  test(`${adapter}: two pulls straddling a marker: the first one's stale deletion is not made, so the second one's digest never names a document the copy lacks`, async () => {
    const fixture = await createRemoteFixture();
    const x = doc("notes/x", "x v0\n");
    const first = await fixture.authority.write("notes/x", x);
    await fixture.authority.write("notes/z", doc("notes/z", "z v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.delete("notes/x");
      const t1 = holdAfter(fixture.remote, "heads");
      const earlier = pull(b, t1.remote);
      await t1.entered; // the first pull lists x as absent
      // The same bytes again: the authority is back at the state the working copy matches.
      assert.equal(await fixture.authority.write("notes/x", x), first);
      const t2 = holdAfter(fixture.remote, "heads");
      const later = pull(a, t2.remote);
      await t2.entered; // the second pull has marked and been answered
      t1.release();
      const earlierReport = await earlier;
      t2.release();
      const laterReport = await later;

      assert.equal(earlierReport.superseded, true);
      assert.deepEqual(earlierReport.deleted, []);
      assert.equal(laterReport.superseded, undefined);
      assert.deepEqual((await a.backend.list()).sort(), ["notes/x", "notes/z"]);
      const again = countingRemote(fixture);
      await pull(a, again.remote);
      assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
      assert.deepEqual((await a.backend.list()).sort(), (await fixture.authority.list()).sort());
    } finally {
      close();
    }
  });

  test(`${adapter}: of two pulls completing in reverse order, only the later-marked one records its marker and digest`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const t1 = holdAfter(fixture.remote, "heads");
      const earlier = pull(b, t1.remote);
      await t1.entered;
      const earlierRun = (await lastPull(a))?.run;
      const later = await pull(a, fixture.remote);
      const laterMarker = await lastPull(a);
      t1.release();
      const earlierReport = await earlier;

      assert.equal(earlierReport.superseded, true);
      assert.equal(later.superseded, undefined);
      assert.ok(earlierRun && laterMarker?.run && earlierRun !== laterMarker.run);
      assert.equal(laterMarker?.run, (await lastPull(b))?.run);
      assert.notEqual(laterMarker?.headsDigest, undefined);
      assert.deepEqual(await lastPull(a), laterMarker);
    } finally {
      close();
    }
  });

  test(`${adapter}: a lone pull completes with its own run token, the request counts are unchanged, and the 304 after it records the same digest`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    await fixture.authority.write("notes/z", doc("notes/z", "z v0\n"));
    const { a, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const counted = countingRemote(fixture);
      const report = await pull(a, counted.remote);
      assert.deepEqual(report, { refreshed: ["notes/x"], held: [], unchanged: ["notes/z"], deleted: [] });
      assert.deepEqual(counted.requests.map((row) => `${row.method} ${row.path} ${row.status}`), [`GET ${HEADS} 200`, `POST ${READ_MANY} 200`]);
      const marker = await lastPull(a);
      assert.equal(typeof marker?.run, "string");
      assert.notEqual(marker?.completedAt, null);
      assert.notEqual(marker?.headsDigest, undefined);

      const again = countingRemote(fixture);
      const unchanged = await pull(a, again.remote);
      assert.deepEqual(again.requests, [{ method: "GET", path: HEADS, status: 304 }]);
      assert.deepEqual(unchanged, { refreshed: [], held: [], unchanged: ["notes/x", "notes/z"], deleted: [] });
      const after = await lastPull(a);
      assert.equal(after?.unchanged, true);
      assert.equal(after?.headsDigest, marker?.headsDigest);
      assert.notEqual(after?.run, marker?.run);
    } finally {
      close();
    }
  });

  test(`${adapter}: a pull whose marker changed between reading its digest and marking re-reads it, and asks unconditionally rather than offer a digest another pull may have moved past`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      let raced = false;
      // Another realm's pull marks just before this one does, once.
      const racing = new Proxy(a.backend, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "writeMeta") return typeof value === "function" ? value.bind(target) : value;
          return async (key: string, row: unknown, options?: MetaWriteOptions) => {
            if (key === "pull" && !raced) {
              raced = true;
              await target.writeMeta("pull", { startedAt: new Date().toISOString(), completedAt: null, refreshed: 0, unchanged: false, run: "rival" } satisfies PullMarker);
            }
            return target.writeMeta(key, row, options);
          };
        },
      }) as JournaledBackend;
      const counted = countingRemote(fixture);
      const report = await pull(racing, counted.remote);

      assert.equal(report.superseded, undefined);
      assert.deepEqual(counted.ifNoneMatch.filter((_, index) => counted.requests[index]!.path === HEADS), [null]);
      const marker = await lastPull(a);
      assert.notEqual(marker?.run, "rival");
      assert.notEqual(marker?.completedAt, null);
      assert.notEqual(marker?.headsDigest, undefined);
    } finally {
      close();
    }
  });

  test(`${adapter}: QA: a pull that loses every marker race marks unconditionally after the bound and asks without a digest, though the marker it last read offers a current one`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await pull(a, fixture.remote);
      const settled = await lastPull(a);
      assert.notEqual(settled?.headsDigest, undefined);
      const rivals: string[] = [];
      // Another realm's pull completes with the current digest just before each guarded mark.
      const racing = new Proxy(a.backend, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "writeMeta") return typeof value === "function" ? value.bind(target) : value;
          return async (key: string, row: unknown, options?: MetaWriteOptions) => {
            if (key === "pull" && options?.expected !== undefined && (row as PullMarker).completedAt === null) {
              const run = `rival-${rivals.length}`;
              rivals.push(run);
              await target.writeMeta("pull", { ...settled!, startedAt: new Date().toISOString(), run } satisfies PullMarker);
            }
            return target.writeMeta(key, row, options);
          };
        },
      }) as JournaledBackend;
      const counted = countingRemote(fixture);
      const report = await pull(racing, counted.remote);

      assert.equal(report.superseded, undefined);
      assert.deepEqual(rivals, ["rival-0", "rival-1", "rival-2"], "three guarded marks lost; the fourth is unconditional");
      assert.deepEqual(counted.ifNoneMatch.filter((_, index) => counted.requests[index]!.path === HEADS), [null], "the unconditional mark offers no digest");
      assert.deepEqual(counted.requests.filter((row) => row.path === HEADS).map((row) => row.status), [200]);
      const marker = await lastPull(a);
      assert.ok(marker?.run !== undefined && !rivals.includes(marker.run));
      assert.notEqual(marker?.completedAt, null);
      assert.equal(marker?.headsDigest, settled?.headsDigest);
    } finally {
      close();
    }
  });

  test(`${adapter}: a runtime sync whose pull another realm supersedes reports online and ok`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, a);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const held = holdAfter(fixture.remote, "heads");
      const runtime = createBrowserLocalRuntime({ local: b, remote: held.remote, transport: fixture.transport, write: immediate, locks: null });
      const syncing = runtime.sync();
      await held.entered;
      await pull(a, fixture.remote);
      const marker = await lastPull(a);
      held.release();
      const status = await syncing;

      assert.equal(status.online, true);
      assert.deepEqual(status.lastSync, { ok: true });
      // QA: the superseded pull ran once more and completed its own marker.
      const rerun = await lastPull(a);
      assert.ok(rerun?.run !== undefined && rerun.run !== marker?.run);
      assert.notEqual(rerun?.completedAt, null);
      assert.equal(await body(a, "notes/x"), "x v1\n");
    } finally {
      close();
    }
  });

  test(`${adapter}: QA: a runtime sync superseded by a realm that never finishes pulls once more, so that one sync leaves the copy current`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, b);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const held = holdAfter(fixture.remote, "readMany");
      const runtime = createBrowserLocalRuntime({ local: b, remote: held.remote, transport: fixture.transport, write: immediate, locks: null });
      const syncing = runtime.sync();
      await held.entered; // b holds x at v1
      const dead = holdAfter(fixture.remote, "heads");
      void pull(a, dead.remote); // a marks, then its tab is closed: this pull never finishes
      await dead.entered;
      held.release();
      const status = await syncing;

      assert.deepEqual(status.lastSync, { ok: true });
      assert.equal(await body(b, "notes/x"), "x v1\n");
      assert.notEqual((await lastPull(b))?.completedAt, null);
    } finally {
      close();
    }
  });

  test(`${adapter}: QA: a runtime sync accepting refused deletions whose pull is superseded pulls once more, and never reports ok with the refusal gone and nothing applied`, async () => {
    const fixture = await createRemoteFixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `seed/d${String(i).padStart(2, "0")}`;
      await fixture.authority.write(id, doc(id, "s\n"));
      ids.push(id);
    }
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, b);
      for (const id of ids.slice(0, 12)) await fixture.authority.delete(id);
      const refused = (await pull(b, fixture.remote)).refused;
      assert.ok(refused);
      const held = holdAfter(fixture.remote, "heads");
      const runtime = createBrowserLocalRuntime({ local: b, remote: held.remote, transport: fixture.transport, write: immediate, locks: null });
      const accepting = runtime.sync({ acceptRefusedDeletions: refused });
      await held.entered; // b's listing is the refused one
      // Another realm's acknowledged edit supersedes b's pull and moves the listing.
      await commitLocal(a, "seed/d15", edit("edited elsewhere\n"));
      assert.deepEqual((await pushWithRole(a, fixture.transport, { write: immediate })).result?.settled.map((row) => row.state), ["acknowledged"]);
      held.release();
      const status = await accepting;

      assert.equal(status.lastSync?.ok, true);
      assert.equal((await b.backend.list()).length, 20, "the moved listing is refused afresh, as for any sync");
      assert.equal(status.lastSync?.refusedDeletions?.deletions, 12);
      assert.notEqual(status.lastSync?.refusedDeletions?.digest, refused.digest);
    } finally {
      close();
    }
  });

  test(`${adapter}: review: a runtime sync accepting refused deletions whose pull is superseded twice rejects, applies nothing, and keeps the refusal for a retry that applies it`, async () => {
    const fixture = await createRemoteFixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `seed/d${String(i).padStart(2, "0")}`;
      await fixture.authority.write(id, doc(id, "s\n"));
      ids.push(id);
    }
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, b);
      for (const id of ids.slice(0, 12)) await fixture.authority.delete(id);
      const refused = (await pull(b, fixture.remote)).refused;
      assert.ok(refused);
      // Each of b's two pulls lists, then another realm marks a pull whose tab is then closed.
      const superseding = afterEachHeads(fixture.remote, 2, async () => {
        const dead = holdAfter(fixture.remote, "heads");
        void pull(a, dead.remote);
        await dead.entered;
      });
      const runtime = createBrowserLocalRuntime({ local: b, remote: superseding, transport: fixture.transport, write: immediate, locks: null });
      await assert.rejects(runtime.sync({ acceptRefusedDeletions: refused }), PullSupersededError);

      assert.equal((await b.backend.list()).length, 20, "nothing was applied");
      const status = await runtime.syncStatus();
      assert.equal(status.online, true);
      assert.equal(status.lastSync?.ok, false);
      assert.match(status.lastSync?.error ?? "", /^PullSupersededError: /);
      assert.deepEqual(status.lastSync?.refusedDeletions, refused, "the refusal stays reported for a retry");
      assert.equal((await lastPull(b))?.completedAt, null, "the marker is the closed tab's unfinished one");

      const applied = await runtime.sync({ acceptRefusedDeletions: status.lastSync!.refusedDeletions! });
      assert.equal((await b.backend.list()).length, 8, "the retry applied the accepted deletions");
      assert.equal(applied.lastSync?.ok, true);
      assert.equal(applied.lastSync?.refusedDeletions, undefined);
    } finally {
      close();
    }
  });

  test(`${adapter}: review: the refusal a doubly superseded accepting sync keeps is not reported again once another realm has applied it and a later pull is unfinished`, async () => {
    const fixture = await createRemoteFixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `seed/d${String(i).padStart(2, "0")}`;
      await fixture.authority.write(id, doc(id, "s\n"));
      ids.push(id);
    }
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, b);
      for (const id of ids.slice(0, 12)) await fixture.authority.delete(id);
      const refused = (await pull(b, fixture.remote)).refused;
      assert.ok(refused);
      const superseding = afterEachHeads(fixture.remote, 2, async () => {
        const dead = holdAfter(fixture.remote, "heads");
        void pull(a, dead.remote);
        await dead.entered;
      });
      const runtime = createBrowserLocalRuntime({ local: b, remote: superseding, transport: fixture.transport, write: immediate, locks: null });
      await assert.rejects(runtime.sync({ acceptRefusedDeletions: refused }), PullSupersededError);
      assert.deepEqual((await runtime.syncStatus()).lastSync?.refusedDeletions, refused);

      // Realm a applies the same acceptance to completion.
      const applied = await pull(a, fixture.remote, { acceptRefusedDeletions: refused });
      assert.equal(applied.deleted.length, 12);
      assert.equal((await b.backend.list()).length, 8);
      assert.equal((await runtime.syncStatus()).lastSync?.refusedDeletions, undefined);

      // A later pull marks and its tab is closed: its unfinished marker is not the one b's sync left.
      const dead = holdAfter(fixture.remote, "heads");
      void pull(a, dead.remote);
      await dead.entered;
      assert.equal((await lastPull(b))?.completedAt, null);
      const status = await runtime.syncStatus();
      assert.equal(status.lastSync?.ok, false);
      assert.equal(status.lastSync?.refusedDeletions, undefined, "the applied refusal is not reported again");
    } finally {
      close();
    }
  });

  test(`${adapter}: review: a plain runtime sync whose pull is superseded twice still resolves online and ok`, async () => {
    const fixture = await createRemoteFixture();
    await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
    const { a, b, close } = twoRealms(adapter);
    try {
      await bootstrap(fixture.remote, b);
      await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
      const superseding = afterEachHeads(fixture.remote, 2, async () => {
        const dead = holdAfter(fixture.remote, "heads");
        void pull(a, dead.remote);
        await dead.entered;
      });
      const runtime = createBrowserLocalRuntime({ local: b, remote: superseding, transport: fixture.transport, write: immediate, locks: null });
      const status = await runtime.sync();

      assert.equal(status.online, true);
      assert.deepEqual(status.lastSync, { ok: true });
      assert.equal(await body(b, "notes/x"), "x v0\n", "neither superseded pull wrote the stale-fenced refresh");
      assert.equal((await lastPull(b))?.completedAt, null);
    } finally {
      close();
    }
  });
}

test("an adapter without journalSnapshotCas pulls unfenced, as before: no run token, and the marker is written unconditionally", async () => {
  const fixture = await createRemoteFixture();
  await fixture.authority.write("notes/x", doc("notes/x", "x v0\n"));
  const store = new MemoryJournaledBackend();
  const writes: Array<MetaWriteOptions | undefined> = [];
  const plain = new Proxy(store, {
    get(target, prop) {
      if (prop === "journalSnapshotCas") return undefined;
      const value = Reflect.get(target, prop, target);
      if (prop === "writeMeta") {
        return (key: string, row: unknown, options?: MetaWriteOptions) => {
          if (key === "pull") writes.push(options);
          return target.writeMeta(key, row, options);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as JournaledBackend;
  const local = openLocalBundle("plain", { backend: plain });
  try {
    await bootstrap(fixture.remote, local);
    await fixture.authority.write("notes/x", doc("notes/x", "x v1\n"));
    const report = await pull(local, fixture.remote);
    assert.deepEqual(report, { refreshed: ["notes/x"], held: [], unchanged: [], deleted: [] });
    const marker = await lastPull(local);
    assert.equal(marker?.run, undefined);
    assert.notEqual(marker?.headsDigest, undefined);
    assert.ok(writes.length === 2 && writes.every((options) => options === undefined || options.expected === undefined));
  } finally {
    local.close();
  }
});
