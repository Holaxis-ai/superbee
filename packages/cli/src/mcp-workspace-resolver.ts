import { captureRuntimeCallback } from "./runtime-context.js";
import {
  MAX_WORKSPACE_CATALOG_PAGE,
  createMcpBundleContext,
  type McpWorkspaceResolver,
} from "@superbee/mcp-app";

import { openBundle, resolveLocalBundleTarget, samePhysicalPath } from "./bundle.js";
import { deriveBundleDisplayName } from "./bundle-name.js";
import {
  listCatalogEntries,
  resolveCatalogEntry,
  type CatalogEntryView,
} from "./catalog.js";
import { LocalViewAuthorizationStore } from "./ui/view-authorizations.js";
import { servedBundle } from "./hosted/served-bundle.js";

export interface CatalogMcpWorkspaceResolverOptions {
  actor?: string;
  home?: string;
  listEntries?: (home?: string) => Promise<CatalogEntryView[]>;
  resolveEntry?: (selector: string, home?: string) => Promise<CatalogEntryView>;
  open?: typeof openBundle;
  resolveTarget?: typeof resolveLocalBundleTarget;
  deriveName?: typeof deriveBundleDisplayName;
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

  return {
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
      const entry = await resolveEntry(selector, options.home);
      const bundle = await open(entry.locator.path);
      const target = await resolveTarget(entry.locator.path);
      if (
        !samePhysicalPath(bundle.root, entry.locator.path) ||
        !samePhysicalPath(target.canonicalRoot, entry.locator.path)
      ) {
        throw new Error("workspace catalog target changed during selection");
      }
      // A hosted checkout is served through its folder, with the guard that refuses up front what
      // sync cannot send (hosted/served-bundle.ts). Its binding is read fresh, never taken from the catalog.
      const served = await servedBundle(bundle, options.home !== undefined ? { home: options.home } : {});
      const bundleName = (await deriveName(served)).name;
      return createMcpBundleContext({
        bundle: served,
        bundleName,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        viewAuthorization: new LocalViewAuthorizationStore(bundle.root, options.home),
      });
    }),
  };
}
