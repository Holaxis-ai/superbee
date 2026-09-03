// Pure CLI grammar metadata. This module owns executable leaf identity, canonical alias identity,
// exact positional count, display attachment, and ordered top-level command projection. It imports
// no handlers, rendering, invocation policy, SDK, or I/O.

const CLI_LEAF_BRAND: unique symbol = Symbol("superbee.cli-leaf");
const OWNED_CLI_LEAVES = new WeakSet<object>();

export interface ExactPositionalArity {
  readonly kind: "exact";
  readonly count: number;
}

/**
 * What a caller-supplied path token BECOMES. The private-state boundary is a property of the ACT,
 * not of the command (see the boundary specification's table F), so the registry records the act:
 *
 * - `bundle-root`  the token names a bundle root or board path (`--dir`).
 * - `ingress`      the token's BYTES are read (`--body-file`, `promote`/`artifact create <file>`).
 * - `egress`       the token is a destination the CLI writes to (`--out`, `--body-out`, `--rendered-out`).
 * - `recipe-source` a recipe ROOT, deliberately NOT routed through the ingress guard (its adapter
 *   carries its own containment authority) — recorded so the exclusion is a decision, not a gap.
 * - `rejected`     a shared selector parse config accepts the flag on this leaf, which then rejects
 *   it as a USAGE error before it can become a filesystem target (`catalog list --dir`).
 */
export type CliPathRole = "bundle-root" | "ingress" | "egress" | "recipe-source" | "rejected";

/** One path-valued option this leaf's parser accepts, and what the value becomes. */
export interface CliPathFlag {
  readonly flag: string;
  readonly role: CliPathRole;
}

/** One path-valued POSITIONAL this leaf consumes, by index within the leaf's own data. */
export interface CliPathPositional {
  readonly index: number;
  readonly role: CliPathRole;
}

export interface CliLeafSpec<
  Id extends string = string,
  Path extends string = string,
  Exposure extends "public" | "hidden" = "public" | "hidden",
> {
  readonly id: Id;
  readonly path: Path;
  readonly command: FirstWord<Path>;
  readonly arity: ExactPositionalArity;
  readonly canonical: CliLeafSpec;
  readonly exposure: Exposure;
  readonly commandOrder?: number;
  /**
   * Every path-valued option this leaf accepts. This is the ENUMERATION the boundary coverage
   * tables derive their required rows from: a new path-accepting command declares itself here (and
   * `cli-path-surface.test.ts` proves the declaration against the shipped parser), so the coverage
   * table cannot silently miss it the way four hand-kept lists did.
   */
  readonly pathFlags: readonly CliPathFlag[];
  /** Path-valued positionals, same purpose as `pathFlags`. */
  readonly pathPositionals: readonly CliPathPositional[];
  /**
   * This leaf's parser accepts UNDECLARED `--flag` tokens as document fields (`strict:false`), so
   * "an undeclared flag is rejected" is not observable for it.
   */
  readonly dynamicFieldFlags?: true;
  readonly [CLI_LEAF_BRAND]: true;
}

export interface CommandSpecRow<Leaf extends CliLeafSpec = CliLeafSpec> {
  readonly id: string;
  readonly usage: string;
  readonly summary: string;
  readonly leaves: readonly Leaf[];
}

export interface CommandSpecGroup<Row extends CommandSpecRow = CommandSpecRow> {
  readonly group: string;
  readonly commands: readonly Row[];
}

type FirstWord<Path extends string> = Path extends `${infer Head} ${string}` ? Head : Path;
type LeavesOf<Groups extends readonly CommandSpecGroup[]> =
  Groups[number]["commands"][number]["leaves"][number];
type LeafIndex<Groups extends readonly CommandSpecGroup[]> = {
  readonly [Leaf in LeavesOf<Groups> as Leaf["id"]]: Leaf;
};

export function exactPositionalArity(count: number): ExactPositionalArity {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`exact positional count must be a non-negative safe integer; received ${count}`);
  }
  return Object.freeze({ kind: "exact", count });
}

const zero = exactPositionalArity(0);
const one = exactPositionalArity(1);
const two = exactPositionalArity(2);

function pathFlags(...flags: readonly CliPathFlag[]): readonly CliPathFlag[] {
  return Object.freeze(flags.map((entry) => Object.freeze({ ...entry })));
}

/** Shared path-surface shapes. Named so a new leaf reuses a vetted set instead of inventing one. */
const NO_PATHS = pathFlags();
const BUNDLE_DIR = pathFlags({ flag: "dir", role: "bundle-root" });
const BUNDLE_DIR_REJECTED = pathFlags({ flag: "dir", role: "rejected" });
const BUNDLE_DIR_AND_BODY_FILE = pathFlags(
  { flag: "dir", role: "bundle-root" },
  { flag: "body-file", role: "ingress" },
);
const NO_PATH_POSITIONALS: readonly CliPathPositional[] = Object.freeze([]);
const FIRST_POSITIONAL_IS_INGRESS: readonly CliPathPositional[] = Object.freeze([
  Object.freeze({ index: 0, role: "ingress" as const }),
]);

interface LeafPathSurface {
  readonly flags?: readonly CliPathFlag[];
  readonly positionals?: readonly CliPathPositional[];
  readonly dynamicFieldFlags?: true;
}

const DIR_SURFACE: LeafPathSurface = Object.freeze({ flags: BUNDLE_DIR });
const DIR_REJECTED_SURFACE: LeafPathSurface = Object.freeze({ flags: BUNDLE_DIR_REJECTED });
const DIR_BODY_FILE_SURFACE: LeafPathSurface = Object.freeze({ flags: BUNDLE_DIR_AND_BODY_FILE });
const DIR_BODY_FILE_DYNAMIC_SURFACE: LeafPathSurface = Object.freeze({
  flags: BUNDLE_DIR_AND_BODY_FILE,
  dynamicFieldFlags: true,
});
const DIR_OUT_SURFACE: LeafPathSurface = Object.freeze({
  flags: pathFlags({ flag: "dir", role: "bundle-root" }, { flag: "out", role: "egress" }),
});
const DIR_SYNC_SURFACE: LeafPathSurface = Object.freeze({
  flags: pathFlags(
    { flag: "dir", role: "bundle-root" },
    { flag: "out", role: "egress" },
    { flag: "body-out", role: "egress" },
  ),
});
const DIR_DOC_READ_SURFACE: LeafPathSurface = Object.freeze({
  flags: pathFlags(
    { flag: "dir", role: "bundle-root" },
    { flag: "out", role: "egress" },
    { flag: "body-out", role: "egress" },
    { flag: "rendered-out", role: "egress" },
  ),
});
const DIR_RECIPE_SURFACE: LeafPathSurface = Object.freeze({
  flags: pathFlags({ flag: "dir", role: "bundle-root" }, { flag: "recipe", role: "recipe-source" }),
});
const DIR_INGRESS_FILE_SURFACE: LeafPathSurface = Object.freeze({
  flags: BUNDLE_DIR,
  positionals: FIRST_POSITIONAL_IS_INGRESS,
});
const DIR_RECIPE_ROOT_SURFACE: LeafPathSurface = Object.freeze({
  flags: BUNDLE_DIR,
  positionals: Object.freeze([Object.freeze({ index: 0, role: "recipe-source" as const })]),
});

function firstWord<Path extends string>(path: Path): FirstWord<Path> {
  return path.split(" ", 1)[0] as FirstWord<Path>;
}

function surfaceOf(surface: LeafPathSurface | undefined, arity: ExactPositionalArity): {
  pathFlags: readonly CliPathFlag[];
  pathPositionals: readonly CliPathPositional[];
} {
  const positionals = surface?.positionals ?? NO_PATH_POSITIONALS;
  for (const entry of positionals) {
    if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= arity.count) {
      throw new TypeError(`path positional index ${entry.index} is outside the leaf's arity`);
    }
  }
  return { pathFlags: surface?.flags ?? NO_PATHS, pathPositionals: positionals };
}

function publicLeaf<const Id extends string, const Path extends string>(
  id: Id,
  path: Path,
  arity: ExactPositionalArity,
  commandOrder?: number,
  surface?: LeafPathSurface,
): CliLeafSpec<Id, Path, "public"> {
  if (commandOrder !== undefined && (!Number.isSafeInteger(commandOrder) || commandOrder < 0)) {
    throw new TypeError(`command order must be a non-negative safe integer; received ${commandOrder}`);
  }
  const mutable = {
    id,
    path,
    command: firstWord(path),
    arity,
    canonical: undefined as unknown as CliLeafSpec,
    exposure: "public" as const,
    ...(commandOrder === undefined ? {} : { commandOrder }),
    ...surfaceOf(surface, arity),
    ...(surface?.dynamicFieldFlags ? { dynamicFieldFlags: true as const } : {}),
    [CLI_LEAF_BRAND]: true as const,
  };
  mutable.canonical = mutable;
  OWNED_CLI_LEAVES.add(mutable);
  return Object.freeze(mutable);
}

function publicAlias<const Id extends string, const Path extends string, Canonical extends CliLeafSpec>(
  id: Id,
  path: Path,
  canonical: Canonical,
  commandOrder?: number,
): CliLeafSpec<Id, Path, "public"> {
  if (canonical.exposure !== "public") throw new TypeError("a public alias must target a public leaf");
  const mutable = {
    id,
    path,
    command: firstWord(path),
    arity: canonical.arity,
    canonical: canonical.canonical,
    exposure: "public" as const,
    ...(commandOrder === undefined ? {} : { commandOrder }),
    // An alias is the same executable surface under a second spelling: its path metadata is the
    // canonical leaf's, never a second declaration that could drift.
    pathFlags: canonical.pathFlags,
    pathPositionals: canonical.pathPositionals,
    ...(canonical.dynamicFieldFlags ? { dynamicFieldFlags: true as const } : {}),
    [CLI_LEAF_BRAND]: true as const,
  };
  OWNED_CLI_LEAVES.add(mutable);
  return Object.freeze(mutable);
}

function hiddenLeaf<const Id extends string, const Path extends string>(
  id: Id,
  path: Path,
  arity: ExactPositionalArity,
  surface?: LeafPathSurface,
): CliLeafSpec<Id, Path, "hidden"> {
  const mutable = {
    id,
    path,
    command: firstWord(path),
    arity,
    canonical: undefined as unknown as CliLeafSpec,
    exposure: "hidden" as const,
    ...surfaceOf(surface, arity),
    [CLI_LEAF_BRAND]: true as const,
  };
  mutable.canonical = mutable;
  OWNED_CLI_LEAVES.add(mutable);
  return Object.freeze(mutable);
}

const listLeaf = publicLeaf("list", "list", zero, 10, DIR_SURFACE);

export const CLI_COMMAND_GROUPS = [
  {
    group: "Bundle",
    commands: [
      {
        id: "bundleLocate",
        leaves: [publicLeaf("bundleLocate", "bundle locate", zero, 1, DIR_SURFACE)],
        usage: "bundle locate [--dir <path>]",
        summary: "Resolve the exact canonical local bundle path and report why it won selection",
      },
      {
        id: "catalog",
        leaves: [
          publicLeaf("catalogAdd", "catalog add", one, 2, DIR_SURFACE),
          publicLeaf("catalogList", "catalog list", zero, undefined, DIR_REJECTED_SURFACE),
          publicLeaf("catalogResolve", "catalog resolve", one, undefined, DIR_REJECTED_SURFACE),
        ],
        usage: "catalog (add <label> [--dir <path>] | list | resolve <label-or-id> [--field path])",
        summary: "Register and deterministically resolve this user's explicitly named local workspaces",
      },
      {
        id: "init",
        leaves: [publicLeaf("init", "init", zero, 0, DIR_RECIPE_SURFACE)],
        usage: "init [--dir <path>] [--okf-version <v>] [--recipe <name-or-path>] [--create-only]",
        summary:
          "Create (or open) an OKF knowledge bundle in a directory — greenfield setup; a project that already shares a board is set up by sync, not init. --create-only requires a genuinely NEW target and refuses existing, non-empty, symlinked, enclosing, bound, or concurrent targets before publication; runtime failures retain and report any empty directories they created instead of deleting them — 'recipe add' modifies a verified existing bundle",
      },
      {
        id: "indexGenerate",
        leaves: [publicLeaf("indexGenerate", "index generate", zero, 3, DIR_SURFACE)],
        usage: "index generate [--dir <path>] [--check] [--force] [--actor <name>]",
        summary: "Generate complete portable Markdown navigation explicitly; refuses curated indexes unless --force adopts them",
      },
      {
        id: "status",
        leaves: [publicLeaf("status", "status", zero, 18, DIR_SURFACE)],
        usage: "status [--limit <n>] [--dir <path>] [--remote <url>]",
        summary: "Read-only bundle health report (kind lint, unresolved links, orphans, staleness, graph lints)",
      },
    ],
  },
  {
    group: "Documents & links",
    commands: [
      {
        id: "docWrite",
        leaves: [publicLeaf("docWrite", "doc write", one, 4, DIR_BODY_FILE_SURFACE)],
        usage:
          "doc write <id> --type <t> [--title <t>] [--body <s> | --body-file <p>] [--actor <n>] [--dir <path>] [--remote <url>]",
        summary: "Write a generic OKF concept document",
      },
      {
        id: "docUpdate",
        leaves: [publicLeaf("docUpdate", "doc update", one, undefined, DIR_BODY_FILE_DYNAMIC_SURFACE)],
        usage:
          "doc update <id> [--<field> <value> ...] [--title <t>] [--tag <t>] [--type <t>] [--body <s> | --body-file <p>] [--expected-version <v>] [--actor <n>] [--dir <path>] [--remote <url>]",
        summary: "Patch given fields (incl. kind-declared fields like --progress_status) of an existing doc, preserving the rest; optimistic-CAS with --expected-version",
      },
      {
        id: "docRead",
        leaves: [publicLeaf("docRead", "doc read", one, undefined, DIR_DOC_READ_SURFACE)],
        usage:
          "doc read <id> [--out (<path> | -) | --body-out (<path> | -) | --rendered-out (<path> | -) | --field <name>] [--dir <path>] [--remote <url>]",
        summary:
          "Read a doc, export its raw markdown/body/canonical rendered HTML, or print one raw field for scripting",
      },
      {
        id: "docOpen",
        leaves: [publicLeaf("docOpen", "doc open", one, undefined, DIR_SURFACE)],
        usage: "doc open <id> [--dir <path> | --remote <url>] [--port <n>] [--actor <name>]",
        summary: "Open one exact authoritative document in a reusable managed local browser UI (explicit remote launches remain foreground)",
      },
      {
        id: "docHistory",
        leaves: [publicLeaf("docHistory", "doc history", one, undefined, DIR_SURFACE)],
        usage: "doc history <id> [--limit <n>] [--dir <path>] [--remote <url>]",
        summary:
          "Show a doc's version history (newest first, capped at 20 by default — --limit 0 for all; a history-keeping backend returns the full attributed chain, a local bundle just the current revision) — the tokens for --expected-version",
      },
      {
        id: "docDelete",
        leaves: [publicLeaf("docDelete", "doc delete", one, undefined, DIR_SURFACE)],
        usage: "doc delete <id> [--expected-version <v>] [--dir <path>] [--remote <url>]",
        summary: "Hard-delete a doc (idempotent: absent -> deleted:false, exit 0)",
      },
      {
        id: "list",
        leaves: [listLeaf, publicAlias("query", "query", listLeaf, 11)],
        usage: "list [--type <t>] [--tag <t>] [--field <k=v>] [--prefix <p>] [--open] [--limit <n>] [--dir <path>] [--remote <url>]",
        summary:
          "Query concepts newest-first by meaningful change time (alias: query) — a comma in --field's value is set membership (OR); --open excludes terminal instances (declared kinds only)",
      },
      {
        id: "link",
        leaves: [
          publicLeaf("linkAdd", "link add", two, 9, DIR_SURFACE),
          publicLeaf("linkShow", "link show", one, undefined, DIR_SURFACE),
          publicLeaf("linkList", "link list", zero, undefined, DIR_SURFACE),
        ],
        usage:
          "link (add <from> <to> [--text <t>] [--actor <n>] | show <id> [--limit <n>] [--text <t>] | list [--from <id|prefix/>] [--to <id|prefix/>] [--text <t>] [--limit <n>]) [--dir <path>] [--remote <url>]",
        summary:
          "Add a cross-link, show a concept's links + backlinks, or query the whole bundle's derived edge list filtered by from/to (id or prefix/, repeatable/union) and exact-match text",
      },
    ],
  },
  {
    group: "Artifacts",
    commands: [
      {
        id: "artifactCreate",
        leaves: [publicLeaf("artifactCreate", "artifact create", one, 13, DIR_INGRESS_FILE_SURFACE)],
        usage: "artifact create <file> --title <title> [--description <text>] [--supersedes <id>] [--actor <n>] [--dir <path>] [--remote <url>]",
        summary: "Produce a shareable output (HTML) a human can view: one command promotes the bytes and writes the type:Artifact record",
      },
      {
        id: "promote",
        leaves: [publicLeaf("promote", "promote", one, 5, DIR_INGRESS_FILE_SURFACE)],
        usage: "promote <file> --doc-key <key> [--content-type <mime>] [--expected-version <v>] [--dir <path>] [--remote <url>]",
        summary: "Move a local file's bytes into the store (a .md key routes through the engine; else a blob)",
      },
      {
        id: "pull",
        leaves: [publicLeaf("pull", "pull", zero, 6, DIR_OUT_SURFACE)],
        usage: "pull --doc-key <key> --out (<path> | -) [--dir <path>] [--remote <url>]",
        summary: "Pull a doc's canonical form or a blob's raw bytes out of the store (the reverse of promote)",
      },
      {
        id: "blobs",
        leaves: [publicLeaf("blobs", "blobs", zero, 7, DIR_SURFACE)],
        usage: "blobs [--prefix <p>] [--limit <n>] [--dir <path>] [--remote <url>]",
        summary: "List the store's blob (non-document) keys (documents are listed by 'list'/'query')",
      },
      {
        id: "delete",
        leaves: [publicLeaf("delete", "delete", zero, 8, DIR_SURFACE)],
        usage: "delete --doc-key <key> [--expected-version <v>] [--dir <path>] [--remote <url>]",
        summary: "Hard-delete a doc or blob by key (idempotent: absent -> deleted:false, exit 0)",
      },
    ],
  },
  {
    group: "Kinds",
    commands: [
      {
        id: "new",
        leaves: [publicLeaf("new", "new", two, 12, DIR_BODY_FILE_SURFACE)],
        usage:
          'new "<Kind>" <id> --<field> <value> [...] [--body <markdown> | --body-file <path>] [--link "<type>=<target-id>" ...] [--no-prefix] [--actor <n>] [--dir <path>] [--remote <url>]',
        summary:
          "Create a new instance of a bundle-declared kind — initial Markdown may come from --body or --body-file (otherwise declared sections are scaffolded); validates strictly, and repeatable --link wires typed cross-links in the same step",
      },
      {
        id: "kinds",
        leaves: [publicLeaf("kinds", "kinds", zero, 14, DIR_SURFACE)],
        usage: "kinds [--dir <path>] [--remote <url>]",
        summary: "List the kind conventions this bundle declares (purpose, described fields, exact required body headings, typed-link vocabulary, horizon)",
      },
      {
        id: "kindField",
        leaves: [
          publicLeaf("kindFieldAdd", "kind field add", two, 15, DIR_SURFACE),
          publicLeaf("kindFieldRemove", "kind field remove", two, undefined, DIR_SURFACE),
        ],
        usage: 'kind field "<Kind>" (add <name> [--required] [--values <a,b,c>] | remove <name>) [--dir <path>] [--remote <url>]',
        summary: "Edit a kind's schema — add/remove a declared field or enum value on its convention (idempotent)",
      },
      {
        id: "kindDraft",
        leaves: [publicLeaf("kindDraft", "kind draft", one, undefined, DIR_SURFACE)],
        usage: 'kind draft "<Type>" [--apply <plan-token>] [--actor <name>] [--dir <path>] [--remote <url>]',
        summary:
          "Draft a Kind for a recurring ungoverned type from its existing instances — read-only until --apply: measures the post-apply warning count, prices promotions, and emits one token-bound apply command",
      },
      {
        id: "kindDismiss",
        leaves: [publicLeaf("kindDismiss", "kind dismiss", one, undefined, DIR_SURFACE)],
        usage: 'kind dismiss "<Type>" [--reason <text>] [--actor <name>] [--dir <path>] [--remote <url>]',
        summary:
          "Record a deliberate decline of a Kind for an ungoverned type (a declaration-free convention) so no future session re-proposes it; reopen later with 'kind draft'",
      },
      {
        id: "recipes",
        leaves: [publicLeaf("recipes", "recipes", zero, 16, DIR_SURFACE)],
        usage: "recipes [--dir <path>] [--remote <url>]",
        summary: "Browse built-in recipes before or after init; with a bundle, also show whether each is already applied",
      },
      {
        id: "recipeAdd",
        leaves: [publicLeaf("recipeAdd", "recipe add", one, 17, DIR_RECIPE_ROOT_SURFACE)],
        usage: "recipe add <name-or-path> [--dir <path>] [--remote <url>]",
        summary: "Apply a recipe's content-free definitions — Kinds plus optional declared References and Views — idempotently",
      },
      {
        id: "recipeEvolve",
        leaves: [publicLeaf("recipeEvolve", "recipe evolve", one, undefined, DIR_RECIPE_ROOT_SURFACE)],
        usage: "recipe evolve <name-or-path> [--apply <plan-token>] [--actor <name>] [--dir <path>] [--remote <url>]",
        summary: "Plan an additive convention evolution, then apply target heads with exact-version CAS",
      },
    ],
  },
  {
    group: "Remote",
    commands: [
      {
        id: "serve",
        leaves: [publicLeaf("serve", "serve", zero, 19, DIR_SURFACE)],
        usage: "serve [--dir <path>] [--host <h>] [--port <p>]",
        summary: "Boot the reference wire-protocol server over a local bundle (loopback, no auth)",
      },
      {
        id: "ui",
        leaves: [publicLeaf("ui", "ui", zero, 20, DIR_SURFACE)],
        usage: "ui [--dir <path> | --remote <url>] [--port <p>] [--open] | ui --status [--dir <path>] [--limit <n>] | ui --stop [--dir <path>] [--actor <name>]",
        summary:
          'Boot the local web UI over the bundle (same origin, loopback-only): READ the bundle\'s docs as rendered pages (frontmatter, cross-links you can follow, derived backlinks), LAUNCH its registered Views (type: View docs framed in sandboxed iframes with live updates; legacy Page-typed docs no longer register — see status\'s legacy_naming finding), and see a live activity feed, the bundle\'s sharing status, and your registered workspaces. The header shows the bundle\'s display name — derived from the project folder unless set explicitly: doc write docs/bundle --type "Bundle Name" --title "<name>"',
      },
      {
        id: "mcp",
        leaves: [
          publicLeaf("mcp", "mcp", zero, 21, DIR_SURFACE),
          publicLeaf("mcpInstall", "mcp install", zero),
          publicLeaf("mcpStatus", "mcp status", zero),
          publicLeaf("mcpUninstall", "mcp uninstall", zero),
        ],
        usage: "mcp [install|status|uninstall | --dir <path>]",
        summary: "Run the local MCP Apps adapter, or explicitly install, inspect, and uninstall its user-level registration for Codex/ChatGPT, Claude Code, Claude Desktop, and OpenCode",
      },
      {
        id: "viewList",
        leaves: [publicLeaf("viewList", "view list", zero, 27, DIR_SURFACE)],
        usage: "view list [--limit <n>] [--dir <path> | --remote <url>]",
        summary: "List the bundle's registered durable Views from the same catalog used by the web launcher and MCP list_views",
      },
      {
        id: "sync",
        leaves: [publicLeaf("sync", "sync", zero, 22, DIR_SYNC_SURFACE)],
        usage: "sync [--establish [--yes] | --pull-only | --show-incoming <id> [--out <file> | --body-out <file>]] [--dir <path>] [--limit <n>]",
        summary:
          "Share the board branch with a remote — commits, pulls, and pushes (git tier; --pull-only skips commit+push). Works both from a project's conventional bundle worktree and from a standalone clone whose tracked OKF root is attached to the shared board branch. `init` makes a LOCAL bundle; --establish is the separate, explicit act that starts sharing it (creates the board branch, pushes; never automatic). A bundle folder already committed on the code branch is the same flag's hard case: preview first, --yes executes, and the folder's removal from the code branch rides a prepared side-branch commit you push and open as a PR. A bundle committed with code and NO board branch anywhere is the IN-TREE mode (read-side): full sync refuses (sharing rides your normal commit/push), --pull-only fetches the branch's tracking upstream and reports incoming board docs ('git pull' delivers them), and --establish converts to a dedicated board branch. A doc changed on both sides converges: teammate's version kept, yours exported; --show-incoming <id> (exclusive with --pull-only) prints the incoming version as of the last fetch. Board-reading commands (list/doc read/status/home/link show) auto-run the ff-only pull when board state is >~5m stale — silent, bounded (~2s), never a push; SUPERBEE_NO_AUTOPULL=<any value, even 0> disables it",
      },
    ],
  },
  {
    group: "Session",
    commands: [
      {
        id: "version",
        leaves: [publicLeaf("version", "version", zero, 26)],
        usage: "version [--check] [--tag latest|next] [--json]",
        summary: "Show the complete local build/runtime identity, or perform one bounded read-only comparison against npm's exact latest/next release policy",
      },
      {
        id: "sessionStart",
        leaves: [publicLeaf("sessionStart", "session-start", zero, 25, DIR_SURFACE)],
        usage: "session-start [--dir <path>] [--no-update-check]",
        summary: "The SessionStart hook payload: pull then render; default TOON uses a nonblocking 24-hour cached latest check, while --no-update-check or SUPERBEE_NO_UPDATE_CHECK/NO_UPDATE_NOTIFIER/CI presence disables both display and refresh (legacy ASLITE_NO_UPDATE_CHECK remains supported); npm receives only the public package request and ordinary network metadata, never installed version, cwd, bundle, actor, or usage data",
      },
      {
        id: "hook",
        leaves: [
          publicLeaf("hookInstall", "hook install", zero, 23),
          publicLeaf("hookStatus", "hook status", zero),
          publicLeaf("hookUninstall", "hook uninstall", zero),
        ],
        usage: "hook install|status|uninstall [--scope project|user]",
        summary: "Install the SessionStart hook (runs session-start: pull the board, then render) for Claude Code, Codex, OpenCode",
      },
      {
        id: "skill",
        leaves: [
          publicLeaf("skillInstall", "skill install", zero, 24),
          publicLeaf("skillStatus", "skill status", zero),
          publicLeaf("skillUninstall", "skill uninstall", zero),
        ],
        usage: "skill install|status|uninstall [--scope project|user]",
        summary: "Install this package's Agent Skill (SKILL.md + references/) into Claude Code, Codex, and OpenCode-compatible skill folders; shared paths are written once, while SessionStart remains `hook install`; manifest-tracked, idempotent, refuses folders it does not manage",
      },
      {
        id: "setup",
        leaves: [
          publicLeaf("setup", "setup", zero, 28),
          publicLeaf("setupMigrateState", "setup migrate-state", zero),
          publicLeaf("setupHardenState", "setup harden-state", zero),
          publicLeaf("setupQuarantineState", "setup quarantine-state", zero),
        ],
        usage: "setup [migrate-state|harden-state|quarantine-state] [--host codex|claude-code|claude-desktop|opencode] [--scope project|user] [--json]",
        summary: "Agent-driven setup: inspect npm, private state, Skill, Hook, MCP, bundle, and catalog readiness, then return one deterministic action for the calling agent to execute",
      },
    ],
  },
] as const satisfies readonly CommandSpecGroup[];

function publicLeaves<const Groups extends readonly CommandSpecGroup[]>(groups: Groups): LeavesOf<Groups>[] {
  return groups.flatMap((group) => group.commands.flatMap((row) => row.leaves)) as LeavesOf<Groups>[];
}

function indexLeaves<const Groups extends readonly CommandSpecGroup[]>(groups: Groups): LeafIndex<Groups> {
  const byId: Record<string, CliLeafSpec> = Object.create(null) as Record<string, CliLeafSpec>;
  const paths = new Set<string>();
  const rowIds = new Set<string>();
  for (const group of groups) {
    for (const row of group.commands) {
      if (rowIds.has(row.id)) throw new TypeError(`duplicate CLI reference row id: ${row.id}`);
      rowIds.add(row.id);
      if (row.leaves.length === 0) throw new TypeError(`CLI reference row has no leaves: ${row.id}`);
      for (const candidate of row.leaves) {
        assertCliLeaf(candidate);
        if (candidate.exposure !== "public") throw new TypeError(`hidden leaf attached to public row: ${candidate.id}`);
        if (Object.prototype.hasOwnProperty.call(byId, candidate.id)) throw new TypeError(`duplicate CLI leaf id: ${candidate.id}`);
        if (paths.has(candidate.path)) throw new TypeError(`duplicate CLI leaf path: ${candidate.path}`);
        byId[candidate.id] = candidate;
        paths.add(candidate.path);
      }
    }
  }
  return Object.freeze(byId) as LeafIndex<Groups>;
}

export function assertCliLeaf(value: unknown): asserts value is CliLeafSpec {
  if (
    typeof value !== "object" ||
    value === null ||
    !OWNED_CLI_LEAVES.has(value) ||
    (value as { [CLI_LEAF_BRAND]?: unknown })[CLI_LEAF_BRAND] !== true
  ) {
    throw new TypeError("invalid CLI leaf: use CLI_LEAVES or HOME_LEAF");
  }
}

export const PUBLIC_LEAVES = Object.freeze(publicLeaves(CLI_COMMAND_GROUPS));
export const CLI_LEAVES = indexLeaves(CLI_COMMAND_GROUPS);
export const HOME_LEAF = hiddenLeaf("home", "home", zero, DIR_SURFACE);

export type PublicLeafId = keyof typeof CLI_LEAVES;
export type PublicLeaf = (typeof PUBLIC_LEAVES)[number];
export type PublicLeafPath = PublicLeaf["path"];
export type ReferenceRowId = (typeof CLI_COMMAND_GROUPS)[number]["commands"][number]["id"];
export type PublicCommandName = PublicLeaf["command"];

function orderedPublicCommandNames(leaves: readonly PublicLeaf[]): readonly PublicCommandName[] {
  const order = new Map<PublicCommandName, number>();
  for (const candidate of leaves) {
    if (candidate.commandOrder === undefined) continue;
    if (order.has(candidate.command)) throw new TypeError(`duplicate CLI command order owner: ${candidate.command}`);
    order.set(candidate.command, candidate.commandOrder);
  }
  const commands = [...new Set(leaves.map((candidate) => candidate.command))];
  for (const command of commands) {
    if (!order.has(command)) throw new TypeError(`missing CLI command order: ${command}`);
  }
  const sorted = commands.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  const indexes = sorted.map((command) => order.get(command));
  if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value !== index)) {
    throw new TypeError("CLI command order must be unique and contiguous from zero");
  }
  return Object.freeze(sorted);
}

export const PUBLIC_COMMAND_NAMES = orderedPublicCommandNames(PUBLIC_LEAVES);
