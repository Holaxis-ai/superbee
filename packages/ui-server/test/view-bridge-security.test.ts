import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryBackend,
  writeBlob,
  writeDoc,
  type Bundle,
} from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer } from "../src/server.js";

const SECRET = "view-bridge-security-secret";
const renderDocument = ({ id, body }: { id: string; body: string }) => ({
  html: `<article data-id="${id}">${body}</article>`,
  bounded: false,
});
const T = "2026-07-26T00:00:00.000Z";
const headers = {
  cookie: `aslite_ui_session=${SECRET}`,
  "content-type": "application/json",
  "x-requested-with": "agentstate-lite-ui",
};

/** Deliberately violates the backend version contract to prove approval still binds local bytes. */
class LyingBlobVersionBackend extends MemoryBackend {
  override async readBlob(key: string) {
    const result = await super.readBlob(key);
    return result ? { ...result, version: "sha256:unchanged-backend-label" } : null;
  }
}

test("active View data is denied before exact-byte approval and revoked when those bytes change", async () => {
  const bundle: Bundle = {
    root: "mem://view-bridge-security",
    backend: new LyingBlobVersionBackend(),
  };
  await writeDoc(bundle, {
    id: "docs/secret",
    frontmatter: { type: "Doc", title: "Secret", timestamp: T },
    body: "sensitive bundle data",
  });
  await writeDoc(bundle, {
    id: "views-registry/security",
    frontmatter: {
      type: "View",
      title: "Security proof",
      entry: "views/security.html",
      access: "bundle-read",
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/security.html",
    new TextEncoder().encode("<!doctype html><script>parent.postMessage({bridge:'v0',type:'read',id:'r',docId:'docs/secret'},'*')</script>"),
    "text/html; charset=utf-8",
  );

  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://${server.host}:${server.port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() as Record<string, any> };
  };

  try {
    const minted = await post("/__page/mint", { registryId: "views-registry/security" });
    assert.equal(minted.response.status, 200);
    assert.deepEqual(minted.body.authorization, {
      required: true,
      authorized: false,
      contentVersion: minted.body.authorization.contentVersion,
    });

    const denied = await post("/__ui/views/bridge", {
      launchId: minted.body.launchId,
      request: { bridge: "v0", type: "read", id: "r1", docId: "docs/secret" },
    });
    assert.equal(denied.body.reply.error.code, "FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(denied.body), /sensitive bundle data/);

    const approved = await post("/__ui/views/authorize", {
      launchId: minted.body.launchId,
    });
    assert.equal(approved.body.authorized, true);

    const read = await post("/__ui/views/bridge", {
      launchId: minted.body.launchId,
      request: { bridge: "v0", type: "read", id: "r2", docId: "docs/secret" },
    });
    assert.equal(read.body.reply.result.body, "sensitive bundle data");

    const rendered = await post("/__ui/views/bridge", {
      launchId: minted.body.launchId,
      request: { bridge: "v0", type: "render-document", id: "render", docId: "docs/secret" },
    });
    assert.equal(rendered.body.reply.result.document.id, "docs/secret");
    assert.match(rendered.body.reply.result.document.version, /^sha256:/);
    assert.equal(
      rendered.body.reply.result.html,
      '<article data-id="docs/secret">sensitive bundle data</article>',
    );
    assert.equal(rendered.body.reply.result.bounded, false);

    const missing = await post("/__ui/views/bridge", {
      launchId: minted.body.launchId,
      request: { bridge: "v0", type: "render-document", id: "missing", docId: "docs/missing" },
    });
    assert.equal(missing.body.reply.error.code, "NOT_FOUND");

    await writeBlob(
      bundle,
      "views/security.html",
      new TextEncoder().encode("<!doctype html><p>changed</p>"),
      "text/html; charset=utf-8",
    );
    const revoked = await post("/__ui/views/bridge", {
      launchId: minted.body.launchId,
      request: { bridge: "v0", type: "read", id: "r3", docId: "docs/secret" },
    });
    assert.equal(revoked.body.reply.error.code, "FORBIDDEN");

    const reminted = await post("/__page/mint", {
      registryId: "views-registry/security",
    });
    assert.equal(reminted.body.authorization.authorized, false);
    assert.notEqual(
      reminted.body.authorization.contentVersion,
      minted.body.authorization.contentVersion,
    );
  } finally {
    await server.close();
  }
});

test("active View admission accepts only bounded UTF-8 HTML", async () => {
  const bundle: Bundle = {
    root: "mem://view-admission",
    backend: new MemoryBackend(),
  };
  await writeDoc(bundle, {
    id: "views-registry/not-html",
    frontmatter: {
      type: "View",
      title: "Not HTML",
      entry: "views/not-html.bin",
      access: "bundle-read",
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/not-html.bin",
    new Uint8Array([0xff, 0xfe]),
    "application/octet-stream",
  );
  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  try {
    const response = await fetch(`http://${server.host}:${server.port}/__page/mint`, {
      method: "POST",
      headers,
      body: JSON.stringify({ registryId: "views-registry/not-html" }),
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /text\/html/);
  } finally {
    await server.close();
  }
});
