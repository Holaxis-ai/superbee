import type { StorageBackend } from "@superbee/core";

import { MemoryOperationOutcomeStore } from "../../src/operation-outcomes.js";
import { createRouter } from "../../src/router.js";

/** The canonical bundle id these tests address. */
export const BUNDLE_ID = "bnd_00112233445566778899aabbccddeeff";

/** The worker router over one backend, with `X-Actor` taken as the attribution, as a test host. */
export function oneBackendRouter(backend: StorageBackend): (request: Request) => Promise<Response> {
  return createRouter({
    capabilities: backend.capabilities?.() ?? { enforced_cas: true, blobs: true, projections: true, backlinks: false },
    outcomes: new MemoryOperationOutcomeStore(),
    resolveContext: (request) => ({ backend, attribution: { actor: request.headers.get("x-actor")?.trim() || "unknown" } }),
  });
}
