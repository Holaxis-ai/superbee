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
  FilesystemBackend,
  InvalidInputError,
  MemoryBackend,
  VersionConflict,
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  isReservedFile,
  queryHeads,
  pathFromConceptId,
  stripETagWrapper,
  writeDocVersioned,
  type BlobKey,
  type Bundle,
  type ConceptId,
  type DeleteOptions,
  type Frontmatter,
  type ReservedFilename,
  type StorageBackend,
  type Version,
  type WriteOptions,
} from "@superbee/core";

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
function writeOptionsFromHeaders(req: Request): WriteOptions {
  const options: WriteOptions = {};
  if (req.headers.get("If-None-Match") === "*") {
    options.expectedVersion = null;
  } else {
    const ifMatch = req.headers.get("If-Match");
    if (ifMatch !== null) options.expectedVersion = stripETagWrapper(ifMatch);
  }
  const actor = req.headers.get("X-Actor");
  if (actor) options.actor = actor;
  // `X-Agent` is manufactured ONLY by the auth'd worker's `withActor` (never sent by the CLI
  // directly, never forgeable by a client past that gate) — absent here on `serve` (no auth,
  // no `withActor`), so `options.agent` stays undefined there, correctly.
  const agent = req.headers.get("X-Agent");
  if (agent) options.agent = agent;
  return options;
}

/**
 * Read `If-Match` off a request into the seam's `DeleteOptions.expectedVersion` — the delete
 * counterpart to {@link writeOptionsFromHeaders}, deliberately narrower: no `If-None-Match: *`
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

const BUNDLE_PATH_RE = /^\/v0\/bundles\/([^/]+)\/(.*)$/;

/**
 * The complete public route/method registry for the reference router. Runtime dispatch consumes
 * this table, and the repository contract test compares the same rows with WIRE-PROTOCOL.md, so a
 * route cannot become reachable without entering the documented agreement surface.
 */
export const WIRE_ENDPOINTS = [
  { id: "capabilities", resource: "capabilities", method: "GET", path: "/v0/capabilities" },
  { id: "docs-list", resource: "docs", method: "GET", path: "/v0/bundles/{bundle}/docs" },
  {
    id: "docs-read-many",
    resource: "docs-read-many",
    method: "POST",
    path: "/v0/bundles/{bundle}/docs:read-many",
  },
  { id: "doc-read", resource: "doc", method: "GET", path: "/v0/bundles/{bundle}/docs/{id...}" },
  { id: "doc-write", resource: "doc", method: "PUT", path: "/v0/bundles/{bundle}/docs/{id...}" },
  { id: "doc-head", resource: "doc", method: "HEAD", path: "/v0/bundles/{bundle}/docs/{id...}" },
  { id: "doc-delete", resource: "doc", method: "DELETE", path: "/v0/bundles/{bundle}/docs/{id...}" },
  {
    id: "doc-versions",
    resource: "doc-versions",
    method: "GET",
    path: "/v0/bundles/{bundle}/docs/{id...}/versions",
  },
  {
    id: "reserved-read",
    resource: "reserved",
    method: "GET",
    path: "/v0/bundles/{bundle}/reserved/{name}",
  },
  {
    id: "reserved-write",
    resource: "reserved",
    method: "PUT",
    path: "/v0/bundles/{bundle}/reserved/{name}",
  },
  { id: "blobs-list", resource: "blobs", method: "GET", path: "/v0/bundles/{bundle}/blobs" },
  { id: "blob-read", resource: "blob", method: "GET", path: "/v0/bundles/{bundle}/blobs/{key...}" },
  { id: "blob-write", resource: "blob", method: "PUT", path: "/v0/bundles/{bundle}/blobs/{key...}" },
  { id: "blob-head", resource: "blob", method: "HEAD", path: "/v0/bundles/{bundle}/blobs/{key...}" },
  {
    id: "blob-delete",
    resource: "blob",
    method: "DELETE",
    path: "/v0/bundles/{bundle}/blobs/{key...}",
  },
] as const;

type WireResource = (typeof WIRE_ENDPOINTS)[number]["resource"];
type WireEndpoint = (typeof WIRE_ENDPOINTS)[number];

interface ResourceMatch {
  resource: WireResource;
  value?: string;
}

interface RegisteredWireRequest {
  endpoint: WireEndpoint;
  match: ResourceMatch;
  searchParams: URLSearchParams;
}

/** Resolve pathname shapes independently from methods; the registry above owns allowed pairs. */
function matchWireResources(pathname: string): ResourceMatch[] {
  if (pathname === "/v0/capabilities") return [{ resource: "capabilities" }];

  const match = BUNDLE_PATH_RE.exec(pathname);
  if (!match) return [];
  const rest = match[2] ?? "";

  if (rest === "docs") return [{ resource: "docs" }];
  if (rest === "docs:read-many") return [{ resource: "docs-read-many" }];
  if (rest.startsWith("docs/")) {
    const tail = rest.slice("docs/".length);
    // GET gives the history sub-resource priority. Other declared member methods retain the
    // documented ambiguity for a doc id whose own final segment is literally "versions".
    return tail.endsWith("/versions")
      ? [
          { resource: "doc-versions", value: tail.slice(0, -"/versions".length) },
          { resource: "doc", value: tail },
        ]
      : [{ resource: "doc", value: tail }];
  }
  if (rest.startsWith("reserved/")) {
    return [{ resource: "reserved", value: rest.slice("reserved/".length) }];
  }
  if (rest === "blobs") return [{ resource: "blobs" }];
  if (rest.startsWith("blobs/")) return [{ resource: "blob", value: rest.slice("blobs/".length) }];
  return [];
}

function resolveWireEndpoint(
  resources: readonly ResourceMatch[],
  method: string,
): { endpoint: WireEndpoint; match: ResourceMatch } | undefined {
  for (const match of resources) {
    const endpoint = WIRE_ENDPOINTS.find((row) => row.resource === match.resource && row.method === method);
    if (endpoint) return { endpoint, match };
  }
  return undefined;
}

function unsupportedMethodResponse(method: string, match: ResourceMatch): Response {
  let label: string;
  switch (match.resource) {
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
  return errorResponse(400, "USAGE", `unsupported method ${method} for ${label}`);
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
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return errorResponse(400, "USAGE", "invalid request URL");
    }

    const resources = matchWireResources(url.pathname);
    if (resources.length === 0) return errorResponse(404, "NOT_FOUND", `no route for ${url.pathname}`);
    const resolved = resolveWireEndpoint(resources, req.method);
    if (!resolved) return unsupportedMethodResponse(req.method, resources[0]!);

    try {
      return await dispatch(req, { ...resolved, searchParams: url.searchParams });
    } catch (err) {
      return errorFromCaught(err);
    }
  };
}

/**
 * Build the fetch-style router directly over an explicit `backend` — no `Bundle`-shape
 * fallback to `new FilesystemBackend(...)`. This is the edge-runtime entry point: {@link
 * createRouter} falls back to constructing a `FilesystemBackend` when `bundle.backend` is
 * absent (needed by the reference server's local `--dir` support, `serve.ts`), and that
 * fallback imports `node:fs`. A non-Node host supplies its backend explicitly and calls this
 * function so a tree-shaking bundler can omit the filesystem path.
 */
export function createRouterForBackend(backend: StorageBackend): (req: Request) => Promise<Response> {
  return buildRouter(backend);
}

/**
 * Build the fetch-style router for `bundle`. The router is single-bundle (it closes
 * over the one `Bundle` it was constructed with); the `{bundle}` path segment is
 * accepted syntactically (any value) but not used to select among multiple bundles —
 * see `docs/WIRE-PROTOCOL.md` deviations for the multi-bundle open question.
 */
export function createRouter(bundle: Bundle): (req: Request) => Promise<Response> {
  return buildRouter(bundle.backend ?? new FilesystemBackend(bundle.root));
}

function buildRouter(backend: StorageBackend): (req: Request) => Promise<Response> {
  // `writeDocVersioned` (the engine API `handleWriteDoc` routes doc writes through, so
  // server-side OKF enforcement is free) takes a `Bundle`, not a bare `StorageBackend` — this
  // synthesizes the minimal `Bundle` shape it needs. `root` is never read when `backend` is
  // set (core's `backendFor` only falls back to `new FilesystemBackend(bundle.root)` when
  // `bundle.backend` is absent), so an empty string is a safe, inert placeholder here.
  const bundle: Bundle = { root: "", backend };

  async function handleReadDoc(id: ConceptId): Promise<Response> {
    assertValidDocId(id);
    try {
      const { doc, version } = await backend.read(id);
      return jsonResponse(200, { id: doc.id, frontmatter: doc.frontmatter, body: doc.body }, versionHeaders(version));
    } catch (err) {
      if (isEnoent(err)) return errorResponse(404, "NOT_FOUND", `no concept document '${id}'`);
      throw err;
    }
  }

  async function handleHeadDoc(id: ConceptId): Promise<Response> {
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

  async function handleWriteDoc(id: ConceptId, req: Request): Promise<Response> {
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
    const options = writeOptionsFromHeaders(req);
    const result = await writeDocVersioned(
      bundle,
      { id, frontmatter: payload.frontmatter, body: payload.body ?? "" },
      options,
    );
    const status = options.expectedVersion === null ? 201 : 200;
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
  async function handleDeleteDoc(id: ConceptId, req: Request): Promise<Response> {
    assertValidDocId(id);
    const options = deleteOptionsFromHeaders(req);
    const deleted = await backend.delete(id, options);
    return jsonResponse(200, { deleted });
  }

  async function handleVersions(id: ConceptId): Promise<Response> {
    assertValidDocId(id);
    const history = await backend.versions(id);
    return jsonResponse(200, { versions: history });
  }

  async function handleReadMany(req: Request): Promise<Response> {
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

  async function handleList(searchParams: URLSearchParams): Promise<Response> {
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
    // `skipped` response shape — recorded as an open question). The synthetic `bundle`
    // above is the same one `writeDocVersioned` already routes through — the router
    // deliberately does NOT re-implement the prefer-else-fallback dance itself.
    const heads = await queryHeads(bundle, { prefix, type, tags });

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

  async function handleReadReserved(dir: string, name: ReservedFilename): Promise<Response> {
    assertSafeReservedDir(dir);
    const result = await backend.readReserved(dir, name);
    if (result === null) return errorResponse(404, "NOT_FOUND", `no reserved file '${name}' at dir '${dir}'`);
    return jsonResponse(200, { content: result.content }, versionHeaders(result.version));
  }

  async function handleWriteReserved(dir: string, name: ReservedFilename, req: Request): Promise<Response> {
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
    const options = writeOptionsFromHeaders(req);
    const version = await backend.writeReserved(dir, name, payload.content, options);
    const status = options.expectedVersion === null ? 201 : 200;
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

  async function handleReadBlob(key: BlobKey): Promise<Response> {
    assertSafeBlobKey(key);
    const result = await backend.readBlob(key);
    if (result === null) return errorResponse(404, "NOT_FOUND", `no blob '${key}'`);
    return new Response(result.bytes, {
      status: 200,
      headers: { "content-type": result.contentType, ...versionHeaders(result.version) },
    });
  }

  async function handleHeadBlob(key: BlobKey): Promise<Response> {
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

  async function handleWriteBlob(key: BlobKey, req: Request): Promise<Response> {
    assertSafeBlobKey(key);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const contentTypeHeader = req.headers.get("content-type");
    const contentType = contentTypeHeader && contentTypeHeader.trim() !== "" ? contentTypeHeader : undefined;
    const options = writeOptionsFromHeaders(req);
    const version = await backend.writeBlob(key, bytes, contentType, options);
    const status = options.expectedVersion === null ? 201 : 200;
    return jsonResponse(status, { version }, versionHeaders(version));
  }

  /** `DELETE /blobs/{key}`, mirroring `handleDeleteDoc` exactly (`assertSafeBlobKey` rejects `.md`/traversal keys before the backend is ever called). */
  async function handleDeleteBlob(key: BlobKey, req: Request): Promise<Response> {
    assertSafeBlobKey(key);
    const options = deleteOptionsFromHeaders(req);
    const deleted = await backend.deleteBlob(key, options);
    return jsonResponse(200, { deleted });
  }

  async function handleListBlobs(searchParams: URLSearchParams): Promise<Response> {
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
    // Prefer a backend's own declaration; the fallback preserves compatibility for adapters
    // written before capabilities() existed. History and CAS are independent: the filesystem
    // now enforces CAS across processes but intentionally retains only its current revision.
    const declared = backend.capabilities?.();
    const caps = declared ?? {
      enforced_cas: backend instanceof MemoryBackend,
      blobs: true, // v0.1 — PUT/GET/HEAD /blobs/{key} + GET /blobs (list)
      projections: true,
      backlinks: false, // deferred to v1 (docs/WIRE-PROTOCOL.md)
    };
    return jsonResponse(200, {
      history: caps.history ?? caps.enforced_cas,
      enforced_cas: caps.enforced_cas,
      projections: caps.projections ?? true,
      backlinks: caps.backlinks ?? false,
      blobs: caps.blobs,
    });
  }

  return registeredWireRouter(async (req, { endpoint, match, searchParams }) => {
    switch (endpoint.id) {
      case "capabilities":
        return handleCapabilities();
      case "docs-list":
        return await handleList(searchParams);
      case "docs-read-many":
        return await handleReadMany(req);
      case "doc-versions":
        return await handleVersions(decodeId(match.value!));
      case "doc-read":
        return await handleReadDoc(decodeId(match.value!));
      case "doc-write":
        return await handleWriteDoc(decodeId(match.value!), req);
      case "doc-head":
        return await handleHeadDoc(decodeId(match.value!));
      case "doc-delete":
        return await handleDeleteDoc(decodeId(match.value!), req);
      case "reserved-read":
      case "reserved-write": {
        const name = match.value!;
        if (name !== "index.md" && name !== "log.md") {
          return errorResponse(400, "USAGE", `reserved file name must be index.md or log.md, got '${name}'`);
        }
        const dir = searchParams.get("dir") ?? "";
        return endpoint.id === "reserved-read"
          ? await handleReadReserved(dir, name)
          : await handleWriteReserved(dir, name, req);
      }
      case "blobs-list":
        return await handleListBlobs(searchParams);
      case "blob-read":
        return await handleReadBlob(decodeBlobKey(match.value!));
      case "blob-write":
        return await handleWriteBlob(decodeBlobKey(match.value!), req);
      case "blob-head":
        return await handleHeadBlob(decodeBlobKey(match.value!));
      case "blob-delete":
        return await handleDeleteBlob(decodeBlobKey(match.value!), req);
    }
  });
}
