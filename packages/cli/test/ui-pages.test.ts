/**
 * Pages-spike server tests (tasks/ui-pages-spike): the privilege split (a page nonce is rejected
 * by every data route — the REQUIRED security assertion), the mint gating, the page CSP, and the
 * pure change-differ + nonce-registry cores. The end-to-end privilege split boots the REAL
 * `bootUiServer` over a temp bundle, mirroring `ui.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";

import { deleteDoc, initBundle, readDoc, writeBlob, writeDoc, RemoteBackend, type Bundle } from "@superbee/core";
import { createRouter, serve, type ServerHandle } from "@superbee/server";
import { bootUiServer, escapeHtml, pageError, type UiServerHandle } from "../src/ui/server.js";
import {
  PageLaunchRegistry,
  SseHub,
  diffSnapshots,
  isEmptyChange,
  pageCsp,
  snapshotBundle,
  startWatcher,
  type Snapshot,
} from "@superbee/ui-server";
import { writeUiUrlFile, clearUiUrlFile, uiUrlFilePath } from "../src/ui/url-file.js";

// ── PageLaunchRegistry ───────────────────────────────────────────────────────

function launchInput(key: string) {
  return {
    sourceKind: "registered" as const,
    registryId: `pages-registry/${key.split("/").pop()!.replace(/\.html$/, "")}`,
    registryType: "View" as const,
    registryVersion: `registry-${key}`,
    registryTitle: key,
    entryKey: key,
    contentType: "text/html; charset=utf-8",
    contentVersion: `content-${key}`,
    bytes: new TextEncoder().encode(key),
    capability: "bundle-read" as const,
  };
}

test("PageLaunchRegistry: mint returns opaque ids that resolve to one immutable launch", () => {
  const reg = new PageLaunchRegistry();
  const launch = reg.mint(launchInput("pages/a.html"));
  assert.equal(reg.resolveNonce(launch.nonce)?.entryKey, "pages/a.html");
  assert.equal(reg.resolveLaunch(launch.launchId)?.contentVersion, "content-pages/a.html");
  assert.notEqual(launch.nonce, "pages/a.html");
  assert.equal(reg.resolveNonce("never-minted"), null);
});

test("PageLaunchRegistry: two mints of the same source yield distinct launches", () => {
  const reg = new PageLaunchRegistry();
  assert.notEqual(reg.mint(launchInput("pages/a.html")).launchId, reg.mint(launchInput("pages/a.html")).launchId);
});

test("PageLaunchRegistry: an expired launch resolves to null (and is swept)", () => {
  const reg = new PageLaunchRegistry(-1000); // already-expired TTL
  const launch = reg.mint(launchInput("pages/a.html"));
  assert.equal(reg.resolveNonce(launch.nonce), null);
  assert.equal(reg.size(), 0);
});

test("PageLaunchRegistry: bounded by a cap — the oldest launch is revoked once full", () => {
  const reg = new PageLaunchRegistry(60_000, 3);
  const oldest = reg.mint(launchInput("pages/a.html"));
  reg.mint(launchInput("pages/b.html"));
  reg.mint(launchInput("pages/c.html"));
  assert.equal(reg.size(), 3);
  reg.mint(launchInput("pages/d.html"));
  assert.equal(reg.size(), 3);
  assert.equal(reg.resolveLaunch(oldest.launchId), null, "the oldest launch was revoked");
});

test("PageLaunchRegistry: the byte nonce expires quickly without breaking an already-loaded frame's launch", () => {
  let now = 1_000;
  const reg = new PageLaunchRegistry(60_000, 3, () => now, 10);
  const launch = reg.mint(launchInput("pages/a.html"));
  now += 11;
  assert.equal(reg.resolveNonce(launch.nonce), null, "a leaked page URL loses byte access at the nonce TTL");
  assert.equal(reg.resolveLaunch(launch.launchId)?.entryKey, "pages/a.html", "the loaded frame can still propose until its longer launch TTL");
});

test("XSS pin: pageError HTML-escapes its message — script tags, quotes, and ampersands arrive as text, never markup", async () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'quotes'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;");

  // Exercise the TEMPLATE exactly as served: a hostile message (the shape a remote's error text
  // could take on the serve path) must reach the iframe escaped, with the page content-type + CSP.
  const hostile = `remote said <script>alert("x")</script> & 'gotcha'`;
  const res = pageError(502, hostile);
  assert.equal(res.status, 502);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
  const body = await res.text();
  assert.ok(!body.includes("<script>"), "raw markup from the message must never reach the page body");
  assert.ok(
    body.includes("remote said &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;gotcha&#39;"),
    "the human message stays legible in escaped form",
  );
  // The template's own chrome is intact around the escaped payload.
  assert.match(body, /<title>page unavailable<\/title>/);
});

test("pageCsp: locks the page to inert bytes — connect-src 'none', frame-ancestors 'self'", () => {
  const csp = pageCsp();
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
});

// ── ui-url re-entry file (B6) ─────────────────────────────────────────────────

test("uiUrlFile: writes the URL 0600, and clear removes it ONLY when it still points at that url", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-home-"));
  try {
    const url = "http://127.0.0.1:54237/?token=abc123";
    await writeUiUrlFile(url, home);
    const p = uiUrlFilePath(home);
    assert.equal((await readFile(p, "utf8")).trim(), url);
    // 0600 — owner rw only (mode low 9 bits).
    if (process.platform !== "win32") assert.equal((await stat(p)).mode & 0o777, 0o600);

    // A clear for a DIFFERENT url must NOT remove another instance's pointer.
    await clearUiUrlFile("http://127.0.0.1:9/?token=someone-else", home);
    assert.equal((await readFile(p, "utf8")).trim(), url, "a non-matching clear left the file intact");

    // A clear for the matching url removes it.
    await clearUiUrlFile(url, home);
    await assert.rejects(() => readFile(p, "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── diffSnapshots ─────────────────────────────────────────────────────────────

function snap(docs: Record<string, string>, blobs: Record<string, string> = {}): Snapshot {
  return { docs: new Map(Object.entries(docs)), blobs: new Map(Object.entries(blobs)) };
}

test("diffSnapshots: reports changed (new + moved) and removed docs", () => {
  const prev = snap({ a: "v1", b: "v1" });
  const next = snap({ a: "v2", b: "v1", c: "v1" });
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.docs.changed.sort((x, y) => x.id.localeCompare(y.id)), [
    { id: "a", version: "v2" },
    { id: "c", version: "v1" },
  ]);
  assert.deepEqual(d.docs.removed, []);
});

test("diffSnapshots: reports removed docs and blob changes independently", () => {
  const prev = snap({ a: "v1" }, { "pages/p.html": "b1" });
  const next = snap({}, { "pages/p.html": "b2" });
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.docs.removed, ["a"]);
  assert.deepEqual(d.blobs.changed, [{ key: "pages/p.html", version: "b2" }]);
});

test("isEmptyChange: true iff nothing moved on either side", () => {
  assert.equal(isEmptyChange(diffSnapshots(snap({ a: "v1" }), snap({ a: "v1" }))), true);
  assert.equal(isEmptyChange(diffSnapshots(snap({ a: "v1" }), snap({ a: "v2" }))), false);
});

// ── remote watcher: serialized polls + abort on stop (P1 — remote concurrency) ─

function listenOn(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("startWatcher is local-only and rejects a remote-shaped target before any fetch", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  try {
    await assert.rejects(
      () => startWatcher({ mode: "remote", remoteBase: "https://example.invalid", onChange: () => {} } as never),
      /remote bundle watching is not supported/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── privilege split (end-to-end over a real listener) ─────────────────────────

const SECRET = "test-session-secret-pages-spike";

async function bootPagesServer(): Promise<{ handle: UiServerHandle; origin: string; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-pages-"));
  await initBundle(dir);
  const bundle: Bundle = { root: dir };
  // A registered page at the LEGACY locations (blob + its type:View registry doc — old folders
  // stay recognized), plus an OFF-LIMITS blob that is NOT a page — the A1 confinement must
  // refuse to mint a nonce for the latter.
  await writeBlob(bundle, "pages/test.html", Buffer.from("<!doctype html><title>t</title><p>hi</p>"), "text/html; charset=utf-8");
  await writeBlob(bundle, "secrets/creds.bin", Buffer.from("TOP-SECRET"), "application/octet-stream");
  await writeDoc(bundle, { id: "pages-registry/test", frontmatter: { type: "View", title: "Test", entry: "pages/test.html" }, body: "" });
  // A current-location View alongside the legacy-located one — the mixed board.
  await writeBlob(bundle, "views/board.html", Buffer.from("<!doctype html><title>board</title><p>view</p>"), "text/html; charset=utf-8");
  await writeDoc(bundle, { id: "views-registry/board", frontmatter: { type: "View", title: "Board", entry: "views/board.html" }, body: "" });
  // A RETIRED legacy Page-TYPED doc: its entry bytes exist, but the doc is no longer a
  // registration anywhere — mint must refuse (tasks/remove-legacy-page-bridge-support).
  await writeBlob(bundle, "pages/retired.html", Buffer.from("<!doctype html><title>retired</title>"), "text/html; charset=utf-8");
  await writeDoc(bundle, { id: "pages-registry/retired", frontmatter: { type: "Page", title: "Retired", entry: "pages/retired.html" }, body: "" });
  // INVALID registrations (the one-predicate review fold-in): docs the launcher rejects must not
  // mint or serve either, even when their declared entry's bytes exist under an accepted prefix.
  await writeBlob(bundle, "pages/loose.html", Buffer.from("<!doctype html><title>loose</title>"), "text/html; charset=utf-8");
  await writeDoc(bundle, { id: "notes/loose", frontmatter: { type: "View", title: "Loose", entry: "pages/loose.html" }, body: "" });
  await writeBlob(bundle, "pages/has space.html", Buffer.from("<!doctype html><title>spacey</title>"), "text/html; charset=utf-8");
  await writeDoc(bundle, { id: "pages-registry/spacey", frontmatter: { type: "View", title: "Spacey", entry: "pages/has space.html" }, body: "" });
  await writeDoc(bundle, { id: "views-registry/offprefix", frontmatter: { type: "View", title: "Off prefix", entry: "secrets/creds.bin" }, body: "" });
  // A kind convention with a terminal declaration — the /__ui/kinds endpoint's fixture.
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      description: "A unit of work.",
      links: { "depends on": "Task" },
      link_descriptions: { "depends on": "A prerequisite task that must be completed first." },
      fields: {
        required: ["title", "superbee_progress_status"],
        values: { superbee_progress_status: ["todo", "done", "canceled"] },
        terminal: { superbee_progress_status: ["done", "canceled"] },
        descriptions: { title: "A concise summary.", superbee_progress_status: "Current state." },
      },
    },
    body: "# Task",
  });
  await writeDoc(bundle, {
    id: "conventions/claim",
    frontmatter: {
      type: "Convention",
      title: "Claim",
      governs: "Claim",
      fields: {
        required: ["title", "superbee_progress_status"],
        values: { superbee_progress_status: ["active", "challenged", "locked", "deprecated"] },
        value_descriptions: {
          superbee_progress_status: {
            active: "Supported, but still open to revision.",
            challenged: "Contrary evidence or reasoning requires resolution.",
            locked: "Verified at the required standard for downstream reliance.",
            deprecated: "Retained for history but not for new reliance.",
          },
        },
      },
    },
    body: "# Claim",
  });
  // Two linked docs — the /__ui/edges endpoint's fixture (mirrors core's own query-edges.test.ts fixture style).
  await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "A" }, body: "See [also b](b.md)." });
  await writeDoc(bundle, { id: "tasks/b", frontmatter: { type: "Task", title: "B" }, body: "" });
  await writeDoc(bundle, { id: "roadmap-items/x", frontmatter: { type: "Roadmap Item", title: "X" }, body: "[contains](../tasks/a.md)." });
  const handle = await bootUiServer({ mode: "dir", port: 0, router: createRouter(bundle), bundle, sessionSecret: SECRET });
  const origin = `http://${handle.host}:${handle.port}`;
  return {
    handle,
    origin,
    dir,
    cleanup: async () => {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("REQUIRED: a page nonce is rejected by every data route (it is not the session secret)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    // Mint a nonce with a valid session (cookie + X-Requested-With).
    const mint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test.html" }),
    });
    assert.equal(mint.status, 200);
    const { nonce, url } = (await mint.json()) as { nonce: string; url: string };

    // The nonce as a data-route ?token= is NOT the session secret -> 403.
    assert.equal((await fetch(`${origin}/v0/bundles/default/docs?token=${nonce}`)).status, 403);
    // The nonce as a data-route cookie -> 403.
    assert.equal(
      (await fetch(`${origin}/v0/bundles/default/docs`, { headers: { cookie: `aslite_ui_session=${nonce}` } })).status,
      403,
    );

    // But the nonce DOES serve its one page's bytes, WITHOUT any session cookie (opaque-origin iframe).
    const page = await fetch(`${origin}${url}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
  } finally {
    await cleanup();
  }
});

test("the session token does NOT open the page route to arbitrary keys (it is not a nonce)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    // Presenting the session secret where a nonce is expected resolves to no key -> 403.
    assert.equal((await fetch(`${origin}/__page/${SECRET}`)).status, 403);
  } finally {
    await cleanup();
  }
});

test("mint requires BOTH a session AND X-Requested-With (CSRF belt)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    const body = JSON.stringify({ key: "pages/test.html" });
    const headersJson = { "content-type": "application/json" };
    // No session at all.
    assert.equal((await fetch(`${origin}/__page/mint`, { method: "POST", headers: headersJson, body })).status, 403);
    // Session cookie but no X-Requested-With.
    assert.equal(
      (await fetch(`${origin}/__page/mint`, { method: "POST", headers: { ...headersJson, cookie: `aslite_ui_session=${SECRET}` }, body })).status,
      403,
    );
    // Both present -> ok.
    assert.equal(
      (
        await fetch(`${origin}/__page/mint`, {
          method: "POST",
          headers: { ...headersJson, cookie: `aslite_ui_session=${SECRET}`, "x-requested-with": "test" },
          body,
        })
      ).status,
      200,
    );
  } finally {
    await cleanup();
  }
});

test("mint of an unsafe key (traversal / reserved .md) is a USAGE error, not a nonce", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    const res = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "../../etc/hosts" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

test("A1: mint is confined to REGISTERED page entries — an off-limits blob cannot be minted/exfiltrated", async () => {
  const { origin, cleanup } = await bootPagesServer();
  const mintKey = (key: string) =>
    fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key }),
    });
  try {
    // A REAL, existing blob that is not a page (not under pages/, not a registered entry) -> refused.
    assert.equal((await mintKey("secrets/creds.bin")).status, 403);
    // Under the page prefix but NOT declared by any type:Page doc -> refused.
    assert.equal((await mintKey("pages/not-registered.html")).status, 403);
    // The registered page entry -> still minted (happy path intact).
    assert.equal((await mintKey("pages/test.html")).status, 200);
  } finally {
    await cleanup();
  }
});

test("LOCATION-SURVIVAL + REJECTION PIN: a View mints from either folder generation, but a legacy Page-TYPED doc no longer mints", async () => {
  const { origin, cleanup } = await bootPagesServer();
  const mintKey = (key: string) =>
    fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key }),
    });
  const mintRegistryId = (registryId: string) =>
    fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ registryId }),
    });
  try {
    // A current-location View mints and serves.
    const mint = await mintKey("views/board.html");
    assert.equal(mint.status, 200, "a registered View entry must mint");
    const { url } = (await mint.json()) as { url: string };

    // ...and its bytes serve through the nonce route with the page CSP (renders in the iframe).
    const page = await fetch(`${origin}${url}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    assert.match(Buffer.from(await page.arrayBuffer()).toString("utf8"), /<title>board<\/title>/);

    // Legacy LOCATIONS survive: the View-typed doc under pages-registry//pages/ still mints.
    assert.equal((await mintKey("pages/test.html")).status, 200, "a View at the legacy locations must keep minting");

    // REJECTION PIN (tasks/remove-legacy-page-bridge-support): the legacy Page-TYPED doc is no
    // longer a registration — neither its entry key nor its registry id mints, even though the
    // blob bytes exist. Restoring 'Page' to the accepted names turns this red.
    assert.equal((await mintKey("pages/retired.html")).status, 403, "a Page-typed doc's entry must not mint");
    const retired = await mintRegistryId("pages-registry/retired");
    assert.equal(retired.status, 403, "a Page-typed registry id must not mint");
    const envelope = (await retired.json()) as { error?: { message?: string } };
    assert.match(String(envelope.error?.message), /migrate-legacy-view-names/, "the refusal points at the remedy");

    // Confinement is intact under the new prefix: views/ alone is not registration.
    assert.equal((await mintKey("views/not-registered.html")).status, 403);
  } finally {
    await cleanup();
  }
});

test("ONE-PREDICATE: an entry declared ONLY by an invalid registration cannot mint (dir mode) — invalid registry id, malformed entry, off-prefix entry", async () => {
  const { origin, cleanup } = await bootPagesServer();
  const mintKey = (key: string) =>
    fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key }),
    });
  try {
    // notes/loose (type View, valid entry, INVALID registry id) declares pages/loose.html and its
    // bytes exist — the launcher rejects that doc, so mint must too.
    assert.equal((await mintKey("pages/loose.html")).status, 403, "an invalid registry id must not put its entry on the allowlist");
    // pages-registry/spacey declares a NONEMPTY entry that fails the entry grammar; the key itself
    // passes blob-key safety AND the prefix guard, so a 403 here is the registration predicate.
    assert.equal((await mintKey("pages/has space.html")).status, 403, "a malformed declared entry must not mint");
    // views-registry/offprefix declares an off-prefix entry — never mintable (prefix guard AND predicate).
    assert.equal((await mintKey("secrets/creds.bin")).status, 403);
    // The valid registrations on the same board still mint (the predicate rejects docs, not the board).
    assert.equal((await mintKey("pages/test.html")).status, 200);
    assert.equal((await mintKey("views/board.html")).status, 200);
  } finally {
    await cleanup();
  }
});

test("ONE-PREDICATE: serve-time re-verification rides the same predicate — an INVALID registration cannot keep a live nonce serving", async () => {
  const { origin, dir, cleanup } = await bootPagesServer();
  try {
    const mint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test.html" }),
    });
    assert.equal(mint.status, 200);
    const { url } = (await mint.json()) as { url: string };
    assert.equal((await fetch(`${origin}${url}`)).status, 200);

    // Remove the VALID registration and re-declare the same entry from an INVALID one (a type
    // View doc outside the registry namespace). The launcher rejects that doc; serve-time
    // re-verification must too — the invalid registration cannot keep the entry alive.
    const bundle: Bundle = { root: dir };
    await deleteDoc(bundle, "pages-registry/test");
    await writeDoc(bundle, { id: "notes/test-slot", frontmatter: { type: "View", title: "Squatter", entry: "pages/test.html" }, body: "" });
    assert.equal((await fetch(`${origin}${url}`)).status, 403, "an invalid registration must not resurrect a revoked entry");
  } finally {
    await cleanup();
  }
});

test("LOCATION-SURVIVAL: the watcher's snapshot covers views/ blobs — a views/ hot-reload is observable, legacy-located pages/ unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-views-watch-"));
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeBlob(bundle, "pages/legacy.html", Buffer.from("<p>legacy</p>"), "text/html; charset=utf-8");
    await writeBlob(bundle, "views/board.html", Buffer.from("<p>v1</p>"), "text/html; charset=utf-8");
    await writeBlob(bundle, "secrets/creds.bin", Buffer.from("TOP-SECRET"), "application/octet-stream");

    const before = await snapshotBundle(bundle);
    assert.ok(before.blobs.has("pages/legacy.html"), "legacy pages/ blobs stay snapshotted");
    assert.ok(before.blobs.has("views/board.html"), "views/ blobs are snapshotted for hot-reload");
    assert.equal(before.blobs.has("secrets/creds.bin"), false, "non-page blobs stay out of the snapshot");

    // A rewritten views/ blob diffs as a blob change — the SSE hot-reload signal.
    await writeBlob(bundle, "views/board.html", Buffer.from("<p>v2</p>"), "text/html; charset=utf-8");
    const change = diffSnapshots(before, await snapshotBundle(bundle));
    assert.deepEqual(change.blobs.changed.map((b) => b.key), ["views/board.html"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LOCATION-SURVIVAL: the dir-mode watcher EMITS a hot-reload change for a rewritten views/ blob", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-views-emit-"));
  try {
    await initBundle(dir);
    const bundle: Bundle = { root: dir };
    await writeBlob(bundle, "views/board.html", Buffer.from("<p>v1</p>"), "text/html; charset=utf-8");

    const changedKeys: string[] = [];
    const watcher = await startWatcher({
      mode: "dir",
      bundle,
      debounceMs: 25,
      onChange: (e) => changedKeys.push(...e.blobs.changed.map((b) => b.key)),
    });
    try {
      await writeBlob(bundle, "views/board.html", Buffer.from("<p>v2</p>"), "text/html; charset=utf-8");
      await waitFor(() => changedKeys.includes("views/board.html"));
    } finally {
      await watcher.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kinds endpoint: session-gated, serves core's loadKinds registry (ONE registry — the bridge's open filter consumes it)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    // No session -> 403 (it is a data endpoint, not page bytes).
    assert.equal((await fetch(`${origin}/__ui/kinds`)).status, 403);

    const res = await fetch(`${origin}/__ui/kinds`, { headers: { cookie: `aslite_ui_session=${SECRET}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      kinds: {
        governs: string;
        description?: string;
        linkDescriptions?: Record<string, string>;
        fields: {
          terminal: Record<string, string[]>;
          descriptions: Record<string, string>;
          valueDescriptions: Record<string, Record<string, string>>;
        };
      }[];
      okfVersion: string;
    };
    assert.equal(body.okfVersion, "0.2");
    const task = body.kinds.find((k) => k.governs === "Task");
    assert.ok(task, "the bundle's Task convention is in the served registry");
    assert.deepEqual(task.fields.terminal, { superbee_progress_status: ["done", "canceled"] });
    assert.equal(task.description, "A unit of work.");
    assert.deepEqual(task.linkDescriptions, {
      "depends on": "A prerequisite task that must be completed first.",
    });
    assert.deepEqual(task.fields.descriptions, { title: "A concise summary.", superbee_progress_status: "Current state." });
    const claim = body.kinds.find((kind) => kind.governs === "Claim");
    assert.deepEqual(claim?.fields.valueDescriptions, {
      superbee_progress_status: {
        active: "Supported, but still open to revision.",
        challenged: "Contrary evidence or reasoning requires resolution.",
        locked: "Verified at the required standard for downstream reliance.",
        deprecated: "Retained for history but not for new reliance.",
      },
    });
  } finally {
    await cleanup();
  }
});

test("edges endpoint: session-gated, serves core's queryEdges over the mounted bundle (dir mode)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    // No session -> 403 (it is a data endpoint, not page bytes).
    assert.equal((await fetch(`${origin}/__ui/edges`)).status, 403);

    const cookie = { cookie: `aslite_ui_session=${SECRET}` };

    // No filter: every derived edge in the fixture bundle.
    const all = await (await fetch(`${origin}/__ui/edges`, { headers: cookie })).json() as { edges: { from: string; to: string; text: string }[]; count: number };
    assert.equal(all.count, 2);
    assert.deepEqual(
      all.edges.map((e) => [e.from, e.to, e.text]).sort(),
      [
        ["roadmap-items/x", "tasks/a", "contains"],
        ["tasks/a", "tasks/b", "also b"],
      ],
    );

    // `to` scopes to backlinks of one target.
    const toA = await (await fetch(`${origin}/__ui/edges?to=tasks/a`, { headers: cookie })).json() as { edges: unknown[]; count: number };
    assert.equal(toA.count, 1);
    assert.deepEqual(toA.edges, [{ from: "roadmap-items/x", to: "tasks/a", text: "contains" }]);

    // `from` + `text` (repeatable `from`, exact-match `text`) ANDs both facets.
    const contains = await (
      await fetch(`${origin}/__ui/edges?from=roadmap-items/&text=contains`, { headers: cookie })
    ).json() as { edges: unknown[]; count: number };
    assert.equal(contains.count, 1);

    // A prefix `from` that matches nothing yields an empty (not error) result.
    const none = await (await fetch(`${origin}/__ui/edges?from=nowhere/`, { headers: cookie })).json() as { edges: unknown[]; count: number };
    assert.deepEqual(none, { edges: [], count: 0 });
  } finally {
    await cleanup();
  }
});

test("edges endpoint: serves core's queryEdges over a RemoteBackend bundle (remote mode) — same plumbing kindsResponse uses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-edges-remote-"));
  let remoteHandle: ServerHandle | undefined;
  let uiHandle: UiServerHandle | undefined;
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "A" }, body: "See [also b](b.md)." });
    await writeDoc(bundle, { id: "tasks/b", frontmatter: { type: "Task", title: "B" }, body: "" });

    remoteHandle = await serve({ bundle, port: 0 });
    const remoteBase = `http://${remoteHandle.host}:${remoteHandle.port}`;
    const remoteBundle: Bundle = { root: remoteBase, backend: new RemoteBackend({ baseUrl: remoteBase, bundleId: "bnd_00000000000000000000000000000000" }) };

    uiHandle = await bootUiServer({
      mode: "remote",
      port: 0,
      remote: {
        baseUrl: remoteBase,
        origin: new URL(remoteBase).origin,
        bundleId: "bnd_00000000000000000000000000000000",
      },
      bundle: remoteBundle,
      sessionSecret: SECRET,
    });
    const origin = `http://${uiHandle.host}:${uiHandle.port}`;

    const res = await fetch(`${origin}/__ui/edges`, { headers: { cookie: `aslite_ui_session=${SECRET}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { edges: { from: string; to: string; text: string }[]; count: number };
    assert.equal(body.count, 1);
    assert.deepEqual(body.edges, [{ from: "tasks/a", to: "tasks/b", text: "also b" }]);
  } finally {
    await uiHandle?.close();
    await remoteHandle?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("edges endpoint: a remote-upstream OUTAGE surfaces as a non-2xx error, never a 200 {edges:[]} (review fold-in — edges is primary data, not a display filter)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-edges-outage-"));
  let uiHandle: UiServerHandle | undefined;
  try {
    // Boot a REAL reference server, note its origin, then close it — the origin now genuinely
    // refuses connections (ECONNREFUSED), mirroring the review's exact repro ("killing the
    // reference server").
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    const remoteHandle = await serve({ bundle, port: 0 });
    const remoteBase = `http://${remoteHandle.host}:${remoteHandle.port}`;
    await remoteHandle.close();

    const remoteBundle: Bundle = { root: remoteBase, backend: new RemoteBackend({ baseUrl: remoteBase, bundleId: "bnd_00000000000000000000000000000000" }) };
    uiHandle = await bootUiServer({
      mode: "remote",
      port: 0,
      remote: {
        baseUrl: remoteBase,
        origin: new URL(remoteBase).origin,
        bundleId: "bnd_00000000000000000000000000000000",
      },
      bundle: remoteBundle,
      sessionSecret: SECRET,
    });
    const origin = `http://${uiHandle.host}:${uiHandle.port}`;

    const res = await fetch(`${origin}/__ui/edges`, { headers: { cookie: `aslite_ui_session=${SECRET}` } });
    assert.notEqual(res.status, 200, "an unreachable remote must NOT read as a successful empty edge list");
    assert.ok(res.status >= 500, `expected an error status, got ${res.status}`);
    const body = (await res.json()) as { error?: { code: string } };
    assert.ok(body.error, "a non-2xx edges response carries the wire error envelope, not a bare {edges:[]}");
  } finally {
    await uiHandle?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B1: the shell asset CSP explicitly confines framing to same-origin (frame-src/child-src 'self')", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    const res = await fetch(`${origin}/`, { headers: { cookie: `aslite_ui_session=${SECRET}` } });
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /child-src 'self'/);
  } finally {
    await cleanup();
  }
});

test("P1: deleting a page's registry doc revokes its LIVE nonce — page bytes stop serving immediately, not at TTL expiry", async () => {
  const { origin, dir, cleanup } = await bootPagesServer();
  try {
    const mint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test.html" }),
    });
    assert.equal(mint.status, 200);
    const { url } = (await mint.json()) as { url: string };

    // The nonce serves while the registry doc lives...
    assert.equal((await fetch(`${origin}${url}`)).status, 200);

    // ...and stops the moment the doc is gone, with the nonce still inside its TTL.
    await deleteDoc({ root: dir }, "pages-registry/test");
    const revoked = await fetch(`${origin}${url}`);
    assert.equal(revoked.status, 403);
  } finally {
    await cleanup();
  }
});

test("P1: retargeting a page's registry doc revokes its OLD nonce — the old key is no longer any Page's entry", async () => {
  const { origin, dir, cleanup } = await bootPagesServer();
  try {
    const mint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test.html" }),
    });
    assert.equal(mint.status, 200);
    const { url: oldUrl } = (await mint.json()) as { url: string };

    // The old nonce serves while its key is still the registry doc's entry...
    assert.equal((await fetch(`${origin}${oldUrl}`)).status, 200);

    // ...retarget the SAME registry doc to a DIFFERENT blob (mirrors a `doc update` that changes
    // `entry`, not a delete) — the mechanism is identical to the delete-revocation path above
    // (`registeredPageEntries` re-derives the live set at SERVE time), so this closes the
    // coverage gap between "doc removed" and "doc's entry moved out from under a live nonce".
    const bundle: Bundle = { root: dir };
    await writeBlob(bundle, "pages/test2.html", Buffer.from("<!doctype html><title>t2</title><p>hi again</p>"), "text/html; charset=utf-8");
    await writeDoc(bundle, { id: "pages-registry/test", frontmatter: { type: "View", title: "Test", entry: "pages/test2.html" }, body: "" });

    // The OLD nonce now 403s — its key is no longer any Page's entry — even though it's still
    // inside its TTL and the registry doc it was minted from still exists (just retargeted, not
    // deleted).
    const revoked = await fetch(`${origin}${oldUrl}`);
    assert.equal(revoked.status, 403);

    // The new entry key mints and serves fine — retargeting isn't a one-way break.
    const remint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test2.html" }),
    });
    assert.equal(remint.status, 200);
    const { url: newUrl } = (await remint.json()) as { url: string };
    assert.equal((await fetch(`${origin}${newUrl}`)).status, 200);
  } finally {
    await cleanup();
  }
});

test("P1: shell assets AND page bytes both send Referrer-Policy: no-referrer (the tokenized shell URL must never ride a referrer)", async () => {
  const { origin, cleanup } = await bootPagesServer();
  try {
    const shell = await fetch(`${origin}/`, { headers: { cookie: `aslite_ui_session=${SECRET}` } });
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("referrer-policy"), "no-referrer");

    const mint = await fetch(`${origin}/__page/mint`, {
      method: "POST",
      headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
      body: JSON.stringify({ key: "pages/test.html" }),
    });
    assert.equal(mint.status, 200);
    const { url } = (await mint.json()) as { url: string };
    const page = await fetch(`${origin}${url}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await cleanup();
  }
});

// ── shutdown vs. live SSE clients (the session-rotation restart hang) ─────────

test("SseHub: a stream arriving after close() is severed, never registered (no late reconnect holds shutdown open)", () => {
  const hub = new SseHub();
  let destroyed = false;
  let wroteHead = false;
  const res = {
    writeHead: () => {
      wroteHead = true;
    },
    write: () => true,
    end: () => {},
    destroy: () => {
      destroyed = true;
    },
    on: () => {},
  } as unknown as ServerResponse;
  hub.close();
  hub.add(res);
  assert.equal(hub.size(), 0, "a post-close stream must not register");
  assert.equal(destroyed, true, "the late stream is severed");
  assert.equal(wroteHead, false, "no event-stream headers are written on a refused stream");
});

test("P1: close() resolves even when an /events request is IN FLIGHT at shutdown — a restart never waits on a client", async () => {
  // The deterministic form of the flaky session-rotation e2e hang: an /events request the
  // server has ACCEPTED but not yet registered when close() fires (handleRequest's async
  // marshaling spans event-loop turns) reaches sse.add AFTER sse.close() has run. Unfixed,
  // that registered a never-ending stream on an active socket and server.close() waited on it
  // forever — reproduced on the unfixed code at one specific close()-timing turn. The
  // vulnerable window is a timing offset by nature, so SWEEP close() across the first few
  // event-loop turns after the request bytes go out: the fixed server must close bounded at
  // EVERY offset (the hub's post-close guard refuses the late stream; closeAllConnections
  // severs the socket).
  for (let ticks = 0; ticks <= 4; ticks++) {
    const { handle, dir } = await bootPagesServer();
    const sock = connect(handle.port, handle.host);
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", () => resolve());
        sock.once("error", reject);
      });
      // Being severed mid-flight by the shutdown under test is the expected outcome, not an error.
      sock.on("error", () => {});
      sock.write(`GET /events?token=${SECRET} HTTP/1.1\r\nhost: ${handle.host}:${handle.port}\r\n\r\n`);
      for (let i = 0; i < ticks; i++) await new Promise<void>((resolve) => setImmediate(resolve));

      const closed = await Promise.race([
        handle.close().then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000).unref()),
      ]);
      assert.equal(closed, true, `close() must resolve promptly with an in-flight /events request (offset: ${ticks} ticks)`);
    } finally {
      sock.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("P1: close() resolves even when a request is held MID-MARSHALING at shutdown (body declared, never sent)", async () => {
  // The timing-INDEPENDENT form of the same hang: a request the server has accepted whose body
  // marshaling can never finish (content-length declared, bytes withheld) keeps its socket
  // active for as long as the client pleases — unfixed, server.close() waited on it forever
  // (verified: this construction hangs the unfixed close() deterministically, no tick sweep
  // needed). closeAllConnections severs it; the try/caught 500 fallback absorbs the aborted
  // marshaling without an unhandled rejection.
  const { handle, dir } = await bootPagesServer();
  const sock = connect(handle.port, handle.host);
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    sock.on("error", () => {});
    sock.write(
      `POST /events?token=${SECRET} HTTP/1.1\r\nhost: ${handle.host}:${handle.port}\r\nx-requested-with: test\r\ncontent-length: 3\r\n\r\n`,
    );
    // Let the server accept the request and block awaiting the 3 body bytes that never come.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const closed = await Promise.race([
      handle.close().then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000).unref()),
    ]);
    assert.equal(closed, true, "close() must resolve promptly with a mid-marshaling request held open");
  } finally {
    sock.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Boot `bootUiServer` in dir mode over a fresh bundle with the real router WRAPPED so a PUT parks inside the router until the returned hook fires — the deterministic seam for the post-close write race. */
async function bootWithHeldPut(hold: (release: () => void) => Promise<void> | void): Promise<{
  handle: UiServerHandle;
  origin: string;
  dir: string;
  bundle: Bundle;
  putEntered: Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-drain-"));
  await initBundle(dir);
  const bundle: Bundle = { root: dir };
  let signalEntered!: () => void;
  const putEntered = new Promise<void>((resolve) => (signalEntered = resolve));
  const real = createRouter(bundle);
  const router = async (req: Request): Promise<Response> => {
    if (req.method === "PUT") {
      signalEntered();
      await new Promise<void>((release) => void hold(release));
    }
    return real(req);
  };
  const handle = await bootUiServer({ mode: "dir", port: 0, router, bundle, sessionSecret: SECRET });
  return { handle, origin: `http://${handle.host}:${handle.port}`, dir, bundle, putEntered };
}

function sendPut(origin: string, id: string): Promise<unknown> {
  return fetch(`${origin}/v0/bundles/default/docs/${id}`, {
    method: "PUT",
    headers: { cookie: `aslite_ui_session=${SECRET}`, "content-type": "application/json", "x-requested-with": "test" },
    body: JSON.stringify({ frontmatter: { type: "Task", title: "Raced write" }, body: "" }),
    // The socket is severed by the shutdown under test, so this fetch's rejection is expected.
  }).catch(() => undefined);
}

test("P1: an accepted local mutation COMMITS BEFORE close() resolves — never after it (post-close write race)", async () => {
  // The one-level-deeper form of the shutdown race: closeAllConnections severs the CLIENT, but a
  // mutation already executing inside the router is server-side work — if close() resolves while
  // it runs, the write lands AFTER shutdown ostensibly finished (the destructive post-close
  // commit). Chosen semantics, pinned here: dir mode FINISHES what it accepted — the write
  // commits, and close() does not resolve until it has (aborting a local fs write mid-flight
  // risks partial state).
  let release!: () => void;
  const { handle, origin, dir, bundle, putEntered } = await bootWithHeldPut((r) => (release = r));
  try {
    const put = sendPut(origin, "tasks/raced");
    await putEntered; // the mutation is now accepted and parked INSIDE the router

    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    // ORDER pin: close() must not resolve ahead of the accepted mutation.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(closed, false, "close() resolved while an accepted mutation was still executing");

    release();
    await closing;
    await put;
    // COHERENCE pin: the accepted write landed, and it landed before close() resolved.
    const doc = await readDoc(bundle, "tasks/raced");
    assert.equal(doc.frontmatter.title, "Raced write", "the accepted mutation must have committed before close() resolved");
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1: a bundle dir deleted after close() resolves STAYS deleted — no post-close handler resurrects it", async () => {
  // The reviewer's worst repro: close() resolves, the operator deletes the bundle dir, and a
  // handler still executing from before shutdown RECREATES the directory and commits its doc.
  // With draining, nothing outlives close(): the (timer-held, self-releasing) mutation commits
  // BEFORE close() resolves, so the deletion afterwards is final.
  const { handle, origin, dir, putEntered } = await bootWithHeldPut((release) => {
    setTimeout(release, 300);
  });
  try {
    const put = sendPut(origin, "tasks/resurrected");
    await putEntered;

    await handle.close(); // must drain the parked mutation before resolving
    await rm(dir, { recursive: true, force: true });

    // Wait past the point where an undrained handler would have woken and written.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    await put;
    const resurrected = await stat(dir).then(
      () => true,
      () => false,
    );
    assert.equal(resurrected, false, "a post-close handler resurrected the deleted bundle dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() is safe to call CONCURRENTLY during the drain window — both calls settle, no unhandledRejection", async () => {
  // The latent double-close defect: close() creates its listener-closed promise EAGERLY but only
  // awaits it AFTER the drain — a second close() during a parked drain gets that promise's
  // ERR_SERVER_NOT_RUNNING rejection sitting handler-less across macrotask turns, a genuine
  // unhandledRejection (process-fatal under node's default --unhandled-rejections=throw). The
  // guard: a no-op catch attached at creation marks it handled immediately while the later
  // await still observes the real outcome.
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let release!: () => void;
    const { handle, origin, dir, putEntered } = await bootWithHeldPut((r) => (release = r));
    try {
      const put = sendPut(origin, "tasks/double-close");
      await putEntered; // the drain window is now held open by the parked mutation

      const first = handle.close();
      const second = handle.close();
      // Let macrotask turns pass with both closes mid-drain — the window where an unguarded
      // second listener-closed rejection surfaces as unhandled.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      release();

      const outcomes = await Promise.allSettled([first, second]);
      await put;
      assert.equal(outcomes[0].status, "fulfilled", "the first close() must succeed");
      assert.equal(outcomes.length, 2); // the second may reject (already closing) — settled, never unhandled
      // Give the loop a turn to flush any pending unhandledRejection emission before asserting.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(rejections, [], "concurrent close() during the drain produced an unhandledRejection");
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
