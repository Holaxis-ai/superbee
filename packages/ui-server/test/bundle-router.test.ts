/**
 * The UI host's private one-bundle router (`src/bundle-router.ts`): capability self-declaration
 * with the `instanceof MemoryBackend` fallback, the SPA's `default` bundle segment with advisory
 * `X-Actor`/`X-Agent` attribution, and a filesystem bundle keeping the host policy it was
 * initialized with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FilesystemBackend, MemoryBackend, type StorageBackend } from "@superbee/core";
import { createFilesystemRuntime } from "@superbee/core/filesystem";

import { createBackendRouter, createBundleRouter } from "../src/bundle-router.js";

async function json(res: Response): Promise<unknown> {
  return res.json();
}

test("GET /v0/capabilities: a backend WITHOUT capabilities() falls back to the instanceof inference (MemoryBackend = the hard case)", async () => {
  const router = createBundleRouter({ root: "mem://caps-fallback", backend: new MemoryBackend() });
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
    const router = createBundleRouter({ root: dir, backend: new FilesystemBackend(dir) });
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
  const router = createBundleRouter({ root: "stub://caps", backend: stub });
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
  const viaBundle = createBundleRouter({ root: "mem://a", backend });
  const viaBackend = createBackendRouter(backend);

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
  assert.equal(body.body, "hello\n");
});

test("createRouterForBackend: GET /v0/capabilities works without a Bundle at all", async () => {
  const router = createBackendRouter(new StubBackend());
  const res = await router(new Request("http://x/v0/capabilities"));
  const body = (await json(res)) as Record<string, unknown>;
  assert.equal(body.blobs, false);
  assert.equal(body.backlinks, true);
});


test("the one-bundle router serves the SPA's default bundle route and advisory attribution", async () => {
  const backend = new MemoryBackend();
  const router = createBackendRouter(backend);
  const write = await router(
    new Request("http://wire.local/v0/bundles/default/docs/concepts/legacy", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-actor": "legacy-actor", "x-agent": "legacy-agent" },
      body: JSON.stringify({ frontmatter: { type: "Concept", title: "Legacy" }, body: "same wire" }),
    }),
  );
  assert.equal(write.status, 200);

  const read = await router(new Request("http://wire.local/v0/bundles/default/docs/concepts/legacy"));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    id: "concepts/legacy",
    frontmatter: { type: "Concept", title: "Legacy", timestamp: (await backend.read("concepts/legacy")).doc.frontmatter.timestamp },
    body: "same wire\n",
  });
  assert.deepEqual(
    (await backend.versions("concepts/legacy")).map(({ actor, agent }) => ({ actor, agent })),
    [{ actor: "legacy-actor", agent: "legacy-agent" }],
  );
});


test("the one-bundle router retains the initialized filesystem policy outside its constructing host context", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-router-policy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = createFilesystemRuntime({
    runtimeLockParent: () => dir,
    runtimeOwnerKey: () => "router",
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  });
  const bundle = await runtime.initBundle(path.join(dir, "bundle"), { okfVersion: "0.1" });
  await bundle.backend!.write("x", { id: "x", frontmatter: { type: "Note" }, body: "configured" });
  const router = createBundleRouter(bundle);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "unsupported-test-host" });
  try {
    assert.throws(() => createBundleRouter({ root: bundle.root }), /explicit filesystem host policy/);
    const response = await router(new Request("http://wire.local/v0/bundles/default/docs/x"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /configured/);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
