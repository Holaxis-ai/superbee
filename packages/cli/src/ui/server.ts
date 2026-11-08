import { captureRuntimeCallback } from "../runtime-context.js";
// CLI-owned adapter for the reusable loopback UI runtime. Generated asset bytes and bundle-name
// policy stay in this package; the listener/session/View/SSE mechanics live below it.
import {
  bootUiServer as bootUiServerRuntime,
  type UiServerHandle,
  type UiServerOptions as RuntimeUiServerOptions,
} from "@superbee/ui-server";
import type { Bundle } from "@superbee/core";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { serveEmbeddedUiAsset } from "./assets.js";
import { createSharingLoader, createWorkspacesLoader } from "./sharing.js";
import { LocalViewAuthorizationStore } from "./view-authorizations.js";

export type { UiServerHandle };

type InjectedUiServerOption =
  | "serveAsset"
  | "resolveBundleDisplayName"
  | "loadSharingSummary"
  | "loadWorkspaces"
  | "renderDocument";
export type UiServerOptions = Omit<RuntimeUiServerOptions, InjectedUiServerOption>;

export function bootUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  // Inject the CLI's board-channel classification and catalog projection through the runtime's
  // consumer-owned seams.
  return bootUiServerRuntime({
    ...options,
    viewAuthorization: new LocalViewAuthorizationStore(options.bundle.root),
    renderDocument: renderDocumentToStaticHtml,
    serveAsset: serveEmbeddedUiAsset,
    resolveBundleDisplayName: captureRuntimeCallback(async (bundle: Bundle) => (await deriveBundleDisplayName(bundle)).name),
    loadSharingSummary: createSharingLoader(options.bundle.root),
    loadWorkspaces: createWorkspacesLoader(options.bundle.root),
  });
}
