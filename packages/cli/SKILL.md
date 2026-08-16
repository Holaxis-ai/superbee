---
name: superbee
description: >-
  Read and write a local OKF knowledge bundle (agent context notes, docs, cross-links, and live
  bundle Views) from the shell via the Superbee CLI. Use when an agent
  needs to persist a context note across sessions, store a decision/spec as a doc, link concepts,
  query a bundle, share the project's board with teammates (`sync`), or open its local View UI.
  Runs standalone via `npx -y superbee`.
---

# superbee

read and write a local OKF knowledge bundle (context notes, docs, cross-links, live bundle Views).

It is a standalone npm package (`superbee`) installing three bins for the identical CLI: `superbee` and the
legacy aliases `aslite` and `agentstate-lite`. Every example below uses `superbee`.

Output is TOON on stdout (a `--json` hatch exists). Errors are structured TOON on stdout with a
capped exit-code taxonomy (0 ok/no-op, 2 usage, 4 auth, 5 conflict, 6 not-found, 1 runtime).

<!-- GENERATED from src/reference.ts by scripts/gen-skill.mjs — do not edit by hand. -->

## If `superbee` is not on PATH

Every example below assumes the `superbee` bin is on PATH. If it is not:

- `npm install -g superbee` puts it (and the legacy aliases `aslite` and `agentstate-lite`) on PATH.
- `npx -y superbee …` runs any command below with no install at all — swap the leading `superbee`
  for that prefix and the rest of the line runs unchanged.

## Complete host setup

After the global npm install, run:

```sh
superbee setup
```

Without `--host`, setup returns the four supported host rows. Select the exact host running
this agent, run that row's command, then follow the one `next.command` in each host-scoped
plan, filling any explicit placeholder it identifies. Setup is read-only: it composes npm,
Skill, Hook, MCP, bundle, and catalog status but never treats detection as permission to write.
Ask the human before running a returned mutating command. Restart the host after Skill, Hook,
or MCP changes, then rerun the same setup command to verify. Foreign or unreadable state
returns a read-only inspection command instead of overwriting it.

## Stable MCP launch

For a persistent MCP integration, install the supported CLI with
`npm install -g superbee`, then run `superbee mcp install --host <id>` with the exact
current host: `codex`, `claude-code`, `claude-desktop`, or `opencode`. The command
registers the durable npm runtime once at user scope, never an npx cache or one bundle directory.
Use `superbee mcp status --host <id>` to verify it and restart the host after a change.

## Commands

### Bundle

- `superbee bundle locate [--dir <path>]`
  — Resolve the exact canonical local bundle path and report why it won selection
- `superbee catalog (add <label> [--dir <path>] | list | resolve <label-or-id> [--field path])`
  — Register and deterministically resolve this user's explicitly named local workspaces
- `superbee init [--dir <path>] [--okf-version <v>] [--recipe <name-or-path>] [--create-only]`
  — Create (or open) an OKF knowledge bundle in a directory — greenfield setup; a project that already shares a board is set up by sync, not init. --create-only requires a genuinely NEW target and refuses existing, non-empty, symlinked, enclosing, bound, or concurrent targets before publication; runtime failures retain and report any empty directories they created instead of deleting them — 'recipe add' modifies a verified existing bundle
- `superbee index generate [--dir <path>] [--check] [--force] [--actor <name>]`
  — Generate complete portable Markdown navigation explicitly; refuses curated indexes unless --force adopts them
- `superbee status [--limit <n>] [--remote <url>]`
  — Read-only bundle health report (kind lint, unresolved links, orphans, staleness, graph lints)

### Documents & links

- `superbee doc write <id> --type <t> [--title <t>] [--body <s> | --body-file <p>] [--actor <n>] [--remote <url>]`
  — Write a generic OKF concept document
- `superbee doc update <id> [--<field> <value> ...] [--title <t>] [--tag <t>] [--type <t>] [--body <s> | --body-file <p>] [--expected-version <v>] [--actor <n>] [--remote <url>]`
  — Patch given fields (incl. kind-declared fields like --progress_status) of an existing doc, preserving the rest; optimistic-CAS with --expected-version
- `superbee doc read <id> [--out (<path> | -) | --body-out (<path> | -) | --field <name>] [--remote <url>]`
  — Read a doc, export its raw markdown, export its body with a same-read CAS version, or print one raw field for scripting
- `superbee doc open <id> [--dir <path> | --remote <url>] [--port <n>] [--actor <name>]`
  — Open one exact authoritative document in the existing rendered browser UI
- `superbee doc history <id> [--limit <n>] [--remote <url>]`
  — Show a doc's version history (newest first, capped at 20 by default — --limit 0 for all; a history-keeping backend returns the full attributed chain, a local bundle just the current revision) — the tokens for --expected-version
- `superbee doc delete <id> [--expected-version <v>] [--remote <url>]`
  — Hard-delete a doc (idempotent: absent -> deleted:false, exit 0)
- `superbee list [--type <t>] [--tag <t>] [--field <k=v>] [--prefix <p>] [--open] [--limit <n>] [--remote <url>]`
  — Query concepts over their frontmatter (alias: query) — a comma in --field's value is set membership (OR); --open excludes terminal instances (declared kinds only)
- `superbee link (add <from> <to> [--text <t>] [--actor <n>] | show <id> [--limit <n>] [--text <t>] | list [--from <id|prefix/>] [--to <id|prefix/>] [--text <t>] [--limit <n>]) [--remote <url>]`
  — Add a cross-link, show a concept's links + backlinks, or query the whole bundle's derived edge list filtered by from/to (id or prefix/, repeatable/union) and exact-match text

### Artifacts

- `superbee artifact create <file> --title <title> [--description <text>] [--supersedes <id>] [--actor <n>] [--remote <url>]`
  — Produce a shareable output (HTML) a human can view: one command promotes the bytes and writes the type:Artifact record
- `superbee promote <file> --doc-key <key> [--content-type <mime>] [--expected-version <v>] [--remote <url>]`
  — Move a local file's bytes into the store (a .md key routes through the engine; else a blob)
- `superbee pull --doc-key <key> --out (<path> | -) [--remote <url>]`
  — Pull a doc's canonical form or a blob's raw bytes out of the store (the reverse of promote)
- `superbee blobs [--prefix <p>] [--limit <n>] [--remote <url>]`
  — List the store's blob (non-document) keys (documents are listed by 'list'/'query')
- `superbee delete --doc-key <key> [--expected-version <v>] [--remote <url>]`
  — Hard-delete a doc or blob by key (idempotent: absent -> deleted:false, exit 0)

### Kinds

- `superbee new "<Kind>" <id> --<field> <value> [...] [--body <markdown> | --body-file <path>] [--link "<type>=<target-id>" ...] [--no-prefix] [--actor <n>] [--remote <url>]`
  — Create a new instance of a bundle-declared kind — initial Markdown may come from --body or --body-file (otherwise declared sections are scaffolded); validates strictly, and repeatable --link wires typed cross-links in the same step
- `superbee kinds [--remote <url>]`
  — List the kind conventions this bundle declares (purpose, described fields, exact required body headings, typed-link vocabulary, horizon)
- `superbee kind field "<Kind>" (add <name> [--required] [--values <a,b,c>] | remove <name>) [--remote <url>]`
  — Edit a kind's schema — add/remove a declared field or enum value on its convention (idempotent)
- `superbee recipes [--dir <path>] [--remote <url>]`
  — Browse built-in recipes before or after init; with a bundle, also show whether each is already applied
- `superbee recipe add <name-or-path> [--remote <url>]`
  — Apply a recipe's content-free definitions — Kinds plus optional declared References and Views — idempotently

### Remote

- `superbee serve [--dir <path>] [--host <h>] [--port <p>]`
  — Boot the reference wire-protocol server over a local bundle (loopback, no auth)
- `superbee ui [--dir <path> | --remote <url>] [--port <p>] [--open]`
  — Boot the local web UI over the bundle (same origin, loopback-only): READ the bundle's docs as rendered pages (frontmatter, cross-links you can follow, derived backlinks), LAUNCH its registered Views (type: View docs framed in sandboxed iframes with live updates; legacy Page-typed docs no longer register — see status's legacy_naming finding), and see a live activity feed, the bundle's sharing status, and your registered workspaces. The header shows the bundle's display name — derived from the project folder unless set explicitly: doc write docs/bundle --type "Bundle Name" --title "<name>"
- `superbee mcp [install|status|uninstall | --dir <path>]`
  — Run the local MCP Apps adapter, or explicitly install, inspect, and uninstall its user-level registration for Codex/ChatGPT, Claude Code, Claude Desktop, and OpenCode
- `superbee view list [--limit <n>] [--dir <path> | --remote <url>]`
  — List the bundle's registered durable Views from the same catalog used by the web launcher and MCP list_views
- `superbee sync [--establish [--yes] | --pull-only | --show-incoming <id> [--out <file>]] [--dir <path>] [--limit <n>]`
  — Share the board branch with a remote — commits, pulls, and pushes (git tier; --pull-only skips commit+push). `init` makes a LOCAL bundle; --establish is the separate, explicit act that starts sharing it (creates the board branch, pushes; never automatic). A bundle folder already committed on the code branch is the same flag's hard case: preview first, --yes executes, and the folder's removal from the code branch rides a prepared side-branch commit you push and open as a PR. A bundle committed with code and NO board branch anywhere is the IN-TREE mode (read-side): full sync refuses (sharing rides your normal commit/push), --pull-only fetches the branch's tracking upstream and reports incoming board docs ('git pull' delivers them), and --establish converts to a dedicated board branch. A doc changed on both sides converges: teammate's version kept, yours exported; --show-incoming <id> (exclusive with --pull-only) prints the incoming version as of the last fetch. Board-reading commands (list/doc read/status/home/link show) auto-run the ff-only pull when board state is >~5m stale — silent, bounded (~2s), never a push; SUPERBEE_NO_AUTOPULL=<any value, even 0> disables it

### Session

- `superbee version [--check] [--tag latest|next] [--json]`
  — Show the complete local build/runtime identity, or perform one bounded read-only comparison against npm's exact latest/next release policy
- `superbee session-start [--dir <path>] [--no-update-check]`
  — The SessionStart hook payload: pull then render; default TOON uses a nonblocking 24-hour cached latest check, while --no-update-check or SUPERBEE_NO_UPDATE_CHECK/NO_UPDATE_NOTIFIER/CI presence disables both display and refresh (legacy ASLITE_NO_UPDATE_CHECK remains supported); npm receives only the public package request and ordinary network metadata, never installed version, cwd, bundle, actor, or usage data
- `superbee hook install|status|uninstall [--scope project|user]`
  — Install the SessionStart hook (runs session-start: pull the board, then render) for Claude Code, Codex, OpenCode
- `superbee skill install|status|uninstall [--scope project|user]`
  — Install this package's Agent Skill (SKILL.md + references/) into Claude Code and Codex skill folders (OpenCode has no skill surface — its integration is `hook install`); manifest-tracked, idempotent, refuses folders it does not manage
- `superbee setup [--host codex|claude-code|claude-desktop|opencode] [--scope project|user] [--json]`
  — Inspect npm, Skill, Hook, MCP, bundle, and catalog readiness, then emit one deterministic safe next command

## Workspaces — the project's bundle lives at `.agentstate-lite/` in the project root

Unless the user directs otherwise, a project's workspace bundle lives in a `.agentstate-lite/`
folder at the project root. Two verbs, two different jobs — `init` always creates a LOCAL
bundle (solo use is first-class, nothing forces sharing); `sync` is how a project's board
becomes — or stays — shared memory across clones and teammates. Three modes:

- **A local-only board** — `init` creates a bundle that doesn't exist anywhere yet, and it
  stays LOCAL until someone chooses to share it. This is a first-class mode, not a limbo:
  everything works offline and remote-free, and board changes stay on this machine. A bare
  `sync` on a local-only bundle reports that state honestly (its note points at `--establish`)
  — it never establishes on its own, which would silently publish a bundle nobody asked to
  share.
- **Joining an existing shared board** — if `.agentstate-lite/` is already in the clone, there
  is NOTHING to set up. If it isn't but the project already shares its board (the repo's
  remote has a `board` branch), `sync` is the setup verb — run it once and it creates the
  folder and pulls the shared state. NEVER init a project that already has a workspace: that
  creates a divergent second bundle.
- **Sharing a board (`sync --establish`, once)** — the explicit act that publishes a local
  bundle as the repo's `board` branch; teammates then just run `sync` to join. It handles
  both shapes: an uncommitted local folder is snapshotted, pushed, and converted in place;
  a folder ALREADY COMMITTED on the code branch gets a preview first — re-run with `--yes`
  to execute, which also prepares a cleanup commit on a side branch that you push and open
  as a PR (it removes the folder from the code branch; the board branch takes over after the
  merge). If origin cannot be checked, `sync` reports the shared-board state as unknown and
  waits for a retry instead of recommending publication.

```sh
superbee sync                            # existing shared project — provisions the board; a local-only bundle reports its state
superbee init --dir .agentstate-lite     # greenfield — idempotent; creates a LOCAL bundle, or opens an existing one
superbee sync --establish                # establish a new shared board after user approval
```

That's the whole setup. The CLI discovers the conventional folder on its own (the way git
finds `.git`), so every command runs BARE from anywhere in the project tree — no flags, no
config files:

```sh
superbee list
superbee doc read context-notes/cycle-1
```

Surfaces that label the workspace (the `ui` header, home's bundle block) derive its DISPLAY
NAME from the project folder's name. To set it explicitly (it syncs to teammates with the
board), write the well-known name doc — its title becomes the display name:

```sh
superbee doc write docs/bundle --type "Bundle Name" --title "<display name>"
superbee doc update docs/bundle --title "<new name>"   # rename later
```

The folder is LOCAL until you choose to share it: `superbee sync --establish` (once) publishes it
onto its own `board` branch — from then on `sync` commits and pushes board changes itself, never
batched with code. Until established, the bundle stays local — a fully supported mode, not a
temporary one: everything works offline and remote-free, and board changes stay on this machine
(either left uncommitted, or committed directly on the code branch like any other file,
whichever the user prefers). (Gitignore the folder only if the workspace should stay private
to this machine.)

Write with attribution: set `SUPERBEE_ACTOR=<your-name>` once for `new`, `doc write`,
`doc update`, and `link add`, or pass `--actor <your-name>` per command (the flag wins).
Existing `AGENTSTATE_LITE_ACTOR` settings remain supported as a compatibility input.
With neither source, no advisory actor label is stored in frontmatter or sent as an agent label;
backend history still reports its own principal (for example, the local OS owner or an
authenticated remote user). A present-but-blank flag or environment value is a usage error.
Advisory attribution describes a real mutation and never creates a no-op write.
Actor labels are advisory metadata, not authentication or authorization credentials.

Each invocation is stateless. HTTP is activated only by explicit `--remote <url>`.
Otherwise bundle resolution stays local: explicit `--dir` → nearest `.superbee.json` or
supported `.agentstate.json` local-path binding up-tree → the cwd walk, which at each
ancestor checks both binding names together (both at one level fail closed), then the
directory's own `index.md`, then its
conventional `.agentstate-lite/index.md`. Reserve `--dir` for the exceptions: a bundle outside
any project, a second workspace, or reaching another project's bundle from elsewhere.

Two things override the default:

1. **Explicit user direction** — the user names a directory or a `--remote`; use that. A local
   `.superbee.json` binding (`{ "bundle": "<path>" }` at the project root) is the
   preferred durable form; existing `.agentstate.json` bindings remain supported. A binding
   beats the conventional folder; both binding names at one level are a conflict.
   Remote URLs are never durable ambient bindings; pass `--remote <url>` per invocation.
2. **An existing workspace** — if a bare command already resolves (a binding, an enclosing
   bundle, or a conventional folder exists up-tree), that IS this project's workspace — use
   it rather than creating a second one.

If the user wants the workspace PRIVATE to their machine instead of shared (a personal
scratch workspace), keep the bundle OUT of the repo (e.g. under `~/.agentstate/<name>/`)
and point a git-excluded `.superbee.json` at it. Choose by one question: do teammates
share this bundle? When the user's intent is ambiguous, ask rather than defaulting silently.

Do not raise a sharing decision during ordinary local work. When the user names teammates,
a shared board, a handoff, synchronization, or cross-clone coordination, use Superbee's
built-in board path: run `sync` to join an existing `origin/board`; if none exists, explain
that `sync --establish` creates it and offer to run that explicit one-time operation. If the
user prefers an in-tree bundle, custom Git branch/path, or another sharing mechanism, surface
the tradeoff and record that explicit choice; never silently substitute one for Superbee sync.

## Typical flow

```sh
# One-time setup at the project root (see the Workspaces section) — run ONE of these:
superbee sync                          # existing project that shares a board — sets up AND pulls the shared board
superbee init --dir .agentstate-lite   # GREENFIELD — never on a project that already has a workspace; makes a LOCAL bundle

# If collaboration is requested, offer the explicit one-time shared-board operation:
superbee sync --establish

# Everything after runs bare, from anywhere in the project tree
# Create a complete context note (an OKF concept) for the next session in one command
superbee new "Context Note" cycle-1 --title "cycle-1" --body '# Summary

What this session did and what comes next' --actor <your-name>

# Read it back
superbee doc read context-notes/cycle-1

# Store a doc, cross-link it, and query the bundle
superbee doc write specs/auth --type Spec --title "Auth" --body "…" --actor <your-name>
superbee link add specs/auth context-notes/cycle-1
superbee list --type Spec

# For a shared board, sync after a unit of work; local-only work stays complete locally
# (safe everywhere: a local-only board reports its state; outside any workspace it prints
#  "sync: nothing to sync" — in both cases nothing is committed or pushed)
superbee sync
```

## Sharing the board — `sync`

Ordinary `superbee sync` shares your board — commits your changes, pulls your teammate's, pushes yours,
while leaving code-project files untouched.

On a shared board, run it whenever you close a unit of work — a task finished, a decision recorded, a session
ending. Local-only work remains complete locally. Three known empty states (all exit 0):
outside any git repo or workspace it prints `sync: nothing to sync`; a LOCAL-ONLY board (a
bundle with no shared `board` branch — a supported mode) reports itself as local-only, with
nothing committed, pulled, or pushed, and its note points at `--establish` — but bare `sync`
NEVER establishes on its own (that would silently publish a bundle nobody asked to share);
a clean, already-current shared board prints `sync: already up to date`.
If origin cannot be checked and no board ref is available, sync reports the remote state as
unknown and recommends retrying before `--establish`.

`sync --establish` is the one explicit, one-time act that starts sharing a project's local
bundle: it snapshots and publishes the bundle, checks out the `board` branch at the same path,
and appends that path to the root working-tree `.gitignore`; teammates then just run plain
`sync` to join. Never run it on a project that already shares a board (it
detects that state, notes `already established`, and proceeds as an ordinary sync instead of
erroring).

The same flag handles a bundle folder ALREADY COMMITTED on the code branch: `sync --establish`
prints a preview and changes nothing; `sync --establish --yes` creates the `board` branch from
the folder's current files (files only — the folder's history stays on the code branch),
pushes it, and prepares ONE commit on a local `board-cleanup` branch that removes the folder
from the code branch and gitignores it — you push that branch and open the PR yourself;
nothing on the code branch is pushed or changed. Until that PR merges, the old committed
folder is a frozen read-only snapshot; after the merge, `git pull` then `sync` brings the
live board back on every clone.

Sharing is an explicit act: nothing ever creates or publishes a board branch on its own —
only `sync --establish` does. The session-start hook and the read-time refresh below only
ever PULL an already-shared board (bounded, fast-forward, never a push); your changes leave
the machine only when you run `sync`.

When a doc changed on BOTH sides, sync converges instead of stopping: your teammate's version
is kept on the board, YOURS is saved to an export file named in the receipt, and the run
exits 5 with one row per conflicted doc. Reconcile with the doc verbs, never git:

```sh
superbee sync --show-incoming <id>                 # view the kept incoming version (as of the last fetch)
superbee doc update <id> --body-file <export-file> # write your merged version on top
superbee sync                                      # share it
```

`sync --pull-only` picks up teammates' changes without publishing local ones. If a push fails
(offline, auth), your work is already committed locally — re-running sync retries the push.

Reads stay fresh on their own: board-reading commands (`list`, `doc read`, `status`, `home`,
`link show`) automatically run the same fast-forward-only pull when the board's state is older
than ~5 minutes — silent, time-boxed (~2s), never a rebase, never a push, and it never sets a
board up (that stays `sync`'s job) — so a plain `list` can advance the board checkout's HEAD.
Your OWN changes still only leave the machine when you run `sync`. To disable the auto-pull
(CI, scripted runs), set `SUPERBEE_NO_AUTOPULL` to any non-empty value — even `0`
disables it; the variable's presence is the switch.
Legacy `AGENTSTATE_LITE_NO_AUTOPULL` remains supported with the same presence semantics.

On projects that share their board you may notice a `board` branch in the repo's GitHub —
that's the board; it never merges into main (it has no common history with it, by design).
Protect it like main: enable delete and force-push protection on `board` in the repo settings
— sync only ever appends commits to it.

## Remote bundle access (--remote, serve)

Remote bundle access remains explicit and wired the same way as `--dir`: use `serve` to expose
a local bundle over the wire protocol, or pass `--remote <url>` to a bundle-facing command.
For an authenticated remote, provide `SUPERBEE_API_KEY`; an already-provisioned
stored per-origin credential is also consumed when present. Legacy `AGENTSTATE_LITE_API_KEY`
remains supported as a compatibility input. Account and admin credential
provisioning is outside the default CLI surface.

```bash
superbee serve --dir ./my-bundle --port 4818 &
superbee list --remote http://127.0.0.1:4818
```

## Shipped references — worked examples & contracts alongside this file

A few capabilities below (bundle views, custom recipes) are backed by a full contract or a
worked example shipped in this package's `references/` folder rather than inlined here. The
folder sits NEXT TO this SKILL.md — in the npm package root, and in any host skill folder
this file is installed into (`superbee skill install`).

Shell commands resolve paths against YOUR working directory, not this file's folder, so set
`$REFS` once per session: your host names this skill's base directory when it loads it
(e.g. "Base directory for this skill: <path>"). Use that:

```bash
REFS="<skill-base-dir>/references"   # substitute the base directory your host reported
```

Every `$REFS/…` path below then runs from any cwd. Each shipped file is a byte-for-byte copy
of the matching file in the CLI's own repo — one authority, regenerated on every release,
never hand-duplicated.

## Bundle views — ship a live UI as bundle content

A **bundle view** is a self-contained HTML file living IN the bundle: promoted as a blob under
`views/…`, declared by a `type: View` registry doc (`title`, `entry`, `access` — the legacy
`bridge` spelling is no longer read: a doc declaring only `bridge` resolves to `access: none`,
so author with `access`), and rendered by
`superbee ui` inside a sandboxed, opaque-origin iframe. A data-bearing View is executable
code: the shell requires local approval of its exact bytes and declared access, and changed
bytes ask again. The sandbox and CSP deny direct credentials/data-API access and restrict
ordinary network APIs as defense-in-depth; approval remains the decision to trust the View's
source. Bundle data flows only through the narrow postMessage bridge to the trusted shell.
(`Page` is the legacy name and no longer registers: the launcher ignores `type: Page` docs.
`superbee status` lists legacy-named docs under its legacy_naming finding, and the
repo's migrate-legacy-view-names script renames legacy content in place; docs under the
legacy `pages-registry/`/`pages/` folders stay recognized once typed `View`.)

The bridge (protocol `v0`) has six read-only data request types: `hello` (bundle identity), `query`
(frontmatter-filtered rows — the same head projection `list` uses), `read` (one doc), `render-document`
(the shared bounded Markdown presentation for one canonical doc), `edges` (the general
from/to/text graph query — backlinks and containment both reduce to this), and `subscribe`
(opt into a server-pushed `change` event whenever the watched bundle moves). There
is no mutation message in v0 — read-only is enforced by construction. A View that declares
`bundle-propose` may use the local-only v1 contract to propose ONE governed scalar-field
change; the trusted shell revalidates it, shows canonical before/after values, and writes
only after explicit human confirmation with hard CAS. The View never receives a write token.
`open-page`
(a wire verb, stable across the rename) is a separate fire-and-forget shell action available
to every View capability; it opens only another valid registered View and returns none of
that target's content or metadata.

Author a view in four steps:

```bash
# 1. write a self-contained views/my-view.html (inline CSS/JS, no external hosts),
#    embedding the bridge client copied from the shipped contract below
superbee promote my-view.html --doc-key views/my-view.html                        # 2. promote the HTML blob
superbee promote my-view-registry.md --doc-key views-registry/my-view.md           # 3. promote its type: View doc (title, entry, access)
superbee promote "$REFS/views/conventions/view.md" --doc-key conventions/view.md   # 4. declare the View convention (once per bundle, ready-made)
```

Full message shapes, the trust model, the copy-paste bridge client with safe live-refresh
examples (including a live graph view over Roadmap Items) are in the shipped contract:

```bash
cat "$REFS/views/references/view-authoring-v0.md"
```

## Human review

When you create or materially revise a bundle document for human review, display it when the
human asks and otherwise offer once. In an MCP Apps host, call `list_workspaces` when needed,
then `show_document` with the exact workspace label or ID and document ID; do not return only
a filesystem path. In fixed `mcp --dir` compatibility mode, the workspace argument is omitted.
To present an existing interactive View, call `list_views` and then `show_view` with that same
workspace and the exact View ID; later View lifecycle calls use only the returned launch ID.
Outside an MCP Apps host, run
`superbee doc open <id>` to open that exact document in the existing browser reader.

## Notes

- `doc read <id>` truncates a large body and points at `doc read <id> --out <file>`, which streams
  the raw markdown bytes to disk without loading them into the model context window.
- To revise body prose without parsing YAML, run `doc read <id> --body-out <file> --json`; edit the
  file, then pass it to `doc update <id> --body-file <file> --expected-version <receipt-version>`.
  The body-out receipt's version comes from the same read, so this is a safe CAS edit cycle.
- Mutations are idempotent: re-writing a doc or re-adding an existing link is a no-op (exit 0).
- `new` and `doc update` accept a kind's declared fields as `--<field> <value>` (e.g. `--progress_status done`);
  an unknown field or an out-of-enum value is rejected (exit 2). Run `kinds` to see a kind's fields.
- `hook install` registers a SessionStart hook (Claude Code, Codex, OpenCode) that runs
  `session-start`: a quick best-effort pull of the shared board, then the home view — so a new
  session starts with the bundle's state AND any teammate changes already in context. Offline is
  fine: the render always appears, labeled with the last known state. A global npm install binds
  absolute Node and CLI paths, so GUI sessions do not depend on their inherited PATH. If you
  installed the hook before `session-start` existed, re-run `hook install` once to upgrade it.
- Edit a doc's body through `doc update --body-file` (or `--body`), never by pulling the raw file
  with `--out`, editing it with text tools, and re-promoting it — that risks corrupting the
  frontmatter (the engine rejects it, but the right tool avoids the dance entirely).
- Writing a custom recipe: a worked example (the `Claim` kind — event-lifecycle findings with
  provenance, composed from lite primitives) ships at `$REFS/recipes/claims/`; copy its shape,
  then `superbee recipe add <folder>` to apply it (built-in recipes are named directly, e.g.
  `superbee recipe add work-tracking`).
- Packaging a content-free cognitive ecosystem: `$REFS/recipes/review-workflow/` carries a
  self-describing Review Request kind plus a generic live View, but no review instances. A
  definitions-only recipe may contain only its manifest, convention docs, explicitly declared
  static Reference docs, and View registry/HTML pairs; install it with the same `recipe add <folder>` command.
- A full interop-shaped example bundle (externally-authored markdown: unquoted timestamps,
  relative links, wrapped bullets) ships at `$REFS/sample-bundle/` — copy it and point `--dir` at
  the copy to explore a populated bundle without writing one from scratch.
