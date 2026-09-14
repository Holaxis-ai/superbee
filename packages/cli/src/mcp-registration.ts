import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { applyEdits, modify } from "jsonc-parser";
import {
  atomicWriteFileSync,
  capturePrivateConfigParent,
  type PrivateConfigParentSnapshot,
} from "./private-config-write.js";
import {
  classifyMcpRegistration,
  CURRENT_MCP_REGISTRATION,
  inspectCodexMcp,
  LEGACY_MCP_REGISTRATIONS,
  openCodeConfigCandidates,
  parseMcpConfigRoot,
  parseClaudeMcpEntries,
  parseOpenCodeMcpEntries,
  resolveCodexCommand,
  resolveMcpTargetConfigPath,
  selectMcpRegistration,
  type McpHostStatus,
  type McpInstallTarget,
  type McpRegistrationEntry,
  type McpRegistrationState,
  type McpStatusDeps,
  type McpStatusEnvironment,
} from "./mcp-install-targets.js";
import { HostCommandError, runHostCommand, type ResolvedHostCommand } from "./host-command.js";
import {
  resolvePersistentInstallAuthority,
  type PersistentInstallAuthority,
} from "./install-authority.js";
import { collapseHomeDirectory } from "./invocation.js";

export type McpRegistrationOperation = "install" | "uninstall";

export interface McpRegistrationReceipt {
  readonly operation: McpRegistrationOperation;
  readonly host: McpInstallTarget["id"];
  readonly label: string;
  readonly changed: boolean;
  readonly before: McpRegistrationState;
  readonly after: McpRegistrationState;
  readonly config: string | null;
  readonly restart_required: boolean;
  readonly help: readonly string[];
}

export interface McpRegistrationDeps extends McpStatusDeps {
  readonly writeFile?: (path: string, content: string) => void;
  readonly realpath?: (path: string) => string | undefined;
}

export class McpRegistrationError extends Error {
  readonly category: "conflict" | "runtime" | "usage";
  readonly details: Readonly<Record<string, unknown>>;
  readonly help: readonly string[];

  constructor(
    message: string,
    details: Record<string, unknown> = {},
    help: readonly string[] = [],
    category: "conflict" | "runtime" | "usage" = "conflict",
  ) {
    super(message);
    this.name = "McpRegistrationError";
    this.category = category;
    this.details = details;
    this.help = help;
  }
}

interface RegistrationObservation {
  readonly entries: readonly McpRegistrationEntry[];
  readonly selected: McpRegistrationEntry | undefined;
  readonly config: string | null;
  readonly sourcePath?: string;
  readonly sourceText?: string;
  readonly sourceExists?: boolean;
  readonly sourceDestination?: string | null;
  readonly sourceParent?: PrivateConfigParentSnapshot;
  readonly openCodePath?: readonly (string | number)[];
  readonly openCodeNativeCommand?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function defaultEnvironment(): McpStatusEnvironment {
  return { home: homedir(), env: process.env, platform: process.platform };
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && own(error, "code") === "ENOENT";
}

function resolvedPath(path: string, deps: McpRegistrationDeps): string | undefined {
  const resolve = deps.realpath ?? ((candidate: string) => {
    try {
      return realpathSync(candidate);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  });
  return resolve(path);
}

function readOptional(path: string, read: (path: string) => string): string | undefined {
  try {
    return read(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function nativeOptions(input: McpStatusEnvironment): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: input.env,
    cwd: input.home,
  };
}

type OpenCodeGeneration = "v1" | "v2" | "unknown";

interface OpenCodeRuntime {
  readonly generation: OpenCodeGeneration;
  readonly command?: "opencode" | "opencode2";
}

function openCodeRuntime(deps: McpRegistrationDeps, input: McpStatusEnvironment): OpenCodeRuntime {
  const run = deps.execFile ?? ((file, args, options) => execFileSync(file, args, options));
  try {
    run("opencode2", ["--version"], nativeOptions(input));
    return { generation: "v2", command: "opencode2" };
  } catch {
    try {
      const version = run("opencode", ["--version"], nativeOptions(input));
      const major = Number.parseInt(version.match(/\d+/)?.[0] ?? "", 10);
      return {
        generation: Number.isFinite(major) && major >= 2 ? "v2" : "v1",
        command: "opencode",
      };
    } catch {
      return { generation: "unknown" };
    }
  }
}

function exactEntry(left: McpRegistrationEntry | undefined, right: McpRegistrationEntry): boolean {
  return left?.name === right.name
    && left.command === right.command
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index]);
}

function classify(
  observation: RegistrationObservation,
  authority: PersistentInstallAuthority,
  desired?: McpRegistrationEntry,
): Pick<McpHostStatus, "state" | "reason"> {
  const result = classifyMcpRegistration(observation.selected, authority);
  if (result.state === "owned_current" && desired && !exactEntry(observation.selected, desired)) {
    return { state: "owned_stale", reason: "the managed registration differs from the requested launch" };
  }
  return result;
}

function selectedSources<T extends { path: string; text: string; entries: readonly McpRegistrationEntry[] }>(
  sources: readonly T[],
): T[] {
  const reserved = new Set<string>([CURRENT_MCP_REGISTRATION, ...LEGACY_MCP_REGISTRATIONS]);
  return sources.filter((source) => source.entries.some((entry) => reserved.has(entry.name)));
}

function inspectTarget(
  target: McpInstallTarget,
  deps: McpRegistrationDeps,
  codexCommand?: ResolvedHostCommand,
): RegistrationObservation {
  const input = deps.environment ?? defaultEnvironment();
  const path = resolveMcpTargetConfigPath(target.id, input);
  if (!path) {
    throw new McpRegistrationError(`no supported ${target.label} local-config path on ${input.platform}`, {
      host: target.id,
    }, [target.docs_url], "usage");
  }
  const read = deps.readFile ?? ((candidate) => readFileSync(candidate, "utf8"));
  if (target.id === "codex") {
    if (!codexCommand) {
      throw new McpRegistrationError("Codex MCP command was not resolved", { host: target.id }, [], "runtime");
    }
    try {
      const entries = inspectCodexMcp(codexCommand, input, deps);
      return { entries, selected: selectMcpRegistration(entries), config: collapseHomeDirectory(path) };
    } catch (error) {
      const state = error instanceof HostCommandError && error.state === "absent" ? "cli_absent" : "unreadable";
      throw new McpRegistrationError(
        state === "cli_absent" ? "Codex CLI command was not found on PATH" : "Codex MCP registration is unavailable",
        { host: target.id, state },
        [target.docs_url],
        state === "cli_absent" ? "usage" : "runtime",
      );
    }
  }
  if (target.id !== "opencode") {
    const text = readOptional(path, read);
    const entries = text === undefined ? [] : parseClaudeMcpEntries(text, target.id);
    return {
      entries,
      selected: selectMcpRegistration(entries),
      config: collapseHomeDirectory(path),
      sourcePath: path,
      sourceText: text ?? "{}\n",
      sourceExists: text !== undefined,
      sourceDestination: text === undefined ? null : (resolvedPath(path, deps) ?? null),
      sourceParent: capturePrivateConfigParent(path),
    };
  }

  if (input.env.OPENCODE_CONFIG_CONTENT?.trim()) {
    throw new McpRegistrationError(
      "OpenCode inline configuration is active; refusing to mutate a lower-precedence file",
      { host: target.id, config: "OPENCODE_CONFIG_CONTENT" },
      ["Unset OPENCODE_CONFIG_CONTENT or update its MCP registration explicitly."],
    );
  }

  const sources: Array<{
    path: string;
    text: string;
    entries: readonly McpRegistrationEntry[];
    destination: string | null;
    exists: boolean;
  }> = [];
  for (const candidate of openCodeConfigCandidates(input)) {
    const text = readOptional(candidate, read);
    if (text !== undefined) {
      sources.push({
        path: candidate,
        text,
        entries: parseOpenCodeMcpEntries(text),
        destination: resolvedPath(candidate, deps) ?? null,
        exists: true,
      });
    }
  }
  const owners = selectedSources(sources);
  if (owners.length > 1) {
    throw new McpRegistrationError("the Superbee MCP name is declared by multiple OpenCode config sources", {
      host: target.id,
      configs: owners.map((source) => collapseHomeDirectory(source.path)),
    });
  }
  let source = owners[0];
  if (!source) {
    const configured = input.env.OPENCODE_CONFIG?.trim();
    if (configured) {
      source = sources.find((candidate) => candidate.path === configured)
        ?? { path: configured, text: "{}\n", entries: [], destination: null, exists: false };
    } else {
      const standard = sources.filter((candidate) => openCodeConfigCandidates(input).slice(0, 2).includes(candidate.path));
      if (standard.length > 1) {
        throw new McpRegistrationError("both opencode.json and opencode.jsonc exist; choose one with OPENCODE_CONFIG", {
          host: target.id,
          configs: standard.map((candidate) => collapseHomeDirectory(candidate.path)),
        });
      }
      source = standard[0] ?? { path, text: "{}\n", entries: [], destination: null, exists: false };
    }
  }
  const root = parseMcpConfigRoot(source.text);
  const mcp = own(root, "mcp");
  if (mcp !== undefined && !isRecord(mcp)) throw new McpRegistrationError("OpenCode mcp is not an object");
  const servers = isRecord(mcp) ? own(mcp, "servers") : undefined;
  if (servers !== undefined && !isRecord(servers)) {
    throw new McpRegistrationError("OpenCode mcp.servers is not an object");
  }
  const declaredGeneration: OpenCodeGeneration | undefined = isRecord(servers)
    ? "v2"
    : mcp !== undefined
      ? "v1"
      : undefined;
  if (isRecord(servers)) {
    const mixedReserved = [CURRENT_MCP_REGISTRATION, ...LEGACY_MCP_REGISTRATIONS]
      .some((name) => own(mcp as Record<string, unknown>, name) !== undefined);
    if (mixedReserved) {
      throw new McpRegistrationError("OpenCode configuration mixes V1 and V2 MCP declarations", {
        host: target.id,
      });
    }
  }
  const runtime = openCodeRuntime(deps, input);
  if (declaredGeneration === "v2" && runtime.generation === "v1") {
    throw new McpRegistrationError("OpenCode configuration does not match the installed CLI generation", {
      host: target.id,
      config_generation: declaredGeneration,
      runtime_generation: runtime.generation,
    }, [target.docs_url]);
  }
  const generation = declaredGeneration ?? runtime.generation;
  if (generation === "unknown") {
    throw new McpRegistrationError("OpenCode version could not be determined for a new MCP registration", {
      host: target.id,
    }, ["Install OpenCode or create a valid V1/V2 config before retrying."], "usage");
  }
  const entryPath = generation === "v2"
    ? ["mcp", "servers", CURRENT_MCP_REGISTRATION]
    : ["mcp", CURRENT_MCP_REGISTRATION];
  return {
    entries: source.entries,
    selected: selectMcpRegistration(source.entries),
    config: collapseHomeDirectory(source.path),
    sourcePath: source.path,
    sourceText: source.text,
    sourceExists: source.exists,
    sourceDestination: source.destination,
    sourceParent: capturePrivateConfigParent(source.path),
    openCodePath: entryPath,
    openCodeNativeCommand: generation === "v2"
      && runtime.generation === "v2"
      && !source.exists
      && !input.env.OPENCODE_CONFIG?.trim()
      && openCodeConfigCandidates(input).slice(0, 2).includes(source.path)
      ? runtime.command
      : undefined,
  };
}

function inspectForMutation(
  target: McpInstallTarget,
  deps: McpRegistrationDeps,
  codexCommand?: ResolvedHostCommand,
): RegistrationObservation {
  try {
    return inspectTarget(target, deps, codexCommand);
  } catch (error) {
    if (error instanceof McpRegistrationError) throw error;
    throw new McpRegistrationError(`${target.label} MCP configuration is unavailable`, {
      host: target.id,
    }, [target.docs_url], "runtime");
  }
}

function editJsonc(text: string, path: readonly (string | number)[], value: unknown): string {
  const edits = modify(text, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(text, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

function nativeRun(
  deps: McpRegistrationDeps,
  input: McpStatusEnvironment,
  file: string,
  args: readonly string[],
): void {
  const run = deps.execFile ?? ((command, commandArgs, options) => execFileSync(command, commandArgs, options));
  run(file, args, nativeOptions(input));
}

function nativeAddArgs(target: McpInstallTarget, entry: McpRegistrationEntry): readonly string[] {
  if (target.id === "codex") {
    return ["mcp", "add", entry.name, "--", entry.command, ...entry.args];
  }
  return [
    "mcp", "add", "--scope", "user", "--transport", "stdio", entry.name,
    "--", entry.command, ...entry.args,
  ];
}

function nativeRemoveArgs(target: McpInstallTarget): readonly string[] {
  return target.id === "codex"
    ? ["mcp", "remove", CURRENT_MCP_REGISTRATION]
    : ["mcp", "remove", "--scope", "user", CURRENT_MCP_REGISTRATION];
}

function applyTarget(
  target: McpInstallTarget,
  operation: McpRegistrationOperation,
  desired: McpRegistrationEntry,
  before: RegistrationObservation,
  deps: McpRegistrationDeps,
  codexCommand?: ResolvedHostCommand,
): void {
  const input = deps.environment ?? defaultEnvironment();
  if (target.id === "codex") {
    if (!codexCommand) throw new McpRegistrationError("Codex MCP command was not resolved", {}, [], "runtime");
    runHostCommand(
      codexCommand,
      operation === "install" ? nativeAddArgs(target, desired) : nativeRemoveArgs(target),
      { cwd: input.home, env: input.env, platform: input.platform },
      { execFile: deps.execFile },
    );
    return;
  }
  if (target.id === "claude-code") {
    if (operation === "uninstall") {
      nativeRun(deps, input, "claude", nativeRemoveArgs(target));
      return;
    }
    const replacing = before.selected?.name === CURRENT_MCP_REGISTRATION;
    if (replacing) nativeRun(deps, input, "claude", nativeRemoveArgs(target));
    try {
      nativeRun(deps, input, "claude", nativeAddArgs(target, desired));
    } catch (error) {
      if (replacing && before.selected) {
        try {
          nativeRun(deps, input, "claude", nativeAddArgs(target, before.selected));
          const restored = inspectTarget(target, deps);
          if (!exactEntry(restored.selected, before.selected) || restored.selected?.managedShape === false) {
            throw new Error("rollback read-back mismatch");
          }
        } catch {
          throw new McpRegistrationError("Claude Code update failed and the prior registration could not be restored", {
            host: target.id,
            partial: true,
          }, [], "runtime");
        }
      }
      throw error;
    }
    return;
  }
  if (target.id === "opencode" && before.openCodeNativeCommand && operation === "install" && !before.selected) {
    nativeRun(deps, input, before.openCodeNativeCommand, [
      "mcp", "add", CURRENT_MCP_REGISTRATION, "--global", "--", desired.command, ...desired.args,
    ]);
    return;
  }

  if (!before.sourcePath || before.sourceText === undefined) {
    throw new McpRegistrationError(`no writable ${target.label} configuration source was resolved`);
  }
  let path: readonly (string | number)[];
  let value: unknown;
  if (target.id === "claude-desktop") {
    const root = parseMcpConfigRoot(before.sourceText);
    const servers = own(root, "mcpServers");
    if (servers !== undefined && !isRecord(servers)) {
      throw new McpRegistrationError("Claude Desktop mcpServers is not an object");
    }
    path = ["mcpServers", CURRENT_MCP_REGISTRATION];
    value = operation === "install" ? { command: desired.command, args: desired.args } : undefined;
  } else {
    path = before.openCodePath ?? ["mcp", CURRENT_MCP_REGISTRATION];
    const v2 = path[1] === "servers";
    value = operation === "install"
      ? v2
        ? { type: "local", command: [desired.command, ...desired.args], disabled: false }
        : { type: "local", command: [desired.command, ...desired.args], enabled: true }
      : undefined;
  }
  const next = editJsonc(before.sourceText, path, value);
  const write = deps.writeFile ?? ((candidate, content) => atomicWriteFileSync(candidate, content, {
    expected: {
      destination: before.sourceDestination ?? null,
      content: before.sourceExists ? before.sourceText ?? null : null,
      parent: before.sourceParent,
    },
  }));
  write(before.sourcePath, next);
}

function desiredRegistration(
  authority: PersistentInstallAuthority,
  actor: string | undefined,
): McpRegistrationEntry {
  const command = authority.evidence.runtime_path;
  const executable = authority.evidence.executable_path;
  const durable = authority.state === "durable_global"
    || (authority.state === "local_dev"
      && authority.evidence.npm_prefix !== null
      && authority.evidence.bin_path !== null);
  if (!authority.allowed || !durable || !command || !executable) {
    throw new McpRegistrationError("the running Superbee build cannot authorize a persistent MCP registration", {
      authority: authority.state,
      reason: authority.reason,
    }, ["Install Superbee globally with npm, then retry this command without npx."], "usage");
  }
  return {
    name: CURRENT_MCP_REGISTRATION,
    command,
    args: actor ? [executable, "mcp", "--actor", actor] : [executable, "mcp"],
  };
}

/** Apply one explicit user-level host mutation under the shared ownership and read-back policy. */
export function mutateMcpRegistration(
  operation: McpRegistrationOperation,
  target: McpInstallTarget,
  options: { actor?: string } = {},
  deps: McpRegistrationDeps = {},
): McpRegistrationReceipt {
  const input = deps.environment ?? defaultEnvironment();
  const authority = deps.authority?.()
    ?? resolvePersistentInstallAuthority({ env: input.env, platform: input.platform });
  const desired = desiredRegistration(authority, options.actor);
  let codexCommand: ResolvedHostCommand | undefined;
  if (target.id === "codex") {
    try {
      codexCommand = resolveCodexCommand(input, deps);
    } catch (error) {
      const state = error instanceof HostCommandError && error.state === "absent" ? "cli_absent" : "unreadable";
      throw new McpRegistrationError(
        state === "cli_absent" ? "Codex CLI command was not found on PATH" : "Codex CLI command discovery is unavailable",
        { host: target.id, state },
        [target.docs_url],
        state === "cli_absent" ? "usage" : "runtime",
      );
    }
  }
  const before = inspectForMutation(target, deps, codexCommand);
  const beforeClass = classify(before, authority, desired);

  if (beforeClass.state === "foreign" || beforeClass.state === "unverified") {
    throw new McpRegistrationError(`refusing to ${operation}: ${beforeClass.reason}`, {
      host: target.id,
      state: beforeClass.state,
      config: before.config,
    }, [target.docs_url]);
  }
  if (beforeClass.state === "known_legacy") {
    throw new McpRegistrationError("a legacy per-bundle MCP registration needs explicit migration", {
      host: target.id,
      state: beforeClass.state,
      config: before.config,
    }, ["Remove or migrate the legacy registration after its bundle is in the Superbee catalog."]);
  }
  const alreadyDesired = operation === "install"
    ? beforeClass.state === "owned_current" && exactEntry(before.selected, desired)
    : beforeClass.state === "absent";
  if (alreadyDesired) {
    return {
      operation,
      host: target.id,
      label: target.label,
      changed: false,
      before: beforeClass.state,
      after: beforeClass.state,
      config: before.config,
      restart_required: false,
      help: [],
    };
  }
  if (operation === "uninstall" && beforeClass.state !== "owned_current" && beforeClass.state !== "owned_stale") {
    throw new McpRegistrationError(`refusing to uninstall registration in state '${beforeClass.state}'`, {
      host: target.id,
      state: beforeClass.state,
    });
  }

  // Re-read immediately before mutation. Native host CLIs do not expose CAS, but this prevents an
  // already-observable ownership change from turning a safe plan into a name-based overwrite or
  // removal. File-backed adapters also base their JSONC edit on these freshest foreign bytes.
  const current = inspectForMutation(target, deps, codexCommand);
  const currentClass = classify(current, authority, desired);
  const selectionUnchanged = current.selected === undefined
    ? before.selected === undefined
    : exactEntry(current.selected, before.selected ?? desired);
  if (currentClass.state !== beforeClass.state || !selectionUnchanged) {
    throw new McpRegistrationError("MCP registration changed during the operation; nothing was written", {
      host: target.id,
      before: beforeClass.state,
      current: currentClass.state,
    });
  }

  try {
    applyTarget(target, operation, desired, current, deps, codexCommand);
  } catch (error) {
    if (error instanceof McpRegistrationError) throw error;
    throw new McpRegistrationError(`${target.label} MCP ${operation} failed`, {
      host: target.id,
    }, [target.docs_url], "runtime");
  }

  const after = inspectForMutation(target, deps, codexCommand);
  const afterClass = classify(after, authority, desired);
  const verified = operation === "install"
    ? afterClass.state === "owned_current" && exactEntry(after.selected, desired)
    : after.selected?.name !== CURRENT_MCP_REGISTRATION;
  if (!verified) {
    throw new McpRegistrationError(`${target.label} did not retain the requested MCP ${operation}`, {
      host: target.id,
      before: beforeClass.state,
      after: afterClass.state,
      partial: true,
    }, [target.docs_url], "runtime");
  }
  return {
    operation,
    host: target.id,
    label: target.label,
    changed: true,
    before: beforeClass.state,
    after: afterClass.state,
    config: after.config,
    restart_required: true,
    help: operation === "install"
      ? [`Restart ${target.label}, then ask it to list Superbee workspaces.`]
      : [`Restart ${target.label} to unload the removed Superbee server.`],
  };
}
