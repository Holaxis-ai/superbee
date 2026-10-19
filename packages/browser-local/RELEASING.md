# Browser-local release preparation and publisher handoff

This is a release-preparation contract, not permission to publish, approve npm stages,
push release tags, or deploy. The first section names the current candidate; the rest
is the durable process for every browser-local prerelease.

## Current candidate

| Package | Version | Access / channel |
| --- | --- | --- |
| @superbee/core | 0.2.0-pre.19 | public / next |
| @superbee/server | 0.2.0-pre.19 | public / next |
| @superbee/browser-local | 0.1.0-pre.16 | public / next |
| @superbee/markdown-renderer | 0.1.16 | existing restricted access / latest |

This candidate adds superbee#504 to the pre.18 source. Core exposes two opt-in,
browser-safe subpaths: `@superbee/core/builtin-recipes` provides the built-in recipe
catalog and file/loading helpers, and `@superbee/core/kind-authoring` provides shared
Kind inference, draft preparation, guarded apply and dismissal APIs. Core does not
install recipes automatically; CLI adapters now use these owning core APIs. See
`packages/core/README.md` for the entry points and usage contract. Server moves with
core with no source change.

The pre.18 compatibility changes remain: direct `mutateDocument` callers must pass
`bodyReplace` with the matching opt-in when a non-identical whole-body replacement
drops outbound links (`{ replaceLinks: true }`) or writes back a truncated body preview
(`{ acceptTruncatedBody: true }`), otherwise `BodyReplaceError` refuses it
(superbee#498). Any set, assignment or patch of a Kind-declared `string-list` or
`https-url-list` field is refused with `TypedListPatchError`; use `replace-all` or
`unset` (superbee#496). File-journal format 3, written when a blob claim is recorded
as not dispatched, remains unreadable by core pre.17 and older (superbee#497, #500).
The existing pre.18 staged artifacts retain their own source and approval gates;
this candidate neither replaces nor modifies those bytes.

Browser-local 0.1.0-pre.16 changes only its exact core pin from pre.18 to pre.19.
Renderer 0.1.16 changes only its core peer allowance, adding pre.19 while retaining
the existing alternatives. Neither package has a source change since the pre.18
preparation. Browser-local pre.14 and pre.15 were never published, so pre.16 also
carries the source changes since the published pre.13: push pauses persist when an
unknown outcome carries an authorization refusal, leaving the intent pending
(superbee#486); editor saves and reviewed conflict resolutions pass
`bodyReplace: { replaceLinks: true }` for deliberate link removal while still
refusing a truncated preview (superbee#498). Each needs a new version because
changed dependency or peer metadata produces different bytes. Their separate
publication remains optional.

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
