/**
 * Wire error classification is a client-behavior contract, not cosmetic status shaping:
 * caller input must fail immediately as `400 USAGE`, while an unknown storage/runtime
 * failure must remain a retryable `500 RUNTIME`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend, RemoteBackend, type ConceptId } from "@superbee/core";

import { createRouterForBackend } from "../src/legacy-router.js";

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
  const router = createRouterForBackend(new RuntimeFailingBackend());
  const res = await router(new Request("http://wire.local/v0/bundles/default/docs/concepts/a"));

  assert.equal(res.status, 500);
  assert.deepEqual((await res.json()) as ErrorEnvelope, {
    error: { code: "RUNTIME", message: "internal server error" },
  });
});

test("router-owned invalid input remains 400 USAGE", async () => {
  const router = createRouterForBackend(new MemoryBackend());
  const cases = [
    "http://wire.local/v0/bundles/default/docs/index",
    "http://wire.local/v0/bundles/default/docs/%E0%A4%A",
    "http://wire.local/v0/bundles/default/blobs/%E0%A4%A",
    `http://wire.local/v0/bundles/default/reserved/log.md?dir=${encodeURIComponent("../outside")}`,
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
  const router = createRouterForBackend(new MemoryBackend());
  const res = await router(
    new Request("http://wire.local/v0/bundles/default/docs/concepts/a", {
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

test("RemoteBackend retries a router-classified runtime failure and succeeds", async () => {
  const backend = new FailOnceBackend();
  await backend.write("concepts/a", {
    id: "concepts/a",
    frontmatter: { type: "Concept", title: "A" },
    body: "hello",
  });

  const router = createRouterForBackend(backend);
  const remote = new RemoteBackend({
    baseUrl: "http://wire.local",
    bundle: "default",
    fetchImpl: router,
    maxRetries: 1,
  });

  const result = await remote.read("concepts/a");
  assert.equal(result.doc.body, "hello");
  assert.equal(backend.readAttempts, 2);
});
