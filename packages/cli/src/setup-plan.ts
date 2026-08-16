// Pure AXI setup planning. Host/file inspection lives at the command boundary; this module owns
// only the bounded capability matrix, deterministic ordering, and one-next-command projection.

import type { McpInstallTargetId, McpRegistrationState } from "./mcp-install-targets.js";
import type { PersistentInstallAuthorityState } from "./install-authority.js";
import type { InstallScope } from "./install-scope.js";
import type { HookCompatibility } from "./hook-compatibility.js";
import type { SkillCompatibilityState, SkillState } from "./skill-compatibility.js";

export type SetupRequirement = "required" | "recommended" | "not_applicable";
export type SetupCapabilityState = "ready" | "needs_action" | "blocked" | "not_applicable";

export interface SetupCapability {
  readonly id: "distribution" | "skill" | "mcp" | "hook" | "bundle" | "catalog";
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
  };
  readonly skill?: SetupSkillHostState;
  readonly hook?: SetupHookHostState;
  readonly mcp: { readonly state: McpRegistrationState; readonly reason: string };
  readonly workspace: SetupWorkspaceState;
}

export interface SetupPlan {
  readonly schema_version: 1;
  readonly host: McpInstallTargetId;
  readonly scope: InstallScope;
  readonly ready: boolean;
  readonly complete: boolean;
  readonly capabilities: readonly SetupCapability[];
  readonly next?: {
    readonly action: "run" | "inspect" | "choose_value";
    readonly command: string;
    readonly reason: string;
  };
  readonly verify: { readonly command: string };
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
  if (input.mcp.state === "absent" || input.mcp.state === "owned_stale" || input.mcp.state === "known_legacy") {
    return {
      id: "mcp",
      requirement: "required",
      state: "needs_action",
      reason: input.mcp.reason,
      command: `superbee mcp install --host ${input.host}`,
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
      state: "ready",
      reason: "the private catalog provides a workspace; no local project bundle is selected",
    };
  }
  return {
    id: "bundle",
    requirement: "recommended",
    state: "needs_action",
    reason: "no local bundle is selected",
    command: "superbee init --create-only --recipe work-tracking --dir .agentstate-lite",
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
        : "the private workspace catalog has at least one available bundle",
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
  const restartAfter = capabilities
    .filter((capability): capability is SetupCapability & { id: "skill" | "mcp" | "hook" } =>
      (capability.id === "skill" || capability.id === "mcp" || capability.id === "hook")
      && capability.state === "needs_action",
    )
    .map((capability) => capability.id);
  return {
    schema_version: 1,
    host: input.host,
    scope: input.scope,
    ready: required.every((capability) => capability.state === "ready"),
    complete: capabilities.every((capability) => capability.state === "ready" || capability.state === "not_applicable"),
    capabilities,
    ...(actionable?.command
      ? {
          next: {
            action: actionable.state === "blocked"
              ? "inspect" as const
              : actionable.command.includes("<")
                ? "choose_value" as const
                : "run" as const,
            command: actionable.command,
            reason: actionable.reason,
          },
        }
      : {}),
    verify: { command: `superbee setup --host ${input.host} --scope ${input.scope}` },
    restart: { after: restartAfter },
  };
}
