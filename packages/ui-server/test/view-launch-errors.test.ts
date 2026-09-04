import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MemoryBackend, RemoteBackend, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";

const SECRET = "view-launch-errors-secret";
const HEADERS = {
  cookie: `aslite_ui_session=${SECRET}`,
  "content-type": "application/json",
  "x-requested-with": "agentstate-lite-ui",
};

async function boot(bundle: Bundle): Promise<UiServerHandle> {
  return bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
}

async function mint(server: UiServerHandle, registryId: string): Promise<{
  status: number;
  error: { code?: string; message?: string };
}> {
  const response = await fetch(`http://${server.host}:${server.port}/__page/mint`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ registryId }),
  });
  const payload = await response.json() as { error?: { code?: string; message?: string } };
  return { status: response.status, error: payload.error ?? {} };
}

test("the web adapter preserves the established registered-View failure contract", async () => {
  const bundle: Bundle = { root: "mem://view-launch-errors", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "views-registry/invalid",
    frontmatter: { type: "Page", title: "Retired", entry: "views/invalid.html" },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/missing-entry",
    frontmatter: { type: "View", title: "Missing", entry: "views/missing.html" },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/pinned",
    frontmatter: {
      type: "View",
      title: "Pinned",
      entry: "views/pinned.html",
      entry_version: `sha256:${"0".repeat(64)}`,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/pinned.html",
    new TextEncoder().encode("<!doctype html><p>changed</p>"),
    "text/html; charset=utf-8",
  );

  const server = await boot(bundle);
  try {
    const unknown = await mint(server, "views-registry/unknown");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.error.code, "RUNTIME");
    assert.match(unknown.error.message ?? "", /no concept document 'views-registry\/unknown'/);

    const invalid = await mint(server, "views-registry/invalid");
    assert.equal(invalid.status, 403);
    assert.equal(invalid.error.code, "FORBIDDEN");
    assert.match(invalid.error.message ?? "", /migrate-legacy-view-names/);

    const missingEntry = await mint(server, "views-registry/missing-entry");
    assert.deepEqual(
      { status: missingEntry.status, code: missingEntry.error.code },
      { status: 404, code: "NOT_FOUND" },
    );

    const pinned = await mint(server, "views-registry/pinned");
    assert.deepEqual(
      { status: pinned.status, code: pinned.error.code },
      { status: 409, code: "VERSION_CONFLICT" },
    );
  } finally {
    await server.close();
  }
});

test("the web adapter preserves the retired remote helper's non-success-as-absent contract", async () => {
  const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/docs/views-registry/upstream-failure")) {
      res.writeHead(200, { "content-type": "application/json", "x-version": "registry-v1" });
      res.end(JSON.stringify({
        id: "views-registry/upstream-failure",
        frontmatter: { type: "View", title: "Failure", entry: "views/failure.html" },
        body: "",
      }));
      return;
    }
    if (url.pathname.endsWith("/blobs/views/failure.html")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "RUNTIME", message: "upstream unavailable" } }));
      return;
    }
    if (url.pathname.endsWith("/docs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docs: [], next_cursor: null }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const origin = await new Promise<string>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    });
  });
  const bundle: Bundle = {
    root: origin,
    backend: new RemoteBackend({ baseUrl: origin, bundleId: "bnd_00000000000000000000000000000000", maxRetries: 0 }),
  };
  const server = await bootUiServer({
    mode: "remote",
    bundle,
    remote: {
      baseUrl: origin,
      origin: new URL(origin).origin,
      bundleId: "bnd_00000000000000000000000000000000",
    },
    sessionSecret: SECRET,
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  try {
    const failed = await mint(server, "views-registry/upstream-failure");
    assert.deepEqual(
      { status: failed.status, code: failed.error.code, message: failed.error.message },
      { status: 404, code: "NOT_FOUND", message: "no View bytes found for 'views/failure.html'" },
    );
  } finally {
    await server.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
