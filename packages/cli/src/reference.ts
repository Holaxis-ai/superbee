// SINGLE SOURCE OF TRUTH for the CLI's self-description.
//
// `DESCRIPTION` + `COMMAND_GROUPS` feed two consumers that therefore CANNOT drift:
//   1. the zero-arg `home` view (identity header + command reference),
//   2. the `--help` / `-h` / `help` reference.
//
// Neither `home` nor `--help` may hardcode a command list — both derive from `COMMAND_GROUPS` via the
// pure `commandReference()` projector below. Adding/removing a command here updates every consumer at
// once. This module is pure data + a pure projection: NO I/O, NO imports beyond TypeScript types.
//
// `--help` renders `commandReference()`'s output as PLAIN PROSE via `helpIndexText()` (grouped
// headings, one command per physical line) — never TOON. Field feedback (external-agent session,
// help-index-readability task) found the previous rendering (TOON-encoding the same data) crammed
// every group's commands into one escaped string-array value per line, forcing an agent to grep a
// giant line instead of reading it; subcommand help (e.g. `new --help`) is plain prose and was
// praised by the same agent. Help is prose an agent READS, not data it parses — TOON stays the
// default for actual data surfaces (`list`, `status`, …), never for this index. `home` keeps
// rendering `compactCommandReference()`'s command NAMES as TOON (it is real per-session state —
// bundle summary — not a help manual), so this is a renderer change scoped to `--help`
// alone; the registry (`COMMAND_GROUPS`) and `commandReference()`'s projection are untouched.
//
// Adapted from holaxis-agentstate `packages/cli/src/reference.ts`, retargeted from the promote/pull
// command set to the OKF-native bundle command set.

/** The one-sentence tagline. */
export const DESCRIPTION =
  "read and write a local OKF knowledge bundle (context notes, docs, cross-links, live bundle Views)";

/** A single command's usage line + a one-line summary of what it does. */
export interface CommandRef {
  usage: string;
  summary: string;
  /** Literal executable leaf paths represented by this reference row. */
  paths: readonly string[];
}

/** A named group of related commands (e.g. "Bundle", "Notes & Docs", "Session"). */
export interface CommandGroup {
  group: string;
  commands: readonly CommandRef[];
}

/**
 * Every command the CLI exposes, grouped for display. This is the ONLY place the command list is
 * enumerated.
 */
export const COMMAND_GROUPS = [
  {
    group: "Bundle",
    commands: [
      {
        paths: ["bundle locate"],
        usage: "bundle locate [--dir <path>]",
        summary: "Resolve the exact canonical local bundle path and report why it won selection",
      },
      {
        paths: ["catalog add", "catalog list", "catalog resolve"],
        usage:
          "catalog (add <label> [--dir <path>] | list | resolve <label-or-id> [--field path])",
        summary:
          "Register and deterministically resolve this user's explicitly named local workspaces",
      },
      {
        paths: ["init"],
        usage: "init [--dir <path>] [--okf-version <v>] [--recipe <name-or-path>] [--create-only]",
        summary:
          "Create (or open) an OKF knowledge bundle in a directory — greenfield setup; a project that already shares a board is set up by sync, not init. --create-only requires a genuinely NEW target and refuses existing, non-empty, symlinked, enclosing, bound, or concurrent targets before publication; runtime failures retain and report any empty directories they created instead of deleting them — 'recipe add' modifies a verified existing bundle",
      },
      {
        paths: ["index generate"],
        usage: "index generate [--dir <path>] [--check] [--force] [--actor <name>]",
        summary:
          "Generate complete portable Markdown navigation explicitly; refuses curated indexes unless --force adopts them",
      },
      {
        paths: ["status"],
        usage: "status [--limit <n>] [--remote <url>]",
        summary: "Read-only bundle health report (kind lint, unresolved links, orphans, staleness, graph lints)",
      },
    ],
  },
  {
    group: "Documents & links",
    commands: [
      {
        paths: ["doc write"],
        usage:
          "doc write <id> --type <t> [--title <t>] [--body <s> | --body-file <p>] [--actor <n>] [--remote <url>]",
        summary: "Write a generic OKF concept document",
      },
      {
        paths: ["doc update"],
        usage:
          "doc update <id> [--<field> <value> ...] [--title <t>] [--tag <t>] [--type <t>] [--body <s> | --body-file <p>] [--expected-version <v>] [--actor <n>] [--remote <url>]",
        summary: "Patch given fields (incl. kind-declared fields like --status) of an existing doc, preserving the rest; optimistic-CAS with --expected-version",
      },
      {
        paths: ["doc read"],
        usage:
          "doc read <id> [--out (<path> | -) | --body-out (<path> | -) | --field <name>] [--remote <url>]",
        summary:
          "Read a doc, export its raw markdown, export its body with a same-read CAS version, or print one raw field for scripting",
      },
      {
        paths: ["doc history"],
        usage: "doc history <id> [--limit <n>] [--remote <url>]",
        summary:
          "Show a doc's version history (newest first, capped at 20 by default — --limit 0 for all; a history-keeping backend returns the full attributed chain, a local bundle just the current revision) — the tokens for --expected-version",
      },
      {
        paths: ["doc delete"],
        usage: "doc delete <id> [--expected-version <v>] [--remote <url>]",
        summary: "Hard-delete a doc (idempotent: absent -> deleted:false, exit 0)",
      },
      {
        paths: ["list", "query"],
        usage: "list [--type <t>] [--tag <t>] [--field <k=v>] [--prefix <p>] [--open] [--limit <n>] [--remote <url>]",
        summary:
          "Query concepts over their frontmatter (alias: query) — a comma in --field's value is set membership (OR); --open excludes terminal instances (declared kinds only)",
      },
      {
        paths: ["link add", "link show", "link list"],
        usage:
          "link (add <from> <to> [--text <t>] [--actor <n>] | show <id> [--limit <n>] [--text <t>] | list [--from <id|prefix/>] [--to <id|prefix/>] [--text <t>] [--limit <n>]) [--remote <url>]",
        summary:
          "Add a cross-link, show a concept's links + backlinks, or query the whole bundle's derived edge list filtered by from/to (id or prefix/, repeatable/union) and exact-match text",
      },
    ],
  },
  {
    group: "Artifacts",
    commands: [
      {
        paths: ["artifact create"],
        usage: "artifact create <file> --title <title> [--description <text>] [--supersedes <id>] [--actor <n>] [--remote <url>]",
        summary: "Produce a shareable output (HTML) a human can view: one command promotes the bytes and writes the type:Artifact record",
      },
      {
        paths: ["promote"],
        usage:
          "promote <file> --doc-key <key> [--content-type <mime>] [--expected-version <v>] [--remote <url>]",
        summary: "Move a local file's bytes into the store (a .md key routes through the engine; else a blob)",
      },
      {
        paths: ["pull"],
        usage: "pull --doc-key <key> --out (<path> | -) [--remote <url>]",
        summary: "Pull a doc's canonical form or a blob's raw bytes out of the store (the reverse of promote)",
      },
      {
        paths: ["blobs"],
        usage: "blobs [--prefix <p>] [--limit <n>] [--remote <url>]",
        summary: "List the store's blob (non-document) keys (documents are listed by 'list'/'query')",
      },
      {
        paths: ["delete"],
        usage: "delete --doc-key <key> [--expected-version <v>] [--remote <url>]",
        summary: "Hard-delete a doc or blob by key (idempotent: absent -> deleted:false, exit 0)",
      },
    ],
  },
  {
    group: "Kinds",
    commands: [
      {
        paths: ["new"],
        usage:
          'new "<Kind>" <id> --<field> <value> [...] [--body <markdown> | --body-file <path>] [--link "<type>=<target-id>" ...] [--no-prefix] [--actor <n>] [--remote <url>]',
        summary:
          'Create a new instance of a bundle-declared kind — initial Markdown may come from --body or --body-file (otherwise declared sections are scaffolded); validates strictly, and repeatable --link wires typed cross-links in the same step',
      },
      {
        paths: ["kinds"],
        usage: "kinds [--remote <url>]",
        summary:
          "List the kind conventions this bundle declares (purpose, described fields, exact required body headings, typed-link vocabulary, horizon)",
      },
      {
        paths: ["kind field add", "kind field remove"],
        usage: 'kind field "<Kind>" (add <name> [--required] [--values <a,b,c>] | remove <name>) [--remote <url>]',
        summary: "Edit a kind's schema — add/remove a declared field or enum value on its convention (idempotent)",
      },
      {
        paths: ["recipes"],
        usage: "recipes [--dir <path>] [--remote <url>]",
        summary:
          "Browse built-in recipes before or after init; with a bundle, also show whether each is already applied",
      },
      {
        paths: ["recipe add"],
        usage: "recipe add <name-or-path> [--remote <url>]",
        summary:
          "Apply a recipe's content-free definitions — Kinds plus optional declared References and Views — idempotently",
      },
    ],
  },
  {
    group: "Remote",
    commands: [
      {
        paths: ["serve"],
        usage: "serve [--dir <path>] [--host <h>] [--port <p>]",
        summary: "Boot the reference wire-protocol server over a local bundle (loopback, no auth)",
      },
      {
        paths: ["ui"],
        usage: "ui [--dir <path> | --remote <url>] [--port <p>] [--open]",
        summary:
          "Boot the local web UI over the bundle (same origin, loopback-only): READ the bundle's docs as rendered pages (frontmatter, cross-links you can follow, derived backlinks), LAUNCH its registered Views (type: View docs framed in sandboxed iframes with live updates; legacy Page-typed docs no longer register — see status's legacy_naming finding), and see a live activity feed, the bundle's sharing status, and your registered workspaces. The header shows the bundle's display name — derived from the project folder unless set explicitly: doc write docs/bundle --type \"Bundle Name\" --title \"<name>\"",
      },
      {
        paths: ["mcp"],
        usage: "mcp [--dir <path>] [--actor <name>]",
        summary:
          "Run the experimental local MCP Apps adapter over a bundle (stdio): launch an existing registered View unchanged, or launch standard active View HTML transiently and save its approved exact bytes as a registered View; bundle data and governed actions stay behind local human approval",
      },
      {
        paths: ["view list"],
        usage: "view list [--limit <n>] [--dir <path> | --remote <url>]",
        summary:
          "List the bundle's registered durable Views from the same catalog used by the web launcher and MCP list_views",
      },
      {
        paths: ["sync"],
        usage:
          "sync [--establish [--yes] | --pull-only | --show-incoming <id> [--out <file>]] [--dir <path>] [--limit <n>]",
        summary:
          "Share the board branch with a remote — commits, pulls, and pushes (git tier; --pull-only skips commit+push). `init` makes a LOCAL bundle; --establish is the separate, explicit act that starts sharing it (creates the board branch, pushes; never automatic). A bundle folder already committed on the code branch is the same flag's hard case: preview first, --yes executes, and the folder's removal from the code branch rides a prepared side-branch commit you push and open as a PR. A bundle committed with code and NO board branch anywhere is the IN-TREE mode (read-side): full sync refuses (sharing rides your normal commit/push), --pull-only fetches the branch's tracking upstream and reports incoming board docs ('git pull' delivers them), and --establish converts to a dedicated board branch. A doc changed on both sides converges: teammate's version kept, yours exported; --show-incoming <id> (exclusive with --pull-only) prints the incoming version as of the last fetch. Board-reading commands (list/doc read/status/home/link show) auto-run the ff-only pull when board state is >~5m stale — silent, bounded (~2s), never a push; AGENTSTATE_LITE_NO_AUTOPULL=<any value, even 0> disables it",
      },
    ],
  },
  {
    group: "Session",
    commands: [
      {
        paths: ["version"],
        usage: "version [--check] [--tag latest|next] [--json]",
        summary:
          "Show the complete local build/runtime identity, or perform one bounded read-only comparison against npm's exact latest/next release policy",
      },
      {
        paths: ["session-start"],
        usage: "session-start [--dir <path>] [--no-update-check]",
        summary:
          "The SessionStart hook payload: pull then render; default TOON uses a nonblocking 24-hour cached latest check, while --no-update-check or ASLITE_NO_UPDATE_CHECK/NO_UPDATE_NOTIFIER/CI presence disables both display and refresh; npm receives only the public package request and ordinary network metadata, never installed version, cwd, bundle, actor, or usage data",
      },
      {
        paths: ["hook install", "hook status", "hook uninstall"],
        usage: "hook install|status|uninstall [--scope project|user]",
        summary: "Install the SessionStart hook (runs session-start: pull the board, then render) for Claude Code, Codex, OpenCode",
      },
      {
        paths: ["skill install", "skill status", "skill uninstall"],
        usage: "skill install|status|uninstall [--scope project|user]",
        summary:
          "Install this package's Agent Skill (SKILL.md + references/) into Claude Code and Codex skill folders (OpenCode has no skill surface — its integration is `hook install`); manifest-tracked, idempotent, refuses folders it does not manage",
      },
    ],
  },
] as const satisfies readonly CommandGroup[];

/** Public executable leaf path derived from the required literal reference metadata. */
export type PublicLeafPath = (typeof COMMAND_GROUPS)[number]["commands"][number]["paths"][number];

/**
 * Static pointer TEMPLATE (no bundle I/O) from the offline `--help`/`home` views toward the live
 * kind-convention registry. Kind conventions are declared PER-BUNDLE (a `Convention` doc under
 * `conventions/`), so enumerating them requires a live registry load — which `--help`/`home` may
 * never do (they are pure/offline by contract, see `home.ts`'s OFFLINE GUARANTEE). The Phase-0 CLI
 * grammar experiment (kind-conventions plan, Part B) found this pointer is the causal ingredient:
 * subjects with NO discoverable path from help toward the registry spiraled into ~49-command probes;
 * this one static line, paired with the live `kinds` command, closed that gap.
 *
 * Takes the RESOLVED invocation prefix as a plain string argument rather than resolving it itself
 * (that would mean importing `invocation.ts`'s filesystem/PATH resolution into this module, breaking
 * its "NO I/O, NO imports beyond TypeScript types" contract) — every call site already resolves one
 * (`cliInvocation()` in `cli.ts`, `deps.invocation()` in `home.ts`) for its OTHER emitted hints, so
 * this is purely a projection of a value the caller already has.
 */
export function kindsPointer(invocation: string): string {
  return `kinds are declared per-bundle — run \`${invocation} kinds\` to list them`;
}

/**
 * Static pointer describing explicit remote activation and local bundle resolution, shown in BOTH
 * `--help` and home without bundle I/O.
 */
export function remoteEnvPointer(): string {
  return (
    "bundle resolution: HTTP is activated only by explicit --remote <url>; otherwise an explicit " +
    "--dir wins, then a committed .agentstate.json local-path binding at or above the cwd, then local " +
    "discovery walks up for an enclosing or conventional project bundle. URL-valued bindings and the " +
    "retired AGENTSTATE_LITE_REMOTE ambient default fail with guidance to pass --remote explicitly"
  );
}

/** A renderable command reference: group name -> array of "usage — summary" lines. */
export interface CommandReference {
  commands: Record<string, string[]>;
  /** See {@link kindsPointer}. */
  kinds: string;
  /** See {@link remoteEnvPointer}. */
  remoteEnv: string;
}

/**
 * Project COMMAND_GROUPS into a renderable plain object — the shared shape both the home view and the
 * `--help` reference render, so they cannot diverge. Pure: derives entirely from COMMAND_GROUPS plus
 * the caller-supplied `invocation` prefix (see {@link kindsPointer}).
 */
export function commandReference(invocation: string): CommandReference {
  const commands: Record<string, string[]> = {};
  for (const { group, commands: refs } of COMMAND_GROUPS) {
    commands[group] = refs.map((c) => `${c.usage} — ${c.summary}`);
  }
  return { commands, kinds: kindsPointer(invocation), remoteEnv: remoteEnvPointer() };
}

/**
 * The leading command word(s) of a usage string, up to its first argument/flag/option token —
 * e.g. `"doc read <id> [--out …]"` -> `"doc read"`. Exported (beyond its original
 * {@link compactCommandReference} use) so distribution-resources.ts's skill projection registry and
 * its exhaustiveness gate (test/skill-distribution.test.ts) derive command NAMES from the exact
 * same projection `--help`/`home` already use — never a second, driftable name-extraction rule.
 */
export function commandName(usage: string): string {
  const stop = usage.search(/[<[("]|\s--|\s-\w/);
  return (stop === -1 ? usage : usage.slice(0, stop)).trim();
}

/**
 * A COMPACT command list for the home view — which IS the SessionStart hook payload, so it must stay
 * token-lean (AXI §7 "ruthlessly minimize"). Each group maps to its command NAMES only (no
 * usage/summary): discoverability of WHAT commands exist is preserved (every name is visible) while
 * the verbose per-command reference — which the full `--help` still carries — is dropped, cutting the
 * every-session payload substantially. A comprehensive UX audit flagged the full reference (~1.6k
 * tokens) rendering on every session as the single worst §7 violation.
 */
export function compactCommandReference(invocation: string): {
  commands: Record<string, string>;
  commands_help: string;
} {
  const commands: Record<string, string> = {};
  for (const { group, commands: refs } of COMMAND_GROUPS) {
    // Set-dedupe usage variants of one command: a name-only view gains nothing from repeating it.
    commands[group] = [...new Set(refs.map((c) => commandName(c.usage)))].join(", ");
  }
  return {
    commands,
    commands_help: `run \`${invocation} <command> --help\` (or \`${invocation} --help\`) for full usage`,
  };
}

/**
 * Word-wrap `text` to `width` columns, breaking only at existing spaces (never mid-word). Pure, no
 * I/O. Used solely to keep the footer pointers ({@link kindsPointer}, {@link remoteEnvPointer}) —
 * each authored as one long single-line string — readable as wrapped prose in `helpIndexText()`
 * instead of one unbroken line; command usage/summary lines are deliberately left un-wrapped (see
 * {@link helpIndexText}'s comment).
 */
export function wrapText(text: string, width = 96): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wrapped: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length > width && line.length > 0) {
      wrapped.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) wrapped.push(line);
  return wrapped.join("\n");
}

/**
 * The `--help` / `-h` / `help` INDEX: `commandReference()`'s data rendered as grouped PLAIN TEXT —
 * a heading per group, one command per physical line (its usage synopsis and one-line summary
 * joined by " — ", exactly as `commandReference()` already composes them — only the OUTPUT FORMAT
 * changes here, from a TOON-encoded object to prose). Command lines are intentionally left
 * un-wrapped (some usage+summary pairs are long; splitting them across physical lines would break
 * the "one command per line" property this rewrite exists to deliver) — only the free-prose footer
 * pointers are wrapped, via {@link wrapText}. Pure: derives entirely from {@link commandReference}
 * plus the caller-supplied `invocation` prefix; no I/O.
 */
export function helpIndexText(invocation: string): string {
  const ref = commandReference(invocation);
  const lines: string[] = [
    `${invocation} — ${DESCRIPTION}`,
    "",
    `Usage: ${invocation} <command> [options]`,
    `Run \`${invocation} <command> --help\` for a specific command's full reference.`,
  ];
  for (const [group, commandLines] of Object.entries(ref.commands)) {
    lines.push("", `${group}:`);
    for (const commandLine of commandLines) {
      lines.push(`  ${commandLine}`);
    }
  }
  lines.push("", wrapText(ref.kinds), "", wrapText(ref.remoteEnv));
  return `${lines.join("\n")}\n`;
}
