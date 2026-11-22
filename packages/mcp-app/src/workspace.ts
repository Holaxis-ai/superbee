import type { Bundle } from "@superbee/core";
import type { WorkspaceResolver } from "@superbee/workspace-access";
import type { ViewAuthorizationStore } from "@superbee/view-runtime";

/** The exact bundle-scoped inputs that every MCP operation must retain together. */
export interface McpBundleContext {
  readonly bundle: Bundle;
  readonly name: string;
  readonly actor?: string;
  readonly viewAuthorization?: ViewAuthorizationStore;
}

export interface McpBundleContextOptions {
  bundle: Bundle;
  actor?: string;
  bundleName?: string;
  viewAuthorization?: ViewAuthorizationStore;
}

export { WORKSPACE_HOMES as MCP_WORKSPACE_HOMES } from "@superbee/workspace-access";
export type {
  WorkspaceHome as McpWorkspaceHome,
  WorkspaceSummary as McpWorkspaceSummary,
  ReachableWorkspace as McpReachableWorkspace,
  ReachableListing as McpReachableListing,
  OperationsStop as McpOperationsStop,
} from "@superbee/workspace-access";

export type McpWorkspaceResolver = WorkspaceResolver<McpBundleContext>;

/** Normalize the existing fixed-bundle server inputs into one immutable routing context. */
export function createMcpBundleContext(
  options: McpBundleContextOptions,
): McpBundleContext {
  return Object.freeze({
    bundle: options.bundle,
    name: options.bundleName ?? "Superbee bundle",
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    ...(options.viewAuthorization !== undefined
      ? { viewAuthorization: options.viewAuthorization }
      : {}),
  });
}
