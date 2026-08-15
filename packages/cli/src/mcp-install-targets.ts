// Pure host catalog, bounded read-only inspection, and conservative registration classification
// for `superbee mcp status`. This module deliberately contains no configuration writer.
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HOST_CONFIG_ROOTS,
  resolveClaudeUserConfigFile,
  resolveHostConfigRoot,
  resolveOpenCodeConfigRoot,
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

const CURRENT_REGISTRATION = "superbee";
const LEGACY_REGISTRATIONS = ["aslite-views", "agentstate-lite-experimental"] as const;

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
  if (LEGACY_REGISTRATIONS.includes(entry.name as (typeof LEGACY_REGISTRATIONS)[number])) {
    return {
      state: "known_legacy",
      reason: `registration '${entry.name}' is a legacy candidate; inspect it before migration`,
    };
  }
  if (entry.name !== CURRENT_REGISTRATION) {
    return { state: "foreign", reason: `registration '${entry.name}' is not managed by Superbee` };
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

function targetConfigPath(target: McpInstallTargetId, input: McpStatusEnvironment): string | undefined {
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
      return input.env.OPENCODE_CONFIG?.trim() || join(resolveOpenCodeConfigRoot(input.home, input.env), "opencode.json");
  }
}

function parseClaudeEntries(text: string): McpRegistrationEntry[] {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root)) throw new Error("configuration root is not an object");
  const servers = own(root, "mcpServers");
  if (servers === undefined) return [];
  if (!isRecord(servers)) throw new Error("mcpServers is not an object");
  const result: McpRegistrationEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue;
    const command = own(raw, "command");
    const args = own(raw, "args");
    if (typeof command === "string" && (args === undefined || stringArray(args))) {
      result.push({ name, command, args: stringArray(args) ?? [] });
    }
  }
  return result;
}

function parseOpenCodeEntries(text: string): McpRegistrationEntry[] {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root)) throw new Error("configuration root is not an object");
  const mcp = own(root, "mcp");
  if (mcp === undefined) return [];
  if (!isRecord(mcp)) throw new Error("mcp is not an object");
  const v2 = own(mcp, "servers");
  const servers = isRecord(v2) ? v2 : mcp;
  const result: McpRegistrationEntry[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (name === "servers" || !isRecord(raw)) continue;
    const command = stringArray(own(raw, "command"));
    if (command?.[0]) result.push({ name, command: command[0], args: command.slice(1) });
  }
  return result;
}

function parseCodexEntries(text: string): McpRegistrationEntry[] {
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
    if (typeof command === "string" && args) result.push({ name, command, args });
  }
  return result;
}

function selectedEntry(entries: readonly McpRegistrationEntry[]): McpRegistrationEntry | undefined {
  return entries.find((entry) => entry.name === CURRENT_REGISTRATION)
    ?? LEGACY_REGISTRATIONS.map((name) => entries.find((entry) => entry.name === name)).find(Boolean);
}

function environment(deps: McpStatusDeps): McpStatusEnvironment {
  return deps.environment ?? { home: homedir(), env: process.env, platform: process.platform };
}

/** Inspect one known host using a bounded, user-level read. Never writes or scans. */
export function inspectMcpHost(target: McpInstallTarget, deps: McpStatusDeps = {}): McpHostStatus {
  const input = environment(deps);
  const path = targetConfigPath(target.id, input);
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
  try {
    let entries: McpRegistrationEntry[];
    if (target.id === "codex") {
      const run = deps.execFile ?? ((file, args, options) => execFileSync(file, args, options));
      entries = parseCodexEntries(run("codex", ["mcp", "list", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        env: input.env,
        cwd: input.home,
      }));
    } else {
      const read = deps.readFile ?? ((candidate) => readFileSync(candidate, "utf8"));
      try {
        const content = read(path);
        entries = target.id === "opencode" ? parseOpenCodeEntries(content) : parseClaudeEntries(content);
      } catch (error) {
        if (isRecord(error) && own(error, "code") === "ENOENT") entries = [];
        else throw error;
      }
    }
    const classification = classifyMcpRegistration(selectedEntry(entries), authority);
    return {
      host: target.id,
      label: target.label,
      ...classification,
      config: collapseHomeDirectory(path),
      docs_url: target.docs_url,
    };
  } catch (error) {
    return {
      host: target.id,
      label: target.label,
      state: "unreadable",
      config: collapseHomeDirectory(path),
      reason: `status unavailable: ${error instanceof Error ? error.message : String(error)}`,
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
