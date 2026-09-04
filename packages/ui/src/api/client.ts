/**
 * Hand-written typed API client for the wire-protocol v0 surface, called same-origin against
 * whichever server the `ui` command is proxying/mounting (`--dir` in-process router, or
 * `--remote` reverse proxy. The SPA receives only the selected bundle id, never the remote API key.
 *
 * Every route is bundle-scoped (`BASE` below) — see `types.ts`'s ROUTE-SHAPE NOTE. Mutations
 * (anything but GET/HEAD) carry `X-Requested-With` unconditionally: the `ui` server's session
 * guard requires it as a CSRF belt-and-braces on top of the `SameSite=Strict` cookie (rev 3.2:
 * "a malicious page could otherwise fire blind key-injected reads/writes through the proxy").
 */
import type { DocHead, ListDocsResponse, ReadDocResponse, WireErrorEnvelope, WriteDocResponse } from "./types.js";

let bundleId = "default";

/** Configure the one wire target before the SPA mounts; local mode retains its legacy alias. */
export function configureWireBundleId(value: string | null | undefined): void {
  if (value === null || value === undefined) {
    bundleId = "default";
    return;
  }
  if (!/^bnd_[0-9a-f]{32}$/u.test(value)) throw new Error("invalid remote bundle id in UI configuration");
  bundleId = value;
}
/** Default page size the router honors when `limit` is omitted (`DEFAULT_LIST_LIMIT`, router.ts). */
const LIST_LIMIT = 50;

/** A typed API failure: HTTP status + the wire envelope's `code`/`details`, so callers can branch (412 conflict, 401 auth, 429 rate-limited) without re-parsing. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Strip a quoted (`"sha256:..."`) or weak (`W/"sha256:..."`) ETag wrapper down to the bare token — mirrors the router's own `stripETagWrapper` tolerance, kept local (no runtime core import into the browser bundle; see `types.ts`'s module doc). */
function stripETagWrapper(raw: string): string {
  const noWeak = raw.startsWith("W/") ? raw.slice(2) : raw;
  return noWeak.startsWith('"') && noWeak.endsWith('"') ? noWeak.slice(1, -1) : noWeak;
}

/** Read the response version off `X-Version` (primary) or `ETag` (fallback) — see `router.ts`'s `versionHeaders` doc for why both exist. */
function versionOf(res: Response): string | undefined {
  const xVersion = res.headers.get("X-Version");
  if (xVersion) return xVersion;
  const etag = res.headers.get("ETag");
  return etag ? stripETagWrapper(etag) : undefined;
}

/** Exported so `pages.ts`'s shell-local (non-`/v0/`) fetches can throw the SAME typed {@link ApiError} on a non-2xx — a raw `fetch` there would otherwise lose the status code the interceptor needs to recognize a dead session (see `queryClient.ts`'s `onQueryError`). */
export async function parseErrorEnvelope(res: Response): Promise<ApiError> {
  let envelope: WireErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as WireErrorEnvelope;
  } catch {
    envelope = null;
  }
  const code = envelope?.error?.code ?? "RUNTIME";
  const message = envelope?.error?.message ?? `request failed with status ${res.status}`;
  return new ApiError(res.status, code, message, envelope?.error?.details);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  ifMatch?: string;
}

/** Call one bundle-scoped `/v0/...` route same-origin. Throws {@link ApiError} on any non-2xx. */
async function request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; res: Response }> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.ifMatch !== undefined) headers["If-Match"] = options.ifMatch;
  if (method !== "GET" && method !== "HEAD") headers["X-Requested-With"] = "superbee-ui";

  const res = await fetch(`/v0/bundles/${bundleId}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw await parseErrorEnvelope(res);
  const data = (await res.json()) as T;
  return { data, res };
}

/** Filter facets for {@link listHeadsPage}/{@link listAllHeads} — generic over `type`/`prefix` so no caller (the launcher, a page's bridge query) hardcodes a kind here. */
export interface ListHeadsParams {
  /** Restrict to a frontmatter `type` (omit to list every doc). */
  type?: string;
  /** Restrict to a bundle-relative id prefix (e.g. `conventions/`). */
  prefix?: string;
}

/** One page of `GET .../docs?fields=frontmatter[&type=][&prefix=]`, following `cursor` when given. */
export async function listHeadsPage(params: ListHeadsParams, cursor?: string): Promise<ListDocsResponse> {
  const query = new URLSearchParams({ fields: "frontmatter", limit: String(LIST_LIMIT) });
  if (params.type) query.set("type", params.type);
  if (params.prefix) query.set("prefix", params.prefix);
  if (cursor) query.set("cursor", cursor);
  const { data } = await request<ListDocsResponse>(`/docs?${query.toString()}`);
  return data;
}

/** Every matching doc's head (frontmatter + version), following `next_cursor` to exhaustion — a caller bucketing by an enum field (a page's board view) needs the full set, not one page. */
export async function listAllHeads(params: ListHeadsParams): Promise<DocHead[]> {
  const all: DocHead[] = [];
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await listHeadsPage(params, cursor);
    all.push(...page.docs);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return all;
}

/** Full doc + its version (the CAS basis for a following `putDoc`). */
export async function getDoc(id: string): Promise<{ doc: ReadDocResponse; version: string }> {
  const { data, res } = await request<ReadDocResponse>(`/docs/${encodeIdPath(id)}`);
  const version = versionOf(res);
  if (!version) throw new ApiError(res.status, "VERSION_MISSING", "response carried no X-Version/ETag header");
  return { doc: data, version };
}

/** `PUT .../docs/{id}` with a required CAS `If-Match` — a write is never unconditional (every mutation is against a version just read). Part of the banked typed-client surface; the read-only pages spike has no live writer, but the method stays for a future write-capable surface. Throws `ApiError` with `status === 412` on a lost race. */
export async function putDoc(
  id: string,
  payload: { frontmatter: Record<string, unknown>; body: string },
  ifMatch: string,
): Promise<WriteDocResponse> {
  const { data } = await request<WriteDocResponse>(`/docs/${encodeIdPath(id)}`, {
    method: "PUT",
    body: payload,
    ifMatch,
  });
  return data;
}

/** Percent-encode each `/`-separated segment of a concept id independently — mirrors the router's own `decodeId` (per-segment decode), so a segment containing a literal `/`-adjacent character round-trips. */
function encodeIdPath(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}
