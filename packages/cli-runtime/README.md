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
