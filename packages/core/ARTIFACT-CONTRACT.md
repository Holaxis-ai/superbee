# Document target and presentation values

`@superbee/core/artifact-contract` exports portable v1 value types and pure decoders for
`DocumentTargetV1`, `DocumentObservationV1`, `PresentDocumentRequestV1`,
`PresentDocumentReceiptV1` and `DocumentPresentationCapabilitiesV1`. It also exports
`ArtifactAuthorityV1`, `ArtifactLifecycleV1`, `PresentationStateV1`,
`PresentationErrorCodeV1` and `ArtifactDecodeResult<T>`.

Call `decodeDocumentTargetV1`, `decodeDocumentObservationV1`,
`decodePresentDocumentRequestV1`, `decodePresentDocumentReceiptV1(value, expectedRequest)`
and `decodeDocumentPresentationCapabilitiesV1` on object values. Each returns `{ ok: true,
value }` or `{ ok: false, code }`, where code is `invalid_input`, `unsupported_version` or
`receipt_mismatch`. Receipt expectations must be decoded or constructed by the trusted caller.
Decoding clones data, accepts plain/null-prototype records, refuses unexpected/inherited fields,
accessors, symbols and cycles, and catches reflective failures. Proxy reflection can run traps;
this is not an object sandbox. A shared noncyclic reference is allowed. Raw framing, duplicate JSON
keys, transport limits, authentication and receipt origin belong to the host.

Authority/workspace/bundle keys, invocation IDs and lifecycle tokens are exact, nonempty printable
ASCII strings of at most 256 characters, without whitespace or path separators. Keys identify a
trusted host binding; they are neither credentials nor routes. Document IDs reuse core's canonical
ID grammar with no additional length bound: `x` and `x.md` identify distinct documents. Versions
reuse the content-version grammar. Provenance retains its existing semantics and request-ID domain.

`sameDocumentTargetV1(a, b)` compares authority mode/key, hosted workspace, bundle and document
exactly. `compareAuthorityVersionV1(observation, reference)` compares only shared-confirmed
`acknowledged`, yielding `same` or `different`; pending/conflict yields `unconfirmed`. Runtime
`version` can differ from authority `acknowledged`. Neither equal bytes nor shared confirmation
proves present existence, permissions or lifecycle continuity.

Lifecycle is owner evidence: `unverified`, or `bound` with source and document tokens. Decoding
checks shape; the source owner must revalidate continuity before action. A successful receipt for
an `expectedLifecycle` must include a matching bound observation. `referenceVersion` expresses
context/comparison, not historical rendering or approval. Every receipt correlates the invocation,
complete target and any observation target. Rejected receipts never authorize a repeated effect.

Presentation evidence has four states:

- `open_requested`: the browser launcher returned.
- `payload_prepared`: a reader payload exists; an observation is required.
- `offered`: a suggestion was created, with integer epoch expiry from zero through
  `Number.MAX_SAFE_INTEGER`. Expired receipts remain historical evidence.
- `navigated`: the host reports a router commit.

These states do not prove displayed pixels, human reading, inbox acceptance or completed work.
Empty capability states means no v1 presentation capability; duplicates and unknown states refuse.
Only `busy` and `unavailable` errors permit `retryable: true`, for a new explicit invocation under
current context. No decoder automatically retries, opens a host or performs an effect.

The first consumer is managed local `superbee doc open`. It binds the already selected canonical
root's digest to a local authority with bundle key `selected`, uses the decoded ID for its current
read and managed UI start/reuse, and records local read provenance with unverified lifecycle. The
root digest is a scoped reference, not secrecy or a document incarnation. It does not promise
addressing continuity across machines or bundle copies. Its internal `open_requested` receipt is
created only after the existing stdout receipt and browser call. Public output/errors, actor/root
selection and managed behavior stay unchanged; a throwing launcher still rejects after stdout.
The observation precedes launch and cannot guarantee the bytes subsequently rendered.

This subpath has no storage, network, DOM or Node dependency. It does not register an adapter or
change remote/foreground UI, MCP payloads/discovery, hosted reveal or mobile routes. Cross-surface
fixtures demonstrate codec semantics only. Hosted admission, durable lifecycle, attention, inboxes,
notifications, agent work and new adapters require separately reviewed adoption.
