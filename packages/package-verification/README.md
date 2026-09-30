# Package verification primitives

This dependency-free private workspace owns build-time package proof mechanics shared by Superbee,
Docs, and Portal. It is not published, bundled into a product, or registered in a release inventory.

`src/harness.mjs` owns disposable workspace cleanup, explicit closed environments, bounded subprocess
execution, exact artifact integrity, and comparison with consumer-supplied identity expectations.
`src/no-network.mjs` is a Node preload denying fetch and built-in HTTP/socket calls. This is a
credential-free cooperative test boundary, not an operating-system sandbox for malicious programs.
Consumers own their command assertions, fixtures, npm installation, source/release selection,
approvals, and receipts. Returned child output is transient test input, not publication evidence.

`src/preflight.mjs` selects exact direct registry dependencies at the nearest workspace lock location,
optionally includes locked packages in selected scopes, and validates metadata with at most three
concurrent reads. Workspace links require a matching supplied manifest. Replacements are keyed by
package name and supplied explicitly by consumers. Preflight reads existing npm access; it never
changes credentials, npm configuration, dependencies, or docs. It may populate npm's normal metadata
cache. It proves selected metadata access and expected fields, not all downloads; clean installation
and retained-artifact proofs remain required.

Locked registry rows require both tarball URL and integrity. A consumer may explicitly permit a
named version-only row with `allowMetadataOnly`; the result reports those limited metadata checks.
Conflicting locked identities for the same exact package version fail rather than silently dedupe.

## Consumer snapshots

Preflight must run before dependencies exist. Docs and Portal therefore import an explicitly
generated source snapshot rather than an unpublished registry dependency. Its fixed allowlist,
canonical repository, exact producer commit, and file digests are recorded in `snapshot.json`.
Consumers must not edit those files independently. Refresh from a clean exact producer checkout:

```bash
node packages/package-verification/export.mjs --source . --target <consumer>/scripts/vendor/package-verification --commit <exact-sha>
node packages/package-verification/export.mjs --source . --target <consumer>/scripts/vendor/package-verification --commit <new-sha> --expected <old-sha>
node packages/package-verification/export.mjs --source . --target <consumer>/scripts/vendor/package-verification --check
```

The exporter refuses unmanaged targets, stale expected commits, symlinks, dirty source, and source
overlap. It stages complete verified bytes under a writer lock, replaces only the intact expected
snapshot, and restores the previous target on replacement failure. It writes no workstation paths
or runtime state into snapshots. A later refresh requires an explicit reviewed consumer change.
Both the new and previous pinned commits must be present in the producer's Git objects when
refreshing; missing old objects block replacement, rather than trusting the old digest label.

`verifySnapshotIntegrity` proves local bytes and inventory only. `verifySnapshotProvenance` compares
those bytes against actual Git objects in the canonical producer repository at the pinned commit.
Consumer CI performs that comparison before installation; a digest record and SHA label alone are
not source provenance. No package publication or new release authority is needed for this delivery.
