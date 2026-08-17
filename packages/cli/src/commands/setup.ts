// `superbee setup` — one read-only AXI conductor over the existing integration authorities.

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { resolveLocalBundleTarget, type LocalBundleTarget } from "../bundle.js";
import { listCatalogEntries, type CatalogEntryView } from "../catalog.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { inspectMcpHosts, MCP_INSTALL_TARGETS, type McpHostStatus, type McpInstallTarget, type McpInstallTargetId } from "../mcp-install-targets.js";
import { normalizeInstallScope, type InstallScope } from "../install-scope.js";
import { resolvePersistentInstallAuthority, type PersistentInstallAuthority } from "../install-authority.js";
import { render, resolveMode } from "../output.js";
import { buildSetupPlan, type SetupHookHostState, type SetupPlan, type SetupSkillHostState, type SetupWorkspaceState } from "../setup-plan.js";
import { inspectHookStatus, type HookStatusInspection } from "./hook.js";
import { inspectSkillStatus, type SkillStatusInspection } from "./skill.js";

export const SETUP_USAGE = `superbee setup — inspect the complete host integration and emit one safe next command

Usage:
  superbee setup [--host codex|claude-code|claude-desktop|opencode]
                 [--scope project|user] [--json]

Without --host, the command reports the four bounded supported host surfaces and asks the agent to
select the exact host. With --host, it composes the existing distribution, Agent Skill,
SessionStart hook, MCP registration, local bundle, and private catalog inspectors into one
deterministic plan. It never writes configuration or treats detected software as mutation
authority. Run the returned next.command, restart the named host after integration changes, and
re-run the same setup command to verify.

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
  if (host === "claude-code") return inspection.hosts.claude_code;
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
        && available.some((entry) => entry.locator.path === selected!.canonicalRoot),
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
  if (targets.some((target) => target.id === "codex" || target.id === "claude-code")) {
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
  const [workspace, mcp] = await Promise.all([
    inspectWorkspace(deps),
    Promise.resolve(deps.inspectMcp(targets)),
  ]);
  return {
    distribution: deps.inspectDistribution(),
    skill,
    hook,
    projectHook,
    projectHookUnavailable,
    mcp,
    workspace,
  };
}

export async function setup(argv: string[], injected: Partial<SetupDeps> = {}): Promise<void> {
  const stdout = injected.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values } = parseLeafOrUsage(
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
    CLI_LEAVES.setup,
  );
  if (values.help) {
    stdout(SETUP_USAGE);
    return;
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
  };
  if (requestedHost) {
    const target = MCP_INSTALL_TARGETS.find((candidate) => candidate.id === requestedHost)!;
    const inspection = await inspectAll(scope, [target], deps);
    stdout(render({ setup: planForHost(inspection, requestedHost, scope) }, resolveMode(values)));
    return;
  }
  const inspection = await inspectAll(scope, MCP_INSTALL_TARGETS, deps);
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
      next: {
        action: "select_host",
        instruction: "choose the exact host running this agent, then run that row's command",
      },
    },
  }, resolveMode(values)));
}
