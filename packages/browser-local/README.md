# @superbee/browser-local

Shared browser-local working-copy and editor-recovery primitives for Superbee hosts.
This prerelease requires exactly `@superbee/core@0.2.0-pre.3`. Published core pre.2
lacks the atomic journal-resolution APIs used by this package; a workspace build is
not proof that the older registry artifact is compatible.

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
transport is never substituted for it. The authority owns the committed metadata
and returns the core prepared-body receipt contract. Original local journal bytes
remain unchanged when a receipt advances the shared base or visible document.
A newer local intent, even with identical bytes, prevents replacement of that edit.

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
bounded at 2 MiB, original journal fields at 8 MiB, reconciliation at 16 MiB and the
complete guarded target at 32 MiB. JSON escape expansion and named metadata count.
The composite mode/control row has a 64 KiB bound with remaining growth reserved
per target. Capacity errors retain existing work and refuse new state; they do not
prune history or receipts. Body input is bounded at 64 KiB. The existing document
codec owns metadata normalization, including valid timestamp values.

Body mode supports updates to existing documents, not creation or general metadata
edits. Conflict inspection is available, but all conflict-resolution choices refuse
without mutation: inspect or export retained work; no automatic recovery is
performed. Legacy conflict resolution is unchanged. This mode does not install an
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
