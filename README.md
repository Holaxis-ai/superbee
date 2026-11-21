<img src="assets/superbee-mark-256.png" alt="" width="96" height="96">

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

**Requirements: macOS or Linux, and a supported Node.js 22, 24, or 26 release (22.14.0 minimum).**

The current test release is on npm's `next` prerelease channel; `latest` provides the stable
release. Install the prerelease with:

```sh
npm install -g superbee@next
superbee setup
```

`npm install -g superbee` installs the stable channel. The package's optional Agent Skill teaches Claude Code, Codex, and OpenCode
how to use the installed command without carrying another copy of the executable. OpenCode uses
its documented Claude-compatible Skill discovery, so it shares Claude Code's Skill bytes unless a
custom Claude config root requires separate documented host paths.

Bare and host-scoped `setup` are read-only and agent-friendly: without flags it reports private-state
health and lists the four supported hosts; after the agent selects its exact host, it inspects npm,
Agent Skill, SessionStart hook, MCP registration,
current bundle, and private workspace catalog, then returns one safe `next.command`. Fill any
explicit placeholder it identifies, run the command, restart the named host after integration
changes, and rerun the same setup command until the plan is complete. It never guesses a host as
permission to edit configuration.
After a CLI upgrade, `home` and SessionStart also report managed Agent Skills whose stale bytes can
pass the installer's complete read-only preflight, with the exact refresh command and restart
requirement; conflicts stay with explicit setup/status diagnostics and no host files change automatically.
If setup returns `superbee setup migrate-state`, that explicit command copies validated legacy
operational records into Superbee's private state root while preserving every legacy byte; it does
not move project bundles.

The hook is recommended rather than required: it gives Claude Code, Codex, and OpenCode a compact
Superbee orientation at session start. To try read-only and bootstrap commands without installing
anything, run `npx -y superbee`; persistent integrations still require the global npm install.

In a fresh cloud container, provision Superbee in the environment setup step before agent tool
use. Generated hooks bind absolute Node and CLI paths from their installation, so a project hook
copied from a laptop does not install Superbee or provide a working container launcher. Configure
the hook inside the environment and verify startup in a fresh session. Startup pulls are
best-effort; inspect an explicit `superbee sync` receipt to verify publication of edits.

The npm package is the sole executable distribution channel. The optional Agent Skill contains
guidance and references only; it invokes the npm-installed CLI rather than carrying another copy.
The new package installs only `superbee`, so it can coexist with a global `@holaxis/aslite` long
enough for `superbee setup` to inspect and migrate exact legacy integrations. Once setup is
complete, remove the old package with `npm uninstall -g @holaxis/aslite`; the successor does not
keep the retired `aslite` or `agentstate-lite` commands on `PATH`.
If upgrading from the retired marketplace plugin, remove or disable that plugin, then rerun
`superbee setup` and follow its exact next command. The hook installer
replaces exact historical AgentState marketplace hooks rather than leaving two SessionStart hooks.

## Quickstart

```sh
superbee                                   # confirm that no bundle is selected yet
superbee recipes                           # compare the workspace setups shipped offline
superbee init --create-only --recipe work-tracking --dir .superbee
superbee new "Task" first-task --title "Plan the first change" --progress_status todo \
  --actor process:quickstart-agent --dir .superbee
superbee --dir .superbee                   # see the Task in the live bundle summary
```

`--create-only` refuses an occupied, nested, bound, or concurrently claimed target before it
writes; use `recipe add` when you deliberately want to add capability to an existing bundle.
Bring source material or intent to your agent in the tool you already use. The agent organizes,
types, links, and updates the bundle through `superbee`; these commands are the plumbing, not a
manual data-entry workflow.

`process:quickstart-agent` is an advisory example actor identity; replace it with the actual actor
identity (`human:<id>`, `process:<id>`, or `<producer>/<version>`).

New Superbee bundles use Open Knowledge Format (OKF) v0.2. Existing OKF v0.1 bundles remain
supported without automatic migration.

The conventional `.superbee/` folder at the project root is discovered with zero
config (the way git finds `.git`) — every command after setup runs bare from anywhere in
the project tree. A bundle stays local until `sync --establish` explicitly shares it on the
repository's dedicated `board` branch. The remote repository must already exist: Superbee creates
and pushes only the `board` branch, never the GitHub repository that contains it.

Existing `.agentstate-lite/` bundles continue to work with Superbee. A `.agentstate.json`
binding is no longer read: rename it to `.superbee.json` (same contents). When the first task needs a roadmap, run
`superbee recipe add roadmap`. Before sharing, determine whether the intended remote repository
exists, then whether `origin/board` exists. A confirmed-missing repository is created outside
Superbee by an authorized account/organization actor (or by an authorized teammate who then grants
access). For an existing repository with no `board`, repository-creation authority is irrelevant:
with explicit consent, repository-specific push capability, and branch-create policy clearance,
run `superbee sync --establish`. If `origin/board` already exists, join with ordinary
`superbee sync` instead. A failed remote check leaves both facts unknown; diagnose URL, network,
HTTPS/SSH identity, visibility, and repository Read access before any establishment attempt.
If valid `.superbee/` and `.agentstate-lite/` bundles exist at the same project level, Superbee
reports a conflict and refuses to choose; move the bundle you do not intend to use outside the
project before retrying.

**When the conventional project folder does not fit:**

- **Project binding:** `.superbee.json` is a committed local pointer (`{ "bundle": "<path>" }`)
  for an out-of-tree directory and beats the conventional folder. A retired `.agentstate.json` is
  refused with the rename fix rather than skipped. A URL-valued binding, `--remote` and
  `AGENTSTATE_LITE_REMOTE` are refused: use `checkout` for a hosted bundle or `--dir` for a
  local one.
- **Private workspace:** the bundle lives outside the repo (for example,
  `~/superbee-workspaces/<name>/`); a git-excluded binding points at it, and nothing enters the repo.
- **Personal catalog:** register any local bundle under a user- or agent-defined label so it is
  visible when an agent starts outside that project. The catalog is explicit and machine-local:
  it never crawls, clones, or creates an ambient active workspace. Resolve a label to a path, then
  pass that path to an ordinary command:

  ```sh
  superbee catalog add personal --dir ~/superbee-workspaces/personal
  superbee catalog list
  superbee catalog resolve personal --field path
  superbee catalog remove personal   # forgets the label; the folder is never touched
  ```

Then, day to day:

```sh
export SUPERBEE_ACTOR=process:claude   # optional default; per-command --actor wins
superbee new "Task" ship-parser --title "Ship the parser" --progress_status todo
superbee list --type Task
superbee doc update tasks/ship-parser --progress_status in_progress
superbee doc history tasks/ship-parser # who changed what, when
superbee ui                            # the bundle, rendered — local server, no cloud
superbee view open <viewId>             # one exact local View; private one-use browser handoff
superbee index generate                # optional: complete portable Markdown navigation
superbee sync                          # ordinary shared-board updates — commits yours,
                                       # pulls theirs, pushes; leaves code files untouched
```

`init` always makes a LOCAL bundle; `sync` joins or updates a SHARED one, while
`sync --establish` is the one-time, explicit act that turns this project's local bundle into a
shared board (a `board` branch in an already-existing `origin` repository) — never automatic, so
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

For a Git board in a sandbox with a read-only home, set `SUPERBEE_BOARD_STATE_DIR` in the
trusted launcher to an absolute, private, persistent directory outside Git checkouts and
account state. Give the agent write access to that directory and the checkout. Keep using the
same directory when inspecting or resolving conflicts after a restart. Reusing the directory
across clones keeps each clone's state and conflict copies separate. On macOS and Linux, use
owner-only permissions (`0700`) for an existing directory. With no override, board state
uses the host's normal private state location (`~/.superbee-state/sync` on macOS and Linux).
Hosted checkout sync and account credentials follow their own storage policies.

The pending marker helps session start recognize a board. The cursor and awareness cache feed
change summaries and automatic-pull freshness checks. These records support reporting, so a
safe explicit pull can finish if the sandbox denies their writes. Its receipt reports the Git
changes it can verify. Saved conflict copies are required for recovery. If they cannot be saved,
a sync that needs them leaves the local work in the checkout and reports how to restore access.

A clone can hold its own pushes to a check: `git config superbee.syncGate '<command>'` makes
`sync` run that command on the rebased board (the exact commit it would push) before every push
that sends commits. A failing gate pushes nothing, keeps your work committed locally, and exits 5
(`GATE_FAILED`) with the gate's output; the gate learns what it judges from
`SUPERBEE_BOARD_UPSTREAM_SHA` and `SUPERBEE_BOARD_HEAD_SHA`, and exactly that head is pushed. Keep
the gate's code outside the board: a script inside it runs whatever a teammate last pushed. When
another writer pushes between
the rebase and the push, sync re-fetches, rebases, re-runs the gate and retries (up to 5 attempts)
instead of failing.

`sync --establish` also handles a project that already committed `.superbee/` or legacy
`.agentstate-lite/` to
its code branch: it prints a preview first, and `--yes` executes — publishing the board
branch from the folder's current files and preparing a cleanup commit on a side branch
that you open as a PR (the folder leaves the code branch; the board takes over after the
merge).

Establishment appends both recognized bundle directories (`.superbee/` and `.agentstate-lite/`) to
the root working-tree `.gitignore` and reports that uncommitted edit. Ordinary sync performs the
same reported repair when provisioning discovers that either ignore entry is missing.

**If you see a `board` branch** in a repo that uses Superbee: that is the shared
board — an orphan branch carrying only the knowledge bundle, written by `superbee sync`. It
never merges into `main` (it shares no history with it, by design). Protect it the way
you protect `main`: enable delete and force-push protection on `board` in the repo
settings — sync only ever appends commits to it.

**More than one board in a repository.** A repository whose `board` branch is taken can carry
further NAMED boards, each on its own `board-<name>` branch (lowercase letters, digits and
hyphens). The branch declares itself with a committed root file, `.superbee-board.json`:

```json
{ "schema": 1, "branch": "board-fairport" }
```

Work on a named board from a standalone clone of that branch (`git clone --branch
board-fairport <url>`); `superbee sync` there commits, rebases onto and pushes
`origin/board-fairport` and never touches `origin/board`. A named board can start from existing
history: branch it, add the root `index.md` (with `okf_version`) and the marker in one commit, and
push it with tracking (`git push -u origin board-fairport`). A clone whose branch is renamed, or
whose marker names another branch, is refused rather than synced. The conventional `.superbee/`
worktree beside your code always uses `board`.

## How it works

Tools that need a small, portable bundle identity can import the versioned JSON Schema and
TypeScript contract from `superbee/bundle-descriptor`. The contract describes a bundle but grants
no access or authority; see
[Bundle Descriptor v1](https://github.com/Holaxis-ai/superbee/blob/main/packages/bundle-descriptor/README.md).

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

### Prepare a cookbook with explicit Kind bindings

`superbee recipe qualify ./qualification.json --dir ./existing-bundle`
prepares a complete, finite selection of local recipes without changing their sources or installing
anything. `--dir` is needed only for bindings to an already declared Kind. For example:

```json
{
  "schema": "recipe-qualification/v1",
  "recipes": [
    {"key": "base", "source": "./base", "preserve": true},
    {
      "key": "decisions", "source": "./decisions",
      "namespace": "github.com/123/decisions",
      "bindings": {
        "Asset": {"recipe": "base", "kind": "Asset"},
        "Task": {"existing": "Task"}
      },
      "paths": {"Decision": "decisions/"}
    }
  ]
}
```

These coordinates are synthetic examples, not a first-party publisher identity. Namespaces accept
canonical lowercase `github.com/<positive-decimal-id>/<slug>` or
`github.com/<owner>/<repository>/<slug>`, at most 220 UTF-8 bytes. Slugs are alphanumeric words
separated by single hyphens. Readable coordinates require an explicit continuity decision after
renames or transfers. Numeric coordinates are less coupled to names but harder to read. Neither
form authenticates ownership. Qualified source Kind names use ASCII alphanumeric words separated
by single spaces, underscores or hyphens; full selectors are bounded at 256 UTF-8 bytes.

Every external `links` or `expects_inbound` target requires one explicit binding, including an
intentionally retained bare `Task`. Selected recipes can refer to each other cyclically: all
identities are allocated before binding. Missing, unused, ambiguous or conflicting bindings refuse
the entire preparation. `{existing: ...}` checks an exact declared Kind and records the observed
definition/version as a prerequisite; it does not bind to ungoverned records or lock later edits.

The command emits one complete JSON document with schema `recipe-qualification-output/v1`,
`receipt` and `files: [{path, bytes}]`. File paths describe one ordinary recipe folder per key;
`bytes` is its exact UTF-8 text. The receipt records mappings, digests, prerequisites and ordinary
install/evolve commands. No files or directories are created. Materialize the entries separately
under a chosen external root, then run those commands from that root. `--out` is refused;
`--json` is optional because successful output is always JSON. Qualified ownership is
`ns-<SHA256 of exact namespace>` and does not depend on release or schema. Definition paths are
stable and namespace-owned. Record paths remain human-authored or explicitly overridden; shared
record prefixes are reported and ordinary create-only ID collisions still apply. `preserve:true`
retains authored identities and placement, while explicitly mapped external relationships may
change; existing evolution rules can refuse that retargeting.

The complete input set is bounded to 32 selections, 512 files, 2 MiB per file and 8 MiB total;
generated recipe files have the same bounds, the serialized output document is bounded to 16 MiB,
and configuration is bounded to 256 KiB. Preparation supports Conventions and declared static
References. Views, Connectors, undeclared assets, symlinked source entries and unsupported link
constructs refuse before output. Supported inline Markdown links in document bodies relocate using
the ordinary resolver, including nested paths and fragments. Unsupported HTML and reference-link
syntax is conservatively rejected with a body-relative line number (excluding frontmatter). Prose, fenced examples, query strings
and Markdown strings in frontmatter remain unchanged and author-owned. OKF 0.2 field rules and logical progress-status
materialization still apply; qualifying a Kind does not make reserved field conflicts valid.

Keep one canonical source/configuration, regenerate the complete JSON artifact for each release,
and review generated differences. Publish only the expanded artifacts under their actual source
and file digests. Index generation and publication are separate, explicit work. Namespace changes
create new identities; preparation does not adopt or migrate existing records. Optional-field evolution uses the
ordinary plan/apply workflow and preserves instance bytes; incompatible changes require a separate
migration decision.

Qualification reads sources and the explicitly selected registry without materializing output.
It emits a success artifact only after complete validation and serialization. External materialization
has its own filesystem and overwrite responsibilities; qualification does not perform or authorize
that step. Installing several materialized recipes remains per-artifact and can partially complete. Titles are display labels: use exact `governs` selectors from `kinds`. Bare selectors
never expand to similarly titled qualified Kinds, and an existing bare Kind remains valid.

The full recipe/Reference workflow is local. Current hosted CLI recipe admission is convention-only;
a recipe carrying References is not claimed installable through that route. Shared-contract tests
are not deployed-host evidence. Full hosted cookbook adoption requires a separate approved
admission change and verification of the target versions.

Bundles use [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
v0.2 by default - plain markdown any tool conforming to that edition can read. Existing OKF v0.1
bundles remain supported without rewriting their declared edition.

## What's solid

- The engine and the storage seam: a broad suite across four workspaces, with the
  filesystem, memory, and wire backends pinned to byte-identical version tokens.
- The CLI surface, built agent-first: structured output, counts and truncation with
  escape hatches, idempotent mutations, a small stable exit-code taxonomy.
- The byte channel (`promote`/`pull`) for artifacts that should never enter a model's
  context window.
- Project discovery: a committed `.superbee/` or legacy `.agentstate-lite/` folder (or an explicit `.superbee.json`
  binding) resolves the bundle for any agent on any machine with zero
  prior context.

## What's early or experimental

- **Everything is pre-1.0.** The npm package is a prerelease and breaking changes are likely.
- **Native Windows support is separate.** The `superbee` executable supports macOS and Linux.
  Most Windows users should run Superbee in WSL2. Windows adapters and the `superbee-windows`
  executable are developed in a separate repository, https://github.com/Holaxis-ai/superbee-windows-cli,
  which is open source with build-from-source instructions; it is experimental, unsupported, and
  not published to npm.
  See the [CLI upgrade guidance](packages/superbee/README.md#upgrading-an-existing-windows-installation)
  and [core filesystem migration](packages/core/README.md#filesystem-platform-migration) before upgrading.
- **Recipe composition** supports finite explicit local preparation and existing indexed cookbooks.
  Automatic dependency solving, migrations, namespace authentication and marketplace discovery
  remain future work. Preparation does not change ordinary installation or hosted admission limits.
- **Provider integrations** live in [superbee-plugins](https://github.com/Holaxis-ai/superbee-plugins),
  which owns the GitHub package, shared recipes and GitHub/Linear examples. Generic Core helpers
  and the CLI's explicit `source plugin` registration remain in this repository.
- **Bundle Views and the local web UI** are functional but still early. `ui` launches registered
  Views in sandboxed iframes; data Views receive a narrow read-only bridge with live change events,
  while `bundle-propose` Views may ask trusted shell chrome to confirm one local, CAS-guarded
  scalar-field change. Content Views receive no bundle-data capability. Views can navigate to other registered
  Views, and View-bearing definitions-only recipes can carry the operating model, registry entry,
  HTML, and authoring reference together. (`Page` is the legacy name for the kind and is no
  longer read — a legacy `type: Page` doc does not register, and the legacy `bridge:` field
  grants nothing; the `migrate-legacy-view-names` script at tag
  [`v0.4.3`](https://github.com/Holaxis-ai/superbee/blob/v0.4.3/scripts/migrate-legacy-view-names.mjs)
  renames them in place. Legacy folder locations stay recognized.) Authoring is still HTML/agent-driven rather than a
  polished end-user builder, so treat the surface as a preview.
- **The public package ends at a generic remote boundary.** The CLI's v0 remote client
  (`--remote`) and its reference server command (`serve`) are removed; `npx superbee@0.4.5` still
  runs them. The wire protocol remains the local UI's data path and the `@superbee/server/router`
  host contract. This repository ships no hosted deployment, identity system,
  account-administration commands, or cloud-provider package.
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
team develops against daily. The repo also carries three narrow contracts at the boundary where a
fresh clone must remain sufficient: the CLI's [AXI contract](packages/superbee/AXI-CONTRACT.md), the
implemented [wire protocol](docs/WIRE-PROTOCOL.md), and private vulnerability routing in
[SECURITY.md](SECURITY.md). Other deep documentation remains in the bundle rather than creating a
second manually coordinated product authority.

One task guide lives in the repository too:
[move a team's Git board to hosted Superbee](docs/move-a-team-board-to-hosted.md).

## License

Apache-2.0 © 2026 Holaxis

See [Site declaration validation](packages/publication/SITE-MANIFEST.md) for the read-only publication contract used by site builders.
