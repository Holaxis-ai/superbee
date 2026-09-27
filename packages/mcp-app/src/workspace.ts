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

/**
 * Where a workspace's documents live, as the host's catalog derives it: a plain local folder, a
 * folder shared through Git, or a folder checked out from a hosted bundle. Descriptive only; every
 * home is read and written through its folder the same way.
 */
export const MCP_WORKSPACE_HOMES = ["local", "git", "hosted"] as const;
export type McpWorkspaceHome = (typeof MCP_WORKSPACE_HOMES)[number];

export interface McpWorkspaceSummary {
  readonly id: string;
  readonly label: string;
  readonly displayName?: string;
  readonly available: boolean;
  readonly home?: McpWorkspaceHome;
}

/**
 * A workspace the person can reach that has no folder on this machine yet. It cannot be opened
 * here: `bring` is the command that brings it into a folder (MCP tools never create folders).
 */
export interface McpElsewhereWorkspace {
  readonly name: string;
  readonly home: McpWorkspaceHome;
  /** Where it lives, e.g. the host's origin. */
  readonly source: string;
  readonly bring: string;
}

/** Host-neutral workspace authority supplied by the CLI; implementations may know the catalog. */
export interface McpWorkspaceResolver {
  list(): Promise<readonly McpWorkspaceSummary[]>;
  /** Reachable workspaces with no folder here, when the host knows any; bounded and best effort. */
  elsewhere?(): Promise<readonly McpElsewhereWorkspace[]>;
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
