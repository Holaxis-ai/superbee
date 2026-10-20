import { renderUsage } from "../output.js";
// `superbee setup` — one read-only AXI conductor plus one explicit, bounded state-migration leaf.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSelectorOrUsage } from "../args.js";
import { ownConventionalBoardRoot, resolveLocalBundleTarget, resolveProjectBinding, samePhysicalPath, type LocalBundleTarget } from "../bundle.js";
import { detectBoardChannel } from "../board-runtime.js";
import type { ChannelDetection } from "@superbee/board-git";
import { listCatalogEntries, type CatalogEntryView } from "../catalog.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { inspectMcpHosts, MCP_INSTALL_TARGETS, type McpHostStatus, type McpInstallTarget, type McpInstallTargetId } from "../mcp-install-targets.js";
import { normalizeInstallScope, type InstallScope } from "../install-scope.js";
import { resolvePersistentInstallAuthority, type PersistentInstallAuthority } from "../install-authority.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode } from "../output.js";
import {
  buildSetupPlan,
  AGENT_SETUP_INSTRUCTION,
  SETUP_VERIFICATION,
  setupNextForCapability,
  setupStateCapability,
  setupProjectArgs,
  type SetupProjectSelection,
  type SetupHookHostState,
  type SetupPlan,
  type SetupSkillHostState,
  type SetupWorkspaceState,
} from "../setup-plan.js";
import { inspectHookStatus, type HookStatusInspection } from "./hook.js";
import { setupHosted } from "./setup-hosted.js";
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

export const SETUP_USAGE = `superbee setup — inspect setup readiness and return the next action for the calling agent

Usage:
  superbee setup [--host codex|claude-code|claude-desktop|opencode]
                 [--scope project|user] [--project-selected | --skip-project] [--json]
  superbee setup migrate-state [--json]
  superbee setup harden-state [--json]
  superbee setup quarantine-state [--json]
  superbee setup hosted [--url <hosted-url>] [--workspace <id>] [--json]

Setup is an agent-driven workflow. The calling agent selects its exact host, executes the returned
next action, reports what it is doing, requests approval when \`approval.required\` is true, and
reruns setup until status is ready. Do not ask the user to copy or run setup commands unless the
agent cannot execute them. With --host, setup composes the existing distribution, Agent Skill,
SessionStart hook, MCP registration, local bundle, and private catalog inspectors into one
deterministic plan. It never writes configuration or treats detected software as mutation
authority. \`--json\` returns argv arrays plus mutation and approval metadata; a command template is
not executable until its placeholder value is chosen.

Choose the actual project folder before creating its first notes folder (.superbee). A project
folder may be empty and need not contain code or Git. Run setup from that folder with
--project-selected to confirm it, or --skip-project to finish user integration without choosing
a project. An existing resolved bundle remains selected without this flag. An unconfirmed launch
directory and unrelated catalog entries never authorize a new notes folder. Project scope requires
a selected project; --skip-project is user-scope only. Follow returned action.cwd as literal working
directory data, alongside each argv array. These flags apply only to setup inspection.

status, ready and complete describe configured readiness on disk, not live host activation.
Keep restart_required action receipts until the host is actually restarted/reloaded; a later ready
inspection cannot observe or clear that requirement. Verify live MCP access after restart before
reporting it active.

Without --host, the command reports private-state health plus the four bounded supported host
surfaces. A required state remedy comes first; otherwise the calling agent selects the exact host.

When setup reports validated legacy operational state, migrate-state copies only the private
catalog, remote credentials, and immutable View approvals into Superbee's canonical state root.
It never moves bundles or deletes legacy bytes. The explicit command is the authorization event.

A catalog entry preserves a workspace for explicit MCP selection; it never selects that workspace
as the current project's context. Do not read, write, orient from, or sync a cataloged workspace
unless the current checkout resolves to it or the user explicitly selects it. If this checkout has
no bundle, setup reports that state without borrowing one from another project.

\`setup hosted\` signs in to hosted Superbee and records the default hosted workspace in one step:
relay the AUTH_REQUIRED link it returns to the person, then re-run it (see setup hosted --help).

Options:
  --host <id>           Exact host: codex, claude-code, claude-desktop, or opencode
  --scope <scope>       Skill and hook scope: user (default) or project
  --project-selected    Confirm this invocation's directory is the chosen project folder
  --skip-project        Defer project selection and notes-folder/catalog setup (user scope only)
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
  inspectBoard: (startDir: string) => Promise<ChannelDetection>;
  listCatalog: (home: string) => Promise<CatalogEntryView[]>;
  inspectState: (home: string) => Promise<UserStateMigrationInspection>;
  migrateState: (home: string) => Promise<UserStateMigrationReceipt>;
  hardenState: (home: string) => Promise<UserStateRecoveryReceipt>;
  quarantineState: (home: string) => Promise<UserStateRecoveryReceipt>;
  invocation: () => string;
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
  if (host === "opencode") return inspection.hosts.opencode;
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

function planForHost(
  inspection: SetupInspection,
  host: McpInstallTargetId,
  scope: InstallScope,
  invocation: readonly string[],
  projectSelection: SetupProjectSelection,
  cwd: string,
): SetupPlan {
  const mcp = inspection.mcp.find((row) => row.host === host);
  if (!mcp) throw new Error(`missing setup MCP inspection for ${host}`);
  return buildSetupPlan({
    host,
    scope,
    projectSelection,
    cwd,
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
    invocation,
  });
}

export async function inspectSetupBoard(startDir: string): Promise<ChannelDetection> {
  const binding = await resolveProjectBinding(startDir);
  // Only the existing binding authority may route discovery back to this checkout.
  const boardRoot = binding ? await ownConventionalBoardRoot(binding) : startDir;
  if (!boardRoot) throw new CliError("NOT_FOUND", "the project binding is unresolved");
  return detectBoardChannel(boardRoot, { budget: { fetchTimeoutMs: 2000, connectTimeoutSeconds: 2 } });
}

async function inspectWorkspace(deps: SetupDeps, projectSelection: SetupProjectSelection): Promise<SetupWorkspaceState> {
  if (projectSelection === "deferred") {
    return { bundle: "not_checked", catalog: "not_checked", selected_registered: false };
  }
  let selected: LocalBundleTarget | undefined;
  let bundle: SetupWorkspaceState["bundle"] = "absent";
  let recovery: string | undefined;
  try {
    selected = await deps.resolveBundle(deps.cwd());
    bundle = "selected";
  } catch (error) {
    bundle = error instanceof CliError && error.code === "NOT_FOUND" ? "absent" : "unreadable";
    // A bound path that must change before any bundle can be created or provisioned there is
    // blocked, not absent: board detection would otherwise recommend a sync that cannot succeed.
    if (error instanceof CliError && (bundle === "unreadable" || error.details?.binding_target_blocked !== undefined)) {
      bundle = "unreadable";
      if (error.help) recovery = error.help;
    }
  }
  let board: ChannelDetection | undefined;
  if (bundle === "absent" && projectSelection === "confirmed") {
    try {
      board = await deps.inspectBoard(deps.cwd());
    } catch {
      // A binding or discovery conflict is not evidence for creating a replacement bundle.
      bundle = "unreadable";
    }
  }
  try {
    const entries = await deps.listCatalog(deps.home());
    const available = entries.filter((entry) => entry.available);
    return {
      bundle,
      ...(recovery ? { recovery } : {}),
      ...(board ? { board } : {}),
      catalog: available.length > 0 ? "ready" : "empty",
      selected_registered: selected !== undefined
        && available.some((entry) => samePhysicalPath(entry.locator.path, selected!.canonicalRoot)),
    };
  } catch {
    return { bundle, ...(recovery ? { recovery } : {}), ...(board ? { board } : {}), catalog: "unreadable", selected_registered: false };
  }
}

async function inspectAll(
  scope: InstallScope,
  targets: readonly McpInstallTarget[],
  deps: SetupDeps,
  projectSelection: SetupProjectSelection,
): Promise<SetupInspection> {
  let skill: SkillStatusInspection | undefined;
  let hook: HookStatusInspection | undefined;
  let projectHook: HookStatusInspection | undefined;
  let projectHookUnavailable = false;
  const workspace = await inspectWorkspace(deps, projectSelection);
  const canInspectProject = projectSelection === "confirmed" || workspace.bundle === "selected";
  if ((scope === "user" || canInspectProject) && targets.some((target) => target.id === "codex" || target.id === "claude-code" || target.id === "opencode")) {
    try {
      skill = deps.inspectSkill(scope);
    } catch {
      skill = undefined;
    }
  }
  if ((scope === "user" || canInspectProject) && targets.some((target) => target.id !== "claude-desktop")) {
    try {
      hook = deps.inspectHook(scope);
    } catch {
      hook = undefined;
    }
    if (scope === "user" && canInspectProject) {
      try {
        projectHook = deps.inspectHook("project");
      } catch {
        projectHook = undefined;
        projectHookUnavailable = true;
      }
    }
  }
  const [mcp, state] = await Promise.all([
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
  // The one setup leaf that signs in: its own flags (a hosted URL, not an agent host id).
  if (argv[0] === "hosted") {
    await setupHosted(argv.slice(1), { stdout });
    return;
  }
  const parsed = parseSelectorOrUsage(
    () => parseArgs({
      args: argv,
      options: {
        host: { type: "string" },
        scope: { type: "string" },
        "project-selected": { type: "boolean" },
        "skip-project": { type: "boolean" },
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
    stdout(renderUsage(SETUP_USAGE));
    return;
  }
  if (parsed.selection.kind === "unknown" || parsed.selection.kind === "navigation") {
    throw new CliError("USAGE", `unknown setup subcommand: ${parsed.selection.kind === "unknown" ? parsed.selection.token : ""}`, {
      help: `${cliInvocation()} setup --help`,
    });
  }
  const scope = normalizeInstallScope(values.scope ?? "user");
  if (!scope) {
    throw new CliError("USAGE", `unsupported setup scope: ${values.scope} (expected project|user)`, {
      help: `${cliInvocation()} setup --scope project|user`,
    });
  }
  const requestedHost = setupHost(values.host);
  if (values.host !== undefined && !requestedHost) {
    throw new CliError("USAGE", `unknown setup host '${values.host}'`, {
      details: { supported_hosts: MCP_INSTALL_TARGETS.map(({ id }) => id) },
      help: `${cliInvocation()} setup --host <id>`,
    });
  }
  if (values["project-selected"] && values["skip-project"]) {
    throw new CliError("USAGE", "--project-selected and --skip-project are mutually exclusive", { help: `${cliInvocation()} setup --help` });
  }
  if (values["skip-project"] && scope === "project") {
    throw new CliError("USAGE", "--skip-project requires user scope; choose a project folder before project-scoped integration", { help: `${cliInvocation()} setup --help` });
  }
  const projectSelection: SetupProjectSelection = values["skip-project"] ? "deferred" : values["project-selected"] ? "confirmed" : "unselected";
  const cwd = resolve(injected.cwd?.() ?? process.cwd());
  const deps: SetupDeps = {
    stdout,
    cwd: () => cwd,
    home: injected.home ?? homedir,
    inspectDistribution: injected.inspectDistribution ?? (() => resolvePersistentInstallAuthority()),
    inspectSkill: injected.inspectSkill ?? ((selectedScope) => inspectSkillStatus(selectedScope, { cwd })),
    inspectHook: injected.inspectHook ?? ((selectedScope) => inspectHookStatus(selectedScope, { cwd })),
    inspectMcp: injected.inspectMcp ?? ((targets) => inspectMcpHosts(targets)),
    resolveBundle: injected.resolveBundle ?? ((startDir) => resolveLocalBundleTarget(undefined, startDir)),
    inspectBoard: injected.inspectBoard ?? inspectSetupBoard,
    listCatalog: injected.listCatalog ?? listCatalogEntries,
    inspectState: injected.inspectState ?? inspectUserStateMigration,
    migrateState: injected.migrateState ?? migrateUserState,
    hardenState: injected.hardenState ?? hardenUserState,
    quarantineState: injected.quarantineState ?? quarantineUserState,
    invocation: injected.invocation ?? cliInvocation,
  };
  if (parsed.selection.kind === "selected" && parsed.selection.payload.action !== "inspect") {
    if (values.host !== undefined || values.scope !== undefined || values["project-selected"] !== undefined || values["skip-project"] !== undefined) {
      throw new CliError("USAGE", `setup ${parsed.selection.payload.action}-state does not accept --host, --scope, --project-selected or --skip-project`, {
        help: `${cliInvocation()} setup ${parsed.selection.payload.action}-state [--json]`,
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
        help: `${cliInvocation()} setup`,
      });
    }
    return;
  }
  if (requestedHost) {
    const target = MCP_INSTALL_TARGETS.find((candidate) => candidate.id === requestedHost)!;
    const inspection = await inspectAll(scope, [target], deps, projectSelection);
    stdout(render({ setup: planForHost(inspection, requestedHost, scope, deps.invocation().split(/\s+/), projectSelection, cwd) }, resolveMode(values)));
    return;
  }
  const inspection = await inspectAll(scope, MCP_INSTALL_TARGETS, deps, projectSelection);
  const invocation = deps.invocation().split(/\s+/);
  const state = setupStateCapability(inspection.state);
  const stateNext = setupNextForCapability(state, invocation, cwd);
  const hosts = MCP_INSTALL_TARGETS.map((target) => {
    const plan = planForHost(inspection, target.id, scope, invocation, projectSelection, cwd);
    return {
      id: target.id,
      label: target.label,
      ready: plan.ready,
      complete: plan.complete,
      mcp_state: inspection.mcp.find((row) => row.host === target.id)!.state,
      action: {
        action: "run" as const,
        command: [...invocation, "setup", "--host", target.id, "--scope", scope, ...setupProjectArgs(projectSelection), "--json"],
        cwd,
        description: `Inspect setup readiness for ${target.label}.`,
        mutates: false,
        approval: { required: false, reason: null },
      },
    };
  });
  stdout(render({
    setup: {
      schema_version: 2,
      protocol: "agent_setup_v1",
      status: stateNext?.action === "inspect" ? "blocked" : "action_required",
      agent_instruction: AGENT_SETUP_INSTRUCTION,
      mode: "select_host",
      scope,
      verification: SETUP_VERIFICATION,
      verify: {
        action: "run",
        command: [...invocation, "setup", "--scope", scope, ...setupProjectArgs(projectSelection), "--json"],
        cwd,
        description: "Reinspect configured setup readiness while preserving project choice and scope.",
        mutates: false,
        approval: { required: false, reason: null },
      },
      hosts,
      capabilities: [state],
      next: stateNext ?? {
        action: "select_host",
        cwd,
        description: "Identify the exact host running this agent, then execute that host row's action.",
        mutates: false,
        approval: { required: false, reason: null },
      },
    },
  }, resolveMode(values)));
}
