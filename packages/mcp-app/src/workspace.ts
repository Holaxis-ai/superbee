import type { Bundle } from "@superbee/core";
import type { HostedOperationListingAnswer, HostedOperationRun, JsonObject } from "@superbee/core/hosted-transport";
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
 * here: `command` is the one that brings it into a folder, or lists it (MCP tools never create
 * folders).
 */
export interface McpReachableWorkspace {
  readonly id: string;
  readonly name: string;
  readonly home: McpWorkspaceHome;
  /** Where it lives, e.g. the host's origin. */
  readonly location: string;
  readonly command: string;
}

/** The reachable workspaces with no folder here, and a note for each place that could not be asked. */
export interface McpReachableListing {
  readonly workspaces: readonly McpReachableWorkspace[];
  readonly notes: readonly string[];
}

/**
 * Why a workspace's host was not asked: the resolver's own answer, never the host's. A local or Git
 * folder has no host operations; a hosted checkout answers some reads from its folder (they would
 * skip its unsent edits run on the host); and a missing session is the one sign-in link to relay.
 */
export type McpOperationsStop =
  | { readonly stop: "no_host_operations"; readonly home: Exclude<McpWorkspaceHome, "hosted"> }
  | { readonly stop: "folder_answers"; readonly operationId: string }
  | { readonly stop: "sign_in_required"; readonly signInUrl: string; readonly userCode: string };

/** Host-neutral workspace authority supplied by the CLI; implementations may know the catalog. */
export interface McpWorkspaceResolver {
  list(): Promise<readonly McpWorkspaceSummary[]>;
  /** Reachable workspaces with no folder here, when the host knows any; bounded and best effort. */
  reachable?(): Promise<McpReachableListing>;
  open(selector: string): Promise<McpBundleContext>;
  /**
   * The reads a workspace's host runs by id, as the host lists them (the hosted client's
   * `listOperations` for the workspace's bundle), or why the host was not asked.
   */
  listOperations?(selector: string): Promise<HostedOperationListingAnswer | McpOperationsStop>;
  /**
   * One read run by id on the workspace's host, the hosted client's `runOperation` answer passed
   * through unchanged (`input.bundleId` is the workspace's), or why the host was not asked.
   */
  runOperation?(selector: string, operationId: string, input: JsonObject): Promise<HostedOperationRun | McpOperationsStop>;
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
