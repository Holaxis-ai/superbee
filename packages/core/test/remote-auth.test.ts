/**
 * `RemoteBackend` auth + error-code surfacing (Stage-1 Unit 2b Part C, additive to the
 * wire-protocol v0 client — see `remote-backend.ts`'s module doc). Two things pinned here
 * that `wire-protocol.test.ts`'s tri-backend contract suite does not (and must not, per the
 * unit's constraint that suite stays UNMODIFIED):
 *
 *   1. `authToken` rides `Authorization: Bearer <token>` on EVERY request when configured,
 *      and is simply absent when it isn't (the reference server never enforces it either
 *      way, so this is pure request-shape verification against a stub transport).
 *   2. A non-404/412 non-2xx response is now a typed `RemoteError` carrying the envelope's
 *      `code` + the raw HTTP `status` (closing `docs/WIRE-PROTOCOL.md`'s previously-open
 *      "client-side error envelope carries no code" gap) — with a status-derived fallback
 *      code when the envelope is missing or unparseable.
 *
 * A stub `fetchImpl` is used throughout (no router, no sockets) so these tests exercise
 * ONLY `RemoteBackend`'s own request-building / response-parsing logic in isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RemoteBackend, RemoteError } from "../src/remote-backend.js";
import { InvalidInputError } from "../src/errors.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("RemoteBackend rejects non-canonical bundle aliases before constructing a request", () => {
  assert.throws(
    () => new RemoteBackend({ baseUrl: "https://worker.example", bundleId: "default" as never }),
    (err: unknown) => err instanceof InvalidInputError && /invalid bundle id/.test(err.message),
  );
});

test("RemoteBackend: authToken is sent as Authorization: Bearer <token> on every request", async () => {
  const seenAuth: (string | null)[] = [];
  const remote = new RemoteBackend({
    baseUrl: "http://auth.local",
    bundleId: "bnd_11111111111111111111111111111111",
    authToken: "secret-token",
    fetchImpl: async (req: Request) => {
      seenAuth.push(req.headers.get("Authorization"));
      return jsonResponse(200, { docs: [], next_cursor: null });
    },
  });

  await remote.list();
  await remote.list("prefix/");

  assert.deepEqual(seenAuth, ["Bearer secret-token", "Bearer secret-token"]);
});

test("RemoteBackend: no Authorization header is sent when authToken is not configured", async () => {
  let seenAuth: string | null | undefined;
  const remote = new RemoteBackend({
    baseUrl: "http://noauth.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async (req: Request) => {
      seenAuth = req.headers.get("Authorization");
      return jsonResponse(200, { docs: [], next_cursor: null });
    },
  });

  await remote.list();
  assert.equal(seenAuth, null);
});

test("RemoteBackend: authToken is merged onto caller-supplied headers, not overwriting them", async () => {
  let seen: { auth: string | null; contentType: string | null } | undefined;
  const remote = new RemoteBackend({
    baseUrl: "http://merge.local",
    bundleId: "bnd_11111111111111111111111111111111",
    authToken: "tok",
    fetchImpl: async (req: Request) => {
      seen = { auth: req.headers.get("Authorization"), contentType: req.headers.get("content-type") };
      return jsonResponse(200, { version: "sha256:" + "0".repeat(64) }, { ETag: "sha256:" + "0".repeat(64) });
    },
  });

  await remote.write("x", { id: "x", frontmatter: { type: "T" }, body: "b" });
  assert.deepEqual(seen, { auth: "Bearer tok", contentType: "application/json" });
});

test("RemoteBackend: a 401 with an AUTH_REQUIRED envelope surfaces as a RemoteError carrying that code + status", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://gated.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(401, { error: { code: "AUTH_REQUIRED", message: "missing or invalid API key" } }),
  });

  await assert.rejects(() => remote.list(), (err: unknown) => {
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, "AUTH_REQUIRED");
    assert.equal(err.status, 401);
    assert.match(err.message, /missing or invalid API key/);
    return true;
  });
});

test("RemoteBackend: a 500 with a RUNTIME envelope surfaces as a RemoteError carrying that code + status (the misclassification this unit closes)", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://broken.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => jsonResponse(500, { error: { code: "RUNTIME", message: "something broke server-side" } }),
  });

  await assert.rejects(() => remote.read("some/id"), (err: unknown) => {
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, "RUNTIME");
    assert.equal(err.status, 500);
    return true;
  });
});

test("RemoteBackend: a 400 USAGE envelope surfaces as a RemoteError with code USAGE, status 400", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://bad-input.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => jsonResponse(400, { error: { code: "USAGE", message: "bad request" } }),
  });

  await assert.rejects(() => remote.write("x", { id: "x", frontmatter: { type: "T" }, body: "" }), (err: unknown) => {
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, "USAGE");
    assert.equal(err.status, 400);
    return true;
  });
});

test("RemoteBackend: a malformed/absent envelope falls back to a status-derived code guess (401->AUTH_REQUIRED, 5xx->RUNTIME, else USAGE)", async () => {
  const cases: Array<[number, string]> = [
    [401, "AUTH_REQUIRED"],
    [503, "RUNTIME"],
    [403, "USAGE"],
  ];
  for (const [status, expectedCode] of cases) {
    const remote = new RemoteBackend({
      baseUrl: "http://malformed.local",
      bundleId: "bnd_11111111111111111111111111111111",
      fetchImpl: async () => new Response("not json", { status }),
    });
    await assert.rejects(() => remote.list(), (err: unknown) => {
      assert.ok(err instanceof RemoteError);
      assert.equal(err.code, expectedCode);
      assert.equal(err.status, status);
      return true;
    });
  }
});

test("RemoteBackend: 404 and 412 mapping is UNCHANGED by the RemoteError addition (still ENOENT-shaped / VersionConflict, never RemoteError)", async () => {
  const notFound = new RemoteBackend({
    baseUrl: "http://x.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  await assert.rejects(() => notFound.read("missing"), (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
    assert.ok(!(err instanceof RemoteError));
    return true;
  });

  const conflict = new RemoteBackend({
    baseUrl: "http://x.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(412, { error: { code: "VERSION_CONFLICT", message: "stale", details: { expected: "a", actual: "b" } } }),
  });
  await assert.rejects(() => conflict.write("x", { id: "x", frontmatter: { type: "T" }, body: "" }, { expectedVersion: "a" }), (err: unknown) => {
    assert.ok(!(err instanceof RemoteError));
    return true;
  });
});
