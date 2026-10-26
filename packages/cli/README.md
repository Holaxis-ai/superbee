# @superbee/cli

Reusable Superbee command implementation. The package bundles its dependencies into one
ESM library with a closed declaration surface. It does not install a binary or execute arguments
when imported. The `superbee` distribution owns the executable, installed skill resources, private
worker routing, and release identity.

```js
import { configureSourceIdentity, registerExecutableEntry, main } from '@superbee/cli';
import { fileURLToPath } from 'node:url';

configureSourceIdentity({ name: 'superbee', version: '1.2.3' });
registerExecutableEntry(fileURLToPath(import.meta.url));
await main(process.argv.slice(2));
```

Configure identity before reading version/identity or dispatching commands. Configuration is
immutable: identical registration is idempotent; conflicting or late source identity fails.
Baked executable identity always takes precedence. Without configuration, source version is
`unknown`; without an explicit entry, helpers cannot select an executable for workers.

The API uses the process's cwd, environment, stdout/stderr, and exitCode. It supports one executable
identity per process, not multiple isolated command runtimes. Superbee command naming and legacy
recognition remain Superbee policy. Commands that install skills expect `SKILL.md` and `references/`
at the supplied executable's package root (the parent of its `dist/` directory).

Build from the repository root. The root build schedules prerequisites, this package, and the
executable before source and distribution tests run. Releases use `cli/v<version>` and
`release-cli-library.yml`; direct workspace `npm publish` is refused. The first `0.1.0-pre.1`
requires human bootstrap on `next`. Later releases use OIDC staging and human npm approval.
The read-only `release-cli-library-finalize.yml` verifies the registry bytes; it creates no GitHub
Release. See [the contribution guide](../../CONTRIBUTING.md) for release prerequisites.

## Supported surface

The supported API is what the package exports:

- `configureSourceIdentity`, `registerExecutableEntry` and `main`;
- the identity readers `cliVersion`, `isBareVersionFlag`, `buildIdentityEnvelope`,
  `staticBuildIdentity` and `currentExecutableRealPath`;
- `createCliRuntime`, `createPosixCliRuntime` and `HostCommandError`;
- the adapter contract types exported beside them (`CliRuntimeOptions`, `CliDistribution`,
  `HostCommands`, `PrivateStateHost`, `FilesystemHostPolicy`, `BoardHostPolicy` and the types
  they reference);
- the `@superbee/cli/resources` subpath;
- the `@superbee/cli/embedded-engine.json` data file.

`runManagedUiWorker` and `runUpdateRefreshWorker` are exported for first-party distributions
only. They implement private worker protocols whose arguments and behavior may change in any
release; other hosts must not call them.

Everything that is not exported is unsupported, including files under `dist/` reached by path.
Before 1.0 any release may change the supported surface. Pin an exact version and read the
release notes before moving it.

The package has no runtime dependencies. Third-party dependencies are bundled at the versions the
repository lockfile resolved when the artifact was built, not at the ranges `@superbee/core` or
any other Superbee package declares.

## Embedded engine record

The bundle embeds the workspace source of Superbee's engine packages rather than their published
npm packages. `@superbee/cli/embedded-engine.json` records what one artifact embeds and can be
read without importing the library:

```js
import { createRequire } from 'node:module';
const engine = createRequire(import.meta.url)('@superbee/cli/embedded-engine.json');
```

- `schema` is `superbee.cli-embedded-engine.v2`.
- `packages` has one row per embedded `@superbee/*` workspace, derived from the bundler's inputs
  and from the files the asset generation stages embed (the compiled `@superbee/ui` application
  and the MCP resources): `name`, the workspace manifest `version`, and `release_tag`
  (`libraries/v<version>` for `@superbee/core` and `@superbee/server`, otherwise `null`), which
  names the release that a consumer or release gate would compare the recorded commit against.
- `source` is the built `commit` and whether the working tree was `dirty`; either is `null`
  when unknown.

The record states what is embedded and from which commit. It does not claim, and cannot
establish, that the embedded Core or Server equals a published release: a version number alone
does not say so, because workspace source can move ahead of a release without a version change,
and a working-tree measurement inside the tarball would only describe the machine that built it.
The release workflow requires a pristine checkout at the recorded commit, equal to current main
and the tagged GitHub SHA, with successful CI. It compares the entire committed `packages/core`
and `packages/server` directories to their named `libraries/v<version>` tags, including manifests
and documentation. Differences or missing tags block release; release updated libraries first.
This is committed source-tree equality, not binary equality with separately compiled npm libraries
or equality of resolved third-party dependencies.

The workflow builds and packs once, proves that retained tarball's consumer behavior and embedded
inventory, then binds its exact bytes to a GitHub build attestation. The finalizer checks registry
bytes against the dedicated signer workflow, `refs/tags/cli/v<version>` and the packed
`source.commit`. A record alone is not that proof; treat a build without this verified attestation
as unreleased.

## Explicit host runtimes

`createCliRuntime` captures a trusted full distribution descriptor plus structural host, private
state, filesystem and board policies. Policy public fields, nested records/arrays and methods are
copied and frozen internally; ordinary methods compose through the captured public receiver.
Getters are evaluated during capture. Caller objects remain mutable. Opaque class-private state,
internal slots (such as Map/Date state), and methods pre-bound to a mutable receiver are outside this
structural contract. Callback closures can observe external OS facts; they must not use mutable
external configuration to change a captured lock namespace or other selected policy.

Contexts with the same distribution may select different policies. Deferred workspace and
approval callbacks retain their construction context. The process still has one immutable full
distribution and executable identity. Runtime construction requires a resolvable executable and
validates all captured configuration before committing it. A refused construction leaves the
previous identity intact. The standalone `registerExecutableEntry` API retains its no-op behavior
for unresolved paths and does not establish executable authority for them.

## Local snapshot observations

`source snapshot bind <source-doc> --dir <bundle>` previews consent for an ordinary source document;
repeat with `--accept <digest>` to save it. `source snapshot run <source-doc> --snapshot <ordinary.json>
--dir <bundle>` then emits `input_preview`, `effects_planned:false`, `applied:false`. Repeat with that
preview's `--accept <digest>` to ingest the exact input under current policy and private state.
Run requires previously accepted binding; an absent binding refuses without creating private state.
The bundle needs the target Kind and the existing valid record-overlay Signal Kind (for example the
existing source-feeds recipe definition). No executable profile or credential is selected.
Signal links use the actual source/target Kinds. The existing Signal definition's `from feed` link
names Source Feed, so it is omitted for a Reference snapshot source; its provider URN is retained.
A bundle may declare Signal links to its actual source and target Kinds for typed links.
See [Core's snapshot contract](../core/SNAPSHOT-SOURCES.md) for declaration, data, generation,
complete-scope, stable identity, ownership, and caller-associated evidence rules.

Input acceptance binds the exact source document head, target Kind and edition policy, bounds,
snapshot bytes and private state version. It evaluates no target effects. Execution builds one fresh
identity index and uses the existing target CAS/ownership conflict rules. A second identity claimant
added during execution can be detected only on a later fresh index/run; there is no bundle membership
transaction. Changed binding after observation history requires a deliberately new source document
and state key. Existing observations and original run/Artifact evidence are retained.

`source snapshot check <ordinary.json> --inputs-file <explicit-map.json> [--settings-file
<original-settings.json>]` needs no bundle. The map is closed JSON:
`{"inputs":{"original-model":"/explicit/model.blend"},"required_identities":{"tool":"/explicit/tool"}}`.
Each namespace permits at most 64 logical IDs; required identities are optional. Only explicit paths
are read; snapshot evidence selects no files. Snapshot files are at most 2 MiB; each selection map
and original settings file is at most 64 KiB. Original inputs and required identities share a 128 MiB
per-check byte ceiling, using the existing comparison operation bound. Missing, unreadable or
unchecked dimensions remain unknown. Inputs, maps and settings must be ordinary files outside
bundle stores and private state; symlink/hardlink file ingress is refused or uncheckable.

Settings comparison uses the original invocation JSON's existing canonical JSON digest. All hashes
are observed now and caller-associated; they do not prove historical tool consumption. `current`
means equal to every declared required dimension with a nonempty original input basis. A known
mismatch is `stale`; otherwise unavailable dimensions or absent/empty basis are `unverifiable`.
Informational tool labels outside `required_identities` are outside that applicability claim.


### Ordinary Git sync deadlines

Ordinary Git sync keeps one exact gated board update. Its upload budget defaults to 600 seconds,
with a 1500-second overall budget. Clone Git configuration `superbee.syncPushTimeoutSeconds`
accepts whole seconds from 1 through 3600; `superbee.syncTimeoutSeconds` accepts 1 through 7200.
Invalid values are refused before mutation. The initial engineering target is a roughly 160 MB
packed upload at 5 Mbps effective throughput, plus 60 seconds each for quiet server processing
and startup/packing. These values are finite policy defaults, not throughput guarantees.

The first-party executable opts into a supervised worker and enforces the overall deadline across
routing, configuration reads, preparation, gates, retries, and cleanup. Private `runFirstParty`
and `runGitSyncWorker` runtime methods belong to that executable adapter. Other hosts continue
using `run` or `main`; their captured callbacks and policies stay in process. They receive the same
supervised asynchronous push and diagnostics, with cooperative total checks between preparation
phases. They do not acquire a hard total-preemption guarantee across synchronous preparation.

A first-party Stop hook retains its short caller budget and hands unfinished work to foreground
sync. It records a private per-board hold before background gate/push admission, so subsequent
hooks do not restart the upload. Foreground sync bypasses that hold but clears it only after
successful completion. Background callers without the supported supervisor hand off before
publication. A timeout or lost acknowledgement reports publication as unconfirmed and never
triggers an automatic retry. An explicit later sync performs ordinary fetch/rebase/gate recovery.

These settings exclude every `--establish` invocation, including already-established fallthrough,
and do not change hosted sync. Process cleanup covers owned POSIX groups, including ordinary
Git, SSH and gate descendants. Deliberate daemonization that escapes those groups, and
uncatchable supervisor death, are outside this containment contract; this is not an OS sandbox.
