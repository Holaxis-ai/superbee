/**
 * Wire error classification is a client-behavior contract, not cosmetic status shaping:
 * caller input must fail immediately as `400 USAGE`, while an unknown storage/runtime
 * failure must remain a retryable `500 RUNTIME`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FRONTMATTER_LIMITS, FrontmatterRefusedError, MemoryBackend, type ConceptId } from "@superbee/core";

import { BUNDLE_ID, oneBackendRouter } from "./support/one-backend-router.js";
import { RemoteBackend } from "../../core/dist/remote-backend.js";

type ErrorEnvelope = { error: { code: string; message: string } };

class RuntimeFailingBackend extends MemoryBackend {
  override async read(_id: ConceptId): ReturnType<MemoryBackend["read"]> {
    throw new Error("SECRET_STACK_SENTINEL /private/internal/path");
  }
}

class FailOnceBackend extends MemoryBackend {
  readAttempts = 0;

  override async read(id: ConceptId): ReturnType<MemoryBackend["read"]> {
    this.readAttempts++;
    if (this.readAttempts === 1) throw new Error("transient storage failure");
    return super.read(id);
  }
}

test("unknown backend failures are 500 RUNTIME, not 400 USAGE", async () => {
  const router = oneBackendRouter(new RuntimeFailingBackend());
  const res = await router(new Request("http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs/concepts/a"));

  assert.equal(res.status, 500);
  assert.deepEqual((await res.json()) as ErrorEnvelope, {
    error: { code: "RUNTIME", message: "internal server error" },
  });
});

test("router-owned invalid input remains 400 USAGE", async () => {
  const router = oneBackendRouter(new MemoryBackend());
  const cases = [
    "http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs/index",
    "http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs/%E0%A4%A",
    "http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/blobs/%E0%A4%A",
    `http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/reserved/log.md?dir=${encodeURIComponent("../outside")}`,
  ];

  for (const url of cases) {
    const res = await router(new Request(url));
    const body = (await res.json()) as ErrorEnvelope;
    assert.equal(res.status, 400, url);
    assert.equal(body.error.code, "USAGE", url);
    assert.ok(body.error.message.length > 0, url);
  }
});

test("a non-string document body is 400 USAGE, not an internal retryable failure", async () => {
  const router = oneBackendRouter(new MemoryBackend());
  const res = await router(
    new Request("http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs/concepts/a", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frontmatter: { type: "Concept" }, body: 42 }),
    }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()) as ErrorEnvelope, {
    error: { code: "USAGE", message: "request body field body must be a string when present" },
  });
});

test("a document PUT whose frontmatter the reader would refuse is 400 USAGE with its code, and stores nothing", async () => {
  const backend = new MemoryBackend();
  const router = oneBackendRouter(backend);
  const url = "http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs/concepts/long";
  const res = await router(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frontmatter: { type: "Concept", description: "v".repeat(FRONTMATTER_LIMITS.sourceChars) }, body: "" }),
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorEnvelope & { error: { details?: { frontmatter?: { code?: string } } } };
  assert.equal(body.error.code, "USAGE");
  assert.equal(body.error.details?.frontmatter?.code, "FRONTMATTER_TOO_LARGE");
  assert.equal((await router(new Request(url))).status, 404);

  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: BUNDLE_ID, fetchImpl: router, maxRetries: 0 });
  await assert.rejects(
    remote.write("concepts/long", { id: "concepts/long", frontmatter: { type: "Concept", description: "v".repeat(FRONTMATTER_LIMITS.sourceChars) }, body: "" }),
    (error: unknown) => error instanceof FrontmatterRefusedError && error.code === "FRONTMATTER_TOO_LARGE",
  );
});

test("a reserved-file PUT whose leading frontmatter the reader would refuse is 400 USAGE and stores nothing", async () => {
  const router = oneBackendRouter(new MemoryBackend());
  const url = "http://wire.local/v0/bundles/bnd_00112233445566778899aabbccddeeff/reserved/index.md?dir=notes";
  const res = await router(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "---\nloop: &l [*l]\n---\n# Notes\n" }),
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorEnvelope & { error: { details?: { frontmatter?: { code?: string } } } };
  assert.equal(body.error.details?.frontmatter?.code, "FRONTMATTER_CYCLE");
  assert.equal((await router(new Request(url))).status, 404);
});

test("RemoteBackend retries a router-classified runtime failure and succeeds", async () => {
  const backend = new FailOnceBackend();
  await backend.write("concepts/a", {
    id: "concepts/a",
    frontmatter: { type: "Concept", title: "A" },
    body: "hello",
  });

  const router = oneBackendRouter(backend);
  const remote = new RemoteBackend({
    baseUrl: "http://wire.local",
    bundle: BUNDLE_ID,
    fetchImpl: router,
    maxRetries: 1,
  });

  const result = await remote.read("concepts/a");
  assert.equal(result.doc.body, "hello\n");
  assert.equal(backend.readAttempts, 2);
});
