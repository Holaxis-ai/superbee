/**
 * End-to-end pins for the CURRENT `access:` registry field (no legacy `bridge:` anywhere in these
 * fixtures) across every security call site that resolves it: mint capability derivation, nonce
 * serve-time revalidation (dir mode via launchIsCurrent, remote mode inline), and the
 * bundle-propose action gate. Discarding `access` at any one of those sites must turn at least one
 * of these tests red — the legacy-field fixtures elsewhere cannot see that mutation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { MemoryBackend, RemoteBackend, readDocVersioned, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";

const SECRET = "access-field-secret";
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });
const COOKIE = `aslite_ui_session=${SECRET}`;
const T = "2026-07-23T00:00:00.000Z";
const HTML = "<!doctype html><button>done</button>";
const JSON_HEADERS = {
  cookie: COOKIE,
  "content-type": "application/json",
  "x-requested-with": "agentstate-lite-ui",
};
const PREAUTHORIZED_VIEWS = {
  async isAuthorized() { return true; },
  async authorize() {},
};

interface ProbeResponse {
  status: number;
  body: { error?: { message?: unknown }; status?: unknown; launchId?: unknown; approvalToken?: unknown; url?: unknown };
}

async function post(server: UiServerHandle, pathname: string, body: unknown): Promise<ProbeResponse> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: server.host,
        port: server.port,
        path: pathname,
        method: "POST",
        headers: { "content-length": String(Buffer.byteLength(text)), ...JSON_HEADERS },
      },
      (res) => {
        let responseText = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseText += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseText) as ProbeResponse["body"] });
          } catch (error) {
            reject(new Error(`response was not JSON: ${responseText} (${String(error)})`));
          }
        });
      },
    );
    req.once("error", reject);
    req.end(text);
  });
}

async function mintLaunch(server: UiServerHandle, registryId: string): Promise<{ url: string; launchId: string }> {
  const mint = await post(server, "/__page/mint", { registryId });
  assert.equal(mint.status, 200, String(mint.body.error?.message ?? ""));
  assert.equal(typeof mint.body.url, "string");
  assert.equal(typeof mint.body.launchId, "string");
  return { url: mint.body.url as string, launchId: mint.body.launchId as string };
}

async function fetchPage(server: UiServerHandle, url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://${server.host}:${server.port}${url}`);
  return { status: res.status, text: await res.text() };
}

test("access-only registry docs (dir mode): mint derives the capability from `access`, the nonce serves, and the bundle-propose action gate opens/closes on it", async () => {
  const bundle: Bundle = { root: "mem://access-field", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: { required: ["title", "status"], optional: [], values: { status: ["todo", "done"] } },
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "todo", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/propose",
    frontmatter: { type: "View", title: "Propose", entry: "views/propose.html", access: "bundle-propose", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/read",
    frontmatter: { type: "View", title: "Read", entry: "views/read.html", access: "bundle-read", timestamp: T },
    body: "",
  });
  await writeBlob(bundle, "views/propose.html", new TextEncoder().encode(HTML), "text/html; charset=utf-8");
  await writeBlob(bundle, "views/read.html", new TextEncoder().encode(HTML), "text/html; charset=utf-8");

  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    actor: "mike/test",
    viewAuthorization: PREAUTHORIZED_VIEWS,
    serveAsset: () => ({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: new Uint8Array() }),
  });
  try {
    // Mint + serve: the launch derived from `access:` must survive serve-time revalidation.
    const propose = await mintLaunch(server, "views-registry/propose");
    const proposeServed = await fetchPage(server, propose.url);
    assert.equal(proposeServed.status, 200, "serve revalidation must resolve the SAME capability the mint derived");
    assert.equal(proposeServed.text, HTML);

    // The bundle-propose gate OPENS for access: bundle-propose (proves mint resolved `access`,
    // and prepare's launchIsCurrent revalidation resolves it identically).
    const target = await readDocVersioned(bundle, "tasks/alpha");
    const action = { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: target.version };
    const prepared = await post(server, "/__ui/actions/prepare", { launchId: propose.launchId, action });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.status, "prepared", String(prepared.body.error?.message ?? prepared.body.status));
    const cancelled = await post(server, "/__ui/actions/cancel", { approvalToken: prepared.body.approvalToken as string });
    assert.equal(cancelled.body.status, "cancelled");

    // The gate CLOSES for access: bundle-read — capability distinction rides the new field.
    const read = await mintLaunch(server, "views-registry/read");
    assert.equal((await fetchPage(server, read.url)).status, 200);
    const refused = await post(server, "/__ui/actions/prepare", { launchId: read.launchId, action });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.status, "revoked", "a non-propose access value must not open the action gate");
    assert.equal((await readDocVersioned(bundle, "tasks/alpha")).doc.frontmatter.status, "todo");
  } finally {
    await server.close();
  }
});

test("REJECTION PIN (dir mode): a legacy bridge-only registry doc resolves access NONE end to end — it mints and serves as a content view, but the action gate never opens", async () => {
  // tasks/remove-legacy-page-bridge-support: the legacy `bridge:` spelling is no longer read.
  // The doc still REGISTERS (registration never depended on the capability field), so the pin is
  // the DOWNGRADE: mint derives `none`, and a propose attempt is refused. Restoring the bridge
  // fallback in core's declaredAccessValue turns this red.
  const bundle: Bundle = { root: "mem://bridge-only-denial", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "todo", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/legacy-propose",
    frontmatter: { type: "View", title: "Legacy propose", entry: "views/legacy-propose.html", bridge: "bundle-propose", timestamp: T },
    body: "",
  });
  await writeBlob(bundle, "views/legacy-propose.html", new TextEncoder().encode(HTML), "text/html; charset=utf-8");

  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    actor: "mike/test",
    viewAuthorization: PREAUTHORIZED_VIEWS,
    serveAsset: () => ({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: new Uint8Array() }),
  });
  try {
    const launch = await mintLaunch(server, "views-registry/legacy-propose");
    const served = await fetchPage(server, launch.url);
    assert.equal(served.status, 200, "the doc still registers — only its capability is downgraded");
    assert.ok(served.text.startsWith(HTML), "the response preserves the exact bundle HTML prefix");
    assert.match(served.text, /superbee\.view-ready\.v1/);
    assert.doesNotMatch(served.text, new RegExp(launch.launchId));

    const target = await readDocVersioned(bundle, "tasks/alpha");
    const action = { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: target.version };
    const refused = await post(server, "/__ui/actions/prepare", { launchId: launch.launchId, action });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.status, "revoked", "bridge: bundle-propose must not open the action gate");
    assert.equal((await readDocVersioned(bundle, "tasks/alpha")).doc.frontmatter.status, "todo", "no write happened");
  } finally {
    await server.close();
  }
});

test("access-only registry doc (remote mode): the inline serve-time revalidation resolves `access` — the nonce keeps serving", async () => {
  const bytes = Buffer.from(HTML, "utf8");
  const remote = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/docs")) {
      const docs =
        url.searchParams.get("type") === "View"
          ? [{ id: "views-registry/board", version: "v1", frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" } }]
          : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docs, next_cursor: null }));
      return;
    }
    if (url.pathname.endsWith("/docs/views-registry/board")) {
      res.writeHead(200, { "content-type": "application/json", "x-version": "v1" });
      res.end(JSON.stringify({
        id: "views-registry/board",
        frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" },
        body: "",
      }));
      return;
    }
    if (url.pathname.includes("/blobs/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-version": "bv1" });
      res.end(bytes);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const remoteOrigin = await new Promise<string>((resolve) => {
    remote.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(remote.address() as AddressInfo).port}`));
  });
  try {
    const server = await bootUiServer({
      mode: "remote",
      remoteBase: remoteOrigin,
      bundle: {
        root: remoteOrigin,
        backend: new RemoteBackend({ baseUrl: remoteOrigin, bundle: "default", maxRetries: 0 }),
      },
      sessionSecret: SECRET,
      renderDocument,
      viewAuthorization: PREAUTHORIZED_VIEWS,
    });
    try {
      const launch = await mintLaunch(server, "views-registry/board");
      const served = await fetchPage(server, launch.url);
      assert.equal(served.status, 200, "remote serve revalidation must resolve the capability from `access`");
      assert.equal(served.text, HTML);
    } finally {
      await server.close();
    }
  } finally {
    remote.close();
  }
});
