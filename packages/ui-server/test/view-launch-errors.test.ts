import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend, writeBlob, writeDoc, type Bundle } from "@superbee/core";
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
    assert.equal(unknown.error.message, "No registered View with ID 'views-registry/unknown'.");

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
