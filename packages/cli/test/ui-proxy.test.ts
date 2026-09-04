/**
 * Unit tests for the `--remote` reverse proxy (plans/ui-v1.md rev 3.2): conditional Bearer
 * injection (overwrite, never append), hop-by-hop + cookie stripping, and a fresh error
 * envelope on a transport failure (never echoing the outbound request). `globalThis.fetch` is
 * monkey-patched per test and restored in `afterEach` — the same idiom `remote.test.ts` uses
 * for `RemoteBackend`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { proxyToRemote } from "@superbee/ui-server";
import type { BundleId } from "@superbee/core/storage";

const BUNDLE_ID = "bnd_00000000000000000000000000000000" as BundleId;

function remote(baseUrl: string, apiKey?: string) {
  return { baseUrl, origin: new URL(baseUrl).origin, bundleId: BUNDLE_ID, ...(apiKey === undefined ? {} : { apiKey }) };
}

function withFetch<T>(fn: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("proxyToRemote forwards method/path/query/body to the remote base and returns its response verbatim", async () => {
  let captured: Request | undefined;
  await withFetch(
    async (input: RequestInfo | URL) => {
      captured = input as Request;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs?type=Task`, { method: "GET" });
      const res = await proxyToRemote(incoming, remote("https://example.workers.dev"));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), JSON.stringify({ ok: true }));
    },
  );
  assert.ok(captured);
  assert.equal(captured!.url, `https://example.workers.dev/v0/bundles/${BUNDLE_ID}/docs?type=Task`);
});

test("proxyToRemote sets Authorization when an apiKey is given for the origin", async () => {
  let capturedAuth: string | null = null;
  await withFetch(
    async (input: RequestInfo | URL) => {
      capturedAuth = (input as Request).headers.get("authorization");
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, { method: "GET" });
      await proxyToRemote(incoming, remote("https://example.workers.dev", "secret-key-123"));
    },
  );
  assert.equal(capturedAuth, "Bearer secret-key-123");
});

test("proxyToRemote OVERWRITES a client-supplied Authorization header rather than appending", async () => {
  let capturedAuth: string | null = null;
  await withFetch(
    async (input: RequestInfo | URL) => {
      capturedAuth = (input as Request).headers.get("authorization");
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, {
        method: "GET",
        headers: { Authorization: "Bearer client-supplied-should-be-replaced" },
      });
      await proxyToRemote(incoming, remote("https://example.workers.dev", "server-key"));
    },
  );
  assert.equal(capturedAuth, "Bearer server-key");
});

test("proxyToRemote sends NO Authorization header when no key is stored for the origin (the keyless zero-cloud case)", async () => {
  let sawAuthHeader = true;
  await withFetch(
    async (input: RequestInfo | URL) => {
      sawAuthHeader = (input as Request).headers.has("authorization");
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, { method: "GET" });
      await proxyToRemote(incoming, remote("http://127.0.0.1:4818"));
    },
  );
  assert.equal(sawAuthHeader, false);
});

test("proxyToRemote never forwards the local ui session cookie upstream", async () => {
  let capturedCookie: string | null = "unset";
  await withFetch(
    async (input: RequestInfo | URL) => {
      capturedCookie = (input as Request).headers.get("cookie");
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, {
        method: "GET",
        headers: { Cookie: "aslite_ui_session=should-not-leave-this-machine" },
      });
      await proxyToRemote(incoming, remote("https://example.workers.dev"));
    },
  );
  assert.equal(capturedCookie, null);
});

test("proxyToRemote never forwards the local session ?token= query param upstream", async () => {
  let capturedUrl = "";
  await withFetch(
    async (input: RequestInfo | URL) => {
      capturedUrl = (input as Request).url;
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs?type=Task&token=local-secret`, { method: "GET" });
      await proxyToRemote(incoming, remote("https://example.workers.dev"));
    },
  );
  assert.equal(capturedUrl, `https://example.workers.dev/v0/bundles/${BUNDLE_ID}/docs?type=Task`);
});

test("proxyToRemote DROPS Content-Encoding/Content-Length from the upstream response — fetch already decoded the body, so copying them makes the browser double-decode (found live: Cloudflare brotli → 'Failed to fetch' in Chrome; invisible to the zero-cloud E2E because the reference server never compresses)", async () => {
  await withFetch(
    // Simulate exactly what undici hands back from a compressing upstream: a DECODED body with
    // the ORIGINAL coding headers still visible.
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "br", "content-length": "999" },
      }),
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, { method: "GET" });
      const res = await proxyToRemote(incoming, remote("https://example.workers.dev"));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-encoding"), null);
      assert.notEqual(res.headers.get("content-length"), "999"); // the decoded stream's framing is the local server's job
      assert.equal(res.headers.get("content-type"), "application/json"); // non-coding headers still pass through
      assert.equal(await res.text(), JSON.stringify({ ok: true }));
    },
  );
});

test("proxyToRemote maps a transport failure to a FRESH 502 envelope, never echoing the outbound request", async () => {
  await withFetch(
    async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`, {
        method: "GET",
        headers: { "X-Secret-Should-Not-Echo": "leak-me-not" },
      });
      const res = await proxyToRemote(incoming, remote("http://127.0.0.1:1"));
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("X-Secret-Should-Not-Echo"), null);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "RUNTIME");
      assert.match(body.error.message, /could not reach remote/);
    },
  );
});

test("proxyToRemote rejects a different bundle before fetch and never releases the selected key", async () => {
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
    async () => {
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/bnd_33333333333333333333333333333333/docs");
      const res = await proxyToRemote(incoming, remote("https://example.workers.dev", "bundle-a-key"));
      assert.equal(res.status, 404);
      assert.equal(fetched, false);
      assert.doesNotMatch(await res.text(), /bundle-a-key/);
    },
  );
});

test("proxyToRemote rejects an unknown wire path before fetch and never releases the selected key", async () => {
  let fetched = false;
  await withFetch(
    async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
    async () => {
      const incoming = new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/not-a-resource`);
      const res = await proxyToRemote(incoming, remote("https://example.workers.dev", "bundle-key"));
      assert.equal(res.status, 404);
      assert.equal(fetched, false);
      assert.doesNotMatch(await res.text(), /bundle-key/);
    },
  );
});

test("proxyToRemote never attaches bundle credentials to capabilities", async () => {
  let authorization: string | null = "unset";
  await withFetch(
    async (input: RequestInfo | URL) => {
      authorization = (input as Request).headers.get("authorization");
      return new Response(JSON.stringify({ protocol: 0 }), { status: 200 });
    },
    async () => {
      const res = await proxyToRemote(
        new Request("http://127.0.0.1:9/v0/capabilities"),
        remote("https://example.workers.dev", "bundle-key"),
      );
      assert.equal(res.status, 200);
      assert.equal(authorization, null);
    },
  );
});

test("proxyToRemote refuses credentialed redirects and requires manual redirect handling", async () => {
  let redirect: RequestRedirect | undefined;
  await withFetch(
    async (input: RequestInfo | URL) => {
      redirect = (input as Request).redirect;
      return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/collect" } });
    },
    async () => {
      const res = await proxyToRemote(
        new Request(`http://127.0.0.1:9/v0/bundles/${BUNDLE_ID}/docs`),
        remote("https://example.workers.dev", "bundle-key"),
      );
      assert.equal(redirect, "manual");
      assert.equal(res.status, 502);
      assert.doesNotMatch(await res.text(), /bundle-key|attacker/);
    },
  );
});
