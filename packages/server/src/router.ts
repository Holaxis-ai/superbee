/**
 * Wire-protocol v0 fetch router — the wire-protocol v0 seam-over-HTTP contract
 * (`docs/WIRE-PROTOCOL.md`) implemented as a plain
 * `(req: Request) => Promise<Response>` function using Web-standard `Request`/
 * `Response`, so the identical router can mount unchanged in another Fetch-compatible runtime.
 *
 * ONE-ENGINE RULE: this module contains NO parsing/link/OKF logic of its own.
 * Doc WRITES route through the engine (`writeDocVersioned` from `@superbee/core`)
 * so server-side OKF enforcement (non-empty `type`, id safety, reserved-file
 * rejection) comes free — the engine keeps ALL semantics, the router only maps
 * HTTP <-> the `StorageBackend` seam. Reads / list / versions / reserved-file
 * access go through the bundle's `StorageBackend` DIRECTLY (protocol principle 2:
 * "the seam is the schema" — every endpoint maps 1:1 to a seam method), not
 * through the engine's `query`/`readDoc` wrappers.
 *
 * See `docs/WIRE-PROTOCOL.md` "Implemented by reference" section for the exact
 * endpoint set and any recorded deviations from the draft.
 */

import {
  InvalidInputError,
  VersionConflict,
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  isReservedFile,
  pathFromConceptId,
  stripETagWrapper,
  type BlobKey,
  type ConceptId,
  type DeleteOptions,
  type Frontmatter,
  type ReservedFilename,
  type StorageBackend,
  type StorageCapabilities,
  type Version,
  type WriteOptions,
} from "@superbee/core/storage";
import { queryHeads, writeDocVersioned } from "@superbee/core/engine";

/** Default page size for `GET /docs` when `limit` is not supplied. */
const DEFAULT_LIST_LIMIT = 50;

/** True when `err` carries the `ENOENT`-shaped `.code` the seam's adapters use for "absent". */
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** A bundle-relative concept id from a `docs/{id...}` path tail: decode each `/`-separated segment. */
function decodeId(rawPathTail: string): ConceptId {
  try {
    return rawPathTail
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    throw new InvalidInputError(`invalid percent-encoding in document id '${rawPathTail}'`);
  }
}

/** A bundle-relative blob key from a `blobs/{key...}` path tail — same per-segment decode as {@link decodeId}. */
function decodeBlobKey(rawPathTail: string): BlobKey {
  try {
    return rawPathTail
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    throw new InvalidInputError(`invalid percent-encoding in blob key '${rawPathTail}'`);
  }
}

/**
 * Validate a doc-route id is safe (no path traversal / absolute escape) and is not a
 * reserved filename, THROWING an `InvalidInputError` (mapped to `400 USAGE` by the router's
 * catch-all) before any backend call. `read`/`exists` (HEAD)/`versions`/`readMany` are
 * called directly against the `StorageBackend` (protocol principle 2 — "the seam is
 * the schema"), bypassing the engine's `assertSafeConceptId` guard that only fires on
 * the engine-routed write path. Without this, `FilesystemBackend.read('../../etc/hosts')`
 * resolves OUTSIDE the bundle root (`path.join` does not sandbox `..`) — a
 * network-reachable path-traversal read. This closes that gap server-side (protocol
 * principle 4: OKF/id-safety invariants are enforced server-side too).
 */
function assertValidDocId(id: ConceptId): void {
  assertSafeConceptId(id);
  if (isReservedFile(pathFromConceptId(id))) {
    throw new InvalidInputError(`'${id}' is a reserved file, not a concept document`);
  }
}

/** Build a JSON `Response` with the standard `content-type`, merging in any extra headers. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Build the `{ error: { code, message, details? } }` envelope (`docs/WIRE-PROTOCOL.md` Conventions). */
function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return jsonResponse(status, {
    error: details === undefined ? { code, message } : { code, message, details },
  });
}

/**
 * Map a thrown error to its wire status + envelope. Only the engine's typed
 * `InvalidInputError` is a `400 USAGE`; unknown failures are server/runtime defects and
 * remain retryable `500 RUNTIME` responses. `VersionConflict` and ENOENT retain their
 * narrower protocol meanings.
 */
function errorFromCaught(err: unknown): Response {
  if (err instanceof VersionConflict) {
    return errorResponse(412, "VERSION_CONFLICT", err.message, { expected: err.expected, actual: err.actual });
  }
  if (isEnoent(err)) {
    return errorResponse(404, "NOT_FOUND", err instanceof Error ? err.message : "not found");
  }
  if (err instanceof InvalidInputError) {
    return errorResponse(400, "USAGE", err.message);
  }
  return errorResponse(500, "RUNTIME", err instanceof Error ? err.message : String(err));
}

/**
 * Read `If-Match` / `If-None-Match: *` off a request into the seam's `WriteOptions.expectedVersion`.
 *
 * `If-Match` is passed through `stripETagWrapper`: the router accepts the bare, unwrapped token,
 * but a client or intermediary MAY reflect back a quoted (`"sha256:..."`) or weak (`W/"sha256:..."`)
 * form now that the router's OWN responses are correctly quoted (see `versionHeaders` below), so
 * parsing tolerates both wrapped and bare forms rather than requiring the bare one.
 */
function writeOptionsFromRequest(req: Request, attribution: TrustedAttribution): WriteOptions {
  const options: WriteOptions = {};
  if (req.headers.get("If-None-Match") === "*") {
    options.expectedVersion = null;
  } else {
    const ifMatch = req.headers.get("If-Match");
    if (ifMatch !== null) options.expectedVersion = stripETagWrapper(ifMatch);
  }
  options.actor = attribution.actor;
  if (attribution.agent !== undefined) options.agent = attribution.agent;
  return options;
}

/**
 * Read `If-Match` off a request into the seam's `DeleteOptions.expectedVersion` — the delete
 * counterpart to {@link writeOptionsFromRequest}, deliberately narrower: no `If-None-Match: *`
 * branch (expect-absent is meaningless for a delete — there is no "create" reading of removing
 * something that isn't there) and no `X-Actor` (a delete records no new revision to attribute).
 * Quote/weak-prefix-tolerant via {@link stripETagWrapper}, same as `If-Match` on a write.
 */
function deleteOptionsFromHeaders(req: Request): DeleteOptions {
  const ifMatch = req.headers.get("If-Match");
  return ifMatch !== null ? { expectedVersion: stripETagWrapper(ifMatch) } : {};
}

/**
 * Both version-transport headers for a response that carries `version`: `X-Version` (the bare
 * token — the PRIMARY vehicle, a custom header no intermediary has any reason to rewrite) and a
 * properly RFC-7232-QUOTED `ETag` (secondary, for HTTP-ecosystem tooling that expects one).
 *
 * A bare-token `ETag` (`ETag: sha256:<hex>`) is RFC-7232-invalid and may be stripped by an
 * intermediary. Losing this version can silently downgrade the next guarded write to an
 * unconditional one. `X-Version` is therefore the primary transport; the correctly quoted ETag
 * remains for HTTP compatibility.
 */
function versionHeaders(version: Version): Record<string, string> {
  return { "X-Version": version, ETag: `"${version}"` };
}

/** Immutable hosted bundle id: 16 random bytes rendered as lowercase hexadecimal. */
export type BundleId = `bnd_${string}`;

/** Access needed before a registered endpoint may dispatch. */
export type WireAccessClass = "public" | "read" | "write";

/**
 * The complete public route/method registry for the reference router. Runtime dispatch consumes
 * this table, and the repository contract test compares the same rows with WIRE-PROTOCOL.md, so a
 * route cannot become reachable without entering the documented agreement surface.
 */
export const WIRE_ENDPOINTS = [
  {
    id: "capabilities",
    resource: "capabilities",
    method: "GET",
    path: "/v0/capabilities",
    accessClass: "public",
  },
  {
    id: "docs-list",
    resource: "docs",
    method: "GET",
    path: "/v0/bundles/{bundle}/docs",
    accessClass: "read",
  },
  {
    id: "docs-read-many",
    resource: "docs-read-many",
    method: "POST",
    path: "/v0/bundles/{bundle}/docs:read-many",
    accessClass: "read",
  },
  {
    id: "doc-read",
    resource: "doc",
    method: "GET",
    path: "/v0/bundles/{bundle}/docs/{id...}",
    accessClass: "read",
  },
  {
    id: "doc-write",
    resource: "doc",
    method: "PUT",
    path: "/v0/bundles/{bundle}/docs/{id...}",
    accessClass: "write",
  },
  {
    id: "doc-head",
    resource: "doc",
    method: "HEAD",
    path: "/v0/bundles/{bundle}/docs/{id...}",
    accessClass: "read",
  },
  {
    id: "doc-delete",
    resource: "doc",
    method: "DELETE",
    path: "/v0/bundles/{bundle}/docs/{id...}",
    accessClass: "write",
  },
  {
    id: "doc-versions",
    resource: "doc-versions",
    method: "GET",
    path: "/v0/bundles/{bundle}/docs/{id...}/versions",
    accessClass: "read",
  },
  {
    id: "reserved-read",
    resource: "reserved",
    method: "GET",
    path: "/v0/bundles/{bundle}/reserved/{name}",
    accessClass: "read",
  },
  {
    id: "reserved-write",
    resource: "reserved",
    method: "PUT",
    path: "/v0/bundles/{bundle}/reserved/{name}",
    accessClass: "write",
  },
  {
    id: "blobs-list",
    resource: "blobs",
    method: "GET",
    path: "/v0/bundles/{bundle}/blobs",
    accessClass: "read",
  },
  {
    id: "blob-read",
    resource: "blob",
    method: "GET",
    path: "/v0/bundles/{bundle}/blobs/{key...}",
    accessClass: "read",
  },
  {
    id: "blob-write",
    resource: "blob",
    method: "PUT",
    path: "/v0/bundles/{bundle}/blobs/{key...}",
    accessClass: "write",
  },
  {
    id: "blob-head",
    resource: "blob",
    method: "HEAD",
    path: "/v0/bundles/{bundle}/blobs/{key...}",
    accessClass: "read",
  },
  {
    id: "blob-delete",
    resource: "blob",
    method: "DELETE",
    path: "/v0/bundles/{bundle}/blobs/{key...}",
    accessClass: "write",
  },
] as const;

type WireResource = (typeof WIRE_ENDPOINTS)[number]["resource"];
export type WireEndpointId = (typeof WIRE_ENDPOINTS)[number]["id"];
type WireEndpoint = (typeof WIRE_ENDPOINTS)[number];

type TemplateParams = Record<string, string>;

export type ResolvedWireResource =
  | { kind: "capabilities" }
  | { kind: "docs" }
  | { kind: "docs-read-many" }
  | { kind: "doc"; id: ConceptId }
  | { kind: "doc-versions"; id: ConceptId }
  | { kind: "reserved"; dir: string; name: ReservedFilename }
  | { kind: "blobs" }
  | { kind: "blob"; key: BlobKey };

interface ResolvedWireRouteBase {
  endpointId: WireEndpointId;
  accessClass: WireAccessClass;
  resource: ResolvedWireResource;
  searchParams: URLSearchParams;
}

/** A deployment-scoped route never causes context or backend resolution. */
export interface ResolvedDeploymentWireRoute extends ResolvedWireRouteBase {
  scope: "deployment";
  endpointId: "capabilities";
  accessClass: "public";
  resource: { kind: "capabilities" };
}

/** A bundle-scoped route carries the one canonical bundle selection used by all later stages. */
export interface ResolvedBundleWireRoute extends ResolvedWireRouteBase {
  scope: "bundle";
  bundleId: BundleId;
  accessClass: "read" | "write";
}

export type ResolvedWireRoute = ResolvedDeploymentWireRoute | ResolvedBundleWireRoute;

/** Attribution supplied by the trusted host after authentication, never by public request headers. */
export interface TrustedAttribution {
  actor: string;
  agent?: string;
}

/** The host's one-shot authorization result, including a backend already bound to `route.bundleId`. */
export interface TrustedRouterContext {
  backend: StorageBackend;
  attribution: TrustedAttribution;
}

export interface RouterOptions {
  capabilities: StorageCapabilities;
  resolveContext(
    request: Request,
    route: ResolvedBundleWireRoute,
  ): TrustedRouterContext | Response | Promise<TrustedRouterContext | Response>;
}

/** Typed resolution failure retained as a stable host-side rejection seam. */
export class WireRequestResolutionError extends Error {
  readonly status: 400 | 404;
  readonly code: "USAGE" | "NOT_FOUND";

  constructor(status: 400 | 404, code: "USAGE" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "WireRequestResolutionError";
    this.status = status;
    this.code = code;
  }
}

const BUNDLE_ID_RE = /^bnd_[0-9a-f]{32}$/;

export function isCanonicalBundleId(value: string): value is BundleId {
  return BUNDLE_ID_RE.test(value);
}

function literalSpecificity(path: string): number {
  return path.split("/").filter((segment) => segment !== "" && !segment.startsWith("{")).length;
}

/** Match a registry template without decoding route parameters. */
function matchTemplate(template: string, pathname: string): TemplateParams | undefined {
  const templateSegments = template.split("/");
  const pathSegments = pathname.split("/");
  const params: TemplateParams = {};
  let pathIndex = 0;

  for (let templateIndex = 0; templateIndex < templateSegments.length; templateIndex++, pathIndex++) {
    const expected = templateSegments[templateIndex]!;
    const actual = pathSegments[pathIndex];
    if (expected.startsWith("{") && expected.endsWith("...}")) {
      const suffixLength = templateSegments.length - templateIndex - 1;
      const captureEnd = pathSegments.length - suffixLength;
      if (actual === undefined || actual === "" || captureEnd <= pathIndex) return undefined;
      params[expected.slice(1, -4)] = pathSegments.slice(pathIndex, captureEnd).join("/");
      pathIndex = captureEnd - 1;
      continue;
    }
    if (actual === undefined) return undefined;
    if (expected.startsWith("{") && expected.endsWith("}")) {
      if (actual === "") return undefined;
      params[expected.slice(1, -1)] = actual;
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return pathIndex === pathSegments.length ? params : undefined;
}

function resourceFromMatch(
  resource: WireResource,
  params: TemplateParams,
  searchParams: URLSearchParams,
): ResolvedWireResource {
  switch (resource) {
    case "capabilities":
      return { kind: "capabilities" };
    case "docs":
      return { kind: "docs" };
    case "docs-read-many":
      return { kind: "docs-read-many" };
    case "doc": {
      const id = decodeId(params.id!);
      assertValidDocId(id);
      return { kind: "doc", id };
    }
    case "doc-versions": {
      const id = decodeId(params.id!);
      assertValidDocId(id);
      return { kind: "doc-versions", id };
    }
    case "reserved": {
      const name = params.name!;
      if (name !== "index.md" && name !== "log.md") {
        throw new InvalidInputError(`reserved file name must be index.md or log.md, got '${name}'`);
      }
      const dir = searchParams.get("dir") ?? "";
      assertSafeReservedDir(dir);
      return { kind: "reserved", dir, name };
    }
    case "blobs":
      return { kind: "blobs" };
    case "blob": {
      const key = decodeBlobKey(params.key!);
      assertSafeBlobKey(key);
      return { kind: "blob", key };
    }
  }
}

function invalidBundleFromPath(pathname: string): WireRequestResolutionError | undefined {
  const prefix = "/v0/bundles/";
  if (!pathname.startsWith(prefix)) return undefined;
  const rawBundle = pathname.slice(prefix.length).split("/", 1)[0] ?? "";
  if (!isCanonicalBundleId(rawBundle)) {
    return new WireRequestResolutionError(400, "USAGE", `invalid bundle id '${rawBundle}'`);
  }
  return undefined;
}

function resolvePathAndMethod(pathname: string, searchParams: URLSearchParams, method: string): ResolvedWireRoute {
  const bundleError = invalidBundleFromPath(pathname);
  if (bundleError) throw bundleError;

  const shapeMatches = WIRE_ENDPOINTS.flatMap((endpoint) => {
    const params = matchTemplate(endpoint.path, pathname);
    return params ? [{ endpoint, params }] : [];
  });
  if (shapeMatches.length === 0) {
    throw new WireRequestResolutionError(404, "NOT_FOUND", `no route for ${pathname}`);
  }

  const methodMatches = shapeMatches
    .filter(({ endpoint }) => endpoint.method === method)
    .sort((a, b) => literalSpecificity(b.endpoint.path) - literalSpecificity(a.endpoint.path));
  const selected = methodMatches[0];
  if (!selected) {
    throw new WireRequestResolutionError(
      400,
      "USAGE",
      `unsupported method ${method} for ${routeLabel(shapeMatches[0]!.endpoint.resource)}`,
    );
  }

  try {
    const resource = resourceFromMatch(selected.endpoint.resource, selected.params, searchParams);
    if (selected.endpoint.id === "capabilities") {
      return {
        scope: "deployment",
        endpointId: "capabilities",
        accessClass: "public",
        resource: { kind: "capabilities" },
        searchParams,
      };
    }
    const bundleId = selected.params.bundle!;
    if (!isCanonicalBundleId(bundleId)) {
      throw new WireRequestResolutionError(400, "USAGE", `invalid bundle id '${bundleId}'`);
    }
    return {
      scope: "bundle",
      bundleId,
      endpointId: selected.endpoint.id,
      accessClass: selected.endpoint.accessClass,
      resource,
      searchParams,
    } as ResolvedBundleWireRoute;
  } catch (error) {
    if (error instanceof WireRequestResolutionError) throw error;
    if (error instanceof InvalidInputError) {
      throw new WireRequestResolutionError(400, "USAGE", error.message);
    }
    throw error;
  }
}

/** Resolve route identity, canonical bundle selection, decoded resource, and access once. */
export function resolveWireRequest(request: Request): ResolvedWireRoute {
  const { url: requestUrl, method } = request;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new WireRequestResolutionError(400, "USAGE", "invalid request URL");
  }
  const { pathname, searchParams } = url;
  return resolvePathAndMethod(pathname, searchParams, method);
}

interface RegisteredWireRequest {
  resolved: ResolvedWireRoute;
}

function routeLabel(resource: WireResource): string {
  let label: string;
  switch (resource) {
    case "docs":
      label = "/docs";
      break;
    case "docs-read-many":
      label = "/docs:read-many";
      break;
    case "doc":
    case "doc-versions":
      label = "a doc route";
      break;
    case "reserved":
      label = "a reserved-file route";
      break;
    case "blobs":
      label = "/blobs";
      break;
    case "blob":
      label = "a blob route";
      break;
    case "capabilities":
      label = "/v0/capabilities";
      break;
  }
  return label;
}

/** Fetch requires every HEAD response to be bodyless, including host- and runtime-generated errors. */
function responseForMethod(isHead: boolean, response: Response): Response {
  if (!isHead) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The sole raw URL/method boundary. Inner dispatch receives only a registered endpoint, its
 * decoded-shape input, and query parameters; ordinary handler additions cannot make an undeclared
 * method/path pair reachable by branching around the registry.
 */
function registeredWireRouter(
  dispatch: (req: Request, registered: RegisteredWireRequest) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const isHead = req.method === "HEAD";
    let response: Response;
    let url!: URL;

    try {
      try {
        url = new URL(req.url);
      } catch {
        throw new WireRequestResolutionError(400, "USAGE", "invalid request URL");
      }
      const resolved = resolvePathAndMethod(url.pathname, url.searchParams, req.method);
      response = await dispatch(req, { resolved });
    } catch (err) {
      if (err instanceof WireRequestResolutionError) {
        const message = err.status === 404 ? `no route for ${url.pathname}` : err.message;
        response = errorResponse(err.status, err.code, message);
      } else {
        response = errorFromCaught(err);
      }
    }
    return responseForMethod(isHead, response);
  };
}

/**
 * Build the fetch-style router for Worker runtimes. Bundle routes resolve context exactly once
 * after canonical route resolution; deployment capabilities bypass context and storage entirely.
 */
export function createRouter(options: RouterOptions): (req: Request) => Promise<Response> {
  return buildRouter(options);
}

function buildRouter(options: RouterOptions): (req: Request) => Promise<Response> {
  async function handleReadDoc(backend: StorageBackend, id: ConceptId): Promise<Response> {
    assertValidDocId(id);
    try {
      const { doc, version } = await backend.read(id);
      return jsonResponse(200, { id: doc.id, frontmatter: doc.frontmatter, body: doc.body }, versionHeaders(version));
    } catch (err) {
      if (isEnoent(err)) return errorResponse(404, "NOT_FOUND", `no concept document '${id}'`);
      throw err;
    }
  }

  async function handleHeadDoc(backend: StorageBackend, id: ConceptId): Promise<Response> {
    // HEAD responses carry no body regardless of status (including a validation
    // rejection) — caught locally rather than falling through to the JSON-enveloped
    // catch-all.
    try {
      assertValidDocId(id);
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      const { version } = await backend.read(id);
      return new Response(null, { status: 200, headers: versionHeaders(version) });
    } catch (err) {
      if (isEnoent(err)) return new Response(null, { status: 404 });
      throw err;
    }
  }

  async function handleWriteDoc(
    backend: StorageBackend,
    attribution: TrustedAttribution,
    id: ConceptId,
    req: Request,
  ): Promise<Response> {
    let payload: { frontmatter?: Frontmatter; body?: string };
    try {
      payload = (await req.json()) as { frontmatter?: Frontmatter; body?: string };
    } catch {
      return errorResponse(400, "USAGE", "request body must be JSON { frontmatter, body }");
    }
    if (payload === null || typeof payload !== "object" || payload.frontmatter === undefined) {
      return errorResponse(400, "USAGE", "request body must include a frontmatter object");
    }
    if (payload.body !== undefined && typeof payload.body !== "string") {
      return errorResponse(400, "USAGE", "request body field body must be a string when present");
    }
    const writeOptions = writeOptionsFromRequest(req, attribution);
    const result = await writeDocVersioned(
      backend,
      { id, frontmatter: payload.frontmatter, body: payload.body ?? "" },
      writeOptions,
    );
    const status = writeOptions.expectedVersion === null ? 201 : 200;
    return jsonResponse(status, { version: result.version }, versionHeaders(result.version));
  }

  /**
   * `DELETE /docs/{id}`. Same validate-id-before-backend posture as `handleReadDoc`
   * (`assertValidDocId` — traversal and reserved-filename ids reject `400 USAGE`, backend
   * never called). `backend.delete` already returns `false` for an absent target rather
   * than throwing, so there is no `try/catch` shaping needed here beyond the shared
   * catch-all (`VersionConflict` -> `412` via `errorFromCaught`, same as a write). `200
   * { deleted }` unconditionally — never a `404`, matching the wire's absence-is-success
   * contract (AXI P6).
   */
  async function handleDeleteDoc(backend: StorageBackend, id: ConceptId, req: Request): Promise<Response> {
    assertValidDocId(id);
    const options = deleteOptionsFromHeaders(req);
    const deleted = await backend.delete(id, options);
    return jsonResponse(200, { deleted });
  }

  async function handleVersions(backend: StorageBackend, id: ConceptId): Promise<Response> {
    assertValidDocId(id);
    const history = await backend.versions(id);
    return jsonResponse(200, { versions: history });
  }

  async function handleReadMany(backend: StorageBackend, req: Request): Promise<Response> {
    let payload: { ids?: unknown };
    try {
      payload = (await req.json()) as { ids?: unknown };
    } catch {
      return errorResponse(400, "USAGE", "request body must be JSON { ids: string[] }");
    }
    if (!payload || !Array.isArray(payload.ids) || !payload.ids.every((x) => typeof x === "string")) {
      return errorResponse(400, "USAGE", "request body must include an ids: string[] array");
    }
    const ids = payload.ids as ConceptId[];
    if (ids.length === 0) return jsonResponse(200, { results: [] });

    // Validate EVERY id before touching the backend at all — a single bad id (e.g. a
    // traversal payload) rejects the whole batch rather than silently reading the rest.
    for (const id of ids) {
      try {
        assertValidDocId(id);
      } catch (err) {
        return errorResponse(400, "USAGE", err instanceof Error ? err.message : `invalid id '${id}'`, { id });
      }
    }

    // Determine the missing set up front (§ readMany: "404 + { missing }" if ANY id is
    // absent) rather than relying on the batch read to fail generically mid-way.
    const existsFlags = await Promise.all(ids.map((id) => backend.exists(id)));
    const missing = ids.filter((_, i) => !existsFlags[i]);
    if (missing.length > 0) {
      return errorResponse(404, "NOT_FOUND", `${missing.length} id(s) not found`, { missing });
    }
    const results = await backend.readMany(ids);
    return jsonResponse(200, {
      results: results.map((r) => ({ id: r.doc.id, frontmatter: r.doc.frontmatter, body: r.doc.body, version: r.version })),
    });
  }

  async function handleList(backend: StorageBackend, searchParams: URLSearchParams): Promise<Response> {
    const prefix = searchParams.get("prefix") ?? undefined;
    const type = searchParams.get("type") ?? undefined;
    const tags = searchParams.getAll("tag");
    const fields = searchParams.get("fields");
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIST_LIMIT;
    const cursor = searchParams.get("cursor") ?? undefined;

    // HEAD-FIRST scan (this route only ever projects frontmatter — bodies never leave it),
    // via core's ONE `queryHeads` implementation: it prefers the backend's optional
    // push-down (a hosted adapter can answer from its head index without reading bodies),
    // re-applies the canonical `matchesFilter` to whatever came back, and falls back to
    // the delete-tolerant `list` + batch-read walk for every other backend (a doc deleted
    // mid-scan is SKIPPED, not a scan-failing 404 — the server half of STATUS item 33; a
    // MALFORMED doc still fails loudly, since quarantining it over the wire needs a
    // `skipped` response shape — recorded as an open question). The router deliberately
    // does NOT re-implement the prefer-else-fallback dance itself.
    const heads = await queryHeads(backend, { prefix, type, tags });

    const count = heads.length;
    let page = heads;
    if (cursor) {
      const idx = page.findIndex((r) => r.id === cursor);
      // Vanished-cursor fallback: MUST use the SAME comparator the sort above used
      // (`localeCompare`) — a code-unit `>` here diverges from locale order for ids like
      // `B` vs `a`, re-emitting or skipping rows when the cursor doc was deleted or
      // edited out of the filter between pages.
      page = idx >= 0 ? page.slice(idx + 1) : page.filter((r) => r.id.localeCompare(cursor) > 0);
    }
    const limited = page.slice(0, limit);
    const nextCursor = page.length > limit ? (limited[limited.length - 1]?.id ?? null) : null;

    const docs = limited.map(({ id, frontmatter, version }) =>
      fields === "frontmatter"
        ? { id, version, frontmatter }
        : {
            id,
            version,
            type: frontmatter.type,
            title: frontmatter.title,
            timestamp: frontmatter.timestamp,
          },
    );
    return jsonResponse(200, { count, docs, next_cursor: nextCursor });
  }

  async function handleReadReserved(
    backend: StorageBackend,
    dir: string,
    name: ReservedFilename,
  ): Promise<Response> {
    assertSafeReservedDir(dir);
    const result = await backend.readReserved(dir, name);
    if (result === null) return errorResponse(404, "NOT_FOUND", `no reserved file '${name}' at dir '${dir}'`);
    return jsonResponse(200, { content: result.content }, versionHeaders(result.version));
  }

  async function handleWriteReserved(
    backend: StorageBackend,
    attribution: TrustedAttribution,
    dir: string,
    name: ReservedFilename,
    req: Request,
  ): Promise<Response> {
    assertSafeReservedDir(dir);
    let payload: { content?: unknown };
    try {
      payload = (await req.json()) as { content?: unknown };
    } catch {
      return errorResponse(400, "USAGE", "request body must be JSON { content }");
    }
    if (typeof payload.content !== "string") {
      return errorResponse(400, "USAGE", "request body must include a content: string field");
    }
    const writeOptions = writeOptionsFromRequest(req, attribution);
    const version = await backend.writeReserved(dir, name, payload.content, writeOptions);
    const status = writeOptions.expectedVersion === null ? 201 : 200;
    return jsonResponse(status, { version }, versionHeaders(version));
  }

  // ── blobs: opaque bytes served by content-type (wire-protocol v0.1) ─────────
  //
  // Same `StorageBackend`-direct posture as reads/list/reserved-file access
  // (principle 2 — "the seam is the schema"): `readBlob`/`writeBlob`/`existsBlob`/
  // `listBlobs` map 1:1 to their routes. `assertSafeBlobKey` (Part A) is the ONE
  // guard — it already rejects a `.md`-ending key (case-insensitively, covering the
  // two reserved filenames), traversal/absolute escape, and dot-prefixed segments —
  // applied identically on EVERY blob route including GET/HEAD (I1: a probing read
  // must not bypass the guard writes enforce). Bytes cross the wire as the RAW
  // request/response body (`req.arrayBuffer()` / a `Uint8Array` `Response` body),
  // never JSON — B1: no `Buffer` anywhere in this module, so it stays edge-runtime compatible.

  async function handleReadBlob(backend: StorageBackend, key: BlobKey): Promise<Response> {
    assertSafeBlobKey(key);
    const result = await backend.readBlob(key);
    if (result === null) return errorResponse(404, "NOT_FOUND", `no blob '${key}'`);
    return new Response(result.bytes, {
      status: 200,
      headers: { "content-type": result.contentType, ...versionHeaders(result.version) },
    });
  }

  async function handleHeadBlob(backend: StorageBackend, key: BlobKey): Promise<Response> {
    // Bodiless on EVERY status, including a validation rejection — mirrors handleHeadDoc.
    try {
      assertSafeBlobKey(key);
    } catch {
      return new Response(null, { status: 400 });
    }
    const result = await backend.readBlob(key);
    if (result === null) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: { "content-type": result.contentType, ...versionHeaders(result.version) },
    });
  }

  async function handleWriteBlob(
    backend: StorageBackend,
    attribution: TrustedAttribution,
    key: BlobKey,
    req: Request,
  ): Promise<Response> {
    assertSafeBlobKey(key);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const contentTypeHeader = req.headers.get("content-type");
    const contentType = contentTypeHeader && contentTypeHeader.trim() !== "" ? contentTypeHeader : undefined;
    const writeOptions = writeOptionsFromRequest(req, attribution);
    const version = await backend.writeBlob(key, bytes, contentType, writeOptions);
    const status = writeOptions.expectedVersion === null ? 201 : 200;
    return jsonResponse(status, { version }, versionHeaders(version));
  }

  /** `DELETE /blobs/{key}`, mirroring `handleDeleteDoc` exactly (`assertSafeBlobKey` rejects `.md`/traversal keys before the backend is ever called). */
  async function handleDeleteBlob(backend: StorageBackend, key: BlobKey, req: Request): Promise<Response> {
    assertSafeBlobKey(key);
    const options = deleteOptionsFromHeaders(req);
    const deleted = await backend.deleteBlob(key, options);
    return jsonResponse(200, { deleted });
  }

  async function handleListBlobs(backend: StorageBackend, searchParams: URLSearchParams): Promise<Response> {
    // Mirrors handleList's prefix/limit/cursor pagination shape (B2) — no type/tag
    // filters (blobs carry no frontmatter to filter on), and rows are bare keys.
    const prefix = searchParams.get("prefix") ?? undefined;
    const limitParam = searchParams.get("limit");
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIST_LIMIT;
    const cursor = searchParams.get("cursor") ?? undefined;

    const keys = await backend.listBlobs(prefix); // already sorted (localeCompare, backend contract)
    const count = keys.length;
    let page = keys;
    if (cursor) {
      const idx = page.findIndex((k) => k === cursor);
      // Same vanished-cursor comparator rule as handleList: the backends sort blob keys
      // with `localeCompare`, so the fallback must compare the same way.
      page = idx >= 0 ? page.slice(idx + 1) : page.filter((k) => k.localeCompare(cursor) > 0);
    }
    const limited = page.slice(0, limit);
    const nextCursor = page.length > limit ? (limited[limited.length - 1] ?? null) : null;

    return jsonResponse(200, { count, keys: limited, next_cursor: nextCursor });
  }

  function handleCapabilities(): Response {
    const caps = options.capabilities;
    return jsonResponse(200, {
      history: caps.history ?? caps.enforced_cas,
      enforced_cas: caps.enforced_cas,
      projections: caps.projections ?? true,
      backlinks: caps.backlinks ?? false,
      blobs: caps.blobs,
    });
  }

  return registeredWireRouter(async (req, { resolved }) => {
    if (resolved.scope === "deployment") return handleCapabilities();

    const context = await options.resolveContext(req, resolved);
    if (context instanceof Response) return context;
    const { backend, attribution } = context;
    switch (resolved.endpointId) {
      case "capabilities":
        throw new Error("deployment route reached bundle dispatch");
      case "docs-list":
        return await handleList(backend, resolved.searchParams);
      case "docs-read-many":
        return await handleReadMany(backend, req);
      case "doc-versions":
        return await handleVersions(backend, (resolved.resource as { kind: "doc-versions"; id: ConceptId }).id);
      case "doc-read":
        return await handleReadDoc(backend, (resolved.resource as { kind: "doc"; id: ConceptId }).id);
      case "doc-write":
        return await handleWriteDoc(
          backend,
          attribution,
          (resolved.resource as { kind: "doc"; id: ConceptId }).id,
          req,
        );
      case "doc-head":
        return await handleHeadDoc(backend, (resolved.resource as { kind: "doc"; id: ConceptId }).id);
      case "doc-delete":
        return await handleDeleteDoc(backend, (resolved.resource as { kind: "doc"; id: ConceptId }).id, req);
      case "reserved-read": {
        const resource = resolved.resource as { kind: "reserved"; dir: string; name: ReservedFilename };
        return await handleReadReserved(backend, resource.dir, resource.name);
      }
      case "reserved-write": {
        const resource = resolved.resource as { kind: "reserved"; dir: string; name: ReservedFilename };
        return await handleWriteReserved(backend, attribution, resource.dir, resource.name, req);
      }
      case "blobs-list":
        return await handleListBlobs(backend, resolved.searchParams);
      case "blob-read":
        return await handleReadBlob(backend, (resolved.resource as { kind: "blob"; key: BlobKey }).key);
      case "blob-write":
        return await handleWriteBlob(
          backend,
          attribution,
          (resolved.resource as { kind: "blob"; key: BlobKey }).key,
          req,
        );
      case "blob-head":
        return await handleHeadBlob(backend, (resolved.resource as { kind: "blob"; key: BlobKey }).key);
      case "blob-delete":
        return await handleDeleteBlob(backend, (resolved.resource as { kind: "blob"; key: BlobKey }).key, req);
    }
  });
}
