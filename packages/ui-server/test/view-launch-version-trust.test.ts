/**
 * Active-View launch identity must come from bytes the host hashed itself, never from a version the
 * backend asserts. A backend's blob version is entirely under its control, so a host that trusted it
 * would let a backend pin one version token across a byte swap and keep a stale approval admitting
 * substituted HTML.
 *
 * These pins drive the real `/__page/mint`, `/__ui/views/authorize`, and nonce-serve paths against
 * a backend that lies about its blob version. They fail if launch identity, serve-time currentness, or
 * approval subjects are ever rewired back onto the asserted version.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { blobVersion, MemoryBackend, type Bundle, type ReadBlobResult } from "@superbee/core";
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

/** A backend that reports one pinned blob version whatever bytes it holds. */
class LyingBlobBackend extends MemoryBackend {
  override async readBlob(key: string): Promise<ReadBlobResult | null> {
    const found = await super.readBlob(key);
    return found === null ? null : { ...found, version: LIE };
  }
}

/**
 * A bundle whose served bytes can change under the test while the asserted blob version stays
 * pinned to one value — the shape a host trusting it cannot distinguish from an unchanged View.
 */
async function lyingUpstream(): Promise<{ bundle: Bundle; serve(html: string): Promise<void>; close(): Promise<void> }> {
  const backend = new LyingBlobBackend();
  await backend.write("views-registry/board", {
    id: "views-registry/board",
    frontmatter: { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" },
    body: "",
  });
  const serve = async (html: string): Promise<void> => {
    await backend.writeBlob("views/board.html", Buffer.from(html, "utf8"), "text/html; charset=utf-8");
  };
  await serve(ORIGINAL);
  return { bundle: { root: "mem://lying-view-host", backend }, serve, close: async () => {} };
}

/** These pins exercise only the launch paths; the SPA data route is never called. */
const NO_ROUTER = async (): Promise<Response> => new Response(null, { status: 404 });

test("launch identity is the host's own hash, not the version the upstream asserts", async () => {
  const upstream = await lyingUpstream();
  try {
    const server = await bootUiServer({
      mode: "dir",
      router: NO_ROUTER,
      bundle: upstream.bundle,
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
      mode: "dir",
      router: NO_ROUTER,
      bundle: upstream.bundle,
      sessionSecret: SECRET,
      renderDocument,
      viewAuthorization: new SessionViewAuthorizationStore(),
    });
    try {
      const mint = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(mint.status, 200, String(mint.body.error?.message ?? ""));
      const delivered = await post(server, "/__page/mint", { registryId: "views-registry/board" });
      assert.equal(delivered.status, 200);
      const url = mint.body.url as string;
      const launchId = delivered.body.launchId as string;

      const before = await fetch(`http://${server.host}:${server.port}${delivered.body.url as string}`, {
        headers: { cookie: COOKIE, "x-requested-with": "superbee-ui" },
      });
      assert.equal(before.status, 200);
      assert.equal(await before.text(), ORIGINAL, "the honest launch serves its own bytes");

      // The registry doc and x-version are byte-for-byte unchanged; only the HTML moved. A host
      // trusting the asserted version sees nothing happen here and keeps the launch alive.
      await upstream.serve(SUBSTITUTED);

      // The serve path replays the bytes captured at mint, so the failure is not that the
      // substitution is served — it is that the launch survives a source change it should not
      // have, and the approval keeps covering a View the bundle no longer registers.
      const after = await fetch(`http://${server.host}:${server.port}${url}`, {
        headers: { cookie: COOKIE, "x-requested-with": "superbee-ui" },
      });
      assert.equal(after.status, 403, "changed source bytes must revoke the launch, not deliver it");

      const reused = await post(server, "/__ui/views/verify", { launchId });
      assert.equal(reused.status, 403, "an already-delivered launch is revoked once its source changes");
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
      mode: "dir",
      router: NO_ROUTER,
      bundle: upstream.bundle,
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

      await upstream.serve(SUBSTITUTED);

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
