// Pure host catalog, bounded read-only inspection, and conservative registration classification
// for `superbee mcp status`. This module deliberately contains no configuration writer.
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getNodeValue, parseTree, type Node as JsoncNode, type ParseError } from "jsonc-parser";
import {
  HOST_CONFIG_ROOTS,
  resolveClaudeUserConfigFile,
  resolveHostConfigRoot,
  resolveOpenCodeGlobalConfigRoot,
} from "./host-config.js";
import {
  resolvePersistentInstallAuthority,
  type PersistentInstallAuthority,
} from "./install-authority.js";
import { collapseHomeDirectory } from "./invocation.js";

export type McpInstallTargetId = "codex" | "claude-code" | "claude-desktop" | "opencode";

export interface McpInstallTarget {
  readonly id: McpInstallTargetId;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly inspection: "native-cli" | "config-file";
  readonly docs_url: string;
}

export const MCP_INSTALL_TARGETS: readonly McpInstallTarget[] = Object.freeze([
  Object.freeze({
    id: "codex",
    label: "Codex / ChatGPT",
    aliases: Object.freeze(["chatgpt", "chatgpt-desktop"]),
    inspection: "native-cli",
    docs_url: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  }),
  Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    aliases: Object.freeze(["claude"]),
    inspection: "config-file",
    docs_url: "https://code.claude.com/docs/en/mcp",
  }),
  Object.freeze({
    id: "claude-desktop",
    label: "Claude Desktop",
    aliases: Object.freeze(["claude-app"]),
    inspection: "config-file",
    docs_url:
      "https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop",
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    aliases: Object.freeze(["open-code"]),
    inspection: "config-file",
    docs_url: "https://dev.opencode.ai/docs/mcp-servers/",
  }),
]);

const TARGET_BY_NAME = new Map<string, McpInstallTarget>();
for (const target of MCP_INSTALL_TARGETS) {
  TARGET_BY_NAME.set(target.id, target);
  for (const alias of target.aliases) TARGET_BY_NAME.set(alias, target);
}

export function resolveMcpInstallTarget(value: string): McpInstallTarget | undefined {
  return TARGET_BY_NAME.get(value.trim().toLowerCase());
}

export type McpRegistrationState =
  | "absent"
  | "owned_current"
  | "owned_stale"
  | "known_legacy"
  | "foreign"
  | "unverified"
  | "unreadable"
  | "unsupported";

export interface McpRegistrationEntry {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** False when host-native fields exceed the exact shape Superbee can safely own. */
  readonly managedShape?: boolean;
}

export interface McpHostStatus {
  readonly host: McpInstallTargetId;
  readonly label: string;
  readonly state: McpRegistrationState;
  readonly config: string | null;
  readonly reason: string;
  readonly docs_url: string;
}

export interface McpStatusEnvironment {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform | string;
}

export interface McpStatusDeps {
  readonly environment?: McpStatusEnvironment;
  readonly authority?: () => PersistentInstallAuthority;
  readonly readFile?: (path: string) => string;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string;
}

export const CURRENT_MCP_REGISTRATION = "superbee";
export const LEGACY_MCP_REGISTRATIONS = ["aslite-views", "agentstate-lite-experimental"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

interface ParsedLaunchArgs {
  readonly actor?: string;
  readonly dir?: string;
}

function parseLaunchArgs(args: readonly string[], executable: string): ParsedLaunchArgs | undefined {
  if (args[0] !== executable || args[1] !== "mcp") return undefined;
  const parsed: { actor?: string; dir?: string } = {};
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--actor" && flag !== "--dir") || !value?.trim()) return undefined;
    const key = flag === "--actor" ? "actor" : "dir";
    if (parsed[key] !== undefined) return undefined;
    parsed[key] = value;
  }
  return parsed;
}

/** Classify one exact registration without treating a recognizable name as ownership. */
export function classifyMcpRegistration(
  entry: McpRegistrationEntry | undefined,
  authority: PersistentInstallAuthority,
): Pick<McpHostStatus, "state" | "reason"> {
  if (!entry) return { state: "absent", reason: "no Superbee registration found" };
  if (LEGACY_MCP_REGISTRATIONS.includes(entry.name as (typeof LEGACY_MCP_REGISTRATIONS)[number])) {
    return {
      state: "known_legacy",
      reason: `registration '${entry.name}' is a legacy candidate; inspect it before migration`,
    };
  }
  if (entry.name !== CURRENT_MCP_REGISTRATION) {
    return { state: "foreign", reason: `registration '${entry.name}' is not managed by Superbee` };
  }
  if (entry.managedShape === false) {
    return {
      state: "foreign",
      reason: "the reserved name carries host settings outside the exact Superbee-managed shape",
    };
  }
  const runtime = authority.evidence.runtime_path;
  const executable = authority.evidence.executable_path;
  if (!authority.allowed || !runtime || !executable) {
    return {
      state: "unverified",
      reason: "the running distribution cannot prove durable ownership of this registration",
    };
  }
  const launch = entry.command === runtime ? parseLaunchArgs(entry.args, executable) : undefined;
  if (!launch) {
    return {
      state: "foreign",
      reason: "the reserved name exists but its launch command is not the current managed command",
    };
  }
  if (launch.dir !== undefined) {
    return {
      state: "owned_stale",
      reason: "the managed registration is still pinned to one bundle directory",
    };
  }
  return { state: "owned_current", reason: "the registration matches this durable Superbee install" };
}

export function resolveMcpTargetConfigPath(
  target: McpInstallTargetId,
  input: McpStatusEnvironment,
): string | undefined {
  switch (target) {
    case "codex":
      return join(resolveHostConfigRoot(HOST_CONFIG_ROOTS.codex, input.home, input.env), "config.toml");
    case "claude-code":
      return resolveClaudeUserConfigFile(input.home, input.env);
    case "claude-desktop":
      if (input.platform === "darwin") {
        return join(input.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (input.platform === "win32" && input.env.APPDATA) {
        return join(input.env.APPDATA, "Claude", "claude_desktop_config.json");
      }
      return undefined;
    case "opencode":
      return join(resolveOpenCodeGlobalConfigRoot(input.home, input.env), "opencode.json");
  }
}

export function openCodeConfigCandidates(input: McpStatusEnvironment): string[] {
  const root = resolveOpenCodeGlobalConfigRoot(input.home, input.env);
  const candidates = [join(root, "opencode.json"), join(root, "opencode.jsonc")];
  const additional = input.env.OPENCODE_CONFIG?.trim();
  if (additional && !candidates.includes(additional)) candidates.push(additional);
  return candidates;
}

function assertUniqueObjectKeys(node: JsoncNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") continue;
      if (seen.has(key)) throw new Error(`configuration contains duplicate key '${key}'`);
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) assertUniqueObjectKeys(child);
}

/** Parse one host JSON/JSONC file without accepting ambiguous duplicate-key ownership. */
export function parseMcpConfigRoot(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new Error(`configuration is not valid JSON/JSONC (error ${errors[0]?.error})`);
  if (!tree || tree.type !== "object") throw new Error("configuration root is not an object");
  assertUniqueObjectKeys(tree);
  return getNodeValue(tree) as Record<string, unknown>;
}

export function parseClaudeMcpEntries(
  text: string,
  target: "claude-code" | "claude-desktop",
): McpRegistrationEntry[] {
  const root = parseMcpConfigRoot(text);
  const servers = own(root, "mcpServers");
  if (servers === undefined) return [];
  if (!isRecord(servers)) throw new Error("mcpServers is not an object");
  const result: McpRegistrationEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue;
    const command = own(raw, "command");
    const args = own(raw, "args");
    if (typeof command === "string" && (args === undefined || stringArray(args))) {
      const keys = Object.keys(raw).sort();
      const parsedArgs = stringArray(args);
      const desktopShape = parsedArgs !== undefined
        && keys.every((key) => key === "args" || key === "command");
      const env = own(raw, "env");
      const codeShape = parsedArgs !== undefined
        && keys.every((key) => key === "args" || key === "command" || key === "env" || key === "type")
        && own(raw, "type") === "stdio"
        && isRecord(env)
        && Object.keys(env).length === 0;
      result.push({
        name,
        command,
        args: parsedArgs ?? [],
        managedShape: target === "claude-code" ? codeShape : desktopShape,
      });
    }
  }
  return result;
}

export function parseOpenCodeMcpEntries(text: string): McpRegistrationEntry[] {
  const root = parseMcpConfigRoot(text);
  const mcp = own(root, "mcp");
  if (mcp === undefined) return [];
  if (!isRecord(mcp)) throw new Error("mcp is not an object");
  const v2 = own(mcp, "servers");
  const servers = isRecord(v2) ? v2 : mcp;
  const v2Shape = isRecord(v2);
  const result: McpRegistrationEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (name === "servers" || !isRecord(raw)) continue;
    const command = stringArray(own(raw, "command"));
    if (command?.[0]) {
      const keys = Object.keys(raw);
      const allowed = v2Shape
        ? new Set(["type", "command", "disabled"])
        : new Set(["type", "command", "enabled"]);
      const activation = v2Shape ? own(raw, "disabled") : own(raw, "enabled");
      const managedShape = keys.every((key) => allowed.has(key))
        && own(raw, "type") === "local"
        && (activation === undefined || activation === (v2Shape ? false : true));
      result.push({ name, command: command[0], args: command.slice(1), managedShape });
    }
  }
  return result;
}

export function parseCodexMcpEntries(text: string): McpRegistrationEntry[] {
  const root: unknown = JSON.parse(text);
  if (!Array.isArray(root)) throw new Error("codex mcp list did not return an array");
  const result: McpRegistrationEntry[] = [];
  for (const raw of root) {
    if (!isRecord(raw)) continue;
    const name = own(raw, "name");
    const transport = own(raw, "transport");
    if (typeof name !== "string" || !isRecord(transport) || own(transport, "type") !== "stdio") continue;
    const command = own(transport, "command");
    const args = stringArray(own(transport, "args"));
    if (typeof command === "string" && args) {
      const keys = Object.keys(transport);
      const allowed = new Set(["type", "command", "args", "env", "env_vars", "cwd"]);
      const env = own(transport, "env");
      const envVars = own(transport, "env_vars");
      const cwd = own(transport, "cwd");
      const outerKeys = Object.keys(raw);
      const allowedOuter = new Set([
        "name", "enabled", "disabled_reason", "transport", "startup_timeout_sec", "tool_timeout_sec", "auth_status",
      ]);
      const managedShape = outerKeys.every((key) => allowedOuter.has(key))
        && own(raw, "enabled") === true
        && (own(raw, "disabled_reason") === undefined || own(raw, "disabled_reason") === null)
        && (own(raw, "startup_timeout_sec") === undefined || own(raw, "startup_timeout_sec") === null)
        && (own(raw, "tool_timeout_sec") === undefined || own(raw, "tool_timeout_sec") === null)
        && keys.every((key) => allowed.has(key))
        && (env === undefined || env === null)
        && (envVars === undefined || (Array.isArray(envVars) && envVars.length === 0))
        && (cwd === undefined || cwd === null);
      result.push({ name, command, args, managedShape });
    }
  }
  return result;
}

export function selectMcpRegistration(
  entries: readonly McpRegistrationEntry[],
): McpRegistrationEntry | undefined {
  return entries.find((entry) => entry.name === CURRENT_MCP_REGISTRATION)
    ?? LEGACY_MCP_REGISTRATIONS.map((name) => entries.find((entry) => entry.name === name)).find(Boolean);
}

function environment(deps: McpStatusDeps): McpStatusEnvironment {
  return deps.environment ?? { home: homedir(), env: process.env, platform: process.platform };
}

/** Inspect one known host using a bounded, user-level read. Never writes or scans. */
export function inspectMcpHost(target: McpInstallTarget, deps: McpStatusDeps = {}): McpHostStatus {
  const input = environment(deps);
  const path = resolveMcpTargetConfigPath(target.id, input);
  if (!path) {
    return {
      host: target.id,
      label: target.label,
      state: "unsupported",
      config: null,
      reason: `no supported ${target.label} local-config path on ${input.platform}`,
      docs_url: target.docs_url,
    };
  }
  const authority = deps.authority?.() ?? resolvePersistentInstallAuthority({ env: input.env, platform: input.platform });
  let reportedPath = path;
  try {
    let entries: McpRegistrationEntry[];
    if (target.id === "codex") {
      const run = deps.execFile ?? ((file, args, options) => execFileSync(file, args, options));
      entries = parseCodexMcpEntries(run("codex", ["mcp", "list", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        env: input.env,
        cwd: input.home,
      }));
    } else {
      const read = deps.readFile ?? ((candidate) => readFileSync(candidate, "utf8"));
      const candidates = target.id === "opencode" ? openCodeConfigCandidates(input) : [path];
      const sources: Array<{ path: string; entries: McpRegistrationEntry[] }> = [];
      for (const candidate of candidates) {
        try {
          const content = read(candidate);
          reportedPath = candidate;
          sources.push({
            path: candidate,
            entries: target.id === "opencode"
              ? parseOpenCodeMcpEntries(content)
              : parseClaudeMcpEntries(content, target.id),
          });
        } catch (error) {
          if (!isRecord(error) || own(error, "code") !== "ENOENT") throw error;
        }
      }
      entries = sources.flatMap((source) => source.entries);
      for (const name of [CURRENT_MCP_REGISTRATION, ...LEGACY_MCP_REGISTRATIONS]) {
        const declarations = sources.filter((source) => source.entries.some((entry) => entry.name === name));
        if (declarations.length > 1) {
          throw new Error(
            `registration '${name}' is declared by multiple OpenCode config sources: ${declarations.map((source) => source.path).join(", ")}`,
          );
        }
      }
      if (target.id === "opencode" && input.env.OPENCODE_CONFIG_CONTENT?.trim()) {
        const inlineEntries = parseOpenCodeMcpEntries(input.env.OPENCODE_CONFIG_CONTENT);
        const effective = new Map(entries.map((entry) => [entry.name, entry]));
        for (const entry of inlineEntries) effective.set(entry.name, entry);
        entries = [...effective.values()];
        const inlineSelected = selectMcpRegistration(inlineEntries);
        if (inlineSelected) {
          reportedPath = "OPENCODE_CONFIG_CONTENT";
        } else {
          const selected = selectMcpRegistration(entries);
          const owner = selected
            ? sources.find((source) => source.entries.some((entry) => entry.name === selected.name))
            : undefined;
          if (owner) reportedPath = owner.path;
        }
      }
    }
    const classification = classifyMcpRegistration(selectMcpRegistration(entries), authority);
    return {
      host: target.id,
      label: target.label,
      ...classification,
      config: collapseHomeDirectory(reportedPath),
      docs_url: target.docs_url,
    };
  } catch (error) {
    return {
      host: target.id,
      label: target.label,
      state: "unreadable",
      config: collapseHomeDirectory(reportedPath),
      reason: "status unavailable: host configuration is unreadable",
      docs_url: target.docs_url,
    };
  }
}

export function inspectMcpHosts(
  targets: readonly McpInstallTarget[] = MCP_INSTALL_TARGETS,
  deps: McpStatusDeps = {},
): McpHostStatus[] {
  const resolvedAuthority = deps.authority?.()
    ?? resolvePersistentInstallAuthority({
      env: environment(deps).env,
      platform: environment(deps).platform,
    });
  return targets.map((target) => inspectMcpHost(target, {
    ...deps,
    authority: () => resolvedAuthority,
  }));
}
