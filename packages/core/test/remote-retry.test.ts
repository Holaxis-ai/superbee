/**
 * RemoteBackend transient-failure retry (tasks/client-retry-transient). The D1 cold-start hiccups
 * observed against the deployed Cloudflare bundle surfaced as HARD failures because the wire client
 * did not retry a transient 5xx. `send()` now retries a transient 5xx (500/502/503/504 — a D1
 * cold-start's "storage object reset" is a 500) or a network/transport error with exponential
 * backoff, while a REAL result (2xx, 4xx incl. 412 VersionConflict, 401) returns immediately.
 *
 * Uses a scripted `fetchImpl` (RemoteBackend accepts one) so no server is booted; `exists()` is the
 * probe because it decides purely on status (no body/header parsing). maxRetries is kept small so
 * the real backoff delays stay sub-second.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RemoteBackend, RemoteError } from "../src/remote-backend.js";
import { VersionConflict } from "../src/index.js";

type Step = { status?: number; body?: string; throwErr?: Error };

/** A fetchImpl returning a scripted sequence (the LAST step repeats); counts calls, records per-call bodies. */
function scripted(steps: Step[]): { impl: (r: Request) => Promise<Response>; state: { calls: number; bodies: string[] } } {
  const state: { calls: number; bodies: string[] } = { calls: 0, bodies: [] };
  const impl = async (req: Request): Promise<Response> => {
    const step = steps[Math.min(state.calls, steps.length - 1)]!;
    state.bodies.push(await req.text()); // "" for bodyless GET/HEAD; the PUT payload otherwise
    state.calls++;
    if (step.throwErr) throw step.throwErr;
    return new Response(step.body ?? "", { status: step.status ?? 200 });
  };
  return { impl, state };
}

function backend(impl: (r: Request) => Promise<Response>, maxRetries?: number): RemoteBackend {
  return new RemoteBackend({ baseUrl: "http://x", bundle: "default", fetchImpl: impl, maxRetries });
}

const ERR500: Step = { status: 500, body: JSON.stringify({ error: { code: "RUNTIME", message: "D1_ERROR: storage caused object to be reset" } }) };

test("retries a transient 500 and then succeeds", async () => {
  const { impl, state } = scripted([ERR500, { status: 200 }]);
  assert.equal(await backend(impl, 3).exists("concepts/a"), true);
  assert.equal(state.calls, 2); // 1 retry then success
});

test("gives up after maxRetries on a PERSISTENT 500 (returns the real RUNTIME error)", async () => {
  const { impl, state } = scripted([ERR500]);
  await assert.rejects(
    () => backend(impl, 2).exists("concepts/a"),
    (e: unknown) => {
      assert.ok(e instanceof RemoteError);
      assert.equal(e.status, 500);
      return true;
    },
  );
  assert.equal(state.calls, 3); // 1 initial + 2 retries
});

test("does NOT retry a 412 — VersionConflict is a real result, not transient", async () => {
  const { impl, state } = scripted([
    { status: 412, body: JSON.stringify({ error: { code: "VERSION_CONFLICT", details: { expected: "sha256:a", actual: "sha256:b" } } }) },
  ]);
  await assert.rejects(
    () => backend(impl, 3).exists("concepts/a"),
    (e: unknown) => e instanceof VersionConflict,
  );
  assert.equal(state.calls, 1); // immediate, no retry
});

test("does NOT retry a 4xx (USAGE)", async () => {
  const { impl, state } = scripted([{ status: 400, body: JSON.stringify({ error: { code: "USAGE", message: "bad" } }) }]);
  await assert.rejects(
    () => backend(impl, 3).exists("concepts/a"),
    (e: unknown) => e instanceof RemoteError && e.status === 400,
  );
  assert.equal(state.calls, 1);
});

test("retries a network/transport error and then succeeds", async () => {
  const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const { impl, state } = scripted([{ throwErr: netErr }, { status: 200 }]);
  assert.equal(await backend(impl, 3).exists("concepts/a"), true);
  assert.equal(state.calls, 2);
});

test("retries a transient 500 on a WRITE and re-sends the body on the retry", async () => {
  // The write path shares send(); proving body-reuse across attempts guards against a consumed-stream
  // regression (each attempt rebuilds the Request from the same string body).
  const { impl, state } = scripted([ERR500, { status: 200, body: JSON.stringify({ version: "sha256:committed" }) }]);
  const doc = { id: "concepts/a", frontmatter: { type: "Concept", title: "A" }, body: "hello world" };
  const version = await backend(impl, 3).write("concepts/a", doc);
  assert.equal(version, "sha256:committed");
  assert.equal(state.calls, 2);
  const sent = JSON.parse(state.bodies[1]!); // attempt 2 must still carry the payload, not an empty body
  assert.equal(sent.body, "hello world");
  assert.equal(sent.frontmatter.title, "A");
});

test("a write with an ambiguous first response fails closed when the retry observes a conflict", async () => {
  const transportFailure = new Error("connection closed after request dispatch");
  const { impl, state } = scripted([
    { throwErr: transportFailure },
    {
      status: 412,
      body: JSON.stringify({
        error: { code: "VERSION_CONFLICT", details: { expected: null, actual: "sha256:already-present" } },
      }),
    },
  ]);
  const doc = { id: "concepts/a", frontmatter: { type: "Concept" }, body: "hello world" };

  await assert.rejects(
    () => backend(impl, 1).write("concepts/a", doc, { expectedVersion: null }),
    (error: unknown) => error instanceof VersionConflict,
  );
  assert.equal(state.calls, 2);
});

test("maxRetries: 0 disables retry", async () => {
  const { impl, state } = scripted([ERR500]);
  await assert.rejects(() => backend(impl, 0).exists("concepts/a"), (e: unknown) => e instanceof RemoteError);
  assert.equal(state.calls, 1);
});
