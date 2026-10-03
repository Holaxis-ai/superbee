# @superbee/browser-local

Shared browser-local working-copy and editor-recovery primitives for Superbee hosts.
This prerelease requires exactly `@superbee/core@0.2.0-pre.7`. That core release adds
`retireAcknowledged` to the journaled backend seam (IndexedDB adapter included), which
this package's body runtime calls to retire acknowledged history, and raises the body
delivery bounds to the hosted document write bound. Registry core pre.6 lacks both; a
workspace build is not proof that an older registry artifact is compatible.

The root entry exports working-copy bootstrap, local mutation, synchronization,
conflict recovery and platform runtimes. These use the shared core engine and
IndexedDB backend, not a second document model. The narrower
`@superbee/browser-local/editor-recovery` entry exports the same editor-recovery
owner without importing the working-copy runtime.

See [editor recovery](EDITOR-RECOVERY.md) for draft/attempt persistence and
[conflict recovery](CONFLICT-RECOVERY.md) for explicit working-copy reconciliation.
Unsaved drafts, durable local commits and shared acknowledgements are different
states. Neither package installation nor a successful IndexedDB transaction means
a document was admitted into shared state.

In the default exact mode, a refusal about the content, or a busy refusal
(`BUSY_REFUSAL_CODES`), means the authority never applied the change, so a later
edit supersedes the refused request. An edit made while that request was in flight
waits on it instead; the next `push` folds the two. Both retire, and one fresh intent
carries the working document against the refused request's base. It is delivered in
the same run and listed in `PushReport.rebased`. A deletion of a create that never
landed retires both and journals nothing, since there is nothing to delete. A refusal
for lost permission or an exhausted request quota (core's
`AUTHORIZATION_REFUSAL_CODES`), a conflict and an edit that was ever sent are never
folded.

## Opt-in body delivery

`openLocalBundle(name, { bodyDelivery: { scope, okfVersion: "0.2" } })` selects
body-only delivery in a separate `body-v1` IndexedDB namespace. The default exact
document mode and its store remain unchanged. Supply a scope that partitions the
working copy appropriately; this label is not authorization. A custom journaled
backend must support `journalSnapshotCas` and be explicitly dedicated through
`bodyDelivery.dedicated: true`. Existing nonempty journals cannot be adopted.
There is no automatic migration, old-tab cutover or old-draft import. The same
logical name continues to select the existing push role.

Use `commitBodyLocal(local, id, { body, expectedVersion })`, or the existing platform
`commit`, after bootstrap. Both use the shared mutation engine and atomically retain
the local document and an immutable body intent. Pass a `BodyDeliveryTransport` as
`bodyTransport` to `push` or `createBrowserLocalRuntime`; the exact-document
transport is never substituted for it. A body-mode runtime may omit `transport`,
since body-mode push never calls it; a working copy in any other mode still needs
it, and a runtime built without it rejects its first `sync` rather than delivering
nothing. The authority owns the committed metadata
and returns the core prepared-body receipt contract. Original local journal bytes
remain unchanged when a receipt advances the shared base or visible document.
A newer local intent, even with identical bytes, prevents replacement of that edit.
Refreshes also bind content and deletion listings to full local premises captured
before fetching. A concurrent change invalidates stale incoming evidence; the
refresh rejects and its completion marker remains incomplete. Retrying performs a
new read rather than applying the old response against a newly captured guard.

Body mode is not a mirror of reserved root metadata. After mode admission, an absent
local root receives only a deterministic edition seed. An existing matching root,
including custom metadata and body, is preserved byte-for-byte. Each concept import
checks the authority's edition; malformed, unsupported or mismatched declarations
refuse rather than rewriting either root. A genuinely missing edition retains the
existing v0.1 fallback. Legacy bootstrap still imports the remote root unchanged.

Preparation is saved with the attempted claim before submission. After interruption,
the existing `reclaimInFlight` operation runs inside `pushWithRole` for body mode,
including normal platform Sync. The next delivery looks up the same immutable
identity before any resubmission. Callers using bare `push` own role and reclaim
coordination; the in-process role fallback does not coordinate separate realms.
`resume` schedules a lookup-first recheck while preserving refusal evidence. A
recorded refusal remains refused; resuming does not promise progress. Unresolved
or refused work is not reported as a successful complete synchronization.

The runtime admits at most two unsettled intents per target. It reserves missing
preparations, receipts and observations before accepting work: each envelope is
bounded at 4 MiB, original journal fields at 16 MiB, reconciliation at 32 MiB and the
complete guarded target at 64 MiB. JSON escape expansion and named metadata count: a commit
whose delivery cannot be prepared within its envelope (a body of control characters, each six
bytes once escaped) is refused before it is journaled.
The composite mode/control row has a 64 KiB bound with remaining growth reserved
per target. Capacity errors retain existing work and refuse new state; they do not
prune history or receipts.

Acknowledged history does not accumulate. After an acknowledgment, and before each local
commit, the runtime retires every acknowledged row of the target older than its newest
acknowledged row, with that row's descriptor, prepared envelope and receipt, in one guarded
transaction (`retireAcknowledged` on the journaled seam). The shared base already holds the
acknowledged content, a successor's proof reads only its immediate predecessor (the newest
acknowledged row, which stays), and receipt reconciliation reads only the settling row and
newer ones. Unsettled rows are never retired. Retirement is cleanup: a commit or settle never
depends on it, and one that fails is retried by the next. An adapter without
`retireAcknowledged` keeps its history, as before. `syncStatus` therefore counts at most one
acknowledged row per target.

A working copy written by this version cannot be read by an older one. An older library
refuses (fails closed on) a target whose newest acknowledged row names a retired predecessor,
and on any body, envelope or editor-recovery draft over its own smaller bounds; because its
status, refresh and pull read every target, one such target stops them for the whole store.
A host that ships this version should reload pages still running an older bundle, and must not
roll the browser library back past it without clearing the working copy.

Body input is bounded at 983,040 UTF-8 bytes, the library's ceiling. It matches the hosted
kernel's document write bound in raw bytes, but the host measures a write as canonical JSON
(newlines, quotes and backslashes count twice) and keeps definition documents (`conventions/`)
at 64 KiB, so a host preflights its own measure before committing. The existing document
codec owns metadata normalization, including valid timestamp values.

Body mode supports updates to existing documents, not creation or general metadata
edits. Conflict recovery accepts a chain whose head the authority answered with a
conflict or a content refusal (a refusal outside the authorization codes; lost
permission keeps the resume path). `take-remote` retires the chain and adopts the
served document, or deletes locally when the authority no longer holds it.
`keep-local` and `revise` retire the chain and journal one fresh body update at the
served head; they refuse when the authority holds nothing, since body mode cannot
create. Retired rows leave with their descriptors; a bounded receipt without content
is retained at `conflictResolutionKey(headRequestId)`. Nothing is sent by a
resolution. Legacy conflict resolution is unchanged. This mode does not install an
offline application shell or guarantee persistence against browser eviction. A
successful local commit, a queued delivery and authority confirmation remain
distinct states.

## Platform runtime host boundary

`createBrowserLocalRuntime({ local, remote, transport })` accepts an existing
`StorageBackend` for the authority's read side. A host may supply a plain structural
adapter; it need not construct or subclass `RemoteBackend`. The runtime does not
call the adapter's mutation methods. All identified shared writes and outcome
lookups belong to the separately injected `OperationTransport`; local commits still
use the journaled backend and core mutation engine.

| Platform operation | Browser-local behavior |
| --- | --- |
| `read`, `query`, `validate` | Read the working copy and report its provenance |
| `commit` | Update an existing document's body, preserving frontmatter under core mutation policy; persist the document and pending intent atomically |
| `sync` | Submit/lookup through the injected transport, then refresh through the read adapter |
| `syncStatus` | Report pending/conflict/refusal/completeness state, not blanket shared confirmation |
| Create, delete, frontmatter/model edits, conflict resolution, export, lifecycle | Not verbs of `PlatformRuntime`; lower-level primitives do not imply platform or hosted support |

Bootstrap is caller-owned. The existing optional structural trio `heads`, `snapshot`
and `wireCapabilities` enables the inventory protocol used by bootstrap/pull,
including bounded remote-deletion reconciliation. A bare `StorageBackend` can
bootstrap and refresh via list/read, but that fallback retains documents missing
from a later listing. It is **not** a deletion-complete SaaS synchronization contract.
The read-side type alone is not admission of an adapter's completeness, bounds or
authorization semantics.

The Node `test/platform-contract.test.ts` runs the same operation rows against the
wire backend and a structural read adapter with refusing mutation methods, including
lost acknowledgements, failures, conflicts and authorization refusal. It separately
checks bare-backend fallback and filesystem authorities whose shared tokens differ
from local tokens. A TypeScript-checker fixture proves structural construction;
the normal test loader alone does not typecheck test sources.

This seam is only the first host-contract step. Hosted inventory/outcome protocol
mapping, supported creation and lifecycle contracts, identity/lock ownership,
durable-editor cutover, offline shell compatibility and integrated browser acceptance
remain separate gates. It neither activates hosted local-first behavior nor supplies
a hosted transport. Hosts must not point the generic wire transport at editor-only
routes or convert a body update into an unrestricted document write.

Hosts own current authentication and authorization, account/workspace/bundle/
installation partitioning, transport adaptation, rendering and deployment policy.
Editor recovery requires real Web Locks, persists before returning prepared input,
retains unresolved attempts, and never sends or silently expires work. Browser
eviction and device-owner access remain limitations. No credentials belong in its
storage. Do not expose retained text before a current scope-bound authorized read;
write authorization is a separate prerequisite for retrying.

This package does not install a service worker, provide an offline application shell,
activate production storage, or configure hosted APIs. Release preparation and
publisher handoff are documented in repository `packages/browser-local/RELEASING.md`.
