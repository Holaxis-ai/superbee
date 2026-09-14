// Server URL normalization for the `--remote` wire-protocol flow.
//
// `normalizeServer` validates + normalizes a `--remote <url>` into a {base, resource(=origin)} — the
// origin is the key under which a non-default provisioning integration stores a per-origin API key, and the
// base is what `RemoteBackend` targets. This is the ONLY server-URL helper: the legacy bearer-flow
// (`login --token`/`--server` + `AGENTSTATE_MCP_URL`) was removed — the live remote auth is a
// per-origin API key against a gated wire-protocol deployment, not a stored bearer token.

export interface ServerConfig {
  /** Normalized base URL (no trailing slash), e.g. https://my-worker.example.workers.dev */
  base: string;
  /** The server ORIGIN — the per-origin API-key store key (and OAuth-style audience indicator). */
  resource: string;
}

/**
 * Normalize a raw server URL string into a {base, resource}. Throws on a malformed or non-http(s) URL.
 */
export function normalizeServer(raw: string): ServerConfig {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid server URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`server URL must use http or https: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { base: url.origin + path, resource: url.origin };
}
