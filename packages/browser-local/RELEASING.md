# Browser-local initial prerelease handoff

This is a release-preparation contract, not permission to publish, approve npm stages,
push release tags, or deploy. The initial candidate is:

| Package | Version | Access / channel |
| --- | --- | --- |
| @superbee/core | 0.2.0-pre.3 | public / next |
| @superbee/server | 0.2.0-pre.3 | public / next |
| @superbee/browser-local | 0.1.0-pre.1 | public / next |
| @superbee/markdown-renderer | 0.1.1 | existing restricted access / latest |

Browser-local depends exactly on core pre.3. Registry pre.2 lacks
`assertJournalSnapshot` and atomic journal resolution; do not patch around it or
publish with a wildcard dependency. Server moves with core under the existing paired
release policy. Renderer 0.1.1 only extends its core peer allowance to pre.3; it is
included so hosted consumers can align their root core without overriding peer
checks. Its access remains restricted: do not make other private packages public.

## Before release

1. Review and merge the preparation PR. Record the actual merged source SHA. Require
   green `CI required lanes` and the relevant security verdicts on that exact source,
   not merely the PR head. Refresh npm versions and dist-tags read-only; if a candidate
   already exists, compare its manifest/artifacts and stop on divergence. Never overwrite
   or reuse a published version for different bytes.
2. Obtain the maintainer's release authorization. For core/server, use the existing
   `.github/workflows/release-libraries.yml` and
   `release-libraries-finalize.yml` process from the current-main
   `libraries/v0.2.0-pre.3` tag. That workflow builds and retains exact tarballs,
   attests them, and stages each package separately. Human npm approval remains
   required. Do not independently rebuild/publish replacement core/server tarballs.
3. Complete the existing read-only core/server registry finalizer. Verify both exact
   versions and the `next` channel before browser-local publication.

## Browser-local and renderer artifacts

There is no browser-local release workflow in this PR. The first package may require
human namespace/bootstrap setup; npm access alone is not proof of that permission.
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
scratch consumer against **registry** core pre.3, not a workspace link or substituted
local core. Verify root and editor-recovery entry loading, TypeScript declarations,
browser bundling and the draft/prepare/reopen behavior. The repository's external
proof uses the literal candidate core/browser pair before publication; this registry
check is additional release evidence. Renderer must likewise pass its external
consumer proof and exact pre.3 peer compatibility before its separate publication.

Only the authorized publishing agent/maintainer may publish the approved literal
tarballs, with explicit access and dist-tag from the table and any required interactive
human approval. The browser-local workspace `prepublishOnly` refusal prevents an
accidental workspace publish; bypassing it is appropriate only for the separately
approved literal artifact (not an unreviewed workspace rebuild). It is an ergonomics
guard, not a security boundary. No npm credentials are supplied by this PR.

After each publication, anonymously retrieve the public package (authenticated retrieval
for the still-private renderer), compare registry integrity and downloaded bytes with the
approved tarball, inspect dependency/peer metadata, and confirm its intended dist-tag.
Record evidence in the existing Superbee Release/Task records. These manual bootstrap
artifacts do not automatically gain the core/server workflow's attestations; do not
claim otherwise. Configure a future repeatable browser-local release workflow separately.

## Hosted integration handoff

After artifact verification, make a separate hosted PR pinning browser-local pre.1,
core/server pre.3 and renderer 0.1.1 in the applicable manifests and lockfiles. Verify a
clean install without peer overrides or local tarball paths. Preserve credentials for
remaining private packages. Do not change other private package access.

Wire existing editor recovery through the shared component, not copied persistence
code. Use hosted PR285's account binding, plus workspace/bundle/installation/registration
scope, and require a current scope-bound authorized read before revealing retained text.
Read-only users may inspect/copy recovered work; retry needs current write permission.
Persist original input and request identity before sending, preserve newer drafts on
settlement, and never discard an unresolved attempt as though it cancelled remote work.
Logout closes access/sync without silently deleting drafts; approved retention has no
automatic expiry, with device/eviction limitations disclosed.

Complete actual in-app editor journeys: edit, interrupted response, close/reload,
restore/retry, newer draft preservation, two tabs, account switch, read-only downgrade,
revocation and storage refusal. Follow independent review, ordered adversarial QA and
green CI before merge. Package publication alone does not complete those journeys.
Production activation, migrations and offline-shell rollout are separate permissions.
