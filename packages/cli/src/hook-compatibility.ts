import { currentHost, distributionLayouts, distributionBinName, currentDistribution } from "./runtime-context.js";
import path from "node:path";

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

function bareManagedBinIdentity(value: string): "canonical" | "legacy" | undefined {
  if (value === distributionBinName()) return "canonical";
  if (distributionLayouts().slice(1).some(layout=>layout.bins.includes(value))) return "legacy";
  return undefined;
}

// Migration-only recognition of executable paths written by the retired marketplace channel.
// This does not discover, launch, or otherwise restore that channel: it lets npm `hook install`
// replace an exact historical hook instead of preserving a broken duplicate forever.
type ManagedExecutableLayout =
  | "canonical_npm"
  | "legacy_npm"
  | "canonical_local_dev"
  | "legacy_local_dev"
  | "retired_marketplace";

function isCanonicalAbsolutePath(value:string,_platform:string):boolean {return currentHost().isCanonicalAbsolutePath(value);}

function hookLayouts() {
 const layouts=distributionLayouts();
 if(distributionBinName()==='superbee')layouts.push(
 {packageName:'@holaxis/aslite',entryRelativePath:'dist/agentstate-lite.mjs',bins:['aslite','agentstate-lite']},
 {packageName:'aslite',entryRelativePath:'dist/superbee.mjs',bins:['aslite']},
 {packageName:'agentstate-lite',entryRelativePath:'dist/superbee.mjs',bins:['agentstate-lite']},
 {packageName:'agentstate-lite',entryRelativePath:'dist/agentstate-lite.mjs',bins:['agentstate-lite']},
 );
 return layouts;
}
function managedExecutableLayout(value: string, platform: string): ManagedExecutableLayout | undefined {
  if (!isCanonicalAbsolutePath(value, platform)) return undefined;
  const portable = value.replaceAll("\\", "/");
  const layouts=hookLayouts();
  for(const [index,layout] of layouts.entries()) {
    if(portable.endsWith('/node_modules/'+layout.packageName+'/'+layout.entryRelativePath)) return index===0?'canonical_npm':'legacy_npm';
  }
  if(currentDistribution() && currentDistribution()!.predecessorLayouts.length===0) return undefined;
  if (/\/packages\/(?:cli|superbee)\/dist\/superbee\.mjs$/.test(portable)) return "canonical_local_dev";
  if (/\/packages\/cli\/dist\/agentstate-lite\.mjs$/.test(portable)) return "legacy_local_dev";
  if (
    /\/(?:\.claude|\.codex)\/plugins\/cache\/[^/]+\/agentstate-lite\/[^/]+\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/.test(portable) ||
    /\/plugins\/agentstate-lite\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/.test(portable)
  ) {
    return "retired_marketplace";
  }
  return undefined;
}

function stableNpmRuntimePair(program:string,executable:string,platform:string):'canonical'|'legacy'|undefined {
 if(!isCanonicalAbsolutePath(program,platform)||!isCanonicalAbsolutePath(executable,platform))return undefined;
 const layouts=hookLayouts();
 for(const [index,layout]of layouts.entries()) if(currentHost().isStableRuntimePair(program,executable,layout))return index===0?'canonical':'legacy';
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

  const stableIdentity = tokens.length === 3
    ? stableNpmRuntimePair(tokens[0]!, tokens[1]!, platform)
    : undefined;
  if (stableIdentity && tokens[2] === "session-start") {
    return stableIdentity === "canonical"
      ? result("current", "command uses the canonical Superbee npm-prefix Node launcher and package entry")
      : result("legacy_identity", "recognized managed hook uses the legacy ASLite npm package identity");
  }

  const bareIdentity = bareManagedBinIdentity(tokens[0]!);
  if (tokens.length === 2 && bareIdentity && tokens[1] === "session-start") {
    return result(
      "legacy_path_bound",
      bareIdentity === "canonical"
        ? "recognized canonical bare command depends on ambient PATH"
        : "recognized historical generated command depends on ambient PATH",
    );
  }
  if (tokens.length === 1 && bareIdentity) {
    return result("stale", "recognized pre-session-start generated bare-bin command");
  }

  const directLayout = tokens.length <= 2 ? managedExecutableLayout(tokens[0]!, platform) : undefined;
  if (tokens.length === 2 && directLayout && tokens[1] === "session-start") {
    return result(
      directLayout.startsWith("legacy_") ? "legacy_identity" : "legacy_path_bound",
      directLayout === "retired_marketplace"
        ? "recognized historical marketplace hook; npm hook install will replace it"
        : directLayout.startsWith("legacy_")
          ? "recognized direct-executable hook uses the legacy ASLite identity"
          : "recognized generated direct-executable command bound to one path",
    );
  }
  if (tokens.length === 1 && directLayout) {
    return result(
      "stale",
      directLayout === "retired_marketplace"
        ? "recognized pre-session-start historical marketplace hook"
        : "recognized pre-session-start generated direct-executable command",
    );
  }

  const legacyNpx =
    tokens.length >= 3 &&
    (!currentDistribution() || currentDistribution()!.predecessorLayouts.length > 0) &&
    tokens[0] === "npx" &&
    tokens[1] === "-y" &&
    (tokens[2] === "agentstate-lite" || tokens[2] === "@holaxis/agentstate-lite");
  if (legacyNpx && tokens.length === 4 && tokens[3] === "session-start") {
    return result("legacy_path_bound", "recognized historical generated npx session-start command");
  }
  if (legacyNpx && tokens.length === 3) {
    return result("stale", "recognized pre-session-start generated npx command");
  }

  const executableLayout = tokens.length === 3 ? managedExecutableLayout(tokens[1]!, platform) : undefined;
  if (
    tokens.length === 3 &&
    isCanonicalAbsolutePath(tokens[0]!, platform) &&
    currentHost().isNodeRuntimePath(tokens[0]!) &&
    (executableLayout === "canonical_local_dev" || executableLayout === "legacy_local_dev") &&
    tokens[2] === "session-start"
  ) {
    return executableLayout === "canonical_local_dev"
      ? result("current", "recognized canonical Superbee PATH-independent Node launch")
      : result("legacy_identity", "recognized PATH-independent Node launch uses the legacy ASLite identity");
  }

  return result("unmanaged", "command is not an exact generated Superbee or supported legacy form");
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
