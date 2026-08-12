// CLI-owned adapter for the reusable loopback UI runtime. Generated asset bytes and bundle-name
// policy stay in this package; the listener/session/proxy/View/SSE mechanics live below it.
import {
  bootUiServer as bootUiServerRuntime,
  escapeHtml,
  pageError,
  type UiServerHandle,
  type UiServerOptions as RuntimeUiServerOptions,
} from "@superbee/ui-server";
import type { Bundle } from "@superbee/core";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { serveEmbeddedUiAsset } from "./assets.js";
import { createSharingLoader, createWorkspacesLoader } from "./sharing.js";
import { LocalViewAuthorizationStore } from "./view-authorizations.js";

export { escapeHtml, pageError };
export type { UiServerHandle };

type InjectedUiServerOption =
  | "serveAsset"
  | "resolveBundleDisplayName"
  | "loadSharingSummary"
  | "loadWorkspaces"
  | "renderDocument";
type WithoutInjectedOptions<T> = T extends unknown ? Omit<T, InjectedUiServerOption> : never;
export type UiServerOptions = WithoutInjectedOptions<RuntimeUiServerOptions>;

export function bootUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  // Dir mode injects the CLI's board-channel classification + catalog projection through the
  // runtime's consumer-owned seams (remote mode derives `hosted` in the runtime itself).
  if (options.mode === "dir") {
    return bootUiServerRuntime({
      ...options,
      viewAuthorization: new LocalViewAuthorizationStore(options.bundle.root),
      renderDocument: renderDocumentToStaticHtml,
      serveAsset: serveEmbeddedUiAsset,
      resolveBundleDisplayName: async (bundle: Bundle) => (await deriveBundleDisplayName(bundle)).name,
      loadSharingSummary: createSharingLoader(options.bundle.root),
      loadWorkspaces: createWorkspacesLoader(options.bundle.root),
    });
  }
  return bootUiServerRuntime({
    ...options,
    viewAuthorization: new LocalViewAuthorizationStore(options.remoteBase),
    renderDocument: renderDocumentToStaticHtml,
    serveAsset: serveEmbeddedUiAsset,
  });
}
