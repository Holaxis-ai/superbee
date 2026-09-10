/** Node-specific compatibility adapter for the historical single-backend package root. */

import {
  FilesystemBackend,
  MemoryBackend,
  type Bundle,
  type StorageBackend,
  type StorageCapabilities,
} from "@superbee/core";

import { MemoryOperationOutcomeStore, type OperationOutcomeStore } from "./operation-outcomes.js";
import {
  createRouter as createWorkerRouter,
  type TrustedAttribution,
} from "./router.js";

const LEGACY_INTERNAL_BUNDLE_ID = "bnd_00000000000000000000000000000000";

export interface LegacyRouterOptions {
  /**
   * The store behind identified document writes. Omitted, the reference router gets a fresh
   * in-memory store so identity works out of the box; `null` builds a router without one, which
   * refuses identity and reports `operations: false`.
   */
  outcomes?: OperationOutcomeStore | null;
}

function capabilitiesForBackend(backend: StorageBackend): StorageCapabilities {
  return (
    backend.capabilities?.() ?? {
      enforced_cas: backend instanceof MemoryBackend,
      blobs: true,
      projections: true,
      backlinks: false,
    }
  );
}

function legacyAttribution(request: Request): TrustedAttribution {
  const actor = request.headers.get("X-Actor")?.trim();
  const agent = request.headers.get("X-Agent")?.trim();
  return {
    actor: actor || "unknown",
    ...(agent ? { agent } : {}),
  };
}

/**
 * Map the old ignored bundle slot to one internal canonical id. This adapter is reachable only
 * from the Node package root; `@superbee/server/router` never admits `default` or another alias.
 */
function canonicalizeLegacyBundleRoute(request: Request): Request {
  const url = new URL(request.url);
  const match = /^\/v0\/bundles\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return request;
  url.pathname = `/v0/bundles/${LEGACY_INTERNAL_BUNDLE_ID}/${match[2]!}`;
  return new Request(url, request);
}

function buildLegacyRouter(backend: StorageBackend, options: LegacyRouterOptions): (request: Request) => Promise<Response> {
  const outcomes = options.outcomes === undefined ? new MemoryOperationOutcomeStore() : options.outcomes;
  const workerRouter = createWorkerRouter({
    capabilities: capabilitiesForBackend(backend),
    ...(outcomes === null ? {} : { outcomes }),
    resolveContext: (request) => ({ backend, attribution: legacyAttribution(request) }),
  });
  return (request) => workerRouter(canonicalizeLegacyBundleRoute(request));
}

/** Historical explicit-backend entry point retained at the Node package root. */
export function createRouterForBackend(backend: StorageBackend, options: LegacyRouterOptions = {}): (request: Request) => Promise<Response> {
  return buildLegacyRouter(backend, options);
}

/** Historical Bundle entry point retained at the Node package root, including `/bundles/default`. */
export function createRouter(bundle: Bundle, options: LegacyRouterOptions = {}): (request: Request) => Promise<Response> {
  return buildLegacyRouter(bundle.backend ?? new FilesystemBackend(bundle.root), options);
}
