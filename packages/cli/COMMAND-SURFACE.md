# Command surface

GENERATED FILE — do not edit. Run `npm run surface -w @superbee/cli` to regenerate;
`npm run surface:check -w @superbee/cli` fails when this file is stale.

Every public CLI leaf, labelled with what it reaches outside the bundle it is pointed at.
Labels are derived from the canonical registry in `src/command-spec.ts` and from the real
import graph under `src/` — not declared by hand — so each one names the module that proves
it. **This file makes no stability claim.** It answers how large the surface is and how much
of it reaches past the bundle.

## Totals

- **58 public leaves** across **29 top-level commands**
- **0** reach nothing outside the bundle
- **11** network — reaches the network on its own, without being asked
- **34** network-opt-in — reaches the network only when the caller passes --remote
- **4** local-server — binds a local port or hands off to a browser
- **14** vendor-config — reads or writes another tool's configuration
- **56** user-state — reads or writes this CLI's own user-level state
- **10** caller-files — reads or writes a file the caller named outside the bundle

A leaf can carry more than one reach, so these do not sum to the total.

## What each reach means

| Reach | Meaning | Proven by |
| --- | --- | --- |
| `network` | reaches the network on its own, without being asked | `autopull.ts`, `update-check.ts`, `sync-cli.ts` |
| `network-opt-in` | reaches the network only when the caller passes --remote | the command grammar |
| `local-server` | binds a local port or hands off to a browser | the command grammar |
| `vendor-config` | reads or writes another tool's configuration | `host-config.ts`, `mcp-install-targets.ts`, `mcp-registration.ts` |
| `user-state` | reads or writes this CLI's own user-level state | `user-state.ts`, `private-config-write.ts`, `credentials.ts`, `catalog.ts` |
| `caller-files` | reads or writes a file the caller named outside the bundle | `external-file.ts` |

## Leaves

| Command | Reaches | Implemented by |
| --- | --- | --- |
| **Bundle** | | |
| `bundle locate` | `user-state` | `src/commands/bundle.ts` |
| `catalog add` | `user-state` | `src/commands/catalog.ts` |
| `catalog list` | `user-state` | `src/commands/catalog.ts` |
| `catalog resolve` | `user-state` | `src/commands/catalog.ts` |
| `init` | `user-state` | `src/commands/init.ts` |
| `index generate` | `user-state` | `src/commands/index.ts` |
| `status` | `network`, `user-state`, `network-opt-in` | `src/commands/status.ts` |
| **Documents & links** | | |
| `doc write` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/write.ts` |
| `doc update` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/update.ts` |
| `doc field set` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/field.ts` |
| `doc field add` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/field.ts` |
| `doc field remove` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/field.ts` |
| `doc field edit` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/field.ts` |
| `doc field replace-all` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/doc/field.ts` |
| `doc verify` | `user-state`, `network-opt-in` | `src/commands/doc/verify.ts` |
| `doc read` | `network`, `user-state`, `network-opt-in` | `src/commands/doc/read.ts` |
| `doc open` | `network-opt-in`, `local-server` | `src/commands/doc/open.ts` |
| `doc history` | `user-state`, `network-opt-in` | `src/commands/doc/history.ts` |
| `doc delete` | `user-state`, `network-opt-in` | `src/commands/doc/delete.ts` |
| `list` | `network`, `user-state`, `network-opt-in` | `src/commands/list.ts` |
| `query` _(alias of `list`)_ | `network`, `user-state`, `network-opt-in` | `src/commands/list.ts` |
| `link add` | `network`, `user-state`, `network-opt-in` | `src/commands/link.ts` |
| `link show` | `network`, `user-state`, `network-opt-in` | `src/commands/link.ts` |
| `link list` | `network`, `user-state`, `network-opt-in` | `src/commands/link.ts` |
| **Artifacts** | | |
| `artifact create` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/artifact.ts` |
| `promote` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/promote.ts` |
| `pull` | `user-state`, `network-opt-in` | `src/commands/pull.ts` |
| `blobs` | `user-state`, `network-opt-in` | `src/commands/blobs.ts` |
| `delete` | `user-state`, `network-opt-in` | `src/commands/delete.ts` |
| **Kinds** | | |
| `new` | `caller-files`, `user-state`, `network-opt-in` | `src/commands/new.ts` |
| `kinds` | `user-state`, `network-opt-in` | `src/commands/kinds.ts` |
| `kind field add` | `user-state`, `network-opt-in` | `src/commands/kind.ts` |
| `kind field remove` | `user-state`, `network-opt-in` | `src/commands/kind.ts` |
| `kind draft` | `user-state`, `network-opt-in` | `src/commands/kind.ts` |
| `kind dismiss` | `user-state`, `network-opt-in` | `src/commands/kind.ts` |
| `recipes` | `user-state`, `network-opt-in` | `src/commands/recipes.ts` |
| `recipe add` | `user-state`, `network-opt-in` | `src/commands/recipe.ts` |
| `recipe evolve` | `user-state`, `network-opt-in` | `src/commands/recipe.ts` |
| **Remote** | | |
| `serve` | `user-state`, `local-server` | `src/commands/serve.ts` |
| `ui` | `user-state`, `network-opt-in`, `local-server` | `src/commands/ui.ts` |
| `mcp` | `vendor-config`, `user-state`, `local-server` | `src/commands/mcp.ts` |
| `mcp install` | `vendor-config`, `user-state` | `src/commands/mcp.ts` |
| `mcp status` | `vendor-config`, `user-state` | `src/commands/mcp.ts` |
| `mcp uninstall` | `vendor-config`, `user-state` | `src/commands/mcp.ts` |
| `view list` | `network`, `user-state`, `network-opt-in` | `src/commands/view.ts` |
| `sync` | `network`, `user-state` | `src/commands/sync.ts` |
| **Session** | | |
| `version` | `network` | `src/commands/version.ts` |
| `session-start` | `network`, `user-state` | `src/commands/session-start.ts` |
| `hook install` | `vendor-config`, `user-state` | `src/commands/hook.ts` |
| `hook status` | `vendor-config`, `user-state` | `src/commands/hook.ts` |
| `hook uninstall` | `vendor-config`, `user-state` | `src/commands/hook.ts` |
| `skill install` | `user-state`, `vendor-config` | `src/commands/skill.ts` |
| `skill status` | `user-state`, `vendor-config` | `src/commands/skill.ts` |
| `skill uninstall` | `user-state`, `vendor-config` | `src/commands/skill.ts` |
| `setup` | `user-state`, `vendor-config` | `src/commands/setup.ts` |
| `setup migrate-state` | `user-state`, `vendor-config` | `src/commands/setup.ts` |
| `setup harden-state` | `user-state`, `vendor-config` | `src/commands/setup.ts` |
| `setup quarantine-state` | `user-state`, `vendor-config` | `src/commands/setup.ts` |

## Evidence

Why each labelled leaf carries the label it does. Where a reach covers more than half the
surface the exceptions are listed instead, because the short list is the informative one.

### network — 11 of 58

- `status`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `doc read`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `list`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `query`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `link add`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `link show`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `link list`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `view list`: autopull.ts — opportunistic board pull — a git fetch against the configured remote
- `sync`: sync-cli.ts — board branch fetch/push against the configured git remote
- `version`: update-check.ts — bounded release check against the npm registry
- `session-start`: autopull.ts — opportunistic board pull — a git fetch against the configured remote

### network-opt-in — 34 of 58

- via command grammar — accepts --remote, which targets an arbitrary wire-protocol server

Every leaf except: `bundle locate`, `catalog add`, `catalog list`, `catalog resolve`, `init`, `index generate`, `serve`, `mcp`, `mcp install`, `mcp status`, `mcp uninstall`, `sync`, `version`, `session-start`, `hook install`, `hook status`, `hook uninstall`, `skill install`, `skill status`, `skill uninstall`, `setup`, `setup migrate-state`, `setup harden-state`, `setup quarantine-state`.

### local-server — 4 of 58

- `doc open`: command grammar — binds a local port or opens a browser window
- `serve`: command grammar — binds a local port or opens a browser window
- `ui`: command grammar — binds a local port or opens a browser window
- `mcp`: command grammar — binds a local port or opens a browser window

### vendor-config — 14 of 58

- `mcp`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; mcp-registration.ts — writes this CLI's registration into a host's config; host-config.ts — Claude/Codex config-root conventions
- `mcp install`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; mcp-registration.ts — writes this CLI's registration into a host's config; host-config.ts — Claude/Codex config-root conventions
- `mcp status`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; mcp-registration.ts — writes this CLI's registration into a host's config; host-config.ts — Claude/Codex config-root conventions
- `mcp uninstall`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; mcp-registration.ts — writes this CLI's registration into a host's config; host-config.ts — Claude/Codex config-root conventions
- `hook install`: host-config.ts — Claude/Codex config-root conventions
- `hook status`: host-config.ts — Claude/Codex config-root conventions
- `hook uninstall`: host-config.ts — Claude/Codex config-root conventions
- `skill install`: host-config.ts — Claude/Codex config-root conventions
- `skill status`: host-config.ts — Claude/Codex config-root conventions
- `skill uninstall`: host-config.ts — Claude/Codex config-root conventions
- `setup`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; host-config.ts — Claude/Codex config-root conventions
- `setup migrate-state`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; host-config.ts — Claude/Codex config-root conventions
- `setup harden-state`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; host-config.ts — Claude/Codex config-root conventions
- `setup quarantine-state`: mcp-install-targets.ts — reads host MCP registrations from their own config locations; host-config.ts — Claude/Codex config-root conventions

### user-state — 56 of 58

- via credentials.ts — reads/writes user-scoped credentials
- via user-state.ts — the private, user-scoped state directory outside any bundle
- via catalog.ts — the user-level workspace catalog
- via private-config-write.ts — writes private user-scoped configuration

Every leaf except: `doc open`, `version`.

### caller-files — 10 of 58

- `doc write`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc update`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc field set`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc field add`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc field remove`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc field edit`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `doc field replace-all`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `artifact create`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `promote`: external-file.ts — ingests bytes from a caller-named path outside the bundle
- `new`: external-file.ts — ingests bytes from a caller-named path outside the bundle

## Resolution granularity

These modules implement more than one leaf, so those leaves necessarily share a reach.
A finer answer would need the code split, not the report changed.

- `src/commands/catalog.ts` — 3 leaves
- `src/commands/doc/field.ts` — 5 leaves
- `src/commands/hook.ts` — 3 leaves
- `src/commands/kind.ts` — 4 leaves
- `src/commands/link.ts` — 3 leaves
- `src/commands/list.ts` — 2 leaves
- `src/commands/mcp.ts` — 4 leaves
- `src/commands/recipe.ts` — 2 leaves
- `src/commands/setup.ts` — 4 leaves
- `src/commands/skill.ts` — 3 leaves

