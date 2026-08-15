import type { Bundle } from "@superbee/core";
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

export interface McpWorkspaceSummary {
  readonly id: string;
  readonly label: string;
  readonly displayName?: string;
  readonly available: boolean;
}

/** Host-neutral workspace authority supplied by the CLI; implementations may know the catalog. */
export interface McpWorkspaceResolver {
  list(): Promise<readonly McpWorkspaceSummary[]>;
  open(selector: string): Promise<McpBundleContext>;
}

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
