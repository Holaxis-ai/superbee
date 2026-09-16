# Scoped editor recovery

`withEditorRecovery(scope, { backend, locks }, callback)` retains unsaved editor bodies and
prepared body-only save requests in the existing `JournaledBackend` metadata store. It does not
write a bundle document or intent, send a request, or claim shared confirmation. The package
entrypoint exports the function, types, `editorRecoveryKey`, limits, and typed errors.

The authenticated host supplies endpoint, principal scope, workspace, bundle, installation, and
registration scope. These labels partition storage; they are not credentials or authorization.
The endpoint is a canonical HTTP(S) URL without credentials, query or fragment. The fixed tuple
owns both the hashed metadata key and Web Lock name. Every host sharing that backend must use this
primitive for the envelope. No in-process lock fallback is permitted: unavailable locks return
`{ held: false, reason: "locks-unavailable" }`; a competing tab returns `held-elsewhere`.

The host must establish current read access before opening or restoring work, end the callback on
logout/account change/access loss, and independently establish current write access before retrying
any prepared request. Retention has no automatic expiry. Ending access does not delete retained
work. Browser eviction can lose data, and a device owner can access local storage; this component
does not encrypt or guarantee backup. Production activation and package publication are separate.

Within the callback:

- `read(documentId)` returns a detached slot or `null`.
- `saveDraft(documentId, { base: { version, body }, body }, expectedRevision)` saves under draft
  compare-and-swap. Use `null` only to create a missing slot. Revisions are positive safe integers
  allocated across the envelope, including after discard/recreate. A save preserves any pending
  attempt and the latest confirmation.
- `prepare(documentId, { requestId }, expectedRevision)` copies the stored draft body and base
  version into one immutable pending request and persists it before returning. Supply a fresh
  lowercase UUIDv4; retries use the retained identity and bytes, never a new `prepare`. An existing
  pending attempt refuses replacement. The returned request has fixed `diagnosticsVersion: 1`.
- `settle(documentId, requestId, outcome)` accepts only `{ kind: "committed", version }` or
  `{ kind: "refused" }` for the matching pending identity. It removes that attempt and records
  confirmation, preserving draft body, base, and revision even when edits occurred during dispatch.
  A host with an unknown outcome must retain the attempt and must not call `settle`.
- `discardDraft(documentId, expectedRevision)` removes only that slot, and refuses while any
  attempt remains unresolved. Local discard is not remote cancellation.

The writer role spans the whole callback. Operations serialize; entered operations drain before
release on callback return or throw, and escaped handles reject after closure. Capture inputs
before scheduling an operation; the primitive detaches them synchronously before its first wait.
All recovery outputs are detached. A storage write failure poisons the session and makes the outer
call reject: reopen under the writer role to read durable state before continuing. This also
protects a write whose completion became uncertain.

Schema version 1 is one strict metadata envelope, bounded to 32 documents, 2 MiB of UTF-8 JSON,
and 64 KiB of UTF-8 for each body (including base and pending bodies). Capacity and quota failures
never evict another draft. Foreign, corrupt, and unsupported envelopes fail closed without reset;
there is no migration, expiry, purge, or force-discard API.
