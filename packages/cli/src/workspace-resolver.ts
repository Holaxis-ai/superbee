import type { Bundle } from "@superbee/core";
import { homedir } from "node:os";

import { assertSupportedCliHost } from "./posix-host.js";
import { captureRuntimeCallback } from "./runtime-context.js";
import {
  MAX_WORKSPACE_CATALOG_PAGE,
  type ReachableListing as WorkspaceReachableListing,
  type OperationsStop,
  type WorkspaceResolver,
} from "@superbee/workspace-access";
import { namesOtherBundle, type HostedOperationListingAnswer, type HostedOperationRun, type JsonObject } from "@superbee/core/hosted-transport";

import { openBundle, resolveLocalBundleTarget, samePhysicalPath } from "./bundle.js";
import { deriveBundleDisplayName } from "./bundle-name.js";
import {
  listCatalogEntries,
  resolveCatalogEntry,
  type CatalogEntryView,
} from "./catalog.js";
import { LocalViewAuthorizationStore } from "./ui/view-authorizations.js";
import { servedBundle } from "./hosted/served-bundle.js";
import { reachableHostedBundles, type ReachableListing } from "./hosted/reachable.js";
import { bundleHomeAt } from "./bundle-home.js";
import { commandFragment, commandToken } from "./command-text.js";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import type { HostedAccountDeps } from "./hosted/account.js";
import type { CheckoutBinding } from "./hosted/binding.js";
import { openCheckoutConnection, type CheckoutConnection } from "./hosted/checkout-connection.js";
import { isFolderAnswered } from "./hosted/folder-answered.js";
import { bindingHostArgument } from "./hosted/marker.js";

/** Hosted discovery time budget and lifetime of a cached answer. */
export const WORKSPACE_HOSTED_BUDGET_MS = 1_500;
export const WORKSPACE_HOSTED_CACHE_MS = 60_000;

export interface CatalogWorkspaceResolverOptions {
  actor?: string;
  home?: string;
  listEntries?: (home?: string) => Promise<CatalogEntryView[]>;
  resolveEntry?: (selector: string, home?: string) => Promise<CatalogEntryView>;
  open?: typeof openBundle;
  resolveTarget?: typeof resolveLocalBundleTarget;
  deriveName?: typeof deriveBundleDisplayName;
  /** The reachable hosted bundles (default: {@link reachableHostedBundles} within {@link WORKSPACE_HOSTED_BUDGET_MS}). */
  reachable?: () => Promise<ReachableListing | null>;
  now?: () => number;
  /** The person and fetch a hosted checkout's operations are reached with (default: this home's session). */
  hosted?: HostedAccountDeps;
}

/** Adapt the private CLI catalog to the shared workspace boundary. */
export function createCatalogWorkspaceResolver(
  options: CatalogWorkspaceResolverOptions = {},
): WorkspaceResolver<Awaited<ReturnType<typeof serveWorkspace>>> {
  const listEntries = options.listEntries ?? listCatalogEntries;
  const resolveEntry = options.resolveEntry ?? resolveCatalogEntry;
  const open = options.open ?? openBundle;
  const resolveTarget = options.resolveTarget ?? resolveLocalBundleTarget;
  const deriveName = options.deriveName ?? deriveBundleDisplayName;
  const reachable = options.reachable ?? (() => reachableHostedBundles({ budgetMs: WORKSPACE_HOSTED_BUDGET_MS, ...(options.home !== undefined ? { home: options.home } : {}) }));
  const now = options.now ?? Date.now;
  // The private state bindings and sessions are read from: one home, as `op` derives it.
  const home = options.hosted?.auth?.home ?? options.home ?? homedir();

  /**
   * The catalog entry a selector names and its canonical root, refused when the two disagree.
   * `during` runs between the two (opening the bundle), so a retarget while it runs is caught.
   */
  const select = async <T>(selector: string, during: (folder: string) => Promise<T>) => {
    const entry = await resolveEntry(selector, options.home);
    const value = await during(entry.locator.path);
    const target = await resolveTarget(entry.locator.path);
    if (!samePhysicalPath(target.canonicalRoot, entry.locator.path)) {
      throw new Error("workspace catalog target changed during selection");
    }
    return { entry, target, value };
  };

  /**
   * The checkout a workspace is, decided on this machine with no request: its binding read fresh
   * (never from the catalog). A local or Git folder stops here.
   */
  const checkoutOf = async (selector: string): Promise<CheckoutBinding | OperationsStop> => {
    const { target } = await select(selector, async () => undefined);
    const facts = await bundleHomeAt(target.canonicalRoot, { home });
    return facts.home === "hosted" ? facts.binding : { stop: "no_host_operations", home: facts.home };
  };

  /**
   * The one checkout connection `op` uses, as the checkout's own person. A missing session stops
   * with the one sign-in link, never a prompt; its resume names the host only, never the folder.
   */
  const connect = async (binding: CheckoutBinding): Promise<CheckoutConnection | OperationsStop> => {
    const resume = commandFragment`${cliInvocation()} login --host ${commandToken(bindingHostArgument(binding))}`;
    try {
      return await openCheckoutConnection(binding, options.hosted, resume, home);
    } catch (error) {
      const details = error instanceof CliError && error.code === "AUTH_REQUIRED" ? (error.details as { sign_in_url?: unknown; user_code?: unknown } | undefined) : undefined;
      if (typeof details?.sign_in_url === "string" && typeof details.user_code === "string") {
        return { stop: "sign_in_required", signInUrl: details.sign_in_url, userCode: details.user_code };
      }
      throw error;
    }
  };
  // One answer per minute per process, in memory only.
  let cached: { at: number; value: Promise<WorkspaceReachableListing> } | undefined;

  return {
    reachable: captureRuntimeCallback(async () => {
      if (!cached || now() - cached.at >= WORKSPACE_HOSTED_CACHE_MS) {
        cached = {
          at: now(),
          value: reachable().then(
            (listing): WorkspaceReachableListing => ({
              workspaces: (listing?.hosts ?? []).flatMap((host) =>
                host.bundles.map((bundle) => ({ id: bundle.reference, name: bundle.name || bundle.reference, home: "hosted" as const, location: host.host, command: bundle.checkout ?? host.ask })),
              ),
              notes: listing?.notes ?? [],
            }),
            () => ({ workspaces: [], notes: [] }),
          ),
        };
      }
      return cached.value;
    }),
    list: captureRuntimeCallback(async () => {
      const entries = await listEntries(options.home);
      return Promise.all(entries.map(async (entry, index) => {
        if (!entry.available) {
          return {
            id: entry.id,
            label: entry.label,
            available: false,
          };
        }
        if (index >= MAX_WORKSPACE_CATALOG_PAGE) {
          return {
            id: entry.id,
            label: entry.label,
            available: true,
            home: entry.home,
          };
        }
        try {
          const bundle = await open(entry.locator.path);
          const displayName = (await deriveName(bundle)).name;
          return {
            id: entry.id,
            label: entry.label,
            displayName,
            available: true,
            home: entry.home,
          };
        } catch {
          // Availability is advisory in list output. Selection re-resolves and revalidates the
          // exact catalog entry, so a bundle that drifts during listing fails closed on open.
          return {
            id: entry.id,
            label: entry.label,
            available: false,
          };
        }
      }));
    }),
    open: captureRuntimeCallback(async (selector) => {
      const { entry, value: bundle } = await select(selector, open);
      if (!samePhysicalPath(bundle.root, entry.locator.path)) {
        throw new Error("workspace catalog target changed during selection");
      }
      return serveWorkspace(bundle, options.actor, options.home, deriveName);
    }),
    listOperations: captureRuntimeCallback(async (selector: string): Promise<HostedOperationListingAnswer | OperationsStop> => {
      const binding = await checkoutOf(selector);
      if ("stop" in binding) return binding;
      const connection = await connect(binding);
      if ("stop" in connection) return connection;
      const answer = await connection.client.listOperations(binding.bundle_id);
      if (!answer.ok) return answer;
      const kept = answer.listing.operations.filter((operation) => !isFolderAnswered(operation.operationId));
      const skipped = answer.listing.operations.filter((operation) => isFolderAnswered(operation.operationId));
      return {
        ok: true,
        listing: {
          operations: kept,
          notes: [
            ...answer.listing.notes,
            ...skipped.map((operation) => `${operation.operationId} is not listed: the folder answers it, which sees unsent edits`),
          ],
        },
      };
    }),
    runOperation: captureRuntimeCallback(async (selector: string, operationId: string, input: JsonObject): Promise<HostedOperationRun | OperationsStop> => {
      const binding = await checkoutOf(selector);
      if ("stop" in binding) return binding;
      // Decided here before any request, as `op run` decides them.
      if (isFolderAnswered(operationId)) return { stop: "folder_answers", operationId };
      if (namesOtherBundle(input, binding.bundle_id)) {
        return { ok: false, refusal: { code: "invalid_input", message: "the input names another bundle than this workspace's: leave bundleId out", retryable: false } };
      }
      const connection = await connect(binding);
      if ("stop" in connection) return connection;
      return connection.client.runOperation(binding.bundle_id, operationId, input);
    }),
  };
}

/** Keep checkout policy, folder naming and local View approvals together for both open modes. */
export async function serveWorkspace(
  opened: Bundle,
  actor?: string,
  home?: string,
  deriveName = deriveBundleDisplayName,
) {
  const bundle = await servedBundle(opened, { home });
  const { name } = await deriveName(opened);
  return Object.freeze({
    bundle,
    name,
    ...(actor !== undefined ? { actor } : {}),
    viewAuthorization: new LocalViewAuthorizationStore(opened.root, home),
  });
}

export async function openPluginWorkspace(source: "catalog" | "directory", selector: string) {
  assertSupportedCliHost();
  if (source !== "catalog" && source !== "directory") {
    throw new TypeError("workspace source must be catalog or directory");
  }
  if (typeof selector !== "string" || !selector.trim()) {
    throw new TypeError("a workspace selector is required");
  }
  return source === "catalog"
    ? await createCatalogWorkspaceResolver().open(selector)
    : await serveWorkspace(await openBundle(selector));
}
