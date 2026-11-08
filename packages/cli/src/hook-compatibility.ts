import { currentHost, distributionLayouts, distributionBinName } from "./runtime-context.js";

/** Compatibility states shared by status, install reconciliation, probes, and uninstall. */
export type HookCompatibilityState =
  | "current"
  | "stale"
  | "legacy_identity"
  | "legacy_path_bound"
  | "absent"
  | "unmanaged";

export interface HookCompatibility {
  state: HookCompatibilityState;
  reason: string;
  remedy?: string;
}

export interface HookEntryLike {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

export interface HookEntryContext {
  entry: HookEntryLike | undefined;
  location: "SessionStart" | "session_start";
  matcher?: unknown;
  timeoutSeconds: number;
  platform?: string;
}

function currentRemedy():string { return `re-run \`${distributionBinName()} hook install\` from the durable global npm installation`; }
const SAFE_UNQUOTED_HOOK_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The complete unquoted token language shared by the hook writer and recognizer. */
export function isSafeUnquotedHookToken(value: string): boolean {
  return SAFE_UNQUOTED_HOOK_TOKEN.test(value);
}

/** Render one token in the exact lexical envelope emitted by the current hook writer. */
export function renderGeneratedHookToken(value:string,_platform?:string):string {return currentHost().renderGeneratedHookToken(value);}

function result(
  state: HookCompatibilityState,
  reason: string,
  remedy: string | undefined = state === "stale" || state === "legacy_identity" || state === "legacy_path_bound"
    ? currentRemedy()
    : undefined,
): HookCompatibility {
  return { state, reason, ...(remedy ? { remedy } : {}) };
}

function lexicalHookTokens(command:string,_platform?:string) {return currentHost().lexicalHookTokens(command);}

/** Decode commands only after each raw token proves an exact generated lexical envelope. */
export function tokenizeGeneratedHookCommand(
  command: string,
  platform: string = process.platform,
): string[] | undefined {
  return lexicalHookTokens(command, platform)?.map(({ value }) => value);
}

function isCanonicalAbsolutePath(value: string): boolean { return currentHost().isCanonicalAbsolutePath(value); }

function isSuperbeeDistribution(): boolean { return distributionBinName() === "superbee"; }

// The hook commands the retired aslite and agentstate-lite packages wrote, kept so `hook install`
// replaces an unedited one instead of leaving a second hook beside it. A path entry matches the end
// of an absolute path, run directly or through an absolute Node runtime. Any form may end in
// `session-start`; the forms without it predate that subcommand.
const RETIRED_HOOK_BINS: readonly string[] = ["aslite", "agentstate-lite"];
const RETIRED_HOOK_NPX_PACKAGES: readonly string[] = ["agentstate-lite", "@holaxis/agentstate-lite"];
const RETIRED_HOOK_ENTRIES: readonly RegExp[] = [
  /\/node_modules\/@holaxis\/aslite\/dist\/(?:agentstate-lite|superbee)\.mjs$/,
  /\/node_modules\/aslite\/dist\/superbee\.mjs$/,
  /\/node_modules\/agentstate-lite\/dist\/(?:agentstate-lite|superbee)\.mjs$/,
  /\/packages\/cli\/dist\/agentstate-lite\.mjs$/,
  /\/\.(?:claude|codex)\/plugins\/cache\/[^/]+\/agentstate-lite\/[^/]+\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/,
  /\/plugins\/agentstate-lite\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/,
];

function isRetiredHookEntry(value: string): boolean {
  if (!isCanonicalAbsolutePath(value)) return false;
  const portable = value.replaceAll("\\", "/");
  return RETIRED_HOOK_ENTRIES.some((entry) => entry.test(portable));
}

/** Whether decoded hook tokens are exactly a command the retired packages wrote. */
export function isRetiredHookCommand(tokens: readonly string[]): boolean {
  if (!isSuperbeeDistribution()) return false;
  const launch = tokens.at(-1) === "session-start" ? tokens.slice(0, -1) : tokens;
  if (launch.length === 1) return RETIRED_HOOK_BINS.includes(launch[0]!) || isRetiredHookEntry(launch[0]!);
  if (launch.length === 2) {
    return isCanonicalAbsolutePath(launch[0]!) && currentHost().isNodeRuntimePath(launch[0]!) && isRetiredHookEntry(launch[1]!);
  }
  return launch.length === 3 && launch[0] === "npx" && launch[1] === "-y" && RETIRED_HOOK_NPX_PACKAGES.includes(launch[2]!);
}

/** The running distribution's own entry: from its npm install, or a source build of this repo. */
function canonicalExecutableLayout(value: string): "npm" | "local_dev" | undefined {
  if (!isCanonicalAbsolutePath(value)) return undefined;
  const portable = value.replaceAll("\\", "/");
  const layout = distributionLayouts()[0]!;
  if (portable.endsWith(`/node_modules/${layout.packageName}/${layout.entryRelativePath}`)) return "npm";
  if (isSuperbeeDistribution() && /\/packages\/(?:cli|superbee)\/dist\/superbee\.mjs$/.test(portable)) return "local_dev";
  return undefined;
}

/** Classify a complete command token sequence; near-matches are always unmanaged. */
export function classifyHookCommand(
  command: string,
  platform: string = process.platform,
): HookCompatibility {
  const lexical = lexicalHookTokens(command, platform);
  if (!lexical) return result("unmanaged", "command is outside the generated-command grammar");
  const tokens = lexical.map(({ value }) => value);

  if (isRetiredHookCommand(tokens)) {
    return result("legacy_identity", "recognized hook written by aslite or agentstate-lite; hook install replaces it");
  }
  if (
    tokens.length === 3 &&
    tokens[2] === "session-start" &&
    isCanonicalAbsolutePath(tokens[0]!) &&
    isCanonicalAbsolutePath(tokens[1]!) &&
    currentHost().isStableRuntimePair(tokens[0]!, tokens[1]!, distributionLayouts()[0]!)
  ) {
    return result("current", "command uses the canonical Superbee npm-prefix Node launcher and package entry");
  }

  if (tokens[0] === distributionBinName()) {
    if (tokens.length === 2 && tokens[1] === "session-start") {
      return result("legacy_path_bound", "recognized canonical bare command depends on ambient PATH");
    }
    if (tokens.length === 1) return result("stale", "recognized pre-session-start generated bare-bin command");
  }

  const directLayout = tokens.length <= 2 ? canonicalExecutableLayout(tokens[0]!) : undefined;
  if (tokens.length === 2 && directLayout && tokens[1] === "session-start") {
    return result("legacy_path_bound", "recognized generated direct-executable command bound to one path");
  }
  if (tokens.length === 1 && directLayout) {
    return result("stale", "recognized pre-session-start generated direct-executable command");
  }

  if (
    tokens.length === 3 &&
    tokens[2] === "session-start" &&
    isCanonicalAbsolutePath(tokens[0]!) &&
    currentHost().isNodeRuntimePath(tokens[0]!) &&
    canonicalExecutableLayout(tokens[1]!) === "local_dev"
  ) {
    return result("current", "recognized canonical Superbee PATH-independent Node launch");
  }

  return result("unmanaged", "command is not an exact generated Superbee form");
}

/** Classify command ownership together with the host hook shape the generator owns. */
export function classifyHookEntry(context: HookEntryContext): HookCompatibility {
  const command = context.entry?.command;
  if (typeof command !== "string") return result("unmanaged", "entry has no generated command string");
  const commandCompatibility = classifyHookCommand(command, context.platform);
  if (commandCompatibility.state === "unmanaged") return commandCompatibility;
  const exactEntryShape =
    context.entry?.type === "command" && context.entry?.timeout === context.timeoutSeconds;
  if (!exactEntryShape) {
    return result("unmanaged", "recognized command appears in an unknown hook entry shape");
  }
  if (context.location === "session_start") {
    return result("stale", "recognized generated command has a historical or non-current hook shape");
  }
  if (context.matcher !== "") {
    return result("unmanaged", "recognized command appears under an unknown SessionStart matcher");
  }
  return commandCompatibility;
}

export function isOwnedHookCompatibility(compatibility: HookCompatibility): boolean {
  return compatibility.state !== "absent" && compatibility.state !== "unmanaged";
}
