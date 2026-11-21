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

Use macOS, Linux, or WSL2 for the full CLI. It requires a supported Node.js 22, 24, or 26 release (22.14.0 minimum).

```sh
npm install -g superbee
```

Stable releases publish on npm's `latest` tag and prereleases on `next`. To try the prerelease:

```sh
npm install -g superbee@next
```

### Native Windows Git boards

Native Git board sync requires Node.js 22.17.0 or later in the 22 line, 24.2.0 or later in the 24
line, or Node.js 26. These releases use libuv 1.51.0 or newer, which fixes a Windows file identity
check needed when reading board state. [libuv changelog](https://github.com/libuv/libuv/blob/v1.51.0/ChangeLog)

The `superbee` package from this source also installs on native Windows. To try it before a
release with this feature, install the packed `superbee` tarball from the build with
`npm install -g`, passing the path to the tarball. Install Git for Windows and make `git.exe`
available on PATH. Run `superbee version` to identify the installed build, and
`superbee sync --dir "C:\path to\board"` to synchronize an existing standalone Git board.
Use `--pull-only` to pull without pushing or `--inspect --doc <id>` to read a saved conflict.

Native Windows mode is experimental. Use WSL2 for setup, hosted checkouts, board establishment,
or boards with a configured pre-push sync gate. If such a gate would run, native sync keeps the
commit locally and refuses the push. The Windows install uses `%LOCALAPPDATA%\Superbee` by
default. A launcher can set `SUPERBEE_BOARD_STATE_DIR` to an absolute, writable directory
outside the board to keep Git board state across restarts when that default is unavailable.
This setting applies to Git board state only. Existing credentials and a separately installed
`superbee-windows` executable stay in their existing locations.

Run `superbee version` to see which build you have. `superbee version --check` is not available on published builds yet: it exits 1 with `policy_disabled` and makes no network request. Check the npm page or `npm view superbee version` for the current release.

## First run: let your agent finish setup

`npm install` gives you the CLI. The integrations (the Agent Skill, the `SessionStart` hook, and
MCP server registration, where MCP is the Model Context Protocol) are installed by your agent,
not by hand. Ask it:

> Run `superbee setup` and follow its instructions.

Setup itself changes nothing. It inspects your configuration and returns one safe next command at
a time, and the agent runs each with your approval. Setup knows Claude Code, Codex, and OpenCode,
plus Claude Desktop for the MCP registration only.

For a fresh cloud container, provision Superbee in the environment setup step before agent tool
use. Generated hooks bind absolute Node and CLI paths from their installation, so a project hook
copied from a laptop does not install Superbee or provide a working container launcher. Configure
hooks inside the environment and verify startup in a fresh session. Startup pulls are best-effort;
inspect an explicit `superbee sync` receipt to verify publication of edits.

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
superbee view open <id>   # one exact local registered View, through a private one-use browser handoff
```

In a hosted checkout, `superbee view read <id>` prints a View page's version on the host and
`superbee view update <id> --expected-version <version>` replaces the page there (sync never sends
`views/`). Uploading a page never approves its execution. `superbee view create <name> --title
<title>` adds a new View there from `views/<name>.html`, when you may change the bundle's model.

## Copying documents between bundles

`superbee doc import` copies chosen documents from another bundle with new ids and rewritten links.
Declare the source first, then review the plan before applying it:

```sh
superbee deps add wave --bundle-id <source-bundle-id> --path ../wave
superbee doc import --from wave --with wave=../wave --select type=Theme --prefix wave
superbee doc import --from wave --with wave=../wave --select type=Theme --prefix wave --apply <plan-token>
superbee doc import --from wave --with wave=../wave --refresh <record-id>
```

The first import command only prints the plan and its token. Applying writes new documents and one
Promotion record, and never overwrites a document. `--resume <record-id>` finishes an interrupted
run. `--refresh <record-id>` updates the copies from their sources with the same plan and apply
steps; a copy edited since the import is a conflict until you name it with `--overwrite <id>` or
`--skip <id>`. The target must be a local bundle or Git board. `superbee doc import --help` has the
full reference.

## When a document cannot be read

Superbee bounds how much frontmatter it parses: 262,144 characters of YAML, 32 levels of nesting, and limits on
YAML alias use. Ordinary documents are far below these limits. A write over a limit is refused with
`USAGE` and nothing is stored. A document already in the bundle that is over a limit, or whose YAML
is invalid, cannot be read:

- `doc read` on it fails with `RUNTIME`. `details.frontmatter.code` is `FRONTMATTER_TOO_LARGE`,
  `FRONTMATTER_TOO_DEEP`, `FRONTMATTER_ALIAS_LIMIT`, `FRONTMATTER_CYCLE` or
  `FRONTMATTER_MALFORMED`, and `details.frontmatter.document` names the file.
- To find every affected document, run `superbee status` (the `malformed` count and rows) or
  `superbee list` (the `skipped` rows). `search`, `query`, `index generate`, `link list`,
  `link show`, `view list` and `kinds --coverage` also skip it, say so, and keep working.
- To fix it, edit the lines between the `---` markers in a text editor, or remove the document with
  `superbee doc delete <id>`. `doc update` and `doc field` cannot change a document they cannot read.

On a Git board, `sync` holds a changed file it cannot read: it exits 5, names the file, and commits
and pushes nothing until you fix it. If a conflict kept a version that cannot be read, the receipt
tells you to copy your saved export over the document.

In a hosted checkout, a host document this client cannot store comes back as a `held` row named with
its `FRONTMATTER_*` code, exit 5, and everything else proceeds. The next sync places it once it is
repaired on the host. If the checkout's own local store holds a copy it cannot read, sync stops with
`store_damaged` and sends and places nothing. Reads continue and `status` reports it. Copy out any
unsent edits and make a fresh checkout, as the error's help describes.

## Upgrading from aslite

If you installed the earlier `@holaxis/aslite` package or its marketplace plugin: install
`superbee` alongside it, have your agent run `superbee setup` to migrate the integrations, then
run `npm uninstall -g @holaxis/aslite`. Existing `.agentstate-lite/` bundles keep working. Rename
a `.agentstate.json` binding to `.superbee.json` (same contents), and rename the old environment
variables (`AGENTSTATE_LITE_ACTOR`, `ASLITE_NO_UPDATE_CHECK`, `AGENTSTATE_LITE_NO_AUTOPULL`) to
their `SUPERBEE_*` names. An old name set without its new one is refused with that fix; beside its
new one it is ignored. Remove `AGENTSTATE_LITE_API_KEY` (refused while set) and
`AGENTSTATE_LITE_REMOTE` (refused when a command has no `--dir`): nothing reads them. Hosted bundles
use `superbee login`.

## Learn more

The [repository](https://github.com/Holaxis-ai/superbee) holds the source, the
[CLI contract](https://github.com/Holaxis-ai/superbee/blob/main/packages/superbee/AXI-CONTRACT.md),
and the [wire protocol](https://github.com/Holaxis-ai/superbee/blob/main/docs/WIRE-PROTOCOL.md).
Site builders can read a publication's Site declaration through `superbee/publication/site-manifest`;
see [Site declarations](https://github.com/Holaxis-ai/superbee/blob/main/packages/publication/SITE-MANIFEST.md).

## License

Apache-2.0 © 2026 Holaxis
