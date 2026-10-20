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

`prepareRecipeInstall(recipe, { okfVersion, now })` prepares those same edition-specific candidates
without a backend or target reads. Retain the explicit `now` across preview and replay; v0.1 uses
it for the existing install timestamp, while v0.2 adds no legacy clock. The returned `identity`
contains the source digest taken before materialization; Convention, Connector and Reference
candidates already carry their recipe stamps. Preparation does not mutate the parsed source.

`inspectRecipeInstallTarget(existingOrNull, candidate, prepared)` separately reports existence,
source-content equality, recipe stamp identity and stamp integrity. For a matching installed
artifact, require `sameContent`, `stamp: "current"` and `stampIntegrity: "current"`; an identity match
alone does not establish readable digest rules or an intact definition stamp. Neither function
installs, adopts stamps, validates the target registry or grants write authority. An admitted host
can use the candidates with its existing canonical writer after its own coherent target and
compatibility checks; preparation is not an approved-preview transaction or a new apply API.

`installRecipe` is create-only: each convention, Connector, View pair and Reference is written with
an expect-absent compare-and-swap, an existing convention or Connector is left untouched (its row
reports `source_differs` when it differs from the recipe), and a differing View or Reference target
is refused before anything is written. Before any write it checks each Connector against the
authoring rules of the bundle's edition (`RecipeInputError` when OKF v0.2 would refuse it) and its
sources against the Kinds the bundle will hold (its conventions plus the recipe's own), throwing
`ConnectorTargetUnsatisfied` when one does not fit. `planRecipeEvolution` is read-only: it merges each recipe
convention into the installed one additively, rechecks existing instances, and returns blockers
and a `plan_token` bound to everything it read. `applyRecipeEvolution` recomputes the plan,
refuses a different token, and writes each changed convention at exactly the version the plan
saw. The bundle has no cross-document transaction, so a failure part way reports the definitions
written and those still pending. A Connector has no additive merge: the plan replaces it whole,
after the conventions, and only when this recipe's stamp holds and its definition digest shows
nobody changed it; an edited, unstamped-and-different or foreign Connector is a blocker and is
never written, stamp included.

Every convention and Connector either path writes carries an `x_recipe` stamp in the same write:
the recipe's id, version, declared convention count (`of`), `recipeSourceDigest` of the recipe,
the `definitionDigest` of the document as written, and the `digest_rules` version. A recipe that
carries connectors adds `connectors`, its declared Connector count, which readers that predate it
ignore; a recipe without connectors writes and digests exactly as before. A plan's `changed` is
about content only; its `writes` also counts definitions whose stamp is stale or missing, so a
ready plan with `writes > 0` has work to apply. `installedRecipes(docs, known?)` reads each
recipe's state (`installed`, `partial`, `diverged`, `unknown`) from the stamps alone, without the
recipe source; give it the conventions and the Connectors (`installedConventionDocs` and
`installedConnectorDocs`).

Failures are typed subclasses of `RecipeLifecycleError`: `RecipeInputError` (the recipe cannot
target this bundle's edition), `ConnectorTargetUnsatisfied` (`recipe`, `connector`, `source`,
`kind`, `code`, `fields`), `RecipeAssetConflict` (`recipe`, `key`), `RecipeEditionChanged`,
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

## Connectors

`@superbee/core/connectors` parses Connector declarations: `type: Connector` documents under
`connectors/` that say what an integration is, independent of any one target Kind. A declaration
holds no authority and nothing in the subpath fetches, executes or receives. It uses no Node globals
or builtins.

```ts
import { bindSourceFeed, changeBetween, connectorPinDigest, findingsFor, mapRecord, parseConnectorDoc } from "@superbee/core/connectors";

const parsed = parseConnectorDoc(connectorDoc, { kinds: registry });
if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.code} ${e.path}`).join("; "));
const pin = connectorPinDigest(parsed.connector);
const bound = bindSourceFeed(parsed.connector, sourceFeedDoc, registry, { okfVersion: "0.2" });
const mapped = mapRecord(bound.source, normalizedRecord, bound.kind);
if (mapped.kind === "mapped") {
  const change = changeBetween(lastAcceptedAfter, mapped, { external_id: mapped.external_id, change_kind: "changed" });
}
const findings = findingsFor(mapped.diagnostics, { source: bound.source.name });
```

`auth.kind` is `none`, `token`, `github-app`, `oauth2` or `signed-webhook`. A credential's hosts
come only from core: `token` and `oauth2` name a row of `AUTH_PROVIDERS`, `github-app` is fixed,
and `credentialHosts` is the one reader. `domains` lists hosts for keyless fetches and may not
repeat a credential host. The sources live under `record_sources` (OKF v0.2 reserves `sources` for
provenance, and `CONNECTOR_DOCUMENT_KEYS` lists every top-level key a Connector adds, none of them
an OKF field); the parsed `Connector.sources` holds them. Each source names a catalog `profile`, a
`target_kind`, mode `overlay`, an identity template (`identity.resource`, an https URL whose
placeholders are feed parameters, and `identity.id` over record paths), `completeness`, and
`fields`: target field to a dotted record
path, or to `{ from, values, unmapped }`. Mapping keys are the most a Source Feed may own; never-owned
fields, managed metadata, work state, the body and list-typed fields are refused. Actions and events
are declared shapes only. Every nested block is closed by `CONNECTOR_KEYS`; `parseConnectorDoc`
returns every refusal with a typed `code` and a JSON pointer `path`. A token shape or URL userinfo
anywhere in a frontmatter string, key or the body, or a credential key name outside the data-name
maps, refuses the document alone, naming a path and never the value; so does a YAML alias, which
keeps every reader bounded by the document's size. The secret rule is a tripwire; the pin, the
credential store and the fetcher are the boundaries.

`connectorPinDigest` covers every key `CONNECTOR_KEYS` accepts, with defaults filled and order-free
lists sorted, plus the credential hosts core resolves the auth kind to, so a host joining an
`AUTH_PROVIDERS` row changes the pin. It is blind to the title, description, version, body and
unknown top-level keys. `CONNECTOR_PIN_RULES` changes whenever a default or sort rule does.

`bindSourceFeed` binds a Source Feed (`connector`, `source`, `url`, `owned_fields`) to one source:
the `url` must equal the identity template rendered from parameters of `[A-Za-z0-9._~-]+` byte for
byte, `owned_fields` must be mapping keys, and the source's `target_kind`, `completeness` and
`profile` win. `okfVersion` is the content bundle's edition (absent means v0.1); a feed owning a
Kind-declared list field binds only on v0.2. Each refusal is an `OverlayRefusal` with
`POLICY_INVALID`, the feed and the key.
`mapRecord` never lets a mapping gap erase a stored value: an absent path is unobserved, an
unmapped native is kept (`unmapped: keep`, the default) or refuses the record while it still counts
as present (`refuse`), and only an empty value (`null` or blank text) clears an optional field; on a
required field or `title` it is kept with a finding. An id template separates its placeholders with
literal text, and a record whose value holds that text, is blank or makes an id past 2048
characters is refused as `IDENTITY_MISSING` or `IDENTITY_INVALID`, so two records never share one id. `changeBetween` takes the last accepted `after`, carries
unobserved fields and leaves them out of `changed_fields`. `findingsFor` groups diagnostics per
source, field, code and value (a list, mapping or empty value by its shape) for `planFindings`, so
one problem across many records raises one Signal.

A recipe carries Connectors through its manifest's `connectors:` list (`parseRecipeFiles` reads
each with `parseConnectorDoc`, checking the sources that target the recipe's own Kinds, and refuses
a malformed one as `RECIPE_CONNECTOR_INVALID`); `@superbee/core/recipe-lifecycle` installs, stamps
and evolves them as definitions.

The public [superbee-plugins recipes](https://github.com/Holaxis-ai/superbee-plugins/tree/main/recipes)
own the `Source Feed`, `Signal` and Work Item definitions used by the GitHub integration. The generic
engine and synthetic conformance fixtures remain in this package.

## Source engine

`@superbee/core/source-engine` is the portable half of the integration source engine: the one
loop that observes a bound Source Feed for an author's test, a local run or a managed runner. It
uses no Node globals or builtins and never calls `fetch`; the caller supplies the network as a
`Transport`.

```ts
import { MemoryMachineState, fetchIdentity, observeSource } from "@superbee/core/source-engine";

const receipt = await observeSource({
  connector, bound, profile, spec, transport, state: new MemoryMachineState(),
  identity: fetchIdentity("Product/1.0 (+https://example.org/about)")!,
  mode: "incremental", signal: AbortSignal.timeout(60_000),
  commit: async (page) => {
    const plan = await planRecordOverlay({ content, ops, policy: bound.policy, changes: page.changes, observedAt: page.observed_at, records: page.records });
    await applyRecordOverlay(plan, { content, ops, policy: bound.policy, actor: "process:calendar-sync" });
  },
});
```

A `SourceProfile` (`id`, `version`, `kind`, `validateSpec`, `hostsFor`, `observe`) turns a bound
feed, a cursor and a transport into pages of normalized records: `{ records, nextCursor, more,
complete }`, all JSON data. It never opens a socket, never sees a credential and never writes. A
`Transport` answers `{ url, method, headers, body, maxBytes, credentialHost, signal }`; it never
follows a redirect and returns `{ ok: false, refused: "too_large" }` rather than a truncated body.
A credential-injecting transport adds its credential only when the engine's `credentialHost` is
true and its own exact match agrees: https, the default port, a host exactly one of the auth
kind's credential hosts.

The profile sees the engine's guarded transport, which checks every URL and every redirect hop:
https only, the lexical address rule (`refusedAddress`: no IP literal, local name, port or
userinfo), and a host within the profile's `hostsFor` and the connector's credential hosts plus
keyless `domains`. A `hostsFor` naming any other host refuses the run before a request. A redirect
never changes host when either side is a credential host. Keyless hosts are read through robots.txt
(RFC 9309, the declared identity's product token, the first 512 KiB) first, and a bot-mitigation
page from one is refused and never retried. Only `GET` is sent unless `rules.post` admits a POST
toward a credential host; a keyless host is GET only. A GET with a body, a POST redirect, and the
headers `authorization`, `cookie`, `proxy-authorization`, `host`, `user-agent` and the method
overrides are always refused; beyond `accept` a header needs `rules.header`, and the validators
`if-none-match` and `if-modified-since` go out in incremental mode only. The budget counts every
request, robots.txt and hops included. Each request ends after `requestTimeoutMs` (default 20
seconds). The deadline is the caller's `signal`; without one the run ends after `deadlineMs`
(default 5 minutes). The deadline bounds the profile's page too: a page still pending is discarded
and the run ends `deferred`. A commit or state write in progress is never abandoned, so a hung one
holds the run. Statuses map to outcomes: 401 and 403 `credential_refused` (no retry), 404 and
410 `not_found`, 429 `deferred` with `retry_after`, others `provider_unavailable` (503 included,
with a retry); `statuses` moves a status between the sets. Any refusal or error status stops the
run, even when the profile catches the error, and the guarded transport is closed when the run
ends.

A profile runs in the engine's realm. The guard bounds what a declaration and a provider's data can
reach; profile code itself is bounded by the repository's static egress check
(`scripts/source-egress-check.mjs`) and by review, until profiles run in an isolate. The check
refuses globals outside a short list, imports outside an allowlist or the scanned roots, writes to
anything reached from a global, the prototype, property-definition and descriptor names however
they are read, `this` outside a class body and CommonJS; a key computed at run time is beyond any
static check.

Each page is mapped with `mapRecord`, diffed against the stored records into `RecordChange` rows
and handed to `commit`; the cursor and the records are stored only after `commit` resolves. A page
that promises more with no cursor, or with a cursor the run already asked for, fails the run as
`cursor_stuck`. `commit` may decline to write changes: a `retry` change (a lost compare-and-swap, a
claimed Signal) stays pending in the machine state and is planned again at the start of every run,
before anything is fetched, until it is written, refused for good, or superseded by a newer
observation of the record (its listing, or its absence from a complete pass); a replay keeps the
record's missing count, and a record that disappeared is not replayed. A replay whose commit throws
stays pending with a finding while the run reads on, and is dropped with a finding after
`MAX_REPLAY_FAILURES` (5). A page that supersedes pending changes stores their removal before its
commit, so a crash after the commit never replays an older change. A `hold` change is not pending,
and its record is planned again when it is next observed. Either way the cursor moves on, so one
record never stops a feed. An incremental
run continues the stored cursor (`resumed` when the last run left its pass open); a complete run
lists from the start, sends no validator, and stops on a not-modified answer. A pass is a complete
observation only when it ran in complete mode to its last page within the run, the profile claimed
it complete and the source is declared `complete`; only then is a listed record's absence counted,
and a record is `disappeared` after the feed's `missing_threshold` (default 2) of them. A cursor
from another profile id or version is never handed back. The receipt names the outcome, every
request, the pass, the stored cursor, the held and pending counts, the mapping diagnostics and the
findings for `planFindings`. `MachineState` is the port for the stored state, written with a
compare-and-swap; `MemoryMachineState` keeps it in memory.

## Source harness

`@superbee/core/source-harness` is how a profile and a transport prove the engine's rules offline.
It returns rows and problem lists rather than asserting, so any test runner can use it, and it uses
no Node globals or builtins.

```ts
import { peerTransport, runSourceFixture, runTransportConformance } from "@superbee/core/source-harness";

const { problems, missing } = await runSourceFixture(fixture, scenarios);
const rows = await runTransportConformance({ name: "mine", create: (peer, credential) => myTransport(peer, credential) });
```

`runSourceScenario` replays a scenario's scripted provider answers (`exchanges`, each used once,
matched on method and URL; a `hang` answer aborts the run's deadline) through `observeSource`,
writing each committed page through record-overlay over a MemoryBackend bundle built from the
fixture's documents, with editor edits between runs. `checkScenario` holds the result to the rule
of its required scenario (`REQUIRED_SCENARIOS`: provider errors, an incomplete page, cursor resume,
a hostile cursor refused by the guard, disappearance only from complete observations, owned-field conflicts, unmapped
and empty values, a missing identity, a cross-host redirect and an undeclared host), and fails any
request to an undeclared host or one the fixture did not script; a name may add a variant
(`cursor.resume.page-number`). `missingScenarios` lists what a fixture lacks.

`runTransportConformance` is the suite every transport passes against a `ScriptedPeer`, the
network that records exactly what arrived: the credential reaches its host under its own header
name (a custom `accessToken` included) and no other host, lookalikes included (a longer or
shorter name, a trailing dot, userinfo, another port), nor its own host when the engine's
`credentialHost` is false; a redirect is returned unfollowed, a body
over the bound is refused while one at the bound is returned whole, and behind the engine a
redirect to another host or a private address reaches nothing. `peerTransport` is a memory
transport that passes it.

## Bundle health

`@superbee/core/bundle-health` computes the health report behind `superbee status` from a core
`Bundle` on any backend: malformed documents, Kind lint and conformance debt, registry warnings,
unresolved links, orphans, freshness and invalid timestamps, trust tiers, the two graph lints, the
View surface, cross-bundle links, the OKF v0.1 upgrade finding and legacy naming. It uses no Node
globals or builtins, so it runs in Node, a browser or a Worker. The caller presents the report;
the CLI adds row caps, help text and its home and sync blocks.

```ts
import { MemoryBackend } from "@superbee/core/memory-backend";
import { bundleHealth } from "@superbee/core/bundle-health";

const bundle = { root: "memory://guide", backend: new MemoryBackend() };
const report = await bundleHealth(bundle, { now: new Date() });
const gate = { malformed: report.malformed.length, kind_warnings: report.kindLint.length, unresolved_links: report.unresolvedLinks.length };
```

The report reads only: one Kind registry load, one lenient query, two prefix-scoped blob listings
and one root-index read, with every finding derived in memory. A document whose frontmatter does
not parse is a `malformed` row (the root index first), never a thrown error. Top-level keys are
camelCase; rows keep snake_case keys (`age_ms`, `bundle_id`, `incompatible_values`) and arrive
whole, in report order, for the caller to cap. Sections whose presence depends on the bundle are
null when absent: `conformanceDebt` without any declared Kind, `trust` outside a non-empty v0.2
bundle, `crossBundle` without `docs/dependencies` or any `okf:` link, `okfUpgrade` outside a v0.1
bundle with a workflow-status collision. `crossLinkTypeViolations` is always an array, because a
local edge under a qualified declaration needs no dependencies. The stored values in
`invalidStaleAfter`, `invalidTimestamps` and `invalidLegacyTimestamps` are made JSON-safe;
`missingExpectedLinks[].status` is the raw stored value.

Nothing outside the bundle is read unless the caller binds it. `bindings` is a map of bound copies
by alias, or a hook core calls exactly once, after every read and with its own parse of
`docs/dependencies` (a self alias already dropped as `DEP_SELF`, using `selfBundleId` when
`docs/bundle` declares no id). Whatever the hook throws propagates unchanged. Each binding's
verdict comes from core's resolver, and `dependencies[].bound` is the binding's `label`.

`bundleKindFindings(documents, okfVersion, { actor, producer })` answers a different question:
which Kind problems a strict host write would refuse, preparing each document as its first edit,
so a timestamp or actor the write supplies is no finding. The CLI's publish preview runs it; the
report's `kindLint` stays advisory. Both use core's one validator, `validateAgainstKind`.

## Search

`@superbee/core/search` is the one `documents.search.v1` engine: the request and result contract,
query normalization, ranking (`portal-webmcp-search/v1`), the any-term fallback, facets, cursors
and page budgets. A backend supplies what it searches through `SearchSource`: one `evidence()`
call per request and `text()` for the page's excerpts. `memorySearchSource` indexes a complete
corpus in memory. `searchSourceFromBackend(backend, options?)` reads a complete local
backend in bounded batches, applies the same memory-source bounds, and derives the corpus key
from the versions actually read. Validate the request before calling it and pass an opaque
bundle identity as the search scope. Failed reads refuse the whole corpus. The subpath uses
no Node globals or builtins.

```ts
import { memorySearchSource, searchDocuments } from "@superbee/core/search";

const source = memorySearchSource(documents, { key: headsDigest });
const result = await searchDocuments(source, { query: "lock keeper", limit: 10 }, { scope: bundleId });
```

`key` identifies the corpus; a cursor is refused for another key, scope, query, match or filters
(`type`, `tag`, `prefix`). A request outside the contract throws `SearchInputError`; a corpus over a
bound throws `SearchLimitError`; a request whose terms hold more than `maxEvidenceInstances` capped
instances (a `searchDocuments` option, at most `SEARCH_LIMITS.maxEvidenceInstances`) throws
`SearchBroadQueryError`, a `SearchLimitError` whose message asks for fewer or more specific terms.
A source must hold one document per id.
A document over 65,536 body terms is left out and counted: the result's `corpus` reports
`documents`, `indexed`, `skipped` and `reindexPending`. `searchRowText` is what one document
contributes to any index, and `textVersion()` names the algorithm, `SEARCH_TEXT_REVISION` and the
runtime's normalizer fingerprint, so a stored index can tell when its rows need re-deriving.

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
durable across restarts (`openHostedClientJournal`, below, is one for Node); lookups use the
binding recorded with each intent. A service that
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

### Writing a blob

`writeBlob` and `deleteBlob` write one ordinary file (a blob: an image, a diagram, any bytes) to a
hosted bundle. A create names an absent key; a replace and a delete name the head they expect,
its version **and** content type (a `BlobPin`), so a type-only change is a replace too.

```ts
const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
const created = await client.writeBlob("notes", { key: "diagrams/flow.svg", bytes: svg, contentType: "image/svg+xml", expectAbsent: true });
if (created.status !== "committed") throw new Error(created.status);
let pin = created.head!; // { key, version, contentType }

const replaced = await client.writeBlob("notes", { key: pin.key, bytes: edited, contentType: "image/svg+xml", expected: pin });
if (replaced.status === "committed") pin = replaced.head!;

const read = await client.readBlob("notes", pin.key, { pin }); // bytes verified, or null if no longer at the pin
const deleted = await client.deleteBlob("notes", { key: pin.key, expected: pin });
```

Each call returns one of:

- `{ status: "committed", head, changed? }`: applied. `head` is the new head (null after a
  delete); `changed` is false for a replace the head already matched.
- `{ status: "conflict", reason: "version_conflict", actual }`: the head is not at the expected pin
  (for a create: the key exists). `actual` is the head now, or null when there is none (a delete of
  an absent key). Final for that identity.
- `{ status: "conflict", reason: "concurrent_change", message }`: another write overlapped this one
  past the host's own retries. Nothing was applied.
- `{ status: "refused", code, message }`: the host's own refusal, or one the client names. The
  host's codes are those it records under the identity (`backend_unavailable`, ...) and those it
  answers before dispatch and never records (`insufficient_scope` for a grant without blob writes,
  `bundle_not_found`, and `request_capacity` in a `200` or a `429`). A refusal of the second kind
  proves only that this attempt did not run, so it is final only when every earlier attempt of the
  write is proven not applied, which is always so for a write the client sends; a write whose
  earlier attempt was unclear is never sent again, only looked up, and stays `unknown`.
  `insufficient_scope`, `bundle_not_found` and `invalid_input` also drop the held capabilities
  answer, so the next write reads them again. The client's own codes are `invalid_input` (an
  unsafe key, a key under one of Superbee's own record folders or a reserved file, an invalid content type, a body over the host's `blobWriteBytes` or 16 MiB, or a held
  identity reused for another write), `scope_mismatch` (a held write, or a reused `requestId`, recorded
  for another origin or sync prefix) or `unsettled_write` (an earlier write of the same key in the bundle is still
  unsettled: settle or forget it first). Nothing was sent for a client-named refusal.
- `{ status: "held", deletions, baseline }`: the host holds this mass delete (`428
  deletions_held`). Nothing was applied. A person confirms the count, and
  `settleBlobWrite(requestId, { acceptDeletes })` with at least `deletions` sends it again; without
  `acceptDeletes` it stays held and nothing is sent, and with fewer it throws
  `HostedBlobDeletionsNotAccepted`, sending nothing. `deleteBlob(..., { acceptDeletes })` sends the
  confirmation with the first attempt.
- `{ status: "unknown" }`: the host may or may not hold the write.

Every result names its `requestId`, `key` and `operation`.

**The capability gate.** A blob write needs the bundle's `blobWrites: "allowed"` and its
`blobWriteBytes` bound, from the same held capabilities answer `write` uses. When the host serves
the bundle no blob writes (an older host's answer reads as refused), `writeBlob` and `deleteBlob`
throw `HostedBlobWritesNotServed`, a `HostedRouteNotServed` (`isRouteNotServed` is true), before
anything is journaled or sent. This differs from `write()`, which answers a bundle without writes
with the result `refused: read_only`: the blob routes are a newer capability a caller probes for, as
it probes for any route a host may lack. The checks a send would otherwise fail (the capability, the
byte bound, the key and the content type) all run against that one answer before the write is
journaled, and the delivery is handed the same answer, so the two cannot disagree.

**Exactly once, never resent after it may have left.** Each blob write is journaled under one
request identity (with the client's binding, the bundle and workspace and the bytes), durably
claimed, then sent once. After an unclear answer the client looks the identity up on the host
(`/outcome`, under the binding recorded with the write) and reports what the host recorded. Unlike a
document write, an `absent` lookup is never permission to send again: once an attempt may have left,
a blob write is only ever looked up. A send proven never to have left (the credential provider
failed or was denied, the signal was already aborted, the identity was malformed, a local check
failed) is rolled back instead: `writeBlob` throws `HostedBlobWriteNotSent` with its `requestId` and
`reason`, and the write stays held and resendable (`held: true`), so `settleBlobWrite` or the same
`writeBlob` call (same `requestId`, same input) sends it. A transport failure after the request was
handed to the carrier is `unknown`.

**Recovery.** `heldBlobWrites()` lists every unsettled blob write (`requestId`, `bundleId`,
`workspace`, `key`, `operation`, `state`, `attempts`, `resendable`, `hold`, `createdAt`) and sweeps any
settled one a crash left behind.

- `lookupBlobWrite(requestId)` makes one outcome lookup and never sends. A write never sent (or
  proven not applied) answers `{ status: "pending" }` without a request, and a held delete `held`.
- `settleBlobWrite(requestId, { acceptDeletes? })` submits the write when its state is pending or
  unknown and every attempt is proven not applied (`attempts === notAppliedThrough`); otherwise it
  only looks it up, and an absent lookup is `unknown`.
- `forgetBlobWrite(requestId)` drops an `unknown` write once one fresh lookup answers `absent`,
  returning `{ status: "forgotten" }`. **The earlier delivery may still commit**; the host's
  compare-and-swap is what keeps a later write from losing that update. Any other record is
  `{ status: "kept", reason: "not_unknown" }` (settle an `in_flight` one first), a lookup that fails,
  is refused or is malformed is `kept` with `lookup_unavailable`, and a lookup that finds the outcome
  settles the write instead. A forgotten identity is no longer held, so `writeBlob` with that same
  `requestId` journals and uploads it again under that identity. That is safe: the host answers a
  delivery it recorded under the identity with the recorded result, and one it did not record is
  checked against the expected pin like any write.

All three answer `{ status: "unrecorded", requestId }` when the journal holds no blob write under the
identity. A reused `requestId` with the same input resumes (settles) the held write; with different
input it is `refused: invalid_input` and nothing is admitted. Calls are serialized per request
identity and per key (the journal's guard covers a key across bundles), so concurrent calls of one
client never trip each other.

```ts
// A service restarting after a crash: settle what it held, forgetting only proven-absent unknowns.
for (const held of await client.heldBlobWrites()) {
  const settled = await client.settleBlobWrite(held.requestId);
  if (settled.status === "unknown") console.warn(`blob write ${held.requestId} is still unknown`); // forgetBlobWrite once you choose to move on
}
```

**Reads.** `readBlob(bundleId, key, { pin })` requires the pin: it reads exactly that version and
content type, verifies length, digest and type, and answers null when the key is no longer at the pin
(the host's `409`). `blobHead(bundleId, key)` is the explicit lookup of one head (or null), and
`blobHeads(bundleId)` the whole listing; both read the full verified listing (up to 10,000 heads in
4 MiB pages), since the host has no single-key head route yet.

**Keys.** `isOrdinaryBlobKey` is the one key policy every blob writer uses, this client and the
CLI's checkout sync alike: a safe key that is not a reserved file (`index.md`, `log.md`) and does not
sit under Superbee's own record folders (`views/`, `pages/`, their registries, `conventions/`,
`recipes/`, `references/`, compared case-insensitively). Any other key is refused `invalid_input`
before any request.

**Aborts.** A `signal` aborted before the write is admitted throws its reason and journals nothing;
that includes an abort while the capabilities are still being read, so a hung credential provider
never holds the call (or its key) past the caller's abort. Once admitted, a write is held until it
settles, and an abort before its send leaves it resendable (`HostedBlobWriteNotSent`).

**Journal.** The default blob journal is in memory (`createMemoryBlobJournal`), owned by the client.
Give a blob journal to one client (its `within` clients share it). Two clients over one journal
coordinate only through its per-key guard: concurrent writes of different identities still settle,
but two calls on the same request identity from both clients can fail with a raw journal conflict.
Pass `blobJournal` to keep blob writes across restarts: in Node, `openHostedClientJournal(...).blobs`
(below). `driveJournaledBlob(journal, context, requestId, mode)` is the owner of the journaled
sequence (admit, claim, deliver, persist, retire) for a caller with its own journal and premises; its
`premises.snapshot(key, step)` returns each transaction's guard plus the caller's own metadata
changes, checked atomically with it.

**Limitations.**

- Lookups currently need `blobWrites`: a grant downgraded to read-only cannot settle its earlier
  blob writes until the host authorizes the outcome route on its own (a hosted follow-up).
- A lookup across principals is unverified: a new token of the same principal finds its outcomes
  (the binding travels in the journal), but what another principal's lookup gets is not yet proven.
- Every journal record of a write carries its bytes, and each transaction validates the record.
  Validation is cached per payload, so a write costs about 0.17 s per MiB in Node (3 MiB about
  0.5 s, 16 MiB about 2.6 s, measured with the in-memory journal); without the cache it was about
  1.7 s per MiB (16 MiB about 28 s). The first validation of a payload still runs on the caller's
  thread in one slice, about 1.2 s for 16 MiB.

### Inbox

`createHostedInbox(client, { tenantId })` is a person's hosted inbox in one workspace, over the
same client (its credential, deadline and abort; a `within` client serves too). It reaches the
attention routes, `POST <prefix>/attention/<operationId>`, and names the workspace in the
`Superbee-Workspace` header on every request, since a sync sign-in spans all of the person's
workspaces. Notifications are a hosted capability: a host without these routes answers
`HostedRouteNotServed`, and nothing here emulates a local inbox.

```ts
import { createHostedInbox } from "@superbee/core/hosted-client";

const identity = await client.whoami();
const inbox = createHostedInbox(client, { tenantId: identity.tenantIds[0]!, via: "my-agent" });
const receipt = await inbox.request({ recipient: { kind: "principal", principalId: identity.principalId }, kind: "needs_input", note: "Ready for you" });
const page = await inbox.list({ threadId: receipt.threadId, afterSeq: 0 });
```

The methods are `list`, `threads`, `summary`, `get` (does not mark read), `open` (marks read),
`ack` (at the revision read), `request` (send) and `cancel` (withdraw your own send), with the
open contract's shapes (`InboxEntry`, `InboxThread`, `AttentionReceipt` and the inputs). A
recipient is a principal id; to notify yourself, use `whoami().principalId`. A document target
names `whoami().targetAuthorityKey` as its `authorityKey` and the document's current version; a
host that reports no key (the field is absent, as on every `/sync/v1` host today) cannot take one yet.

`request` mints one UUIDv7 ticket per send (or takes the one you pass). When an answer is lost or
the host marks its refusal retryable, it sends the same body under the same ticket again
(`sendAttempts`, default 3), which the host answers as a replay of the first send, never as a second
item. A send still unclear after that throws `HostedAttentionOutcomeUnknown` with its `ticket`:
`request({ ...input, ticket })` within 24 hours settles it. Refusals are
`HostedAttentionRefusal` (a `RemoteError`) with the catalog's `code` (`attention_disabled`,
`not_found`, `target_unavailable`, `target_unsupported`, `quota_exceeded`, `request_conflict`,
`version_conflict`, `ticket_expired` with `serverTime`, `workspace_not_available` and the rest),
`retryable`, and a message in this client's words: the host's message and hint are never repeated.

### Durable intent store (Node only)

`openHostedClientJournal` from `@superbee/core/hosted-client/node` is a durable `intentStore`, and its
`blobs` a durable `blobJournal`, so a short-lived process that exits with a write `unknown` can recover
it after a restart.

```ts
import { createHostedClient } from "@superbee/core/hosted-client";
import { openHostedClientJournal } from "@superbee/core/hosted-client/node";

const journal = await openHostedClientJournal({ directory: path.join(stateDir, "superbee-writes") });
const client = createHostedClient({ target, credentials, intentStore: journal, blobJournal: journal.blobs });
for (const held of await client.heldWrites()) await client.settleWrite(held.requestId);
for (const held of await client.heldBlobWrites()) await client.settleBlobWrite(held.requestId);
// ... writes ...
await journal.close();
```

The journal is a `FileJournaledBackend` directory: an fsynced, checksummed log with snapshot
compaction. Its on-disk format is a supported compatibility promise: a format bump ships a reader
for every earlier layout, and an older reader refuses a newer store with `FileJournalFormatError`
rather than misreading it. The current format is 3 (see `JOURNALED-BACKENDS.md`). Each unsettled write is one metadata row, `hosted-client.write.<requestId>`,
holding the whole document and the binding it was sent under, so a new process with a new token
looks it up exactly as the first would have. A settled write is removed. Each unsettled blob write is
one row of the backend's own blob intent family, with its bytes, under the same transition rules as
the in-memory journal; a settled one is retired, and since every record of a blob write carries its
bytes, retiring or forgetting one compacts the store once its log or snapshot is past 1 MiB. Metadata
a blob write carries may not name the journal's own rows (`hosted-client.*`) or a checkout's
blob-sync state.

- **Ownership.** Open takes an exclusive same-user lock on the directory until `close()`. Another
  process waits `lock.waitMs` (default 5,000 ms) and then gets `FilesystemMutationLockError`. A
  lock left by a process that died on this host is reclaimed.
- **Local file system only.** The lock lives in a per-user runtime directory on this host, so it
  cannot exclude a process on another host. Keep the journal on a local disk, never on NFS, SMB
  or another shared mount. Open does not detect a network mount; this is the operator's rule.
- **Privacy.** The journal holds whole documents. A directory open creates is mode 0700, and its
  files 0600. On POSIX, an existing directory that is a symbolic link, is owned by another user,
  or grants its group or others any permission, is refused as `HostedClientJournalError`
  `JOURNAL_DIRECTORY_NOT_PRIVATE`. The check runs again once the lock is held, and a directory
  replaced in between is refused too. The directory is the journal's alone: an existing one may
  hold only `store.log`, `store.snapshot` and `store.snapshot.tmp`, and any other entry (an
  operating system's `.DS_Store` included) is refused as `JOURNAL_NOT_HOSTED_CLIENT`, as is a
  `store.log` that is not a journal's log, and a store file that is a symbolic link, a
  directory, has more than one link, or (on POSIX) belongs to another user. The listing and the
  files are checked again under the lock. Another process of the same user changing the
  directory while it opens is out of scope: in that window the open can truncate a torn or
  foreign log tail.
- **Marker.** A new journal records `hosted-client.journal = { schemaVersion: 1 }` in its first
  transaction. Open refuses, as `JOURNAL_NOT_HOSTED_CLIENT`, a store with rows but no marker or one
  holding documents, blob files or a checkout's blob-sync state, so it is never pointed at a CLI
  checkout store. A marked journal holding blob write intents is its own and reopens. A marker of another schema is `JOURNAL_SCHEMA_UNSUPPORTED`. Open decides on a read-only
  pass first, so a refused directory's files are left byte for byte. A crash before the marker
  lands leaves an empty store, which the next open marks.
- **Size.** Once the store is adopted, the log is compacted into the snapshot whenever it grows past the greater of 1 MiB
  (`HOSTED_CLIENT_JOURNAL_COMPACT_FLOOR_BYTES`) and twice the last snapshot, so steady writing keeps
  it near 1 MiB. The snapshot, which holds every write still unsettled, and any one transaction are
  bounded at 256 MiB. A write that would pass that bound is refused before anything is recorded,
  and its `write` throws. Unsettled writes count toward the bound until `settleWrite` resolves them.
- **Ordering.** Unlike the in-memory store, each call takes effect when its asynchronous steps
  complete, so unawaited overlapping calls on one request identity can land out of call order.
  Await each call before the next, as the client does.
- **Damage.** `FileJournalCorruptError` (a damaged record before the log's end or a damaged
  snapshot) and `FileJournalFormatError` (a newer format) refuse the open and change no file. A torn
  final record, which was never acknowledged, is truncated. Nothing is repaired automatically:
  moving the directory aside starts an empty journal and loses the writes it held, which can then
  be settled only by reading the documents on the host.

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

## Built-in recipes and Kind authoring

`@superbee/core/builtin-recipes` is an opt-in catalog: `builtinNames()` lists names,
`builtinRecipeFiles(name)` returns detached source files, and `loadBuiltinRecipe(name)` returns
the existing parser's result or `null` for an unknown name. The generic parser, package root,
and `initBundle` do not import the catalog or install recipes.

`@superbee/core/kind-authoring` provides inference, forecasts, dismissal classification, templates,
and guarded draft/apply/dismiss operations on a caller-selected `Bundle` backend. An outside app
can use the existing backend and mutation seams without a CLI subprocess:

```ts
import { MemoryBackend } from "@superbee/core/memory-backend";
import { query } from "@superbee/core/engine";
import { mutateDocument } from "@superbee/core/document-mutation";
import { buildKindRegistry } from "@superbee/core/kinds";
import { loadBuiltinRecipe } from "@superbee/core/builtin-recipes";
import { installRecipe } from "@superbee/core/recipe-lifecycle";
import { kindInstanceCandidate, prepareKindDraft, applyKindDraft } from "@superbee/core/kind-authoring";

const backend = new MemoryBackend(), bundle = { root: "memory://project", backend };
await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Project\n");
const loaded = loadBuiltinRecipe("work-tracking");
if (!loaded?.ok) throw new Error("Recipe unavailable");
await installRecipe(bundle, loaded.recipe);
const registry = buildKindRegistry(await query(backend, { prefix: "conventions/" }));
const task = registry.kinds.get("Task")!;
const candidate = kindInstanceCandidate(task, { title: "First task", superbee_progress_status: "todo" });
await mutateDocument({ bundle, id: "tasks/first", mode: "create-only", registry, strict: true,
  buildCandidate: () => candidate });

// Once an ungoverned type has existing instances, inspect its draft before applying.
const text = { inferredBody: () => "The accepted shape of existing research records.\n" };
const plan = await prepareKindDraft(bundle, "Research", text); // requires existing Research docs
// Present candidateDoc, warnings and promotions; after acceptance:
await applyKindDraft(bundle, "Research", plan.token, text);
```

`kindInstanceCandidate` accepts already-typed field values. Existing validators own their meaning;
there is no CLI flag coercion or path-alias resolution. Supply a canonical id and use strict
create-only mutation. The template keeps `type` equal to `governs`, preserves own prototype-shaped
fields, scaffolds sections only when body is omitted, and retains an explicit empty body.

Public draft/apply/dismiss operations trim type names and refuse blank or non-string names before
any backend access, matching convention parsing. `prepareKindDraft` selects a catalog definition
or infers from instances. Its token binds candidate
bytes (including supplied `inferredBody`/`inferredDescription`), edition, presence statistics and
warning forecast. Pass the same prose options to `applyKindDraft`, which recomputes the plan and
checks edition and declaration-free redraft eligibility against every fresh CAS head. New
conventions are expect-absent creates; accepted redrafts replace dismissal prose in place and
report dropped links. `dismissKind` accepts presentation-owned description/body, records no schema
obligations, refuses a real schema, and is idempotent. Definition writes retain recipe
installation's generation-clock opt-out. `KindAuthoringError.reason` identifies domain refusals;
normal mutation/storage errors retain their types.

Presentations with an established mutation adapter may pass the options from
`prepareKindDraftMutation` or `prepareKindDismissal` through that adapter. These are the same
specifications used by public apply/dismiss; keep preparation adjacent to mutation. Outside apps
normally use `applyKindDraft`/`dismissKind`, which own the read-and-apply sequence. No cross-document
transaction or authorization boundary is added.

The packed proof runs the public workflow over `MemoryBackend` in Node and a browser bundle without
Node globals. This proves source/package availability. Hosted provisioning routes, MCP modeling
tools, and publication of a core version remain separate adoption and release decisions.


## Declarative JSON sources

`@superbee/core/source-profiles` exports `getSourceProfile(id)`, frozen `SOURCE_PROFILES` metadata,
and `restJsonProfile` (version 1). The catalog contains only `rest-json`; GitHub
normalization ships separately in [`@superbee/integration-github`](https://github.com/Holaxis-ai/superbee-plugins/tree/main/integrations/github). Core also exports the existing
`nextLinkTarget` parser, `SourcePluginHelpers` type and exact `SOURCE_PLUGIN_CORE_VERSION` for
explicit host composition. The profile accepts a parsed `ConnectorSource` as its spec;
`source.request` describes provider data, while `source.fields` maps normalized paths to Kind fields.
It runs only through `observeSource` and the caller's recorded or credential-injecting transport.
Installing a Connector does not run it.

The optional, pinned request block requires `host`, `method`, `path` and `items` (empty string for
a root array). `query`, `body` and `headers` contain scalar literals or whole `{binding}`, `{cursor}`,
`{page}` and `{watermark}` values. Path placeholders occupy whole segments. `request.fields` maps
normalized dotted paths to `{from, type?}` or `{const}`; types are `text`, `integer`, `date`
(ISO timestamp), `epoch-date` (seconds to ISO timestamp), and `url` (HTTP(S)). Presence-only `skip`
rules count skipped records. No executable expressions or synthesis are supported.

Paging kinds are `none`, `cursor`, `link-header`, `offset` and `page-number`. Cursor paging uses
`cursor_path` (opaque token, placed through `query`) or `next_path` (URL). Numeric paging requires
`size` and `page_param` or `offset_param`, and restarts from the beginning after interruption.
`watermark: {field, param, overlap_seconds}` applies overlap between passes and keeps the pass's
starting watermark fixed across pages. `complete` is `always`, `never`, or `{when_path, equals}`;
the engine additionally requires an uninterrupted complete-mode pass before counting absences.
Optional `errors` sets (`deferred`, `credential_refused`, `not_found`) and `rate.requests` narrow
the run's status interpretation and request budget.

Existing declaration pins without a request block remain unchanged. Credentialed engine consumers
must now supply a request declaration: `declaration_required` refuses a missing one before any
transport call. Parsing and installation remain inert. Provider read paths, read-shaped POST paths,
headers and paging forms are core-owned, deeply frozen, and revalidated at every run; caller rules
can only narrow them. Callback URL/response views are isolated from execution; changing a view
cannot rewrite the request. Core rechecks its private run authority after narrowing callbacks.
Keyless legacy profiles retain the declared-domain and robots rules.

GitHub's repository issues GET, version header and alternate numeric pagination form follow
[issues documentation](https://docs.github.com/en/rest/issues/issues) and
[pagination documentation](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).
Numeric `/repositories/{id}/issues` paging additionally requires first-page repository metadata
that proves the id belongs to the bound owner/repository and stays fixed for that pass. The issues
listing does not guarantee that metadata; a Link alone cannot establish it. Without proof the
engine refuses that alternate form. Its metadata proof is scoped to the current run, so resuming
an interrupted alternate numeric URL in a later run also refuses; restart from the bound path.
The conditional metadata test is not live-provider
qualification. Same bound `/repos/{owner}/{repo}/issues` pagination remains usable.

GraphQL declarations use the real `graphql` syntax parser: one query operation, no variable defaults,
and bound String/ID inputs. GraphQL execution is deferred to the later GraphQL profile slice:
`graphql_scope_unsupported` refuses even a well-formed read body before transport. Syntax alone
does not establish resource-scoped traversal. Mutations and malformed extension bodies are refused
by the engine wrapper; caller hooks cannot enable them.

## Declared Kind model

`@superbee/core/domain-model` exports `projectDomainModelV0(registry)` and its
readonly input/output types. Pass a canonical registry from `buildKindRegistry`
(`@superbee/core/kinds`) or `loadKinds`; the projection performs no parsing or I/O.
It returns deeply frozen JSON with deterministically ordered Kind definitions,
declared relationships, registry warnings and informational outside-scope endpoints.
Structurally malformed inputs throw `TypeError`.

The v0 shape preserves authored array order and warning metadata. It does not
include `fields.types` or derived `freshnessHorizonMs`; adapters that already add
these fields keep that enrichment. Projection does not establish snapshot coherence,
authorization or permission to disclose a bundle's declarations.
