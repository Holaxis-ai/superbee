// Pure SKILL.md section renderers for both distribution channels — extracted from
// scripts/gen-skill.mjs so they are typed, unit-testable without esbuild's data-URL bundling
// dance, and importable directly by test/skill-distribution.test.ts (which renders the skill
// target in-memory to gate its shipped-references prose). NO I/O: pure functions over
// reference.ts's COMMAND_GROUPS/DESCRIPTION and distribution-resources.ts's inventory, parameterized only
// by the caller-supplied invocation prefix where relevant — mirrors reference.ts's own "pure data +
// pure projection" contract (see that file's header comment).
//
// gen-skill.mjs bundles this module (transitively pulling in reference.ts + distribution-resources.ts)
// via esbuild's data-URL loader and calls `renderNpm()` / `renderSkill()` directly; it no longer
// contains any rendering logic of its own, only the write/--check CLI shell.
//
// Both channels ship the same reference tree (see distribution-resources.ts) and render the same
// reference-backed sections (Shipped references, Bundle views, the Notes addendum) — parameterized
// by invocation prefix and by how each channel addresses its installed `references/` copy (the
// `RefPointer` forms below).
import { DESCRIPTION, COMMAND_GROUPS, commandName, type CommandGroup } from "./reference.js";
import { NPM_RESOURCES, SKILL_RESOURCES } from "./distribution-resources.js";
import { HOST_CONFIG_ROOTS, renderShellHostConfigRoot } from "./host-config.js";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "./integration-guidance.js";

export { NPM_RESOURCES, SKILL_RESOURCES, commandName };

// The two channels carry DIFFERENT identities on purpose: the npm package publishes under the
// SCOPED interim coordinate `@holaxis/aslite` (npm rejected the unscoped `aslite` as too similar
// to existing monikers), while the plugin/skill channel keeps its `agentstate-lite` identity and
// `skills/agentstate-lite` paths. Within the npm channel there is a SECOND split: the COORDINATE
// (`@holaxis/aslite`) appears only in install/npx command text, while the channel's skill
// IDENTITY and command prefix stay the bare `aslite` bin — a skill name or install folder must
// not contain `@` or `/`.
const NPM_COORDINATE = "@holaxis/aslite";
const NPM_BIN = "aslite";
const SKILL_NAME = "agentstate-lite";
const NPX = `npx -y ${NPM_COORDINATE}`;
const ASLITE = '"$ASLITE"';

// ---------------------------------------------------------------------------------------------
// Single source for cross-host resolver coverage. The skill ships two shell resolvers — `$ASLITE`
// (the CLI, under renderSkill's invocation section) and `$REFS` (the shipped references dir,
// under renderShippedReferencesSection) — that both need to find the SAME install of this skill
// under the SAME set of hosts. Every host this skill supports lives in ONE array; both resolvers
// derive their direct-install and marketplace-cache search from it, so a host can never be added
// to one and forgotten in the other.
//
// Covered: Claude Code and Codex, each via a DIRECT skill install (`<host-home>/skills/agentstate-lite`)
// and a plugin-MARKETPLACE-cache install (`<host-home>/plugins/cache/<marketplace>/agentstate-lite/<version>/skills/agentstate-lite`
// — the cache copies the plugin dir's own contents, so there is no extra `plugins/` path segment).
//
// Each host's home is ENV-VAR-AWARE, not hardcoded to `$HOME/.<host>` — both hosts support
// relocating it, and a relocated install is a real, reported case (a bare `$HOME/.<host>` glob
// misses it entirely): Claude Code via `CLAUDE_CONFIG_DIR` (confirmed against the installed
// `claude` binary — it resolves `settings.json`/`projects` from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`,
// i.e. the var REPLACES `~/.claude` wholesale, not merges with it), Codex via `CODEX_HOME` (confirmed
// against the installed `codex` binary's own `--help`, e.g. `$CODEX_HOME/<name>.config.toml`). Bash's
// `${VAR:-default}` expresses that fallback inline. The same host definitions drive global hook
// targets, so install and discovery cannot independently drift on an env name or fallback folder.
//
// OpenCode is deliberately NOT here. It never reads SKILL.md at all: its SessionStart integration
// is the ambient-context plugin built by `commands/hook.ts`'s `buildOpenCodePluginSource`, which
// bakes the CLI's already-resolved absolute path in directly at `hook install` time
// (`hookCommand()`) — there is no skill-relative install path for this resolver to discover, by
// construction (confirmed against axi-sdk-js: OpenCode gets a managed plugin file, not a
// skill/plugin-cache directory layout). If a future OpenCode surface ever loads this skill's own
// files by a discoverable convention path, add it to the shared host authority only when hook and
// discovery semantics really are the same.
export const SKILL_HOST_HOMES = [
  renderShellHostConfigRoot(HOST_CONFIG_ROOTS.claude),
  renderShellHostConfigRoot(HOST_CONFIG_ROOTS.codex),
];

// Test-facing projection of every supported host/channel shape. Keep the compatibility matrix
// literal and inspectable while the emitted resolver itself derives from SKILL_HOST_HOMES.
export const SKILL_HOST_ROOTS = SKILL_HOST_HOMES.flatMap((home) => [
  `${home}/skills/agentstate-lite`,
  `${home}/plugins/cache/*/agentstate-lite/*/skills/agentstate-lite`,
]);

/**
 * Render the shared, shell-portable discovery loop. Optional marketplace roots are traversed by
 * `find`, not expanded as shell globs: default zsh treats an unmatched glob as a fatal NOMATCH
 * error before `ls` or stderr redirection can run. Bash leaves the same glob literal in place,
 * which is why bash-only execution tests failed to expose the bug.
 */
function hostDiscoveryLines(subpath: string, type: "f" | "d", indent = "    "): string[] {
  const lines: string[] = [];
  lines.push(`${indent}for host_home in \\`);
  SKILL_HOST_HOMES.forEach((home, index) => {
    lines.push(`${indent}  ${home}${index === SKILL_HOST_HOMES.length - 1 ? "" : " \\"}`);
  });
  lines.push(`${indent}do`);
  lines.push(`${indent}  direct="$host_home/skills/agentstate-lite/${subpath}"`);
  lines.push(`${indent}  [ -${type} "$direct" ] && printf '%s\\n' "$direct"`);
  lines.push(`${indent}  cache="$host_home/plugins/cache"`);
  lines.push(
    `${indent}  [ -d "$cache" ] && find "$cache" -type ${type} -path '*/agentstate-lite/*/skills/agentstate-lite/${subpath}' -print 2>/dev/null`,
  );
  lines.push(`${indent}done | sort -V | tail -1`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Shared projections (single source: COMMAND_GROUPS), parameterized only by invocation prefix.
// ---------------------------------------------------------------------------------------------

function renderCommandsSection(groups: readonly CommandGroup[], prefix: string): string[] {
  const lines: string[] = [];
  lines.push("## Commands");
  lines.push("");
  for (const { group, commands } of groups) {
    lines.push(`### ${group}`);
    lines.push("");
    for (const { usage, summary } of commands) {
      lines.push(`- \`${prefix} ${usage}\``);
      lines.push(`  — ${summary}`);
    }
    lines.push("");
  }
  return lines;
}

function renderWorkspaceLocation(prefix: string): string[] {
  const lines: string[] = [];
  lines.push("## Workspaces — the project's bundle lives at `.agentstate-lite/` in the project root");
  lines.push("");
  lines.push(
    "Unless the user directs otherwise, a project's workspace bundle lives in a `.agentstate-lite/`",
  );
  lines.push(
    "folder at the project root. Two verbs, two different jobs — `init` always creates a LOCAL",
  );
  lines.push(
    "bundle (solo use is first-class, nothing forces sharing); `sync` is how a project's board",
  );
  lines.push("becomes — or stays — shared memory across clones and teammates. Three modes:");
  lines.push("");
  lines.push(
    "- **A local-only board** — `init` creates a bundle that doesn't exist anywhere yet, and it",
  );
  lines.push(
    "  stays LOCAL until someone chooses to share it. This is a first-class mode, not a limbo:",
  );
  lines.push(
    "  everything works offline and remote-free, and board changes stay on this machine. A bare",
  );
  lines.push(
    "  `sync` on a local-only bundle reports that state honestly (its note points at `--establish`)",
  );
  lines.push(
    "  — it never establishes on its own, which would silently publish a bundle nobody asked to",
  );
  lines.push("  share.");
  lines.push(
    "- **Joining an existing shared board** — if `.agentstate-lite/` is already in the clone, there",
  );
  lines.push(
    "  is NOTHING to set up. If it isn't but the project already shares its board (the repo's",
  );
  lines.push(
    "  remote has a `board` branch), `sync` is the setup verb — run it once and it creates the",
  );
  lines.push(
    "  folder and pulls the shared state. NEVER init a project that already has a workspace: that",
  );
  lines.push("  creates a divergent second bundle.");
  lines.push(
    "- **Sharing a board (`sync --establish`, once)** — the explicit act that publishes a local",
  );
  lines.push(
    "  bundle as the repo's `board` branch; teammates then just run `sync` to join. It handles",
  );
  lines.push(
    "  both shapes: an uncommitted local folder is snapshotted, pushed, and converted in place;",
  );
  lines.push(
    "  a folder ALREADY COMMITTED on the code branch gets a preview first — re-run with `--yes`",
  );
  lines.push(
    "  to execute, which also prepares a cleanup commit on a side branch that you push and open",
  );
  lines.push(
    "  as a PR (it removes the folder from the code branch; the board branch takes over after the",
  );
  lines.push(
    "  merge). If origin cannot be checked, `sync` reports the shared-board state as unknown and",
  );
  lines.push("  waits for a retry instead of recommending publication.");
  lines.push("");
  lines.push("```sh");
  lines.push(`${prefix} sync                            # existing shared project — provisions the board; a local-only bundle reports its state`);
  lines.push(`${prefix} init --dir .agentstate-lite     # greenfield — idempotent; creates a LOCAL bundle, or opens an existing one`);
  lines.push(`${prefix} sync --establish                # optional — start sharing a local bundle's board with teammates`);
  lines.push("```");
  lines.push("");
  lines.push(
    "That's the whole setup. The CLI discovers the conventional folder on its own (the way git",
  );
  lines.push(
    "finds `.git`), so every command runs BARE from anywhere in the project tree — no flags, no",
  );
  lines.push("config files:");
  lines.push("");
  lines.push("```sh");
  lines.push(`${prefix} list`);
  lines.push(`${prefix} doc read context-notes/cycle-1`);
  lines.push("```");
  lines.push("");
  lines.push(
    "Surfaces that label the workspace (the `ui` header, home's bundle block) derive its DISPLAY",
  );
  lines.push(
    "NAME from the project folder's name. To set it explicitly (it syncs to teammates with the",
  );
  lines.push("board), write the well-known name doc — its title becomes the display name:");
  lines.push("");
  lines.push("```sh");
  lines.push(`${prefix} doc write docs/bundle --type "Bundle Name" --title "<display name>"`);
  lines.push(`${prefix} doc update docs/bundle --title "<new name>"   # rename later`);
  lines.push("```");
  lines.push("");
  lines.push(
    "The folder is LOCAL until you choose to share it: `aslite sync --establish` (once) publishes it",
  );
  lines.push(
    "onto its own `board` branch — from then on `sync` commits and pushes board changes itself, never",
  );
  lines.push(
    "batched with code. Until established, the bundle stays local — a fully supported mode, not a",
  );
  lines.push(
    "temporary one: everything works offline and remote-free, and board changes stay on this machine",
  );
  lines.push(
    "(either left uncommitted, or committed directly on the code branch like any other file,",
  );
  lines.push(
    "whichever the user prefers). (Gitignore the folder only if the workspace should stay private",
  );
  lines.push("to this machine.)");
  lines.push("");
  lines.push(
    "Write with attribution: set `AGENTSTATE_LITE_ACTOR=<your-name>` once for `new`, `doc write`,",
  );
  lines.push(
    "`doc update`, and `link add`, or pass `--actor <your-name>` per command (the flag wins).",
  );
  lines.push(
    "With neither source, no advisory actor label is stored in frontmatter or sent as an agent label;",
  );
  lines.push(
    "backend history still reports its own principal (for example, the local OS owner or an",
  );
  lines.push(
    "authenticated remote user). A present-but-blank flag or environment value is a usage error.",
  );
  lines.push("Advisory attribution describes a real mutation and never creates a no-op write.");
  lines.push("Actor labels are advisory metadata, not authentication or authorization credentials.");
  lines.push("");
  lines.push("Each invocation is stateless. HTTP is activated only by explicit `--remote <url>`.");
  lines.push(
    "Otherwise bundle resolution stays local: explicit `--dir` → nearest `.agentstate.json`",
  );
  lines.push("local-path binding up-tree → the cwd walk, which at each ancestor checks the");
  lines.push("directory's own `index.md`, then its");
  lines.push(
    "conventional `.agentstate-lite/index.md`. Reserve `--dir` for the exceptions: a bundle outside",
  );
  lines.push("any project, a second workspace, or reaching another project's bundle from elsewhere.");
  lines.push("");
  lines.push("Two things override the default:");
  lines.push("");
  lines.push(
    "1. **Explicit user direction** — the user names a directory or a `--remote`; use that. A local",
  );
  lines.push(
    "   `.agentstate.json` binding (`{ \"bundle\": \"<path>\" }` at the project root) is the",
  );
  lines.push("   durable form of that direction — it beats the conventional folder when both exist.");
  lines.push("   Remote URLs are never durable ambient bindings; pass `--remote <url>` per invocation.");
  lines.push(
    "2. **An existing workspace** — if a bare command already resolves (a binding, an enclosing",
  );
  lines.push(
    "   bundle, or a conventional folder exists up-tree), that IS this project's workspace — use",
  );
  lines.push("   it rather than creating a second one.");
  lines.push("");
  lines.push(
    "If the user wants the workspace PRIVATE to their machine instead of shared (a personal",
  );
  lines.push(
    "scratch workspace), keep the bundle OUT of the repo (e.g. under `~/.agentstate-lite/<name>/`)",
  );
  lines.push(
    "and point a git-excluded `.agentstate.json` at it. Choose by one question: do teammates",
  );
  lines.push("share this bundle? When the user's intent is ambiguous, ask rather than defaulting silently.");
  lines.push("");
  return lines;
}

function renderTypicalFlow(prefix: string): string[] {
  const lines: string[] = [];
  lines.push("## Typical flow");
  lines.push("");
  lines.push("```sh");
  lines.push(`# One-time setup at the project root (see the Workspaces section) — run ONE of these:`);
  lines.push(`${prefix} sync                          # existing project that shares a board — sets up AND pulls the shared board`);
  lines.push(`${prefix} init --dir .agentstate-lite   # GREENFIELD — never on a project that already has a workspace; makes a LOCAL bundle`);
  lines.push("");
  lines.push(`# Optional, after a greenfield init: start sharing this bundle's board with teammates`);
  lines.push(`${prefix} sync --establish`);
  lines.push("");
  lines.push(`# Everything after runs bare, from anywhere in the project tree`);
  lines.push(`# Create a complete context note (an OKF concept) for the next session in one command`);
  lines.push(`${prefix} new "Context Note" cycle-1 --title "cycle-1" --body '# Summary`);
  lines.push("");
  lines.push(`What this session did and what comes next' --actor <your-name>`);
  lines.push("");
  lines.push(`# Read it back`);
  lines.push(`${prefix} doc read context-notes/cycle-1`);
  lines.push("");
  lines.push(`# Store a doc, cross-link it, and query the bundle`);
  lines.push(`${prefix} doc write specs/auth --type Spec --title "Auth" --body "…" --actor <your-name>`);
  lines.push(`${prefix} link add specs/auth context-notes/cycle-1`);
  lines.push(`${prefix} list --type Spec`);
  lines.push("");
  lines.push(`# Share the board — recording work isn't done until it's shared`);
  lines.push(`# (safe everywhere: a local-only board just reports its state; outside any`);
  lines.push(`#  workspace it prints "sync: nothing to sync" — in both cases nothing is committed or pushed)`);
  lines.push(`${prefix} sync`);
  lines.push("```");
  lines.push("");
  return lines;
}

function renderSyncSection(prefix: string): string[] {
  const lines: string[] = [];
  lines.push("## Sharing the board — `sync`");
  lines.push("");
  lines.push(
    "Ordinary `aslite sync` shares your board — commits your changes, pulls your teammate's, pushes yours,",
  );
  lines.push("while leaving code-project files untouched.");
  lines.push("");
  lines.push(
    "Run it whenever you close a unit of work — a task finished, a decision recorded, a session",
  );
  lines.push(
    "ending. Recording work isn't done until it's shared. Three known empty states (all exit 0):",
  );
  lines.push(
    "outside any git repo or workspace it prints `sync: nothing to sync`; a LOCAL-ONLY board (a",
  );
  lines.push(
    "bundle with no shared `board` branch — a supported mode) reports itself as local-only, with",
  );
  lines.push(
    "nothing committed, pulled, or pushed, and its note points at `--establish` — but bare `sync`",
  );
  lines.push(
    "NEVER establishes on its own (that would silently publish a bundle nobody asked to share);",
  );
  lines.push(
    "a clean, already-current shared board prints `sync: already up to date`.",
  );
  lines.push(
    "If origin cannot be checked and no board ref is available, sync reports the remote state as",
  );
  lines.push("unknown and recommends retrying before `--establish`.");
  lines.push("");
  lines.push(
    "`sync --establish` is the one explicit, one-time act that starts sharing a project's local",
  );
  lines.push(
    "bundle: it snapshots and publishes the bundle, checks out the `board` branch at the same path,",
  );
  lines.push(
    "and appends that path to the root working-tree `.gitignore`; teammates then just run plain",
  );
  lines.push(
    "`sync` to join. Never run it on a project that already shares a board (it",
  );
  lines.push(
    "detects that state, notes `already established`, and proceeds as an ordinary sync instead of",
  );
  lines.push("erroring).");
  lines.push("");
  lines.push(
    "The same flag handles a bundle folder ALREADY COMMITTED on the code branch: `sync --establish`",
  );
  lines.push(
    "prints a preview and changes nothing; `sync --establish --yes` creates the `board` branch from",
  );
  lines.push(
    "the folder's current files (files only — the folder's history stays on the code branch),",
  );
  lines.push(
    "pushes it, and prepares ONE commit on a local `board-cleanup` branch that removes the folder",
  );
  lines.push(
    "from the code branch and gitignores it — you push that branch and open the PR yourself;",
  );
  lines.push(
    "nothing on the code branch is pushed or changed. Until that PR merges, the old committed",
  );
  lines.push(
    "folder is a frozen read-only snapshot; after the merge, `git pull` then `sync` brings the",
  );
  lines.push("live board back on every clone.");
  lines.push("");
  lines.push(
    "Sharing is an explicit act: nothing ever creates or publishes a board branch on its own —",
  );
  lines.push(
    "only `sync --establish` does. The session-start hook and the read-time refresh below only",
  );
  lines.push(
    "ever PULL an already-shared board (bounded, fast-forward, never a push); your changes leave",
  );
  lines.push("the machine only when you run `sync`.");
  lines.push("");
  lines.push(
    "When a doc changed on BOTH sides, sync converges instead of stopping: your teammate's version",
  );
  lines.push(
    "is kept on the board, YOURS is saved to an export file named in the receipt, and the run",
  );
  lines.push("exits 5 with one row per conflicted doc. Reconcile with the doc verbs, never git:");
  lines.push("");
  lines.push("```sh");
  lines.push(`${prefix} sync --show-incoming <id>                 # view the kept incoming version (as of the last fetch)`);
  lines.push(`${prefix} doc update <id> --body-file <export-file> # write your merged version on top`);
  lines.push(`${prefix} sync                                      # share it`);
  lines.push("```");
  lines.push("");
  lines.push(
    "`sync --pull-only` picks up teammates' changes without publishing local ones. If a push fails",
  );
  lines.push(
    "(offline, auth), your work is already committed locally — re-running sync retries the push.",
  );
  lines.push("");
  lines.push(
    "Reads stay fresh on their own: board-reading commands (`list`, `doc read`, `status`, `home`,",
  );
  lines.push(
    "`link show`) automatically run the same fast-forward-only pull when the board's state is older",
  );
  lines.push(
    "than ~5 minutes — silent, time-boxed (~2s), never a rebase, never a push, and it never sets a",
  );
  lines.push(
    "board up (that stays `sync`'s job) — so a plain `list` can advance the board checkout's HEAD.",
  );
  lines.push(
    "Your OWN changes still only leave the machine when you run `sync`. To disable the auto-pull",
  );
  lines.push(
    "(CI, scripted runs), set `AGENTSTATE_LITE_NO_AUTOPULL` to any non-empty value — even `0`",
  );
  lines.push("disables it; the variable's presence is the switch.");
  lines.push("");
  lines.push(
    "On projects that share their board you may notice a `board` branch in the repo's GitHub —",
  );
  lines.push(
    "that's the board; it never merges into main (it has no common history with it, by design).",
  );
  lines.push(
    "Protect it like main: enable delete and force-push protection on `board` in the repo settings",
  );
  lines.push("— sync only ever appends commits to it.");
  lines.push("");
  return lines;
}

/**
 * `extraBullets`: physical lines appended after the standard bullets, still under the same
 * `## Notes` heading — each channel passes its {@link referenceNotesAddendum} projection.
 */
function renderNotesSection(extraBullets: string[] = []): string[] {
  const lines: string[] = [];
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- `doc read <id>` truncates a large body and points at `doc read <id> --out <file>`, which streams",
  );
  lines.push("  the raw markdown bytes to disk without loading them into the model context window.");
  lines.push(
    "- To revise body prose without parsing YAML, run `doc read <id> --body-out <file> --json`; edit the",
  );
  lines.push(
    "  file, then pass it to `doc update <id> --body-file <file> --expected-version <receipt-version>`.",
  );
  lines.push("  The body-out receipt's version comes from the same read, so this is a safe CAS edit cycle.");
  lines.push("- Mutations are idempotent: re-writing a doc or re-adding an existing link is a no-op (exit 0).");
  lines.push(
    "- `new` and `doc update` accept a kind's declared fields as `--<field> <value>` (e.g. `--status done`);",
  );
  lines.push("  an unknown field or an out-of-enum value is rejected (exit 2). Run `kinds` to see a kind's fields.");
  lines.push(
    "- `hook install` registers a SessionStart hook (Claude Code, Codex, OpenCode) that runs",
  );
  lines.push(
    "  `session-start`: a quick best-effort pull of the shared board, then the home view — so a new",
  );
  lines.push(
    "  session starts with the bundle's state AND any teammate changes already in context. Offline is",
  );
  lines.push(
    "  fine: the render always appears, labeled with the last known state. A global npm install binds",
  );
  lines.push(
    "  absolute Node and CLI paths, so GUI sessions do not depend on their inherited PATH. If you",
  );
  lines.push("  installed the hook before `session-start` existed, re-run `hook install` once to upgrade it.");
  lines.push(
    "- Edit a doc's body through `doc update --body-file` (or `--body`), never by pulling the raw file",
  );
  lines.push(
    "  with `--out`, editing it with text tools, and re-promoting it — that risks corrupting the",
  );
  lines.push("  frontmatter (the engine rejects it, but the right tool avoids the dance entirely).");
  lines.push(...extraBullets);
  lines.push("");
  return lines;
}

/** Shared remote-access guidance for both published skill channels. */
function renderRemoteAccessSection(invocation: string): string[] {
  const lines: string[] = [];
  lines.push("## Remote bundle access (--remote, serve)");
  lines.push("");
  lines.push(
    "Remote bundle access remains explicit and wired the same way as `--dir`: use `serve` to expose",
  );
  lines.push(
    "a local bundle over the wire protocol, or pass `--remote <url>` to a bundle-facing command.",
  );
  lines.push("For an authenticated remote, provide `AGENTSTATE_LITE_API_KEY`; an already-provisioned");
  lines.push("stored per-origin credential is also consumed when present. Account and admin credential");
  lines.push("provisioning is outside the default CLI surface.");
  lines.push("");
  lines.push("```bash");
  lines.push(`${invocation} serve --dir ./my-bundle --port 4818 &`);
  lines.push(`${invocation} list --remote http://127.0.0.1:4818`);
  lines.push("```");
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Shipped-reference pointer form — ONE `$REFS/<dest>` shape SHARED by both channels: shell
// commands resolve against the process cwd, never the installed SKILL.md's folder, so a bare
// relative `references/…` argument would fail from a project root after a host install. The
// channels differ only in how `$REFS` gets DEFINED: the skill channel emits a cross-host
// discovery resolver (renderShippedReferencesSection), while the npm channel instructs the
// reader to set it from the skill base directory its host reports — trivially, no discovery
// loop, no marketplace-cache search in that channel by design.
// ---------------------------------------------------------------------------------------------

interface RefPointer {
  /** The pointer as a shell-command argument (quoted where the channel needs it). */
  arg(dest: string): string;
  /** The pointer as inline prose (inside backticks). */
  path(dest: string): string;
}

const REFS_POINTER: RefPointer = {
  arg: (dest) => `"$REFS/${dest}"`,
  path: (dest) => `$REFS/${dest}`,
};

// ---------------------------------------------------------------------------------------------
// npm target — packages/cli/SKILL.md, published-package channel.
// ---------------------------------------------------------------------------------------------

/** npm-channel `## Shipped references` — `$REFS` set once from the host-reported skill base dir. */
function renderNpmShippedReferencesSection(): string[] {
  const lines: string[] = [];
  lines.push("## Shipped references — worked examples & contracts alongside this file");
  lines.push("");
  lines.push(
    "A few capabilities below (bundle views, custom recipes) are backed by a full contract or a",
  );
  lines.push(
    "worked example shipped in this package's `references/` folder rather than inlined here. The",
  );
  lines.push(
    "folder sits NEXT TO this SKILL.md — in the npm package root, and in any host skill folder",
  );
  lines.push("this file is installed into (`aslite skill install`).");
  lines.push("");
  lines.push(
    "Shell commands resolve paths against YOUR working directory, not this file's folder, so set",
  );
  lines.push("`$REFS` once per session: your host names this skill's base directory when it loads it");
  lines.push('(e.g. "Base directory for this skill: <path>"). Use that:');
  lines.push("");
  lines.push("```bash");
  lines.push('REFS="<skill-base-dir>/references"   # substitute the base directory your host reported');
  lines.push("```");
  lines.push("");
  lines.push(
    "Every `$REFS/…` path below then runs from any cwd. Each shipped file is a byte-for-byte copy",
  );
  lines.push("of the matching file in the CLI's own repo — one authority, regenerated on every release,");
  lines.push("never hand-duplicated.");
  lines.push("");
  return lines;
}

/** npm-channel "not on PATH" guidance — install channels, no marketplace-cache discovery. */
function renderNpmPathSection(): string[] {
  const lines: string[] = [];
  lines.push(`## If \`${NPM_BIN}\` is not on PATH`);
  lines.push("");
  lines.push(`Every example below assumes the \`${NPM_BIN}\` bin is on PATH. If it is not:`);
  lines.push("");
  lines.push(`- \`npm install -g ${NPM_COORDINATE}\` puts it (and the long-form alias \`agentstate-lite\`) on PATH.`);
  lines.push(`- \`${NPX} …\` runs any command below with no install at all — swap the leading \`${NPM_BIN}\``);
  lines.push("  for that prefix and the rest of the line runs unchanged.");
  lines.push("");
  return lines;
}

export function renderNpm(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${NPM_BIN}`);
  lines.push("description: >-");
  lines.push(
    "  Read and write a local OKF knowledge bundle (agent context notes, docs, cross-links, and live",
  );
  lines.push(
    "  bundle Views) from the shell via the aslite CLI. Use when an agent",
  );
  lines.push(
    "  needs to persist a context note across sessions, store a decision/spec as a doc, link concepts,",
  );
  lines.push(
    "  query a bundle, share the project's board with teammates (`sync`), or open its local View UI.",
  );
  lines.push(`  Runs standalone via \`${NPX}\`.`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${NPM_BIN}`);
  lines.push("");
  lines.push(`${DESCRIPTION}.`);
  lines.push("");
  lines.push(
    `It is a standalone npm package (\`${NPM_COORDINATE}\`) installing two bins for the identical CLI: \`${NPM_BIN}\` and the`,
  );
  lines.push("long-form alias `agentstate-lite`. Every example below uses the bare `aslite` bin.");
  lines.push("");
  lines.push("Output is TOON on stdout (a `--json` hatch exists). Errors are structured TOON on stdout with a");
  lines.push("capped exit-code taxonomy (0 ok/no-op, 2 usage, 4 auth, 5 conflict, 6 not-found, 1 runtime).");
  lines.push("");
  lines.push("<!-- GENERATED from src/reference.ts by scripts/gen-skill.mjs — do not edit by hand. -->");
  lines.push("");
  lines.push(...renderNpmPathSection());
  lines.push(...STABLE_MCP_LAUNCH_GUIDANCE.split("\n"), "");
  lines.push(...renderCommandsSection(COMMAND_GROUPS, NPM_BIN));
  lines.push(...renderWorkspaceLocation(NPM_BIN));
  lines.push(...renderTypicalFlow(NPM_BIN));
  lines.push(...renderSyncSection(NPM_BIN));
  lines.push(...renderRemoteAccessSection(NPM_BIN));
  lines.push(...renderNpmShippedReferencesSection());
  lines.push(...renderBundleViewsSection(NPM_BIN, REFS_POINTER));
  lines.push(...renderNotesSection(referenceNotesAddendum(NPM_BIN, REFS_POINTER)));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// skill target — plugins/agentstate-lite/skills/agentstate-lite/SKILL.md, self-contained committed-bundle channel
// (`npx skills add`). Mirrors the resolver pattern of the reference `holaxis-agentstate` skill.
// ---------------------------------------------------------------------------------------------

/** `## Shipped references` — resolves `$REFS` once, the same way `$ASLITE` is resolved above. */
function renderShippedReferencesSection(): string[] {
  const lines: string[] = [];
  lines.push("## Shipped references — worked examples & contracts alongside the CLI");
  lines.push("");
  lines.push(
    "A few capabilities below (bundle views, custom recipes) are backed by a full contract or a",
  );
  lines.push(
    "worked example shipped in this skill's `references/` folder rather than inlined here, so a",
  );
  lines.push("plain session that never touches them pays nothing for them. Resolve the path once:");
  lines.push("");
  lines.push("```bash");
  lines.push('REFS="$(');
  lines.push("  {");
  lines.push(...hostDiscoveryLines("references", "d"));
  lines.push("  }");
  lines.push(')"');
  lines.push('if [ -z "$REFS" ]; then');
  lines.push(
    '  echo "agentstate-lite: shipped references not found (checked Claude Code (CLAUDE_CONFIG_DIR or ~/.claude) and Codex (CODEX_HOME or ~/.codex) skill + plugin-cache installs)" >&2',
  );
  lines.push("  return 1 2>/dev/null || exit 1");
  lines.push("fi");
  lines.push("```");
  lines.push("");
  lines.push(
    "Every `$REFS/…` path below is a byte-for-byte copy of the matching file in the CLI's own repo —",
  );
  lines.push("one authority, regenerated on every release, never hand-duplicated. If the resolver");
  lines.push(
    "comes up empty, the `references/` folder isn't installed where this skill can find it — an",
  );
  lines.push("uncovered install must fail loudly here, never silently as an empty `$REFS`-rooted path later.");
  lines.push("");
  return lines;
}

/** `## Bundle views` — the concept + v0 request-type names + the 4 authoring steps + a pointer. */
function renderBundleViewsSection(invocation: string, ref: RefPointer): string[] {
  const lines: string[] = [];
  lines.push("## Bundle views — ship a live UI as bundle content");
  lines.push("");
  lines.push(
    "A **bundle view** is a self-contained HTML file living IN the bundle: promoted as a blob under",
  );
  lines.push(
    "`views/…`, declared by a `type: View` registry doc (`title`, `entry`, `access` — the legacy",
  );
  lines.push("`bridge` spelling is no longer read: a doc declaring only `bridge` resolves to `access: none`,");
  lines.push("so author with `access`), and rendered by");
  lines.push(`\`${invocation} ui\` inside a sandboxed, opaque-origin iframe. A data-bearing View is executable`);
  lines.push("code: the shell requires local approval of its exact bytes and declared access, and changed");
  lines.push("bytes ask again. The sandbox and CSP deny direct credentials/data-API access and restrict");
  lines.push("ordinary network APIs as defense-in-depth; approval remains the decision to trust the View's");
  lines.push("source. Bundle data flows only through the narrow postMessage bridge to the trusted shell.");
  lines.push("(`Page` is the legacy name and no longer registers: the launcher ignores `type: Page` docs.");
  lines.push(`\`${invocation} status\` lists legacy-named docs under its legacy_naming finding, and the`);
  lines.push("repo's migrate-legacy-view-names script renames legacy content in place; docs under the");
  lines.push("legacy `pages-registry/`/`pages/` folders stay recognized once typed `View`.)");
  lines.push("");
  lines.push(
    "The bridge (protocol `v0`) has six read-only data request types: `hello` (bundle identity), `query`",
  );
  lines.push(
    "(frontmatter-filtered rows — the same head projection `list` uses), `read` (one doc), `render-document`",
  );
  lines.push(
    "(the shared bounded Markdown presentation for one canonical doc), `edges` (the general",
  );
  lines.push(
    "from/to/text graph query — backlinks and containment both reduce to this), and `subscribe`",
  );
  lines.push(
    "(opt into a server-pushed `change` event whenever the watched bundle moves). There",
  );
  lines.push("is no mutation message in v0 — read-only is enforced by construction. A View that declares");
  lines.push("`bundle-propose` may use the local-only v1 contract to propose ONE governed scalar-field");
  lines.push("change; the trusted shell revalidates it, shows canonical before/after values, and writes");
  lines.push("only after explicit human confirmation with hard CAS. The View never receives a write token.");
  lines.push("`open-page`");
  lines.push("(a wire verb, stable across the rename) is a separate fire-and-forget shell action available");
  lines.push("to every View capability; it opens only another valid registered View and returns none of");
  lines.push("that target's content or metadata.");
  lines.push("");
  lines.push("Author a view in four steps:");
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. write a self-contained views/my-view.html (inline CSS/JS, no external hosts),");
  lines.push("#    embedding the bridge client copied from the shipped contract below");
  lines.push(
    `${invocation} promote my-view.html --doc-key views/my-view.html                        # 2. promote the HTML blob`,
  );
  lines.push(
    `${invocation} promote my-view-registry.md --doc-key views-registry/my-view.md           # 3. promote its type: View doc (title, entry, access)`,
  );
  lines.push(
    `${invocation} promote ${ref.arg("views/conventions/view.md")} --doc-key conventions/view.md   # 4. declare the View convention (once per bundle, ready-made)`,
  );
  lines.push("```");
  lines.push("");
  lines.push(
    "Full message shapes, the trust model, the copy-paste bridge client with safe live-refresh",
  );
  lines.push("examples (including a live graph view over Roadmap Items) are in the shipped contract:");
  lines.push("");
  lines.push("```bash");
  lines.push(`cat ${ref.arg("views/references/view-authoring-v0.md")}`);
  lines.push("```");
  lines.push("");
  return lines;
}

/** Shipped-reference addendum to `## Notes` — see {@link renderNotesSection}'s `extraBullets`. */
function referenceNotesAddendum(invocation: string, ref: RefPointer): string[] {
  return [
    "- Writing a custom recipe: a worked example (the `Claim` kind — event-lifecycle findings with",
    `  provenance, composed from lite primitives) ships at \`${ref.path("recipes/claims/")}\`; copy its shape,`,
    `  then \`${invocation} recipe add <folder>\` to apply it (built-in recipes are named directly, e.g.`,
    `  \`${invocation} recipe add work-tracking\`).`,
    `- Packaging a content-free cognitive ecosystem: \`${ref.path("recipes/review-workflow/")}\` carries a`,
    "  self-describing Review Request kind plus a generic live View, but no review instances. A",
    "  definitions-only recipe may contain only its manifest, convention docs, explicitly declared",
    "  static Reference docs, and View registry/HTML pairs; install it with the same `recipe add <folder>` command.",
    "- A full interop-shaped example bundle (externally-authored markdown: unquoted timestamps,",
    `  relative links, wrapped bullets) ships at \`${ref.path("sample-bundle/")}\` — copy it and point \`--dir\` at`,
    "  the copy to explore a populated bundle without writing one from scratch.",
  ];
}

export function renderSkill(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${SKILL_NAME}`);
  lines.push("description: >-");
  lines.push(
    "  Read and write a local OKF knowledge bundle (agent context notes, docs, cross-links, and live",
  );
  lines.push(
    "  bundle Views) via the self-contained agentstate-lite CLI bundled in this",
  );
  lines.push(
    "  skill (scripts/agentstate-lite — a committed, zero-dependency bundle; no npm install",
  );
  lines.push(
    "  required). Use when an agent needs to persist a context note across sessions, store a",
  );
  lines.push(
    "  decision/spec as a doc, link concepts, query a bundle, share the project's board with",
  );
  lines.push(
    "  teammates (`sync`), run a local wire-protocol server (`serve` / `--remote`), or open the",
  );
  lines.push("  bundle's local View UI.");
  lines.push("---");
  lines.push("");
  lines.push(`# ${SKILL_NAME}`);
  lines.push("");
  lines.push(`${DESCRIPTION}.`);
  lines.push("");
  lines.push(
    "This skill bundles a **self-contained** `agentstate-lite` CLI at `scripts/agentstate-lite` (a",
  );
  lines.push(
    "committed, zero-dependency `.mjs` esbuild bundle, run through a small bash shim). It runs under",
  );
  lines.push(
    "plain `node >= 20` — there is **no install step, no `npm install`, and no `node_modules`**. This",
  );
  lines.push(
    "is a SEPARATE distribution channel from the published npm package (`npx -y @holaxis/aslite`);",
  );
  lines.push("both wrap the identical CLI source, so behavior and output are identical.");
  lines.push("");
  lines.push(...STABLE_MCP_LAUNCH_GUIDANCE.split("\n"), "");
  lines.push("## Invocation — it is NOT on PATH");
  lines.push("");
  lines.push(
    "The bundle is **not** on your `PATH`, and it does **not** live at a fixed path — the bundle may",
  );
  lines.push(
    "ship inside a version-keyed plugin cache, so a bare `scripts/agentstate-lite` does **not**",
  );
  lines.push(
    "resolve from an arbitrary cwd. Resolve its absolute path once, with this one-line resolver, then",
  );
  lines.push(`use \`${ASLITE}\` in every command:`);
  lines.push("");
  lines.push("```bash");
  lines.push('ASLITE="$(');
  lines.push("  command -v agentstate-lite 2>/dev/null || {");
  lines.push(...hostDiscoveryLines("scripts/agentstate-lite", "f"));
  lines.push("  }");
  lines.push(')"');
  lines.push('if [ -z "$ASLITE" ]; then');
  lines.push(
    '  echo "agentstate-lite: plugin executable not found (checked PATH, Claude Code (CLAUDE_CONFIG_DIR or ~/.claude), and Codex (CODEX_HOME or ~/.codex) skill + plugin-cache installs)" >&2',
  );
  lines.push("  return 1 2>/dev/null || exit 1");
  lines.push("fi");
  lines.push(`${ASLITE} --help`);
  lines.push("```");
  lines.push("");
  lines.push(
    "`command -v` short-circuits if a future install ever puts `agentstate-lite` on `PATH`; otherwise",
  );
  lines.push(
    "the fallback checks, for BOTH Claude Code and Codex, a direct skill install (`<host-home>/skills/…`) and",
  );
  lines.push(
    "a plugin-marketplace cache install (`<host-home>/plugins/cache/<marketplace>/<plugin>/<version>/skills/agentstate-lite/scripts/…` — the cache copies the PLUGIN DIR's contents, so there is no `plugins/` segment); each `<host-home>` honors that host's own relocation variable first (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex) and falls back to `~/.claude`/`~/.codex`, and",
  );
  lines.push(
    "`sort -V | tail -1` picks whichever matched path sorts last — a true \"highest version\" pick",
  );
  lines.push(
    "only among matches sharing the same root (e.g. two versions under the same marketplace cache);",
  );
  lines.push(
    "across DIFFERENT roots (direct vs cache, Claude vs Codex) it's a best-effort, path-ordered pick,",
  );
  lines.push(
    "not a true cross-host version comparison. Marketplace discovery is delegated to `find` rather",
  );
  lines.push(
    "than shell-expanded optional globs, so the same block works under Bash and default zsh. This",
  );
  lines.push(
    "works from any cwd. Resolve to",
  );
  lines.push(
    "the **shim** (not the `.mjs` directly) so the Node >= 20 floor guard runs first. OpenCode isn't",
  );
  lines.push(
    "in this search: it never reads this file — its SessionStart integration bakes the CLI's path in",
  );
  lines.push(
    "directly at `hook install` time instead (see that command's own docs). If NONE of the checked",
  );
  lines.push(
    "installs match — an uncovered host, a corrupted install — the resolver fails LOUDLY to stderr",
  );
  lines.push("and stops, rather than silently handing you an empty command.");
  lines.push("");
  lines.push(
    "> If your harness happens to export `${CLAUDE_PLUGIN_ROOT}` you may instead use",
  );
  lines.push(
    '> `"$CLAUDE_PLUGIN_ROOT/skills/agentstate-lite/scripts/agentstate-lite"`, but it is **often unset**',
  );
  lines.push("> in an agent shell — do not rely on it; prefer the resolver above.");
  lines.push("");
  lines.push(
    "**Runtime-hint note.** Every follow-up command the CLI itself prints (`help:` fields, error",
  );
  lines.push(
    "hints) uses its own resolved invocation. Off `PATH`, running the skill bundle now prints its own",
  );
  lines.push(
    "resolved absolute path there — directly runnable as printed, no substitution needed. If a bare",
  );
  lines.push(
    "`aslite`/`agentstate-lite` or an `npx -y @holaxis/aslite …` prefix ever shows up instead (e.g. a",
  );
  lines.push(
    `different install answered the \`PATH\` probe), swap that leading token for \`${ASLITE}\` and run`,
  );
  lines.push("the rest of the line unchanged.");
  lines.push("");
  lines.push(
    "<!-- GENERATED from src/reference.ts by scripts/gen-skill.mjs --target skill — do not edit by hand. -->",
  );
  lines.push("");
  lines.push(...renderCommandsSection(COMMAND_GROUPS, ASLITE));
  lines.push(...renderWorkspaceLocation(ASLITE));
  lines.push(...renderTypicalFlow(ASLITE));
  lines.push(...renderSyncSection(ASLITE));
  lines.push(...renderRemoteAccessSection(ASLITE));
  lines.push(
    "The wire-protocol v0.1 contract `serve` implements is documented as a project bundle doc, not",
  );
  lines.push(
    "(yet) shipped in this skill's references — `serve`'s own source is the authoritative reference",
  );
  lines.push("implementation in the meantime.");
  lines.push("");
  lines.push(...renderShippedReferencesSection());
  lines.push(...renderBundleViewsSection(ASLITE, REFS_POINTER));
  lines.push(...renderNotesSection(referenceNotesAddendum(ASLITE, REFS_POINTER)));
  return lines.join("\n");
}
