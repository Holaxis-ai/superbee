/**
 * RemoteBackend transient-failure retry (tasks/client-retry-transient). The D1 cold-start hiccups
 * observed against the deployed Cloudflare bundle surfaced as HARD failures because the wire client
 * did not retry a transient 5xx. RemoteBackend now retries transient 5xx (500/502/503/504 — a D1
 * cold-start's "storage object reset" is a 500) and network/transport failures only when an
 * operation descriptor makes replay safe: reads and CAS/expect-absent mutations may retry, while
 * unguarded writes/deletes must surface an ambiguous lost response without replaying it.
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

test("retries a transient 500 on a guarded WRITE and re-sends the body on the retry", async () => {
  // The write path shares send(); proving body-reuse across attempts guards against a consumed-stream
  // regression (each attempt rebuilds the Request from the same string body).
  const { impl, state } = scripted([ERR500, { status: 200, body: JSON.stringify({ version: "sha256:committed" }) }]);
  const doc = { id: "concepts/a", frontmatter: { type: "Concept", title: "A" }, body: "hello world" };
  const version = await backend(impl, 3).write("concepts/a", doc, { expectedVersion: "sha256:current" });
  assert.equal(version, "sha256:committed");
  assert.equal(state.calls, 2);
  const sent = JSON.parse(state.bodies[1]!); // attempt 2 must still carry the payload, not an empty body
  assert.equal(sent.body, "hello world");
  assert.equal(sent.frontmatter.title, "A");
});

type MutationMode = "unguarded" | "cas" | "expect-absent";

interface MutationCase {
  readonly name: string;
  readonly supportsExpectAbsent: boolean;
  run(remote: RemoteBackend, mode: MutationMode): Promise<unknown>;
}

const doc = { id: "concepts/a", frontmatter: { type: "Concept", title: "A" }, body: "client" };
const bytes = new Uint8Array([1, 2, 3]);

function writeOptions(mode: MutationMode) {
  if (mode === "cas") return { expectedVersion: "sha256:before" as const };
  if (mode === "expect-absent") return { expectedVersion: null };
  return {};
}

/** Every remote mutation family must pass through the same retry authority. */
const MUTATION_CASES: MutationCase[] = [
  {
    name: "document write",
    supportsExpectAbsent: true,
    run: (remote, mode) => remote.write("concepts/a", doc, writeOptions(mode)),
  },
  {
    name: "reserved-file write",
    supportsExpectAbsent: true,
    run: (remote, mode) => remote.writeReserved("", "index.md", "client\n", writeOptions(mode)),
  },
  {
    name: "blob write",
    supportsExpectAbsent: true,
    run: (remote, mode) => remote.writeBlob("artifacts/a.bin", bytes, undefined, writeOptions(mode)),
  },
  {
    name: "document delete",
    supportsExpectAbsent: false,
    run: (remote, mode) => remote.delete("concepts/a", mode === "cas" ? { expectedVersion: "sha256:before" } : {}),
  },
  {
    name: "blob delete",
    supportsExpectAbsent: false,
    run: (remote, mode) => remote.deleteBlob("artifacts/a.bin", mode === "cas" ? { expectedVersion: "sha256:before" } : {}),
  },
];

/**
 * The first call represents a server that commits the client mutation, loses the response, then
 * lets another writer replace that state. A replay must therefore either be refused (unguarded) or
 * receive a 412 against the original premise (CAS/expect-absent).
 */
function lostResponseWithInterposedWriter() {
  const lost = new Error("lost response after commit");
  const state = {
    calls: 0,
    current: "sha256:before",
    events: [] as string[],
    requestGuards: [] as Array<{ ifMatch: string | null; ifNoneMatch: string | null }>,
  };
  const impl = async (req: Request): Promise<Response> => {
    state.calls++;
    state.requestGuards.push({ ifMatch: req.headers.get("if-match"), ifNoneMatch: req.headers.get("if-none-match") });
    if (state.calls === 1) {
      state.current = "sha256:client-commit";
      state.events.push("client committed");
      state.current = "sha256:interposed-writer";
      state.events.push("interposed writer committed");
      throw lost;
    }
    return new Response(
      JSON.stringify({
        error: {
          code: "VERSION_CONFLICT",
          details: { expected: req.headers.get("if-none-match") ? null : req.headers.get("if-match"), actual: state.current },
        },
      }),
      { status: 412 },
    );
  };
  return { impl, state, lost };
}

for (const mutation of MUTATION_CASES) {
  test(`does not replay an unguarded ${mutation.name} after a lost response and interposed writer`, async () => {
    const { impl, state, lost } = lostResponseWithInterposedWriter();
    await assert.rejects(() => mutation.run(backend(impl, 1), "unguarded"), (err: unknown) => err === lost);
    assert.equal(state.calls, 1, "an unguarded mutation must never replay an ambiguous outcome");
    assert.deepEqual(state.events, ["client committed", "interposed writer committed"]);
    assert.equal(state.current, "sha256:interposed-writer");
    assert.deepEqual(state.requestGuards, [{ ifMatch: null, ifNoneMatch: null }]);
  });

  test(`does not replay an unguarded ${mutation.name} after an ambiguous transient 500`, async () => {
    let calls = 0;
    const impl = async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ error: { code: "RUNTIME", message: "response may have been lost after commit" } }), {
        status: 500,
      });
    };
    await assert.rejects(
      () => mutation.run(backend(impl, 1), "unguarded"),
      (err: unknown) => err instanceof RemoteError && err.status === 500,
    );
    assert.equal(calls, 1, "an unguarded mutation must not replay a possibly post-commit 5xx");
  });

  test(`replays a CAS-guarded ${mutation.name} after a lost response and surfaces the interposed writer conflict`, async () => {
    const { impl, state } = lostResponseWithInterposedWriter();
    await assert.rejects(
      () => mutation.run(backend(impl, 1), "cas"),
      (err: unknown) => err instanceof VersionConflict && err.expected === "sha256:before" && err.actual === "sha256:interposed-writer",
    );
    assert.equal(state.calls, 2, "a guarded mutation may retry its original CAS premise once");
    assert.deepEqual(state.events, ["client committed", "interposed writer committed"]);
    assert.equal(state.current, "sha256:interposed-writer");
    assert.deepEqual(state.requestGuards, [
      { ifMatch: "sha256:before", ifNoneMatch: null },
      { ifMatch: "sha256:before", ifNoneMatch: null },
    ]);
  });

  if (mutation.supportsExpectAbsent) {
    test(`replays an expect-absent ${mutation.name} after a lost response and surfaces the interposed writer conflict`, async () => {
      const { impl, state } = lostResponseWithInterposedWriter();
      await assert.rejects(
        () => mutation.run(backend(impl, 1), "expect-absent"),
        (err: unknown) => err instanceof VersionConflict && err.expected === null && err.actual === "sha256:interposed-writer",
      );
      assert.equal(state.calls, 2, "an expect-absent mutation may retry its original creation premise once");
      assert.deepEqual(state.events, ["client committed", "interposed writer committed"]);
      assert.equal(state.current, "sha256:interposed-writer");
      assert.deepEqual(state.requestGuards, [
        { ifMatch: null, ifNoneMatch: "*" },
        { ifMatch: null, ifNoneMatch: "*" },
      ]);
    });
  }
}

test("maxRetries: 0 disables retry", async () => {
  const { impl, state } = scripted([ERR500]);
  await assert.rejects(() => backend(impl, 0).exists("concepts/a"), (e: unknown) => e instanceof RemoteError);
  assert.equal(state.calls, 1);
});
