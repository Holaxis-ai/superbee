import { realpath } from "node:fs/promises";
import { readDocVersioned, versionOfBytes, type Bundle } from "@superbee/core";
import { backendFor } from "@superbee/core/bundle-ops";
import {
  searchDocuments,
  searchSourceFromBackend,
  validateSearchRequest,
  SEARCH_MAX_OUTPUT_BYTES,
  SearchInputError,
  SearchLimitError,
} from "@superbee/core/search";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import {
  createBundlelessViewContext,
  createWorkspaceViewServices,
  type ViewAuthorizationStore,
  listViewCatalogPage,
  mayResumePageLaunch,
  mintActiveViewLaunch,
  mintTransientViewLaunch,
  resolvePageLaunchAuthorization,
  saveTransientView,
  parseDocumentSetFieldAction,
  type PageLaunch,
  type RegisteredPageLaunch,
} from "@superbee/view-runtime";
import { assertActorAcceptedByBundle, resolveActor } from "./actor.js";
import { folderIdentity } from "./folder-identity.js";
import {
  MAX_WORKSPACE_CATALOG_PAGE as catalogLimit,
  WORKSPACE_HOMES as workspaceHomes,
} from "@superbee/workspace-access";
import { assertWorkspaceProviderHost } from "./workspace-host.js";
import {
  createCatalogWorkspaceResolver,
  openPluginWorkspace,
} from "./workspace-resolver.js";
import type { PreparedViewEdit, ViewActionOutcome } from "./view-actions.js";

type Access = "none" | "bundle-read" | "bundle-propose";
export type ViewInput =
  | { viewId: string }
  | { title: string; html: string; access: Access };
export interface ActiveView {
  title: string;
  html: string;
  id: string;
  access: Access;
  contentVersion: string;
  contentType: string;
  registration?: { id: string; entry: string };
  authorized: boolean;
}
/** Transport only through the trusted host's receipt channel. This carries no approval. */
export interface RegisteredViewReceipt {
  readonly schemaVersion: "superbee.registered-view-receipt.v1";
  readonly workingCopy: string;
  readonly viewId: string;
  readonly title: string;
  readonly registryVersion: string;
  readonly contentVersion: string;
  readonly contentType: string;
  readonly access: "bundle-read" | "bundle-propose";
}
export interface ViewWorkspace {
  name: string;
  document(id: string): Promise<{
    id: string;
    version: string;
    frontmatter: Record<string, unknown>;
    html: string;
    bounded: boolean;
  }>;
  search(input: unknown): Promise<Record<string, unknown>>;
  listViews(afterId?: string): Promise<{
    entries: readonly {
      id: string;
      title: string;
      access: Access;
      description?: string;
      presentation?: string;
      timestamp?: string;
    }[];
    registeredTotal: number;
    excludedAccess: number;
    invalidRegistrations: number;
    pageUnavailableEntries: number;
    skippedDocuments: number;
    examined: number;
    truncated: boolean;
    nextAfterId?: string;
  }>;
  open(input: ViewInput): Promise<ActiveView>;
  captureRegisteredView(viewId: string): Promise<RegisteredViewReceipt>;
  reopenRegisteredView(receipt: RegisteredViewReceipt): Promise<ActiveView>;
  inspect(id: string): Promise<ActiveView | null>;
  approve(id: string): Promise<ActiveView>;
  resume(id: string): Promise<ActiveView>;
  close(id: string): void;
  request(
    id: string,
    message: unknown,
  ): Promise<{
    reply: Record<string, unknown> | null;
    subscribed?: boolean;
    openPageId?: string;
  }>;
  poll(
    id: string,
    generation?: string,
  ): Promise<{ status: string; generation?: string; message?: unknown }>;
  save(
    id: string,
    viewId: string,
    description?: string,
  ): Promise<{
    viewId: string;
    entry: string;
    title: string;
    access: Access;
    sourceVersion: string;
    entryVersion: string;
    registryVersion: string;
    entryCreated: boolean;
    registryCreated: boolean;
  }>;
  prepare(
    id: string,
    action: unknown,
  ): Promise<PreparedViewEdit | ViewActionOutcome>;
  finish(
    id: string,
    token: string,
    decision: "commit" | "cancel",
  ): Promise<ViewActionOutcome>;
}

/** A trusted local presentation host owns the user interface. Each instance pins one working copy. */
export async function openViewWorkspace(
  source: "catalog" | "directory",
  selector: string,
  options: { actor?: string } = {},
): Promise<ViewWorkspace> {
  const actor = resolveActor(options.actor);
  return bindViewWorkspace(await openPluginWorkspace(source, selector), actor);
}

type WorkspaceContext = {
  bundle: Bundle;
  name: string;
  viewAuthorization?: ViewAuthorizationStore;
};

async function bindViewWorkspace(
  context: WorkspaceContext,
  actor: string | undefined,
): Promise<ViewWorkspace> {
  await assertActorAcceptedByBundle(context.bundle, actor);
  return createViewWorkspace(context, actor);
}

async function currentWorkingCopy(root: string): Promise<string | null> {
  try {
    const canonicalRoot = await realpath(root);
    const identity = await folderIdentity(canonicalRoot);
    return identity &&
      versionOfBytes(JSON.stringify([canonicalRoot, identity.dev, identity.ino, identity.birth ?? null]));
  } catch {
    return null;
  }
}

function registeredHandoffChanged(): Error {
  return new Error("The working copy or registered View changed. Reopen the View to inspect its current source and access.");
}

function registeredReceipt(launch: RegisteredPageLaunch, workingCopy: string): RegisteredViewReceipt {
  if (launch.capability === "none") {
    throw new Error("The registered View must declare bundle-read or bundle-propose access.");
  }
  return {
    schemaVersion: "superbee.registered-view-receipt.v1",
    workingCopy,
    viewId: launch.registryId,
    title: launch.registryTitle,
    registryVersion: launch.registryVersion,
    contentVersion: launch.contentVersion,
    contentType: launch.contentType,
    access: launch.capability,
  };
}

function createViewWorkspace(
  { bundle, name, viewAuthorization }: WorkspaceContext,
  actor?: string,
): ViewWorkspace {
  const {
    launches,
    durableAuthorizations: registeredAuthorizations,
    transientAuthorizations: transient,
    actions,
    bridge,
  } = createWorkspaceViewServices({
    bundle,
    name,
    authorizations: viewAuthorization,
    actor,
    renderDocument: renderDocumentToStaticHtml,
  });
  // A workspace that has accepted a handoff stays on that working copy for subsequent View
  // navigation and resume. Its existing, path-backed provider owns all access and confirmation.
  let handoffWorkingCopy: string | undefined;
  const stillWorkingCopy = (expected: string) =>
    async () => await currentWorkingCopy(bundle.root) === expected;
  async function describe(
    launch: PageLaunch,
    approve = false,
  ): Promise<ActiveView> {
    const registered = launch.sourceKind === "registered";
    const status = await resolvePageLaunchAuthorization(
      bundle,
      launches,
      launch.launchId,
      registered ? registeredAuthorizations : transient,
      approve,
    );
    if (!status || (approve && !status.authorized))
      throw new Error("The active View changed or expired before approval.");
    return {
      title: registered ? launch.registryTitle : launch.title,
      html: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        launch.bytes,
      ),
      contentVersion: launch.contentVersion,
      contentType: launch.contentType,
      id: launch.launchId,
      access: launch.capability,
      authorized: status.authorized,
      ...(registered
        ? { registration: { id: launch.registryId, entry: launch.entryKey } }
        : {}),
    };
  }
  async function open(input: ViewInput): Promise<ActiveView> {
    if ("viewId" in input) {
      const launch = await mintActiveViewLaunch(
        bundle, launches, input.viewId,
        handoffWorkingCopy === undefined ? undefined : stillWorkingCopy(handoffWorkingCopy),
      );
      if (launch.capability === "none") {
        bridge.revoke(launch.launchId);
        throw new Error(
          "The registered View must declare bundle-read or bundle-propose access.",
        );
      }
      return describe(launch);
    }
    const { title, html, access } = input;
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 120 ||
      typeof html !== "string" ||
      !html.length ||
      !["none", "bundle-read", "bundle-propose"].includes(access)
    )
      throw new TypeError("Invalid temporary View");
    return describe(
      mintTransientViewLaunch(bundle, launches, {
        title: title.trim(),
        html,
        capability: access,
      }),
    );
  }
  async function inspect(id: string): Promise<ActiveView | null> {
    const launch = launches.resolveLaunch(id);
    return launch ? describe(launch) : null;
  }
  return {
    name,
    open,
    inspect,
    async captureRegisteredView(viewId) {
      const workingCopy = await currentWorkingCopy(bundle.root);
      if (!workingCopy || (handoffWorkingCopy !== undefined && handoffWorkingCopy !== workingCopy))
        throw registeredHandoffChanged();
      const launch = await mintActiveViewLaunch(bundle, launches, viewId, stillWorkingCopy(workingCopy));
      try {
        return registeredReceipt(launch, workingCopy);
      } finally {
        bridge.revoke(launch.launchId);
      }
    },
    async reopenRegisteredView(receipt) {
      if (receipt.schemaVersion !== "superbee.registered-view-receipt.v1" ||
          (handoffWorkingCopy !== undefined && handoffWorkingCopy !== receipt.workingCopy))
        throw registeredHandoffChanged();
      const launch = await mintActiveViewLaunch(bundle, launches, receipt.viewId, stillWorkingCopy(receipt.workingCopy));
      try {
        const current = registeredReceipt(launch, receipt.workingCopy);
        if (current.viewId !== receipt.viewId ||
            current.registryVersion !== receipt.registryVersion ||
            current.contentVersion !== receipt.contentVersion ||
            current.contentType !== receipt.contentType ||
            current.access !== receipt.access ||
            current.title !== receipt.title) throw registeredHandoffChanged();
        const view = await describe(launch);
        if (handoffWorkingCopy !== undefined && handoffWorkingCopy !== receipt.workingCopy)
          throw registeredHandoffChanged();
        handoffWorkingCopy = current.workingCopy;
        return view;
      } catch (error) {
        bridge.revoke(launch.launchId);
        throw error;
      }
    },
    async document(id) {
      const { doc, version } = await readDocVersioned(bundle, id);
      return {
        id: doc.id,
        version,
        frontmatter: doc.frontmatter,
        ...renderDocumentToStaticHtml(doc),
      };
    },
    async search(input) {
      try {
        const request = validateSearchRequest(input);
        const documents = await searchSourceFromBackend(backendFor(bundle));
        const result = await searchDocuments(
          documents,
          request,
          { scope: versionOfBytes(bundle.root) },
          undefined,
          { maxResultBytes: SEARCH_MAX_OUTPUT_BYTES },
        );
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > SEARCH_MAX_OUTPUT_BYTES)
          throw new SearchLimitError(
            "maxResultBytes",
            SEARCH_MAX_OUTPUT_BYTES,
            bytes,
          );
        return { ...result };
      } catch (error) {
        if (
          error instanceof SearchInputError ||
          error instanceof SearchLimitError
        )
          throw error;
        throw new Error(
          "Could not search the selected local corpus. Check that its documents are readable and retry.",
        );
      }
    },
    listViews: (afterId) =>
      listViewCatalogPage(bundle, {
        afterId,
        limit: 20,
        scanLimit: 40,
        access: ["bundle-read", "bundle-propose"],
      }),
    async approve(id) {
      const launch = launches.resolveLaunch(id);
      if (!launch || launch.capability === "none")
        throw new Error("The active View changed or expired before approval.");
      return describe(launch, true);
    },
    async resume(id) {
      const old = launches.resolveLaunch(id);
      const store =
        old?.sourceKind === "transient" ? transient : registeredAuthorizations;
      if (!old || !(await mayResumePageLaunch(launches, old, store))) {
        throw new Error(
          "The suspended View is unknown, expired or no longer authorized.",
        );
      }
      const fresh = await open(
        old.sourceKind === "registered"
          ? { viewId: old.registryId }
          : {
              title: old.title,
              html: new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: true,
              }).decode(old.bytes),
              access: old.capability,
            },
      );
      try {
        if (!(await mayResumePageLaunch(launches, old, store))) {
          throw new Error("The suspended View changed while resuming.");
        }
        return fresh;
      } catch (error) {
        bridge.revoke(fresh.id);
        throw error;
      }
    },
    close: (id) => bridge.revoke(id),
    request: (id, message) => bridge.handle(id, message),
    poll: (id, generation) => bridge.poll(id, generation),
    save: (launchId, viewId, description) =>
      saveTransientView(
        bundle,
        launches,
        transient,
        { launchId, viewId, description },
        { actor },
      ),
    async prepare(id, action) {
      let parsed;
      try {
        parsed = parseDocumentSetFieldAction(action);
      } catch {
        return {
          status: "rejected",
          action: "document.set-field",
          message: "this host accepts scalar View actions only",
        };
      }
      return actions.prepare(id, parsed);
    },
    async finish(id, token, decision) {
      if (typeof id !== "string" || !launches.resolveLaunch(id))
        return {
          status: "rejected",
          action: "document.set-field",
          message: "the View is unknown or expired",
        };
      if (decision === "cancel") return actions.cancel(token, id);
      if (decision === "commit") return actions.commit(token, id);
      throw new TypeError("The decision must be commit or cancel");
    },
  };
}

// Closed public signatures keep installed plugins independent of private workspace packages.
export const MAX_WORKSPACE_CATALOG_PAGE: number = catalogLimit;
export const WORKSPACE_HOMES: readonly ["local", "git", "hosted"] =
  workspaceHomes;
export type WorkspaceHome = (typeof WORKSPACE_HOMES)[number];
export interface WorkspaceSummary {
  readonly id: string;
  readonly label: string;
  readonly displayName?: string;
  readonly available: boolean;
  readonly home?: WorkspaceHome;
}
export interface ReachableWorkspace {
  readonly id: string;
  readonly name: string;
  readonly home: WorkspaceHome;
  readonly location: string;
  readonly command: string;
}
export type OperationsStop =
  | { readonly stop: "no_host_operations"; readonly home: "local" | "git" }
  | { readonly stop: "folder_answers"; readonly operationId: string }
  | {
      readonly stop: "sign_in_required";
      readonly signInUrl: string;
      readonly userCode: string;
    };

type JsonObject = Readonly<Record<string, unknown>>;
interface HostedOperation {
  readonly operationId: string;
  readonly title: string;
  readonly description: string;
  readonly maximumOutputBytes: number;
  readonly inputJsonSchema: JsonObject;
  readonly resultJsonSchema: JsonObject;
  readonly annotations: Readonly<Record<string, boolean>>;
}
type RefusedOperation = {
  readonly ok: false;
  readonly refusal: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
};
export interface ViewWorkspaceCatalog {
  list(): Promise<readonly WorkspaceSummary[]>;
  reachable(): Promise<{
    readonly workspaces: readonly ReachableWorkspace[];
    readonly notes: readonly string[];
  }>;
  open(selector: string): Promise<ViewWorkspace>;
  listOperations(
    selector: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly listing: {
          readonly operations: readonly HostedOperation[];
          readonly notes: readonly string[];
        };
      }
    | RefusedOperation
    | OperationsStop
  >;
  runOperation(
    selector: string,
    operationId: string,
    input: JsonObject,
  ): Promise<
    | { readonly ok: true; readonly data: unknown }
    | RefusedOperation
    | OperationsStop
  >;
}

/** The CLI owns catalog selection, checkout identity and hosted sessions. */
export function createViewWorkspaceCatalog(
  options: { actor?: string } = {},
): ViewWorkspaceCatalog {
  assertWorkspaceProviderHost();
  const actor = resolveActor(options.actor);
  const { list, reachable, open, listOperations, runOperation } =
    createCatalogWorkspaceResolver({ actor });
  return {
    list,
    reachable,
    listOperations,
    runOperation,
    async open(selector) {
      return bindViewWorkspace(await open(selector), actor);
    },
  };
}

export interface BundlelessViewHost extends Pick<
  ViewWorkspace,
  "inspect" | "resume" | "close" | "request" | "poll"
> {
  open(input: {
    title: string;
    html: string;
    access: "none";
  }): Promise<ActiveView>;
}

/** Present ephemeral HTML without selecting a catalog entry or consulting a workspace. */
export function createBundlelessViewHost(): BundlelessViewHost {
  const host = createViewWorkspace(createBundlelessViewContext());
  return {
    async open(input) {
      if (!input || "viewId" in input || input.access !== "none") {
        throw new TypeError(
          "A workspace-free View requires temporary HTML with access none.",
        );
      }
      return host.open({
        title: input.title,
        html: input.html,
        access: "none",
      });
    },
    inspect: host.inspect,
    resume: host.resume,
    close: host.close,
    request: host.request,
    poll: host.poll,
  };
}
