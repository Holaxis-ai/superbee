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
- **Views on demand.** Ask your agent to create whatever representation you need and Superbee will
  create it: a self-contained HTML View, registered in the bundle as a typed document, that
  `superbee ui` launches in a sandboxed iframe. A reading surface for one dense document, a board, a
  timeline, a filtered queue, a chart, a dashboard — the shape follows the question rather than a
  fixed set of built-in screens, and a view worth keeping stays. A data View reads live bundle
  content through a narrow read-only bridge and refreshes as documents change. Views are bundle
  content, so they travel with `sync` and open the same way for a teammate's agent.
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

## How do I download Superbee on Windows?

**Requirements: Node.js 20 or newer on macOS, Linux, or native Windows.** You do not need WSL,
Ubuntu, or Docker. On Windows, Superbee keeps per-user operational state under
`%LOCALAPPDATA%\Superbee`; npm installs the command as `superbee.cmd`.

Superbee currently has two npm release channels:

- `latest` is the stable channel selected by bare `superbee`. Its current release predates native
  Windows support.
- `next` is the prerelease channel. It contains the current native-Windows build.

Install the current prerelease on Windows:

```powershell
npm install -g superbee@next
superbee.cmd setup
```

On macOS or Linux, the stable channel remains available with `npm install -g superbee`. To test the
same prerelease as Windows, install `superbee@next` instead.

After installation, ask your AI agent to run `superbee setup` (`superbee.cmd setup` when invoking
the Windows shim explicitly). Setup walks the agent through Agent Skill, SessionStart hook, and MCP
registration. It is read-only: it inspects your configuration and returns one safe next command at
a time, so the agent performs any actual changes with your approval.

The managed Agent Skill works in Claude Code, Codex, and OpenCode. OpenCode discovers Superbee from
its documented Claude-compatible Skill path. It shares Claude Code's Skill bytes by default; if
Claude Code is explicitly relocated, the installer manages the two documented host paths separately.

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
- "Give me a view of the open tasks grouped by owner."

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
