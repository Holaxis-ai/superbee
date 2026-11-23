import { readDocVersioned, versionOfBytes } from "@superbee/core";
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
  createWorkspaceViewServices,
  listViewCatalogPage,
  mintActiveViewLaunch,
  mintTransientViewLaunch,
  resolvePageLaunchAuthorization,
  saveTransientView,
  parseDocumentSetFieldAction,
  type PageLaunch,
} from "@superbee/view-runtime";
import { assertActorAcceptedByBundle, resolveActor } from "./actor.js";
import { openPluginWorkspace } from "./workspace-resolver.js";
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
export interface ViewWorkspace {
  name: string;
  document(
    id: string,
  ): Promise<{
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
  const { bundle, name, viewAuthorization } = await openPluginWorkspace(
    source,
    selector,
  );
  await assertActorAcceptedByBundle(bundle, actor);
  const {
    launches,
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
  async function describe(
    launch: PageLaunch,
    approve = false,
  ): Promise<ActiveView> {
    const registered = launch.sourceKind === "registered";
    const status = await resolvePageLaunchAuthorization(
      bundle,
      launches,
      launch.launchId,
      registered ? viewAuthorization : transient,
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
      const launch = await mintActiveViewLaunch(bundle, launches, input.viewId);
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
      const old = await inspect(id);
      if (!old?.authorized)
        throw new Error(
          "The suspended View is unknown, expired or no longer authorized.",
        );
      const fresh = await open(
        old.registration ? { viewId: old.registration.id } : old,
      );
      try {
        if (!(await inspect(id))?.authorized)
          throw new Error("The suspended View changed while resuming.");
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
