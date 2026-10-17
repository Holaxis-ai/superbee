/**
 * `@superbee/core/hosted-client` against the `/sync/v1` golden exchanges
 * (`fixtures/hosted-sync-v1/`, copied from superbee-hosted): every read method's happy path through
 * the real fetch carrier, answers the contract does not admit, non-200 answers as typed errors,
 * workspace qualification, the credential provider asked once per request, and abort.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bearerCredentials,
  BUNDLE_LIST_CAP,
  createHostedClient,
  HostedCarrierError,
  HostedRouteNotServed,
  isAnswerTooLarge,
  isMalformedAnswer,
  isRouteNotServed,
  MALFORMED_ANSWER,
  parseHostedBundleReference,
  qualifyingCarrier,
  readBundleListing,
  RemoteError,
  ROUTE_NOT_SERVED,
  syncRoutePrefix,
  type HostedClientOptions,
} from "../src/hosted-client/index.js";
import { HostedCarrierError as TransportCarrierError } from "../src/hosted-transport/index.js";
import { MalformedAnswer as RootMalformedAnswer, RemoteError as RootRemoteError } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");

interface Exchange {
  route: string;
  request: { body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

const fixture = (name: string): Exchange => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Exchange;

const ORIGIN = "https://hosted.example";
const BUNDLE = "notes.a";

interface Sent {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
}

/** A fetch answering each request with what `answer` returns for its path and body, recording what was sent. */
function host(answer: (path: string, body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path: pathname, body, authorization: new Headers(init?.headers).get("authorization") });
    return answer(pathname, body);
  }) as typeof fetch;
  return { fetch, sent };
}

/** The exchange's exact answer bytes. */
function replay(name: string): Response {
  const { response } = fixture(name);
  return new Response(response.body === "" ? null : response.body, { status: response.status, headers: response.headers });
}

/** A host answering each route of the sync family with the named exchange (by the route's last segment). */
function serving(byRoute: Record<string, string>) {
  return host((pathname) => {
    const name = byRoute[pathname.slice(pathname.lastIndexOf("/") + 1)];
    return name ? replay(name) : replay("unknown-route-404");
  });
}

function clientOf(fetch: typeof globalThis.fetch, overrides: Partial<HostedClientOptions> = {}) {
  return createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch, ...overrides });
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// ── target ─────────────────────────────────────────────────────────────────────────────────

test("syncRoutePrefix: the API audience, an agent connection, and no family for anything else", () => {
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}/mcp` }), "/sync/v1");
  const agent = "/agents/0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1e";
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}${agent}/mcp` }), `${agent}/sync/v1`);
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}/agents/not-a-uuid/mcp` }), null);
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}/other` }), null);
});

test("syncRoutePrefix: an audience on another host is no sync family, whatever its length", () => {
  // Same length as the origin, so slicing by length alone would read `/mcp`.
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: "https://hosted.exampl3/mcp" }), null);
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}.evil/mcp` }), null);
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: `${ORIGIN}:8443/mcp` }), null);
  assert.equal(syncRoutePrefix({ origin: ORIGIN, audience: ORIGIN }), null);
});

test("parseHostedBundleReference: references it refuses", () => {
  for (const value of ["", "/", "notes.a/", "/notes.a", "South/notes.a", "-south/notes.a", "south-/notes.a", "a/b/notes.a", `${"s".repeat(64)}/notes.a`, "south/Notes A", "south/"]) {
    assert.equal(parseHostedBundleReference(value), null, value);
  }
  assert.deepEqual(parseHostedBundleReference("south/notes.a"), { slug: "south", bundleId: "notes.a" });
  assert.deepEqual(parseHostedBundleReference("notes.a"), { slug: null, bundleId: "notes.a" });
});

test("qualifyingCarrier: a raw body to a bundle-scoped route is refused; an unscoped one passes", async () => {
  const sent: string[] = [];
  const inner = {
    json: async () => assert.fail("json"),
    stream: async () => assert.fail("stream"),
    bytes: async (route: string) => {
      sent.push(route);
      return { status: 200, headers: new Headers(), body: {} };
    },
  };
  const carrier = qualifyingCarrier(inner, "/sync/v1", "south");
  const signal = new AbortController().signal;
  await assert.rejects(carrier.bytes!("/sync/v1/write", new Uint8Array(1), signal, { maximum: 1024 }), TypeError);
  await carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array(1), signal, { maximum: 1024 });
  assert.deepEqual(sent, ["/sync/v1/bundle-create-blob"]);
});

test("qualifyingCarrier: only exact blob upload routes qualify one bare bundle header and preserve every other request option", async () => {
  for (const prefix of ["/sync/v1", "/agents/0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1e/sync/v1"]) {
    const signal = new AbortController().signal, body = new Uint8Array([0, 255, 128, 13, 10]);
    const seen: {route: string; bytes: Uint8Array; signal: AbortSignal; options: any}[] = [];
    const inner = {json: async () => assert.fail("json"), stream: async () => assert.fail("stream"), bytes: async (route: string, bytes: Uint8Array, signal: AbortSignal, options: any) => {
      seen.push({route, bytes, signal, options});
      return {status: 200, headers: new Headers(), body: {ok: true}};
    }};
    for (const slug of ["south", "north"]) for (const route of ["blob-create", "blob-replace"]) {
      const headers = {"x-SuPeRbEe-BuNdLe": BUNDLE, "X-Superbee-Content-Type": "image/svg+xml; charset=utf-8", "X-Superbee-Blob-Key": "ZGlhZ3JhbXMvY2Fmw6kuc3Zn", "X-Superbee-Blob-Version": `sha256:${"a".repeat(64)}`, ...(route === "blob-replace" ? {"X-Superbee-Expected-Version": `sha256:${"b".repeat(64)}`, "X-Superbee-Expected-Content-Type": "application/octet-stream"} : {})};
      const options = {maximum: 4096, writeRequest: "11111111-1111-4111-8111-111111111111", binding: `sha256:${"c".repeat(64)}`, via: "codex", headers};
      await qualifyingCarrier(inner, prefix, slug).bytes!(`${prefix}/${route}`, body, signal, options);
      const sent = seen.at(-1)!;
      assert.equal(sent.route, `${prefix}/${route}`); assert.equal(sent.bytes, body); assert.equal(sent.signal, signal);
      assert.deepEqual(sent.options, {...options, headers: {...headers, "x-SuPeRbEe-BuNdLe": `${slug}/${BUNDLE}`}});
      assert.equal(headers["x-SuPeRbEe-BuNdLe"], BUNDLE, "qualification never mutates the caller's reusable header record");
    }
    const carrier = qualifyingCarrier(inner, prefix, "south"), before = seen.length;
    for (const headers of [undefined, {}, {"X-Superbee-Bundle": ""}, {"X-Superbee-Bundle": " notes.a"}, {"X-Superbee-Bundle": "notes.a "}, {"X-Superbee-Bundle": "north/notes.a"}, {"X-Superbee-Bundle": "south/notes.a"}, {"X-Superbee-Bundle": "../notes.a"}, {"X-Superbee-Bundle": "notes.a\r\nX-Other: bad"}, {"X-Superbee-Bundle": BUNDLE, "x-superbee-bundle": BUNDLE}]) {
      for (const route of ["blob-create", "blob-replace"]) await assert.rejects(carrier.bytes!(`${prefix}/${route}`, body, signal, {maximum: 1024, headers}), TypeError);
    }
    for (const route of ["blob-delete", "outcome", "write", "blob-create/extra", "blob-replace?override=1"])
      await assert.rejects(carrier.bytes!(`${prefix}/${route}`, body, signal, {maximum: 1024, headers: {"X-Superbee-Bundle": BUNDLE}}), TypeError);
    assert.equal(seen.length, before, "invalid and unrelated scoped raw calls never dispatch");
    const withoutBytes = qualifyingCarrier({json: inner.json, stream: inner.stream}, prefix, "south");
    assert.equal(withoutBytes.bytes, undefined, "qualification never fabricates a missing binary port");
    let credentials = 0;
    const requests: Request[] = [];
    const client = createHostedClient({target: {origin: ORIGIN, syncPrefix: prefix}, credentials: async () => ({Authorization: `Bearer current-${++credentials}`}), fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), body);
      return Response.json({ok: true});
    }});
    for (const slug of ["south", "north"]) await client.within(slug).carrier.bytes!(`${prefix}/blob-create`, body, signal, {
      maximum: 1024, writeRequest: "11111111-1111-4111-8111-111111111111", binding: `sha256:${"c".repeat(64)}`, via: "codex", headers: {"X-Superbee-Bundle": BUNDLE},
    });
    assert.equal(credentials, 2);
    for (const [index, slug] of ["south", "north"].entries()) {
      const request = requests[index]!;
      assert.equal(new URL(request.url).pathname, `${prefix}/blob-create`);
      assert.equal(request.headers.get("x-superbee-bundle"), `${slug}/${BUNDLE}`);
      assert.equal(request.headers.get("authorization"), `Bearer current-${index + 1}`);
      assert.equal(request.headers.get("x-superbee-write-request"), "11111111-1111-4111-8111-111111111111");
      assert.equal(request.headers.get("x-superbee-checkout"), `sha256:${"c".repeat(64)}`);
      assert.equal(request.headers.get("x-superbee-via"), "codex");
    }
  }
});

test("an agent-connection prefix routes every request under it", async () => {
  const prefix = "/agents/0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1e/sync/v1";
  const { fetch, sent } = serving({ whoami: "whoami-200" });
  const client = clientOf(fetch, { target: { origin: ORIGIN, syncPrefix: prefix } });
  assert.equal(client.prefix, prefix);
  await client.whoami();
  assert.equal(sent[0]?.path, `${prefix}/whoami`);
});

test("a malformed sync prefix or a missing credential provider is refused at construction", () => {
  const { fetch } = serving({});
  for (const syncPrefix of ["sync/v1", "/sync/v1/", ""]) {
    assert.throws(() => clientOf(fetch, { target: { origin: ORIGIN, syncPrefix } }), TypeError);
  }
  assert.throws(() => createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: undefined as never, fetch }), TypeError);
});

// ── happy paths ────────────────────────────────────────────────────────────────────────────

test("whoami: the golden identity, its workspaces' slugs and the stated write bound", async () => {
  const { fetch, sent } = serving({ whoami: "whoami-200" });
  const identity = await clientOf(fetch).whoami();
  assert.deepEqual(identity, {
    principalId: "person:both",
    tenantIds: ["tenant:a"],
    workspaces: [{ tenantId: "tenant:a", slug: "tenant-a" }],
    documentInputBytes: 983040,
    email: null,
    targetAuthorityKey: "orgs",
  });
  assert.deepEqual(sent, [{ path: "/sync/v1/whoami", body: {}, authorization: "Bearer token-1" }]);
});

test("whoami: a host from before qualified references names no slugs", async () => {
  const { fetch } = host(() => json({ principalId: "p", tenantIds: ["b", "a"], email: "p@example.com" }));
  const identity = await clientOf(fetch).whoami();
  assert.deepEqual(identity.tenantIds, ["a", "b"]);
  assert.deepEqual(identity.workspaces, [{ tenantId: "a", slug: null }, { tenantId: "b", slug: null }]);
  assert.equal(identity.documentInputBytes, null);
  assert.equal(identity.email, "p@example.com");
  // A host that states no target authority key: still an identity, with none.
  assert.equal(identity.targetAuthorityKey, null);
});

test("whoami: a target authority key no document target can carry reads as none", async () => {
  for (const targetAuthorityKey of ["", "a/b", "a\\b", "has space", 7, "x".repeat(257)]) {
    const { fetch } = host(() => json({ principalId: "p", tenantIds: ["a"], targetAuthorityKey }));
    assert.equal((await clientOf(fetch).whoami()).targetAuthorityKey, null, JSON.stringify(targetAuthorityKey));
  }
});

test("bundles: the golden list's rows, and readBundleListing over them", async () => {
  const { fetch, sent } = serving({ bundles: "bundles-200" });
  const rows = await clientOf(fetch).bundles();
  assert.deepEqual(rows, [
    { bundleId: "notes.a", name: "notes.a", lifecycle: "active" },
    { bundleId: "ro.a", name: "ro.a", lifecycle: "active" },
  ]);
  assert.equal(sent[0]?.path, "/sync/v1/bundles");
  const listing = readBundleListing(rows);
  assert.equal(listing.complete, true);
  assert.deepEqual(listing.lookup({ slug: null, bundleId: "notes.a" }), { row: rows[0], holders: 1, references: [] });
});

test("readBundleListing: a qualified collision, and a capped list", () => {
  const listing = readBundleListing([
    { bundleId: "south/notes.a", name: "notes", lifecycle: null },
    { bundleId: "north/notes.a", name: "notes", lifecycle: null },
  ]);
  assert.deepEqual(listing.lookup({ slug: null, bundleId: "notes.a" }), { row: null, holders: 2, references: ["north/notes.a", "south/notes.a"] });
  assert.equal(listing.lookup({ slug: "north", bundleId: "notes.a" }).row?.bundleId, "north/notes.a");
  const capped = readBundleListing(Array.from({ length: BUNDLE_LIST_CAP }, (_, n) => ({ bundleId: `b${n}.a`, name: "b", lifecycle: null })));
  assert.equal(capped.complete, false);
});

test("reader: a document read through the bundle's read adapter under the family's routes", async () => {
  const { fetch, sent } = serving({ read: "read-200-ok" });
  const result = await clientOf(fetch).reader(BUNDLE).read("notes/one");
  assert.equal(result.version, "sha256:dfc05cf336bf2eaa2bf4a3319609f596514c2ec0f5abf3e7a173aafe7baac5c4");
  assert.deepEqual(sent[0], { path: "/sync/v1/read", body: { bundleId: BUNDLE, documentId: "notes/one" }, authorization: "Bearer token-1" });
});

test("history: the golden page, newest first", async () => {
  const { fetch, sent } = serving({ history: "history-200-ok" });
  const answer = await clientOf(fetch).history(BUNDLE, { documentId: "notes/via", limit: 20 });
  assert.equal(answer.ok, true);
  assert.ok(answer.ok && answer.page.versions.length > 0);
  assert.deepEqual(sent[0]?.body, { bundleId: BUNDLE, documentId: "notes/via", limit: 20 });
});

test("listOperations: the golden listing, and bundle_not_found as a refusal", async () => {
  const listed = await clientOf(serving({ operations: "operations-200" }).fetch).listOperations(BUNDLE);
  assert.ok(listed.ok && listed.listing.operations.some((operation) => operation.operationId === "documents.history.v1"));
  const absent = await clientOf(serving({ operations: "operations-404-bundle-not-found" }).fetch).listOperations("nope.a");
  assert.equal(absent.ok, false);
  assert.equal(!absent.ok && absent.refusal.code, "bundle_not_found");
});

test("runOperation: the golden run body and data, and the route's own refusals", async () => {
  const exchange = fixture("run-200-ok");
  const { fetch, sent } = serving({ run: "run-200-ok" });
  const run = await clientOf(fetch).runOperation(BUNDLE, "documents.history.v1", { documentId: "notes/via" });
  assert.equal(run.ok, true);
  assert.deepEqual(sent[0]?.body, JSON.parse(exchange.request.body));
  const unknown = await clientOf(serving({ run: "run-400-unknown-operation" }).fetch).runOperation(BUNDLE, "documents.replace.v1", {});
  assert.equal(!unknown.ok && unknown.refusal.code, "unknown_operation");
});

// ── typed failures ─────────────────────────────────────────────────────────────────────────

test("malformed answers are MalformedAnswer naming the route", async () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["/sync/v1/whoami", () => clientOf(host(() => json({ principalId: "", tenantIds: [] })).fetch).whoami()],
    ["/sync/v1/whoami", () => clientOf(host(() => json({ principalId: "p", tenantIds: ["a"], workspaces: [{ tenantId: "a", slug: "Not A Slug" }] })).fetch).whoami()],
    ["/sync/v1/whoami", () => clientOf(host(() => json({ principalId: "p", tenantIds: ["a", "b"], workspaces: [{ tenantId: "a", slug: null }, { tenantId: "a", slug: null }] })).fetch).whoami()],
    ["/sync/v1/bundles", () => clientOf(host(() => json({ ok: true, data: {} })).fetch).bundles()],
    ["/sync/v1/history", () => clientOf(host(() => json({ ok: true, operationId: "documents.history.v1", data: { versions: "no" } })).fetch).history(BUNDLE, { documentId: "notes/via", limit: 20 })],
    ["/sync/v1/operations", () => clientOf(host(() => json({ operations: "no" })).fetch).listOperations(BUNDLE)],
    ["/sync/v1/run", () => clientOf(host(() => json({ ok: true, operationId: "other.v1", data: {} })).fetch).runOperation(BUNDLE, "documents.history.v1", {})],
  ];
  for (const [route, call] of cases) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(isMalformedAnswer(error), `${route}: ${String(error)}`);
      assert.equal(error.code, MALFORMED_ANSWER);
      assert.equal(error.route, route);
      return true;
    });
  }
});

test("non-200 answers are RemoteError with the host's code and status", async () => {
  await assert.rejects(clientOf(serving({ whoami: "read-401-unauthenticated" }).fetch).whoami(), (error: unknown) => {
    assert.ok(error instanceof RemoteError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_token");
    return true;
  });
  await assert.rejects(clientOf(host(() => json({ ok: false, error: { code: "insufficient_scope" } })).fetch).bundles(), (error: unknown) => {
    assert.ok(error instanceof RemoteError);
    assert.deepEqual([error.code, error.status], ["insufficient_scope", 403]);
    return true;
  });
  await assert.rejects(clientOf(serving({ history: "history-400-invalid-input" }).fetch).history(BUNDLE, { documentId: "notes/via", limit: 20 }), (error: unknown) => {
    assert.ok(error instanceof RemoteError);
    assert.deepEqual([error.code, error.status], ["invalid_input", 400]);
    return true;
  });
  await assert.rejects(clientOf(host(() => json({ error: { code: "invalid_input" } }, 400)).fetch).listOperations(BUNDLE), RemoteError);
  // A 503 is the transport's `unavailable`, retryable, not a refusal.
  await assert.rejects(clientOf(serving({ run: "heads-503-backend-unavailable" }).fetch).runOperation(BUNDLE, "documents.history.v1", {}), (error: unknown) => {
    assert.ok(error instanceof HostedCarrierError);
    assert.equal(error.code, "unavailable");
    return true;
  });
});

test("a route a gateway does not have yet is HostedRouteNotServed naming it", async () => {
  const { fetch } = serving({});
  const client = clientOf(fetch);
  for (const [route, call] of [
    ["/sync/v1/history", () => client.history(BUNDLE, { documentId: "notes/via", limit: 20 })],
    ["/sync/v1/operations", () => client.listOperations(BUNDLE)],
    ["/sync/v1/run", () => client.runOperation(BUNDLE, "documents.history.v1", {})],
  ] as const) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(isRouteNotServed(error));
      assert.ok(error instanceof RemoteError, "one hierarchy: a route not served is a RemoteError");
      assert.deepEqual([error.code, error.status, error.route], [ROUTE_NOT_SERVED, 404, route]);
      return true;
    });
  }
  // Another 404 envelope is the route's own refusal, not a missing route.
  await assert.rejects(clientOf(host(() => json({ error: { code: "document_not_found" } }, 404)).fetch).history(BUNDLE, { documentId: "x/y", limit: 1 }), (error: unknown) => {
    assert.ok(error instanceof RemoteError && !(error instanceof HostedRouteNotServed));
    return true;
  });
});

test("an answer over its bound is the transport's too-large failure", async () => {
  const big = JSON.stringify({ ok: true, operationId: "documents.history.v1", data: "x".repeat(4096) });
  const { fetch } = host(() => new Response(big, { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(clientOf(fetch).runOperation(BUNDLE, "documents.history.v1", {}, { maximumBytes: 1024 }), (error: unknown) => {
    assert.ok(isAnswerTooLarge(error));
    return true;
  });
});

test("the error classes are core's own identities, re-exported", () => {
  assert.equal(RemoteError, RootRemoteError);
  assert.equal(HostedCarrierError, TransportCarrierError);
  assert.ok(new HostedRouteNotServed("/x") instanceof RootRemoteError);
  assert.ok(!(new HostedRouteNotServed("/x") instanceof RootMalformedAnswer));
});

// ── within ─────────────────────────────────────────────────────────────────────────────────

test("within: bundle-scoped requests name <slug>/<id>; unscoped ones and the answers do not", async () => {
  const { fetch, sent } = host((pathname) => {
    if (pathname.endsWith("/whoami")) return replay("whoami-200");
    if (pathname.endsWith("/bundles")) return replay("bundles-200");
    if (pathname.endsWith("/read")) return replay("read-200-ok-qualified");
    if (pathname.endsWith("/run")) return replay("run-200-ok-qualified");
    if (pathname.endsWith("/history")) return replay("history-200-ok");
    return replay("operations-200");
  });
  const client = clientOf(fetch).within("south");
  await client.whoami();
  await client.bundles();
  await client.reader(BUNDLE).read("notes/one");
  await client.history(BUNDLE, { documentId: "notes/via", limit: 20 });
  await client.listOperations(BUNDLE);
  await client.runOperation(BUNDLE, "documents.history.v1", { documentId: "notes/via" });
  const named = Object.fromEntries(sent.map((request) => [request.path.slice("/sync/v1/".length), request.body.bundleId]));
  assert.deepEqual(named, {
    whoami: undefined,
    bundles: undefined,
    read: `south/${BUNDLE}`,
    history: `south/${BUNDLE}`,
    operations: `south/${BUNDLE}`,
    run: `south/${BUNDLE}`,
  });
  // An id that already names a workspace is a caller's mistake.
  await assert.rejects(client.carrier.json("/sync/v1/read", { bundleId: `north/${BUNDLE}` }, client.signal, { maximum: 1024 }), TypeError);
});

// ── credentials and abort ──────────────────────────────────────────────────────────────────

test("the credential provider is asked once per request, so a renewed bearer is used at once", async () => {
  let calls = 0;
  const { fetch, sent } = serving({ whoami: "whoami-200", bundles: "bundles-200", read: "read-200-ok" });
  const client = clientOf(fetch, { credentials: bearerCredentials(async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    calls += 1;
    return `token-${calls}`;
  }) });
  await client.whoami();
  await client.bundles();
  await client.within("south").whoami();
  assert.equal(calls, 3);
  assert.deepEqual(sent.map((request) => request.authorization), ["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
});

test("any credential headers pass through the carrier seam unchanged", async () => {
  const { fetch } = serving({ whoami: "whoami-200" });
  const seen: Headers[] = [];
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  await clientOf(recording, { credentials: async () => ({ "X-CSRF-Token": "csrf", Cookie: "session=s" }) }).whoami();
  assert.equal(seen[0]?.get("x-csrf-token"), "csrf");
  assert.equal(seen[0]?.get("authorization"), null);
});

test("a credential provider that rejects sends nothing: the transport's denied", async () => {
  const { fetch, sent } = serving({ whoami: "whoami-200" });
  const client = clientOf(fetch, { credentials: async () => Promise.reject(new Error("signed out")) });
  await assert.rejects(client.whoami(), (error: unknown) => {
    assert.ok(error instanceof HostedCarrierError);
    assert.equal(error.code, "denied");
    assert.doesNotMatch(String(error), /token/);
    return true;
  });
  const notString = clientOf(fetch, { credentials: bearerCredentials(() => 42 as never) });
  await assert.rejects(notString.whoami(), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  assert.equal(sent.length, 0);
});

test("a token getter that throws synchronously sends nothing: the transport's denied", async () => {
  const { fetch, sent } = serving({ whoami: "whoami-200" });
  const client = clientOf(fetch, { credentials: bearerCredentials(() => {
    throw new Error("no session");
  }) });
  await assert.rejects(client.whoami(), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  assert.equal(sent.length, 0);
});

test("deadlineMs: a host that never answers is the transport's unavailable", async () => {
  const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  // The carrier's deadline is an unref'd AbortSignal.timeout and this fake fetch holds no socket,
  // so a referenced timer keeps the event loop alive until the deadline fires.
  const hold = setInterval(() => {}, 1000);
  try {
    await assert.rejects(clientOf(silent, { deadlineMs: 20 }).whoami(), (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");
  } finally {
    clearInterval(hold);
  }
});

test("abort: an aborted signal sends nothing, and aborting mid-request ends it as a transport failure", async () => {
  const before = new AbortController();
  before.abort();
  const idle = serving({ whoami: "whoami-200" });
  const client = clientOf(idle.fetch, { signal: before.signal });
  assert.equal(client.signal, before.signal);
  await assert.rejects(client.whoami(), HostedCarrierError);
  await assert.rejects(client.within("south").listOperations(BUNDLE), HostedCarrierError);
  assert.equal(idle.sent.length, 0);

  const during = new AbortController();
  let started!: () => void;
  const sending = new Promise<void>((resolve) => (started = resolve));
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
    started();
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }) as typeof fetch;
  const pending = clientOf(hanging, { signal: during.signal }).history(BUNDLE, { documentId: "notes/via", limit: 20 });
  await sending;
  during.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");
});
