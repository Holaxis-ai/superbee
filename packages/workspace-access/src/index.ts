import type { HostedOperationListingAnswer, HostedOperationRun, JsonObject } from "@superbee/core/hosted-transport";

export const MAX_WORKSPACE_CATALOG_PAGE = 50;

/**
 * Where a workspace's documents live, as the host's catalog derives it: a plain local folder, a
 * folder shared through Git, or a folder checked out from a hosted bundle. Descriptive only; every
 * home is read and written through its folder the same way.
 */
export const WORKSPACE_HOMES = ["local", "git", "hosted"] as const;
export type WorkspaceHome = (typeof WORKSPACE_HOMES)[number];

export interface WorkspaceSummary {
  readonly id: string;
  readonly label: string;
  readonly displayName?: string;
  readonly available: boolean;
  readonly home?: WorkspaceHome;
}

/**
 * A workspace the person can reach that has no folder on this machine yet. It cannot be opened
 * here: `command` is the one that brings it into a folder, or lists it (listing does not create
 * folders).
 */
export interface ReachableWorkspace {
  readonly id: string;
  readonly name: string;
  readonly home: WorkspaceHome;
  /** Where it lives, e.g. the host's origin. */
  readonly location: string;
  readonly command: string;
}

/** The reachable workspaces with no folder here, and a note for each place that could not be asked. */
export interface ReachableListing {
  readonly workspaces: readonly ReachableWorkspace[];
  readonly notes: readonly string[];
}

/**
 * Why a workspace's host was not asked: the resolver's own answer, never the host's. A local or Git
 * folder has no host operations; a hosted checkout answers some reads from its folder (they would
 * skip its unsent edits run on the host); and a missing session is the one sign-in link to relay.
 */
export type OperationsStop =
  | { readonly stop: "no_host_operations"; readonly home: Exclude<WorkspaceHome, "hosted"> }
  | { readonly stop: "folder_answers"; readonly operationId: string }
  | { readonly stop: "sign_in_required"; readonly signInUrl: string; readonly userCode: string };

/** Host-neutral workspace authority supplied by the CLI; implementations may know the catalog. */
export interface WorkspaceResolver<Context> {
  list(): Promise<readonly WorkspaceSummary[]>;
  /** Reachable workspaces with no folder here, when the host knows any; bounded and best effort. */
  reachable?(): Promise<ReachableListing>;
  open(selector: string): Promise<Context>;
  /**
   * The reads a workspace's host runs by id, as the host lists them (the hosted client's
   * `listOperations` for the workspace's bundle), or why the host was not asked.
   */
  listOperations?(selector: string): Promise<HostedOperationListingAnswer | OperationsStop>;
  /**
   * One read run by id on the workspace's host, the hosted client's `runOperation` answer passed
   * through unchanged (`input.bundleId` is the workspace's), or why the host was not asked.
   */
  runOperation?(selector: string, operationId: string, input: JsonObject): Promise<HostedOperationRun | OperationsStop>;
}
