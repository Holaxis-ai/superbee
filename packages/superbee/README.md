# superbee

Shared, versioned, conflict-safe knowledge for AI coding agents, stored as plain markdown in
your repo.

Superbee is pre-1.0. Commands and formats may change between releases.

## What is Superbee?

Agents forget everything between sessions, overwrite each other's work, and keep what they know
invisible to the humans they work for. Superbee fixes all three with a **knowledge bundle**: a
folder of markdown documents, by convention `.superbee/` at your project root, that agents read
and write through a small command-line tool.

- **Context that persists.** Agents write context notes, decisions, plans, and research into the
  bundle. The next session, or a different agent, picks up where the last one left off. An
  optional `SessionStart` hook for Claude Code, Codex, and OpenCode orients every new session
  automatically.
- **Safe for many writers.** Each write can carry the actor that made it. A writer can name the
  version it last read; if anyone changed the document since, the write fails with a typed
  conflict error instead of silently overwriting their work.
- **Visible to humans.** The bundle is plain markdown. Open it in any editor, render it on
  GitHub, diff it in git. `superbee ui` serves it locally as cross-linked pages with backlinks and
  a live activity feed. No bundle content leaves your machine until you run `superbee sync`, which
  shares the bundle with teammates through the board: a copy of the bundle kept on its own git
  branch, separate from your code.
- **Views on demand.** Ask your agent for a dashboard, a timeline, a filtered task queue, or a
  reading view of one dense document. It builds a self-contained HTML page, stores it in the bundle
  as a View, and `superbee ui` hosts it in a sandboxed frame. A View reads the bundle live and can
  change it only through a write you confirm. Views are bundle content, so they travel with `sync`.
- **Built for agents.** Output is structured and token-lean, and errors carry a small, stable set
  of exit codes. Agents act on responses without parsing prose or flooding their context window.
- **Yours, and portable.** Bundles follow the Open Knowledge Format (OKF), a convention of
  markdown with frontmatter, so they outlive the tool: hand the folder to someone else, or read it
  with anything that speaks markdown. New bundles are written as OKF v0.2, and existing v0.1
  bundles keep working as they are. Reading and writing the bundle works offline; only sharing
  needs a network. The document schemas, called kinds, live inside the bundle, so it describes
  its own structure.

Bees build comb one cell at a time. The comb holds what the colony gathers, and its shape shows
the next bee where to build and what belongs where. Superbee works the same way: people and
agents record what they learn in a structure that fits their domain, and that structure guides
whoever works next. Each session builds on the last instead of starting over.

The npm package is one self-contained executable with zero runtime dependencies, plus an Agent
Skill, an instruction file your agent loads, that teaches it how to use the tool.

## Install

Requires Node.js 20 or newer on macOS and Linux. Native Windows is not supported by this package.

```sh
npm install -g superbee
```

Stable releases publish on npm's `latest` tag and prereleases on `next`. To try the prerelease:

```sh
npm install -g superbee@next
```

Windows adapters and the `superbee-windows` executable live in a separate repository and are
not included in `superbee`. Most Windows users should run Superbee in WSL2, where npm sees a
Linux platform and the normal installation applies. An experimental, unsupported native Windows
build is available as open source, with build-from-source instructions: https://github.com/Holaxis-ai/superbee-windows-cli

### Upgrading an existing Windows installation

The first release containing the Windows extraction removes native Windows support from this
package. Its npm `os` metadata permits only `darwin` and `linux`, so a Windows upgrade to an affected
version is rejected with `EBADPLATFORM`. This applies to existing prerelease users too. Forcing the
installation does not restore support: the executable refuses commands on unsupported hosts
before running them (the bare `--version` flag can still identify the installed build).

There is no supported Windows replacement on npm. The alternatives are WSL2 or the experimental
build from source at https://github.com/Holaxis-ai/superbee-windows-cli; neither carries a
first-party support promise for native Windows. An older installed version is not converted or
removed by this source change, and existing bundle files are not migrated by it. Review the affected release's notes before changing an existing
Windows installation. macOS/Linux users can continue using the normal installation and setup flow.

Run `superbee version --check` to compare your install with the current stable release.

## First run: let your agent finish setup

`npm install` gives you the CLI. The integrations (the Agent Skill, the `SessionStart` hook, and
MCP server registration, where MCP is the Model Context Protocol) are installed by your agent,
not by hand. Ask it:

> Run `superbee setup` and follow its instructions.

Setup itself changes nothing. It inspects your configuration and returns one safe next command at
a time, and the agent runs each with your approval. Setup knows Claude Code, Codex, and OpenCode,
plus Claude Desktop for the MCP registration only.

## Everyday use

You rarely type Superbee commands yourself. You ask your agent, and the Agent Skill translates the
request into CLI calls:

- "Set up a Superbee bundle for this project and track our tasks in it."
- "Write up what we decided about the auth design as a doc, and link it to the task."
- "What did the last session leave off on? Check the context notes."
- "Sync the board so my teammate's agent sees this."
- "Give me a view of the open tasks grouped by owner."

Behind those requests the agent uses a small set of commands: `init --dir .superbee` creates the
bundle, `new` creates a document of a declared kind, `doc write` writes a free-form one,
`doc update` changes a document, `link add` connects two, `list` and `doc read` query them, and
`sync` shares the board. `superbee --help` lists the commands, and `superbee <command> --help`
gives each one's full reference.

The two commands meant for you are the ones that show you the knowledge:

```sh
superbee ui --open        # the whole bundle, rendered in your browser
superbee doc open <id>    # one document, by an id from `superbee list`
```

## Upgrading from aslite

If you installed the earlier `@holaxis/aslite` package or its marketplace plugin: install
`superbee` alongside it, have your agent run `superbee setup` to migrate the integrations, then
run `npm uninstall -g @holaxis/aslite`. Existing `.agentstate-lite/` bundles and
`.agentstate.json` bindings keep working with no migration.

## Learn more

The [repository](https://github.com/Holaxis-ai/superbee) holds the source, the
[CLI contract](https://github.com/Holaxis-ai/superbee/blob/main/packages/superbee/AXI-CONTRACT.md),
and the [wire protocol](https://github.com/Holaxis-ai/superbee/blob/main/docs/WIRE-PROTOCOL.md).

## License

Apache-2.0 © 2026 Holaxis
