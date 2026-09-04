/**
 * `RemoteBackend` — a {@link StorageBackend} implemented over the wire-protocol v0
 * reference contract (`docs/WIRE-PROTOCOL.md`, `@superbee/server`).
 *
 * This is the client half of the seam over HTTP: every method maps directly to a wire endpoint,
 * and response versions remain the same content-addressed {@link Version} tokens local backends
 * produce. Tri-backend contract tests pin that invariant.
 *
 * Zero new dependencies: it calls an injectable {@link FetchLike} transport
 * (defaulting to the global `fetch`, available on Node >= 20) with a constructed
 * `Request`. That means the SAME adapter runs against a real HTTP server, or — in
 * tests — directly against an in-process `createRouter(bundle)` function with no
 * sockets: `createRouter` returns exactly the `(req: Request) => Promise<Response>`
 * shape {@link FetchLike} expects, so the router can be injected AS the transport.
 *
 * {@link extractVersion} reads `X-Version` first and a normalized `ETag` second. A missing
 * version is always `VERSION_MISSING`, never `""`: feeding an empty version into a later write
 * would weaken compare-and-swap into an unconditional write. The server emits both headers;
 * `X-Version` is primary because intermediaries may rewrite or strip ETags.
 *
 * Error mapping (so engine callers behave identically regardless of backend):
 *   - HTTP `404`                               -> an ENOENT-shaped rejection
 *     (`err.code === "ENOENT"`), matching {@link FilesystemBackend} / {@link MemoryBackend}.
 *     (Blob reads are the one exception: {@link StorageBackend.readBlob} returns `null`
 *     on a `404`, matching the LOCAL adapters' own "absence is a normal result, not a
 *     rejection" posture for blobs — see the blob section below.)
 *   - HTTP `412` (`If-Match`/`If-None-Match` failed) -> a reconstructed
 *     {@link VersionConflict} from the error envelope's `details: { expected, actual }`.
 *   - any other non-2xx                        -> a {@link RemoteError} carrying the envelope's
 *     `message` AND its `code` (falling back to a
 *     status-derived guess — `AUTH_REQUIRED` for 401, `RUNTIME` for 5xx, else `USAGE` — when
 *     the response carries no parseable envelope) plus the raw HTTP `status`, so callers can
 *     branch on `.code` instead of guessing from exception shape.
 *
 * An optional {@link RemoteBackendOptions.authToken} rides as
 * `Authorization: Bearer <token>` on EVERY request. The reference `serve()` ignores it (no
 * auth enforced there), so omitting it is harmless against a local/reference server; a separate
 * gated deployment may require it.
 *
 * This module touches NO filesystem and parses NO markdown — like {@link MemoryBackend},
 * it proves the engine leaks no assumptions beyond the {@link StorageBackend} contract.
 */

import { DEFAULT_BLOB_CONTENT_TYPE } from "./content-type.js";
import { InvalidInputError } from "./errors.js";
import { assertSafeBlobKey, assertSafeConceptId } from "./paths.js";
import { VersionConflict, stripETagWrapper } from "./version-transport.js";
import type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  Frontmatter,
  HeadResult,
  OkfDocument,
  QueryFilter,
  ReadBlobResult,
  ReadResult,
  ReservedFilename,
  ReservedReadResult,
  StorageBackend,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

/** The wire-protocol JSON error envelope (`docs/WIRE-PROTOCOL.md` Conventions). */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: { expected?: Version | null; actual?: Version | null; missing?: string[] };
  };
}

/**
 * An injectable fetch-like transport: given a `Request`, resolve a `Response`. This
 * is exactly the shape {@link createRouter} (in `@superbee/server`) returns,
 * so a router can be injected directly as the transport — no sockets involved.
 */
export type FetchLike = (request: Request) => Promise<Response>;

/** Construction options for {@link RemoteBackend}. */
export interface RemoteBackendOptions {
  /** Base URL of the wire-protocol server, e.g. `http://127.0.0.1:4021`. A trailing slash is tolerated. */
  baseUrl: string;
  /** Bundle name segment in the `/v0/bundles/{bundle}/…` path. */
  bundle: string;
  /** Transport override; defaults to the global `fetch` (Node >= 20). Tests inject a router directly. */
  fetchImpl?: FetchLike;
  /**
   * Optional bearer token sent as `Authorization: Bearer <token>` on EVERY request. The
   * reference `serve()` (`@superbee/server`)
   * ignores this header entirely (no auth enforced there), so omitting it is harmless
   * against a local/reference server.
   */
  authToken?: string;
  /**
   * Max RETRIES (not total attempts) on a TRANSIENT failure — a transient 5xx (500/502/503/504,
   * e.g. a Cloudflare D1 cold-start's 500 "storage caused object to be reset" when a hibernated
   * database is first hit) or a network/transport error. Each retry backs off exponentially with
   * jitter. A 4xx (incl. 412 VersionConflict), 401, or any 2xx is a REAL result, never retried.
   * Default 3; set 0 to disable. Safe because every op is content-addressed + CAS: a retried write
   * lands the same version or a conflict — possibly SPURIOUS, if a prior attempt actually committed
   * before its response was lost — but never silent data loss; and a retried read is idempotent.
   */
  maxRetries?: number;
}

/**
 * A non-2xx wire response that is neither a `404` (ENOENT-shaped) nor a `412`
 * ({@link VersionConflict}) — the generic case, carrying the error envelope's `code` alongside
 * the raw HTTP `status`, so a caller can distinguish e.g.
 * `AUTH_REQUIRED` (401, an unauthenticated/misconfigured `--remote`) from `RUNTIME` (5xx, a
 * genuine server-side bug) instead of both collapsing into a generically-classified `Error`.
 */
export class RemoteError extends Error {
  /** The envelope's `code` field, or a status-derived guess when the envelope is missing/unparseable. */
  readonly code: string;
  /** The raw HTTP status that produced this error. */
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.status = status;
  }
}

/** An ENOENT-shaped rejection so missing-document handling matches the local adapters. */
function notFound(id: string): NodeJS.ErrnoException {
  const err = new Error(`no concept document '${id}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/**
 * Extract a version-carrying response's {@link Version} from `X-Version` (primary, edge-proof —
 * see this module's doc comment) or, failing that, a quote/weak-prefix-stripped `ETag`
 * (fallback — `stripETagWrapper` tolerates both a properly quoted `"sha256:..."` and a weak
 * `W/"sha256:..."` form). THROWS a loud `RemoteError` (`VERSION_MISSING`) when a response has
 * NEITHER header, instead of ever silently substituting `""` — the production bug this repair
 * closes. `context` is a short human-readable description of the request (e.g. `GET /docs/{id}`)
 * folded into the error message so the failure is actionable without a debugger.
 */
function extractVersion(res: Response, context: string): Version {
  const xVersion = res.headers.get("x-version");
  if (xVersion) return xVersion;
  const etag = res.headers.get("etag");
  if (etag) return stripETagWrapper(etag);
  throw new RemoteError(
    `wire response for ${context} carried neither an X-Version nor an ETag header — the version ` +
      `is unknown, so compare-and-swap integrity cannot be guaranteed for a subsequent write. ` +
      `Likely cause: an intermediary (e.g. a CDN or compressing proxy) stripped the version ` +
      `header from the response.`,
    "VERSION_MISSING",
    res.status,
  );
}

/**
 * Reject `expectedVersion === ""` as malformed input BEFORE constructing an `If-Match` header —
 * an empty string is never a valid content-addressed {@link Version} token (see `types.ts`'s
 * `Version` doc comment: `sha256:<hex>`), and if it silently reached `If-Match: ` the write
 * would go out UNCONDITIONAL (an absent/empty CAS guard is last-writer-wins on this seam),
 * reopening the exact silent-CAS-downgrade class this repair exists to close — e.g. if a caller
 * naively passed through a version read via {@link extractVersion} from an OLDER, unpatched
 * server that still emitted the empty-string default. An `InvalidInputError` (not a
 * `RemoteError`): a caller-side input problem discovered before any request is sent, not a
 * wire response to classify.
 */
function assertValidExpectedVersion(expectedVersion: WriteOptions["expectedVersion"]): void {
  if (expectedVersion === "") {
    throw new InvalidInputError(
      "expectedVersion must not be an empty string — pass a real version token, null " +
        "(expect-absent create), or omit the option entirely (unconditional write)",
    );
  }
}

/**
 * Transient HTTP statuses worth retrying: 500 (a Cloudflare D1 cold-start surfaces as a 500
 * "storage caused object to be reset" the first time a hibernated database is hit), plus the edge
 * gateway family 502/503/504. Deliberately NARROW — a 4xx (incl. 412 VersionConflict) or 401 is a
 * REAL result, never retried; 501/505 are terminal server bugs, not transient, so also excluded.
 */
const RETRIABLE_STATUS = new Set([500, 502, 503, 504]);

/** Retry-backoff timing: exponential base doubling, capped, with jitter to avoid a thundering herd. */
const RETRY_BASE_MS = 150;
const RETRY_CAP_MS = 2000;
const RETRY_JITTER_MS = 100;

/** Backoff before retry attempt `n` (0-indexed): min(cap, base * 2^n) + [0, jitter). */
function retryDelayMs(attempt: number): number {
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return backoff + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** URL-encode a concept id's path segments individually, preserving `/` as the separator. */
function encodeId(id: ConceptId): string {
  return id
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** URL-encode a blob key's path segments individually, preserving `/` as the separator. */
function encodeBlobKey(key: BlobKey): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * The client half of the wire-protocol v0 contract: implements {@link StorageBackend}
 * over HTTP against a `@superbee/server` instance (or any conformant
 * implementation of `docs/WIRE-PROTOCOL.md`).
 */
export class RemoteBackend implements StorageBackend {
  private readonly baseUrl: string;
  private readonly bundle: string;
  private readonly fetchImpl: FetchLike;
  private readonly authToken?: string;
  private readonly maxRetries: number;

  constructor(options: RemoteBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bundle = options.bundle;
    this.fetchImpl = options.fetchImpl ?? ((request: Request) => globalThis.fetch(request));
    this.authToken = options.authToken;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Build the absolute URL for a bundle-relative wire path (e.g. `/docs/concepts/x`). */
  private url(bundleRelativePath: string): string {
    return `${this.baseUrl}/v0/bundles/${encodeURIComponent(this.bundle)}${bundleRelativePath}`;
  }

  private async send(bundleRelativePath: string, init: RequestInit = {}): Promise<Response> {
    // Attach Authorization on EVERY request when an authToken is configured — the reference
    // server ignores the header (no auth enforced), while a separate gated deployment may
    // require it. Merged onto any caller-supplied headers rather than overwriting `init`.
    if (this.authToken) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.authToken}`);
      init = { ...init, headers };
    }
    const url = this.url(bundleRelativePath);
    // Retry TRANSIENT failures — a transient 5xx (notably a Cloudflare D1 cold-start's 500 "storage
    // object reset" when a hibernated database is first hit; also 502/503/504 from the edge) or a
    // network/transport error — with exponential backoff + jitter, so a hibernated-backend hiccup is
    // transparent instead of a hard failure. A REAL result (2xx, or 4xx incl. 412 VersionConflict,
    // or 401) returns/throws immediately, never retried. Safe because every op is content-addressed
    // + CAS: a retried write lands the same version or a conflict (possibly SPURIOUS — a prior
    // attempt may have committed before its response was lost — but never silent data loss); a
    // retried read is idempotent. `send` rebuilds the Request per attempt from `init` (bodies are
    // strings/bytes, so reusable — no consumed-stream hazard).
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(new Request(url, init));
        if (RETRIABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < this.maxRetries) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /** Parse a non-2xx response into the typed error the engine expects. */
  private async toError(res: Response, fallbackId: string): Promise<Error> {
    let envelope: ErrorEnvelope | null = null;
    try {
      envelope = (await res.json()) as ErrorEnvelope;
    } catch {
      envelope = null;
    }
    if (res.status === 412) {
      const expected = envelope?.error?.details?.expected ?? null;
      const actual = envelope?.error?.details?.actual ?? null;
      return new VersionConflict(fallbackId, expected, actual);
    }
    const message = envelope?.error?.message ?? `wire request failed with status ${res.status}`;
    // The envelope's own `code` wins when present (every route in this repo's servers emits
    // one); a status-derived guess covers a malformed/absent envelope or a conformant-but-
    // foreign server that doesn't populate `code`.
    const code = envelope?.error?.code ?? (res.status === 401 ? "AUTH_REQUIRED" : res.status >= 500 ? "RUNTIME" : "USAGE");
    return new RemoteError(message, code, res.status);
  }

  async read(id: ConceptId): Promise<ReadResult> {
    assertSafeConceptId(id);
    const res = await this.send(`/docs/${encodeId(id)}`, { method: "GET" });
    if (res.status === 404) throw notFound(id);
    if (!res.ok) throw await this.toError(res, id);
    const version = extractVersion(res, `GET /docs/${id}`);
    const payload = (await res.json()) as Pick<OkfDocument, "id" | "frontmatter" | "body">;
    // The requested route key owns identity. A foreign or buggy server payload must not rename
    // the document the caller asked for (the same rule FilesystemBackend/MemoryBackend enforce).
    return { doc: { id, frontmatter: payload.frontmatter, body: payload.body }, version };
  }

  async readMany(ids: ConceptId[]): Promise<ReadResult[]> {
    for (const id of ids) assertSafeConceptId(id);
    if (ids.length === 0) return [];
    const res = await this.send("/docs:read-many", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (res.status === 404) {
      let missing: string[] = [];
      try {
        const envelope = (await res.json()) as ErrorEnvelope;
        missing = envelope.error.details?.missing ?? [];
      } catch {
        /* fall through with an empty missing set */
      }
      throw notFound(missing[0] ?? ids[0]!);
    }
    if (!res.ok) throw await this.toError(res, ids[0] ?? "");
    const payload = (await res.json()) as {
      results: Array<Pick<OkfDocument, "id" | "frontmatter" | "body"> & { version: Version }>;
    };
    if (payload.results.length !== ids.length) {
      throw new RemoteError(
        `wire read-many returned ${payload.results.length} result(s) for ${ids.length} requested id(s)`,
        "RUNTIME",
        502,
      );
    }
    return payload.results.map((r, index) => ({
      // `readMany`'s positional contract pairs each payload with the requested id at that index;
      // never trust a redundant payload id to redefine the route-owned identity.
      doc: { id: ids[index]!, frontmatter: r.frontmatter, body: r.body },
      version: r.version,
    }));
  }

  async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    assertSafeConceptId(id);
    assertValidExpectedVersion(options.expectedVersion);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.expectedVersion === null) headers["If-None-Match"] = "*";
    else if (options.expectedVersion !== undefined) headers["If-Match"] = options.expectedVersion;
    if (options.actor) headers["X-Actor"] = options.actor;

    const res = await this.send(`/docs/${encodeId(id)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ frontmatter: doc.frontmatter, body: doc.body ?? "" }),
    });
    if (!res.ok) throw await this.toError(res, id);
    const payload = (await res.json()) as { version: Version };
    return payload.version;
  }

  async exists(id: ConceptId): Promise<boolean> {
    assertSafeConceptId(id);
    const res = await this.send(`/docs/${encodeId(id)}`, { method: "HEAD" });
    if (res.status === 404) return false;
    if (!res.ok) throw await this.toError(res, id);
    return true;
  }

  /**
   * THE `GET /docs` cursor pager — the pagination contract (the `cursor` param, the
   * `{ docs, next_cursor }` envelope) exists ONCE, here; {@link RemoteBackend.list} and
   * {@link RemoteBackend.queryHeads} are both thin row-mappings over it, so a wire
   * pagination change cannot make the two scans silently paginate differently.
   */
  private async pageDocs<Row>(
    baseParams: URLSearchParams,
    mapRow: (row: { id: ConceptId; version: Version; frontmatter: Frontmatter }) => Row,
    errorContext: string,
  ): Promise<Row[]> {
    const rows: Row[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams(baseParams);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const res = await this.send(`/docs${qs ? `?${qs}` : ""}`, { method: "GET" });
      if (!res.ok) throw await this.toError(res, errorContext);
      const payload = (await res.json()) as {
        docs: Array<{ id: ConceptId; version: Version; frontmatter: Frontmatter }>;
        next_cursor: string | null;
      };
      for (const row of payload.docs) rows.push(mapRow(row));
      if (!payload.next_cursor) break;
      cursor = payload.next_cursor;
    }
    return rows;
  }

  async list(prefix?: string): Promise<ConceptId[]> {
    const params = new URLSearchParams();
    if (prefix) params.set("prefix", prefix);
    return this.pageDocs(params, (row) => row.id, prefix ?? "");
  }

  /**
   * The seam's OPTIONAL head-projection push-down, over the SAME `GET /docs` route
   * `list()` pages through — with `fields=frontmatter` (the wire's full-frontmatter
   * projection, in the protocol since v0) plus the `prefix`/`type`/repeated-`tag`
   * filter params the reference router evaluates server-side. A filtered scan therefore
   * crosses the wire as thin frontmatter rows: NO bodies, and non-matching docs never
   * leave the server. {@link QueryFilter.fields} equality is NOT pushed (the wire's
   * `fields` param is the projection selector — a recorded name collision, see
   * `docs/WIRE-PROTOCOL.md`); the engine's `queryHeads` re-filter covers it, per the
   * seam contract (over-returning is fine; semantics live in core).
   */
  async queryHeads(filter: QueryFilter = {}): Promise<HeadResult[]> {
    const params = new URLSearchParams();
    params.set("fields", "frontmatter");
    if (filter.prefix) params.set("prefix", filter.prefix);
    if (filter.type) params.set("type", filter.type);
    for (const tag of filter.tags ?? []) params.append("tag", tag);
    return this.pageDocs(
      params,
      (row) => ({ id: row.id, frontmatter: row.frontmatter, version: row.version }),
      filter.prefix ?? "",
    );
  }

  async versions(id: ConceptId): Promise<VersionInfo[]> {
    assertSafeConceptId(id);
    const res = await this.send(`/docs/${encodeId(id)}/versions`, { method: "GET" });
    if (!res.ok) throw await this.toError(res, id);
    // Parse `agent` explicitly (defensive against foreign/extra fields) rather than trusting
    // the wire payload's shape to already BE `VersionInfo[]` — and omit it from the returned
    // entry (not merely set it to `undefined`) when the server didn't record one.
    const payload = (await res.json()) as {
      versions: Array<{ version: Version; actor: string; timestamp: string; agent?: string }>;
    };
    return payload.versions.map((v) =>
      v.agent === undefined
        ? { version: v.version, actor: v.actor, timestamp: v.timestamp }
        : { version: v.version, actor: v.actor, timestamp: v.timestamp, agent: v.agent },
    );
  }

  async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const res = await this.send(`/reserved/${name}${qs}`, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, `${dir}/${name}`);
    const version = extractVersion(res, `GET /reserved/${name}`);
    const payload = (await res.json()) as { content: string };
    return { content: payload.content, version };
  }

  async writeReserved(
    dir: string,
    name: ReservedFilename,
    content: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertValidExpectedVersion(options.expectedVersion);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.expectedVersion === null) headers["If-None-Match"] = "*";
    else if (options.expectedVersion !== undefined) headers["If-Match"] = options.expectedVersion;
    if (options.actor) headers["X-Actor"] = options.actor;

    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const res = await this.send(`/reserved/${name}${qs}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw await this.toError(res, `${dir}/${name}`);
    const payload = (await res.json()) as { version: Version };
    return payload.version;
  }

  /**
   * `DELETE /docs/{id}`, `If-Match: <expectedVersion>` when given (no unwrapped/null branch
   * to send — {@link DeleteOptions} carries no expect-absent reading, unlike
   * {@link WriteOptions}) and NO `X-Actor` (a delete records no new revision to attribute).
   * `assertValidExpectedVersion` rejects `""` the same way `write` does. There is NO `404`
   * branch: an absent target is a normal `200 { deleted: false }` response by wire contract
   * (idempotency, AXI P6), never a rejection — `!res.ok` still routes a `412` through
   * `toError`'s existing `VersionConflict` reconstruction, and anything else through
   * `RemoteError`.
   */
  async delete(id: ConceptId, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeConceptId(id);
    assertValidExpectedVersion(options.expectedVersion);
    const headers: Record<string, string> = {};
    if (options.expectedVersion !== undefined) headers["If-Match"] = options.expectedVersion;

    const res = await this.send(`/docs/${encodeId(id)}`, { method: "DELETE", headers });
    if (!res.ok) throw await this.toError(res, id);
    const payload = (await res.json()) as { deleted: boolean };
    return payload.deleted;
  }

  // ── blobs: opaque bytes served by content-type (wire-protocol v0.1) ──────────
  //
  // Bytes cross the wire as the RAW request/response body — never JSON (B1): PUT
  // sends a `Uint8Array` directly as `BodyInit`, GET reads back via `arrayBuffer()`.
  // No `Buffer` anywhere in this module, so it stays browser/edge-runtime compatible.
  // Content-type rides `Content-Type`; the version rides `X-Version`/`ETag` (extractVersion),
  // exactly like docs.

  async readBlob(key: BlobKey): Promise<ReadBlobResult | null> {
    assertSafeBlobKey(key);
    const res = await this.send(`/blobs/${encodeBlobKey(key)}`, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, key);
    const version = extractVersion(res, `GET /blobs/${key}`);
    const contentType = res.headers.get("content-type") ?? DEFAULT_BLOB_CONTENT_TYPE;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType, version };
  }

  async writeBlob(
    key: BlobKey,
    bytes: Uint8Array,
    contentType?: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    assertSafeBlobKey(key);
    assertValidExpectedVersion(options.expectedVersion);
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    if (options.expectedVersion === null) headers["If-None-Match"] = "*";
    else if (options.expectedVersion !== undefined) headers["If-Match"] = options.expectedVersion;
    if (options.actor) headers["X-Actor"] = options.actor;

    const res = await this.send(`/blobs/${encodeBlobKey(key)}`, {
      method: "PUT",
      headers,
      body: bytes,
    });
    if (!res.ok) throw await this.toError(res, key);
    const payload = (await res.json()) as { version: Version };
    return payload.version;
  }

  /** `DELETE /blobs/{key}`, mirroring `delete`'s `If-Match`/no-404/no-actor posture exactly. */
  async deleteBlob(key: BlobKey, options: DeleteOptions = {}): Promise<boolean> {
    assertSafeBlobKey(key);
    assertValidExpectedVersion(options.expectedVersion);
    const headers: Record<string, string> = {};
    if (options.expectedVersion !== undefined) headers["If-Match"] = options.expectedVersion;

    const res = await this.send(`/blobs/${encodeBlobKey(key)}`, { method: "DELETE", headers });
    if (!res.ok) throw await this.toError(res, key);
    const payload = (await res.json()) as { deleted: boolean };
    return payload.deleted;
  }

  async existsBlob(key: BlobKey): Promise<boolean> {
    assertSafeBlobKey(key);
    const res = await this.send(`/blobs/${encodeBlobKey(key)}`, { method: "HEAD" });
    if (res.status === 404) return false;
    if (!res.ok) throw await this.toError(res, key);
    return true;
  }

  async listBlobs(prefix?: string): Promise<BlobKey[]> {
    const keys: BlobKey[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams();
      if (prefix) params.set("prefix", prefix);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const res = await this.send(`/blobs${qs ? `?${qs}` : ""}`, { method: "GET" });
      if (!res.ok) throw await this.toError(res, prefix ?? "");
      const payload = (await res.json()) as { keys: BlobKey[]; next_cursor: string | null };
      keys.push(...payload.keys);
      if (!payload.next_cursor) break;
      cursor = payload.next_cursor;
    }
    return keys;
  }
}
