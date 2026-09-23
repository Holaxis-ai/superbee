// Hosted sign-in target resolution and issuer discovery.
//
// The hosted gateway publishes RFC 9728 protected-resource metadata. Its `authorization_servers`
// names the issuer, and `superbee_cli_client_id` (an extra member RFC 9728 permits) names the
// native CLI client. Nothing about the issuer or client is trusted from anywhere else, so a
// refresh token is only ever sent to the issuer the host itself named at sign-in.
import { CliError } from "../errors.js";

/** The default resource path on a hosted origin: the Superbee API audience is `<origin>/mcp`. */
export const DEFAULT_RESOURCE_PATH = "/mcp";

/**
 * Built-in CLI client ids by hosted origin, used only when the host does not yet publish
 * `superbee_cli_client_id`. Provisional: empty until the native client is provisioned. The
 * protected-resource metadata is the intended source, and `--client-id` or
 * SUPERBEE_OAUTH_CLIENT_ID override both.
 */
export const BUILT_IN_CLIENT_IDS: Readonly<Record<string, string>> = Object.freeze({});

/** Scopes the CLI asks for. Anything else the issuer grants is tolerated, not required. */
export const REQUESTED_SCOPE = "openid offline_access bundles:discover documents:read documents:write";

const HTTP_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 256 * 1024;

export interface HostedTarget {
  /** The hosted origin, e.g. `https://mcp.getsuperbee.com`. */
  readonly origin: string;
  /** The protected resource and token audience, e.g. `https://mcp.getsuperbee.com/mcp`. */
  readonly audience: string;
  /** Where the protected-resource metadata lives. */
  readonly metadataUrl: string;
}

export interface IssuerEndpoints {
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly authorizationEndpoint?: string;
  readonly revocationEndpoint?: string;
}

export interface Discovery extends IssuerEndpoints {
  readonly target: HostedTarget;
  /** The client id the host publishes, when it publishes one. */
  readonly publishedClientId?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Drop trailing "/" characters. A plain loop, not a regex: `/\/+$/` backtracks quadratically on
 * long slash runs in attacker-supplied metadata (CodeQL js/polynomial-redos).
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** True for https, or plain http on loopback. */
export function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  } catch {
    return false;
  }
}

/** HTTPS everywhere, plain HTTP only on loopback (local issuers and tests). */
export function assertSecureUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("USAGE", `${what} is not a valid URL: ${value}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new CliError("USAGE", `${what} must use https (plain http is accepted only on loopback): ${value}`);
}

/**
 * Resolve a `--host` value. A bare origin targets the default Superbee API audience (`/mcp`);
 * a URL with a path (an agent connection such as `/agents/<uuid>/mcp`) targets that resource.
 */
export function resolveHostedTarget(host: string): HostedTarget {
  const url = assertSecureUrl(host.trim(), "--host");
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError("USAGE", "--host must be a plain URL without credentials, query or fragment");
  }
  const path = trimTrailingSlashes(url.pathname);
  const resourcePath = path === "" ? DEFAULT_RESOURCE_PATH : path;
  return {
    origin: url.origin,
    audience: `${url.origin}${resourcePath}`,
    metadataUrl: `${url.origin}/.well-known/oauth-protected-resource${resourcePath}`,
  };
}

async function fetchJson(fetchImpl: FetchLike, url: string, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new CliError("TRANSIENT", `could not reach ${what} at ${url}`, { details: { retryable: true } });
  }
  if (!response.ok) {
    throw new CliError(response.status >= 500 ? "TRANSIENT" : "RUNTIME", `${what} at ${url} returned HTTP ${response.status}`, {
      details: { status: response.status, ...(response.status >= 500 ? { retryable: true } : {}) },
    });
  }
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new CliError("RUNTIME", `${what} at ${url} is too large`);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new CliError("RUNTIME", `${what} at ${url} is not a JSON object`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function endpoint(meta: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(meta[key]);
  if (value === undefined) return undefined;
  if (!isSecureUrl(value)) throw new CliError("RUNTIME", `issuer ${key} is not an https URL: ${value}`);
  return value;
}

/** Candidate authorization-server metadata URLs: OIDC first (Auth0), then RFC 8414. */
export function issuerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const trimmed = trimTrailingSlashes(issuer);
  const path = trimTrailingSlashes(url.pathname);
  return [
    `${trimmed}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
  ];
}

function sameIssuer(a: string, b: string): boolean {
  return trimTrailingSlashes(a) === trimTrailingSlashes(b);
}

/** Read the issuer's endpoints, requiring the metadata to name the same issuer. */
export async function discoverIssuer(fetchImpl: FetchLike, issuer: string): Promise<IssuerEndpoints> {
  assertSecureUrl(issuer, "issuer");
  let lastError: unknown;
  for (const url of issuerMetadataUrls(issuer)) {
    let meta: Record<string, unknown>;
    try {
      meta = await fetchJson(fetchImpl, url, "issuer metadata");
    } catch (error) {
      lastError = error;
      continue;
    }
    const named = optionalString(meta.issuer);
    if (named === undefined || !sameIssuer(named, issuer)) {
      throw new CliError("RUNTIME", `issuer metadata at ${url} names a different issuer`, { details: { refused: "issuer_mismatch" } });
    }
    const tokenEndpoint = endpoint(meta, "token_endpoint");
    if (tokenEndpoint === undefined) throw new CliError("RUNTIME", `issuer metadata at ${url} has no token_endpoint`);
    const device = endpoint(meta, "device_authorization_endpoint");
    const authorization = endpoint(meta, "authorization_endpoint");
    const revocation = endpoint(meta, "revocation_endpoint");
    return {
      issuer,
      tokenEndpoint,
      ...(device ? { deviceAuthorizationEndpoint: device } : {}),
      ...(authorization ? { authorizationEndpoint: authorization } : {}),
      ...(revocation ? { revocationEndpoint: revocation } : {}),
    };
  }
  throw lastError instanceof CliError ? lastError : new CliError("RUNTIME", `could not read issuer metadata for ${issuer}`);
}

/** Discover the issuer (and any published CLI client id) from the host's protected-resource metadata. */
export async function discoverHosted(fetchImpl: FetchLike, target: HostedTarget): Promise<Discovery> {
  const prm = await fetchJson(fetchImpl, target.metadataUrl, "protected-resource metadata");
  // RFC 9728 section 3.3: `resource` is required and must equal the resource the metadata was fetched for.
  const resource = optionalString(prm.resource);
  if (resource === undefined) {
    throw new CliError("RUNTIME", `protected-resource metadata at ${target.metadataUrl} has no resource`);
  }
  if (trimTrailingSlashes(resource) !== target.audience) {
    throw new CliError("RUNTIME", `protected-resource metadata names resource ${resource}, expected ${target.audience}`);
  }
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
  const issuer = optionalString(servers[0]);
  if (issuer === undefined) {
    throw new CliError("RUNTIME", `protected-resource metadata at ${target.metadataUrl} names no authorization server`);
  }
  const endpoints = await discoverIssuer(fetchImpl, issuer);
  const published = optionalString(prm.superbee_cli_client_id);
  return { ...endpoints, target, ...(published ? { publishedClientId: published } : {}) };
}

export interface ClientIdSources {
  readonly flag?: string;
  readonly env?: string;
  readonly published?: string;
  readonly origin: string;
}

/** Flag, then env, then the host's published id, then the provisional built-in table. */
export function resolveClientId(sources: ClientIdSources): { clientId: string; source: string } {
  if (sources.flag) return { clientId: sources.flag, source: "flag" };
  if (sources.env) return { clientId: sources.env, source: "env" };
  if (sources.published) return { clientId: sources.published, source: "host-metadata" };
  const builtIn = BUILT_IN_CLIENT_IDS[sources.origin];
  if (builtIn) return { clientId: builtIn, source: "built-in" };
  throw new CliError("USAGE", `${sources.origin} does not publish a Superbee CLI client id yet`, {
    help: "pass --client-id <id> (or set SUPERBEE_OAUTH_CLIENT_ID) with the CLI client id for this host",
    details: { host: sources.origin },
  });
}
