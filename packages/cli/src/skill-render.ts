// Pure renderer for the npm-carried SKILL.md. gen-skill.mjs bundles this module in memory and
// writes the committed package projection. NO I/O: pure functions over reference.ts's command data
// and distribution-resources.ts's npm inventory.
import { DESCRIPTION, COMMAND_GROUPS, commandName, type CommandGroup } from "./reference.js";
import { NPM_RESOURCES } from "./distribution-resources.js";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "./integration-guidance.js";

export { NPM_RESOURCES, commandName };

// Superbee is the canonical npm coordinate and command. The legacy aliases `aslite` and `agentstate-lite`
// remain installed so existing users do not need to migrate.
const NPM_COORDINATE = "superbee";
const NPM_BIN = "superbee";
const NPX = `npx -y ${NPM_COORDINATE}`;

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
  lines.push(`${prefix} sync --establish                # establish a new shared board after user approval`);
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
    `The folder is LOCAL until you choose to share it: \`${prefix} sync --establish\` (once) publishes it`,
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
    "Write with attribution: set `SUPERBEE_ACTOR=<your-name>` once for `new`, `doc write`,",
  );
  lines.push(
    "`doc update`, and `link add`, or pass `--actor <your-name>` per command (the flag wins).",
  );
  lines.push("Existing `AGENTSTATE_LITE_ACTOR` settings remain supported as a compatibility input.");
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
    "Otherwise bundle resolution stays local: explicit `--dir` → nearest `.superbee.json` or",
  );
  lines.push("supported `.agentstate.json` local-path binding up-tree → the cwd walk, which at each");
  lines.push("ancestor checks both binding names together (both at one level fail closed), then the");
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
    "   `.superbee.json` binding (`{ \"bundle\": \"<path>\" }` at the project root) is the",
  );
  lines.push("   preferred durable form; existing `.agentstate.json` bindings remain supported. A binding");
  lines.push("   beats the conventional folder; both binding names at one level are a conflict.");
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
    "scratch workspace), keep the bundle OUT of the repo (e.g. under `~/.agentstate/<name>/`)",
  );
  lines.push(
    "and point a git-excluded `.superbee.json` at it. Choose by one question: do teammates",
  );
  lines.push("share this bundle? When the user's intent is ambiguous, ask rather than defaulting silently.");
  lines.push("");
  lines.push(
    "Do not raise a sharing decision during ordinary local work. When the user names teammates,",
  );
  lines.push(
    "a shared board, a handoff, synchronization, or cross-clone coordination, use Superbee's",
  );
  lines.push(
    "built-in board path: run `sync` to join an existing `origin/board`; if none exists, explain",
  );
  lines.push(
    "that `sync --establish` creates it and offer to run that explicit one-time operation. Do not",
  );
  lines.push(
    "substitute an in-tree committed bundle, a custom Git branch/path, or another sharing mechanism.",
  );
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
  lines.push(`# If collaboration is requested, offer the explicit one-time shared-board operation:`);
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
  lines.push(`# For a shared board, sync after a unit of work; local-only work stays complete locally`);
  lines.push(`# (safe everywhere: a local-only board reports its state; outside any workspace it prints`);
  lines.push(`#  "sync: nothing to sync" — in both cases nothing is committed or pushed)`);
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
    `Ordinary \`${prefix} sync\` shares your board — commits your changes, pulls your teammate's, pushes yours,`,
  );
  lines.push("while leaving code-project files untouched.");
  lines.push("");
  lines.push(
    "On a shared board, run it whenever you close a unit of work — a task finished, a decision recorded, a session",
  );
  lines.push(
    "ending. Local-only work remains complete locally. Three known empty states (all exit 0):",
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
    "(CI, scripted runs), set `SUPERBEE_NO_AUTOPULL` to any non-empty value — even `0`",
  );
  lines.push("disables it; the variable's presence is the switch.");
  lines.push("Legacy `AGENTSTATE_LITE_NO_AUTOPULL` remains supported with the same presence semantics.");
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
 * `## Notes` heading — the npm renderer passes its {@link referenceNotesAddendum} projection.
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
    "- `new` and `doc update` accept a kind's declared fields as `--<field> <value>` (e.g. `--progress_status done`);",
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

/** Remote-access guidance for the published npm Skill. */
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
  lines.push("For an authenticated remote, provide `SUPERBEE_API_KEY`; an already-provisioned");
  lines.push("stored per-origin credential is also consumed when present. Legacy `AGENTSTATE_LITE_API_KEY`");
  lines.push("remains supported as a compatibility input. Account and admin credential");
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
// Shipped-reference pointer form. Shell commands resolve against the process cwd, never the
// installed SKILL.md's folder, so a bare relative `references/…` argument would fail from a
// project root after a host install. The npm-carried Skill instructs the reader to set `$REFS`
// from the skill base directory its host reports; no cache-path discovery is required.
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
  lines.push(`this file is installed into (\`${NPM_BIN} skill install\`).`);
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

/** npm-channel "not on PATH" guidance. */
function renderNpmPathSection(): string[] {
  const lines: string[] = [];
  lines.push(`## If \`${NPM_BIN}\` is not on PATH`);
  lines.push("");
  lines.push(`Every example below assumes the \`${NPM_BIN}\` bin is on PATH. If it is not:`);
  lines.push("");
  lines.push(`- \`npm install -g ${NPM_COORDINATE}\` puts it (and the legacy aliases \`aslite\` and \`agentstate-lite\`) on PATH.`);
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
    "  bundle Views) from the shell via the Superbee CLI. Use when an agent",
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
    `It is a standalone npm package (\`${NPM_COORDINATE}\`) installing three bins for the identical CLI: \`${NPM_BIN}\` and the`,
  );
  lines.push("legacy aliases `aslite` and `agentstate-lite`. Every example below uses `superbee`.");
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
  lines.push(...renderHumanReviewSection(NPM_BIN));
  lines.push(...renderNotesSection(referenceNotesAddendum(NPM_BIN, REFS_POINTER)));
  return lines.join("\n");
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

function renderHumanReviewSection(invocation: string): string[] {
  return [
    "## Human review",
    "",
    "When you create or materially revise a bundle document for human review, display it when the",
    "human asks and otherwise offer once. In an MCP Apps host, call `show_document` with the exact",
    "document ID; do not return only a filesystem path. Outside an MCP Apps host, run",
    `\`${invocation} doc open <id>\` to open that exact document in the existing browser reader.`,
    "",
  ];
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
