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
executable before source and distribution tests run. This package is not yet enrolled in a release
workflow; `npm publish` is refused here.

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
Equality with a published release is planned as an attested check in the release workflow that
will enroll this package: it will build from a pristine checkout of the recorded commit and bind
the result to its build attestation. No current workflow establishes it. Until then, treat every
record without a release attestation for its `source.commit` as an unreleased build.

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
