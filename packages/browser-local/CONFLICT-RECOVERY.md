# Explicit conflict recovery

The shared runtime exports `inspectConflict` and `resolveConflict`. They accept an opened local
bundle or any `JournaledBackend`, plus the same authenticated remote used by synchronization.
There is no separate UI mutation engine and neither operation sends a remote write.

1. Inspect a conflicted document. Present its original base, latest local content (including
   later dependent edits), and freshly fetched shared content. A null version means known absence;
   a non-null base version with null content means the original content is unavailable.
2. Pass that review back with `keep-local`, `take-remote`, or `revise` (body and optional
   frontmatter). Keep/revise run the ordinary mutation engine and record a fresh pending request
   against the reviewed shared version. Take-remote adopts the served snapshot, including explicit
   deletion, without sending a write.
3. If the review is stale, inspect again. Do not automatically retry a human choice against new
   content. Network or authorization failure is not a deletion and leaves the conflict intact.
4. Continue normal push/sync. A later shared edit can still cause a new conflict; no unseen shared
   head is overwritten. A local resolution is not a shared acknowledgement.

Resolution compares the document version and complete unsettled journal atomically with the
document, base, recovery receipt and replacement intent. It refuses possibly delivered pending,
unknown or in-flight work until its outcome is reconciled. Only one dependent edit chain whose
latest bytes match the document can be resolved. Two tabs cannot both resolve the same review.

The returned receipt retains the reviewed base/local/remote data and original intents in meta at
`conflictResolutionKey(receipt.id)`, in the same transaction. The receipt id is the original
conflicted request id, so a caller can find it even if the resolution reply was lost. Receipts are not pruned by this API.
They survive reload with the working copy but are not a backup against browser eviction. Hosts
must scope stores and remote access correctly; this API does not add account or retention policy.

This is shared runtime support, not activation of the browser-first SaaS editor. Hosted wire,
authentication, UI integration, offline shell, release and deployment remain separate work.
