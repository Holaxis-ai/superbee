# @superbee/cli

Unpublished reusable Superbee command implementation. The package bundles its dependencies into one
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
executable before source and distribution tests run. The manifest's `private: true` prevents accidental npm publication; source visibility is unchanged. This
package is not enrolled in a publication or release workflow.

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
