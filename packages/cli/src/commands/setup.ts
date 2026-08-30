// `superbee setup` — one read-only AXI conductor plus one explicit, bounded state-migration leaf.

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { parseSelectorOrUsage } from "../args.js";
import { resolveLocalBundleTarget, samePhysicalPath, type LocalBundleTarget } from "../bundle.js";
import { listCatalogEntries, type CatalogEntryView } from "../catalog.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { inspectMcpHosts, MCP_INSTALL_TARGETS, type McpHostStatus, type McpInstallTarget, type McpInstallTargetId } from "../mcp-install-targets.js";
import { normalizeInstallScope, type InstallScope } from "../install-scope.js";
import { resolvePersistentInstallAuthority, type PersistentInstallAuthority } from "../install-authority.js";
import { render, resolveMode } from "../output.js";
import {
  buildSetupPlan,
  setupNextForCapability,
  setupStateCapability,
  type SetupHookHostState,
  type SetupPlan,
  type SetupSkillHostState,
  type SetupWorkspaceState,
} from "../setup-plan.js";
import { inspectHookStatus, type HookStatusInspection } from "./hook.js";
import { inspectSkillStatus, type SkillStatusInspection } from "./skill.js";
import {
  hardenUserState,
  quarantineUserState,
  type UserStateRecoveryReceipt,
} from "../user-state.js";
import {
  inspectUserStateMigration,
  migrateUserState,
  type UserStateMigrationInspection,
  type UserStateMigrationReceipt,
} from "../user-state-migration.js";

export const SETUP_USAGE = `superbee setup — inspect the complete host integration and emit one safe next command

Usage:
  superbee setup [--host codex|claude-code|claude-desktop|opencode]
                 [--scope project|user] [--json]
  superbee setup migrate-state [--json]
  superbee setup harden-state [--json]
  superbee setup quarantine-state [--json]

Without --host, the command reports private-state health plus the four bounded supported host
surfaces. A required state remedy comes first; otherwise it asks the agent to select the exact
host. With --host, it composes the existing distribution, Agent Skill,
SessionStart hook, MCP registration, local bundle, and private catalog inspectors into one
deterministic plan. It never writes configuration or treats detected software as mutation
authority. Run the returned next.command, restart the named host after integration changes, and
re-run the same setup command to verify.

When setup reports validated legacy operational state, migrate-state copies only the private
catalog, remote credentials, and immutable View approvals into Superbee's canonical state root.
It never moves bundles or deletes legacy bytes. The explicit command is the authorization event.

A catalog entry preserves a workspace for explicit MCP selection; it never selects that workspace
as the current project's context. Do not read, write, orient from, or sync a cataloged workspace
unless the current checkout resolves to it or the user explicitly selects it. If this checkout has
no bundle, setup reports that state without borrowing one from another project.

Options:
  --host <id>           Exact host: codex, claude-code, claude-desktop, or opencode
  --scope <scope>       Skill and hook scope: user (default) or project
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface SetupInspection {
  distribution: PersistentInstallAuthority;
  skill?: SkillStatusInspection;
  hook?: HookStatusInspection;
  projectHook?: HookStatusInspection;
  projectHookUnavailable?: boolean;
  mcp: readonly McpHostStatus[];
  workspace: SetupWorkspaceState;
  state: UserStateMigrationInspection;
}

export interface SetupDeps {
  stdout: (text: string) => void;
  cwd: () => string;
  home: () => string;
  inspectDistribution: () => PersistentInstallAuthority;
  inspectSkill: (scope: InstallScope) => SkillStatusInspection;
  inspectHook: (scope: InstallScope) => HookStatusInspection;
  inspectMcp: (targets: readonly McpInstallTarget[]) => readonly McpHostStatus[];
  resolveBundle: (startDir: string) => Promise<LocalBundleTarget>;
  listCatalog: (home: string) => Promise<CatalogEntryView[]>;
  inspectState: (home: string) => Promise<UserStateMigrationInspection>;
  migrateState: (home: string) => Promise<UserStateMigrationReceipt>;
  hardenState: (home: string) => Promise<UserStateRecoveryReceipt>;
  quarantineState: (home: string) => Promise<UserStateRecoveryReceipt>;
}

function setupHost(value: string | undefined): McpInstallTargetId | undefined {
  return MCP_INSTALL_TARGETS.find((target) => target.id === value)?.id;
}

function skillForHost(
  inspection: SkillStatusInspection | undefined,
  host: McpInstallTargetId,
): SetupSkillHostState | undefined {
  if (!inspection) return undefined;
  if (host === "codex") return inspection.hosts.codex;
  if (host === "claude-code" || host === "opencode") return inspection.hosts.claude_code;
  return undefined;
}

function hookForHost(
  inspection: HookStatusInspection | undefined,
  host: McpInstallTargetId,
): SetupHookHostState | undefined {
  if (!inspection || host === "claude-desktop") return undefined;
  return host === "codex"
    ? inspection.hosts.codex
    : host === "claude-code"
      ? inspection.hosts.claude_code
      : inspection.hosts.opencode;
}

function planForHost(inspection: SetupInspection, host: McpInstallTargetId, scope: InstallScope): SetupPlan {
  const mcp = inspection.mcp.find((row) => row.host === host);
  if (!mcp) throw new Error(`missing setup MCP inspection for ${host}`);
  return buildSetupPlan({
    host,
    scope,
    distribution: {
      ...inspection.distribution,
      persistent: inspection.distribution.allowed
        && inspection.distribution.evidence.executable_path !== null
        && inspection.distribution.evidence.runtime_path !== null,
    },
    skill: skillForHost(inspection.skill, host),
    hook: hookForHost(inspection.hook, host),
    projectHook: scope === "user" ? hookForHost(inspection.projectHook, host) : undefined,
    projectHookUnavailable: scope === "user" && inspection.projectHookUnavailable === true,
    mcp,
    workspace: inspection.workspace,
    state: inspection.state,
  });
}

async function inspectWorkspace(deps: SetupDeps): Promise<SetupWorkspaceState> {
  let selected: LocalBundleTarget | undefined;
  let bundle: SetupWorkspaceState["bundle"] = "absent";
  try {
    selected = await deps.resolveBundle(deps.cwd());
    bundle = "selected";
  } catch (error) {
    bundle = error instanceof CliError && error.code === "NOT_FOUND" ? "absent" : "unreadable";
  }
  try {
    const entries = await deps.listCatalog(deps.home());
    const available = entries.filter((entry) => entry.available);
    return {
      bundle,
      catalog: available.length > 0 ? "ready" : "empty",
      selected_registered: selected !== undefined
        && available.some((entry) => samePhysicalPath(entry.locator.path, selected!.canonicalRoot)),
    };
  } catch {
    return { bundle, catalog: "unreadable", selected_registered: false };
  }
}

async function inspectAll(
  scope: InstallScope,
  targets: readonly McpInstallTarget[],
  deps: SetupDeps,
): Promise<SetupInspection> {
  let skill: SkillStatusInspection | undefined;
  let hook: HookStatusInspection | undefined;
  let projectHook: HookStatusInspection | undefined;
  let projectHookUnavailable = false;
  if (targets.some((target) => target.id !== "claude-desktop")) {
    try {
      skill = deps.inspectSkill(scope);
    } catch {
      skill = undefined;
    }
  }
  if (targets.some((target) => target.id !== "claude-desktop")) {
    try {
      hook = deps.inspectHook(scope);
    } catch {
      hook = undefined;
    }
    if (scope === "user") {
      try {
        projectHook = deps.inspectHook("project");
      } catch {
        projectHook = undefined;
        projectHookUnavailable = true;
      }
    }
  }
  const [workspace, mcp, state] = await Promise.all([
    inspectWorkspace(deps),
    Promise.resolve(deps.inspectMcp(targets)),
    deps.inspectState(deps.home()),
  ]);
  return {
    distribution: deps.inspectDistribution(),
    skill,
    hook,
    projectHook,
    projectHookUnavailable,
    mcp,
    workspace,
    state,
  };
}

export async function setup(argv: string[], injected: Partial<SetupDeps> = {}): Promise<void> {
  const stdout = injected.stdout ?? ((text: string) => void process.stdout.write(text));
  const parsed = parseSelectorOrUsage(
    () => parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        scope: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }),
    "setup",
    (positionals) => {
      if (positionals.length === 0) {
        return {
          kind: "selected",
          leaf: CLI_LEAVES.setup,
          data: [],
          payload: { action: "inspect" as "inspect" | "migrate" | "harden" | "quarantine" },
        };
      }
      const [subcommand, ...data] = positionals;
      if (subcommand === "migrate-state") {
        return {
          kind: "selected",
          leaf: CLI_LEAVES.setupMigrateState,
          data,
          payload: { action: "migrate" as "inspect" | "migrate" | "harden" | "quarantine" },
        };
      }
      if (subcommand === "harden-state") {
        return {
          kind: "selected",
          leaf: CLI_LEAVES.setupHardenState,
          data,
          payload: { action: "harden" as "inspect" | "migrate" | "harden" | "quarantine" },
        };
      }
      if (subcommand === "quarantine-state") {
        return {
          kind: "selected",
          leaf: CLI_LEAVES.setupQuarantineState,
          data,
          payload: { action: "quarantine" as "inspect" | "migrate" | "harden" | "quarantine" },
        };
      }
      return { kind: "unknown", token: subcommand };
    },
  );
  const { values } = parsed;
  if (values.help) {
    stdout(SETUP_USAGE);
    return;
  }
  if (parsed.selection.kind === "unknown" || parsed.selection.kind === "navigation") {
    throw new CliError("USAGE", `unknown setup subcommand: ${parsed.selection.kind === "unknown" ? parsed.selection.token : ""}`, {
      help: "superbee setup --help",
    });
  }
  const scope = normalizeInstallScope(values.scope ?? "user");
  if (!scope) {
    throw new CliError("USAGE", `unsupported setup scope: ${values.scope} (expected project|user)`, {
      help: "superbee setup --scope project|user",
    });
  }
  const requestedHost = setupHost(values.host);
  if (values.host !== undefined && !requestedHost) {
    throw new CliError("USAGE", `unknown setup host '${values.host}'`, {
      details: { supported_hosts: MCP_INSTALL_TARGETS.map(({ id }) => id) },
      help: "superbee setup --host <id>",
    });
  }
  const deps: SetupDeps = {
    stdout,
    cwd: injected.cwd ?? (() => process.cwd()),
    home: injected.home ?? homedir,
    inspectDistribution: injected.inspectDistribution ?? (() => resolvePersistentInstallAuthority()),
    inspectSkill: injected.inspectSkill ?? ((selectedScope) => inspectSkillStatus(selectedScope)),
    inspectHook: injected.inspectHook ?? ((selectedScope) => inspectHookStatus(selectedScope)),
    inspectMcp: injected.inspectMcp ?? ((targets) => inspectMcpHosts(targets)),
    resolveBundle: injected.resolveBundle ?? ((startDir) => resolveLocalBundleTarget(undefined, startDir)),
    listCatalog: injected.listCatalog ?? listCatalogEntries,
    inspectState: injected.inspectState ?? inspectUserStateMigration,
    migrateState: injected.migrateState ?? migrateUserState,
    hardenState: injected.hardenState ?? hardenUserState,
    quarantineState: injected.quarantineState ?? quarantineUserState,
  };
  if (parsed.selection.kind === "selected" && parsed.selection.payload.action !== "inspect") {
    if (values.host !== undefined || values.scope !== undefined) {
      throw new CliError("USAGE", `setup ${parsed.selection.payload.action}-state does not accept --host or --scope`, {
        help: `superbee setup ${parsed.selection.payload.action}-state [--json]`,
      });
    }
    try {
      if (parsed.selection.payload.action === "migrate") {
        stdout(render({ migration: await deps.migrateState(deps.home()) }, resolveMode(values)));
      } else if (parsed.selection.payload.action === "harden") {
        stdout(render({ state_recovery: await deps.hardenState(deps.home()) }, resolveMode(values)));
      } else {
        stdout(render({ state_recovery: await deps.quarantineState(deps.home()) }, resolveMode(values)));
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("CONFLICT", error instanceof Error ? error.message : "private-state recovery failed", {
        help: "superbee setup",
      });
    }
    return;
  }
  if (requestedHost) {
    const target = MCP_INSTALL_TARGETS.find((candidate) => candidate.id === requestedHost)!;
    const inspection = await inspectAll(scope, [target], deps);
    stdout(render({ setup: planForHost(inspection, requestedHost, scope) }, resolveMode(values)));
    return;
  }
  const inspection = await inspectAll(scope, MCP_INSTALL_TARGETS, deps);
  const state = setupStateCapability(inspection.state);
  const stateNext = setupNextForCapability(state);
  const hosts = MCP_INSTALL_TARGETS.map((target) => {
    const plan = planForHost(inspection, target.id, scope);
    return {
      id: target.id,
      label: target.label,
      ready: plan.ready,
      complete: plan.complete,
      mcp_state: inspection.mcp.find((row) => row.host === target.id)!.state,
      command: `superbee setup --host ${target.id} --scope ${scope}`,
    };
  });
  stdout(render({
    setup: {
      schema_version: 1,
      mode: "select_host",
      scope,
      hosts,
      capabilities: [state],
      next: stateNext ?? {
        action: "select_host",
        instruction: "choose the exact host running this agent, then run that row's command",
      },
    },
  }, resolveMode(values)));
}
