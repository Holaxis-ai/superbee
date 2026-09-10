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

A production host uses `@superbee/server/router`, whose context resolver authenticates and
authorizes the one canonical resolved bundle route, then returns a bundle-bound backend and trusted
attribution. That router ignores client-supplied `X-Actor` and `X-Agent`; the Node package-root
reference adapter retains both as advisory, client-controlled strings for compatibility.

`RemoteBackend` can send `Authorization: Bearer <token>` on every request, but that capability does
not make the reference server enforce it. A gated deployment owns the meaning of that token.

## Conventions

- Paths are `/v0/bundles/{bundle}/...`. The reference router closes over one backend: it accepts
  any syntactically valid `{bundle}` segment but does not use it to select among bundles.
- The Worker-safe `@superbee/server/router` subpath instead requires exactly `bnd_` plus 32
  lowercase hexadecimal characters. Its public resolver rejects labels, aliases, uppercase ids,
  percent escapes, encoded slash or backslash, and empty or repeated bundle segments before the
  trusted context resolver can run. `GET /v0/capabilities` is deployment-scoped and bypasses that
  resolver and storage.
- `resolveWireRequest(Request)` governs the normalized `pathname` exposed by the Fetch/WHATWG URL
  API. An adapter that can inspect an HTTP request-target before URL normalization may enforce
  stricter raw-target rules separately. The Fetch router does not reconstruct raw bytes that the
  platform no longer exposes. Encoded separators and malformed bundle tokens that survive
  normalization are rejected. Normalized-away dot forms are outside this router's observable
  boundary and can become a canonical route (for example, `/bundles/./bnd_.../docs`); rejecting
  their raw spelling requires an upstream adapter with request-target access.
- Document IDs and blob keys may contain `/`; clients encode each segment independently. Every
  route validates decoded IDs/keys before backend access. Document IDs cannot address reserved
  `index.md` or `log.md`; blob keys cannot end in `.md` and reject absolute, traversal, and
  dot-prefixed segments.
- JSON responses use `content-type: application/json; charset=utf-8`. Blob reads use the blob's
  content type and raw bytes. Successful `HEAD` responses and all `HEAD` failures are bodyless.
- Except for `HEAD`, errors have shape
  `{ "error": { "code": "...", "message": "...", "details": ... } }`. Current router-owned
  classes are `400 USAGE`, `404 NOT_FOUND`, `412 VERSION_CONFLICT`, and `500 RUNTIME`. Unsupported
  methods currently return `400 USAGE`, not `405`. `401 AUTH_REQUIRED` and `403 FORBIDDEN` are
  host-owned: a gated host answers them before the router runs, and the reference router never
  emits them. On an identified write that ordering matters: an authorization refusal arrives
  before the key is claimed, so nothing is recorded under it.
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
  `deleted:false`, not `404`. A supplied stale `If-Match` still returns `412`. A document delete
  that carried `If-Match` answers with the version headers naming that token; an unconditional
  delete sends none.
- `Idempotency-Key` identifies a document `PUT` or `DELETE` so it is applied at most once and its
  outcome can be looked up afterwards; see "Identified writes and outcome lookup" below. On any
  other endpoint the header is `400 USAGE`, never ignored.

## Implemented endpoints

`{id...}` and `{key...}` mean one or more independently encoded path segments; `{key}` on the
operation route is exactly one.

| Method | Path | Success contract |
| --- | --- | --- |
| GET | `/v0/capabilities` | `200` capability booleans: `history`, `enforced_cas`, `projections`, `backlinks`, `blobs`, `operations`. |
| GET | `/v0/bundles/{bundle}/docs` | `200 { count, docs, next_cursor }`; filters/pagination below. |
| POST | `/v0/bundles/{bundle}/docs:read-many` | JSON `{ ids: string[] }`; `200 { results }`, or all-or-nothing `404` with `details.missing`. |
| GET | `/v0/bundles/{bundle}/docs/{id...}` | `200 { id, frontmatter, body }` plus version headers. |
| PUT | `/v0/bundles/{bundle}/docs/{id...}` | JSON `{ frontmatter, body? }`; `201` for expect-absent create, otherwise `200`, with `{ version }` plus version headers. |
| HEAD | `/v0/bundles/{bundle}/docs/{id...}` | Bodyless `200` plus version headers, `404` absent, or `400` invalid. |
| DELETE | `/v0/bundles/{bundle}/docs/{id...}` | `200 { deleted }`; optional `If-Match`, echoed as version headers when supplied. |
| GET | `/v0/bundles/{bundle}/docs/{id...}/versions` | `200 { versions }`, each carrying version, actor, timestamp, and optional agent. |
| GET | `/v0/bundles/{bundle}/reserved/{name}` | `{name}` is `index.md` or `log.md`; optional `dir`; `200 { content }` plus version headers, or `404`. |
| PUT | `/v0/bundles/{bundle}/reserved/{name}` | `{name}` is `index.md` or `log.md`; optional `dir`; JSON `{ content }`; `201` expect-absent or `200`, with `{ version }` plus headers. |
| GET | `/v0/bundles/{bundle}/blobs` | `200 { count, keys, next_cursor }`; prefix/pagination below. |
| GET | `/v0/bundles/{bundle}/blobs/{key...}` | Raw bytes with stored `Content-Type` and version headers, or JSON `404`. |
| PUT | `/v0/bundles/{bundle}/blobs/{key...}` | Raw request bytes; optional `Content-Type`; `201` expect-absent or `200`, with `{ version }` plus headers. |
| HEAD | `/v0/bundles/{bundle}/blobs/{key...}` | Bodyless `200` with content type/version, `404` absent, or `400` invalid. |
| DELETE | `/v0/bundles/{bundle}/blobs/{key...}` | `200 { deleted }`; optional `If-Match`. |
| GET | `/v0/bundles/{bundle}/operations/{key}` | `200` recorded outcome of the identified write under `{key}`, or `404 NOT_FOUND` when nothing is recorded; requires write access. |

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

## Identified writes and outcome lookup

A write over a network has three answers, not two: applied, refused, or lost before the client
learned which. A document `PUT` or `DELETE` that carries an `Idempotency-Key` header is an
identified write: the authority applies it at most once under that key and keeps the answer, so a
client whose response was lost can look the answer up instead of guessing.

- The key is 1 to 128 printable ASCII characters with no space; anything else is `400 USAGE`.
  Identity is scoped per bundle and per key.
- The header is accepted on document `PUT` and `DELETE` only. Reserved-file and blob writes do not
  accept it in this slice, and a key on any other endpoint is `400 USAGE`, so a client never
  believes an unsupported write was identified.
- The key is claimed before the write is applied. A duplicate submission, including one that
  arrives while the first application is still in progress, receives the recorded response
  replayed: the same status, the same `X-Version` and `ETag`, the same body. Payload differences
  under the same key, method and id are not inspected.
- A recorded outcome is bound to the method and decoded document id it was recorded for. The same
  key resubmitted with a different method or id is `400 USAGE` with
  `details: { recorded: { method, id } }`, never a replay.
- Content rejections are recorded outcomes: a duplicate of a `412 VERSION_CONFLICT` replays the
  `412`, and a duplicate of a `400 USAGE` replays the `400`. A host-owned `401 AUTH_REQUIRED` or
  `403 FORBIDDEN` is answered before the key is claimed, so nothing is recorded under it. If the
  application throws before any response exists (a runtime failure, not a 4xx or 5xx response),
  the claim is released with nothing recorded and a later submission applies fresh.
- An identified `DELETE` must carry a well-formed `If-Match` token, a content-addressed version
  (`sha256:` followed by 64 lowercase hex characters, bare or in ETag form); without one, or with
  an empty or malformed one, the request is `400 USAGE` before the key is claimed and nothing is
  recorded. The delete's response echoes the `If-Match` token as its version headers, which is
  the version its recorded outcome is committed at. That holds for `deleted: false` as well: an
  absent target is the idempotent success the wire promises, and the token the client supplied
  remains the revision its outcome names.
- `GET /v0/bundles/{bundle}/operations/{key}` returns the recorded outcome as exactly one of
  `{ "kind": "committed", "version" }`, `{ "kind": "conflict", "actual" }`, or
  `{ "kind": "refused", "code", "message" }` (the `Outcome` union of
  `@superbee/core/uncertain-write` without `unknown`). It requires write access: the caller must
  hold the right to make the write in order to learn its outcome. `404 NOT_FOUND` means the
  authority holds nothing under that key; an invalid key is `400 USAGE`.
- Retention. The reference store keeps an outcome for a window, 24 hours by default and
  configurable with an injectable clock. A host states its window. A `404` after expiry is
  indistinguishable from never recorded. A resubmission after expiry is safe only because the
  write carries its compare-and-swap premise: a committed write resubmitted after expiry answers
  `412` whose `actual` equals the client's own committed version, which the client treats as
  committed. That property is what makes expiry safe, and it is why an identified write is always
  a guarded write.
- `GET /v0/capabilities` reports `operations: true` exactly when the host records outcomes. A
  host without a store answers any request carrying `Idempotency-Key`, and the lookup route, with
  `400 USAGE` "request identity is not supported by this host".

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
- `WriteOptions.requestId` and `DeleteOptions.requestId` travel as `Idempotency-Key`; a malformed
  one is an `InvalidInputError` before any request is sent. Transient retries of an identified
  write are true replays. `RemoteBackend.lookupOperation(requestId)` reads the outcome route and
  maps `404` to `null`. `createRemoteOperationTransport` in `@superbee/core/remote-operations`
  is the uncertain-write transport over those two calls: a `document.write` intent becomes an
  identified guarded `PUT`, and a lost answer is resolved by lookup before any resubmission.

## Behavior evidence

The router's sole raw URL/method boundary dispatches through its exported `WIRE_ENDPOINTS` registry,
whose rows own endpoint id, method, path template, resource kind, and access class. The public
resolver returns either a deployment-scoped capability route or a bundle-scoped route carrying the
canonical bundle id, endpoint id, access class, and decoded resource. The Worker router passes that
same object to its context resolver once and dispatches through the returned bound backend.
The contract test pins that boundary, requires the exact endpoint table above to match the runtime
registry, and validates every source/test anchor in this proof table. The referenced behavioral
suites exercise the semantics through the router, `RemoteBackend`, and a real socket.

| ID | Contract area | Implementation evidence | Behavioral proof |
| --- | --- | --- | --- |
| WIRE-PROOF-01 | Capabilities and single-backend routing. | `packages/server/src/router.ts::id: "capabilities"` | `packages/core/test/wire-protocol.test.ts::GET /v0/capabilities reports` |
| WIRE-PROOF-02 | Document collection, projections, filters, cursors, and read-many. | `packages/server/src/router.ts::id: "docs-read-many"` | `packages/core/test/wire-protocol.test.ts::GET /docs list endpoint carries count` |
| WIRE-PROOF-03 | Document member read/write/head/delete and version headers. | `packages/server/src/router.ts::id: "doc-delete"` | `packages/core/test/wire-protocol.test.ts::raw DELETE /docs/{id} response shape` |
| WIRE-PROOF-04 | History and attribution payload. | `packages/server/src/router.ts::case "doc-versions"` | `packages/core/test/wire-protocol.test.ts::GET /docs/{id}/versions returns` |
| WIRE-PROOF-05 | Reserved file get/put only. | `packages/server/src/router.ts::reserved file name must be index.md or log.md` | `packages/core/test/wire-protocol.test.ts::reserved files have no delete route` |
| WIRE-PROOF-06 | Blob collection and raw byte member routes. | `packages/server/src/router.ts::case "blob-read"` | `packages/core/test/wire-protocol.test.ts::REAL socket GET returns EXACT bytes` |
| WIRE-PROOF-07 | Reference server is loopback by default and unauthenticated. | `packages/server/src/serve.ts::NO AUTH in v0` | `packages/core/test/wire-protocol.test.ts::serve() boots a real node:http listener` |
| WIRE-PROOF-08 | Remote canonical export differs from an original-byte guarantee. | `packages/cli/src/commands/doc/common.ts::canonical OKF re-serialization` | `packages/cli/test/remote.test.ts::canonical re-serialization is byte-identical` |
| WIRE-PROOF-09 | Missing version transport fails closed. | `packages/core/src/remote-backend.ts::VERSION_MISSING` | `packages/cli/test/remote-auth.test.ts::response stripped of BOTH version headers` |
| WIRE-PROOF-10 | Identified writes apply once, replay their record, and are looked up by key. | `packages/server/src/router.ts::id: "operation-lookup"`; `packages/server/src/operation-outcomes.ts::class MemoryOperationOutcomeStore` | `packages/core/test/wire-protocol.test.ts::identified PUT is applied once`; `packages/browser-local/test/sync.test.ts::lost acknowledgement: the fixture applies then drops the response` |

## Known deviations and open questions

These are current limitations, not promises that a client may paper over:

1. The Node package-root reference adapter remains single-backend and does not select among
   bundles. Explicit bundle selection belongs to the Worker-safe subpath's host context resolver.
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
   Only an identified write turns a retry into a replay; an unidentified guarded write retried
   after a lost response may still surface a conservative conflict.
10. Request identity covers document `PUT` and `DELETE` only. Reserved-file and blob writes carry
    no identity yet, and the reference outcome store is in-memory: a restarted reference server
    holds no records, which a client observes as `404` on lookup.
