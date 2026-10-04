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

## Mutation attribution and local history

`mutateDocument` and `prepareDocumentMutationCandidate` persist a supplied `actor` by default:
`actor` in OKF v0.1, `superbee_updated_by` in v0.2 (plus `actor` when the Kind requires it).
Use `persistActor: false` to keep candidate attribution unchanged, or `persistActor: true` to apply
the attribution policy even without a supplied actor. An identical mutation remains a no-op and
preserves its original attribution and bytes. This default changes library writes that previously
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

## Release compatibility

This migration describes the source after the Windows extraction. Previously published versions
are unchanged. Consult the release notes for the first affected version before upgrading a pinned
consumer. CLI and engine version numbers are independent; do not infer matching embedded code from
package names or version labels.

[Source and contribution guide](https://github.com/Holaxis-ai/superbee)
