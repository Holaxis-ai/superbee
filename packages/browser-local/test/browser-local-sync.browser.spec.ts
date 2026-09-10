/**
 * The browser-local sync claim in real Chromium: a working copy bootstraps from a remote
 * authority over HTTP, commits offline with pending intents that survive a reload and a
 * browser restart, synchronizes nonconflicting changes on reconnect so a second client observes
 * them, holds the push role under a Web Lock so concurrent tabs never double-apply, and
 * preserves local edits through conflict, lost acknowledgement, quota failure, tab termination
 * and access revocation without ever reporting false synchronization.
 *
 * Harness: the page (test/fixtures/driver.ts, served by test/fixtures/harness.ts) talks to the
 * disposable authority (test/fixtures/remote-fixture.ts: the reference router and outcome
 * store with fault injection around them) served as a second HTTP origin on 127.0.0.1
 * (test/fixtures/remote-http.ts). The fixture's knobs are flipped from the Node side of the
 * spec; the page never sees them. Every scenario here has a Node twin in sync.test.ts
 * over fake-indexeddb; this file is the same runtime in a real page with real IndexedDB, real
 * fetch, real Web Locks, real reloads and real page termination.
 *
 * Simulated versus real: the authority's failures are knobs on a real HTTP origin, and page
 * death is a real page close. The quota failure (scenario h) is armed, not induced: the wrapped
 * factory makes the next `put` throw a QuotaExceededError synchronously, whereas a real
 * exhausted origin surfaces the same DOMException through the put request's error event. Both
 * reach the adapter's transaction guard, abort the transaction, and reject the commit with the
 * same error name; the throw path is what this file exercises.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import path from "node:path";

import { chromium, expect, test, type Page } from "@playwright/test";

import type { OkfDocument } from "@superbee/core";

import type { DriverError, IntentView } from "./fixtures/driver.ts";
import { call, isDriverError, load as loadAt, ok, startDriverServer, waitForDriver, type DriverServer } from "./fixtures/harness.ts";
import { createRemoteFixture, type RemoteFixture } from "./fixtures/remote-fixture.ts";
import { serveRemoteFixture, type ServedFixture } from "./fixtures/remote-http.ts";

const NOTE_IDS = ["notes/alpha", "notes/beta", "notes/gamma", "notes/delta", "notes/epsilon", "notes/zeta"] as const;

function note(id: string, body: string): OkfDocument {
  return { id, frontmatter: { type: "Note", title: `Note ${id}`, timestamp: "2026-09-01T00:00:00.000Z" }, body };
}

async function seededFixture(): Promise<RemoteFixture> {
  const fixture = await createRemoteFixture();
  for (const id of NOTE_IDS) await fixture.authority.write(id, note(id, `${id} v1\n`));
  return fixture;
}

let driver: DriverServer;
let served: ServedFixture;

test.beforeAll(async () => {
  driver = await startDriverServer();
});

test.afterAll(async () => {
  await driver.close();
});

test.beforeEach(async () => {
  served = await serveRemoteFixture(await seededFixture());
});

test.afterEach(async () => {
  await served.close();
});

const load = (page: Page) => loadAt(page, driver.origin);

function remoteRequests(): number {
  return served.requests.length;
}

/** Requests the bridge saw for the identified-write and lookup routes, by kind. */
function trafficSummary(): { puts: number; lookups: number; preflights: number } {
  let puts = 0;
  let lookups = 0;
  let preflights = 0;
  for (const row of served.requests) {
    if (row.method === "OPTIONS") preflights += 1;
    else if (row.method === "PUT") puts += 1;
    else if (row.method === "GET" && /^\/v0\/bundles\/[^/]+\/operations\//.test(row.path)) lookups += 1;
  }
  return { puts, lookups, preflights };
}

/** Cut the page off from the authority: the carrier refuses in-page, and the route aborts anything that slips past. */
async function goOffline(page: Page): Promise<() => Promise<void>> {
  await page.route(`${served.origin}/**`, (route) => route.abort("internetdisconnected"));
  ok(await call(page, "setOffline", true), "setOffline");
  return async () => {
    ok(await call(page, "setOffline", false), "setOffline");
    await page.unroute(`${served.origin}/**`);
  };
}

/** Bootstrap `name` from the authority, go offline, and commit two edits; returns the pending intents. */
async function bootstrapAndCommitOffline(page: Page, name: string): Promise<{ intents: IntentView[]; backOnline: () => Promise<void> }> {
  const booted = ok(await call(page, "bootstrap", served.origin, name), "bootstrap");
  expect(booted.marker.complete).toBe(true);
  expect(booted.marker.documentCount).toBe(NOTE_IDS.length);
  const backOnline = await goOffline(page);
  const alpha = ok(await call(page, "commitLocal", "notes/alpha", "notes/alpha v2 (local)\n"), "commit alpha");
  const beta = ok(await call(page, "commitLocal", "notes/beta", "notes/beta v2 (local)\n"), "commit beta");
  expect(alpha.changed).toBe(true);
  expect(beta.changed).toBe(true);
  return { intents: [alpha.intent!, beta.intent!], backOnline };
}

test("a: bootstrap from the remote, then read, query and commit offline with zero requests and pending intents visible per document", async ({ page }) => {
  await load(page);
  const remoteHits: string[] = [];
  /** Every request the page issues to any origin, the driver origin included. */
  const allHits: string[] = [];
  page.on("request", (request) => {
    allHits.push(`${request.method()} ${request.url()}`);
    if (request.url().startsWith(served.origin)) remoteHits.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  const booted = ok(await call(page, "bootstrap", served.origin, "a-offline"), "bootstrap");
  expect(booted.marker).toMatchObject({ complete: true, documentCount: NOTE_IDS.length, generation: 1 });
  expect(booted.marker.findings).toBeUndefined();
  const sharedAlpha = (await served.fixture.authority.read("notes/alpha")).version;
  const hitsAfterBootstrap = remoteHits.length;
  const allHitsAfterBootstrap = allHits.length;
  const serverHitsAfterBootstrap = remoteRequests();
  expect(hitsAfterBootstrap).toBeGreaterThan(0);

  await goOffline(page);

  // Read, query, and validate-by-read while offline: every answer comes from IndexedDB.
  const before = ok(await call(page, "readSync", "notes/alpha"), "readSync before");
  expect(before.version).toBe(sharedAlpha);
  expect(before.shared).toEqual({ baseVersion: sharedAlpha, acknowledged: true, unsettled: [] });
  expect(ok(await call(page, "query", "notes/"), "query").map((head) => head.id)).toEqual([...NOTE_IDS].sort());

  const alpha = ok(await call(page, "commitLocal", "notes/alpha", "notes/alpha v2 (local)\n"), "commit alpha");
  const beta = ok(await call(page, "commitLocal", "notes/beta", "notes/beta v2 (local)\n"), "commit beta");
  expect(alpha.intent).toMatchObject({ state: "pending", attempts: 0, base: sharedAlpha, local: alpha.version });
  expect(beta.intent).toMatchObject({ state: "pending", attempts: 0 });

  // Local persistence and shared acknowledgement are separate answers for one document.
  const after = ok(await call(page, "readSync", "notes/alpha"), "readSync after");
  expect(after.doc.body).toBe("notes/alpha v2 (local)\n");
  expect(after.local).toEqual({ persisted: true, version: alpha.version });
  expect(after.shared.baseVersion).toBe(sharedAlpha);
  expect(after.shared.acknowledged).toBe(false);
  expect(after.shared.unsettled.map((row) => [row.requestId, row.state])).toEqual([[alpha.intent!.requestId, "pending"]]);

  const status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.counts.pending).toBe(2);
  expect(status.counts.acknowledged).toBe(0);
  expect(status.paused).toBe(false);

  // An offline push does not turn into a false acknowledgement: both intents stay pending.
  const pushed = ok(await call(page, "push"), "push offline");
  expect(pushed.held).toBe(true);
  expect(pushed.held && pushed.result.settled.map((row) => row.state)).toEqual(["pending", "pending"]);
  expect(ok(await call(page, "intents", "pending"), "intents").map((row) => row.attempts)).toEqual([1, 1]);

  // Nothing reached the network: not to the authority, not to any origin at all, not at the server.
  expect(remoteHits.length).toBe(hitsAfterBootstrap);
  expect(allHits.slice(allHitsAfterBootstrap)).toEqual([]);
  expect(remoteRequests()).toBe(serverHitsAfterBootstrap);
  expect((await served.fixture.authority.read("notes/alpha")).doc.body).toBe("notes/alpha v1\n");
  const offlineState = ok(await call(page, "setOffline", true), "setOffline");
  expect(offlineState.submittedWhileOffline.length).toBeGreaterThan(0);
});

test("b: the working bundle and its pending intents survive an offline reload and a browser restart, and bootstrap stays complete", async ({ browser }) => {
  test.setTimeout(120_000);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "superbee-browser-local-sync-"));
  const name = "b-persist";
  try {
    let expected: IntentView[] = [];
    const first = await chromium.launchPersistentContext(userDataDir, { headless: true });
    try {
      const page = first.pages()[0] ?? (await first.newPage());
      await load(page);
      expected = (await bootstrapAndCommitOffline(page, name)).intents;

      // Reload offline: the driver origin still answers, the authority does not.
      await page.route(`${served.origin}/**`, (route) => route.abort("internetdisconnected"));
      await page.reload({ waitUntil: "networkidle" });
      await waitForDriver(page);
      await expectRecovered(page, name, expected);
    } finally {
      await first.close();
    }

    const second = await chromium.launchPersistentContext(userDataDir, { headless: true });
    try {
      const page = second.pages()[0] ?? (await second.newPage());
      await page.route(`${served.origin}/**`, (route) => route.abort("internetdisconnected"));
      await load(page);
      await expectRecovered(page, name, expected);
      test.info().annotations.push({ type: "browser-restart", description: `working bundle and 2 pending intents survived a Chromium ${browser.version()} restart` });
    } finally {
      await second.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function expectRecovered(page: Page, name: string, expected: IntentView[]): Promise<void> {
  const attached = ok(await call(page, "attach", served.origin, name), "attach");
  expect(attached.complete).toBe(true);
  ok(await call(page, "setOffline", true), "setOffline");
  const serverHits = remoteRequests();
  expect(ok(await call(page, "isComplete"), "isComplete").complete).toBe(true);
  expect(ok(await call(page, "read", "notes/alpha"), "read alpha").doc.body).toBe("notes/alpha v2 (local)\n");
  expect(ok(await call(page, "read", "notes/beta"), "read beta").doc.body).toBe("notes/beta v2 (local)\n");
  expect(ok(await call(page, "read", "notes/gamma"), "read gamma").doc.body).toBe("notes/gamma v1\n");
  const pending = ok(await call(page, "intents", "pending"), "intents");
  expect(pending.map((row) => [row.requestId, row.target, row.base, row.local])).toEqual(expected.map((row) => [row.requestId, row.target, row.base, row.local]));
  const status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status).toMatchObject({ bootstrapComplete: true, generation: 1, paused: false });
  expect(status.counts.pending).toBe(2);
  const alpha = ok(await call(page, "readSync", "notes/alpha"), "readSync");
  expect(alpha.local.persisted).toBe(true);
  expect(alpha.shared.acknowledged).toBe(false);
  expect(remoteRequests()).toBe(serverHits);
}

test("c: reconnect and push acknowledges both intents once each, and a second client bootstraps and observes them", async ({ context }) => {
  const page = await context.newPage();
  await load(page);
  const { intents, backOnline } = await bootstrapAndCommitOffline(page, "c-reconnect");
  // A push attempt while offline leaves both attempted once, so the reconnect begins with a lookup.
  ok(await call(page, "push"), "push offline");
  expect(served.fixture.history).toEqual([]);

  await backOnline();
  const pushed = ok(await call(page, "push"), "push online");
  expect(pushed.held).toBe(true);
  expect(pushed.held && pushed.result.settled.map((row) => row.state)).toEqual(["acknowledged", "acknowledged"]);
  const status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.counts).toMatchObject({ pending: 0, in_flight: 0, acknowledged: 2, conflict: 0, refused: 0 });
  expect(served.fixture.history.map((row) => [row.requestId, row.id, row.status])).toEqual(intents.map((row) => [row.requestId, row.target, 200]));
  expect(served.fixture.deduplicated).toEqual([]);
  const traffic = trafficSummary();
  expect(traffic.puts).toBe(2);
  expect(traffic.lookups).toBeGreaterThanOrEqual(2);
  for (const intent of intents) {
    const settled = ok(await call(page, "intent", intent.requestId), "intent");
    expect(settled).toMatchObject({ state: "acknowledged", acknowledgedVersion: intent.local, finding: null });
    const sync = ok(await call(page, "readSync", intent.target), "readSync");
    expect(sync.shared).toEqual({ baseVersion: intent.local, acknowledged: true, unsettled: [] });
  }
  expect((await served.fixture.authority.read("notes/alpha")).doc.body).toBe("notes/alpha v2 (local)\n");
  expect((await served.fixture.authority.read("notes/beta")).doc.body).toBe("notes/beta v2 (local)\n");

  // A second client with its own store bootstraps from the authority and sees both edits.
  const other = await context.newPage();
  await load(other);
  const booted = ok(await call(other, "bootstrap", served.origin, "c-observer"), "bootstrap observer");
  expect(booted.marker.complete).toBe(true);
  expect(ok(await call(other, "read", "notes/alpha"), "observer alpha").doc.body).toBe("notes/alpha v2 (local)\n");
  expect(ok(await call(other, "read", "notes/beta"), "observer beta")).toMatchObject({ version: intents[1]!.local });
  expect(ok(await call(other, "syncStatus"), "observer status").counts.pending).toBe(0);
  test.info().annotations.push({ type: "reconcile", description: `two-intent push after reconnect: ${pushed.ms.toFixed(1)} ms in page (lookups ${traffic.lookups}, preflights ${traffic.preflights})` });
});

test("d: a conflicting remote edit becomes an explicit conflict with base, local and remote readable; nothing is overwritten", async ({ page }) => {
  await load(page);
  ok(await call(page, "bootstrap", served.origin, "d-conflict"), "bootstrap");
  const base = (await served.fixture.authority.read("notes/alpha")).version;
  const committed = ok(await call(page, "commitLocal", "notes/alpha", "notes/alpha local edit\n"), "commit");
  // Someone else moves the shared head through the fixture's own router first.
  const remoteVersion = await served.fixture.remote.write("notes/alpha", note("notes/alpha", "notes/alpha remote edit\n"), { expectedVersion: base });
  expect(remoteVersion).not.toBe(base);

  // A pull before push holds the document instead of replacing the base under the pending edit.
  const pulled = ok(await call(page, "pull"), "pull");
  expect(pulled.held).toEqual(["notes/alpha"]);
  expect(ok(await call(page, "readSync", "notes/alpha"), "readSync").shared.baseVersion).toBe(base);

  const pushed = ok(await call(page, "push"), "push");
  expect(pushed.held && pushed.result.settled.map((row) => row.state)).toEqual(["conflict"]);
  const conflict = ok(await call(page, "intent", committed.intent!.requestId), "intent");
  expect(conflict).toMatchObject({ state: "conflict", base, local: committed.version });
  expect(conflict!.baseContent).toMatch(/notes\/alpha v1/);
  expect(conflict!.content).toMatch(/notes\/alpha local edit/);
  expect(conflict!.remote).toMatchObject({ version: remoteVersion });
  expect(conflict!.remote!.content).toMatch(/notes\/alpha remote edit/);
  // Local content untouched, remote untouched, one 412 in the history, nothing acknowledged.
  expect(ok(await call(page, "read", "notes/alpha"), "read").doc.body).toBe("notes/alpha local edit\n");
  expect((await served.fixture.authority.read("notes/alpha")).version).toBe(remoteVersion);
  expect(served.fixture.history.map((row) => row.status)).toEqual([412]);
  const status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.counts).toMatchObject({ conflict: 1, acknowledged: 0, pending: 0 });
  expect(ok(await call(page, "readSync", "notes/alpha"), "readSync").shared.acknowledged).toBe(false);
});

test("e: a lost acknowledgement leaves the intent pending, and the next push settles it through lookup with one application", async ({ page }) => {
  await load(page);
  ok(await call(page, "bootstrap", served.origin, "e-lost"), "bootstrap");
  const committed = ok(await call(page, "commitLocal", "notes/gamma", "notes/gamma v2\n"), "commit");
  const requestId = committed.intent!.requestId;
  // The authority applies the write and the socket resets before the response; the lookup route is down too.
  served.fixture.knobs.dropAfterApply = true;
  served.fixture.knobs.lookupFails = true;

  const first = ok(await call(page, "push"), "push one");
  expect(first.held && first.result.settled.map((row) => row.state)).toEqual(["pending"]);
  expect(ok(await call(page, "intent", requestId), "intent")).toMatchObject({ state: "pending", attempts: 1 });
  expect(served.fixture.history.map((row) => row.requestId)).toEqual([requestId]);
  expect((await served.fixture.authority.read("notes/gamma")).doc.body).toBe("notes/gamma v2\n");
  expect(ok(await call(page, "readSync", "notes/gamma"), "readSync").shared.acknowledged).toBe(false);

  served.fixture.knobs.dropAfterApply = false;
  served.fixture.knobs.lookupFails = false;
  const putsBefore = trafficSummary().puts;
  const second = ok(await call(page, "push"), "push two");
  expect(second.held && second.result.settled.map((row) => row.state)).toEqual(["acknowledged"]);
  // The second push claimed the intent as attempt 2 before its lookup, and settle keeps no fewer attempts than the claim recorded.
  expect(ok(await call(page, "intent", requestId), "intent")).toMatchObject({ state: "acknowledged", attempts: 2, acknowledgedVersion: committed.version });
  // Settled by lookup: no second PUT left the page, nothing was deduplicated, history is still one write.
  expect(trafficSummary().puts).toBe(putsBefore);
  expect(served.fixture.deduplicated).toEqual([]);
  expect(served.fixture.history.length).toBe(1);
  expect(ok(await call(page, "readSync", "notes/gamma"), "readSync").shared).toEqual({ baseVersion: committed.version, acknowledged: true, unsettled: [] });
});

test("f: two tabs over one store push at once; the Web Lock admits one, the other reports held-elsewhere, and nothing is applied twice", async ({ context }) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await load(tabA);
  await load(tabB);
  const { intents, backOnline } = await bootstrapAndCommitOffline(tabA, "f-tabs");
  await backOnline();
  ok(await call(tabB, "attach", served.origin, "f-tabs"), "attach B");
  expect(ok(await call(tabB, "intents", "pending"), "B sees pending")).toHaveLength(2);

  // The holder's push spans two delayed writes, so the other tab's request lands while the role is held.
  served.fixture.knobs.delayMs = 400;
  const [replyA, replyB] = await Promise.all([call(tabA, "push"), call(tabB, "push")]);
  const a = ok(replyA, "push A");
  const b = ok(replyB, "push B");
  expect([a.held, b.held].filter(Boolean)).toHaveLength(1);
  const holder = a.held ? a : b;
  const other = a.held ? b : a;
  expect(holder.held && holder.result.settled.map((row) => row.state)).toEqual(["acknowledged", "acknowledged"]);
  expect(other).toMatchObject({ held: false, reason: "held-elsewhere" });
  expect(served.fixture.history.map((row) => row.requestId)).toEqual(intents.map((row) => row.requestId));
  expect(served.fixture.deduplicated).toEqual([]);

  // After the holder releases, the other tab's push finds nothing pending and delivers nothing.
  served.fixture.knobs.delayMs = 0;
  const later = ok(await call(a.held ? tabB : tabA, "push"), "push later");
  expect(later).toMatchObject({ held: true, result: { settled: [], skipped: [], paused: false } });
  expect(served.fixture.history).toHaveLength(2);
  for (const tab of [tabA, tabB]) {
    const status = ok(await call(tab, "syncStatus"), "syncStatus");
    expect(status.counts).toMatchObject({ pending: 0, in_flight: 0, acknowledged: 2 });
  }
  test.info().annotations.push({ type: "web-lock", description: `push role held by tab ${a.held ? "A" : "B"}; the other tab reported held-elsewhere` });
});

test("f (red probe): the same two-tab push with the lock bypassed makes both tabs report held and run push over one journal; the claim compare-and-swap still applies each intent once", async ({ context }) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await load(tabA);
  await load(tabB);
  const { intents, backOnline } = await bootstrapAndCommitOffline(tabA, "f-bypass");
  await backOnline();
  ok(await call(tabB, "attach", served.origin, "f-bypass"), "attach B");
  expect(ok(await call(tabB, "intents", "pending"), "B sees pending")).toHaveLength(2);

  // Same timing as scenario f: the first tab's push spans two delayed writes, so the second tab's push runs while the first is mid-push.
  served.fixture.knobs.delayMs = 400;
  const [replyA, replyB] = await Promise.all([call(tabA, "pushWithoutRole"), call(tabB, "pushWithoutRole")]);
  const a = ok(replyA, "bypass A");
  const b = ok(replyB, "bypass B");

  // The observable the lock prevents: both tabs believe they hold the push role, and both run
  // push over the same journal at once. Scenario f asserts exactly one `held`; here it is two.
  expect([a.held, b.held]).toEqual([true, true]);
  const reports = [a, b].flatMap((row) => (row.held ? [row.result] : []));
  expect(reports).toHaveLength(2);
  // Both pushes did journal work: each tab settled or was turned away from at least one intent,
  // and at least one claim lost the intent's compare-and-swap to the other tab. Under the lock
  // the second tab never touches the journal, so neither of these can happen there.
  for (const report of reports) expect(report.settled.length + report.skipped.length).toBeGreaterThan(0);
  const skipped = reports.flatMap((row) => row.skipped);
  expect(skipped.map((row) => row.reason)).toContain("claimed-elsewhere");
  // What the lock is not for: application stays single even with the role bypassed. The claim
  // compare-and-swap hands each intent to one tab, that tab alone settles it, and the authority
  // applied each request identity once with nothing deduplicated. The lock owns the push role;
  // the journal owns the correctness of application.
  const settled = reports.flatMap((row) => row.settled);
  expect(settled.map((row) => row.state)).toEqual(["acknowledged", "acknowledged"]);
  expect(settled.map((row) => row.requestId).sort()).toEqual(intents.map((row) => row.requestId).sort());
  expect(served.fixture.history.map((row) => row.requestId).sort()).toEqual(intents.map((row) => row.requestId).sort());
  expect(served.fixture.deduplicated).toEqual([]);
  served.fixture.knobs.delayMs = 0;
  for (const tab of [tabA, tabB]) {
    const status = ok(await call(tab, "syncStatus"), "syncStatus");
    expect(status.counts).toMatchObject({ pending: 0, in_flight: 0, acknowledged: 2 });
  }
  test.info().annotations.push({
    type: "web-lock-bypassed",
    description: `both tabs reported held; settled A ${a.held ? a.result.settled.length : 0}, B ${b.held ? b.result.settled.length : 0}; skipped ${skipped.map((row) => row.reason).join(",")}`,
  });
});

test("g: a tab closed mid-push is reclaimed by a new tab, which settles the intent through lookup without a second application", async ({ context }) => {
  test.setTimeout(60_000);
  const first = await context.newPage();
  await load(first);
  ok(await call(first, "bootstrap", served.origin, "g-termination"), "bootstrap");
  const committed = ok(await call(first, "commitLocal", "notes/delta", "notes/delta from a tab that will die\n"), "commit");
  const requestId = committed.intent!.requestId;

  // Hold the write open at the authority, start the push, and kill the tab once the PUT is in flight.
  served.fixture.knobs.delayMs = 1500;
  const inFlight = call(first, "push").catch((error: unknown) => ({ closed: String(error) }));
  await expect.poll(() => served.requests.some((row) => row.method === "PUT")).toBe(true);
  await first.close();
  // The tab is gone and the authority still holds the write open: nothing has landed yet.
  expect(served.fixture.history).toEqual([]);
  const closed = await inFlight;
  expect(isDriverError(closed) || "closed" in (closed as object)).toBe(true);
  // The authority finishes the write after the tab is gone: the write landed, nobody was told.
  await expect.poll(() => served.fixture.history.length, { timeout: 10_000 }).toBe(1);
  expect(served.fixture.history[0]).toMatchObject({ requestId, id: "notes/delta", status: 200 });
  served.fixture.knobs.delayMs = 0;

  const second = await context.newPage();
  await load(second);
  ok(await call(second, "attach", served.origin, "g-termination"), "attach");
  // The dead tab's claim persisted attempts 1 before the PUT left, so the journal already says the request may have been delivered.
  expect(ok(await call(second, "intents", "in_flight"), "in_flight before reclaim").map((row) => [row.requestId, row.attempts])).toEqual([[requestId, 1]]);
  expect(ok(await call(second, "reclaimInFlight"), "reclaim").reclaimed).toBe(1);
  expect(ok(await call(second, "intent", requestId), "reclaimed")).toMatchObject({ state: "pending", attempts: 1 });
  const putsBefore = trafficSummary().puts;
  const pushed = ok(await call(second, "push"), "push");
  expect(pushed.held && pushed.result.settled.map((row) => row.state)).toEqual(["acknowledged"]);
  expect(trafficSummary().puts).toBe(putsBefore);
  expect(trafficSummary().lookups).toBeGreaterThanOrEqual(1);
  expect(served.fixture.history).toHaveLength(1);
  expect(served.fixture.deduplicated).toEqual([]);
  expect(ok(await call(second, "intent", requestId), "settled")).toMatchObject({ state: "acknowledged", acknowledgedVersion: committed.version });
  expect(ok(await call(second, "readSync", "notes/delta"), "readSync").shared).toEqual({ baseVersion: committed.version, acknowledged: true, unsettled: [] });
  expect((await served.fixture.authority.read("notes/delta")).doc.body).toBe("notes/delta from a tab that will die\n");
});

test("h: a quota failure rejects the commit, leaves the previous version intact with no partial intent, and a later commit succeeds", async ({ page }) => {
  await load(page);
  ok(await call(page, "bootstrap", served.origin, "h-quota"), "bootstrap");
  const before = ok(await call(page, "read", "notes/epsilon"), "read before");
  // Armed: the next put throws QuotaExceededError synchronously (see the header on the real error-event path).
  ok(await call(page, "armQuota"), "armQuota");

  const failed = await call(page, "commitLocal", "notes/epsilon", "notes/epsilon will not fit\n");
  expect(isDriverError(failed)).toBe(true);
  expect((failed as DriverError).error.name).toBe("QuotaExceededError");
  const after = ok(await call(page, "read", "notes/epsilon"), "read after");
  expect(after).toEqual(before);
  expect(ok(await call(page, "intents"), "intents")).toEqual([]);
  expect(ok(await call(page, "syncStatus"), "syncStatus").counts.pending).toBe(0);
  expect(ok(await call(page, "readSync", "notes/epsilon"), "readSync").shared.acknowledged).toBe(true);

  ok(await call(page, "disarmQuota"), "disarmQuota");
  const committed = ok(await call(page, "commitLocal", "notes/epsilon", "notes/epsilon fits now\n"), "commit after");
  expect(committed.changed).toBe(true);
  expect(committed.intent).toMatchObject({ state: "pending", attempts: 0, base: before.version });
  expect(ok(await call(page, "read", "notes/epsilon"), "read final").doc.body).toBe("notes/epsilon fits now\n");
  expect(ok(await call(page, "syncStatus"), "syncStatus").counts.pending).toBe(1);
});

test("i: revocation refuses and pauses; later commits persist locally; push does nothing while paused; resume delivers the retained intents", async ({ page }) => {
  await load(page);
  ok(await call(page, "bootstrap", served.origin, "i-revoked"), "bootstrap");
  const first = ok(await call(page, "commitLocal", "notes/alpha", "notes/alpha after revocation\n"), "commit one");
  served.fixture.knobs.unauthorized = true;

  const refused = ok(await call(page, "push"), "push refused");
  expect(refused.held && refused.result.paused).toBe(true);
  expect(refused.held && refused.result.settled.map((row) => row.state)).toEqual(["refused"]);
  expect(ok(await call(page, "intent", first.intent!.requestId), "refused intent")).toMatchObject({ state: "refused", refusal: { code: "AUTH_REQUIRED" } });
  let status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.paused).toBe(true);
  expect(status.pausedReason).toMatch(/AUTH_REQUIRED/);
  expect(served.fixture.history).toEqual([]);

  // Local work continues: two more edits persist with pending intents; the refused one is superseded.
  const second = ok(await call(page, "commitLocal", "notes/alpha", "notes/alpha still editing\n"), "commit two");
  const third = ok(await call(page, "commitLocal", "notes/zeta", "notes/zeta edited while paused\n"), "commit three");
  expect(second.intent).toMatchObject({ state: "pending", base: first.intent!.base });
  expect(third.intent).toMatchObject({ state: "pending" });
  expect(ok(await call(page, "read", "notes/alpha"), "read").doc.body).toBe("notes/alpha still editing\n");
  status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.paused).toBe(true);
  expect(status.counts).toMatchObject({ pending: 2, refused: 0 });

  // Paused: even with the credential back, push touches nothing.
  served.fixture.knobs.unauthorized = false;
  const putsBefore = trafficSummary().puts;
  const paused = ok(await call(page, "push"), "push paused");
  expect(paused).toMatchObject({ held: true, result: { paused: true, settled: [], skipped: [] } });
  expect(trafficSummary().puts).toBe(putsBefore);
  expect(served.fixture.history).toEqual([]);
  expect(ok(await call(page, "syncStatus"), "syncStatus")).toMatchObject({ paused: true, counts: { pending: 2 } });

  // An explicit resume delivers the retained intents.
  ok(await call(page, "resume"), "resume");
  const resumed = ok(await call(page, "push"), "push resumed");
  expect(resumed.held && resumed.result.settled.map((row) => row.state)).toEqual(["acknowledged", "acknowledged"]);
  status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status.paused).toBe(false);
  expect(status.counts).toMatchObject({ pending: 0, acknowledged: 2 });
  expect(served.fixture.history.map((row) => row.id)).toEqual(["notes/alpha", "notes/zeta"]);
  expect((await served.fixture.authority.read("notes/alpha")).doc.body).toBe("notes/alpha still editing\n");
  expect((await served.fixture.authority.read("notes/zeta")).doc.body).toBe("notes/zeta edited while paused\n");
});

test("j: a bootstrap the authority cuts off half-way never reports complete, and a later bootstrap completes it", async ({ page }) => {
  await load(page);
  served.fixture.knobs.readBudget = NOTE_IDS.length / 2;
  const interrupted = await call(page, "bootstrap", served.origin, "j-interrupted", NOTE_IDS.length / 2);
  expect(isDriverError(interrupted)).toBe(true);
  expect((interrupted as DriverError).error.message).toMatch(/fetch/i);
  expect(ok(await call(page, "isComplete"), "isComplete").complete).toBe(false);
  const status = ok(await call(page, "syncStatus"), "syncStatus");
  expect(status).toMatchObject({ bootstrapComplete: false, generation: 1 });
  // Partial state is visible as partial: half the documents landed, and the store is neither empty nor complete.
  expect(ok(await call(page, "query", "notes/"), "query")).toHaveLength(NOTE_IDS.length / 2);
  expect(served.fixture.served.documents).toBe(NOTE_IDS.length / 2);
  // A fresh handle sees the same incomplete answer.
  expect(ok(await call(page, "attach", served.origin, "j-interrupted"), "attach").complete).toBe(false);

  served.fixture.knobs.readBudget = null;
  const repaired = ok(await call(page, "bootstrap", served.origin, "j-interrupted"), "bootstrap again");
  expect(repaired.marker).toMatchObject({ complete: true, generation: 2, documentCount: NOTE_IDS.length });
  expect(ok(await call(page, "isComplete"), "isComplete").complete).toBe(true);
  expect(ok(await call(page, "query", "notes/"), "query")).toHaveLength(NOTE_IDS.length);
});

test("k: measurements are recorded, not asserted: cold bootstrap, warm read and query, local commit, reconciliation, storage footprint", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await served.close();
  const fixture = await createRemoteFixture();
  const DOCS = 200;
  const filler = "x".repeat(1024);
  for (let index = 0; index < DOCS; index += 1) {
    const id = `measure/doc-${String(index).padStart(3, "0")}`;
    await fixture.authority.write(id, note(id, `${filler}\n`));
  }
  served = await serveRemoteFixture(fixture);

  await load(page);
  const estimateBefore = await call(page, "storage");
  const booted = ok(await call(page, "bootstrap", served.origin, "k-measure"), "bootstrap");
  expect(booted.marker.documentCount).toBe(DOCS);
  const timed = ok(await call(page, "timeRead", "measure/doc-100", "measure/"), "timeRead");
  expect(timed.count).toBe(DOCS);
  const commitOne = ok(await call(page, "commitLocal", "measure/doc-010", "edited ten\n"), "commit one");
  const commitTwo = ok(await call(page, "commitLocal", "measure/doc-020", "edited twenty\n"), "commit two");
  const pushed = ok(await call(page, "push"), "push");
  expect(pushed.held && pushed.result.settled.map((row) => row.state)).toEqual(["acknowledged", "acknowledged"]);
  const blob = ok(await call(page, "writeRandomBlob", "artifacts/random.bin", 256 * 1024), "writeRandomBlob");
  expect(blob.size).toBe(256 * 1024);
  const estimateAfter = await call(page, "storage");

  const lines = [
    `Chromium ${browser.version()} on ${cpus()[0]?.model ?? "unknown cpu"} with ${(totalmem() / 1024 ** 3).toFixed(0)} GiB, ${process.platform} ${process.arch}`,
    `cold bootstrap of ${DOCS} x 1 KiB documents over HTTP (127.0.0.1): ${booted.ms.toFixed(1)} ms`,
    `warm read (same page, after bootstrap): ${timed.readMs.toFixed(2)} ms; warm query over ${timed.count} heads: ${timed.queryMs.toFixed(2)} ms`,
    `local commit (engine patch plus journaled intent, one IndexedDB transaction): ${commitOne.ms.toFixed(2)} ms, ${commitTwo.ms.toFixed(2)} ms`,
    `reconciliation (two-intent push under the Web Lock, two PUTs over HTTP): ${pushed.ms.toFixed(1)} ms`,
    `storage estimate before: usage=${estimateBefore.usage} quota=${estimateBefore.quota}; after bootstrap + 256 KiB random blob: usage=${estimateAfter.usage} quota=${estimateAfter.quota} persisted=${estimateAfter.persisted}`,
  ];
  for (const line of lines) {
    console.log(`[measure] ${line}`);
    test.info().annotations.push({ type: "measure", description: line });
  }
});
