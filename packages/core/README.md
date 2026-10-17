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

## Recipe lifecycle

`@superbee/core/recipe-lifecycle` installs and evolves a parsed recipe on any bundle. The caller
acquires the recipe (`parseRecipeFiles` from `@superbee/core/recipes` turns files into a
`LoadedRecipe`) and presents the results; the `superbee` CLI is one such caller. It uses no Node
globals or builtins, so it runs in Node, a browser or a Worker over any storage backend.

```ts
import { MemoryBackend } from "@superbee/core/memory-backend";
import { parseRecipeFiles } from "@superbee/core/recipes";
import { applyRecipeEvolution, installRecipe, planRecipeEvolution } from "@superbee/core/recipe-lifecycle";

const bundle = { root: "memory://glossary", backend: new MemoryBackend() };
const v1 = parseRecipeFiles(glossaryV1Files, "memory:glossary@1");
if (!v1.ok) throw new Error(v1.error.message);
await installRecipe(bundle, v1.recipe);

const v2 = parseRecipeFiles(glossaryV2Files, "memory:glossary@2");
if (!v2.ok) throw new Error(v2.error.message);
const plan = await planRecipeEvolution(bundle, v2.recipe);
if (plan.ready && plan.writes > 0) {
  await applyRecipeEvolution(bundle, v2.recipe, plan.plan_token, { actor: "process:glossary-sync" });
}
```

`installRecipe` is create-only: each convention, View pair and Reference is written with an
expect-absent compare-and-swap, an existing convention is left untouched (its row reports
`source_differs` when it differs from the recipe), and a differing View or Reference target is
refused before anything is written. `planRecipeEvolution` is read-only: it merges each recipe
convention into the installed one additively, rechecks existing instances, and returns blockers
and a `plan_token` bound to everything it read. `applyRecipeEvolution` recomputes the plan,
refuses a different token, and writes each changed convention at exactly the version the plan
saw. The bundle has no cross-document transaction, so a failure part way reports the definitions
written and those still pending.

Every convention either path writes carries an `x_recipe` stamp in the same write: the recipe's
id, version, declared convention count (`of`), `recipeSourceDigest` of the recipe, the
`definitionDigest` of the convention as written, and the `digest_rules` version. A plan's
`changed` is about content only; its `writes` also counts conventions whose stamp is stale or
missing, so a ready plan with `writes > 0` has work to apply. `installedRecipes(conventions,
known?)` reads each recipe's state (`installed`, `partial`, `diverged`, `unknown`) from the stamps
alone, without the recipe source.

Failures are typed subclasses of `RecipeLifecycleError`: `RecipeInputError` (the recipe cannot
target this bundle's edition), `RecipeAssetConflict` (`recipe`, `key`), `RecipeEditionChanged`,
`RecipeEvolutionPlanChanged` (`expected`, `current`), `RecipeEvolutionBlocked` (`blockers`),
`RecipeEvolutionInterrupted` (`reason`, `completed`, `pending`, `cause`) and
`RecipeEvolutionPostcondition` (`reason`, `completed`).

## Record overlay

`@superbee/core/record-overlay` is the write half of binding documents to external records. A
Source Feed policy names the fields a feed owns; the caller fetches and diffs its records and hands
the changes to the planner. It uses no Node globals or builtins, so it runs in Node, a browser or a
Worker over any storage backend.

```ts
import { MemoryBackend } from "@superbee/core/memory-backend";
import { buildKindRegistry } from "@superbee/core/kinds";
import { applyRecordOverlay, buildSourceIndex, planRecordOverlay, readOverlayPolicy } from "@superbee/core/record-overlay";

const bundle = { root: "memory://guide", backend: new MemoryBackend() };
const registry = buildKindRegistry(conventionDocs);
const guide = { bundle, registry, okfVersion: "0.2" as const };
const policy = readOverlayPolicy(sourceFeedDoc, { targetKind: registry.kinds.get("Event") });
const overlays = await buildSourceIndex(bundle, { type: policy.target_kind });
const plan = await planRecordOverlay({ content: guide, ops: guide, policy, changes, observedAt, overlays });
const receipt = await applyRecordOverlay(plan, { content: guide, ops: guide, policy, actor: "process:calendar-sync", overlays });
```

For each owned field the plan compares the last accepted feed value, the new feed value and the
document's value: a document that already says the new value is left alone, one that still says
the old value is written, and anything else is an `OVERLAY_DOC_CONFLICT` with a Signal, so an
editor's override is never overwritten. Each step carries the version it was planned against.
`applyRecordOverlay` writes every step through `mutateDocument` with a guard core builds itself and
runs on the fresh read: an owned-field write reaches documents of the policy's target Kind only,
may change only owned and derived fields, never the body, and needs the record's `sources`
identity; a Signal may be created only as a new, unclaimed document of the attention Kind under its
path, and updated only in a fixed set of fields plus one appended observation line. Signal writes
are bound to the provider of the policy the caller passes, never to a field of the plan, and an id
held by another provider's Signal is refused. A Signal's text must be the planner's rendering of
its own fields and the run (its observation line, links to the plan's feed and to documents, the
adoption hint): every plan the planner makes passes, and other text is a held `INVALID_INPUT` row,
so a mismatch is visible and planned again rather than dropped. Nothing of the
target Kind is created and nothing is deleted. A feed never owns its target's work state: the
progress storage fields and the target Kind's claim fields are refused like `status`. The
attention Kind (default `Signal`) must declare a claim owner and state field and the fields
`change_kind`, `observed_at`, `provider`, `external_id` and `diff_summary`.

Site rules are hooks with safe defaults: `textGate` (identity), `interval` (none, so a disappeared
record is always raised), `correlate`, `sourceProperties` (an upsert of the record's `sources`
entry in the same write, OKF v0.2 only), `assertCandidate` (site candidate checks after the core
guards) and `deriveFields` (fields such as `updated_at` written in the same version). Refusals are
receipt rows with a `REFUSAL_CODES` code; `RETRYABLE` and `HOLD_STORE` say which leave a record to be
planned again. A value core's write policy refuses (an OKF v0.2 field type, for example) is a held
`INVALID_INPUT` row, so one bad record never stops the rest of a run. A malformed plan (an unknown
step, a non-canonical target, written values that are not JSON data with finite numbers, prototype
keys, non-scalar or identity `sources` properties), actor or bundle edition throws `OverlayRefusal`
before any write, and so does a plan with owned-field steps whose policy names no declared target
Kind or whose owned or derived list names a field a feed can never own.

`SourceIndex` holds one head read for a whole run. It is bounded to that run: an edited or deleted
overlay is still caught at write time, but a second document given an identity during the run is
only refused as ambiguous on the next run.

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

### Writing a document

`write` sends one whole serialized document (frontmatter and body, as a file holds it) to a hosted
bundle: a create of an absent id, or a replace at exactly the version the caller read.

```ts
const created = await client.write("notes", { id: "notes/today", document: text, expectAbsent: true });
const replaced = await client.write("notes", { id: "notes/today", document: edited, expectedVersion: version });
```

It returns one of:

- `{ status: "committed", version }`: the host stored it; `version` is the new head.
- `{ status: "conflict", reason: "version_conflict", currentVersion }`: the document is not at the
  expected version (for a create: it exists). `currentVersion` is the version the host serves, or
  null when it serves none. Nothing was written.
- `{ status: "conflict", reason: "concurrent_change" }`: another write to the bundle overlapped
  this one past the host's own retries. Nothing was written.
- `{ status: "refused", code, message }`: the host refused this write (`validation_failed`,
  `invalid_input`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, a sync quota's `REQUEST_CAPACITY_*`, or
  `read_only` when the bundle serves no writes). Nothing was written.
- `{ status: "unknown", requestId }`: the host may or may not hold the write.

Every result names its `requestId`. A conflict is final for that identity: the client never
resends it, under that identity or a new one. Read the document and decide; another attempt is a
new `write`.

A write needs the bundle's capabilities (whether it serves writes, its OKF edition, the write
bound and the retention window). The client reads them once per bundle and workspace and holds the
answer for `capabilitiesTtlMs` (default 60,000 ms), shared by the client and its `within` clients
and never by `reader()`. So a write costs one round trip while its bundle's capabilities are fresh,
and two when they are read first; concurrent writes to one bundle share one read. A write refused
`read_only`, `invalid_input`, `validation_failed` or `PERMISSION_DENIED` (which is how a
`bundle_not_found` write answer arrives), or whose result is `unknown`, drops the held answer, and
a capabilities read that fails is never held, so the next write reads them again. Set
`capabilitiesTtlMs: 0` to read them before every write. The retention window that decides a
resend after an `absent` lookup (below) is never taken from a held answer: it is read again then.

Each write has one request identity and carries the client's binding, a digest of a random id the
client mints once (its `within` clients share it). When an answer is lost (a transport failure or
a deadline after sending), the client looks the identity up on the host and reports what the host
recorded. The host's outcome route tells a request it never received ("absent") from one still in
progress ("pending"), and the shared transport keeps the two apart. On either answer `write`
sends the same identity once more, which the host applies at most once; after "pending", an
earlier delivery is known to be held. Absence counts as
evidence only within the retention window the host serves in its capabilities
(`operationsRetentionMs`, less an hour's margin); past it, the result stays `unknown` and nothing
is resent. The client measures an intent's age by its own clock against the host's window, so that
margin holds only while the client's clock is within an hour of the host's. A resend refused before
it reaches the host's execution (no credential, access withdrawn, a spent quota) leaves the result
`unknown` too, since the first delivery may still commit; after a "pending" lookup, so does any
refusal before execution, a gateway's `400` included. The result's `refusal` (`{ code, message }`)
names that refusal, so an app can say why the write is waiting (for example, access withdrawn)
while it stays held; only the call that met the refusal reports it. Absence alone never settles
such a write: a delayed first delivery is authorized when it arrives, so it can still commit once
access returns. When the lookups themselves fail, or the caller's `signal` aborts after sending, the
result is `unknown`.

An `unknown` write can be resolved later in two ways:

- `lookupWrite(requestId)` makes one outcome lookup and never sends the write. When the host holds
  no outcome yet (absent or pending), the answer stays `unknown`.
- `settleWrite(requestId)` looks the identity up and, when the host never recorded it within its
  retention window or holds it pending, sends the same identity once more, as `write` would have.

Both answer `{ status: "unrecorded", requestId }` when the intent store holds no write under that
identity: it was never recorded there, or it already settled and left the store. Both return
`unknown` when the bundle's capabilities cannot be read, because the write may already have left.
`settleWrite` only looks up, sending nothing, when the host serves the bundle no writes. A
`signal` already aborted when `write`, `lookupWrite` or `settleWrite` is called is thrown as its
reason before any request; an abort during delivery leaves the write `unknown` and held.
`write` instead throws that failure, because it has sent nothing yet.

Until it settles, a write is held in an intent store: its operation, bundle (and workspace),
document id, document and digest, expected version, request identity and binding, which is
everything needed to rebuild the lookup exactly. The default store is in memory and lives as long
as the client. Pass `intentStore` (`put`, `get`, `delete`, and optionally `list`) to keep intents
durable across restarts; lookups use the binding recorded with each intent. A service that
restarts with a durable store calls `heldWrites()` to find the writes that never settled
(including any recorded but never sent), then settles each with `settleWrite`. `heldWrites()`
throws `HostedIntentsNotListable` when the store has no `list`. A settled write leaves the store.

`write(..., { requestId })` with the identity of a held write resumes that write and applies
nothing new. A different write under a held identity, including the same write named in another
workspace, is refused before sending. The host refuses an identity it recorded for another
document (`invalid_input`). Calls on one client that name the same identity run one after another.

`write` throws only before anything is sent: a malformed input (`TypeError`), the typed error of
its capabilities read, or a failure of the intent store to record the write. Document deletion is
not part of `write`.

### Export download (Node only)

`@superbee/core/hosted-client/node` downloads and verifies a hosted bundle's portable export. It
is a supported public API under the same versioning. It is Node-only because verification
(`@superbee/core/portable-export`) needs Node; `@superbee/core/hosted-client` never imports it,
so the client itself stays browser-safe.

```ts
import { bearerCredentials, createHostedClient } from "@superbee/core/hosted-client";
import { downloadExport, EXPORT_WINDOW_MS } from "@superbee/core/hosted-client/node";
import { materializeExport } from "@superbee/core/portable-export";

const client = createHostedClient({ target, credentials: bearerCredentials(getToken), deadlineMs: EXPORT_WINDOW_MS });
const verified = await downloadExport(client, "team.notes", { signal });
const folder = await materializeExport(verified, parentDirectory);
```

`downloadExport(client, bundleId, { signal })` returns a `VerifiedExport`: every document,
reserved file and blob at the bundle's latest confirmed revision, read whole and checked against
the host's digest manifests. It writes nothing. A stopped, tampered or oversized export never
becomes a result; placing the files is the caller's (`materializeExport`, or its own staging). It
reads a paged export one page at a time and joins the pages. On a host from before paging it reads
the whole archive. A bundle that changes between pages is read again from its first page, up to
three attempts, and a busy or stopped page is asked for once more. Create the client with
`deadlineMs: EXPORT_WINDOW_MS` (60 s), the host's export window; the default 15 s can cut a large
bundle. A `within(slug)` client names the bundle in that workspace.

Failures are typed:

- `HostedCarrierError`, `HostedRouteNotServed` (a host without the export route) and
  `RemoteError` (the host's refusal: `bundle_not_found`, `result_too_large`, `validation_failed`,
  an unauthenticated bearer and so on), as for the rest of the client.
- `ExportArchiveError` (`problem`): the verifier refused the archive. `incomplete` means the host
  stopped it, and the same request may succeed.
- `HostedExportError` (`problem`): `stopped` (the answer's body failed part way), `too_large`
  (past `MAX_EXPORT_BYTES`) or `source_changed` (the bundle kept changing between pages).
- The signal's reason, once `signal` or the client's own signal aborts.

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
