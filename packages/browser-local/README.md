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
