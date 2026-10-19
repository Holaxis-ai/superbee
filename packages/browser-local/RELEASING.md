# Browser-local release preparation and publisher handoff

This is a release-preparation contract, not permission to publish, approve npm stages,
push release tags, or deploy. The first section names the current candidate; the rest
is the durable process for every browser-local prerelease.

## Current candidate

| Package | Version | Intended access / channel | Preparation status |
| --- | --- | --- | --- |
| @superbee/core | 0.2.0-pre.21 | public / next | Native release candidate; unpublished |
| @superbee/server | 0.2.0-pre.21 | public / next | Native release candidate; unpublished |
| @superbee/browser-local | 0.1.0-pre.18 | public / next | Source alignment only; publication deferred |
| @superbee/markdown-renderer | 0.1.18 | existing restricted access / latest | Source alignment only; publication deferred |

This preparation carries recipe field-description upgrades, actor-aware installation
and ownership-proven Reference evolution in core. The separately versioned public
`superbee` executable candidate is 0.4.3-pre.11. Source preparation does not authorize
release tags, staged publication, human npm approval or downstream adoption.

Browser-local 0.1.0-pre.18 changes only its exact core dependency from pre.20 to
pre.21. Keeping the workspace pair aligned avoids a fresh install resolving a nested
older core and splitting shared error identities. Renderer 0.1.18 adds exact core
pre.21 peer compatibility while retaining its existing alternatives and restricted
access. Neither package changes product source in this preparation. Both packages
are unpublished, and their separate artifact approval/publication procedures below
remain deferred. Their publication is not required for the public Core API or the
self-contained executable release.

## Before release

1. Review and merge the preparation PR. Record the actual merged source SHA. Require
   green `CI required lanes` and the relevant security verdicts on that exact source,
   not merely the PR head. Refresh npm versions and dist-tags read-only; if a candidate
   already exists, compare its manifest/artifacts and stop on divergence. Never overwrite
   or reuse a published version for different bytes.
2. Obtain the maintainer's release authorization. For core/server, use the existing
   `.github/workflows/release-libraries.yml` and
   `release-libraries-finalize.yml` process from the current-main
   `libraries/v<version>` tag for the table's core version. That workflow builds and
   retains exact tarballs, attests them, and stages each package separately. Human npm
   approval remains required. Do not independently rebuild/publish replacement
   core/server tarballs.
3. Complete the existing read-only core/server registry finalizer. Verify both exact
   versions and the `next` channel before browser-local publication.

## Browser-local and renderer artifacts

There is no browser-local release workflow; browser-local and the renderer are
published by hand from approved literal tarballs. Repository access is not npm
publish access, and npm access alone is not proof of maintainer authorization.
Use a clean checkout of the reviewed merged source. Run `npm ci`, root build and
typecheck, then the external packed consumer proof in `npm run test:scripts` and the
browser-local tests. Do not skip checks to use workspace-linked dependencies as a
substitute for the installed artifact proof.

Pack the built browser-local and renderer workspaces once into a fresh artifact
directory, preserving npm JSON receipts. Record source SHA, package names/versions,
tarball SHA-256 and npm integrity values. Inspect allowlists and ensure no source,
tests, credentials or local paths are included unexpectedly. Do not rebuild or repack
between artifact approval and publication.

Before publishing browser-local, install its literal candidate tarball into an external
scratch consumer against **registry** core at the table's version, not a workspace link
or substituted local core. Verify root and editor-recovery entry loading, TypeScript
declarations, browser bundling and the draft/prepare/reopen behavior. The repository's
external proof uses the literal candidate core/browser pair before publication; this
registry check is additional release evidence. Renderer must likewise pass its external
consumer proof and exact peer compatibility with the table's core version before its
separate publication.

Only the authorized publishing agent/maintainer may publish the approved literal
tarballs, with explicit access and dist-tag from the table and any required interactive
human approval. The browser-local workspace `prepublishOnly` refusal prevents an
accidental workspace publish; bypassing it is appropriate only for the separately
approved literal artifact (not an unreviewed workspace rebuild). It is an ergonomics
guard, not a security boundary. No npm credentials are supplied by the preparation.

After each publication, anonymously retrieve the public package (authenticated retrieval
for the still-private renderer), compare registry integrity and downloaded bytes with the
approved tarball, inspect dependency/peer metadata, and confirm its intended dist-tag.
npm also assigned `latest` to browser-local on its first publication, and the registry
refused an attempt to remove that tag; `latest` therefore points at the first prerelease
until a stable version exists. Consumers pin exact prerelease versions; do not republish
to repair a tag. Record evidence in the project bundle's Release record. These manual
artifacts do not automatically gain the core/server workflow's attestations; do not
claim otherwise. Configure a future repeatable browser-local release workflow
separately.

## Consumer repin

After artifact verification, make a separate consumer change pinning the table's exact
versions in the applicable manifests, every lockfile (root and nested), and any peer
range that lists exact core prereleases. Verify a clean install without peer overrides or
local tarball paths. Preserve credentials for remaining private packages. Do not change
other private package access.

Package publication does not complete a consumer's integration: independent review,
ordered adversarial QA, green CI and real in-app journeys follow in the consumer.
Production activation, migrations and offline-shell rollout are separate permissions.
