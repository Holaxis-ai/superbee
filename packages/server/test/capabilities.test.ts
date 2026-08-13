/**
 * Router-level tests for the capabilities self-declaration seam addition (Stage-1 Unit 2b
 * Part B, `core/src/types.ts`'s optional `StorageBackend.capabilities?()`): `GET
 * /v0/capabilities` prefers a backend's own declaration when present, and falls back to the
 * pre-existing `instanceof MemoryBackend` inference for an adapter that doesn't implement it.
 * FilesystemBackend now self-declares because its enforced CAS and retained-history answers differ.
 *
 * Also covers {@link createRouterForBackend}, the worker-clean entry point extracted
 * alongside this change (`router.ts`'s `buildRouter` refactor): a basic doc round-trip
 * proves the extraction didn't change observable router behavior for a caller that supplies
 * an explicit backend directly, without going through the `Bundle`-shape fallback
 * {@link createRouter} still provides.
 *
 * This is a NEW test file in a package that previously had no `test` script — the existing
 * wire-protocol contract suite lives in `packages/core/test/wire-protocol.test.ts` (a
 * documented test-only reverse dependency, see `docs/WIRE-PROTOCOL.md`'s "Test coupling
 * note") and stays untouched; these tests are additive, package-local coverage of the
 * router changes made directly in `packages/server/src/router.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FilesystemBackend, MemoryBackend } from "@superbee/core";
import type { StorageBackend } from "@superbee/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRouter, createRouterForBackend } from "../src/router.js";

async function json(res: Response): Promise<unknown> {
  return res.json();
}

test("GET /v0/capabilities: a backend WITHOUT capabilities() falls back to the instanceof inference (MemoryBackend = the hard case)", async () => {
  const router = createRouter({ root: "mem://caps-fallback", backend: new MemoryBackend() });
  const res = await router(new Request("http://x/v0/capabilities"));
  assert.equal(res.status, 200);
  const body = (await json(res)) as Record<string, unknown>;
  assert.equal(body.history, true);
  assert.equal(body.enforced_cas, true);
  assert.equal(body.blobs, true);
  assert.equal(body.projections, true);
  assert.equal(body.backlinks, false);
});

test("GET /v0/capabilities: a FilesystemBackend reports enforced CAS independently from retained history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-server-caps-"));
  try {
    const router = createRouter({ root: dir, backend: new FilesystemBackend(dir) });
    const res = await router(new Request("http://x/v0/capabilities"));
    const body = (await json(res)) as Record<string, unknown>;
    assert.equal(body.history, false);
    assert.equal(body.enforced_cas, true);
    assert.equal(body.blobs, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A minimal stub backend that self-declares capabilities different from either fallback path. */
class StubBackend extends MemoryBackend implements StorageBackend {
  capabilities(): { history?: boolean; enforced_cas: boolean; blobs: boolean; projections?: boolean; backlinks?: boolean } {
    return { enforced_cas: true, blobs: false, projections: false, backlinks: true };
  }
}

test("GET /v0/capabilities: a backend that DECLARES capabilities() has its values reported verbatim, not the instanceof-inferred ones", async () => {
  const stub = new StubBackend();
  const router = createRouter({ root: "stub://caps", backend: stub });
  const res = await router(new Request("http://x/v0/capabilities"));
  const body = (await json(res)) as Record<string, unknown>;
  // If the router were still using the raw instanceof-MemoryBackend fallback, `blobs` would
  // be `true` and `backlinks` would be `false` (the fallback's hardcoded values) — asserting
  // the OPPOSITE proves the self-declaration path, not the fallback, produced this response.
  assert.equal(body.enforced_cas, true);
  assert.equal(body.blobs, false);
  assert.equal(body.projections, false);
  assert.equal(body.backlinks, true);
  assert.equal(body.history, true, "history mirrors enforced_cas, not a separately-declared field");
});

test("createRouterForBackend: doc write/read round-trip identical to createRouter given the same explicit backend (extraction is behavior-preserving)", async () => {
  const backend = new MemoryBackend();
  const viaBundle = createRouter({ root: "mem://a", backend });
  const viaBackend = createRouterForBackend(backend);

  const writeRes = await viaBackend(
    new Request("http://x/v0/bundles/default/docs/concepts/alpha", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frontmatter: { type: "Concept", title: "Alpha" }, body: "hello" }),
    }),
  );
  assert.equal(writeRes.status, 200);

  // Read back through EITHER router — same backend, same state — proving createRouterForBackend
  // is not a parallel implementation, just the same buildRouter over an explicit backend.
  const readRes = await viaBundle(new Request("http://x/v0/bundles/default/docs/concepts/alpha"));
  assert.equal(readRes.status, 200);
  const body = (await json(readRes)) as { frontmatter: { title: string }; body: string };
  assert.equal(body.frontmatter.title, "Alpha");
  assert.equal(body.body, "hello");
});

test("createRouterForBackend: GET /v0/capabilities works without a Bundle at all", async () => {
  const router = createRouterForBackend(new StubBackend());
  const res = await router(new Request("http://x/v0/capabilities"));
  const body = (await json(res)) as Record<string, unknown>;
  assert.equal(body.blobs, false);
  assert.equal(body.backlinks, true);
});
