# Superbee wire protocol

This file is the repository authority for the currently implemented Superbee storage seam over
HTTP. It documents the protocol implemented by `@superbee/server` and consumed by
`RemoteBackend`; code and tests are behavior evidence, not separate protocol specifications.

The current route prefix is `/v0`. Blob routes are an additive v0.1 capability under that prefix.
The protocol is pre-1.0 and may change, but a change is not implemented until this contract and its
behavioral proofs change together.

## Security boundary

The reference `serve()` implementation has **no authentication or authorization**. It ignores the
`Authorization` header and binds to `127.0.0.1` by default. Loopback prevents access from another
machine; it does not protect against another process or user on the same machine. Passing a
non-loopback `host` exposes the same unauthenticated server and is not a production deployment.

A production host must put authentication, authorization, transport security, request limits, and
principal attribution in front of the router. It must strip client-supplied `X-Agent` and set that
header only after authentication if it wants trustworthy agent attribution. On the reference server,
both `X-Actor` and `X-Agent` are advisory, client-controlled strings.

`RemoteBackend` can send `Authorization: Bearer <token>` on every request, but that capability does
not make the reference server enforce it. A gated deployment owns the meaning of that token.

## Conventions

- Paths are `/v0/bundles/{bundle}/...`. The reference router closes over one backend: it accepts
  any syntactically valid `{bundle}` segment but does not use it to select among bundles.
- Document IDs and blob keys may contain `/`; clients encode each segment independently. Every
  route validates decoded IDs/keys before backend access. Document IDs cannot address reserved
  `index.md` or `log.md`; blob keys cannot end in `.md` and reject absolute, traversal, and
  dot-prefixed segments.
- JSON responses use `content-type: application/json; charset=utf-8`. Blob reads use the blob's
  content type and raw bytes. Successful `HEAD` responses and all `HEAD` failures are bodyless.
- Except for `HEAD`, errors have shape
  `{ "error": { "code": "...", "message": "...", "details": ... } }`. Current router-owned
  classes are `400 USAGE`, `404 NOT_FOUND`, `412 VERSION_CONFLICT`, and `500 RUNTIME`. Unsupported
  methods currently return `400 USAGE`, not `405`.
- Version-carrying responses send a bare content-addressed token in `X-Version` (primary) and the
  same token as a quoted `ETag` (secondary). A conforming client must refuse a successful versioned
  read that has neither header; it must not silently downgrade a later CAS write.
- `If-None-Match: *` means expect-absent create. `If-Match` accepts the bare token and quoted or weak
  ETag forms. Omitting both requests an unconditional write. An empty expected version is invalid
  client input, not an unconditional-write spelling.
- `X-Actor` is advisory write attribution. `X-Agent` is reserved for a trusted authentication gate;
  see the no-auth caveat above. Deletes create no revision and send neither attribution header from
  `RemoteBackend`.
- Document and blob deletes are idempotent: both return `200 { "deleted": true|false }`; absence is
  `deleted:false`, not `404`. A supplied stale `If-Match` still returns `412`.

## Implemented endpoints

`{id...}` and `{key...}` mean one or more independently encoded path segments.

| Method | Path | Success contract |
| --- | --- | --- |
| GET | `/v0/capabilities` | `200` capability booleans: `history`, `enforced_cas`, `projections`, `backlinks`, `blobs`. |
| GET | `/v0/bundles/{bundle}/docs` | `200 { count, docs, next_cursor }`; filters/pagination below. |
| POST | `/v0/bundles/{bundle}/docs:read-many` | JSON `{ ids: string[] }`; `200 { results }`, or all-or-nothing `404` with `details.missing`. |
| GET | `/v0/bundles/{bundle}/docs/{id...}` | `200 { id, frontmatter, body }` plus version headers. |
| PUT | `/v0/bundles/{bundle}/docs/{id...}` | JSON `{ frontmatter, body? }`; `201` for expect-absent create, otherwise `200`, with `{ version }` plus version headers. |
| HEAD | `/v0/bundles/{bundle}/docs/{id...}` | Bodyless `200` plus version headers, `404` absent, or `400` invalid. |
| DELETE | `/v0/bundles/{bundle}/docs/{id...}` | `200 { deleted }`; optional `If-Match`. |
| GET | `/v0/bundles/{bundle}/docs/{id...}/versions` | `200 { versions }`, each carrying version, actor, timestamp, and optional agent. |
| GET | `/v0/bundles/{bundle}/reserved/{name}` | `{name}` is `index.md` or `log.md`; optional `dir`; `200 { content }` plus version headers, or `404`. |
| PUT | `/v0/bundles/{bundle}/reserved/{name}` | `{name}` is `index.md` or `log.md`; optional `dir`; JSON `{ content }`; `201` expect-absent or `200`, with `{ version }` plus headers. |
| GET | `/v0/bundles/{bundle}/blobs` | `200 { count, keys, next_cursor }`; prefix/pagination below. |
| GET | `/v0/bundles/{bundle}/blobs/{key...}` | Raw bytes with stored `Content-Type` and version headers, or JSON `404`. |
| PUT | `/v0/bundles/{bundle}/blobs/{key...}` | Raw request bytes; optional `Content-Type`; `201` expect-absent or `200`, with `{ version }` plus headers. |
| HEAD | `/v0/bundles/{bundle}/blobs/{key...}` | Bodyless `200` with content type/version, `404` absent, or `400` invalid. |
| DELETE | `/v0/bundles/{bundle}/blobs/{key...}` | `200 { deleted }`; optional `If-Match`. |

There are deliberately no collection-delete routes and no reserved-file delete route.

### List projection and pagination

Document list query parameters are `prefix`, `type`, repeated `tag`, `fields`, `limit`, and
`cursor`. Filters are ANDed. The default page size is 50; a missing, non-positive, or unparsable
limit also selects 50. `count` is the total filtered count before cursor pagination. The default row
is `{ id, version, type, title, timestamp }`; `fields=frontmatter` returns
`{ id, version, frontmatter }`. The `fields` name is therefore a projection selector on the wire,
not the CLI/core `QueryFilter.fields` equality filter.

Blob list accepts `prefix`, `limit`, and `cursor` with the same page-size and envelope semantics.
Both cursors are the last returned ID/key. If that cursor vanished, the next page resumes using the
same `localeCompare` ordering as the backend scan.

## Documents, canonical bytes, and blobs

The document route transports a parsed document as JSON, not the original Markdown byte stream.
`RemoteBackend.read()` reconstructs the requested ID with the returned frontmatter/body and retains
the server's content-addressed version token. A CLI `doc read --out` over `--remote` therefore emits
Superbee's canonical OKF serialization. It is byte-identical to a local export for an engine-written
canonical document, but external formatting, YAML key order, quoting, or whitespace may not survive
a remote round trip even when document meaning does. The version header identifies server state; it
must not be inferred by hashing the client's reconstructed export.

Blobs are the raw-byte channel. Blob `PUT` and `GET` carry exact bytes as the HTTP body, with content
type in `Content-Type` and identity in the version headers. Blob keys ending in `.md` are rejected so
the blob channel cannot become an accidental bypass around document parsing and ID safety.

## Client behavior

`RemoteBackend` maps the HTTP surface back to the `StorageBackend` seam:

- `404` document reads become an `ENOENT`-shaped error; absent blob reads return `null`.
- `412` reconstructs `VersionConflict` from `details.expected` and `details.actual`.
- Other non-2xx responses become `RemoteError` with the wire code and HTTP status. A missing or
  malformed envelope uses a status-derived fallback.
- Network failures and only `500`, `502`, `503`, and `504` are retried by default, with bounded
  exponential backoff and jitter. A real 4xx, including `401` and `412`, is never retried. A guarded
  write whose response was lost may surface a conservative conflict after retry. `RemoteBackend`
  also permits unconditional writes; because a retry after an ambiguous transport failure can repeat
  one, callers that require lost-update safety must supply `If-Match`/expect-absent semantics.
- Full-frontmatter list pagination supplies the optional `queryHeads` push-down. Core re-applies
  query semantics, so a foreign backend may over-return but cannot redefine matches.

## Behavior evidence

The router dispatches through its exported `WIRE_ENDPOINTS` registry. The contract test requires
the exact endpoint table above to match that runtime registry and validates every source/test anchor
in this proof table. The referenced behavioral suites exercise the semantics through the router,
`RemoteBackend`, and a real socket.

| ID | Contract area | Implementation evidence | Behavioral proof |
| --- | --- | --- | --- |
| WIRE-PROOF-01 | Capabilities and single-backend routing. | `packages/server/src/router.ts::pathname === "/v0/capabilities"` | `packages/core/test/wire-protocol.test.ts::GET /v0/capabilities reports` |
| WIRE-PROOF-02 | Document collection, projections, filters, cursors, and read-many. | `packages/server/src/router.ts::rest === "docs:read-many"` | `packages/core/test/wire-protocol.test.ts::GET /docs list endpoint carries count` |
| WIRE-PROOF-03 | Document member read/write/head/delete and version headers. | `packages/server/src/router.ts::id: "doc-delete"` | `packages/core/test/wire-protocol.test.ts::raw DELETE /docs/{id} response shape` |
| WIRE-PROOF-04 | History and attribution payload. | `packages/server/src/router.ts::tail.endsWith("/versions")` | `packages/core/test/wire-protocol.test.ts::GET /docs/{id}/versions returns` |
| WIRE-PROOF-05 | Reserved file get/put only. | `packages/server/src/router.ts::reserved file name must be index.md or log.md` | `packages/core/test/wire-protocol.test.ts::reserved files have no delete route` |
| WIRE-PROOF-06 | Blob collection and raw byte member routes. | `packages/server/src/router.ts::rest.startsWith("blobs/")` | `packages/core/test/wire-protocol.test.ts::REAL socket GET returns EXACT bytes` |
| WIRE-PROOF-07 | Reference server is loopback by default and unauthenticated. | `packages/server/src/serve.ts::NO AUTH in v0` | `packages/core/test/wire-protocol.test.ts::serve() boots a real node:http listener` |
| WIRE-PROOF-08 | Remote canonical export differs from an original-byte guarantee. | `packages/cli/src/commands/doc/common.ts::canonical OKF re-serialization` | `packages/cli/test/remote.test.ts::canonical re-serialization is byte-identical` |
| WIRE-PROOF-09 | Missing version transport fails closed. | `packages/core/src/remote-backend.ts::VERSION_MISSING` | `packages/cli/test/remote-auth.test.ts::response stripped of BOTH version headers` |

## Known deviations and open questions

These are current limitations, not promises that a client may paper over:

1. The `{bundle}` segment does not select among multiple bundles in the reference router.
2. A document whose final path segment is literally `versions` is ambiguous with the history
   subresource.
3. There is no original-document-byte endpoint. Canonical JSON reconstruction is the only remote
   document export; blobs are raw but cannot use `.md` keys.
4. A malformed document still fails a list. The wire has no `skipped` row/envelope to express the
   CLI's local quarantine-style partial result.
5. Wire `fields` selects a projection and cannot express core's arbitrary field-equality filter.
6. `requestFromIncomingMessage` supports a maximum body size, but reference `serve()` currently
   supplies no cap.
7. Authentication, authorization, and trusted principal/agent attribution belong to a gated host;
   the reference server implements none of them.
8. `backlinks` is reported false and has no wire endpoint; clients derive graph results from reads.
9. Transient retry applies at the transport boundary, including unconditional writes. The storage
   seam permits those writes, so a caller that needs lost-update protection must provide a CAS premise.
