# superbee

**An OKF-native, CLI-first, agent-facing knowledge store.** Context notes, docs, cross-links,
and live bundle Views — as a plain folder of user-owned files that works offline,
with an optional wire backend when a separate service hosts the bundle. `superbee` is the
[Superbee](https://github.com/Holaxis-ai/superbee) project's CLI. Its historical `aslite` and
`agentstate-lite` commands remain supported aliases for existing installations.

The npm artifact ships one self-contained executable file with **zero runtime dependencies**,
plus the generated Agent Skill (`SKILL.md` and its `references/` folder — installable into host
skill folders with `superbee skill install`). npm is the sole executable distribution channel;
the installed Skill contains guidance and references, not a second CLI copy. Maintainers can
reproduce the complete package proof from the
repository root with `npm run verify:npm-package`; it builds, packs, installs into an isolated
prefix, resolves both command names from `PATH`, and exercises an offline bundle workflow. This
developer proof deliberately stamps `local-dev`, so it works on an in-progress/dirty checkout;
`prepublishOnly` runs the same journey in strict `npm-package` mode and refuses unless Git proves
an exact clean source commit.
Install the supported default once (`superbee` is canonical; `aslite` and `agentstate-lite` remain
compatible aliases), then run the first-value flow from an ordinary project directory:

```sh
npm install -g superbee
superbee
superbee recipes
superbee init --create-only --recipe work-tracking --dir .agentstate-lite
superbee new "Task" first-task --title "Plan the first change" \
  --status todo --actor quickstart-agent --dir .agentstate-lite
superbee --dir .agentstate-lite
```

`--create-only` fails before writing when the selected target is occupied or ambiguous. Use
`recipe add` instead when you intend to modify an existing bundle. Bring source material or intent
to your agent in the tool you already use. The agent organizes, types, links, and updates the
bundle through `superbee`; these commands are the plumbing, not a manual data-entry workflow.

`quickstart-agent` is an advisory example actor label; replace it with the actual agent identity.

Existing `.agentstate-lite/` bundles and `.agentstate.json` bindings need no migration. To try one
orientation command without installing anything, run `npx -y superbee`.
Install the optional Agent Skill after the global install if you want guidance for Claude Code and
Codex:

```sh
superbee skill install --scope user # optional guidance for Claude Code + Codex
```

If upgrading from the retired marketplace plugin, remove or disable that plugin, then rerun both
`superbee skill install --scope user` and `superbee hook install --scope user`. The hook installer
replaces exact historical AgentState marketplace hooks instead of adding a duplicate.

## What it is

A knowledge bundle is a directory of markdown that conforms to the **Open Knowledge Format
(OKF)** — so it survives the tool: open it in any editor, render it on GitHub, diff it in git,
hand it to someone else. On top of that portable format, `superbee` adds an agent-facing
CLI (TOON output, a capped exit-code taxonomy, structured errors) and a local UI for live bundle
Views.

- **Local-first.** Everything works with the network off; the filesystem is the source of truth.
- **Agent-native.** The primary interface is a small, predictable CLI designed to be driven by
  AI agents, with a `SessionStart` hook installer for Claude Code / Codex / OpenCode.
- **Human-visible.** `superbee ui --open` opens a local browser window over the bundle: read its
  docs as rendered pages (cross-links you can follow, derived backlinks), see a live activity
  feed and the bundle's sharing status, and launch its registered Views — which present live data
  through the read-only v0 bridge or propose one human-confirmed local scalar action through v1.
  (`Page` is the retired legacy name for the View kind — legacy-named content no longer
  registers; `superbee status` flags it and the repo's migration script renames it in place.)

## Optional: a shared remote bundle

Run the reference server over a local bundle, then point any command at it with `--remote`:

```sh
superbee serve --dir ./my-bundle    # loopback, keyless reference server
superbee list --remote http://127.0.0.1:4818
```

The public package intentionally stops at this generic wire boundary. It does not ship a hosted
deployment, identity system, account-administration commands, or cloud-provider recipe. A separate
service can implement the same versioned storage and HTTP contracts without changing the local
engine or CLI.

## Documentation

Run `superbee --help` (or any subcommand with `--help`) for the full command reference.
Design and format docs live in the repository.

## License

MIT © Holaxis
