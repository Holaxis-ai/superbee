# Runtime release-please compatibility proof

An offline, pinned experiment, not release automation. No root dependency, package
version, release workflow, tag, npm stage, approval, or repository setting is changed.
The prior spike was recorded on another host and was not committed; this is a
reconstruction of the outstanding shared-component experiment, not its original bytes.

## Run

From this directory, run `npm ci --ignore-scripts` once, then `npm test`. Installation
requires the public npm registry. Tests use release-please **17.11.2**, pinned with
integrity in this directory's lockfile. They use Node's test runner and the existing
dependency-free package preflight; a root build is not needed to execute the proof.

The fixture reads real manifests and the root lockfile from this checkout. It refuses
to silently reinterpret a core version other than the audited `0.2.0-pre.2` baseline.
To replay later, use this experiment's commit, not a moving main checkout. All generated
updates stay in memory; preflight writes only disposable temporary fixtures and removes
them. Repository source bytes are compared before and after.

The canned adapter implements upstream's SCM read interface and has no authenticated
client. Unknown operations throw. Its PR-creation sentinel throws before any provider
write; that sentinel measures eligibility only. Socket connection and global fetch are
blocked during the tests. This is a bounded test harness, not a general network sandbox
for arbitrary code. It does not test GitHub's real HTTP response parsing or bot credentials.

## Result: useful candidate builder, not activation-ready

The single Node component in `shared-config.json` is rooted at `packages/core`, named
`libraries`, and uses `/` as its tag separator. Explicit JSON extra-file updates keep
the server version, exact server-to-core dependency, and root lock records synchronized.
`skip-github-release` remains true. The tests run upstream's real configuration parser,
candidate generator, updaters, and PR-creation decision logic, not a reimplementation.

| Question | Observed result |
| --- | --- |
| Discover actual `libraries/v0.2.0-pre.2`, without a GitHub release object? | Yes, tag fallback stops at the released SHA; shipped changes are absent. |
| Propose pre.3 with exact pair and root lock agreement? | Yes. |
| Repeat generation against unchanged source? | Same proposed file bytes and PR body. This is candidate idempotence, not live PR deduplication. |
| After simulated merge/tag, avoid a duplicate with no new changes? | Yes. |
| Produce a second candidate pre.4 after another core fix? | Yes, without replaying pre.3 changes or inventing a GitHub release. |
| Actually permit the next PR after finalizer success? | No while the merged PR retains `autorelease: pending`. Upstream does not read the finalizer. |
| Remove that label and rely on upstream to wait for publication? | No. The PR-creation sentinel is reached with no publication evidence. |
| Cover server-only fixes through this core-rooted component? | No, those commits are outside its path. |
| Preserve renderer compatibility on a new prerelease? | No, unchanged exact prerelease opt-in fails the existing preflight. |
| Reject unmatched/malformed library tag history? | No. Tested unmatched tags fall back to manifest version and repeat shipped changes. |
| Reject malformed/divergent package references? | Existing Superbee preflight does; it is separate from release-please and must remain wired into any future proposal path. |
| Explicitly promote this prerelease to stable? | Setting prerelease false produces a 0.2.0 candidate; this does not execute or prove publication. |

The pending-state matrix covers merged/no tag, tagged/no stage, partial staging, both
staged, core-only approval, both packages visible with finalizer pending/failed, and
finalizer success. Except for tag presence these states have the **same SCM projection**:
release-please has no npm-stage or finalizer interface. All are held by the same pending
label, including the completed state. The matrix is evidence of the missing handoff,
not proof of an implemented publication gate. No pretend finalizer is added.

## Recommendation and next boundaries

Do not activate this configuration. The experiment is complete as a reproducible
incompatibility result, which the task explicitly permits. It does not reject every
possible release-please configuration.

Keep the existing manual version-PR and human-approved publishing route. If pursuing
release-please, the separately reviewed proposal-automation task must first resolve:

1. One component's commit scope covering both libraries without bumping the CLI or
   unrelated packages, and explicit renderer peer-policy handling without blindly
   replacing version-like strings.
2. A provider-native handoff tied to successful verification of the exact release,
   before clearing the pending label. Tag creation or registry visibility alone is
   insufficient. Label removal must not itself become publication authority.
3. Fail-closed bootstrap/tag-history validation and existing preflight integration.
4. Real bot PR CI, open-PR deduplication, credentials, conventional squash messages,
   and disposable-package rehearsal. None is established by this offline proof.

Do not add a release controller, GitHub release object, automatic npm approval, or
custom ledger to make the tests green. Restricted packages retain the separate controls
audit and package-specific proof; this experiment does not certify those packages.
Packed consumer proofs and existing release monotonicity/source checks stay authoritative.

## Upstream evidence

- [Pinned manifest documentation](https://github.com/googleapis/release-please/blob/v17.11.2/docs/manifest-releaser.md).
- [Manifest implementation](https://github.com/googleapis/release-please/blob/v17.11.2/src/manifest.ts):
  `backfillReleasesFromTags`, `buildPullRequests`, `createPullRequests`, and
  `findMergedReleasePullRequests` own the observed tag fallback and pending-label behavior.
- [Node strategy](https://github.com/googleapis/release-please/blob/v17.11.2/src/strategies/node.ts)
  and [generic JSON updater](https://github.com/googleapis/release-please/blob/v17.11.2/src/updaters/generic-json.ts).
