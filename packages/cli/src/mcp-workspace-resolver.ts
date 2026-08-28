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
    list: async () => {
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
    },
    open: async (selector) => {
      const entry = await resolveEntry(selector, options.home);
      const bundle = await open(entry.locator.path);
      const target = await resolveTarget(entry.locator.path);
      if (
        !samePhysicalPath(bundle.root, entry.locator.path) ||
        !samePhysicalPath(target.canonicalRoot, entry.locator.path)
      ) {
        throw new Error("workspace catalog target changed during selection");
      }
      const bundleName = (await deriveName(bundle)).name;
      return createMcpBundleContext({
        bundle,
        bundleName,
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        viewAuthorization: new LocalViewAuthorizationStore(bundle.root),
      });
    },
  };
}
