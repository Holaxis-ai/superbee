// Pure AXI setup planning. Host/file inspection lives at the command boundary; this module owns
// only the bounded capability matrix, deterministic ordering, and one-next-command projection.

import type { McpInstallTargetId, McpRegistrationState } from "./mcp-install-targets.js";
import type {
  PersistentInstallAuthorityFailure,
  PersistentInstallAuthorityState,
} from "./install-authority.js";
import type { InstallScope } from "./install-scope.js";
import type { HookCompatibility } from "./hook-compatibility.js";
import type { SkillCompatibilityState, SkillState } from "./skill-compatibility.js";
import type { UserStateMigrationInspection } from "./user-state-migration.js";

export type SetupRequirement = "required" | "recommended" | "not_applicable";
export type SetupCapabilityState = "ready" | "needs_action" | "blocked" | "not_applicable";
export type SetupActionKind = "run" | "inspect" | "choose_value" | "select_host";

export interface SetupApproval {
  readonly required: boolean;
  readonly reason: string | null;
}

/**
 * A machine-executable next step for the calling agent. `command` is an argv vector, never shell
 * prose. Shell recovery is explicit (`sh -c`) because the command itself is a fixed CLI-owned
 * remedy; a template is deliberately not executable until the agent has obtained its value.
 */
export interface SetupAction {
  readonly action: SetupActionKind;
  readonly command?: readonly string[];
  readonly command_template?: string;
  readonly description: string;
  readonly mutates: boolean;
  readonly approval: SetupApproval;
}

export const AGENT_SETUP_INSTRUCTION =
  "The calling agent executes the returned action, reports what it is doing, requests approval when approval.required is true, then reruns setup until status is ready. The calling agent must not relay the command to the user unless execution is unavailable.";

export interface SetupCapability {
  readonly id: "distribution" | "state" | "skill" | "mcp" | "hook" | "bundle" | "catalog";
  readonly requirement: SetupRequirement;
  readonly state: SetupCapabilityState;
  readonly reason: string;
  readonly command?: string;
}

export interface SetupSkillHostState {
  readonly canonical: {
    readonly state: SkillState;
    readonly compatibility?: { readonly state: SkillCompatibilityState };
  };
  readonly legacy: {
    readonly state: SkillState;
    readonly compatibility?: { readonly state: SkillCompatibilityState };
  };
}

export interface SetupHookHostState {
  readonly installed: boolean;
  readonly compatibility: HookCompatibility;
  readonly installSafe?: boolean;
}

export interface SetupWorkspaceState {
  readonly bundle: "selected" | "absent" | "unreadable";
  readonly catalog: "ready" | "empty" | "unreadable";
  readonly selected_registered: boolean;
}

export interface SetupPlanInput {
  readonly host: McpInstallTargetId;
  readonly scope: InstallScope;
  readonly distribution: {
    readonly allowed: boolean;
    readonly state: PersistentInstallAuthorityState;
    readonly reason: string;
    readonly persistent: boolean;
    readonly failure?: PersistentInstallAuthorityFailure;
  };
  readonly state: UserStateMigrationInspection;
  readonly skill?: SetupSkillHostState;
  readonly hook?: SetupHookHostState;
  readonly projectHook?: SetupHookHostState;
  readonly projectHookUnavailable?: boolean;
  readonly mcp: { readonly state: McpRegistrationState; readonly reason: string };
  readonly workspace: SetupWorkspaceState;
  /** Resolved launcher for follow-up actions; defaults to the portable installed bin. */
  readonly invocation?: readonly string[];
}

export function setupStateCapability(state: UserStateMigrationInspection): SetupCapability {
  if (state.state === "ready" || state.state === "fresh") {
    return {
      id: "state",
      requirement: "required",
      state: "ready",
      reason: state.reason,
    };
  }
  if (state.state === "migratable") {
    return {
      id: "state",
      requirement: "required",
      state: "needs_action",
      reason: state.reason,
      command: "superbee setup migrate-state",
    };
  }
  // A root this product RECOGNIZES is repaired, never quarantined: it may hold the only copy of
  // the catalog, credentials, and View approvals, and nothing re-imports a quarantined root.
  if (state.state === "repairable") {
    return {
      id: "state",
      requirement: "required",
      state: "needs_action",
      reason: state.reason,
      command: state.command,
    };
  }
  // A blocked state root cannot be un-blocked by rerunning the command that reported it, and the
  // exit node depends on WHICH root is blocked, so the inspection supplies it.
  return {
    id: "state",
    requirement: "required",
    state: "blocked",
    reason: state.reason,
    command: state.command,
  };
}

function commandForInvocation(command: string, invocation: readonly string[]): string {
  const launcher = invocation.join(" ");
  if (launcher === "superbee") return command;

  // Only replace an executable command head (including one after a fixed shell
  // chain). Package operands and private-state paths may also contain the word
  // "superbee" and must remain untouched.
  return command
    .replace(/^superbee(?=\s|$)/, launcher)
    .replace(/([;&]{1,2}\s*)superbee(?=\s|$)/g, `$1${launcher}`);
}

function commandArgv(command: string, invocation: readonly string[]): readonly string[] {
  // These are CLI-owned recovery strings. Preserve shell semantics only when control syntax or
  // home expansion is required; ordinary setup actions remain directly executable argv vectors.
  const resolved = commandForInvocation(command, invocation);
  if (/[&|;$`"']/.test(resolved) || resolved.includes("~")) return ["sh", "-c", resolved];
  return resolved.split(/\s+/).filter(Boolean);
}

function mutatesCapability(capability: SetupCapability): boolean {
  const command = capability.command ?? "";
  if (capability.id === "distribution") return command.startsWith("npm install ");
  if (capability.id === "skill" || capability.id === "mcp" || capability.id === "hook") {
    return command.includes(" install ");
  }
  if (capability.id === "bundle") return command.startsWith("superbee init ");
  if (capability.id === "catalog") return command.startsWith("superbee catalog add ");
  if (capability.id === "state") {
    return command.startsWith("superbee setup migrate-state")
      || command.startsWith("superbee setup harden-state")
      || command.startsWith("superbee setup quarantine-state")
      || command.startsWith("chmod ")
      || command.includes(" mv ");
  }
  return false;
}

function approvalFor(capability: SetupCapability, mutates: boolean): SetupApproval {
  if (!mutates) return { required: false, reason: null };
  const command = capability.command ?? "";
  if (capability.id === "skill" && command.includes("--scope project")) {
    return { required: false, reason: null };
  }
  if (capability.id === "hook" && command.includes("--scope project")) {
    return { required: false, reason: null };
  }
  if (capability.id === "bundle") {
    return { required: true, reason: "This creates durable project knowledge-bundle files." };
  }
  if (capability.id === "state") {
    return { required: true, reason: "This writes to the user-level Superbee private-state directory." };
  }
  if (capability.id === "distribution") {
    return { required: true, reason: "This writes to the user-level npm global installation." };
  }
  return { required: true, reason: "This writes to user-level host configuration." };
}

function actionDescription(capability: SetupCapability): string {
  const command = capability.command ?? "";
  if (command.startsWith("superbee skill install")) return "Install Superbee's Agent Skill for the selected scope.";
  if (command.startsWith("superbee mcp install")) return "Install Superbee's MCP registration for the selected host.";
  if (command.startsWith("superbee hook install")) return "Install Superbee's SessionStart hook for the selected scope.";
  if (command.startsWith("superbee setup migrate-state")) return "Migrate validated legacy private state into Superbee's canonical user-state directory.";
  if (command.startsWith("superbee setup harden-state")) return "Repair permissions on Superbee's recognized private-state directory.";
  if (command.startsWith("superbee setup quarantine-state")) return "Preserve unrecognized private state by moving it aside before setup continues.";
  if (command.startsWith("npm install ")) return "Install Superbee into the user's global npm prefix.";
  if (command.startsWith("superbee init ")) return "Create the requested project-local Superbee bundle.";
  return capability.reason;
}

export function setupNextForCapability(
  capability: SetupCapability,
  invocation: readonly string[] = ["superbee"],
): SetupAction | undefined {
  if (!capability.command) return undefined;
  const mutates = mutatesCapability(capability);
  const approval = approvalFor(capability, mutates);
  return {
    // A blocked row represents uncertainty or foreign state. Keep every such remedy in the
    // inspect phase: approval metadata describes a later mutation, but never makes an unknown
    // state directly runnable before the operator has inspected the conflict.
    action: capability.state === "blocked"
      ? "inspect"
      : capability.command.includes("<")
        ? "choose_value"
        : "run",
    ...(capability.command.includes("<")
      ? { command_template: commandForInvocation(capability.command, invocation) }
      : { command: commandArgv(capability.command, invocation) }),
    description: actionDescription(capability),
    mutates,
    approval,
  };
}

export interface SetupPlan {
  readonly schema_version: 2;
  readonly protocol: "agent_setup_v1";
  readonly status: "ready" | "action_required" | "blocked";
  readonly agent_instruction: string;
  readonly host: McpInstallTargetId;
  readonly scope: InstallScope;
  readonly ready: boolean;
  readonly complete: boolean;
  readonly workspace: {
    readonly current_project_bundle: SetupWorkspaceState["bundle"];
    readonly catalog_access: SetupWorkspaceState["catalog"];
    readonly catalog_selects_current_project: false;
  };
  readonly capabilities: readonly SetupCapability[];
  readonly next?: SetupAction;
  readonly verify: SetupAction;
  readonly restart: { readonly after: readonly ("skill" | "mcp" | "hook")[] };
}

function distributionCapability(input: SetupPlanInput): SetupCapability {
  if (input.distribution.allowed && input.distribution.persistent) {
    return {
      id: "distribution",
      requirement: "required",
      state: "ready",
      reason: input.distribution.state === "durable_global"
        ? "the running CLI is a durable npm-global installation"
        : "the running CLI is an installed developer artifact with stable launch paths",
    };
  }
  if (input.distribution.failure === "npm_prefix_runtime_unavailable") {
    return {
      id: "distribution",
      requirement: "required",
      state: "blocked",
      reason: `${input.distribution.reason}; use the npm-global prefix owned by the running Node installation, reinstall Superbee there, then rerun setup`,
      command: "npm prefix --global && command -v node && command -v superbee",
    };
  }
  return {
    id: "distribution",
    requirement: "required",
    state: "needs_action",
    reason: input.distribution.reason,
    command: "npm install -g superbee",
  };
}

function skillCapability(input: SetupPlanInput): SetupCapability {
  if (input.host === "claude-desktop" || input.host === "opencode") {
    return {
      id: "skill",
      requirement: "not_applicable",
      state: "not_applicable",
      reason: `${input.host} has no supported Agent Skill install surface`,
    };
  }
  if (!input.skill) {
    return {
      id: "skill",
      requirement: "required",
      state: "blocked",
      reason: "Agent Skill status is unavailable",
      command: `superbee skill status --scope ${input.scope}`,
    };
  }
  const canonicalOwned = input.skill.canonical.state === "installed" || input.skill.canonical.state === "stale";
  const legacyOwned = input.skill.legacy.state === "installed" || input.skill.legacy.state === "stale";
  if (canonicalOwned && legacyOwned) {
    return {
      id: "skill",
      requirement: "required",
      state: "blocked",
      reason: "both canonical and legacy Agent Skill folders are managed; inspect before convergence",
      command: `superbee skill status --scope ${input.scope}`,
    };
  }
  if (
    input.skill.canonical.compatibility?.state === "newer_contract"
    || input.skill.legacy.compatibility?.state === "newer_contract"
  ) {
    return {
      id: "skill",
      requirement: "required",
      state: "blocked",
      reason: "the installed Agent Skill uses a newer compatibility contract than this CLI",
      command: `superbee skill status --scope ${input.scope}`,
    };
  }
  if (input.skill.canonical.state === "installed") {
    return {
      id: "skill",
      requirement: "required",
      state: "ready",
      reason: "the current Superbee Agent Skill is installed",
    };
  }
  if (input.skill.canonical.state === "unmanaged") {
    return {
      id: "skill",
      requirement: "required",
      state: "blocked",
      reason: "the canonical Agent Skill folder is not managed by Superbee",
      command: `superbee skill status --scope ${input.scope}`,
    };
  }
  return {
    id: "skill",
    requirement: "required",
    state: "needs_action",
    reason: legacyOwned
      ? "a managed legacy Agent Skill is ready to migrate"
      : input.skill.canonical.state === "stale"
        ? "the managed Agent Skill does not match this CLI"
        : "the Superbee Agent Skill is absent",
    command: `superbee skill install --scope ${input.scope}`,
  };
}

function mcpCapability(input: SetupPlanInput): SetupCapability {
  if (input.mcp.state === "owned_current") {
    return {
      id: "mcp",
      requirement: "required",
      state: "ready",
      reason: "the host registration matches this durable Superbee install",
    };
  }
  if (input.mcp.state === "absent" || input.mcp.state === "owned_stale") {
    return {
      id: "mcp",
      requirement: "required",
      state: "needs_action",
      reason: input.mcp.reason,
      command: `superbee mcp install --host ${input.host}`,
    };
  }
  if (input.mcp.state === "known_legacy") {
    return {
      id: "mcp",
      requirement: "required",
      state: "blocked",
      reason: input.mcp.reason,
      command: `superbee mcp status --host ${input.host}`,
    };
  }
  return {
    id: "mcp",
    requirement: "required",
    state: "blocked",
    reason: input.mcp.reason,
    command: `superbee mcp status --host ${input.host}`,
  };
}

function hookCapability(input: SetupPlanInput): SetupCapability {
  if (input.host === "claude-desktop") {
    return {
      id: "hook",
      requirement: "not_applicable",
      state: "not_applicable",
      reason: "Claude Desktop has no supported SessionStart hook surface",
    };
  }
  if (!input.hook) {
    return {
      id: "hook",
      requirement: "recommended",
      state: "blocked",
      reason: "SessionStart hook status is unavailable",
      command: `superbee hook status --scope ${input.scope}`,
    };
  }
  if (input.hook.installSafe === false) {
    return {
      id: "hook",
      requirement: "recommended",
      state: "blocked",
      reason: `the ${input.host} hook settings cannot be safely inspected for installation`,
      command: `superbee hook status --scope ${input.scope}`,
    };
  }
  if (input.hook.installed && input.hook.compatibility.state === "current") {
    if (input.scope === "user" && input.projectHookUnavailable) {
      return {
        id: "hook",
        requirement: "recommended",
        state: "blocked",
        reason: `the ${input.host} project hook settings could not be inspected`,
        command: "superbee hook status --scope project",
      };
    }
    if (input.scope === "user" && input.projectHook) {
      if (input.projectHook.installSafe === false) {
        return {
          id: "hook",
          requirement: "recommended",
          state: "blocked",
          reason: `the ${input.host} project hook settings cannot be safely reconciled with the user hook`,
          command: "superbee hook status --scope project",
        };
      }
      if (input.host === "opencode" && input.projectHook.compatibility.state === "unmanaged") {
        return {
          id: "hook",
          requirement: "recommended",
          state: "blocked",
          reason: "the reserved project OpenCode plugin path is not managed by Superbee",
          command: "superbee hook status --scope project",
        };
      }
      if (input.projectHook.installed) {
        return {
          id: "hook",
          requirement: "recommended",
          state: "blocked",
          reason: "a managed project SessionStart hook overlaps the current user hook",
          command: "superbee hook status --scope project",
        };
      }
    }
    return {
      id: "hook",
      requirement: "recommended",
      state: "ready",
      reason: "the current SessionStart orientation hook is installed",
    };
  }
  if (input.host === "opencode" && input.hook.compatibility.state === "unmanaged") {
    return {
      id: "hook",
      requirement: "recommended",
      state: "blocked",
      reason: "the reserved OpenCode plugin path is not managed by Superbee",
      command: `superbee hook status --scope ${input.scope}`,
    };
  }
  return {
    id: "hook",
    requirement: "recommended",
    state: "needs_action",
    reason: input.hook.installed
      ? "the managed SessionStart hook does not match this CLI"
      : "the SessionStart orientation hook is absent",
    command: `superbee hook install --scope ${input.scope}`,
  };
}

function bundleCapability(input: SetupPlanInput): SetupCapability {
  if (input.workspace.bundle === "selected") {
    return { id: "bundle", requirement: "recommended", state: "ready", reason: "a local bundle is selected" };
  }
  if (input.workspace.bundle === "unreadable") {
    return {
      id: "bundle",
      requirement: "recommended",
      state: "blocked",
      reason: "local bundle selection is unreadable or conflicting",
      command: "superbee bundle locate",
    };
  }
  if (input.workspace.catalog === "ready") {
    return {
      id: "bundle",
      requirement: "recommended",
      state: "not_applicable",
      reason: "no current-project bundle is selected; catalog entries remain available only by explicit selection and are not project context",
    };
  }
  return {
    id: "bundle",
    requirement: "recommended",
    state: "needs_action",
    reason: "no local bundle is selected",
    command: "superbee init --create-only --recipe work-tracking --dir .superbee",
  };
}

function catalogCapability(input: SetupPlanInput): SetupCapability {
  if (input.workspace.catalog === "ready" && (input.workspace.bundle !== "selected" || input.workspace.selected_registered)) {
    return {
      id: "catalog",
      requirement: "required",
      state: "ready",
      reason: input.workspace.bundle === "selected"
        ? "the selected bundle is registered for bundle-unbound MCP access"
        : "the private workspace catalog has at least one explicitly selectable bundle; cataloging does not select current project context",
    };
  }
  if (input.workspace.catalog === "unreadable") {
    return {
      id: "catalog",
      requirement: "required",
      state: "blocked",
      reason: "the private workspace catalog is unreadable",
      command: "superbee catalog list",
    };
  }
  return {
    id: "catalog",
    requirement: "required",
    state: "needs_action",
    reason: input.workspace.bundle === "selected"
      ? "the selected bundle is not registered for bundle-unbound MCP access"
      : "the private workspace catalog has no available bundles",
    command: input.workspace.bundle === "selected"
      ? "superbee catalog add <label>"
      : "superbee catalog add <label> --dir <path>",
  };
}

export function buildSetupPlan(input: SetupPlanInput): SetupPlan {
  const capabilities = [
    distributionCapability(input),
    setupStateCapability(input.state),
    skillCapability(input),
    mcpCapability(input),
    bundleCapability(input),
    catalogCapability(input),
    hookCapability(input),
  ] as const;
  const required = capabilities.filter((capability) => capability.requirement === "required");
  const actionable = capabilities.find((capability) =>
    capability.state === "needs_action" || capability.state === "blocked",
  );
  const invocation = input.invocation ?? ["superbee"];
  const next = actionable ? setupNextForCapability(actionable, invocation) : undefined;
  const ready = required.every((capability) => capability.state === "ready");
  const complete = capabilities.every((capability) => capability.state === "ready" || capability.state === "not_applicable");
  const restartAfter = capabilities
    .filter((capability): capability is SetupCapability & { id: "skill" | "mcp" | "hook" } =>
      (capability.id === "skill" || capability.id === "mcp" || capability.id === "hook")
      && capability.state === "needs_action",
    )
    .map((capability) => capability.id);
  return {
    schema_version: 2,
    protocol: "agent_setup_v1",
    status: complete ? "ready" : next?.action === "inspect" ? "blocked" : "action_required",
    agent_instruction: AGENT_SETUP_INSTRUCTION,
    host: input.host,
    scope: input.scope,
    ready,
    complete,
    workspace: {
      current_project_bundle: input.workspace.bundle,
      catalog_access: input.workspace.catalog,
      catalog_selects_current_project: false,
    },
    capabilities,
    ...(next ? { next } : {}),
    verify: {
      action: "run",
      command: [...invocation, "setup", "--host", input.host, "--scope", input.scope, "--json"],
      description: "Reinspect setup readiness after the preceding action.",
      mutates: false,
      approval: { required: false, reason: null },
    },
    restart: { after: restartAfter },
  };
}
