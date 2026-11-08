/**
 * The UI's one-bundle router: the worker router over one backend, reached by the SPA at
 * `/v0/bundles/default/...`. The `default` segment is mapped to one internal canonical id, and
 * `X-Actor`/`X-Agent` become the advisory attribution, because this loopback host has no identity
 * of its own. Private to this package; hosts use `@superbee/server/router` with their own
 * resolver.
 */

import {
  MemoryBackend,
  type Bundle,
  type StorageBackend,
  type StorageCapabilities,
} from "@superbee/core";

import { backendFor } from "@superbee/core/bundle-ops";

import { MemoryOperationOutcomeStore, type OperationOutcomeStore } from "@superbee/server/operation-outcomes";
import {
  createRouter as createWorkerRouter,
  type TrustedAttribution,
} from "@superbee/server/router";

const INTERNAL_BUNDLE_ID = "bnd_00000000000000000000000000000000";

export interface BundleRouterOptions {
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

function advisoryAttribution(request: Request): TrustedAttribution {
  const actor = request.headers.get("X-Actor")?.trim();
  const agent = request.headers.get("X-Agent")?.trim();
  return {
    actor: actor || "unknown",
    ...(agent ? { agent } : {}),
  };
}

/** Map the SPA's bundle slot to one internal canonical id; `@superbee/server/router` admits no alias. */
function canonicalizeBundleRoute(request: Request): Request {
  const url = new URL(request.url);
  const match = /^\/v0\/bundles\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return request;
  url.pathname = `/v0/bundles/${INTERNAL_BUNDLE_ID}/${match[2]!}`;
  return new Request(url, request);
}

function buildRouter(backend: StorageBackend, options: BundleRouterOptions): (request: Request) => Promise<Response> {
  const outcomes = options.outcomes === undefined ? new MemoryOperationOutcomeStore() : options.outcomes;
  const workerRouter = createWorkerRouter({
    capabilities: capabilitiesForBackend(backend),
    ...(outcomes === null ? {} : { outcomes }),
    resolveContext: (request) => ({ backend, attribution: advisoryAttribution(request) }),
  });
  return (request) => workerRouter(canonicalizeBundleRoute(request));
}

/** The router over one explicit backend. */
export function createBackendRouter(backend: StorageBackend, options: BundleRouterOptions = {}): (request: Request) => Promise<Response> {
  return buildRouter(backend, options);
}

/** The router over one bundle, as `superbee ui --dir` mounts it. */
export function createBundleRouter(bundle: Bundle, options: BundleRouterOptions = {}): (request: Request) => Promise<Response> {
  return buildRouter(backendFor(bundle), options);
}
