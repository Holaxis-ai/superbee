# @superbee/core

The Superbee knowledge engine reads and writes Open Knowledge Format bundles, with versioned
writes, cross-links and storage backends. It is a library; installing it does not install the
`superbee` executable.

Core and `@superbee/server` are released together, independently of the `superbee` CLI. A CLI
release bundles the engine source selected at build time; it does not load `@superbee/core@latest`.

## Document presentation values

The additive `@superbee/core/artifact-contract` subpath provides pure v1 document target,
observation, request, receipt and capability decoders. See the [contract reference](https://github.com/Holaxis-ai/superbee/blob/main/packages/core/ARTIFACT-CONTRACT.md)
for identity, provenance, lifecycle and host responsibilities.

## Site capabilities

The additive `@superbee/core/site-capabilities` subpath is the contract for read-only tools a
site or a recipe pack provides (`SiteCapability`), and the one owner of their composition rules:
`composeSiteCapabilities` refuses duplicate names, `superbee_` names outside the generic tier and
names outside a pack's or site's namespace, orders generic, pack and site tools deterministically,
applies a surface's exclusions after those checks, enforces size limits and, with
`requireReadOnly`, refuses any capability not declared read-only. It returns frozen snapshots and
an identity digest for the surface's list. `toProviderTool`, `toPortalAdditionalTool`,
`toToolDescriptor` and `siteCapabilityFromPortalTool` are the explicit mappings to the existing
tool shapes. `checkSiteCapability` and `siteCapabilityConformanceCases` test a capability against
recorded fixtures (read-only declaration, dated results, closed error codes that never echo input,
bounded and deterministic output, same-origin URLs, citations of records the result contains, and
refusal of unknown arguments). `siteRecordSource` mints a `site-record` citation only for a path
the host admits, bound to the publication's digests.

Annotations such as `readOnlyHint` and `untrustedContentHint` are self-declared and enforce
nothing at runtime; the checks above test recorded fixtures, not the code. Treat them as a control
only for in-process code from the same reviewed deploy. The module has no Node built-in import, so
it runs unchanged in a Worker or a browser.

## Mutation attribution and local history

`mutateDocument` and `prepareDocumentMutationCandidate` persist a supplied `actor` by default:
`actor` in OKF v0.1, `superbee_updated_by` in v0.2 (plus `actor` when the Kind requires it).
Use `persistActor: false` to keep candidate attribution unchanged, or `persistActor: true` to apply
the attribution policy even without a supplied actor. Supplying the actor option alone leaves an
otherwise unchanged candidate a no-op, preserving its original attribution and bytes. In v0.1,
deliberate edits to the candidate's legacy `actor` field still count as authored changes in `patch`
and `replace-document` modes; overwrite retains its automatic attribution comparison. The pure preview
prepares patches. This default changes library writes that previously
required `persistActor: true`; callers needing the old opt-in behavior can explicitly pass false.

`producer` controls `generated.by` independently of the version mutator. Local filesystem history
returns only the current revision, including for Git-tracked bundles. It reads mutation attribution
from `superbee_updated_by`, legacy `updated_by`, or `actor`; when absent it returns the stable string
`unattributed`. It does not infer an identity from the reader's environment or the content producer.
History-keeping backends retain their existing per-write attribution.

## Filesystem platform migration

The Windows extraction changes the default Node.js filesystem backend. Its built-in host policy
supports macOS and Linux. On native Windows or another unsupported host, filesystem construction
requires an explicit `FilesystemHostPolicy`; there is no automatic Windows fallback.

| Entry point | Default on macOS/Linux | On other hosts |
| --- | --- | --- |
| `new FilesystemBackend(root)` | Uses the built-in policy | Pass `{ hostPolicy }` as the second argument |
| `initBundle(root, options)` | Uses the built-in policy | Pass `{ hostPolicy }` as the third argument |
| `createFilesystemRuntime()` | Captures the built-in policy | Pass a host policy as its argument |
| `withFilesystemMutationLock(target, body, options)` | Uses the built-in policy | Include `hostPolicy` in `options` |
| `filesystemMutationLockPath(target, portableRoot)` | Uses the built-in policy | Pass a host policy as the third argument |

Without that policy, these filesystem entry points throw `InvalidInputError` on unsupported hosts;
backend construction and bundle initialization refuse before creating or modifying the target.
The package has no npm `os` restriction: storage contracts and non-filesystem backends remain
available independently of the default filesystem policy. Choose a backend and imports appropriate
to your runtime; installing the library alone does not establish native filesystem support.

There is no Windows adapter on npm to install. The experimental first-party adapters are built
from source in a separate repository, https://github.com/Holaxis-ai/superbee-windows-cli.
Supplying a policy is an integration contract for an adapter owner, not a promise that arbitrary
policies make Windows supported.

## Keep the backend returned by initBundle

`initBundle` now returns `{ root, backend }`. Pass that returned bundle to engine operations so they
retain the backend and host policy selected during initialization:

```ts
import { initBundle, readDoc, writeDoc } from '@superbee/core';

const bundle = await initBundle('./knowledge'); // Default filesystem: macOS/Linux.
await writeDoc(bundle, {
  id: 'notes/example',
  frontmatter: { type: 'Note', title: 'Example' },
  body: 'Shared knowledge.\n',
});
const document = await readDoc(bundle, 'notes/example');
```

Reading `bundle.root` still works. Code that assumes the return value has exactly one property,
serializes the whole return value, or uses backend presence as a synonym for a remote bundle must
be updated. A filesystem bundle now has a backend too. Serialize only the fields your application
intends to persist; do not reconstruct `{ root: bundle.root }` when continuing engine operations
that need the selected backend.

## Integrating an explicit filesystem policy

`@superbee/core/filesystem` exports `createFilesystemRuntime`, `FilesystemBackend`, and the
`FilesystemHostPolicy` type. An application that owns its host adapter can bind it once:

```ts
import { createFilesystemRuntime, type FilesystemHostPolicy } from '@superbee/core/filesystem';

export async function openFilesystemBundle(root: string, hostPolicy: FilesystemHostPolicy) {
  const filesystem = createFilesystemRuntime(hostPolicy);
  return filesystem.initBundle(root);
}
```

The resulting runtime supplies `backend`, `initBundle`, `withMutationLock`, and `mutationLockPath`
with the same captured policy. Direct backend construction uses
`new FilesystemBackend(root, { hostPolicy })`. Lock helpers are also exported from `@superbee/core`.

A policy supplies the lock-parent directory, owner-namespace key, private-mode enforcement choice,
and host error classifications. Core still owns lock ownership, version checks, retry bounds and
cleanup. Policies are structural snapshots: public data and methods are captured, while callbacks
may continue to observe live operating-system facts. Do not use opaque private fields or methods
pre-bound to a mutable receiver.

## Hosted client

`@superbee/core/hosted-client` is the headless client of a hosted Superbee's sync routes
(`/sync/v1`). It is a supported public API under core's normal versioning; the `superbee` CLI uses
it. It runs wherever `fetch` does (Node, a browser or a Worker) and reads identity (`whoami`),
the bundle list (`bundles`, with `readBundleListing`), documents (`reader`), document history
(`history`) and operations run by id (`listOperations`, `runOperation`). `within(slug)` returns
the same client naming every bundle-scoped request's bundle as `<slug>/<bundle-id>`.

```ts
import { bearerCredentials, createHostedClient } from "@superbee/core/hosted-client";

const client = createHostedClient({
  target: { origin: "https://mcp.getsuperbee.com", syncPrefix: "/sync/v1" },
  credentials: bearerCredentials(() => getToken()),
});
const identity = await client.whoami();
```

The target is the origin and the sync prefix: `/sync/v1`, or `/agents/<id>/sync/v1` for an agent
connection. `syncRoutePrefix({ origin, audience })` derives the prefix from a protected-resource
audience and returns null when the audience has none. `credentials` is the transport carrier's
own credential provider: an async function returning the headers for one request. It is called
before every request, so it may renew a short-lived token. `bearerCredentials` builds one from a
token getter. The client never logs credentials, and its errors carry the route and code, never a
token.

Failures are typed and carry no wording for any particular surface:

- `HostedCarrierError`: transport. `denied` means no credential (nothing was sent) or the request
  was refused before sending; `unavailable` means the answer is unknown. `isAnswerTooLarge`
  distinguishes an answer larger than its bound.
- `MalformedAnswer` (`code` `MALFORMED_ANSWER`, `route`): the host answered something the
  contract does not admit. Retrying gets the same answer.
- `RemoteError` (`code`, `status`): the host refused the request, with its own code.
- `HostedRouteNotServed` (`code` `ROUTE_NOT_SERVED`, status 404, `route`): a `RemoteError` for a
  host from before the route.

Operation and history refusals the host states in a `200` (and `bundle_not_found`,
`unknown_operation` and `invalid_input`) come back as `{ ok: false, refusal }`, not as errors.

## Release compatibility

This migration describes the source after the Windows extraction. Previously published versions
are unchanged. Consult the release notes for the first affected version before upgrading a pinned
consumer. CLI and engine version numbers are independent; do not infer matching embedded code from
package names or version labels.

[Source and contribution guide](https://github.com/Holaxis-ai/superbee)

### Node portable export boundary

`@superbee/core/portable-export` (also bundled as `superbee/portable-export`) exposes the same
store-only archive verifier used by the CLI: `verifyExport`, `ExportPageChain` and
`joinExportPages`. The page chain charges the sum of complete ZIP sizes, including manifests
and headers, against `MAX_EXPORT_BYTES` before retaining a page; returned `bytes` counts only
stored bundle content. It performs no acquisition, sign-in or network access. A complete accepted
handle can be passed to `materializeExport(handle, existingPrivateParent)` to create a fresh
private directory; callers own its cleanup and isolation while publishing. No target is replaced.
`exportProvenance(handle)` returns exact ordered raw-manifest SHA-256/size evidence plus a combined
inventory SHA-256. Keep that evidence outside the directory and private when it identifies a
private source. Handles cannot be reconstructed from JSON or moved between independently bundled
module instances; modified handles are refused. This surface requires Node, not a browser or Worker.
