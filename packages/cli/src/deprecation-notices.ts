// The one owner of "this old path will be removed" notices: a table of what is going away, what
// replaces it and the exact fix, plus one way to emit a row.
//
// A notice is one prose line on stderr, the channel `autopull.ts` already uses for notes, so stdout
// records and exit codes never change. The channel stays closed until the CLI entry opens it for a
// command that leaves stderr free: importing this module, a private worker and a command whose
// stderr is itself a contract all stay silent. See {@link stderrIsReserved}.
import { NO_AUTOPULL_ENV, SUPERBEE_NO_AUTOPULL_ENV } from "@superbee/board-git";
import {
  LEGACY_ACTOR_ENV,
  LEGACY_API_KEY_ENV,
  LEGACY_NO_UPDATE_CHECK_ENV,
  SUPERBEE_ACTOR_ENV,
  SUPERBEE_API_KEY_ENV,
  SUPERBEE_NO_UPDATE_CHECK_ENV,
} from "./env-policy.js";
import type { InstallScope } from "./install-scope.js";
import { cliInvocation } from "./invocation.js";

export type DeprecationNoticeCode =
  | "DEPRECATED_ENV_ACTOR"
  | "DEPRECATED_ENV_API_KEY"
  | "DEPRECATED_ENV_NO_UPDATE_CHECK"
  | "DEPRECATED_ENV_NO_AUTOPULL"
  | "DEPRECATED_PROJECT_BINDING"
  | "DEPRECATED_SOURCE_PLUGIN_POINTER"
  | "DEPRECATED_LEGACY_HOOK"
  | "DEPRECATED_LEGACY_SKILL_FOLDER"
  | "DEPRECATED_LEGACY_MCP_REGISTRATION"
  | "DEPRECATED_LEGACY_USER_STATE"
  | "DEPRECATED_REMOTE_FLAG"
  | "DEPRECATED_SERVE";

export interface DeprecationNotice {
  /** Stable identifier an agent or script can match on; the prose around it may change. */
  readonly code: DeprecationNoticeCode;
  readonly old: string;
  readonly replacement: string;
  /** The exact fix, given this executable's own command prefix and any install scopes it found. */
  readonly fix: (cli: string, scopes: readonly InstallScope[]) => string;
  /** Set on a row its presence in the environment triggers at CLI entry. */
  readonly env?: string;
}

function envRow(
  code: DeprecationNoticeCode,
  legacy: string,
  canonical: string,
): DeprecationNotice {
  return {
    code,
    old: `the ${legacy} environment variable`,
    replacement: canonical,
    fix: () => `rename ${legacy} to ${canonical} wherever it is set (same value)`,
    env: legacy,
  };
}

/** The install verbs default to project scope, so a fix must name the scope the old thing is in. */
function scopedInstalls(cli: string, verb: "hook" | "skill", scopes: readonly InstallScope[]): string {
  return scopes.map((scope) => `${cli} ${verb} install --scope ${scope}`).join(" and ");
}

export const DEPRECATION_NOTICES: readonly DeprecationNotice[] = Object.freeze([
  envRow("DEPRECATED_ENV_ACTOR", LEGACY_ACTOR_ENV, SUPERBEE_ACTOR_ENV),
  envRow("DEPRECATED_ENV_API_KEY", LEGACY_API_KEY_ENV, SUPERBEE_API_KEY_ENV),
  envRow("DEPRECATED_ENV_NO_UPDATE_CHECK", LEGACY_NO_UPDATE_CHECK_ENV, SUPERBEE_NO_UPDATE_CHECK_ENV),
  envRow("DEPRECATED_ENV_NO_AUTOPULL", NO_AUTOPULL_ENV, SUPERBEE_NO_AUTOPULL_ENV),
  {
    code: "DEPRECATED_PROJECT_BINDING",
    // Spelled here rather than imported: `bundle.ts` imports this module. A test pins the literal.
    old: "the .agentstate.json project binding",
    replacement: ".superbee.json",
    fix: () => "rename .agentstate.json to .superbee.json (same contents)",
  },
  {
    code: "DEPRECATED_SOURCE_PLUGIN_POINTER",
    old: "the pre-v2 source plugin pointer",
    replacement: "the v2 source plugin registry",
    fix: (cli) => `run ${cli} source plugin register <built-folder> and accept its digest, which rewrites the pointer`,
  },
  {
    code: "DEPRECATED_LEGACY_HOOK",
    old: "a SessionStart hook written by aslite or agentstate-lite",
    replacement: "the Superbee hook",
    fix: (cli, scopes) => `run ${scopedInstalls(cli, "hook", scopes)} from a global install (npm install -g superbee), which replaces it`,
  },
  {
    code: "DEPRECATED_LEGACY_SKILL_FOLDER",
    old: "the aslite skill folder",
    replacement: "the superbee skill folder",
    fix: (cli, scopes) => `run ${scopedInstalls(cli, "skill", scopes)} from a global install (npm install -g superbee), which moves a Superbee-owned folder; delete the folder if it remains`,
  },
  {
    code: "DEPRECATED_LEGACY_MCP_REGISTRATION",
    old: "an aslite-views or agentstate-lite-experimental MCP registration",
    replacement: "the superbee MCP registration",
    fix: (cli) => `delete that entry from the host configuration, then run ${cli} mcp install --host <id> from a global install (npm install -g superbee)`,
  },
  {
    code: "DEPRECATED_LEGACY_USER_STATE",
    old: "private state under ~/.agentstate or ~/.config/superbee",
    replacement: "the canonical Superbee state root",
    fix: (cli) => `run ${cli} setup migrate-state, which copies it and leaves the old files in place`,
  },
  {
    code: "DEPRECATED_REMOTE_FLAG",
    old: "--remote and its RemoteBackend client",
    replacement: "a hosted checkout or a local bundle",
    fix: (cli) => `run ${cli} checkout <bundle-id> for a hosted bundle, or pass --dir <path> for a local one`,
  },
  {
    code: "DEPRECATED_SERVE",
    old: "superbee serve",
    replacement: "direct local access",
    fix: (cli) => `pass --dir <path> to commands that read this bundle, and run ${cli} ui --dir <path> for the browser`,
  },
]);

const ROWS = new Map(DEPRECATION_NOTICES.map((row) => [row.code, row]));
const BYTE_CHANNEL_FLAGS = ["--out", "--body-out", "--rendered-out"];

let open = false;
let stderrErrorsAbsorbed = false;
const shown = new Set<DeprecationNoticeCode>();

function requestsByteChannel(argv: readonly string[]): boolean {
  return argv.some((arg, index) =>
    (BYTE_CHANNEL_FLAGS.includes(arg) && argv[index + 1]?.trim() === "-")
    || BYTE_CHANNEL_FLAGS.some((flag) => arg.startsWith(`${flag}=`) && arg.slice(flag.length + 1).trim() === "-"));
}

function requestsRawField(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--field" || arg.startsWith("--field="));
}

/**
 * Commands that must carry no notice. A host runs `session-start` and `turn-end` and owns what their
 * streams mean, and neither writes to stderr today. A byte or raw value channel and `mcp` put their
 * parseable receipt or error envelope on stderr, and `publish --json` puts progress there as JSON
 * lines.
 */
export function stderrIsReserved(argv: readonly string[]): boolean {
  const command = argv[0];
  if (command === "session-start" || command === "turn-end") return true;
  if (command === "mcp") return true;
  if (command === "publish" && argv.includes("--json")) return true;
  if ((command === "catalog" || (command === "doc" && argv[1] === "read")) && requestsRawField(argv)) return true;
  return requestsByteChannel(argv);
}

/** One line: control characters in a path cannot split the notice or forge another one. */
export function renderDeprecationNotice(
  row: DeprecationNotice,
  cli: string,
  locations: readonly string[] = [],
  scopes: readonly InstallScope[] = ["project", "user"],
): string {
  const where = locations.length ? ` (${locations.join(", ")})` : "";
  const line = `superbee: warning: ${row.old}${where} is deprecated and will be removed; use ${row.replacement} instead. Fix: ${row.fix(cli, scopes)}. [${row.code}]`;
  return `${line.replace(/[\u0000-\u001f\u007f]/g, " ")}\n`;
}

/** Show a row at most once per process, naming where the old thing was found. Never throws. */
export function emitDeprecationNotice(
  code: DeprecationNoticeCode,
  locations: readonly string[] = [],
  scopes?: readonly InstallScope[],
): void {
  if (!open || shown.has(code)) return;
  shown.add(code);
  // Guidance never outranks the command: a stderr that cannot be written costs only the notice. A
  // reader that has gone away fails asynchronously, as an `error` event that would otherwise end the
  // process with a new exit code.
  if (!stderrErrorsAbsorbed) {
    stderrErrorsAbsorbed = true;
    process.stderr.on("error", () => {});
  }
  try {
    process.stderr.write(renderDeprecationNotice(ROWS.get(code)!, cliInvocation(), locations, scopes));
  } catch {
    // A synchronous write failure is the same case.
  }
}

/**
 * The CLI entry's one call: open the channel for this command and report old variables by name. A
 * present variable warns even when empty, because it is what the later refusal will check. A value
 * is never read here, so an API key cannot reach the notice.
 */
export function openDeprecationNotices(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (stderrIsReserved(argv)) return;
  open = true;
  for (const row of DEPRECATION_NOTICES) {
    if (row.env !== undefined && Object.hasOwn(env, row.env)) emitDeprecationNotice(row.code);
  }
}
