/**
 * Tri-backend contract tests, part 3: `RemoteBackend` over the wire-protocol v0
 * reference router (`@superbee/server`), wired with NO SOCKETS for the
 * contract tests — the router is injected directly as `RemoteBackend`'s fetch
 * transport, so these are deterministic and fast while still exercising the real
 * HTTP-shaped request/response envelopes (headers, status codes, JSON bodies) end
 * to end. One dedicated test at the bottom boots a REAL `node:http` listener via
 * `serve()` for a socket-level smoke check.
 *
 * `storage-backend-contract.test.ts` owns direct-seam parity across FilesystemBackend,
 * MemoryBackend, and RemoteBackend. This file owns engine agreement over RemoteBackend
 * plus HTTP mechanics, envelopes, security gates, and socket-level smoke coverage.
 *
 * Note on module identity: the router's capabilities endpoint does
 * `backend instanceof MemoryBackend` against the COMPILED `@superbee/core`
 * it imports transitively via `@superbee/server`. The server-side backend
 * constructed here therefore uses `MemoryBackend` imported from the `@superbee/core`
 * package (not the local `../src` module) so that check observes a true match — the
 * rest of this file uses the local `../src` imports, matching `dual-backend.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRouter, createRouterForBackend, MemoryOperationOutcomeStore, serve } from "@superbee/server";
import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";

import { InvalidInputError } from "../src/errors.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { RemoteBackend, RemoteError } from "../src/remote-backend.js";
import { createRemoteOperationTransport, openRemoteOperationTransport, OperationsUnsupportedError } from "../src/remote-operations.js";
import type { OperationIntent } from "../src/uncertain-write.js";
import { MemoryBackend } from "../src/memory-backend.js";
import {
  writeDocVersioned,
  readDocVersioned,
  writeBlob,
} from "../src/bundle.js";
import { VersionConflict } from "../src/versioning.js";
import { scenario, T_DOC } from "./scenario.js";
import type {
  Bundle,
  ConceptId,
  DeleteOptions,
  OkfDocument,
  ReservedFilename,
  StorageBackend,
  WriteOptions,
} from "../src/types.js";

/** A fresh `RemoteBackend` wired to an in-process router over a fresh server-side
 * `MemoryBackend`, with the router injected AS the fetch transport (no sockets). */
function freshWireBundle(): Bundle {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-server", backend: serverBackend });
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: router });
  return { root: "wire://client", backend: remote };
}

/**
 * A `StorageBackend` wrapper that records every call it receives — used to prove a
 * rejected (traversal / invalid-id / invalid-dir) request never reaches the backend
 * at all, not just that it happens to 4xx.
 */
class SpyBackend implements StorageBackend {
  readonly calls: string[] = [];
  private readonly inner: StorageBackend;
  constructor(inner: StorageBackend) {
    this.inner = inner;
  }
  read(id: ConceptId) {
    this.calls.push(`read:${id}`);
    return this.inner.read(id);
  }
  readMany(ids: ConceptId[]) {
    this.calls.push(`readMany:${ids.join(",")}`);
    return this.inner.readMany(ids);
  }
  write(id: ConceptId, doc: OkfDocument, options?: WriteOptions) {
    this.calls.push(`write:${id}`);
    return this.inner.write(id, doc, options);
  }
  exists(id: ConceptId) {
    this.calls.push(`exists:${id}`);
    return this.inner.exists(id);
  }
  list(prefix?: string) {
    this.calls.push(`list:${prefix ?? ""}`);
    return this.inner.list(prefix);
  }
  versions(id: ConceptId) {
    this.calls.push(`versions:${id}`);
    return this.inner.versions(id);
  }
  readReserved(dir: string, name: ReservedFilename) {
    this.calls.push(`readReserved:${dir}/${name}`);
    return this.inner.readReserved(dir, name);
  }
  writeReserved(dir: string, name: ReservedFilename, content: string, options?: WriteOptions) {
    this.calls.push(`writeReserved:${dir}/${name}`);
    return this.inner.writeReserved(dir, name, content, options);
  }
  // Forwarding stub so this class keeps satisfying `StorageBackend` after the DELETE-operation
  // pass added `delete` to the seam — exercised directly by this file's "wire security: DELETE
  // ..." tests below (unlike the blob stubs' original note, which predates the blob routes
  // existing at all).
  delete(id: ConceptId, options?: DeleteOptions) {
    this.calls.push(`delete:${id}`);
    return this.inner.delete(id, options);
  }
  // Forwarding stubs so this class keeps satisfying `StorageBackend` after Part A added
  // the blob methods to the seam. Not exercised by any test in THIS file (no blob route
  // exists on the router yet — that's Part B); present only to keep the class compiling.
  readBlob(key: string) {
    this.calls.push(`readBlob:${key}`);
    return this.inner.readBlob(key);
  }
  writeBlob(key: string, bytes: Uint8Array, contentType?: string, options?: WriteOptions) {
    this.calls.push(`writeBlob:${key}`);
    return this.inner.writeBlob(key, bytes, contentType, options);
  }
  deleteBlob(key: string, options?: DeleteOptions) {
    this.calls.push(`deleteBlob:${key}`);
    return this.inner.deleteBlob(key, options);
  }
  existsBlob(key: string) {
    this.calls.push(`existsBlob:${key}`);
    return this.inner.existsBlob(key);
  }
  listBlobs(prefix?: string) {
    this.calls.push(`listBlobs:${prefix ?? ""}`);
    return this.inner.listBlobs(prefix);
  }
}

/** A fresh router over a `SpyBackend`-wrapped `MemoryBackend`, for the traversal tests. */
function freshSpiedRouter(): { router: (req: Request) => Promise<Response>; spy: SpyBackend } {
  const spy = new SpyBackend(new ServerMemoryBackend());
  const router = createRouter({ root: "mem://wire-spy", backend: spy });
  return { router, spy };
}

/** Assert `res` is a 4xx with a structured `{ error: { code, message } }` envelope. */
async function assertUsageEnvelope(res: Response): Promise<void> {
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx status, got ${res.status}`);
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  assert.ok(body.error, "expected a structured { error } envelope");
  assert.ok(typeof body.error?.code === "string" && body.error.code.length > 0);
  assert.ok(typeof body.error?.message === "string" && body.error.message.length > 0);
}

test("wire security: GET .../docs/../../etc/passwd never reaches the backend (URL dot-segments collapse away from the docs route; still 4xx)", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/../../etc/passwd"));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: GET .../docs/a/../../b never reaches the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/a/../../b"));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: an id that decodes to an absolute path ('/etc/passwd') is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  // %2F is an encoded '/', so this id-path-segment decodes (as a single segment, per
  // decodeId's per-segment decodeURIComponent) to the absolute string '/etc/passwd' —
  // the real vector: it survives URL dot-segment collapsing because there are no
  // literal '/' characters in the raw path segment for the URL parser to normalize.
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/%2Fetc%2Fpasswd"));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: an id containing a literal '..' segment (delivered via decodeId's per-segment decode) is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  // %2e%2e%2f%2e%2e%2f encodes "../../" with the slashes escaped too, so it arrives as
  // ONE raw path segment (no literal '/' for the URL parser to dot-collapse) and only
  // becomes multi-segment after decodeId's decodeURIComponent.
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs/%2e%2e%2f%2e%2e%2fetc%2fpasswd"),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: HEAD with an invalid id returns a bodiless 4xx and never touches the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs/%2Fetc%2Fpasswd", { method: "HEAD" }),
  );
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal(await res.text(), "");
  assert.deepEqual(spy.calls, []);
});

test("wire security: GET .../docs/{id}/versions with an invalid id is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs/%2Fetc%2Fpasswd/versions"),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: PUT a doc with an invalid id is rejected (via the engine's own guard) before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs/%2Fetc%2Fpasswd", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frontmatter: { type: "T" }, body: "pwned" }),
    }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: DELETE .../docs/%2Fetc%2Fpasswd (an id that decodes to an absolute path) never reaches the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs/%2Fetc%2Fpasswd", { method: "DELETE" }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: DELETE canonical id /docs/index (the reserved index.md) is rejected 400 USAGE before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/index", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: DELETE canonical id /docs/log (the reserved log.md) is rejected 400 USAGE before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/log", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: POST /docs:read-many rejects the WHOLE batch when any id is a traversal payload, never touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs:read-many", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The traversal payload arrives verbatim in the JSON body — no URL encoding
      // involved, so this is the cleanest proof the id validation itself (not URL
      // parsing) is what rejects it.
      body: JSON.stringify({ ids: ["good", "../../etc/passwd"] }),
    }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: GET /reserved/{name}?dir=../outside is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request(`http://wire.local/v0/bundles/test/reserved/log.md?dir=${encodeURIComponent("../outside")}`),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: PUT /reserved/{name}?dir=/absolute is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request(`http://wire.local/v0/bundles/test/reserved/log.md?dir=${encodeURIComponent("/absolute")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "pwned" }),
    }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire: core operations return identical results over RemoteBackend as over a local MemoryBackend", async () => {
  const wireResult = await scenario(freshWireBundle());
  const localResult = await scenario({ root: "mem://local", backend: new MemoryBackend() });
  assert.deepEqual(wireResult, localResult);

  const r = wireResult as {
    conceptIds: string[];
    betaBacklinks: { from: string; text: string }[];
    alphaBacklinks: { from: string; text: string }[];
    freshness: string;
  };
  assert.deepEqual(r.conceptIds, ["concepts/alpha", "concepts/beta"]);
  assert.deepEqual(r.betaBacklinks, [{ from: "concepts/alpha", text: "Beta" }]);
  assert.equal(r.freshness, "fresh");
});

test("wire: engine compare-and-swap (writeDocVersioned + expectedVersion) rejects a stale version, over the wire", async () => {
  const bundle = freshWireBundle();
  const doc: OkfDocument = { id: "concepts/cas", frontmatter: { type: "Concept", title: "Cas", timestamp: T_DOC }, body: "v1" };
  const first = await writeDocVersioned(bundle, doc);
  const second = await writeDocVersioned(bundle, { ...doc, body: "v2" });
  assert.notEqual(second.version, first.version);

  await assert.rejects(
    () => writeDocVersioned(bundle, { ...doc, body: "v3" }, { expectedVersion: first.version }),
    (err: unknown) => {
      assert.ok(err instanceof VersionConflict);
      assert.equal(err.expected, first.version);
      assert.equal(err.actual, second.version);
      return true;
    },
  );
  assert.equal((await readDocVersioned(bundle, "concepts/cas")).version, second.version);

  const third = await writeDocVersioned(bundle, { ...doc, body: "v3" }, { expectedVersion: second.version });
  assert.notEqual(third.version, second.version);
});

test("wire: raw DELETE /docs/{id} response shape is exactly { deleted } with a 200 status, no version headers", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-delete-shape", backend: serverBackend };
  const router = createRouter(bundle);
  await writeDocVersioned(bundle, { id: "shape", frontmatter: { type: "T", timestamp: T_DOC }, body: "x" });

  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/shape", { method: "DELETE" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deleted: boolean };
  assert.deepEqual(body, { deleted: true });

  const absentRes = await router(new Request("http://wire.local/v0/bundles/test/docs/never-here", { method: "DELETE" }));
  assert.equal(absentRes.status, 200);
  assert.deepEqual((await absentRes.json()) as { deleted: boolean }, { deleted: false });
});

test("wire: GET /docs list endpoint carries count + type/tag filters + fields=frontmatter projection", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-list", backend: serverBackend };
  const router = createRouter(bundle);
  const listUrl = "http://wire.local/v0/bundles/test/docs";

  await writeDocVersioned(bundle, { id: "a", frontmatter: { type: "Concept", title: "A", tags: ["x"], timestamp: T_DOC }, body: "" });
  await writeDocVersioned(bundle, { id: "b", frontmatter: { type: "Concept", title: "B", tags: ["y"], timestamp: T_DOC }, body: "" });
  await writeDocVersioned(bundle, { id: "c", frontmatter: { type: "Other", title: "C", timestamp: T_DOC }, body: "" });

  const all = await router(new Request(listUrl));
  const allBody = (await all.json()) as { count: number; docs: Array<{ id: string }> };
  assert.equal(allBody.count, 3);
  assert.deepEqual(allBody.docs.map((d) => d.id).sort(), ["a", "b", "c"]);

  const byType = await router(new Request(`${listUrl}?type=Concept`));
  const byTypeBody = (await byType.json()) as { count: number; docs: Array<{ id: string; type?: string }> };
  assert.equal(byTypeBody.count, 2);
  for (const row of byTypeBody.docs) assert.equal(row.type, "Concept");

  const byTag = await router(new Request(`${listUrl}?tag=y`));
  const byTagBody = (await byTag.json()) as { count: number; docs: Array<{ id: string }> };
  assert.deepEqual(byTagBody.docs.map((d) => d.id), ["b"]);

  const withFrontmatter = await router(new Request(`${listUrl}?fields=frontmatter`));
  const fmBody = (await withFrontmatter.json()) as { docs: Array<{ id: string; frontmatter?: Record<string, unknown> }> };
  assert.ok(fmBody.docs[0]?.frontmatter);
  assert.equal(typeof fmBody.docs[0]?.frontmatter?.type, "string");
});

test("wire: POST /docs:read-many reports 404 + { missing } when any id is absent", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-read-many", backend: serverBackend };
  const router = createRouter(bundle);
  await writeDocVersioned(bundle, { id: "present", frontmatter: { type: "T", timestamp: T_DOC }, body: "" });

  const res = await router(
    new Request("http://wire.local/v0/bundles/test/docs:read-many", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["present", "absent"] }),
    }),
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string; details?: { missing: string[] } } };
  assert.equal(body.error.code, "NOT_FOUND");
  assert.deepEqual(body.error.details?.missing, ["absent"]);
});

test("wire: GET /docs/{id}/versions returns [] for never-written, and the real chain for MemoryBackend", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-versions", backend: serverBackend };
  const router = createRouter(bundle);

  const neverWritten = await router(new Request("http://wire.local/v0/bundles/test/docs/nope/versions"));
  assert.equal(neverWritten.status, 200);
  assert.deepEqual((await neverWritten.json()) as { versions: unknown[] }, { versions: [] });

  await writeDocVersioned(bundle, { id: "v", frontmatter: { type: "T", timestamp: T_DOC }, body: "one" }, { actor: "alice" });
  await writeDocVersioned(bundle, { id: "v", frontmatter: { type: "T", timestamp: T_DOC }, body: "two" }, { actor: "bob" });
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs/v/versions"));
  const body = (await res.json()) as { versions: Array<{ actor: string }> };
  assert.equal(body.versions.length, 2);
  assert.equal(body.versions[0]!.actor, "bob"); // newest-first
  assert.equal(body.versions[1]!.actor, "alice");
});

test("wire: X-Agent round-trips alongside X-Actor — router reads it into options.agent, wire JSON carries it, RemoteBackend.versions() parses VersionInfo.agent; a write with no X-Agent leaves agent absent end to end", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-agent", backend: serverBackend });

  // Direct PUT with BOTH X-Actor and X-Agent, bypassing RemoteBackend's write() (which
  // deliberately does not send X-Agent — only the auth'd worker manufactures it).
  const putRes = await router(
    new Request("http://wire.local/v0/bundles/test/docs/concepts/agented", {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Actor": "root", "X-Agent": "collab-3" },
      body: JSON.stringify({ frontmatter: { type: "Concept", timestamp: T_DOC }, body: "one" }),
    }),
  );
  assert.equal(putRes.status, 200);

  // A control write with NO X-Agent header.
  const controlRes = await router(
    new Request("http://wire.local/v0/bundles/test/docs/concepts/unagented", {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Actor": "root" },
      body: JSON.stringify({ frontmatter: { type: "Concept", timestamp: T_DOC }, body: "one" }),
    }),
  );
  assert.equal(controlRes.status, 200);

  // Raw wire JSON carries `agent` only for the agented write.
  const versionsRes = await router(new Request("http://wire.local/v0/bundles/test/docs/concepts/agented/versions"));
  const versionsBody = (await versionsRes.json()) as { versions: Array<{ actor: string; agent?: string }> };
  assert.equal(versionsBody.versions.length, 1);
  assert.equal(versionsBody.versions[0]!.actor, "root");
  assert.equal(versionsBody.versions[0]!.agent, "collab-3");

  const controlVersionsRes = await router(
    new Request("http://wire.local/v0/bundles/test/docs/concepts/unagented/versions"),
  );
  const controlVersionsBody = (await controlVersionsRes.json()) as { versions: Array<{ actor: string; agent?: string }> };
  assert.equal(controlVersionsBody.versions.length, 1);
  assert.ok(!("agent" in controlVersionsBody.versions[0]!), "no X-Agent sent -> no agent key in the wire JSON");

  // RemoteBackend.versions() parses `agent` through into VersionInfo.agent.
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: router });
  const agentedVersions = await remote.versions("concepts/agented");
  assert.equal(agentedVersions.length, 1);
  assert.equal(agentedVersions[0]!.actor, "root");
  assert.equal(agentedVersions[0]!.agent, "collab-3");

  const unagentedVersions = await remote.versions("concepts/unagented");
  assert.equal(unagentedVersions.length, 1);
  assert.equal(unagentedVersions[0]!.agent, undefined);
});

test("wire: GET /v0/capabilities reports the backend's real capabilities (MemoryBackend = the hard case)", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-caps", backend: serverBackend });
  const res = await router(new Request("http://wire.local/v0/capabilities"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { history: true, enforced_cas: true, projections: true, backlinks: false, blobs: true, operations: true });
});

test("wire: error envelopes on 404 and 412 follow the { error: { code, message, details? } } shape", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-errors", backend: serverBackend };
  const router = createRouter(bundle);

  const notFoundRes = await router(new Request("http://wire.local/v0/bundles/test/docs/nope"));
  assert.equal(notFoundRes.status, 404);
  const notFoundBody = (await notFoundRes.json()) as { error: { code: string; message: string } };
  assert.equal(notFoundBody.error.code, "NOT_FOUND");
  assert.ok(notFoundBody.error.message.length > 0);

  await writeDocVersioned(bundle, { id: "conflict-me", frontmatter: { type: "T", timestamp: T_DOC }, body: "v1" });
  const conflictRes = await router(
    new Request("http://wire.local/v0/bundles/test/docs/conflict-me", {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": "sha256:" + "0".repeat(64) },
      body: JSON.stringify({ frontmatter: { type: "T", timestamp: T_DOC }, body: "v2" }),
    }),
  );
  assert.equal(conflictRes.status, 412);
  const conflictBody = (await conflictRes.json()) as { error: { code: string; details?: { expected: string; actual: string } } };
  assert.equal(conflictBody.error.code, "VERSION_CONFLICT");
  assert.ok(conflictBody.error.details?.expected);
  assert.ok(conflictBody.error.details?.actual);
});

test("wire: serve() boots a real node:http listener; one GET round-trips, then close()", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-smoke", backend: serverBackend };
  await writeDocVersioned(bundle, { id: "smoke", frontmatter: { type: "T", title: "Smoke", timestamp: T_DOC }, body: "hello" });

  const handle = await serve({ bundle, port: 0 });
  try {
    assert.equal(handle.host, "127.0.0.1");
    assert.ok(handle.port > 0);
    const res = await fetch(`http://${handle.host}:${handle.port}/v0/bundles/test/docs/smoke`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; body: string };
    assert.equal(body.id, "smoke");
    assert.equal(body.body, "hello");
    // Production repair (Stage-1 Unit 2b): the version now rides X-Version (bare, primary,
    // edge-proof) AND a properly RFC-7232-QUOTED ETag (secondary) — the original unquoted
    // bare-token ETag this pinned was itself the defect (Cloudflare's edge strips an invalid
    // ETag under Brotli compression; see router.ts's versionHeaders doc comment).
    assert.match(res.headers.get("x-version") ?? "", /^sha256:/);
    assert.match(res.headers.get("etag") ?? "", /^"sha256:[0-9a-f]{64}"$/);
  } finally {
    await handle.close();
  }
});

// ── blobs: opaque bytes served by content-type (wire-protocol v0.1) ──────────

const enc = (s: string) => new TextEncoder().encode(s);

test("wire: PUT /blobs/{key} returns 201 + {version} + ETag on expect-absent create, 200 on an ordinary write (I4)", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-blob-put", backend: serverBackend };
  const router = createRouter(bundle);

  const createRes = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/artifacts/report.html", {
      method: "PUT",
      headers: { "content-type": "text/html; charset=utf-8", "If-None-Match": "*" },
      body: enc("<p>hi</p>"),
    }),
  );
  assert.equal(createRes.status, 201);
  const createBody = (await createRes.json()) as { version: string };
  assert.match(createBody.version, /^sha256:[0-9a-f]{64}$/);
  // Production repair (Stage-1 Unit 2b): X-Version carries the bare token (primary, edge-proof);
  // ETag now carries the RFC-7232-quoted form (this pinned the pre-fix bare ETag, itself the
  // defect Cloudflare's edge strips under Brotli — see router.ts's versionHeaders doc comment).
  assert.equal(createRes.headers.get("x-version"), createBody.version);
  assert.equal(createRes.headers.get("etag"), `"${createBody.version}"`);

  const overwriteRes = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/artifacts/report.html", {
      method: "PUT",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: enc("<p>updated</p>"),
    }),
  );
  assert.equal(overwriteRes.status, 200);

  // A second expect-absent create against the now-present key is a 412 conflict.
  const conflictRes = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/artifacts/report.html", {
      method: "PUT",
      headers: { "content-type": "text/html; charset=utf-8", "If-None-Match": "*" },
      body: enc("<p>clobber attempt</p>"),
    }),
  );
  assert.equal(conflictRes.status, 412);
});

test("wire: GET /blobs list endpoint carries count + prefix filter + cursor pagination (B2, mirrors handleList)", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-blob-list", backend: serverBackend };
  const router = createRouter(bundle);

  await writeBlob(bundle, "artifacts/a.bin", enc("a"));
  await writeBlob(bundle, "artifacts/b.bin", enc("b"));
  await writeBlob(bundle, "other/c.bin", enc("c"));

  const all = await router(new Request("http://wire.local/v0/bundles/test/blobs"));
  const allBody = (await all.json()) as { count: number; keys: string[]; next_cursor: string | null };
  assert.equal(allBody.count, 3);
  assert.deepEqual(allBody.keys.sort(), ["artifacts/a.bin", "artifacts/b.bin", "other/c.bin"]);
  assert.equal(allBody.next_cursor, null);

  const byPrefix = await router(new Request("http://wire.local/v0/bundles/test/blobs?prefix=artifacts/"));
  const byPrefixBody = (await byPrefix.json()) as { count: number; keys: string[] };
  assert.equal(byPrefixBody.count, 2);
  assert.deepEqual(byPrefixBody.keys, ["artifacts/a.bin", "artifacts/b.bin"]);

  const limited = await router(new Request("http://wire.local/v0/bundles/test/blobs?limit=1"));
  const limitedBody = (await limited.json()) as { count: number; keys: string[]; next_cursor: string | null };
  assert.equal(limitedBody.count, 3); // count is the TOTAL matched, not the page size
  assert.equal(limitedBody.keys.length, 1);
  assert.ok(limitedBody.next_cursor);
});

test("wire security: PUT /blobs/{key} with a traversal key ('%2Fetc%2Fpasswd') is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/%2Fetc%2Fpasswd", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: DELETE /blobs/{key} with a traversal key ('%2Fetc%2Fpasswd') is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/%2Fetc%2Fpasswd", { method: "DELETE" }),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: DELETE /blobs/{key} with a .md-ending key (case-insensitive) is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/blobs/artifacts/report.MD", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: GET /blobs/{key} with a .md-ending key (case-insensitive) is rejected before touching the backend (I1 — no accidental raw-doc channel)", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/blobs/artifacts/report.MD"));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire security: HEAD /blobs/{key} with a dot-prefixed segment returns a bodiless 4xx and never touches the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/.git/config", { method: "HEAD" }),
  );
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal(await res.text(), "");
  assert.deepEqual(spy.calls, []);
});

test("wire security: GET /blobs/{key} with a '..' segment delivered via decodeBlobKey's per-segment decode (survives URL dot-segment collapsing) is rejected before touching the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  // %2e%2e%2f%2e%2e%2f encodes "../../" with the slashes escaped too, so it arrives as
  // ONE raw path segment (no literal '/' for the URL parser to dot-collapse) and only
  // becomes multi-segment after decodeBlobKey's decodeURIComponent — mirrors the
  // analogous doc-route test above.
  const res = await router(
    new Request("http://wire.local/v0/bundles/test/blobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd"),
  );
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

// ── D4: no bulk/reserved delete — DELETE on the collection or reserved-file routes 400s ──

test("wire: DELETE /docs (the collection route, bulk delete) is 400 USAGE — no bulk delete", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/docs", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire: DELETE /blobs (the collection route, bulk delete) is 400 USAGE — no bulk delete", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/blobs", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire: DELETE /reserved/log.md is 400 USAGE — reserved files have no delete route at all", async () => {
  const { router, spy } = freshSpiedRouter();
  const res = await router(new Request("http://wire.local/v0/bundles/test/reserved/log.md", { method: "DELETE" }));
  await assertUsageEnvelope(res);
  assert.deepEqual(spy.calls, []);
});

test("wire: serve() blob route — a REAL socket GET returns EXACT bytes with the correct Content-Type header (served-by-content-type acceptance, plan DoD #2)", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-blob-smoke", backend: serverBackend };
  const htmlBytes = enc("<html><body>served by content-type</body></html>");
  await writeBlob(bundle, "artifacts/report.html", htmlBytes);

  const handle = await serve({ bundle, port: 0 });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v0/bundles/test/blobs/artifacts/report.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes], [...htmlBytes]);
    // Production repair (Stage-1 Unit 2b): X-Version (bare, primary, edge-proof) + a properly
    // RFC-7232-quoted ETag (secondary) — this pinned the pre-fix unquoted bare-token ETag,
    // itself the defect (Cloudflare's edge strips an invalid ETag under Brotli compression).
    assert.match(res.headers.get("x-version") ?? "", /^sha256:/);
    assert.match(res.headers.get("etag") ?? "", /^"sha256:[0-9a-f]{64}"$/);

    const headRes = await fetch(`http://${handle.host}:${handle.port}/v0/bundles/test/blobs/artifacts/report.html`, {
      method: "HEAD",
    });
    assert.equal(headRes.status, 200);
    assert.match(headRes.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(await headRes.text(), "");

    const missingRes = await fetch(`http://${handle.host}:${handle.port}/v0/bundles/test/blobs/artifacts/nope.bin`);
    assert.equal(missingRes.status, 404);
  } finally {
    await handle.close();
  }
});

// ── identified writes and outcome lookup (WIRE-PROOF-10) ─────────────────────

const DOCS_URL = "http://wire.local/v0/bundles/test/docs";
const OPERATIONS_URL = "http://wire.local/v0/bundles/test/operations";

function identifiedPut(id: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${DOCS_URL}/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ frontmatter: { type: "T", timestamp: T_DOC }, body }),
  });
}

function identifiedDelete(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`${DOCS_URL}/${id}`, { method: "DELETE", headers });
}

function lookup(key: string): Request {
  return new Request(`${OPERATIONS_URL}/${encodeURIComponent(key)}`);
}

/** Everything a duplicate must reproduce: status, both version headers, and the exact body. */
async function answer(res: Response): Promise<{ status: number; version: string | null; etag: string | null; body: string }> {
  return { status: res.status, version: res.headers.get("x-version"), etag: res.headers.get("etag"), body: await res.text() };
}

async function outcomeAt(router: (req: Request) => Promise<Response>, key: string): Promise<{ status: number; body: unknown }> {
  const res = await router(lookup(key));
  return { status: res.status, body: await res.json() };
}

test("wire: identified PUT is applied once; the same Idempotency-Key replays the same status, X-Version and body, and the backend holds one revision", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-identified", backend: serverBackend });

  const first = await answer(await router(identifiedPut("concepts/once", "v1", { "Idempotency-Key": "req-1", "If-None-Match": "*" })));
  assert.equal(first.status, 201);
  assert.match(first.version ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.etag, `"${first.version}"`);

  // A different payload under the same key, method and id is not inspected: the record replays.
  const again = await answer(await router(identifiedPut("concepts/once", "v1 resent with a different body", { "Idempotency-Key": "req-1", "If-None-Match": "*" })));
  assert.deepEqual(again, first);
  assert.equal((await serverBackend.versions("concepts/once")).length, 1);
  assert.equal((await serverBackend.read("concepts/once")).doc.body, "v1");
});

/** A backend whose writes take real time, so two submissions can overlap deterministically. */
class SlowWriteBackend extends ServerMemoryBackend {
  writes = 0;
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions) {
    this.writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.write(id, doc, options);
  }
}

test("wire: two concurrent submissions under one Idempotency-Key apply exactly once and both receive the same version", async () => {
  const backend = new SlowWriteBackend();
  const router = createRouter({ root: "mem://wire-identified-race", backend });
  const [a, b] = await Promise.all([
    router(identifiedPut("concepts/race", "v1", { "Idempotency-Key": "race-1", "If-None-Match": "*" })),
    router(identifiedPut("concepts/race", "v1", { "Idempotency-Key": "race-1", "If-None-Match": "*" })),
  ]);
  const first = await answer(a);
  const second = await answer(b);
  assert.equal(first.status, 201);
  assert.deepEqual(second, first);
  assert.equal(backend.writes, 1, "the second submission waited for the first application instead of applying");
  assert.equal((await backend.versions("concepts/race")).length, 1);
});

test("wire: GET /operations/{key} returns committed after a PUT, 404 for an unknown key, and conflict after a stale If-Match PUT whose duplicate replays the 412", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-lookup", backend: serverBackend });

  const created = await answer(await router(identifiedPut("concepts/look", "v1", { "Idempotency-Key": "look-1", "If-None-Match": "*" })));
  assert.equal(created.status, 201);
  assert.deepEqual(await outcomeAt(router, "look-1"), { status: 200, body: { kind: "committed", version: created.version } });

  const unknown = await outcomeAt(router, "never-submitted");
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body as { error: { code: string } }).error.code, "NOT_FOUND");

  const stale = await answer(await router(identifiedPut("concepts/look", "v2", { "Idempotency-Key": "look-2", "If-Match": "sha256:" + "0".repeat(64) })));
  assert.equal(stale.status, 412);
  assert.deepEqual(await outcomeAt(router, "look-2"), { status: 200, body: { kind: "conflict", actual: created.version } });
  const staleAgain = await answer(await router(identifiedPut("concepts/look", "v2", { "Idempotency-Key": "look-2", "If-Match": "sha256:" + "0".repeat(64) })));
  assert.deepEqual(staleAgain, stale);
  assert.equal((await serverBackend.versions("concepts/look")).length, 1);
});

test("wire: identified DELETE requires If-Match, applies once, replays deleted:true, and is looked up as committed at the deleted revision", async () => {
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-identified-delete", backend: serverBackend };
  const router = createRouter(bundle);
  const { version } = await writeDocVersioned(bundle, { id: "concepts/gone", frontmatter: { type: "T", timestamp: T_DOC }, body: "x" });

  const noPremise = await router(identifiedDelete("concepts/gone", { "Idempotency-Key": "del-1" }));
  assert.equal(noPremise.status, 400);
  assert.match(((await noPremise.json()) as { error: { message: string } }).error.message, /If-Match/);
  assert.equal(await serverBackend.exists("concepts/gone"), true);
  assert.equal((await outcomeAt(router, "del-1")).status, 404);

  // A premise that is not a content-addressed version is refused before the key is claimed:
  // nothing is recorded, so the key stays free and the lookup stays 404.
  for (const premise of ["hello", ""]) {
    const malformed = await router(identifiedDelete("concepts/gone", { "Idempotency-Key": "del-1", "If-Match": premise }));
    assert.equal(malformed.status, 400, `If-Match ${JSON.stringify(premise)}`);
    const body = (await malformed.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "USAGE");
    assert.match(body.error.message, /well-formed If-Match/);
    assert.equal(await serverBackend.exists("concepts/gone"), true);
    assert.equal((await outcomeAt(router, "del-1")).status, 404);
  }

  const deleted = await answer(await router(identifiedDelete("concepts/gone", { "Idempotency-Key": "del-1", "If-Match": version })));
  assert.equal(deleted.status, 200);
  assert.deepEqual(JSON.parse(deleted.body), { deleted: true });
  assert.equal(deleted.version, version);
  assert.equal(deleted.etag, `"${version}"`);
  assert.equal(await serverBackend.exists("concepts/gone"), false);

  // The duplicate replays the record: deleted:true, not the deleted:false a fresh delete would answer.
  const again = await answer(await router(identifiedDelete("concepts/gone", { "Idempotency-Key": "del-1", "If-Match": version })));
  assert.deepEqual(again, deleted);
  assert.deepEqual(await outcomeAt(router, "del-1"), { status: 200, body: { kind: "committed", version } });

  // A new identity on the now-absent target is the idempotent success, still named by its premise.
  const absent = await answer(await router(identifiedDelete("concepts/gone", { "Idempotency-Key": "del-2", "If-Match": version })));
  assert.equal(absent.status, 200);
  assert.deepEqual(JSON.parse(absent.body), { deleted: false });
  assert.equal(absent.version, version);
  assert.deepEqual(await outcomeAt(router, "del-2"), { status: 200, body: { kind: "committed", version } });

  // An unidentified, unconditional delete still carries no version headers.
  const plain = await answer(await router(identifiedDelete("concepts/gone")));
  assert.equal(plain.status, 200);
  assert.equal(plain.version, null);
});

test("wire: the same Idempotency-Key resubmitted for a different id or method is 400 USAGE with details.recorded, and nothing else is applied", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-identified-binding", backend: serverBackend });
  const created = await answer(await router(identifiedPut("concepts/a", "a", { "Idempotency-Key": "bind-1", "If-None-Match": "*" })));
  assert.equal(created.status, 201);

  for (const request of [
    identifiedPut("concepts/b", "b", { "Idempotency-Key": "bind-1", "If-None-Match": "*" }),
    identifiedDelete("concepts/a", { "Idempotency-Key": "bind-1", "If-Match": created.version! }),
  ]) {
    const res = await router(request);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; details?: { recorded?: { method: string; id: string } } } };
    assert.equal(body.error.code, "USAGE");
    assert.deepEqual(body.error.details?.recorded, { method: "PUT", id: "concepts/a" });
  }
  assert.equal(await serverBackend.exists("concepts/b"), false);
  assert.equal(await serverBackend.exists("concepts/a"), true);
  assert.deepEqual(await outcomeAt(router, "bind-1"), { status: 200, body: { kind: "committed", version: created.version } });
});

test("wire: an invalid Idempotency-Key (empty, 129 characters, containing a space, '.' or '..') is 400 USAGE, records nothing, and never reaches the backend", async () => {
  const { router, spy } = freshSpiedRouter();
  for (const key of ["", "k".repeat(129), "has space", ".", ".."]) {
    const res = await router(identifiedPut("concepts/never", "x", { "Idempotency-Key": key, "If-None-Match": "*" }));
    assert.equal(res.status, 400, `key ${JSON.stringify(key)}`);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "USAGE");
  }
  assert.deepEqual(spy.calls, []);
  for (const key of ["k".repeat(129), "has space"]) {
    const res = await router(lookup(key));
    assert.equal(res.status, 400, `lookup ${JSON.stringify(key)}`);
  }
  const valid = await router(identifiedPut("concepts/never", "x", { "Idempotency-Key": "k".repeat(128), "If-None-Match": "*" }));
  assert.equal(valid.status, 201);
});

test("wire: a router without an outcome store refuses Idempotency-Key and the lookup route with 400 USAGE and reports operations:false; with a store, Idempotency-Key on any other endpoint is 400 USAGE", async () => {
  const bare = new SpyBackend(new ServerMemoryBackend());
  const withoutStore = createRouterForBackend(bare, { outcomes: null });
  const caps = (await (await withoutStore(new Request("http://wire.local/v0/capabilities"))).json()) as { operations: boolean };
  assert.equal(caps.operations, false);
  const refused = await withoutStore(identifiedPut("concepts/x", "x", { "Idempotency-Key": "no-store", "If-None-Match": "*" }));
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: { message: string } }).error.message, /not supported by this host/);
  const refusedLookup = await withoutStore(lookup("no-store"));
  assert.equal(refusedLookup.status, 400);
  assert.deepEqual(bare.calls, []);
  // Without identity the same router still writes.
  assert.equal((await withoutStore(identifiedPut("concepts/x", "x", { "If-None-Match": "*" }))).status, 201);

  const { router, spy } = freshSpiedRouter();
  const withStoreCaps = (await (await router(new Request("http://wire.local/v0/capabilities"))).json()) as { operations: boolean };
  assert.equal(withStoreCaps.operations, true);
  const elsewhere = [
    new Request("http://wire.local/v0/bundles/test/reserved/log.md", { method: "PUT", headers: { "content-type": "application/json", "Idempotency-Key": "k1" }, body: JSON.stringify({ content: "log" }) }),
    new Request("http://wire.local/v0/bundles/test/blobs/assets/a.bin", { method: "PUT", headers: { "content-type": "application/octet-stream", "Idempotency-Key": "k2" }, body: "bytes" }),
    new Request("http://wire.local/v0/bundles/test/blobs/assets/a.bin", { method: "DELETE", headers: { "Idempotency-Key": "k3" } }),
    new Request("http://wire.local/v0/bundles/test/docs/concepts/x", { method: "GET", headers: { "Idempotency-Key": "k4" } }),
    new Request("http://wire.local/v0/capabilities", { headers: { "Idempotency-Key": "k5" } }),
  ];
  for (const request of elsewhere) {
    const res = await router(request);
    assert.equal(res.status, 400, `${request.method} ${new URL(request.url).pathname}`);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "USAGE");
  }
  assert.deepEqual(spy.calls, []);
});

test("wire: a recorded outcome expires after the retention window; a resubmission after expiry with the original If-Match answers 412 whose actual is the first application's version", async () => {
  let now = 1_000_000;
  const store = new MemoryOperationOutcomeStore({ retentionMs: 60_000, now: () => now });
  const serverBackend = new ServerMemoryBackend();
  const bundle: Bundle = { root: "mem://wire-retention", backend: serverBackend };
  const router = createRouter(bundle, { outcomes: store });
  const { version: base } = await writeDocVersioned(bundle, { id: "concepts/ttl", frontmatter: { type: "T", timestamp: T_DOC }, body: "v1" });

  const committed = await answer(await router(identifiedPut("concepts/ttl", "v2", { "Idempotency-Key": "ttl-1", "If-Match": base })));
  assert.equal(committed.status, 200);
  assert.equal(store.size, 1);
  now += 59_999;
  assert.deepEqual(await outcomeAt(router, "ttl-1"), { status: 200, body: { kind: "committed", version: committed.version } });
  now += 1;
  assert.equal((await outcomeAt(router, "ttl-1")).status, 404);

  // The premise makes expiry safe: the write's own commit is what the resubmission conflicts with.
  const resubmitted = await router(identifiedPut("concepts/ttl", "v2", { "Idempotency-Key": "ttl-1", "If-Match": base }));
  assert.equal(resubmitted.status, 412);
  const conflict = (await resubmitted.json()) as { error: { details: { expected: string; actual: string } } };
  assert.equal(conflict.error.details.expected, base);
  assert.equal(conflict.error.details.actual, committed.version);
  assert.deepEqual(await outcomeAt(router, "ttl-1"), { status: 200, body: { kind: "conflict", actual: committed.version } });
  assert.equal((await serverBackend.versions("concepts/ttl")).length, 2);
  assert.equal(store.size, 1, "recording pruned the expired record");
});

test("wire: MemoryOperationOutcomeStore releases the claim and settles waiters with null when the clock throws inside record", async () => {
  let clockFails = false;
  const store = new MemoryOperationOutcomeStore({
    now: () => {
      if (clockFails) throw new Error("clock exploded");
      return 1_000;
    },
  });
  const claimed = await store.claim("bundle", "clock-1");
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed") return;
  const waiting = await store.claim("bundle", "clock-1");
  assert.equal(waiting.kind, "in_progress");
  const settled = waiting.kind === "in_progress" ? waiting.settled : Promise.resolve(undefined);

  const operation = { method: "PUT", id: "concepts/c", response: { status: 200, headers: [], body: "{}" }, outcome: { kind: "committed", version: "sha256:" + "0".repeat(64) } } as const;
  clockFails = true;
  assert.throws(() => claimed.record(operation), /clock exploded/);
  assert.equal(await settled, null, "the waiter is told the claim was released, not left hanging");
  assert.equal(store.size, 0);
  assert.equal(await store.lookup("bundle", "clock-1"), null);
  clockFails = false;
  assert.throws(() => claimed.record(operation), /already recorded or released/);

  // The key is free again: a fresh claim records once the clock behaves.
  const again = await store.claim("bundle", "clock-1");
  assert.equal(again.kind, "claimed");
  if (again.kind !== "claimed") return;
  assert.equal(again.record(operation).recordedAt, 1_000);
  assert.equal((await store.lookup("bundle", "clock-1"))?.outcome.kind, "committed");
});

test("wire: the operation transport reads capabilities once before its first submission or lookup and refuses a host that reports operations:false, so nothing identified reaches it", async () => {
  const bare = new SpyBackend(new ServerMemoryBackend());
  const withoutStore = createRouterForBackend(bare, { outcomes: null });
  const unsupported = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: withoutStore, maxRetries: 0 });
  // The memory backend reports no history and no enforced CAS; the point here is `operations`.
  assert.deepEqual(await unsupported.wireCapabilities(), { history: false, enforced_cas: false, projections: true, backlinks: false, blobs: true, operations: false });
  await assert.rejects(openRemoteOperationTransport(unsupported), (err: unknown) => err instanceof OperationsUnsupportedError && err.code === "OPERATIONS_UNSUPPORTED");

  const intent: OperationIntent = {
    requestId: "op-preflight",
    kind: "document.write",
    target: "concepts/preflight",
    base: null,
    local: "sha256:local",
    content: stringifyDoc({ type: "T", timestamp: T_DOC }, "x"),
    createdAt: T_DOC,
    attempts: 0,
    state: "pending",
  };
  const lazy = createRemoteOperationTransport(unsupported);
  await assert.rejects(lazy.submit(intent), OperationsUnsupportedError);
  await assert.rejects(lazy.lookup("op-preflight"), OperationsUnsupportedError);
  assert.deepEqual(bare.calls, [], "no write and no read reached the unsupported host's backend");

  // A supported host is asked once; later submissions and lookups do not repeat the read.
  const { router } = freshSpiedRouter();
  let capabilityReads = 0;
  const counting = async (request: Request) => {
    if (new URL(request.url).pathname === "/v0/capabilities") capabilityReads += 1;
    return router(request);
  };
  const supported = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: counting, maxRetries: 0 });
  const transport = createRemoteOperationTransport(supported);
  const first = await transport.submit(intent);
  assert.equal(first.kind, "committed");
  assert.equal((await transport.lookup("op-preflight"))?.kind, "committed");
  assert.equal(capabilityReads, 1);

  // A check that cannot reach the authority fails like a carrier error and is retried next time.
  let reachable = false;
  const flaky = async (request: Request) => {
    if (!reachable) throw new TypeError("fetch failed: authority unreachable");
    return counting(request);
  };
  const retrying = createRemoteOperationTransport(new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: flaky, maxRetries: 0 }));
  await assert.rejects(retrying.lookup("op-preflight"), TypeError);
  reachable = true;
  assert.equal((await retrying.lookup("op-preflight"))?.kind, "committed");
  assert.equal(capabilityReads, 2);
});

test("wire: MemoryOperationOutcomeStore prunes expired records from the front and stops at the first live one", async () => {
  let clock = 0;
  const store = new MemoryOperationOutcomeStore({ retentionMs: 25, now: () => clock });
  const operation = { method: "PUT", id: "concepts/c", response: { status: 200, headers: [], body: "{}" }, outcome: { kind: "committed", version: "sha256:" + "0".repeat(64) } } as const;
  const record = async (key: string): Promise<void> => {
    const claimed = await store.claim("bundle", key);
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind === "claimed") claimed.record(operation);
  };
  await record("k1");
  clock = 10;
  await record("k2");
  clock = 20;
  await record("k3");
  assert.equal(store.size, 3);
  // At 36 only k1 and k2 (recorded at 0 and 10) are past the 25 ms window; the scan stops at k3.
  clock = 36;
  await record("k4");
  assert.equal(store.size, 2);
  assert.equal(await store.lookup("bundle", "k1"), null);
  assert.equal(await store.lookup("bundle", "k2"), null);
  assert.equal((await store.lookup("bundle", "k3"))?.recordedAt, 20);
  assert.equal((await store.lookup("bundle", "k4"))?.recordedAt, 36);
  // Nothing expired: a record scans one live entry and keeps everything.
  clock = 37;
  await record("k5");
  assert.equal(store.size, 3);
  // A lookup drops an expired record on its own; the next record's scan starts at what is left.
  clock = 70;
  assert.equal(await store.lookup("bundle", "k3"), null);
  assert.equal(store.size, 2);
  await record("k6");
  assert.equal(store.size, 1);
});

/** A backend whose next `failures` writes reject with a runtime error after a tick, then behave. */
class FlakyWriteBackend extends ServerMemoryBackend {
  failures = 0;
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("storage exploded");
    }
    return super.write(id, doc, options);
  }
}

test("wire: an identified PUT whose application throws records nothing and releases the key, so a later submission applies, including one that was waiting on the failed claim", async () => {
  const backend = new FlakyWriteBackend();
  const router = createRouter({ root: "mem://wire-identified-release", backend });

  backend.failures = 1;
  const failed = await router(identifiedPut("concepts/flaky", "v1", { "Idempotency-Key": "flaky-1", "If-None-Match": "*" }));
  assert.equal(failed.status, 500);
  assert.equal((await outcomeAt(router, "flaky-1")).status, 404);
  const applied = await answer(await router(identifiedPut("concepts/flaky", "v1", { "Idempotency-Key": "flaky-1", "If-None-Match": "*" })));
  assert.equal(applied.status, 201);
  assert.deepEqual(await outcomeAt(router, "flaky-1"), { status: 200, body: { kind: "committed", version: applied.version } });

  // A waiter on a claim that is released re-claims and applies fresh rather than inheriting the failure.
  backend.failures = 1;
  const [first, second] = await Promise.all([
    router(identifiedPut("concepts/flaky-2", "v1", { "Idempotency-Key": "flaky-2", "If-None-Match": "*" })),
    router(identifiedPut("concepts/flaky-2", "v1", { "Idempotency-Key": "flaky-2", "If-None-Match": "*" })),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 500]);
  const settled = await answer(first.status === 201 ? first : second);
  assert.deepEqual(await outcomeAt(router, "flaky-2"), { status: 200, body: { kind: "committed", version: settled.version } });
  assert.equal((await backend.versions("concepts/flaky-2")).length, 1);
});

test("wire: RemoteBackend sends Idempotency-Key from requestId, rejects a malformed one before any request leaves, and lookupOperation maps 404 to null", async () => {
  const serverBackend = new ServerMemoryBackend();
  let sent = 0;
  const router = createRouter({ root: "mem://wire-remote-identity", backend: serverBackend });
  const counting = (request: Request) => {
    sent += 1;
    return router(request);
  };
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: counting, maxRetries: 0 });
  const doc: OkfDocument = { id: "concepts/rb", frontmatter: { type: "T", timestamp: T_DOC }, body: "one" };

  const version = await remote.write("concepts/rb", doc, { expectedVersion: null, requestId: "rb-1" });
  assert.equal(await remote.write("concepts/rb", { ...doc, body: "one again" }, { expectedVersion: null, requestId: "rb-1" }), version);
  assert.equal((await serverBackend.versions("concepts/rb")).length, 1);
  assert.deepEqual(await remote.lookupOperation("rb-1"), { kind: "committed", version });
  assert.equal(await remote.lookupOperation("rb-never"), null);

  const before = sent;
  await assert.rejects(remote.write("concepts/rb", doc, { requestId: "bad key" }), (err: unknown) => err instanceof InvalidInputError);
  await assert.rejects(remote.delete("concepts/rb", { expectedVersion: version, requestId: "" }), (err: unknown) => err instanceof InvalidInputError);
  await assert.rejects(remote.lookupOperation("k".repeat(129)), (err: unknown) => err instanceof InvalidInputError);
  for (const key of [".", ".."]) {
    await assert.rejects(remote.write("concepts/rb", doc, { requestId: key }), (err: unknown) => err instanceof InvalidInputError);
    await assert.rejects(remote.lookupOperation(key), (err: unknown) => err instanceof InvalidInputError);
  }
  assert.equal(sent, before, "a malformed identity never becomes a request");

  assert.equal(await remote.delete("concepts/rb", { expectedVersion: version, requestId: "rb-del" }), true);
  assert.equal(await remote.delete("concepts/rb", { expectedVersion: version, requestId: "rb-del" }), true, "the duplicate replays the record");
  assert.deepEqual(await remote.lookupOperation("rb-del"), { kind: "committed", version });
});

test("wire: createRemoteOperationTransport delivers a document.write intent as an identified guarded PUT and maps committed, conflict and refused; lookup reads the record", async () => {
  const serverBackend = new ServerMemoryBackend();
  const router = createRouter({ root: "mem://wire-remote-operations", backend: serverBackend });
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: router, maxRetries: 0 });
  const transport = createRemoteOperationTransport(remote, { actor: "human:tester" });
  const frontmatter = { type: "T", timestamp: T_DOC };
  const intent = (requestId: string, target: string, base: string | null, body: string): OperationIntent => ({
    requestId,
    kind: "document.write",
    target,
    base,
    local: "sha256:local",
    content: stringifyDoc(frontmatter, body),
    createdAt: T_DOC,
    attempts: 1,
    state: "in_flight",
  });

  const committed = await transport.submit(intent("op-1", "concepts/op", null, "first"));
  assert.equal(committed.kind, "committed");
  const version = committed.kind === "committed" ? committed.version : "";
  assert.equal((await serverBackend.read("concepts/op")).version, version);
  assert.equal((await serverBackend.versions("concepts/op"))[0]?.actor, "human:tester");
  assert.deepEqual(await transport.lookup("op-1"), { kind: "committed", version });
  assert.equal(await transport.lookup("op-none"), null);
  // The same identity delivered again is answered from the record, not applied.
  assert.deepEqual(await transport.submit(intent("op-1", "concepts/op", null, "first")), { kind: "committed", version });
  assert.equal((await serverBackend.versions("concepts/op")).length, 1);

  assert.deepEqual(await transport.submit(intent("op-2", "concepts/op", "sha256:" + "0".repeat(64), "stale")), { kind: "conflict", actual: version });
  // The engine's own rejection (a document with no type) comes back as a typed refusal.
  const untyped = { ...intent("op-3", "concepts/untyped", null, "x"), content: stringifyDoc({ title: "no type", timestamp: T_DOC }, "x") };
  const refused = await transport.submit(untyped);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.kind === "refused" && refused.code, "USAGE");
  assert.deepEqual(await transport.lookup("op-3"), refused, "a content rejection is a recorded outcome");
  await assert.rejects(transport.submit({ ...intent("op-4", "concepts/op", null, "x"), kind: "document.delete" }), /unsupported intent kind/);
});

test("wire: createRemoteOperationTransport rethrows a 5xx RemoteError so the primitive classifies it as unknown and looks up, while a 4xx refusal stays refused", async () => {
  const envelope = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: `${code} from the wire` } }), { status, headers: { "content-type": "application/json" } });
  let status = 503;
  let code = "RUNTIME";
  const supported = { history: false, enforced_cas: false, projections: true, backlinks: false, blobs: true, operations: true };
  const fetchImpl = async (request: Request) =>
    new URL(request.url).pathname === "/v0/capabilities"
      ? new Response(JSON.stringify(supported), { status: 200, headers: { "content-type": "application/json" } })
      : envelope(status, code);
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl, maxRetries: 0 });
  const transport = createRemoteOperationTransport(remote);
  const intent: OperationIntent = {
    requestId: "op-5xx",
    kind: "document.write",
    target: "concepts/op",
    base: null,
    local: "sha256:local",
    content: stringifyDoc({ type: "T", timestamp: T_DOC }, "x"),
    createdAt: T_DOC,
    attempts: 1,
    state: "in_flight",
  };

  await assert.rejects(transport.submit(intent), (err: unknown) => err instanceof RemoteError && err.status === 503 && err.code === "RUNTIME");
  status = 502;
  code = "BAD_GATEWAY";
  await assert.rejects(transport.submit(intent), (err: unknown) => err instanceof RemoteError && err.status === 502);

  status = 403;
  code = "FORBIDDEN";
  assert.deepEqual(await transport.submit(intent), { kind: "refused", code: "FORBIDDEN", message: "FORBIDDEN from the wire" });
});
