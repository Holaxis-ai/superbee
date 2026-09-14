# Prepared body delivery

`@superbee/core/governed-body-write` supports explicit `document.body.update` operations
when a shared authority controls document metadata. It does not replace exact-document
`document.write`, implement persistence, or activate synchronization.

## Prepare, persist, deliver

Use `prepareBodyDelivery(input, { expectedVersion })` for an update against an observed
non-null authority version. Creates, frontmatter patches, and overwrite modes are not supported.
The input records the original local content, its exact-byte SHA-256 version, an explicit OKF
edition (`0.1` or `0.2`), a stable request identity, and an explicit body operation. The parsed
candidate must have a nonempty concept type and the same body under the existing storage
normalization rule. The result is copied and frozen, including nested values.

Persist this exact prepared envelope and a potentially-attempted claim atomically **before**
network delivery. Recover it using `validatePreparedBodyDelivery`; never reconstruct an attempted
request using a fresh head or a different predecessor. `assertSameBodyDelivery` rejects changed
input, including local history, under a reused identity. These functions cannot establish that a
consumer actually persisted the record.

`performBodyDelivery(transport, prepared, attempts, options)` reuses `performUncertainWrite` with
recorded-only settlement. A nonzero attempt count begins with lookup. A lookup may return `null`
only when the authority positively knows the request was never recorded; unavailable, expired,
unsupported, or incomplete evidence must return unknown or throw. Requests are never blindly
resubmitted after an uncertain outcome. Authorization refusals should use the existing recognized
codes such as `FORBIDDEN` or `AUTH_REQUIRED`.

The transport submits the prepared body operation, not a generic exact-document write. A conflict
against the original local hash stays a conflict: equal content does not prove that the authority
performed a metadata-governed operation. Existing uncertain-write callers retain exact-content
settlement by default.

## Bind the committed snapshot

A committed receipt repeats scope, request identity, target, expected version and exact operation
body, and includes the committed version and its document content. `validateBodyReceipt` checks
that binding and parses the snapshot under the selected edition, requiring the same normalized
body and a nonempty concept type. Missing or mismatched evidence cannot yield success.

The authority port is trusted to associate the snapshot with the immutable committed version.
This is an assertion, not cryptographic proof or an authorization credential. The content can be
parsed and reserialized, so its hash need not equal the authority's version. An unrelated later
head is not valid evidence. The original local content is different: its raw bytes must hash to
the captured local version.

Prepare a successor with `{ prepared: predecessor, receipt }`. It must keep scope, target and
edition, use a different request identity, and derives its expected version from that validated
receipt. An arbitrary acknowledged-version token is not a substitute for the receipt.

## Reconciliation is a conditional proposal

`reconcileBodyReceipt` accepts a consistent document version and full journal-record snapshot.
It returns the authority's shared base plus either `preserve-local` or
`replace-local-under-CAS`, carrying the complete captured snapshot as the expected premise.

Replacement is proposed only when the current document still has the captured local version,
the exact request's original content and identity are present in the journal, and no later
intent for that document exists. Every later local commit prevents replacement, even an
acknowledged intent with identical bytes. Missing anchors preserve local content; duplicate
identities or sequence numbers refuse an ambiguous snapshot.

The persistence adapter must compare the full journal and document version **atomically** before
replacement. A version-only comparison is insufficient. This module changes no journal state,
database, document, or draft buffer; a proposal is not proof that persistence honored its CAS.
The snapshot must include acknowledged records needed to establish ordering, not just pending
records. Consumers must retain the anchor until reconciliation can complete.

## Bounds and evidence

Labels and target IDs are limited to 2,048 UTF-8 bytes, operation bodies to 64 KiB, and content,
serialized envelopes and reconciliation snapshots to 2 MiB. Request IDs use the existing
128-character printable-ASCII rule. Counts are nonnegative safe integers with overflow checks.
Unexpected fields, unknown schemas/editions/operations, reserved concept targets, invalid
timestamps and incomplete evidence fail closed. Scope is a non-secret identity label; do not put
credentials in envelopes or document content. Limits are contract bounds, not a storage quota.

The agreement rows in `test/governed-body-write.test.ts` exercise engine-authored metadata,
immutable recorded snapshots, chained operations, lost replies, reloads, refusals, conflicting
content, malformed inputs and newer local commits. Browser bundle and package-subpath checks
exercise the same public primitive. Reload fixtures prove serialized envelope stability, not
browser crash durability; atomic journal preparation and settlement remain consumer obligations.
