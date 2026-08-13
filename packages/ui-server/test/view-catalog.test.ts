import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer } from "../src/server.js";

test("the web launcher endpoint serves the shared durable View catalog", async () => {
  const bundle: Bundle = { root: "mem://ui-view-catalog", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "views-registry/board",
    frontmatter: {
      type: "View",
      title: "Board",
      entry: "views/board.html",
      access: "bundle-propose",
      presentation: "workspace",
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/dangling",
    frontmatter: {
      type: "View",
      title: "Dangling",
      entry: "views/missing.html",
      access: "bundle-read",
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/board.html",
    new TextEncoder().encode("<!doctype html><title>Board</title>"),
    "text/html; charset=utf-8",
  );
  await writeDoc(bundle, {
    id: "docs/not-registered",
    frontmatter: { type: "View", title: "Invalid", entry: "views/invalid.html" },
    body: "",
  });
  const secret = "view-catalog-secret";
  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: secret,
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  try {
    const response = await fetch(`http://${server.host}:${server.port}/__ui/views`, {
      headers: { cookie: `aslite_ui_session=${secret}` },
    });
    assert.equal(response.status, 200);
    const catalog = await response.json() as {
      views: Array<Record<string, unknown>>;
      total: number;
      invalidRegistrations: number;
      unavailableEntries: number;
    };
    assert.equal(catalog.total, 1);
    assert.equal(catalog.invalidRegistrations, 1);
    assert.equal(catalog.unavailableEntries, 1);
    assert.deepEqual(catalog.views[0], {
      id: "views-registry/board",
      version: catalog.views[0]?.version,
      title: "Board",
      access: "bundle-propose",
      presentation: "workspace",
      timestamp: catalog.views[0]?.timestamp,
    });
  } finally {
    await server.close();
  }
});
