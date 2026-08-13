import { isAbsolute, normalize, sep } from "node:path";

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
}

const CURRENT_REMEDY = "re-run `superbee hook install` from the durable global npm installation";
const SAFE_UNQUOTED_HOOK_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The complete unquoted token language shared by the hook writer and recognizer. */
export function isSafeUnquotedHookToken(value: string): boolean {
  return SAFE_UNQUOTED_HOOK_TOKEN.test(value);
}

/** Render one token in the exact lexical envelope emitted by the current hook writer. */
export function renderGeneratedHookToken(value: string): string {
  return isSafeUnquotedHookToken(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function result(
  state: HookCompatibilityState,
  reason: string,
  remedy: string | undefined = state === "stale" || state === "legacy_identity" || state === "legacy_path_bound"
    ? CURRENT_REMEDY
    : undefined,
): HookCompatibility {
  return { state, reason, ...(remedy ? { remedy } : {}) };
}

interface DoubleQuotedSegment {
  value: string;
  next: number;
}

function decodeDoubleQuotedSegment(command: string, start: number): DoubleQuotedSegment | undefined {
  let i = start + 1;
  let value = "";
  while (i < command.length) {
    const inner = command[i]!;
    if (inner === '"') return { value, next: i + 1 };
    const code = inner.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || inner === "$" || inner === "`") return undefined;
    if (inner === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      // POSIX double quotes consume a backslash only before $, `, ", or another backslash.
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        value += next;
        i += 2;
        continue;
      }
      value += "\\";
      i += 1;
      continue;
    }
    value += inner;
    i += 1;
  }
  return undefined;
}

function renderHistoricalDoubleQuotedHookToken(value: string): string | undefined {
  // The historical writer used JSON.stringify only when its command base contained whitespace.
  if (!/\s/.test(value)) return undefined;
  const rendered = JSON.stringify(value);
  const decoded = decodeDoubleQuotedSegment(rendered, 0);
  return decoded?.next === rendered.length && decoded.value === value ? rendered : undefined;
}

type HookTokenEnvelope = "current" | "historical_double";

interface LexicalHookToken {
  raw: string;
  value: string;
  envelope: HookTokenEnvelope;
}

/**
 * Parse only enough shell syntax to recover raw token slices, then require every decoded token to
 * round-trip to one exact current or historical writer envelope. Shell-equivalent mixed, empty,
 * or partial quote segments are therefore foreign even when quote removal yields familiar argv.
 */
function lexicalHookTokens(command: string): LexicalHookToken[] | undefined {
  if (command.length === 0 || command.startsWith(" ") || command.endsWith(" ")) return undefined;
  const tokens: LexicalHookToken[] = [];
  let i = 0;
  while (i < command.length) {
    const start = i;
    let token = "";
    let consumed = false;
    while (i < command.length && command[i] !== " ") {
      consumed = true;
      const ch = command[i]!;
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) return undefined;
        token += command.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        const segment = decodeDoubleQuotedSegment(command, i);
        if (!segment) return undefined;
        token += segment.value;
        i = segment.next;
        continue;
      }
      if (ch === "\\" && command[i + 1] === "'") {
        token += "'";
        i += 2;
        continue;
      }
      if (!isSafeUnquotedHookToken(ch)) return undefined;
      token += ch;
      i += 1;
    }
    if (!consumed) return undefined;
    if ([...token].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
      return undefined;
    }
    const raw = command.slice(start, i);
    const current = renderGeneratedHookToken(token);
    const historical = renderHistoricalDoubleQuotedHookToken(token);
    const envelope: HookTokenEnvelope | undefined =
      raw === current ? "current" : raw === historical ? "historical_double" : undefined;
    if (!envelope) return undefined;
    tokens.push({ raw, value: token, envelope });
    if (i < command.length) {
      i += 1;
      if (i === command.length || command[i] === " ") return undefined;
    }
  }
  if (tokens.some(({ envelope }) => envelope === "historical_double")) {
    const exactHistoricalCommand =
      tokens.length === 2 &&
      tokens[0]?.envelope === "historical_double" &&
      tokens[1]?.envelope === "current" &&
      tokens[1]?.raw === "session-start";
    if (!exactHistoricalCommand) return undefined;
  }
  return tokens.length > 0 ? tokens : undefined;
}

/** Decode commands only after each raw token proves an exact generated lexical envelope. */
export function tokenizeGeneratedHookCommand(command: string): string[] | undefined {
  return lexicalHookTokens(command)?.map(({ value }) => value);
}

function bareManagedBinIdentity(value: string): "canonical" | "legacy" | undefined {
  if (value === "superbee") return "canonical";
  if (value === "aslite" || value === "agentstate-lite") return "legacy";
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

function isCanonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function managedExecutableLayout(value: string): ManagedExecutableLayout | undefined {
  if (!isCanonicalAbsolutePath(value)) return undefined;
  const portable = value.split(sep).join("/");
  if (/\/node_modules\/@holaxis\/superbee\/dist\/superbee\.mjs$/.test(portable)) {
    return "canonical_npm";
  }
  if (/\/node_modules\/(?:@holaxis\/aslite|aslite|agentstate-lite)\/dist\/agentstate-lite\.mjs$/.test(portable)) {
    return "legacy_npm";
  }
  if (/\/packages\/cli\/dist\/superbee\.mjs$/.test(portable)) return "canonical_local_dev";
  if (/\/packages\/cli\/dist\/agentstate-lite\.mjs$/.test(portable)) return "legacy_local_dev";
  if (
    /\/(?:\.claude|\.codex)\/plugins\/cache\/[^/]+\/agentstate-lite\/[^/]+\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/.test(portable) ||
    /\/plugins\/agentstate-lite\/skills\/agentstate-lite\/scripts\/agentstate-lite\.mjs$/.test(portable)
  ) {
    return "retired_marketplace";
  }
  return undefined;
}

function stableNpmRuntimePair(
  program: string,
  executable: string,
): "canonical" | "legacy" | undefined {
  if (!isCanonicalAbsolutePath(program) || !isCanonicalAbsolutePath(executable)) return undefined;
  const runtimeSuffix = `${sep}bin${sep}node`;
  if (!program.endsWith(runtimeSuffix)) return undefined;
  const suffixes: ReadonlyArray<[string, "canonical" | "legacy"]> = [
    [`${sep}lib${sep}node_modules${sep}@holaxis${sep}superbee${sep}dist${sep}superbee.mjs`, "canonical"],
    [`${sep}lib${sep}node_modules${sep}@holaxis${sep}aslite${sep}dist${sep}agentstate-lite.mjs`, "legacy"],
  ];
  for (const [executableSuffix, identity] of suffixes) {
    if (
      executable.endsWith(executableSuffix) &&
      program.slice(0, -runtimeSuffix.length) === executable.slice(0, -executableSuffix.length)
    ) {
      return identity;
    }
  }
  return undefined;
}

/** Classify a complete command token sequence; near-matches are always unmanaged. */
export function classifyHookCommand(command: string): HookCompatibility {
  const lexical = lexicalHookTokens(command);
  if (!lexical) return result("unmanaged", "command is outside the generated-command grammar");
  const tokens = lexical.map(({ value }) => value);

  const stableIdentity = tokens.length === 3
    ? stableNpmRuntimePair(tokens[0]!, tokens[1]!)
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

  const directLayout = tokens.length <= 2 ? managedExecutableLayout(tokens[0]!) : undefined;
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
    tokens[0] === "npx" &&
    tokens[1] === "-y" &&
    (tokens[2] === "agentstate-lite" || tokens[2] === "@holaxis/agentstate-lite");
  if (legacyNpx && tokens.length === 4 && tokens[3] === "session-start") {
    return result("legacy_path_bound", "recognized historical generated npx session-start command");
  }
  if (legacyNpx && tokens.length === 3) {
    return result("stale", "recognized pre-session-start generated npx command");
  }

  const executableLayout = tokens.length === 3 ? managedExecutableLayout(tokens[1]!) : undefined;
  if (
    tokens.length === 3 &&
    isCanonicalAbsolutePath(tokens[0]!) &&
    tokens[0]!.endsWith(`${sep}bin${sep}node`) &&
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
  const commandCompatibility = classifyHookCommand(command);
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
