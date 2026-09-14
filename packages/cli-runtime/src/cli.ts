// Argument router for the `axi` CLI.
//
// Ported from holaxis-agentstate `packages/cli/src/cli.ts`: axi-sdk-js's `runAxiCli` command registry
// drives dispatch; success records + error envelopes render as TOON (the agent-facing default); the
// full CliError exit-code taxonomy (0/1/2/4/5/6) is preserved via `formatError`. The command REGISTRY
// is retargeted from the promote/pull set to the OKF-native bundle set.
//
// The help family is SPLIT: bare `axi` (no args) renders the offline home view (identity header +
// live local bundle state + command reference), while `--help`/`-h`/`help` render the
// COMMAND_GROUPS reference. Neither hardcodes a command list — both derive from reference.ts
// (COMMAND_GROUPS), the single source of truth. The `hook` command manages the SessionStart home-view
// hook.
//
// The home/help/leading-flag cases are pre-routed at the TOP of main(), BEFORE runAxiCli, so home can
// set bin via cliInvocation() and stay fully offline. `home`/`topLevelHelp`/`description` are still
// REQUIRED by the SDK, so they are supplied even though the pre-routes mean they are unreached for
// those inputs.
import { runAxiCli } from "axi-sdk-js";
import { init } from "./commands/init.js";
import { doc } from "./commands/doc.js";
import { promote } from "./commands/promote.js";
import { pull } from "./commands/pull.js";
import { blobs } from "./commands/blobs.js";
import { deleteCommand } from "./commands/delete.js";
import { link } from "./commands/link.js";
import { list } from "./commands/list.js";
import { newCommand } from "./commands/new.js";
import { kinds } from "./commands/kinds.js";
import { kind } from "./commands/kind.js";
import { recipes } from "./commands/recipes.js";
import { recipe } from "./commands/recipe.js";
import { status } from "./commands/status.js";
import { serve } from "./commands/serve.js";
import { ui } from "./commands/ui.js";
import { mcp } from "./commands/mcp.js";
import { sync } from "./commands/sync.js";
import { home, homeCommand } from "./commands/home.js";
import { hook } from "./commands/hook.js";
import { skill } from "./commands/skill.js";
import { sessionStart } from "./commands/session-start.js";
import { bundleCommand } from "./commands/bundle.js";
import { catalog } from "./commands/catalog.js";
import { indexCommand } from "./commands/index.js";
import { artifact } from "./commands/artifact.js";
import { versionCommand } from "./commands/version.js";
import { view } from "./commands/view.js";
import { setup } from "./commands/setup.js";
import { cliVersion, isBareVersionFlag } from "./build-identity.js";
import { CliError, toEnvelope, toExit } from "./errors.js";
import { renderErrorEnvelope } from "./output.js";
import { DESCRIPTION, helpIndexText } from "./reference.js";
import { cliInvocation } from "./invocation.js";
import { PUBLIC_COMMAND_NAMES, type PublicCommandName } from "./command-spec.js";
import { parseArgs } from "node:util";
import { commandWords } from "./command-text.js";
export { cliVersion } from "./build-identity.js";

export const KNOWN_COMMANDS = PUBLIC_COMMAND_NAMES;

/**
 * The `--help` / `-h` / `help` reference, rendered as grouped PLAIN PROSE from COMMAND_GROUPS
 * (single source of truth) — never TOON; see `reference.ts`'s module comment for why (help is
 * prose an agent reads, not data it parses). Used both by the pre-route and as the SDK's required
 * `topLevelHelp` (which is unreached because --help is pre-routed above runAxiCli).
 */
function helpReference(): string {
  return helpIndexText(cliInvocation());
}

/**
 * The "unknown command" USAGE error (exit 2). Shared by `renderUnknownCommand` (for genuinely unknown
 * verbs) and by the `update` shadow handler so both surface the identical envelope. The `help` field
 * points at THIS executable's resolved invocation, not a bare `axi` (which is off-PATH).
 */
function unknownCommandError(cmd: string): CliError {
  return new CliError("USAGE", `unknown command: ${cmd} (known: ${KNOWN_COMMANDS.join(", ")})`, {
    help: `${cliInvocation()} --help`,
  });
}

/**
 * Wrap an existing command (which writes its own output and resolves void) as an SDK handler.
 * Returning "" makes the SDK's mandatory success write `renderOutput("") + "\n"` exactly "\n", which
 * the custom stdout wrapper drops — so command output stays byte-identical and an object is never
 * returned to the SDK.
 */
const wrap =
  (fn: (args: string[]) => Promise<void>) =>
  async (args: string[]): Promise<string> => {
    await fn(args);
    return "";
  };

export type PublicHandler = (args: string[]) => Promise<void>;
export type PublicHandlerMap = { readonly [Command in PublicCommandName]: PublicHandler };

/** Exact public handler ownership: catalog additions and removals are compile-time obligations. */
export const PUBLIC_HANDLERS = Object.freeze({
  init,
  bundle: bundleCommand,
  catalog,
  index: indexCommand,
  doc,
  promote,
  pull,
  blobs,
  delete: deleteCommand,
  link,
  list,
  query: list,
  new: newCommand,
  artifact,
  kinds,
  kind,
  recipes,
  recipe,
  status,
  serve,
  ui,
  mcp,
  sync,
  hook,
  skill,
  "session-start": sessionStart,
  version: versionCommand,
  view,
  setup,
} satisfies PublicHandlerMap);

type RuntimeHandler = (args: string[]) => Promise<string>;

const publicRuntimeCommands = Object.fromEntries(
  PUBLIC_COMMAND_NAMES.map((name) => [name, wrap(PUBLIC_HANDLERS[name])]),
) as Record<PublicCommandName, RuntimeHandler>;

/** The sole SDK registry: public entries project from the command graph plus two exact exceptions. */
export const RUNTIME_COMMANDS = Object.freeze({
  ...publicRuntimeCommands,
  // Defensive alias for the bare zero-arg home surface; intentionally not public/catalogued.
  home: wrap(homeCommand),
  // Shadow the SDK's reserved built-in npm updater with this CLI's ordinary unknown-command error.
  update: async () => {
    throw unknownCommandError("update");
  },
});

/**
 * Parse argv (already sliced past `node script`) and dispatch to a subcommand.
 *
 * Help family: no command (bare `axi`) renders the offline home view (exit 0); `--help`/`-h`/`help`
 * render the COMMAND_GROUPS reference (exit 0). A leading flag before a command writes a USAGE
 * envelope and sets exit 2 — EXCEPT a global-flags-only invocation (`--remote <url>`/`--dir <path>`
 * with no subcommand), which renders the home view scoped to that remote/dir (exit 0). Everything
 * else routes through `runAxiCli`, whose `formatError`
 * preserves the full CliError exit taxonomy (0/1/2/4/5/6) and TOON error envelope; the SDK sets
 * `process.exitCode` (never `process.exit`), so the rich taxonomy survives end-to-end.
 */
/**
 * True when `argv` is ONLY home-compatible global flags (`--remote <url>` / `--dir <path>` /
 * `--json` / `--no-update-check`) with NO positional subcommand — the canonical `superbee --remote <url>` an agent
 * runs to orient against a bundle. Such an invocation routes to the home view rather than the
 * "options must follow the command" USAGE error (which is for a real flag-before-command like
 * `--dir x list`, or an unknown flag like `--bogus`). Any parse failure returns false.
 */
function isGlobalOnlyHomeInvocation(argv: string[]): boolean {
  try {
    const { positionals } = parseArgs({
      args: argv,
      options: {
        remote: { type: "string" },
        dir: { type: "string" },
        json: { type: "boolean" },
        "no-update-check": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    return positionals.length === 0;
  } catch {
    return false;
  }
}

/**
 * When argv is `[global flags…] <known-subcommand> [rest…]` (a common ordering mistake — the agent
 * mirrors the bare `superbee --dir <path>` home form), reorder it so it RUNS instead of
 * erroring "options must follow the command". The leading global-flag block is moved to the END —
 * `<subcommand> [rest…] [global flags…]` — so it lands after the FULL command path; splicing the
 * flags in right after the first word would break TWO-word commands (`doc read`, `link add`, `kind
 * field`) whose sub-dispatch reads its OWN first positional: `--dir x doc read` must not become
 * `doc --dir x read` and fail with "unknown doc subcommand: --dir". Returns the
 * reordered argv, or null when it isn't that shape (leaving the existing USAGE error to fire).
 * Guarded to a KNOWN command as the first positional: a stray non-global flag before the command
 * leaks a positional that fails the known-command check, so nothing is mis-hoisted.
 */
export function hoistLeadingGlobalFlags(argv: string[]): string[] | null {
  let tokens;
  try {
    tokens = parseArgs({
      args: argv,
      tokens: true,
      strict: false,
      allowPositionals: true,
      options: {
        remote: { type: "string" },
        dir: { type: "string" },
        json: { type: "boolean" },
        "no-update-check": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }).tokens;
  } catch {
    return null;
  }
  const firstPositional = tokens?.find((t) => t.kind === "positional");
  if (!firstPositional) return null;
  const cmd = argv[firstPositional.index];
  if (cmd === undefined || !(KNOWN_COMMANDS as readonly string[]).includes(cmd)) return null;
  // Move the leading global-flag block (everything BEFORE the subcommand) to the END, after the full
  // command path — so `--dir x doc read y` becomes `doc read y --dir x`, not `doc --dir x read y`.
  return [...argv.slice(firstPositional.index), ...argv.slice(0, firstPositional.index)];
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];

  // Bare `axi` (no args): the offline-safe home view — identity header, live local state, and the
  // command reference. Always exits 0.
  if (command === undefined) {
    await home(argv);
    return;
  }

  // `--help` / `-h` / `help`: the COMMAND_GROUPS reference (TOON), offline, exit 0.
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpReference());
    return;
  }

  // `--version` / `-v` / `-V`: the CLI's own version string, offline, exit 0. Handled BEFORE the
  // leading-flag USAGE path below, which would otherwise reject `--version` as a misplaced option.
  if (isBareVersionFlag(command)) {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }

  // A leading flag (e.g. `axi --dir <path> list`) is a common mistake: options are per-command and
  // must FOLLOW the subcommand. Give an actionable hint rather than the opaque "unknown command:
  // --dir". (Version and help aliases are handled above; this is for the rest.) Exit 2.
  if (command.startsWith("-")) {
  // `superbee --remote <url>` (or `--dir <path>`) with NO subcommand is the canonical
    // "orient me against this bundle" invocation, not a flags-before-command mistake — route it to
    // the home view (scoped to that remote/dir) instead of erroring. A real leading flag before a
    // command (`--dir x list`) or an unknown flag (`--bogus`) still gets the actionable USAGE hint.
    if (isGlobalOnlyHomeInvocation(argv)) {
      await home(argv);
      return;
    }
    // `[global flags] <known-subcommand> …` (e.g. `--dir x list`) is a common ordering mistake — hoist
    // the subcommand to the front and run it, so `--dir x list` behaves like `list --dir x` instead of
    // erroring. Only fires for a KNOWN command; a genuinely malformed leading flag still gets the
    // USAGE error below. The reordered argv leads with a command, so this recursion can't loop.
    const hoisted = hoistLeadingGlobalFlags(argv);
    if (hoisted) {
      await main(hoisted);
      return;
    }
    const envelope = toEnvelope(
      new CliError(
        "USAGE",
        `options must follow the command (e.g. '${cliInvocation()} ${commandWords(command)} …').`,
        {
          help: `${cliInvocation()} --help`,
        },
      ),
    );
    process.stdout.write(renderErrorEnvelope(envelope));
    process.exitCode = 2;
    return;
  }

  await runAxiCli({
    argv,
    description: DESCRIPTION,
    topLevelHelp: helpReference(),
    // Drop the SDK's mandatory lone trailing "\n" after each successful (void) command so command
    // output stays byte-identical; forward everything else (error envelopes, unknown-command output).
    stdout: { write: (c: string) => (c === "\n" ? true : process.stdout.write(c)) },
    commands: RUNTIME_COMMANDS,
    // Required by AxiCliOptions; UNREACHED because the no-args path is pre-routed to the home view
    // above. Kept a trivial offline writer (the command reference) — no creds/network.
    home: async () => {
      process.stdout.write(helpReference());
      return "";
    },
    renderUnknownCommand: (cmd: string) => renderErrorEnvelope(toEnvelope(unknownCommandError(cmd))),
    formatError: (err: unknown) => {
      const { exitCode, envelope, handled } = toExit(err);
      return { output: handled ? "" : renderErrorEnvelope(envelope), exitCode };
    },
  });
}
