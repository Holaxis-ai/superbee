import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

import { MemoryBackend, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";
import { BrowserLaunchTickets, parseBrowserLaunchTarget } from "../src/browser-launch.js";

const SESSION = "browser-session-secret";
const MANAGEMENT = "management-secret-separate-from-browser";
const NONCE = "launch-nonce-exact";
const COOKIE = "superbee_ui_testauthority";
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });
const asset = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("shell") });

function bundle(): Bundle {
  return { root: "mem://managed", backend: new MemoryBackend() };
}

async function boot(managed = true): Promise<UiServerHandle> {
  const value = bundle();
  return bootUiServer({
    mode: "dir",
    bundle: value,
    router: createRouter(value),
    renderDocument,
    serveAsset: asset,
    sessionSecret: SESSION,
    sessionCookieName: COOKIE,
    ...(managed ? {
      management: {
        secret: MANAGEMENT,
        identity: {
          protocol: 2,
          mode: "dir" as const,
          authority_key: "a".repeat(64),
          bundle_root: "/bundle",
          launch_root: "/bundle-alias",
          actor: null,
          launch_nonce: NONCE,
          pid: 123,
          started_at: "2026-09-01T00:00:00.000Z",
        },
      },
    } : {}),
  });
}

function url(server: UiServerHandle, pathname: string): string {
  return `http://${server.host}:${server.port}${pathname}`;
}

const managementHeaders = {
  "x-superbee-management-secret": MANAGEMENT,
  "x-superbee-launch-nonce": NONCE,
};

test("management routes are absent from an ordinary foreground server", async () => {
  const server = await boot(false);
  try {
    assert.equal((await fetch(url(server, "/__manage/status"), { headers: managementHeaders })).status, 404);
  } finally {
    await server.close();
  }
});

test("browser and management capabilities remain disjoint and the exact nonce is required", async () => {
  const server = await boot();
  try {
    assert.equal((await fetch(url(server, "/__manage/status"))).status, 403);
    assert.equal((await fetch(url(server, `/__manage/status?token=${SESSION}`))).status, 403);
    assert.equal((await fetch(url(server, "/__manage/status"), { headers: { cookie: `${COOKIE}=${SESSION}` } })).status, 403);
    assert.equal((await fetch(url(server, "/__manage/status"), {
      headers: { ...managementHeaders, "x-superbee-launch-nonce": "stale" },
    })).status, 403);
    assert.equal((await fetch(url(server, "/"), { headers: managementHeaders })).status, 403);
    assert.equal((await fetch(url(server, "/v0/bundles/default/docs"), { headers: managementHeaders })).status, 403);
  } finally {
    await server.close();
  }
});

test("authenticated status is exact, cacheless, and never returns either secret", async () => {
  const server = await boot();
  try {
    const response = await fetch(url(server, "/__manage/status"), { headers: managementHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    const raw = await response.text();
    assert.doesNotMatch(raw, new RegExp(SESSION));
    assert.doesNotMatch(raw, new RegExp(MANAGEMENT));
    assert.deepEqual(JSON.parse(raw), {
      protocol: 2,
      mode: "dir",
      authority_key: "a".repeat(64),
      bundle_root: "/bundle",
      launch_root: "/bundle-alias",
      actor: null,
      launch_nonce: NONCE,
      pid: 123,
      started_at: "2026-09-01T00:00:00.000Z",
      state: "ready",
      active_clients: 0,
    });
  } finally {
    await server.close();
  }
});

test("weak or malformed exported management authority is rejected at boot", async () => {
  const value = bundle();
  const base = {
    mode: "dir" as const,
    bundle: value,
    router: createRouter(value),
    renderDocument,
    serveAsset: asset,
    sessionSecret: SESSION,
  };
  const identity = {
    protocol: 1,
    mode: "dir" as const,
    authority_key: "a".repeat(64),
    bundle_root: "/bundle",
    launch_root: "/bundle",
    actor: null,
    launch_nonce: NONCE,
    pid: 123,
    started_at: "2026-09-01T00:00:00.000Z",
  };
  await assert.rejects(() => bootUiServer({ ...base, management: { secret: "", identity } }), /invalid managed UI/);
  await assert.rejects(() => bootUiServer({
    ...base,
    management: { secret: MANAGEMENT, identity: { ...identity, launch_nonce: "", bundle_root: "relative" } },
  }), /invalid managed UI/);
  await assert.rejects(() => bootUiServer({ ...base, sessionCookieName: "bad\r\nname" }), /invalid UI session cookie/);
});

test("authority-specific browser cookies do not collide across loopback ports", async () => {
  const first = await boot();
  const value = bundle();
  const second = await bootUiServer({
    mode: "dir",
    bundle: value,
    router: createRouter(value),
    renderDocument,
    serveAsset: asset,
    sessionSecret: "second-browser-secret",
    sessionCookieName: "superbee_ui_secondauthority",
  });
  try {
    const firstLogin = await fetch(url(first, `/?token=${SESSION}`));
    assert.match(firstLogin.headers.get("set-cookie") ?? "", new RegExp(`^${COOKIE}=`));
    const firstCookie = (firstLogin.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal((await fetch(url(first, "/"), { headers: { cookie: firstCookie } })).status, 200);
    assert.equal((await fetch(url(second, "/"), { headers: { cookie: firstCookie } })).status, 403);
    const secondLogin = await fetch(url(second, "/?token=second-browser-secret"));
    assert.match(secondLogin.headers.get("set-cookie") ?? "", /^superbee_ui_secondauthority=/);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("adopt and stop are exact-launch idempotent transitions whose acknowledgements finish first", async () => {
  const server = await boot();
  try {
    const adopted = server.management!.adopted.then(() => "adopted");
    const firstAdopt = await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders });
    assert.equal(firstAdopt.status, 200);
    assert.deepEqual(await firstAdopt.json(), { adopted: true, launch_nonce: NONCE });
    assert.equal(await adopted, "adopted");
    assert.equal((await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders })).status, 200);

    const stopping = server.management!.stopRequested.then(() => "stopping");
    const stop = await fetch(url(server, "/__manage/stop"), { method: "POST", headers: managementHeaders });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { stopping: true, launch_nonce: NONCE });
    assert.equal(await stopping, "stopping");
    assert.equal((await fetch(url(server, "/__manage/stop"), { method: "POST", headers: managementHeaders })).status, 200);
  } finally {
    await server.close();
  }
});

test("lease expiry and stop-before-adopt atomically prevent a later successful adoption", async () => {
  const expired = await boot();
  try {
    assert.equal(expired.management!.expireIfReady(), true);
    await expired.management!.stopRequested;
    assert.equal(expired.management!.expireIfReady(), false);
    assert.equal((await fetch(url(expired, "/__manage/adopt"), { method: "POST", headers: managementHeaders })).status, 409);
  } finally {
    await expired.close();
  }

  const stopped = await boot();
  try {
    const response = await fetch(url(stopped, "/__manage/stop"), { method: "POST", headers: managementHeaders });
    assert.equal(response.status, 200);
    await stopped.management!.stopRequested;
    assert.equal((await fetch(url(stopped, "/__manage/adopt"), { method: "POST", headers: managementHeaders })).status, 409);
  } finally {
    await stopped.close();
  }
});

const target = { kind: "registered-view", id: "views-registry/probe" };
async function mintHandoff(server: UiServerHandle): Promise<{ destination: string; browser_launch: { path: string; expires_at: number } }> {
  const response = await fetch(url(server, "/__manage/browser-launch"), {
    method: "POST", headers: { ...managementHeaders, "content-type": "application/json" }, body: JSON.stringify(target),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  return response.json();
}
function redeem(server: UiServerHandle, ticket: string, headers: Record<string, string> = {}) {
  return fetch(url(server, "/__ui/browser-launch"), {
    method: "POST",
    headers: { origin: url(server, ""), "x-requested-with": "superbee-browser-launch", "content-type": "application/json", ...headers },
    body: JSON.stringify({ ticket }),
  });
}

test("one-use handoff establishes the selected browser cookie, never View approval or management", async () => {
  const server = await boot();
  try {
    assert.equal((await fetch(url(server, "/__manage/browser-launch"), {
      method: "POST", headers: managementHeaders, body: JSON.stringify(target),
    })).status, 409, "ready is not adopted");
    await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders });
    const document = await fetch(url(server, "/__ui/browser-launch"));
    assert.equal(document.status, 200);
    assert.equal(document.headers.get("cache-control"), "no-store");
    assert.equal(document.headers.get("referrer-policy"), "no-referrer");
    assert.equal(document.headers.get("x-frame-options"), "DENY");
    assert.match(document.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
    const html = await document.text();
    assert.ok(html.indexOf("history.replaceState") < html.indexOf("await fetch"));
    assert.ok(!html.includes(SESSION) && !html.includes(MANAGEMENT) && !html.includes(target.id));
    assert.equal((await fetch(url(server, "/"))).status, 403);
    assert.equal((await fetch(url(server, "/__ui/config"))).status, 403);
    assert.equal((await fetch(url(server, "/__manage/browser-launch"), { method: "POST", body: JSON.stringify(target) })).status, 403);
    const handoff = await mintHandoff(server);
    assert.equal(handoff.destination, "/?view=page&id=views-registry%2Fprobe");
    assert.ok(!JSON.stringify(handoff).includes(SESSION) && !JSON.stringify(handoff).includes(MANAGEMENT));
    const ticket = handoff.browser_launch.path.split("#")[1]!;
    assert.equal((await redeem(server, ticket, { origin: "http://other.invalid" })).status, 403);
    assert.equal((await redeem(server, ticket, { "x-requested-with": "" })).status, 403);
    const responses = await Promise.all([redeem(server, ticket), redeem(server, ticket)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
    const success = responses.find((response) => response.status === 200)!;
    assert.deepEqual(await success.json(), { destination: handoff.destination });
    assert.equal(responses.find((response) => response.status === 403)!.headers.get("set-cookie"), null);
    const cookieHeader = success.headers.get("set-cookie") ?? "";
    assert.match(cookieHeader, new RegExp(`^${COOKIE}=`));
    assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
    const cookie = cookieHeader.split(";")[0]!;
    assert.equal((await fetch(url(server, "/"), { headers: { cookie } })).status, 200);
    assert.equal((await fetch(url(server, "/__manage/status"), { headers: { cookie } })).status, 403);
    assert.equal((await redeem(server, ticket)).status, 403);
  } finally { await server.close(); }
});

test("handoff targets, bounds, stopping and process isolation fail closed", async () => {
  const first = await boot();
  const second = await boot();
  try {
    for (const server of [first, second]) await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders });
    for (const input of [{ ...target, url: "https://elsewhere.invalid" }, { kind: "registered-view", id: "../other" }, { kind: "uri", id: "/" }]) {
      assert.equal((await fetch(url(first, "/__manage/browser-launch"), { method: "POST", headers: managementHeaders, body: JSON.stringify(input) })).status, 400);
    }
    assert.equal((await fetch(url(first, "/__manage/browser-launch"), { method: "POST", headers: managementHeaders, body: JSON.stringify({ ...target, extra: "x".repeat(5000) }) })).status, 413);
    const handoff = await mintHandoff(first);
    const ticket = handoff.browser_launch.path.split("#")[1]!;
    assert.equal((await redeem(second, ticket)).status, 403);
    for (let index = 1; index < 32; index++) await mintHandoff(first);
    assert.equal((await fetch(url(first, "/__manage/browser-launch"), { method: "POST", headers: managementHeaders, body: JSON.stringify(target) })).status, 429);
    await fetch(url(first, "/__manage/stop"), { method: "POST", headers: managementHeaders });
    assert.equal((await redeem(first, ticket)).status, 403);
    assert.equal((await fetch(url(first, "/__manage/browser-launch"), { method: "POST", headers: managementHeaders, body: JSON.stringify(target) })).status, 409);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("expired tickets cannot enroll a browser and bounded capacity recovers after expiry", () => {
  let now = 0;
  const tickets = new BrowserLaunchTickets(() => now);
  const parsed = parseBrowserLaunchTarget(target)!;
  const first = tickets.mint(parsed)!;
  for (let index = 1; index < 32; index++) assert.ok(tickets.mint(parsed));
  assert.equal(tickets.mint(parsed), null);
  now = first.expiresAt;
  assert.equal(tickets.consume(first.ticket), null);
  const fresh = tickets.mint(parsed)!;
  assert.equal(tickets.consume(fresh.ticket), "/?view=page&id=views-registry%2Fprobe");
  assert.equal(tickets.consume(fresh.ticket), null);
});

test("served bootstrap scrubs its private fragment before the exchange and navigates only its returned destination", async () => {
  const server = await boot();
  try {
    await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders });
    const handoff = await mintHandoff(server);
    const response = await fetch(url(server, "/__ui/browser-launch"));
    const html = await response.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    assert.ok(response.headers.get("content-security-policy")?.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
    const location = { hash: `#${handoff.browser_launch.path.split("#")[1]}`, pathname: "/__ui/browser-launch", replace: (destination: string) => { navigated = destination; } };
    let scrubbed = false;
    let navigated: string | undefined;
    let calls = 0;
    const window = {} as { top?: unknown };
    window.top = window;
    await runInNewContext(script, {
      window, location, document: { getElementById: () => ({ textContent: "Opening" }) },
      history: { replaceState: (_state: unknown, _title: string, path: string) => { assert.equal(path, location.pathname); location.hash = ""; scrubbed = true; } },
      fetch: async (path: string, init: RequestInit) => {
        assert.ok(scrubbed);
        assert.equal(location.hash, "");
        assert.equal(init.redirect, "error");
        calls++;
        return fetch(url(server, path), { ...init, headers: { ...init.headers, origin: url(server, "") } });
      },
    });
    assert.equal(navigated, handoff.destination);
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test("managed document offers coalesce concurrent opens and require the exact controller/session", async () => {
  const server = await boot();
  const other = await boot();
  try {
    await fetch(url(server, "/__manage/adopt"), { method: "POST", headers: managementHeaders });
    const send = (id: string, headers = managementHeaders) => fetch(url(server, "/__manage/document-offer"), {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "document", id }),
    });
    assert.equal((await send("docs/a", {} as typeof managementHeaders)).status, 403);
    assert.equal((await send("../outside")).status, 400);
    const replies = await Promise.all([send("docs/a"), send("docs/b"), send("docs/a")]);
    const results = await Promise.all(replies.map((response) => response.json()));
    assert.equal(results.filter((result) => result.openBrowser).length, 1);
    assert.equal((await fetch(url(server, "/__ui/document-offers"))).status, 403);
    const snapshot = await (await fetch(url(server, "/__ui/document-offers"), { headers: { cookie: `${COOKIE}=${SESSION}` } })).json();
    assert.deepEqual(snapshot.offers.map((item: { documentId: string }) => item.documentId), ["docs/a", "docs/b"]);
    const otherSnapshot = await (await fetch(url(other, "/__ui/document-offers"), { headers: { cookie: `${COOKIE}=${SESSION}` } })).json();
    assert.deepEqual(otherSnapshot.offers, []);
    const controller = new AbortController();
    const stream = await fetch(url(server, "/events"), { headers: { cookie: `${COOKIE}=${SESSION}` }, signal: controller.signal });
    try {
      const offered = await (await send("docs/c")).json();
      assert.equal(offered.openBrowser, false);
      const reader = stream.body!.getReader();
      let text = "";
      while (!text.includes('"documentId":"docs/c"')) {
        const part = await reader.read();
        assert.equal(part.done, false);
        text += new TextDecoder().decode(part.value);
      }
      assert.match(text, /event: document-offers/);
    } finally { controller.abort(); }
  } finally { await server.close(); await other.close(); }
});

test("document offer expiry, capacity and pending-open recovery are finite", async () => {
  const { DocumentOffers } = await import("../src/document-offers.js");
  let now = 1_000;
  const offers = new DocumentOffers(() => now);
  assert.equal(offers.offer("docs/a", 0)!.openBrowser, true);
  assert.equal(offers.offer("docs/b", 0)!.openBrowser, false);
  now += 10_000;
  assert.equal(offers.offer("docs/c", 0)!.openBrowser, true);
  for (let i = 3; i < 20; i++) assert.ok(offers.offer(`docs/${i}`, 1));
  assert.equal(offers.offer("docs/overflow", 1), null);
  assert.ok(offers.offer("docs/a", 1), "a duplicate coalesces at capacity");
  const oldRevision = offers.snapshot().revision;
  now += 60_000;
  assert.deepEqual(offers.snapshot().offers, []);
  assert.ok(offers.snapshot().revision > oldRevision);
  assert.equal(offers.offer("docs/new", 0)!.openBrowser, true);
});

test("live-update streams reserve a browser connection for page loads and recover capacity on close", async () => {
  const server = await boot();
  const controllers: AbortController[] = [];
  const headers = { cookie: `${COOKIE}=${SESSION}` };
  try {
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      assert.equal((await fetch(url(server, "/events"), { headers, signal: controller.signal })).status, 200);
    }
    const overflow = await fetch(url(server, "/events"), { headers });
    assert.equal(overflow.status, 204);
    assert.equal(overflow.headers.get("cache-control"), "no-store");
    assert.equal(await overflow.text(), "");
    assert.equal((await fetch(url(server, "/"), { headers })).status, 200);
    assert.equal((await fetch(url(server, "/events"))).status, 403);
    controllers[0]!.abort();
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await (await fetch(url(server, "/__manage/status"), { headers: managementHeaders })).json() as { active_clients: number };
      if (status.active_clients === 4) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const replacement = new AbortController();
    controllers.push(replacement);
    assert.equal((await fetch(url(server, "/events"), { headers, signal: replacement.signal })).status, 200);
  } finally {
    for (const controller of controllers) controller.abort();
    await server.close();
  }
});
