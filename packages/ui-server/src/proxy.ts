// Reverse-proxy `/v0/*` to an explicit remote origin (plans/ui-v1.md rev 3.2): Bearer injection is
// CONDITIONAL on a stored key existing for that origin (a loopback `serve` target typically has
// none — the zero-cloud E2E depends on this staying a no-op in that case); when present, the
// `Authorization` header is OVERWRITTEN, never appended. Hop-by-hop headers are stripped both
// directions; the local session cookie is never forwarded upstream (it authenticates the LOCAL
// proxy, not the remote); the error path builds a FRESH envelope and never echoes the outbound
// request's own headers (a failure must not become a header-reflection channel for the key).

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
 * Proxy one `/v0/*` request to `remoteBase`. `apiKey` is the stored key for the remote's
 * origin, if any (`undefined` for a keyless target, e.g. the local reference `serve()` used by
 * the E2E harness) — its presence alone decides whether `Authorization` is set at all.
 * `signal` is the ui server's shutdown signal: at close(), in-flight upstream requests are
 * ABORTED rather than awaited (a slow remote must not stall shutdown; the remote owns its own
 * write coherence).
 */
export async function proxyToRemote(request: Request, remoteBase: string, apiKey: string | undefined, signal?: AbortSignal): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const target = new URL(remoteBase + incomingUrl.pathname + incomingUrl.search);
  // The local per-run session `?token=` is OUR trust boundary, not the remote's — never forward
  // it (it would otherwise leak into the remote's access logs for no reason).
  target.searchParams.delete("token");

  const headers = copyHeaders(request.headers, { dropCookie: true });
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  else headers.delete("authorization");

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const bodyBytes = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(new Request(target, { method, headers, body: bodyBytes, signal }));
  } catch {
    return freshErrorResponse(502, "RUNTIME", "could not reach the remote bundle server");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyHeaders(upstream.headers, { dropContentCoding: true }),
  });
}
