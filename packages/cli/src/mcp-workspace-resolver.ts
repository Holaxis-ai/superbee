import { homedir } from "node:os";

import { captureRuntimeCallback } from "./runtime-context.js";
import {
  MAX_WORKSPACE_CATALOG_PAGE,
  createMcpBundleContext,
  type McpOperationsStop,
  type McpWorkspaceResolver,
} from "@superbee/mcp-app";
import type { HostedOperationListingAnswer, HostedOperationRun, JsonObject } from "@superbee/core/hosted-transport";

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
import type { McpReachableListing } from "@superbee/mcp-app";
import { bundleHomeAt } from "./bundle-home.js";
import { commandFragment, commandToken } from "./command-text.js";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";
import type { HostedAccountDeps } from "./hosted/account.js";
import type { CheckoutBinding } from "./hosted/binding.js";
import { openCheckoutConnection, type CheckoutConnection } from "./hosted/checkout-connection.js";
import { isFolderAnswered } from "./hosted/folder-answered.js";
import { bindingHostArgument } from "./hosted/marker.js";

/** How long `list_workspaces` waits for the hosted bundles, and how long an answer is reused. */
export const MCP_HOSTED_BUDGET_MS = 1_500;
export const MCP_HOSTED_CACHE_MS = 60_000;

export interface CatalogMcpWorkspaceResolverOptions {
  actor?: string;
  home?: string;
  listEntries?: (home?: string) => Promise<CatalogEntryView[]>;
  resolveEntry?: (selector: string, home?: string) => Promise<CatalogEntryView>;
  open?: typeof openBundle;
  resolveTarget?: typeof resolveLocalBundleTarget;
  deriveName?: typeof deriveBundleDisplayName;
  /** The reachable hosted bundles (default: {@link reachableHostedBundles} within {@link MCP_HOSTED_BUDGET_MS}). */
  reachable?: () => Promise<ReachableListing | null>;
  now?: () => number;
  /** The person and fetch a hosted checkout's operations are reached with (default: this home's session). */
  hosted?: HostedAccountDeps;
}

/** Adapt the private CLI catalog to the host-neutral MCP workspace boundary. */
export function createCatalogMcpWorkspaceResolver(
  options: CatalogMcpWorkspaceResolverOptions = {},
): McpWorkspaceResolver {
  const listEntries = options.listEntries ?? listCatalogEntries;
  const resolveEntry = options.resolveEntry ?? resolveCatalogEntry;
  const open = options.open ?? openBundle;
  const resolveTarget = options.resolveTarget ?? resolveLocalBundleTarget;
  const deriveName = options.deriveName ?? deriveBundleDisplayName;
  const reachable = options.reachable ?? (() => reachableHostedBundles({ budgetMs: MCP_HOSTED_BUDGET_MS, ...(options.home !== undefined ? { home: options.home } : {}) }));
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();

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
   * A workspace's host, as the checkout's own person: its binding read fresh (never from the
   * catalog), then the one checkout connection `op` uses. A local or Git folder stops here; a
   * missing session stops with the one sign-in link, never a prompt. The sign-in's resume names
   * the host only, never the folder.
   */
  const hostOf = async (selector: string): Promise<{ binding: CheckoutBinding; connection: CheckoutConnection } | McpOperationsStop> => {
    const { target } = await select(selector, async () => undefined);
    const facts = await bundleHomeAt(target.canonicalRoot, { home });
    if (facts.home !== "hosted") return { stop: "no_host_operations", home: facts.home };
    const resume = commandFragment`${cliInvocation()} login --host ${commandToken(bindingHostArgument(facts.binding))}`;
    try {
      const connection = await openCheckoutConnection(facts.binding, options.hosted, resume, home);
      return { binding: facts.binding, connection };
    } catch (error) {
      const details = error instanceof CliError && error.code === "AUTH_REQUIRED" ? (error.details as { sign_in_url?: unknown; user_code?: unknown } | undefined) : undefined;
      if (typeof details?.sign_in_url === "string" && typeof details.user_code === "string") {
        return { stop: "sign_in_required", signInUrl: details.sign_in_url, userCode: details.user_code };
      }
      throw error;
    }
  };
  // One answer per minute per process, in memory only.
  let cached: { at: number; value: Promise<McpReachableListing> } | undefined;

  return {
    reachable: captureRuntimeCallback(async () => {
      if (!cached || now() - cached.at >= MCP_HOSTED_CACHE_MS) {
        cached = {
          at: now(),
          value: reachable().then(
            (listing): McpReachableListing => ({
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
      // A hosted checkout is served through its folder, with the guard that refuses up front what
      // sync cannot send (hosted/served-bundle.ts). Its binding is read fresh, never taken from the catalog.
      const served = await servedBundle(bundle, options.home !== undefined ? { home: options.home } : {});
      // Named from the folder as opened, so naming it never waits on an automatic pull.
      const bundleName = (await deriveName(bundle)).name;
      return createMcpBundleContext({
        bundle: served,
        bundleName,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        viewAuthorization: new LocalViewAuthorizationStore(bundle.root, options.home),
      });
    }),
    listOperations: captureRuntimeCallback(async (selector: string): Promise<HostedOperationListingAnswer | McpOperationsStop> => {
      const host = await hostOf(selector);
      if ("stop" in host) return host;
      const answer = await host.connection.client.listOperations(host.binding.bundle_id);
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
    runOperation: captureRuntimeCallback(async (selector: string, operationId: string, input: JsonObject): Promise<HostedOperationRun | McpOperationsStop> => {
      const host = await hostOf(selector);
      if ("stop" in host) return host;
      if (isFolderAnswered(operationId)) return { stop: "folder_answers", operationId };
      // The route's own refusal wording, before any request: the input names another bundle.
      if (input.bundleId !== undefined && input.bundleId !== host.binding.bundle_id) {
        return { ok: false, refusal: { code: "invalid_input", message: "the input names another bundle than this workspace's: leave bundleId out", retryable: false } };
      }
      return host.connection.client.runOperation(host.binding.bundle_id, operationId, input);
    }),
  };
}
