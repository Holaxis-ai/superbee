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
