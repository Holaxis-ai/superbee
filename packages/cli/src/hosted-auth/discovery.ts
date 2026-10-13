// Hosted sign-in target resolution and issuer discovery.
//
// The hosted gateway publishes RFC 9728 protected-resource metadata. Its `authorization_servers`
// names the issuer, and `superbee_cli_client_id` (an extra member RFC 9728 permits) names the
// native CLI client. Nothing about the issuer or client is trusted from anywhere else, so a
// refresh token is only ever sent to the issuer the host itself named at sign-in.
import { CliError } from "../errors.js";
import { commandToken } from "../command-text.js";
import { isWorkspaceSlug } from "../hosted/reference.js";

/** The default resource path on a hosted origin: the Superbee API audience is `<origin>/mcp`. */
export const DEFAULT_RESOURCE_PATH = "/mcp";

/** The protected-resource metadata member naming the host's Superbee CLI client. */
export const PUBLISHED_CLIENT_ID_FIELD = "superbee_cli_client_id";

/**
 * Built-in CLI client ids by hosted origin, used only when the host does not publish
 * `superbee_cli_client_id`. Empty: the host's metadata is the source, and `--client-id` or
 * SUPERBEE_OAUTH_CLIENT_ID override it.
 */
export const BUILT_IN_CLIENT_IDS: Readonly<Record<string, string>> = Object.freeze({});

/** Scopes the CLI asks for. Anything else the issuer grants is tolerated, not required. */
export const REQUESTED_SCOPE = "openid offline_access bundles:discover documents:read documents:write";

const HTTP_TIMEOUT_MS = 10_000;
/** An OAuth client id as the CLI accepts it from a host: visible ASCII, no spaces, bounded. */
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
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
  /** The host published `superbee_cli_client_id`, but not as a plausible client id. */
  readonly publishedClientIdMalformed?: true;
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
  let prm: Record<string, unknown>;
  try {
    prm = await fetchJson(fetchImpl, target.metadataUrl, "protected-resource metadata");
  } catch (error) {
    if (error instanceof CliError && error.details?.status === 404) throw missingMetadataError(target);
    throw error;
  }
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
  return { ...endpoints, target, ...publishedClientId(prm) };
}

/** The host's published CLI client id: absent, a plausible client id, or malformed. */
function publishedClientId(prm: Record<string, unknown>): { publishedClientId?: string; publishedClientIdMalformed?: true } {
  const value = prm[PUBLISHED_CLIENT_ID_FIELD];
  if (value === undefined || value === null) return {};
  if (typeof value === "string" && CLIENT_ID.test(value)) return { publishedClientId: value };
  return { publishedClientIdMalformed: true };
}

export interface ClientIdSources {
  readonly flag?: string;
  readonly env?: string;
  readonly published?: string;
  /** The host published a malformed id: refused unless the flag or env names one. */
  readonly publishedMalformed?: boolean;
  readonly origin: string;
  /** Where the host's metadata was read, for the refusal when it publishes no id. */
  readonly metadataUrl?: string;
}

/** Flag, then env, then the host's published id, then the provisional built-in table. */
export function resolveClientId(sources: ClientIdSources): { clientId: string; source: string } {
  if (sources.flag) return { clientId: sources.flag, source: "flag" };
  if (sources.env) return { clientId: sources.env, source: "env" };
  if (sources.published) return { clientId: sources.published, source: "host-metadata" };
  const details = {
    host: sources.origin,
    field: PUBLISHED_CLIENT_ID_FIELD,
    ...(sources.metadataUrl ? { metadata_url: sources.metadataUrl } : {}),
  };
  if (sources.publishedMalformed) {
    // The host meant to name a client; a built-in id must not silently stand in for it.
    throw new CliError("RUNTIME", `${sources.origin} publishes a malformed ${PUBLISHED_CLIENT_ID_FIELD} in its protected-resource metadata`, {
      help: "report this to the host's operator; meanwhile pass --client-id <id> or set SUPERBEE_OAUTH_CLIENT_ID if you were given one",
      details,
    });
  }
  const builtIn = BUILT_IN_CLIENT_IDS[sources.origin];
  if (builtIn) return { clientId: builtIn, source: "built-in" };
  throw new CliError("USAGE", `${sources.origin} publishes no Superbee CLI client id (no ${PUBLISHED_CLIENT_ID_FIELD} in its protected-resource metadata)`, {
    help: "this host has no Superbee CLI client yet; if its operator gave you one, pass --client-id <id> or set SUPERBEE_OAUTH_CLIENT_ID",
    details,
  });
}

// ---------------------------------------------------------------------------------------------
// Workspace origins

/**
 * Where a workspace browser origin (`<slug>.<parent>`) points at the gateway that serves its
 * protected-resource metadata. The pointer only says where to look: the gateway's own RFC 9728
 * metadata must still name the same resource, and the issuer still comes from that metadata alone.
 */
export const WORKSPACE_POINTER_PATH = "/.well-known/superbee-workspace";

export interface WorkspaceOrigin {
  /** The gateway the pointer names, resolved as if the person had typed it to `--host`. */
  readonly target: HostedTarget;
  /** The workspace the origin belongs to. */
  readonly workspaceSlug: string;
  /** The origin the person named. */
  readonly requestedOrigin: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAX_POINTER_RESOURCE_LENGTH = 2048;

/** The hostname without its first label, when that leaves at least two labels; null otherwise. */
function parentDomain(hostname: string): string | null {
  if (hostname.startsWith("[") || IPV4.test(hostname)) return null;
  const labels = hostname.split(".");
  if (labels.length < 3 || labels.some((label) => label === "")) return null;
  return labels.slice(1).join(".");
}

/**
 * True when a target may be a workspace origin: the default resource on a bare https origin with
 * no explicit port, on a named host under a parent domain of two or more labels.
 */
export function mayBeWorkspaceOrigin(target: HostedTarget): boolean {
  const url = new URL(target.origin);
  return url.protocol === "https:" && url.port === "" && target.audience === `${target.origin}${DEFAULT_RESOURCE_PATH}` && parentDomain(url.hostname) !== null;
}

/**
 * The gateway a pointer's `resource` names, when this origin may send the person there: https, no
 * credentials, query, fragment or explicit port, and a different host under the same parent domain
 * as the origin. Null for anything else.
 */
export function trustedPointerTarget(origin: string, resource: unknown): HostedTarget | null {
  if (typeof resource !== "string" || resource.length > MAX_POINTER_RESOURCE_LENGTH || resource.includes("@")) return null;
  let from: URL;
  let to: URL;
  try {
    from = new URL(origin);
    to = new URL(resource);
  } catch {
    return null;
  }
  if (from.protocol !== "https:" || to.protocol !== "https:") return null;
  if (to.username || to.password || to.port !== "" || from.port !== "" || to.search || to.hash) return null;
  if (to.hostname === from.hostname) return null;
  const parent = parentDomain(from.hostname);
  if (parent === null || parentDomain(to.hostname) !== parent) return null;
  try {
    return resolveHostedTarget(resource);
  } catch {
    return null;
  }
}

/**
 * The refusal for a host with no protected-resource metadata. A host `<label>.<parent>` is often a
 * workspace address, so the help names the gateway form as a likely fix, not a certain one.
 */
export function missingMetadataError(target: HostedTarget): CliError {
  const hostname = new URL(target.origin).hostname;
  const parent = parentDomain(hostname);
  const label = hostname.split(".")[0]!;
  const suggestion = parent !== null && label !== "mcp" && isWorkspaceSlug(label) ? { host: `https://mcp.${parent}`, workspace: label } : null;
  return new CliError("RUNTIME", `protected-resource metadata at ${target.metadataUrl} returned HTTP 404`, {
    details: {
      status: 404,
      reason: "no_protected_resource_metadata",
      host: target.origin,
      ...(suggestion ? { suggested_host: suggestion.host, suggested_workspace: suggestion.workspace } : {}),
    },
    help: suggestion
      ? `${target.origin} may be a workspace address rather than the sign-in host; if so, re-run with --host ${commandToken(suggestion.host)} --workspace ${commandToken(suggestion.workspace)} (--workspace only where the command takes it)`
      : `${target.origin} publishes no Superbee sign-in metadata; check the URL, or ask the host's operator which Superbee host to use`,
  });
}

/** The pointer at an origin, validated; null when it is absent, unreadable or not trusted. */
async function readWorkspacePointer(fetchImpl: FetchLike, target: HostedTarget): Promise<WorkspaceOrigin | null> {
  let pointer: Record<string, unknown>;
  try {
    pointer = await fetchJson(fetchImpl, `${target.origin}${WORKSPACE_POINTER_PATH}`, "workspace pointer");
  } catch {
    return null;
  }
  if (pointer.schema_version !== 1 || !isWorkspaceSlug(pointer.workspace_slug)) return null;
  const gateway = trustedPointerTarget(target.origin, pointer.resource);
  if (gateway === null) return null;
  return { target: gateway, workspaceSlug: pointer.workspace_slug, requestedOrigin: target.origin };
}

/**
 * Follow a workspace origin to its gateway, one hop at most: the gateway is never asked for a
 * pointer of its own. Null when the target is not a possible workspace origin, or its metadata
 * answers anything but 404 (normal discovery then reads or reports it). Metadata absent with no
 * trusted pointer is refused with {@link missingMetadataError}.
 */
export async function followWorkspaceOrigin(fetchImpl: FetchLike, target: HostedTarget): Promise<WorkspaceOrigin | null> {
  if (!mayBeWorkspaceOrigin(target)) return null;
  let status: number;
  try {
    const response = await fetchImpl(target.metadataUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    return null;
  }
  if (status !== 404) return null;
  const followed = await readWorkspacePointer(fetchImpl, target);
  if (followed === null) throw missingMetadataError(target);
  return followed;
}
