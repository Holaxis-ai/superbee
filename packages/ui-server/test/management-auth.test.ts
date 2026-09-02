import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";

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
          protocol: 1,
          mode: "dir" as const,
          authority_key: "a".repeat(64),
          bundle_root: "/bundle",
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
      protocol: 1,
      mode: "dir",
      authority_key: "a".repeat(64),
      bundle_root: "/bundle",
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
