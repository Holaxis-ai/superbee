// Reverse-proxy `/v0/*` to an explicit remote origin (plans/ui-v1.md rev 3.2): Bearer injection is
// CONDITIONAL on a stored key existing for that origin (a loopback `serve` target typically has
// none — the zero-cloud E2E depends on this staying a no-op in that case); when present, the
// `Authorization` header is OVERWRITTEN, never appended. Hop-by-hop headers are stripped both
// directions; the local session cookie is never forwarded upstream (it authenticates the LOCAL
// proxy, not the remote); the error path builds a FRESH envelope and never echoes the outbound
// request's own headers (a failure must not become a header-reflection channel for the key).

import { resolveWireRequest, WireRequestResolutionError } from "@superbee/server/router";
import type { BundleId } from "@superbee/core/storage";

export interface RemoteUiTarget {
  readonly baseUrl: string;
  readonly origin: string;
  readonly bundleId: BundleId;
  readonly apiKey?: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// Response-direction drops: WHATWG fetch (undici) DECODES a compressed upstream body but
// leaves the original `Content-Encoding`/`Content-Length` headers visible — copying them onto
// the already-decoded stream makes the browser try to decode plain bytes a second time
// (ERR_CONTENT_DECODING_FAILED → "Failed to fetch"). Found live against a compressed hosted
// response; invisible to the local E2E because the reference server never compresses. The local
// server sets its own framing.
const RESPONSE_DROP = new Set(["content-encoding", "content-length"]);

function copyHeaders(from: Headers, opts: { dropCookie?: boolean; dropContentCoding?: boolean } = {}): Headers {
  const out = new Headers();
  for (const [key, value] of from) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (opts.dropCookie && lower === "cookie") continue;
    if (opts.dropContentCoding && RESPONSE_DROP.has(lower)) continue;
    out.set(key, value);
  }
  return out;
}

function freshErrorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Proxy one `/v0/*` request to an exact remote target. `apiKey` is the stored key for its exact
 * origin-and-bundle pair, if any (`undefined` for a keyless target, e.g. reference `serve()` used by
 * the E2E harness) — its presence alone decides whether `Authorization` is set at all.
 * `signal` is the ui server's shutdown signal: at close(), in-flight upstream requests are
 * ABORTED rather than awaited (a slow remote must not stall shutdown; the remote owns its own
 * write coherence).
 */
export async function proxyToRemote(request: Request, remote: RemoteUiTarget, signal?: AbortSignal): Promise<Response> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(remote.baseUrl);
  } catch {
    return freshErrorResponse(500, "RUNTIME", "remote UI target is invalid");
  }
  if (baseUrl.origin !== remote.origin) {
    return freshErrorResponse(500, "RUNTIME", "remote UI target origin does not match its base URL");
  }
  let resolved;
  try {
    resolved = resolveWireRequest(request);
  } catch (error) {
    if (error instanceof WireRequestResolutionError) return freshErrorResponse(error.status, error.code, error.message);
    return freshErrorResponse(400, "USAGE", error instanceof Error ? error.message : String(error));
  }
  if (resolved.scope === "bundle" && resolved.bundleId !== remote.bundleId) {
    return freshErrorResponse(404, "NOT_FOUND", "remote bundle route is not available");
  }
  const incomingUrl = new URL(request.url);
  const target = new URL(remote.baseUrl + incomingUrl.pathname + incomingUrl.search);
  // The local per-run session `?token=` is OUR trust boundary, not the remote's — never forward
  // it (it would otherwise leak into the remote's access logs for no reason).
  target.searchParams.delete("token");

  const headers = copyHeaders(request.headers, { dropCookie: true });
  const credentialed = resolved.scope === "bundle" && remote.apiKey !== undefined;
  if (credentialed) headers.set("authorization", `Bearer ${remote.apiKey}`);
  else headers.delete("authorization");

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const bodyBytes = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(new Request(target, { method, headers, body: bodyBytes, signal, redirect: "manual" }));
  } catch (err) {
    return freshErrorResponse(502, "RUNTIME", `could not reach remote ${remote.baseUrl} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (credentialed && upstream.status >= 300 && upstream.status < 400) {
    return freshErrorResponse(502, "RUNTIME", "credentialed remote request refused an upstream redirect");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyHeaders(upstream.headers, { dropContentCoding: true }),
  });
}
