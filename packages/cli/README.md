# superbee

## What is Superbee?

Superbee gives AI coding agents shared, versioned, conflict-safe memory — as a folder of
plain markdown in your repo.

Agents forget everything between sessions, overwrite each other's work, and keep what they
know invisible to the humans they work for. Superbee fixes all three:

- **Memory that persists.** Agents write context notes, decisions, plans, and research into a
  knowledge bundle that survives the session. The next session — or a different agent — picks
  up exactly where the last one left off. An optional `SessionStart` hook (Claude Code, Codex,
  OpenCode) orients every new session automatically.
- **Safe for many writers.** Every document write is compare-and-swap versioned and attributed
  to an actor. Two agents racing on the same document get a clean, typed conflict instead of a
  silent lost update — and `doc history` shows who changed what, when.
- **Visible to humans.** Everything is plain markdown you can open in any editor, render on
  GitHub, and diff in git. `superbee ui` serves the bundle locally as rendered, cross-linked
  pages with derived backlinks, a live activity feed, and launchable bundle Views. `superbee
  sync` shares the bundle with teammates on a dedicated `board` branch — pulling their changes
  and pushing yours without touching your code.
- **Agent-native by design.** The CLI follows the AXI principles for agent-facing tools:
  structured, token-lean output; result counts and truncation with explicit escape hatches;
  idempotent mutations; structured errors with a small, stable exit-code taxonomy. Agents get
  predictable responses they can act on without parsing prose or flooding their context window.
- **Yours, and portable.** Bundles conform to the Open Knowledge Format — new bundles are
  written as OKF v0.2, and existing v0.1 bundles stay supported in place — so they survive the
  tool: hand the folder to someone else, or read it with anything that speaks markdown.
  Everything works offline; the filesystem is the source of truth. Typed document schemas
  ("kinds") live in the bundle itself, so the bundle describes its own structure.

The npm package ships one self-contained executable with zero runtime dependencies, plus an
Agent Skill that teaches agents how to use it.

## Install Steps

**Requirements: macOS or Linux, and Node.js 20 or newer.** Windows is not supported yet: the
private-state layer that keeps per-user operational records contained relies on POSIX file modes
that Windows does not distinguish, so the package declares `"os": ["!win32"]` and npm stops with
`EBADPLATFORM` rather than installing something that fails on first use. Windows support is tracked
work, not a permanent boundary. Under WSL2 npm sees a Linux platform and installs the package; that
path is untested and no CI lane covers it.

1. Install the CLI globally:

   ```sh
   npm install -g superbee
   ```

2. Once superbee is installed, ask your AI agent to run `superbee setup`. Setup walks the
   agent through the remaining integration steps (Agent Skill, SessionStart hook, MCP
   registration) and orients it to the Superbee environment. It is read-only — it inspects
   your configuration and returns one safe next command at a time, so the agent (with your
   approval) performs any actual changes.

Upgrading from the legacy `@holaxis/aslite` package or the retired marketplace plugin? Install
`superbee` alongside it, have your agent run `superbee setup` to migrate the exact legacy
integrations, then remove the old package with `npm uninstall -g @holaxis/aslite`. Existing
`.agentstate-lite/` bundles and `.agentstate.json` bindings keep working with no migration.

## How to use Superbee

Superbee is agent-first: you don't type its commands yourself — you ask your agent for what
you need, and the Agent Skill included with this package helps the agent translate your
instructions into CLI commands. For example:

- "Set up a Superbee workspace for this project and track our tasks in it."
- "Write up what we decided about the auth design as a doc, and link it to the task."
- "What did the last session leave off on? Check the context notes."
- "Sync the board so my teammate's agent sees this."

Behind those requests, the agent drives a small, predictable CLI: `init` creates a bundle in a
conventional `.superbee/` folder (discovered automatically, the way git finds `.git`); `new`,
`doc write`, `doc update`, and `link add` create and connect typed documents; `list` and
`doc read` query them; `sync` shares the board with teammates.

When you want to see the knowledge yourself, ask the agent to open it — or run the two
human-facing commands directly:

```sh
superbee ui --open        # the bundle, rendered: pages, links, backlinks, live Views
superbee doc open <id>    # one exact document in the same local browser reader
```

Run `superbee --help` (or any subcommand with `--help`) for the full command reference.
Design and format docs live in the [repository](https://github.com/Holaxis-ai/superbee).

## License

Apache-2.0 © 2026 Holaxis
