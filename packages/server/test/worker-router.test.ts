import assert from "node:assert/strict";
import test from "node:test";

import { MemoryBackend, type WriteOptions } from "@superbee/core";

import {
  WIRE_ENDPOINTS,
  WireRequestResolutionError,
  createRouter,
  resolveWireRequest,
  type ResolvedBundleWireRoute,
} from "../src/router.js";

const BUNDLE_A = "bnd_00112233445566778899aabbccddeeff";
const BUNDLE_B = "bnd_ffeeddccbbaa99887766554433221100";
const CAPABILITIES = {
  enforced_cas: true,
  blobs: true,
  projections: true,
  backlinks: false,
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://worker.example${path}`, init);
}

function assertResolutionError(path: string, status = 400): void {
  assert.throws(
    () => resolveWireRequest(request(path)),
    (error) => error instanceof WireRequestResolutionError && error.status === status,
  );
}

test("resolver returns discriminated deployment and canonical bundle routes with decoded resources", () => {
  const deployment = resolveWireRequest(request("/v0/capabilities"));
  assert.deepEqual(
    {
      scope: deployment.scope,
      endpointId: deployment.endpointId,
      accessClass: deployment.accessClass,
      resource: deployment.resource,
      hasBundle: "bundleId" in deployment,
    },
    {
      scope: "deployment",
      endpointId: "capabilities",
      accessClass: "public",
      resource: { kind: "capabilities" },
      hasBundle: false,
    },
  );

  const bundle = resolveWireRequest(request(`/v0/bundles/${BUNDLE_A}/docs/concepts/caf%C3%A9%2Fproof`));
  assert.equal(bundle.scope, "bundle");
  assert.equal(bundle.bundleId, BUNDLE_A);
  assert.equal(bundle.endpointId, "doc-read");
  assert.equal(bundle.accessClass, "read");
  assert.deepEqual(bundle.resource, { kind: "doc", id: "concepts/café/proof" });
});

test("registry is the endpoint, method, template, and access-class authority", () => {
  assert.equal(new Set(WIRE_ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).size, WIRE_ENDPOINTS.length);
  assert.deepEqual(
    WIRE_ENDPOINTS.filter((endpoint) => endpoint.id === "docs-read-many").map((endpoint) => endpoint.accessClass),
    ["read"],
  );
  assert.deepEqual(
    WIRE_ENDPOINTS.filter((endpoint) => endpoint.method === "PUT" || endpoint.method === "DELETE").map(
      (endpoint) => endpoint.accessClass,
    ),
    ["write", "write", "write", "write", "write"],
  );
});

test("resolver rejects aliases, uppercase ids, percent escapes, encoded slash, and malformed segments", () => {
  for (const path of [
    "/v0/bundles/default/docs",
    "/v0/bundles/customer-label/docs",
    "/v0/bundles/bnd_00112233445566778899AABBCCDDEEFF/docs",
    "/v0/bundles/bnd_00112233445566778899aabbccddee%66f/docs",
    "/v0/bundles/bnd_00112233445566778899aabbccdd%2Feeff/docs",
    "/v0/bundles//docs",
    `/v0/bundles/${BUNDLE_A}//docs`,
  ]) {
    assertResolutionError(path, path === `/v0/bundles/${BUNDLE_A}//docs` ? 404 : 400);
  }
});

test("route rejection fails before context or backend resolution", async () => {
  let contextCalls = 0;
  const router = createRouter({
    capabilities: CAPABILITIES,
    resolveContext: () => {
      contextCalls++;
      throw new Error("must not run");
    },
  });

  for (const path of [
    "/v0/bundles/default/docs",
    "/v0/bundles/bnd_00112233445566778899aabbccdd%2Feeff/docs",
    `/v0/bundles/${BUNDLE_A}/docs/../escape`,
    `/v0/bundles/${BUNDLE_A}/reserved/other.md`,
  ]) {
    const response = await router(request(path));
    assert.ok(response.status === 400 || response.status === 404, path);
  }
  assert.equal(contextCalls, 0);
});

test("bundle dispatch resolves one trusted context exactly once and public headers cannot forge attribution", async () => {
  class CapturingBackend extends MemoryBackend {
    writes: WriteOptions[] = [];

    override async write(...args: Parameters<MemoryBackend["write"]>): ReturnType<MemoryBackend["write"]> {
      this.writes.push(args[2] ?? {});
      return super.write(...args);
    }
  }

  const backend = new CapturingBackend();
  let contextCalls = 0;
  let observedRoute: ResolvedBundleWireRoute | undefined;
  const router = createRouter({
    capabilities: CAPABILITIES,
    resolveContext: (_request, route) => {
      contextCalls++;
      observedRoute = route;
      return { backend, attribution: { actor: "principal_7", agent: "verified-agent" } };
    },
  });

  const response = await router(
    request(`/v0/bundles/${BUNDLE_B}/docs/concepts/attribution`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-actor": "forged-actor",
        "x-agent": "forged-agent",
      },
      body: JSON.stringify({ frontmatter: { type: "Concept" }, body: "trusted" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(contextCalls, 1);
  assert.equal(observedRoute?.bundleId, BUNDLE_B);
  assert.equal(observedRoute?.endpointId, "doc-write");
  assert.deepEqual(backend.writes.at(-1), { actor: "principal_7", agent: "verified-agent" });
});

test("deployment capabilities bypass context and backend resolution", async () => {
  let contextCalls = 0;
  const router = createRouter({
    capabilities: CAPABILITIES,
    resolveContext: () => {
      contextCalls++;
      throw new Error("must not run");
    },
  });
  const response = await router(request("/v0/capabilities"));
  assert.equal(response.status, 200);
  assert.equal(contextCalls, 0);
  assert.deepEqual(await response.json(), { history: true, ...CAPABILITIES });
});
