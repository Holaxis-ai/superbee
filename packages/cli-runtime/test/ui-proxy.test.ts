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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs?type=Task", { method: "GET" });
      const res = await proxyToRemote(incoming, "https://example.workers.dev", undefined);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), JSON.stringify({ ok: true }));
    },
  );
  assert.ok(captured);
  assert.equal(captured!.url, "https://example.workers.dev/v0/bundles/default/docs?type=Task");
});

test("proxyToRemote sets Authorization when an apiKey is given for the origin", async () => {
  let capturedAuth: string | null = null;
  await withFetch(
    async (input: RequestInfo | URL) => {
      capturedAuth = (input as Request).headers.get("authorization");
      return new Response(null, { status: 200 });
    },
    async () => {
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", { method: "GET" });
      await proxyToRemote(incoming, "https://example.workers.dev", "secret-key-123");
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", {
        method: "GET",
        headers: { Authorization: "Bearer client-supplied-should-be-replaced" },
      });
      await proxyToRemote(incoming, "https://example.workers.dev", "server-key");
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", { method: "GET" });
      await proxyToRemote(incoming, "http://127.0.0.1:4818", undefined);
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", {
        method: "GET",
        headers: { Cookie: "aslite_ui_session=should-not-leave-this-machine" },
      });
      await proxyToRemote(incoming, "https://example.workers.dev", undefined);
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs?type=Task&token=local-secret", { method: "GET" });
      await proxyToRemote(incoming, "https://example.workers.dev", undefined);
    },
  );
  assert.equal(capturedUrl, "https://example.workers.dev/v0/bundles/default/docs?type=Task");
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", { method: "GET" });
      const res = await proxyToRemote(incoming, "https://example.workers.dev", undefined);
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
      const incoming = new Request("http://127.0.0.1:9/v0/bundles/default/docs", {
        method: "GET",
        headers: { "X-Secret-Should-Not-Echo": "leak-me-not" },
      });
      const res = await proxyToRemote(incoming, "http://127.0.0.1:1", undefined);
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("X-Secret-Should-Not-Echo"), null);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "RUNTIME");
      assert.match(body.error.message, /could not reach remote/);
    },
  );
});
