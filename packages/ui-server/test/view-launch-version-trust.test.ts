/**
 * Active-View launch identity must come from bytes the host hashed itself, never from a version the
 * backend asserts. In remote mode the asserted value arrives as the blob response's `x-version`
 * header — entirely under the upstream's control — so a host that trusted it would let a remote
 * pin one version token across a byte swap and keep a stale approval admitting substituted HTML.
 *
 * These pins drive the real `/__page/mint`, `/__ui/views/authorize`, and nonce-serve paths against
 * an upstream that lies about `x-version`. They fail if launch identity, serve-time currentness, or
 * approval subjects are ever rewired back onto the asserted version.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { blobVersion, RemoteBackend, type Bundle } from "@superbee/core";
import { SessionViewAuthorizationStore, bootUiServer, type UiServerHandle } from "../src/index.js";

const SECRET = "version-trust-secret";
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });
const COOKIE = `aslite_ui_session=${SECRET}`;
const JSON_HEADERS = {
  cookie: COOKIE,
  "content-type": "application/json",
  "x-requested-with": "agentstate-lite-ui",
};

const ORIGINAL = "<!doctype html><p>original</p>";
const SUBSTITUTED = "<!doctype html><p>substituted</p>";

/**
 * A version token that is well-formed and stable but corresponds to no content the host will ever
 * hash. A malformed value would be rejected by shape alone and would not prove trust was dropped.
 */
const LIE = `sha256:${"0".repeat(64)}`;

interface ProbeBody {
  error?: { message?: unknown };
  launchId?: unknown;
  url?: unknown;
  authorized?: unknown;
  required?: unknown;
  authorization?: { required?: unknown; authorized?: unknown; contentVersion?: unknown };
}

async function post(server: UiServerHandle, pathname: string, body: unknown): Promise<{ status: number; body: ProbeBody }> {
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
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseText) as ProbeBody });
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

/**
 * An upstream whose served bytes can change under the test while `x-version` stays pinned to one
 * value — the shape a host trusting the header cannot distinguish from an unchanged View.
 */
async function lyingUpstream(): Promise<{ origin: string; serve(html: string): void; close(): Promise<void> }> {
  let html = ORIGINAL;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/docs")) {
      const docs =
        url.searchParams.get("type") === "View"
          ? [{
              id: "views-registry/board",
              version: "registry-v1",
              frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" },
            }]
          : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ docs, next_cursor: null }));
      return;
    }
    if (url.pathname.endsWith("/docs/views-registry/board")) {
      res.writeHead(200, { "content-type": "application/json", "x-version": "registry-v1" });
      res.end(JSON.stringify({
        id: "views-registry/board",
        frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" },
        body: "",
      }));
      return;
    }
    if (url.pathname.includes("/blobs/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-version": LIE });
      res.end(Buffer.from(html, "utf8"));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return {
    origin,
    serve(next: string) { html = next; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function remoteBundle(origin: string): Bundle {
  return {
    root: origin,
    backend: new RemoteBackend({ baseUrl: origin, bundle: "default", maxRetries: 0 }),
  };
}

test("launch identity is the host's own hash, not the version the upstream asserts", async () => {
  const upstream = await lyingUpstream();
  try {
    const server = await bootUiServer({
      mode: "remote",
      remoteBase: upstream.origin,
      bundle: remoteBundle(upstream.origin),
      sessionSecret: SECRET,
      renderDocument,
      viewAuthorization: new SessionViewAuthorizationStore(),
    });
    try {
      const mint = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(mint.status, 200, String(mint.body.error?.message ?? ""));

      const asserted = LIE;
      const computed = blobVersion(new Uint8Array(Buffer.from(ORIGINAL, "utf8")));
      assert.notEqual(computed, asserted, "the fixture must actually disagree, or this pin proves nothing");
      assert.equal(
        mint.body.authorization?.contentVersion,
        computed,
        "the launch must carry the hash of the admitted bytes",
      );
      assert.notEqual(
        mint.body.authorization?.contentVersion,
        asserted,
        "the upstream's x-version must never become launch identity",
      );
    } finally {
      await server.close();
    }
  } finally {
    await upstream.close();
  }
});

test("a pinned upstream version cannot hold a launch current across a byte swap", async () => {
  const upstream = await lyingUpstream();
  try {
    const server = await bootUiServer({
      mode: "remote",
      remoteBase: upstream.origin,
      bundle: remoteBundle(upstream.origin),
      sessionSecret: SECRET,
      renderDocument,
      viewAuthorization: new SessionViewAuthorizationStore(),
    });
    try {
      const mint = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(mint.status, 200, String(mint.body.error?.message ?? ""));
      const url = mint.body.url as string;

      const before = await fetch(`http://${server.host}:${server.port}${url}`);
      assert.equal(before.status, 200);
      assert.equal(await before.text(), ORIGINAL, "the honest launch serves its own bytes");

      // The registry doc and x-version are byte-for-byte unchanged; only the HTML moved. A host
      // trusting the asserted version sees nothing happen here and keeps the launch alive.
      upstream.serve(SUBSTITUTED);

      // The serve path replays the bytes captured at mint, so the failure is not that the
      // substitution is served — it is that the launch survives a source change it should not
      // have. The nonce stays live and the approval keeps covering a View the bundle no longer
      // registers, until someone reads the new bytes through a launch minted for the old ones.
      const after = await fetch(`http://${server.host}:${server.port}${url}`);
      assert.equal(after.status, 403, "changed source bytes must revoke the launch, not keep serving it");

      const reused = await fetch(`http://${server.host}:${server.port}${url}`);
      assert.equal(reused.status, 403, "the revoked nonce must stay dead on reuse");
    } finally {
      await server.close();
    }
  } finally {
    await upstream.close();
  }
});

test("an approval for the honest bytes does not admit substituted bytes under the same asserted version", async () => {
  const upstream = await lyingUpstream();
  try {
    const authorizations = new SessionViewAuthorizationStore();
    const server = await bootUiServer({
      mode: "remote",
      remoteBase: upstream.origin,
      bundle: remoteBundle(upstream.origin),
      sessionSecret: SECRET,
      renderDocument,
      viewAuthorization: authorizations,
    });
    try {
      const first = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(first.status, 200, String(first.body.error?.message ?? ""));
      assert.equal(first.body.authorization?.required, true, "a bundle-read View must require approval");
      assert.equal(first.body.authorization?.authorized, false, "nothing is approved yet");

      const approved = await post(server, "/__ui/views/authorize", { launchId: first.body.launchId });
      assert.equal(approved.status, 200, String(approved.body.error?.message ?? ""));
      assert.equal(approved.body.authorized, true, "the human approved these exact bytes");

      upstream.serve(SUBSTITUTED);

      const second = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(second.status, 200, String(second.body.error?.message ?? ""));
      assert.equal(
        second.body.authorization?.authorized,
        false,
        "the approval was for the previous bytes — the pinned x-version must not carry it forward",
      );
      assert.notEqual(
        second.body.authorization?.contentVersion,
        first.body.authorization?.contentVersion,
        "changed bytes must change the subject even when the asserted version does not move",
      );
    } finally {
      await server.close();
    }
  } finally {
    await upstream.close();
  }
});
