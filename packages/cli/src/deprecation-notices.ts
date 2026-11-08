// The one owner of retired and retiring paths: a table of what is going away, what replaces it and
// the exact fix, plus one way to emit a row, and the refusals for retired environment names, flags
// and commands.
//
// A notice is one prose line on stderr, the channel `autopull.ts` already uses for notes, so stdout
// records and exit codes never change. The channel stays closed until the CLI entry opens it for a
// command that leaves stderr free: importing this module, a private worker and a command whose
// stderr is itself a contract all stay silent. See {@link stderrIsReserved}.
import { SUPERBEE_NO_AUTOPULL_ENV } from "@superbee/board-git";
import { SUPERBEE_ACTOR_ENV, SUPERBEE_NO_UPDATE_CHECK_ENV } from "./env-policy.js";
import { CliError, toEnvelope } from "./errors.js";
import type { InstallScope } from "./install-scope.js";
import { cliInvocation } from "./invocation.js";
import { renderErrorEnvelope } from "./output.js";

export type DeprecationNoticeCode =
  | "DEPRECATED_SOURCE_PLUGIN_POINTER"
  | "DEPRECATED_LEGACY_USER_STATE";

export interface DeprecationNotice {
  /** Stable identifier an agent or script can match on; the prose around it may change. */
  readonly code: DeprecationNoticeCode;
  readonly old: string;
  readonly replacement: string;
  /** The exact fix, given this executable's own command prefix and any install scopes it found. */
  readonly fix: (cli: string, scopes: readonly InstallScope[]) => string;
}

/** Retired environment names and the Superbee name that replaced each one. */
export const RETIRED_ENV: readonly (readonly [retired: string, replacement: string])[] = Object.freeze([
  ["AGENTSTATE_LITE_ACTOR", SUPERBEE_ACTOR_ENV],
  ["ASLITE_NO_UPDATE_CHECK", SUPERBEE_NO_UPDATE_CHECK_ENV],
  ["AGENTSTATE_LITE_NO_AUTOPULL", SUPERBEE_NO_AUTOPULL_ENV],
] as const);

/**
 * The retired ambient remote default. It once chose a remote server when no `--dir` was given, so it
 * is refused only there (see `bundle.ts`); beside an explicit `--dir` it never mattered and is
 * ignored, as before.
 */
export const RETIRED_REMOTE_ENV = "AGENTSTATE_LITE_REMOTE";

/** The refusal for {@link RETIRED_REMOTE_ENV}, raised where it used to select a server. */
export function retiredRemoteEnvRefusal(): CliError {
  return new CliError("USAGE", `${RETIRED_REMOTE_ENV} is no longer read; remote access was removed.`, {
    help: `unset ${RETIRED_REMOTE_ENV} wherever it is set. ${remoteRoutes(cliInvocation())}`,
    details: { code: "RETIRED_ENV", retired_env: [RETIRED_REMOTE_ENV] },
  });
}

/**
 * Retired environment names with no replacement, because what read them was removed: why each is
 * unread, and the fix. Any presence is refused, so a stale setting cannot look like it still works.
 */
export const RETIRED_UNUSED_ENV: readonly (readonly [retired: string, why: string, fix: (cli: string) => string])[] = Object.freeze([
  ["AGENTSTATE_LITE_API_KEY", "nothing uses an API key", (cli: string) => `remove AGENTSTATE_LITE_API_KEY wherever it is set; it is no longer used. Hosted bundles use ${cli} login.`],
] as const);

/**
 * Retired names that are set while their replacement is not, plus any retired name with no
 * replacement: the cases where ignoring the old name would silently change behavior or mislead.
 * Presence counts, even empty; a value is never read.
 */
export function retiredEnvNames(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return [
    ...RETIRED_ENV.filter(([retired, replacement]) => Object.hasOwn(env, retired) && !Object.hasOwn(env, replacement)).map(([retired]) => retired),
    ...RETIRED_UNUSED_ENV.filter(([retired]) => Object.hasOwn(env, retired)).map(([retired]) => retired),
  ];
}

/** The refusal for {@link retiredEnvNames}: names only, so an API key never reaches the output. */
export function retiredEnvRefusal(names: readonly string[]): CliError {
  const pairs = RETIRED_ENV.filter(([retired]) => names.includes(retired));
  const unused = RETIRED_UNUSED_ENV.filter(([retired]) => names.includes(retired));
  const cli = cliInvocation();
  const sentences: string[] = [];
  const fixes: string[] = [];
  if (pairs.length) {
    sentences.push(`${pairs.map(([retired]) => retired).join(" and ")} ${pairs.length === 1 ? "is" : "are"} no longer read; Superbee reads only `
      + `${pairs.map(([, replacement]) => replacement).join(" and ")}.`);
    const renames = pairs.map(([retired, replacement]) => `${retired} to ${replacement}`).join(" and ");
    fixes.push(`rename ${renames} wherever it is set (shell profile, CI, hook or MCP config), same value, then run the command again.`);
  }
  for (const [retired, why, fix] of unused) {
    sentences.push(`${retired} is no longer read; ${why}.`);
    fixes.push(fix(cli));
  }
  return new CliError("USAGE", sentences.join(" "), {
    help: fixes.join(" "),
    details: { code: "RETIRED_ENV", retired_env: [...pairs, ...unused].map(([retired]) => retired) },
  });
}

/** The routes away from the removed `--remote` client, shared by every refusal that names it. */
function remoteRoutes(cli: string): string {
  return `Hosted bundle: ${cli} checkout <bundle-id>. Local bundle: --dir <path>.`;
}

/** The last release that still carries the removed remote client and reference server. */
const LAST_REMOTE_RELEASE = "superbee@0.4.5";

/**
 * A removed command word. `--remote` is found by parsers instead: a command's own parser through
 * {@link retiredFlagInParse}, and the CLI entry's leading-flag handling through
 * {@link refuseLeadingRetiredFlag}, so an option VALUE spelled `--remote` is never mistaken for it.
 */
export function retiredInput(argv: readonly string[]): "serve" | undefined {
  return argv[0] === "serve" ? "serve" : undefined;
}

/**
 * Whether a command parser met `--remote` as a flag: strict parsers reject it as an unknown option,
 * lenient ones return it among their values.
 */
export function retiredFlagInParse(outcome: { error: unknown } | { values: object | undefined }): boolean {
  if ("error" in outcome) {
    const err = outcome.error as { code?: unknown; message?: unknown } | null;
    return err?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && typeof err.message === "string" && /'--remote'/.test(err.message);
  }
  return outcome.values !== undefined && Object.hasOwn(outcome.values, "remote");
}

/** The refusal for {@link retiredInput}. The URL is never echoed: it may carry credentials. */
export function retiredInputRefusal(input: "--remote" | "serve"): CliError {
  const cli = cliInvocation();
  if (input === "serve") {
    return new CliError("USAGE", "superbee serve was removed.", {
      help: `Use --dir <path>, and ${cli} ui --dir <path> for the browser. Old server: npx ${LAST_REMOTE_RELEASE} serve --dir <path>.`,
      details: { code: "RETIRED_COMMAND", input },
    });
  }
  return new CliError("USAGE", "--remote was removed.", {
    help: `${remoteRoutes(cli)} Old server: npx ${LAST_REMOTE_RELEASE} <command> --remote <url>.`,
    details: { code: "RETIRED_FLAG", input },
  });
}

/**
 * The CLI entry's refusal for `--remote` in a leading flag block with no command word to parse it.
 * The envelope goes where the command puts its errors, as for retired environment names.
 */
export function refuseLeadingRetiredFlag(argv: readonly string[]): void {
  writeEntryRefusal(argv, retiredInputRefusal("--remote"));
}

/** The CLI entry's refusal for a removed command word, before any work. */
export function refuseRetiredInput(argv: readonly string[]): boolean {
  // The hook commands own their streams and must not fail a session.
  if (argv[0] === "session-start" || argv[0] === "turn-end") return false;
  const input = retiredInput(argv);
  if (!input) return false;
  writeEntryRefusal(argv, retiredInputRefusal(input));
  return true;
}

function writeEntryRefusal(argv: readonly string[], error: CliError): void {
  const stderr = argv[0] === "mcp" || requestsRawField(argv) || requestsByteChannel(argv);
  (stderr ? process.stderr : process.stdout).write(renderErrorEnvelope(toEnvelope(error)));
  process.exitCode = 2;
}

/**
 * The CLI entry's refusal for retired environment names, before any work. The envelope goes where
 * the command puts its errors: stderr for `mcp` and the byte and raw value channels, else stdout.
 */
export function refuseRetiredEnv(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const names = retiredEnvNames(env);
  if (names.length) {
    writeEntryRefusal(argv, retiredEnvRefusal(names));
    return true;
  }
  if (Object.hasOwn(env, RETIRED_REMOTE_ENV) && selectedRemoteByDefault(argv)) {
    writeEntryRefusal(argv, retiredRemoteEnvRefusal());
    return true;
  }
  return false;
}

/** The commands whose bundle selection read {@link RETIRED_REMOTE_ENV} when no `--dir` was given. */
const AMBIENT_REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "artifact", "blobs", "delete", "deps", "doc", "kind", "kinds", "link", "list", "new", "promote",
  "pull", "query", "recipe", "recipes", "search", "status", "ui", "view",
]);

/** Whether `argv` is a command that once let the retired remote default choose its bundle. */
function selectedRemoteByDefault(argv: readonly string[]): boolean {
  const command = argv[0];
  const reads = command !== undefined
    && (AMBIENT_REMOTE_COMMANDS.has(command) || (command === "bundle" && argv[1] === "id"));
  if (!reads) return false;
  const end = argv.indexOf("--");
  const scanned = end === -1 ? argv : argv.slice(0, end);
  return !scanned.some((arg) => arg === "--dir" || arg.startsWith("--dir="));
}

/** The `retired_env` line the hook path shows in place of refusing, or undefined when none apply. */
export function retiredEnvHomeLine(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const names = retiredEnvNames(env);
  if (!names.length) return undefined;
  const refusal = retiredEnvRefusal(names);
  return `${refusal.message} This session skips the update check and automatic pull until it is fixed. Fix: ${refusal.help}`;
}

export const DEPRECATION_NOTICES: readonly DeprecationNotice[] = Object.freeze([
  {
    code: "DEPRECATED_SOURCE_PLUGIN_POINTER",
    old: "the pre-v2 source plugin pointer",
    replacement: "the v2 source plugin registry",
    fix: (cli) => `run ${cli} source plugin register <built-folder> and accept its digest, which rewrites the pointer`,
  },
  {
    code: "DEPRECATED_LEGACY_USER_STATE",
    old: "private state under ~/.agentstate or ~/.config/superbee",
    replacement: "the canonical Superbee state root",
    fix: (cli) => `run ${cli} setup migrate-state, which copies it and leaves the old files in place`,
  },
]);

const ROWS = new Map(DEPRECATION_NOTICES.map((row) => [row.code, row]));
const BYTE_CHANNEL_FLAGS = ["--out", "--body-out", "--rendered-out"];

let open = false;
let stderrErrorsAbsorbed = false;
const shown = new Set<DeprecationNoticeCode>();
const shownWarnings = new Set<string>();

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

/** Something a retired package left that Superbee leaves in place because the user edited it. */
export type RetiredWarningCode = "RETIRED_HOOK" | "RETIRED_SKILL_FOLDER";

export function retiredHookWarning(path: string): string {
  return `${path} has a hook that runs aslite or agentstate-lite, and Superbee did not remove it because it was edited. It may fail or duplicate context. To remove it, delete that entry.`;
}

export function retiredPluginWarning(path: string): string {
  return `${path} is the old agentstate-lite plugin, edited by hand. Delete it to stop it loading.`;
}

export function retiredSkillFolderWarning(dir: string, canonicalDir: string): string {
  return `${dir} is the old aslite skill and has local edits, so Superbee left it. It teaches commands that no longer exist. Delete the folder. The current skill is at ${canonicalDir}.`;
}

export function retiredSkillFolderInstallWarning(dir: string, install: string): string {
  return `${dir} is the old aslite skill. It teaches commands that no longer exist. Run ${install}, which deletes it.`;
}

/** One warning line on the notice channel, once per process per message. Never throws. */
export function emitRetiredWarning(code: RetiredWarningCode, message: string): void {
  const line = `superbee: warning: ${message} [${code}]`;
  if (!open || shownWarnings.has(line)) return;
  shownWarnings.add(line);
  if (!stderrErrorsAbsorbed) {
    stderrErrorsAbsorbed = true;
    process.stderr.on("error", () => {});
  }
  try {
    process.stderr.write(`${line.replace(/[\u0000-\u001f\u007f]/g, " ")}\n`);
  } catch {
    // A synchronous write failure costs only the warning.
  }
}

/** The CLI entry's one call: open the channel for this command. */
export function openDeprecationNotices(argv: readonly string[]): void {
  if (stderrIsReserved(argv)) return;
  open = true;
}
