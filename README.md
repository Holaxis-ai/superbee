# Superbee

> A markdown knowledge bundle in your repo, plus a CLI built for agents.

Coding agents forget everything between sessions, overwrite each other's work, and keep
what they know invisible to the humans they work for. Superbee gives them
shared, versioned, conflict-safe memory in plain text — offline-first, standards-based,
owned by you.

**Status: early and experimental.** A public npm prerelease is available for testing; formats and
commands will change without ceremony, and some of the project's biggest ideas are still bets
under test. The honest breakdown is below — read it before depending on anything.

## Install

Install the test-user prerelease from npm. The package puts the stable command `superbee` on
`PATH`; its optional Agent Skill teaches Claude Code and Codex how to use that command without
carrying another copy of the executable:

```sh
npm install -g superbee
superbee --version
superbee skill install --scope user
superbee hook install --scope user
```

Restart Claude Code or Codex after installing the skill. `hook install` is optional: it gives
Claude Code, Codex, and OpenCode a compact Superbee orientation at session start. To try one
orientation command without installing anything, run `npx -y superbee`.

The npm package is the sole executable distribution channel. The optional Agent Skill contains
guidance and references only; it invokes the npm-installed CLI rather than carrying another copy.
If upgrading from the retired marketplace plugin, remove or disable that plugin, then rerun
`superbee skill install --scope user` and `superbee hook install --scope user`. The hook installer
replaces exact historical AgentState marketplace hooks rather than leaving two SessionStart hooks.

## Quickstart

```sh
superbee                                   # confirm that no bundle is selected yet
superbee recipes                           # compare the workspace setups shipped offline
superbee init --create-only --recipe work-tracking --dir .agentstate-lite
superbee new "Task" first-task --title "Plan the first change" --status todo \
  --actor quickstart-agent --dir .agentstate-lite
superbee --dir .agentstate-lite            # see the Task in the live bundle summary
```

`--create-only` refuses an occupied, nested, bound, or concurrently claimed target before it
writes; use `recipe add` when you deliberately want to add capability to an existing bundle.
Bring source material or intent to your agent in the tool you already use. The agent organizes,
types, links, and updates the bundle through `superbee`; these commands are the plumbing, not a
manual data-entry workflow.

`quickstart-agent` is an advisory example actor label; replace it with the actual agent identity.

New bundles currently default to OKF v0.1. To start a v0.2 bundle explicitly, add
`--okf-version 0.2` to `init`; built-in recipes then materialize their logical workflow fields at
the v0.2 producer-qualified coordinate. This does not migrate an existing v0.1 bundle.

The conventional `.agentstate-lite/` folder at the project root is discovered with zero
config (the way git finds `.git`) — every command after setup runs bare from anywhere in
the project tree. A bundle stays local until `sync --establish` explicitly shares it on the
repository's dedicated `board` branch.

Existing `.agentstate-lite/` bundles and `.agentstate.json` bindings continue to work with
Superbee; no migration is required. When the first task needs a roadmap, run
`superbee recipe add roadmap`. To share the local bundle, run `superbee sync --establish`; that
explicit step creates the remote `board` branch, and teammates then use ordinary `superbee sync`.

**When the conventional project folder does not fit:**

- **Project binding:** preferred `.superbee.json`, with `.agentstate.json` retained for existing
  projects. Either is a committed local pointer (`{ "bundle": "<path>" }`) for an out-of-tree
  directory and beats the conventional folder. Both names at the same level are a conflict rather
  than an implicit choice. Remote access is never
  ambient: pass `--remote <url>` explicitly. Legacy URL bindings and `AGENTSTATE_LITE_REMOTE`
  fail with migration guidance instead of activating HTTP.
- **Private workspace:** the bundle lives outside the repo (for example,
  `~/.agentstate/<name>/`); a git-excluded binding points at it, and nothing enters the repo.
- **Personal catalog:** register any local bundle under a user- or agent-defined label so it is
  visible when an agent starts outside that project. The catalog is explicit and machine-local:
  it never crawls, clones, or creates an ambient active workspace. Resolve a label to a path, then
  pass that path to an ordinary command:

  ```sh
  superbee catalog add personal --dir ~/.agentstate/personal
  superbee catalog list
  superbee catalog resolve personal --field path
  ```

Then, day to day:

```sh
export SUPERBEE_ACTOR=claude           # optional default; per-command --actor wins
superbee new "Task" ship-parser --title "Ship the parser" --status todo
superbee list --type Task
superbee doc update tasks/ship-parser --status in_progress
superbee doc history tasks/ship-parser # who changed what, when
superbee ui                            # the bundle, rendered — local server, no cloud
superbee index generate                # optional: complete portable Markdown navigation
superbee sync                          # ordinary shared-board updates — commits yours,
                                       # pulls theirs, pushes; leaves code files untouched
```

`init` always makes a LOCAL bundle; `sync` is the verb that establishes or joins a SHARED
one. `sync --establish` is the one-time, explicit act that turns this project's local
bundle into a shared board (a `board` branch on the repo's remote) — never automatic, so
a bare `sync` never silently publishes a bundle nobody asked to share. Once a board
exists (here or on a teammate's clone), plain `sync` is everyone's setup AND ongoing verb:
a fresh clone's first `sync` provisions the board from origin; a project with a local
bundle but no shared board reports its local-only state honestly (changes stay on this
machine) and routes to `--establish`. If origin cannot be checked, sync reports the
shared-board state as unknown and waits for a retry instead of recommending publication.
When a doc changed on both sides, sync
converges: your teammate's version is kept, yours is saved to an export file, and
`sync --show-incoming <id>` + `doc update` reconcile — no git surgery. Bundles committed
directly to a code branch are also supported as the IN-TREE mode: board docs travel with
your normal commit/push/pull, `sync --pull-only` fetches the branch's upstream and reports
incoming board changes (session start shows the same awareness), and a full `sync` refuses
with guidance — `sync --establish` is the explicit conversion to a dedicated board branch.

`sync --establish` also handles the project that already committed `.agentstate-lite/` to
its code branch: it prints a preview first, and `--yes` executes — publishing the board
branch from the folder's current files and preparing a cleanup commit on a side branch
that you open as a PR (the folder leaves the code branch; the board takes over after the
merge).

Establishment also appends `.agentstate-lite/` to the root working-tree `.gitignore` and
reports that uncommitted edit; ordinary sync does not modify code-project files.

**If you see a `board` branch** in a repo that uses Superbee: that is the shared
board — an orphan branch carrying only the knowledge bundle, written by `superbee sync`. It
never merges into `main` (it shares no history with it, by design). Protect it the way
you protect `main`: enable delete and force-push protection on `board` in the repo
settings — sync only ever appends commits to it.

## How it works

- **Every concept is a typed markdown document.** One required frontmatter field — `type` — plus
  whatever fields its schema declares. New concepts are new types, not new subsystems. Byte-exact
  artifacts such as View HTML live as blobs referenced by those documents.
- **Portable navigation is explicit.** `index generate` creates a complete relative-link
  `index.md` hierarchy for GitHub, ordinary editors, and copied folders. It refreshes only marked
  generated files and refuses curated indexes unless `--force` deliberately adopts them.
- **Schemas are documents too.** A "kind" is declared by a convention doc inside the
  bundle; validation fires at write time (warn by default, `--strict` to reject). The
  bundle describes itself.
- **Schema guidance travels with the data.** Kinds can describe the concept itself, individual
  fields, enum values, and relationship labels; the CLI projects that guidance through `kinds`
  and kind-specific `new --help` output so agents do not need a separate live explanation.
- **Relationships are ordinary markdown links with convention-declared semantics.** A kind can
  name and describe allowed outbound link labels and expected inbound relationships; the CLI can
  warn or lint mismatches and query exact link labels. Backlinks are always derived, never stored.
- **Writes are compare-and-swap.** Every document state has a content-addressed
  version; a racing writer gets a typed conflict instead of silently losing an update.
  Every mutation is attributed.
- **Storage is a seam.** The engine holds all semantics; filesystem, memory, and wire
  backends plug in underneath with byte-identical version tokens.
- **Recipes install capability as text.** A recipe is a folder of definitions, applied
  idempotently — it seeds schemas and may carry explicitly declared static References and
  self-contained Views, then the bundle owns them. A `definitions-only` package rejects instance
  data and undeclared files. Three
  recipes ship built-in (`context-notes`, `work-tracking`, `roadmap`);
  `examples/recipes/claims` is the minimal custom-Kind example, while
  `examples/recipes/review-workflow` is a complete content-free cognitive ecosystem: a
  self-describing Review Request kind plus a generic live View, with no review instances.

Bundles are valid [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
v0.1 or v0.2 — plain markdown any conformant tool can read. New bundles default to v0.1; explicit
v0.2 creation is available with `init --okf-version 0.2`.

## What's solid

- The engine and the storage seam: a broad suite across four workspaces, with the
  filesystem, memory, and wire backends pinned to byte-identical version tokens.
- The CLI surface, built agent-first: structured output, counts and truncation with
  escape hatches, idempotent mutations, a small stable exit-code taxonomy.
- The byte channel (`promote`/`pull`) for artifacts that should never enter a model's
  context window.
- Project discovery: a committed `.agentstate-lite/` folder (or an explicit `.superbee.json` /
  supported `.agentstate.json` binding) resolves the bundle for any agent on any machine with zero
  prior context.

## What's early or experimental

- **Everything is pre-1.0.** The npm package is a prerelease and breaking changes are likely.
- **Recipes as composition** is a thesis under test, not a result. The repository includes
  small first-party definitions-only packages, including a Kind-plus-View reference, but package
  dependencies, upgrades, migrations, and marketplace discovery remain future work. "Cookbooks"
  (composed recipes with typed-link glue) are design intent only.
- **Bundle Views and the local web UI** are functional but still early. `ui` launches registered
  Views in sandboxed iframes; data Views receive a narrow read-only bridge with live change events,
  while `bundle-propose` Views may ask trusted shell chrome to confirm one local, CAS-guarded
  scalar-field change. Content Views receive no bundle-data capability. Views can navigate to other registered
  Views, and View-bearing definitions-only recipes can carry the operating model, registry entry,
  HTML, and authoring reference together. (`Page` is the legacy name for the kind and is no
  longer read — a legacy `type: Page` doc does not register, and the legacy `bridge:` field
  grants nothing; `superbee status` flags leftover legacy names and the repo's
  `migrate-legacy-view-names` script renames them in place. Legacy folder locations stay
  recognized.) Authoring is still HTML/agent-driven rather than a
  polished end-user builder, so treat the surface as a preview.
- **The public package ends at a generic remote boundary.** `serve` exposes a bundle through the
  versioned wire protocol, and bundle commands can target a service explicitly with `--remote`.
  A gated service may accept `SUPERBEE_API_KEY` (`AGENTSTATE_LITE_API_KEY` remains supported) or an already-provisioned stored per-origin
  credential. This repository ships no hosted deployment, identity system, account-administration
  commands, or cloud-provider package.
- **Wire protocol v0.1** is evolving. One recorded caveat: a document's raw bytes
  re-serialize to canonical form over the wire; blobs are the byte-exact channel.
- **Filesystem CAS is serialized across same-user local processes** with an external per-target runtime lock.
  A process crash can leave a diagnosable lock behind; writes fail closed until it is inspected
  and removed rather than silently stealing an ambiguous lock.
- **Richer graph semantics** remain open: conventions type outbound links and can require at least
  one matching inbound relationship today, but richer cardinality, cross-edge constraints,
  workflow rules, and automation are intentionally not a second graph engine yet.
- OKF itself is young and evolving; we track it as it changes.

## Where the deep documentation lives

This project dogfoods itself: the plans, research, design docs, product statement, and
the full change history live in the project's own Superbee bundle, which the
team develops against daily. The repo deliberately carries only this README,
`CLAUDE.md` (agent-orchestrator conventions), and the code.

## License

MIT © 2026 Holaxis
