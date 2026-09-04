/**
 * Version-token transport regression tests (production repair, Stage-1 Unit 2b): the router's
 * ORIGINAL unquoted `ETag: sha256:<hex>` was RFC-7232-INVALID (strong ETags MUST be quoted).
 * Cloudflare's edge silently STRIPS an invalid ETag when applying Brotli compression (this
 * client's default `fetch` sends `Accept-Encoding: br`), while preserving it on an uncompressed
 * response — verified in production via D1 ground truth + R2 content forensics. `RemoteBackend`
 * then read the header as ABSENT and, before this fix, defaulted the version to `""`, which fed
 * back as the NEXT write's `expectedVersion` produced an EMPTY `If-Match` — the seam treats an
 * absent/empty CAS guard as UNCONDITIONAL, silently downgrading a compare-and-swap write to
 * last-writer-wins and losing concurrent updates.
 *
 * These tests drive `RemoteBackend` against a hand-built mock `fetchImpl` (no router, no
 * sockets) so they exercise ONLY the client-side extraction/validation logic in isolation —
 * `packages/server/test/*` prove the SERVER side (the router actually emits both headers
 * correctly); `packages/core/test/wire-protocol.test.ts` proves the two sides compose correctly
 * end to end through a real router.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RemoteBackend, RemoteError } from "../src/remote-backend.js";
import { InvalidInputError } from "../src/errors.js";

const TOKEN = "sha256:" + "a".repeat(64);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ── (a) both version headers stripped -> loud VERSION_MISSING, never a silent "" ──────────────

test("read(): a response with NEITHER X-Version NOR ETag throws a loud RemoteError(VERSION_MISSING), never silently returns version: ''", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://stripped.local",
    bundleId: "bnd_11111111111111111111111111111111",
    // Simulates the production finding: the edge stripped BOTH version headers.
    fetchImpl: async () => jsonResponse(200, { id: "x", frontmatter: { type: "T" }, body: "b" }),
  });

  await assert.rejects(() => remote.read("x"), (err: unknown) => {
    assert.ok(err instanceof RemoteError, `expected a RemoteError, got ${String(err)}`);
    assert.equal(err.code, "VERSION_MISSING");
    assert.match(err.message, /neither an X-Version nor an ETag/);
    return true;
  });
});

test("readReserved(): a response with NEITHER version header throws VERSION_MISSING, never a silent ''", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://stripped.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => jsonResponse(200, { content: "# Log\n" }),
  });

  await assert.rejects(() => remote.readReserved("", "log.md"), (err: unknown) => {
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, "VERSION_MISSING");
    return true;
  });
});

test("readBlob(): a response with NEITHER version header throws VERSION_MISSING, never a silent ''", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://stripped.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/octet-stream" } }),
  });

  await assert.rejects(() => remote.readBlob("x.bin"), (err: unknown) => {
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, "VERSION_MISSING");
    return true;
  });
});

// ── (b) expectedVersion === "" is rejected BEFORE any request is sent ─────────────────────────

test("write(): expectedVersion: '' throws BEFORE sending a request (never emits an empty If-Match)", async () => {
  let sent = false;
  const remote = new RemoteBackend({
    baseUrl: "http://guard.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => {
      sent = true;
      return jsonResponse(200, { version: TOKEN });
    },
  });

  await assert.rejects(
    () => remote.write("x", { id: "x", frontmatter: { type: "T" }, body: "b" }, { expectedVersion: "" }),
    /expectedVersion must not be an empty string/,
  );
  assert.equal(sent, false, "no request should ever be sent for a malformed expectedVersion");
});

test("writeReserved(): expectedVersion: '' throws BEFORE sending a request", async () => {
  let sent = false;
  const remote = new RemoteBackend({
    baseUrl: "http://guard.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => {
      sent = true;
      return jsonResponse(200, { version: TOKEN });
    },
  });

  await assert.rejects(
    () => remote.writeReserved("", "log.md", "# Log\n", { expectedVersion: "" }),
    /expectedVersion must not be an empty string/,
  );
  assert.equal(sent, false);
});

test("writeBlob(): expectedVersion: '' throws BEFORE sending a request", async () => {
  let sent = false;
  const remote = new RemoteBackend({
    baseUrl: "http://guard.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => {
      sent = true;
      return jsonResponse(200, { version: TOKEN });
    },
  });

  await assert.rejects(
    () => remote.writeBlob("x.bin", new Uint8Array([1]), undefined, { expectedVersion: "" }),
    /expectedVersion must not be an empty string/,
  );
  assert.equal(sent, false);
});

test("write(): expectedVersion: null (expect-absent) and a real token both still work — the guard targets ONLY the empty string", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://guard.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async (req: Request) => {
      assert.equal(req.headers.get("If-None-Match"), "*");
      return jsonResponse(201, { version: TOKEN });
    },
  });
  const version = await remote.write("x", { id: "x", frontmatter: { type: "T" }, body: "b" }, { expectedVersion: null });
  assert.equal(version, TOKEN);
});

// ── (c) a quoted-ETag-only response parses correctly ───────────────────────────────────────────

test("read(): a response with ONLY a properly quoted ETag (no X-Version) parses the bare token via fallback", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://quoted.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(200, { id: "x", frontmatter: { type: "T" }, body: "b" }, { ETag: `"${TOKEN}"` }),
  });

  const result = await remote.read("x");
  assert.equal(result.version, TOKEN);
});

test("read/readMany keep route-owned identity when a foreign payload reports different ids", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://identity.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async (req: Request) => {
      if (req.url.endsWith("/docs:read-many")) {
        return jsonResponse(
          200,
          {
            results: [
              { id: "payload/a", frontmatter: { type: "T" }, body: "a", version: TOKEN },
              { id: "payload/b", frontmatter: { type: "T" }, body: "b", version: TOKEN },
            ],
          },
        );
      }
      return jsonResponse(
        200,
        { id: "payload/renamed", frontmatter: { type: "T" }, body: "one" },
        { "X-Version": TOKEN },
      );
    },
  });

  assert.equal((await remote.read("route/one")).doc.id, "route/one");
  assert.deepEqual((await remote.readMany(["route/a", "route/b"])).map((result) => result.doc.id), [
    "route/a",
    "route/b",
  ]);
});

test("readMany rejects a response whose result count cannot satisfy the positional identity contract", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://identity.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => jsonResponse(200, { results: [] }),
  });
  await assert.rejects(
    () => remote.readMany(["route/a"]),
    (error: unknown) => error instanceof RemoteError && error.code === "RUNTIME" && error.status === 502,
  );
});

test("readBlob(): a response with ONLY a quoted ETag parses correctly", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://quoted.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream", ETag: `"${TOKEN}"` },
      }),
  });

  const result = await remote.readBlob("x.bin");
  assert.equal(result!.version, TOKEN);
});

// ── (d) a weak W/"..." ETag-only response parses correctly ─────────────────────────────────────

test("read(): a response with ONLY a WEAK ETag (W/\"sha256:...\", no X-Version) parses the bare token via fallback", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://weak.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(200, { id: "x", frontmatter: { type: "T" }, body: "b" }, { ETag: `W/"${TOKEN}"` }),
  });

  const result = await remote.read("x");
  assert.equal(result.version, TOKEN);
});

test("readReserved(): a response with ONLY a weak ETag parses correctly", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://weak.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => jsonResponse(200, { content: "# Log\n" }, { ETag: `W/"${TOKEN}"` }),
  });

  const result = await remote.readReserved("", "log.md");
  assert.equal(result!.version, TOKEN);
});

// ── priority + backward-compatible sanity checks ────────────────────────────────────────────────

test("read(): X-Version wins over a DIFFERENT ETag value when both are present (X-Version is primary)", async () => {
  const otherToken = "sha256:" + "b".repeat(64);
  const remote = new RemoteBackend({
    baseUrl: "http://priority.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(
        200,
        { id: "x", frontmatter: { type: "T" }, body: "b" },
        { "X-Version": TOKEN, ETag: `"${otherToken}"` },
      ),
  });

  const result = await remote.read("x");
  assert.equal(result.version, TOKEN, "X-Version must win, not the ETag");
});

test("read(): a legacy BARE (unquoted) ETag with no X-Version still parses correctly (backward compatible with an unpatched/older server)", async () => {
  const remote = new RemoteBackend({
    baseUrl: "http://legacy.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () =>
      jsonResponse(200, { id: "x", frontmatter: { type: "T" }, body: "b" }, { ETag: TOKEN }),
  });

  const result = await remote.read("x");
  assert.equal(result.version, TOKEN);
});
test("RemoteBackend rejects noncanonical concept aliases before URL construction or fetch", async () => {
  let calls = 0;
  const remote = new RemoteBackend({
    baseUrl: "http://wire.local",
    bundleId: "bnd_11111111111111111111111111111111",
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 500 });
    },
    maxRetries: 0,
  });

  await assert.rejects(() => remote.read("./a/b"), InvalidInputError);
  await assert.rejects(() => remote.write("a//b", { id: "a//b", frontmatter: { type: "T" }, body: "" }), InvalidInputError);
  assert.equal(calls, 0);
});
