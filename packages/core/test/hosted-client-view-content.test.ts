/**
 * `@superbee/core/hosted-client`'s View content methods (`readViewContent`, `updateViewContent`)
 * against a scripted host: the request bodies, every answer checked against the bytes it
 * describes, the operation's refusals typed with their write state, an update's lost answer as
 * `write_outcome_unknown` (never resent), a gateway without the routes, and the refusals made
 * before anything is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  bearerCredentials,
  createHostedClient,
  HostedCarrierError,
  isMalformedAnswer,
  isRouteNotServed,
  isViewContentVersion,
  RemoteError,
  VIEW_CONTENT_MAX_BYTES,
  viewContentVersion,
} from "../src/hosted-client/index.js";

const ORIGIN = "https://hosted.example";
const BUNDLE = "notes.a";
const VIEW = "views-registry/board";
const KEY = "views/board.html";
const REGISTRY = `sha256:${"a".repeat(64)}`;
const version = (html: string) => `sha256:${createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex")}`;
const PAGE = "﻿<p>café</p>";

function host(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path: pathname, body });
    return answer(pathname, body);
  }) as typeof fetch;
  return { fetch, sent };
}

const clientOf = (fetch: typeof globalThis.fetch) => createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch });
const json = (body: unknown, status = 200) => Response.json(body, { status });

const readData = (html = PAGE, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  operationId: "views.content.read.v1",
  data: { bundleId: BUNDLE, registryId: VIEW, registryVersion: REGISTRY, key: KEY, version: version(html), contentType: "text/html", byteCount: Buffer.byteLength(html), html, ...overrides },
});

const updateData = (html: string, previous: string, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  operationId: "views.content.update.v1",
  data: { bundleId: BUNDLE, registryId: VIEW, registryVersion: REGISTRY, key: KEY, changed: version(html) !== previous, version: version(html), previousVersion: previous, byteCount: Buffer.byteLength(html), contentType: "text/html", requestId: "req-1", ...overrides },
});

const refusal = (operationId: string, code: string, status: number, extra: Record<string, unknown> = {}) => json({ ok: false, operationId, error: { code, message: `refused: ${code}`, retryable: false, ...extra } }, status);

test("viewContentVersion is the sha256 of exact bytes, the BOM included", () => {
  const bytes = new TextEncoder().encode(PAGE);
  assert.equal(bytes[0], 0xef);
  assert.equal(viewContentVersion(bytes), version(PAGE));
  assert.ok(isViewContentVersion(version(PAGE)));
  assert.equal(isViewContentVersion("sha256:ABC"), false);
});

test("readViewContent: the request body, and the page checked against its version and byte count", async () => {
  const { fetch, sent } = host(() => json(readData()));
  const answer = await clientOf(fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY });
  assert.ok(answer.ok);
  assert.equal(answer.content.html, PAGE, "the leading BOM is kept as U+FEFF");
  assert.equal(answer.content.version, version(PAGE));
  assert.deepEqual(sent, [{ path: "/sync/v1/view-content-read", body: { bundleId: BUNDLE, registryId: VIEW, expectedRegistryVersion: REGISTRY } }]);
});

test("readViewContent: an answer whose html is not its version, size, View or registration version is malformed", async () => {
  for (const overrides of [{ version: version("other") }, { byteCount: 1 }, { registryId: "views-registry/other" }, { registryVersion: `sha256:${"b".repeat(64)}` }, { key: "notes/x.html" }, { bundleId: "other" }, { html: 7 }]) {
    const { fetch } = host(() => json(readData(PAGE, overrides)));
    await assert.rejects(clientOf(fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY }), (error: unknown) => isMalformedAnswer(error), JSON.stringify(overrides));
  }
});

test("readViewContent: refusals are typed results with their target and versions; a gateway without the route is HostedRouteNotServed", async () => {
  const conflict = host(() => refusal("views.content.read.v1", "version_conflict", 409, { target: "registry", expected: REGISTRY, actual: null, writeState: "not_applied" }));
  const answer = await clientOf(conflict.fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY });
  assert.deepEqual(answer, { ok: false, refusal: { code: "version_conflict", status: 409, message: "refused: version_conflict", writeState: "not_applied", retryable: false, target: "registry", expected: REGISTRY, actual: null } });
  const missing = host(() => refusal("views.content.read.v1", "view_not_found", 404));
  const notFound = await clientOf(missing.fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY });
  assert.equal(!notFound.ok && notFound.refusal.code, "view_not_found");
  const old = host(() => json({ error: "not_found" }, 404));
  await assert.rejects(clientOf(old.fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY }), (error: unknown) => isRouteNotServed(error));
  const unauthenticated = host(() => json({ error: "invalid_token" }, 401));
  await assert.rejects(clientOf(unauthenticated.fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY }), (error: unknown) => error instanceof RemoteError && error.status === 401);
  const other = host(() => refusal("views.content.update.v1", "view_not_found", 404));
  await assert.rejects(clientOf(other.fetch).readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY }), (error: unknown) => isMalformedAnswer(error), "a refusal naming another operation");
});

test("updateViewContent: the request body, and an answer whose version is not the bytes sent is malformed", async () => {
  const html = "<p>v2</p>";
  const { fetch, sent } = host((_, body) => json(updateData(String(body.html), version(PAGE))));
  const answer = await clientOf(fetch).updateViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html });
  assert.ok(answer.ok);
  assert.deepEqual({ changed: answer.update.changed, version: answer.update.version, previous: answer.update.previousVersion }, { changed: true, version: version(html), previous: version(PAGE) });
  assert.deepEqual(sent[0], { path: "/sync/v1/view-content-update", body: { bundleId: BUNDLE, registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html } });

  const unchanged = host((_, body) => json(updateData(String(body.html), version(String(body.html)))));
  const same = await clientOf(unchanged.fetch).updateViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html: PAGE });
  assert.equal(same.ok && same.update.changed, false);

  for (const overrides of [{ version: version("other") }, { byteCount: 1 }, { changed: false }, { requestId: "" }]) {
    const lying = host((_, body) => json(updateData(String(body.html), version(PAGE), overrides)));
    await assert.rejects(clientOf(lying.fetch).updateViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html }), (error: unknown) => isMalformedAnswer(error), JSON.stringify(overrides));
  }
});

test("updateViewContent: a content conflict names the host's version; 4xx refusals are not applied", async () => {
  const actual = version("<p>theirs</p>");
  const { fetch } = host(() => refusal("views.content.update.v1", "version_conflict", 409, { target: "content", expected: version(PAGE), actual, writeState: "not_applied" }));
  const answer = await clientOf(fetch).updateViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html: "<p>v2</p>" });
  assert.ok(!answer.ok);
  assert.deepEqual([answer.refusal.target, answer.refusal.actual, answer.refusal.writeState], ["content", actual, "not_applied"]);
  // A 4xx refusal that states no write state was not applied; a 5xx one may have been.
  const unstated = host(() => refusal("views.content.update.v1", "definition_writes_refused", 403));
  const refused = await clientOf(unstated.fetch).updateViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html: "x" });
  assert.equal(!refused.ok && refused.refusal.writeState, "not_applied");
});

test("updateViewContent: a lost or unreadable answer is write_outcome_unknown, sent once and never again", async () => {
  const request = { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html: "<p>v2</p>" };
  const cases: [string, () => Response | Promise<Response>][] = [
    ["503 write_outcome_unknown", () => refusal("views.content.update.v1", "write_outcome_unknown", 503, { writeState: "unknown" })],
    ["502 without an envelope", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["no answer at all", () => Promise.reject(new TypeError("socket hang up"))],
  ];
  for (const [name, answer] of cases) {
    const { fetch, sent } = host(answer);
    const result = await clientOf(fetch).updateViewContent(BUNDLE, request);
    assert.ok(!result.ok, name);
    assert.equal(result.refusal.writeState, "unknown", name);
    assert.equal(result.refusal.code === "write_outcome_unknown", true, name);
    assert.equal(sent.length, 1, `${name}: sent once`);
  }
  const old = host(() => json({ error: "not_found" }, 404));
  await assert.rejects(clientOf(old.fetch).updateViewContent(BUNDLE, request), (error: unknown) => isRouteNotServed(error));
});

test("updateViewContent: refused before sending: an oversized page, a lone surrogate, a bad version or id, no credential", async () => {
  const { fetch, sent } = host(() => json({}));
  const client = clientOf(fetch);
  const base = { registryId: VIEW, expectedRegistryVersion: REGISTRY, expectedContentVersion: version(PAGE), html: "x" };
  await assert.rejects(client.updateViewContent(BUNDLE, { ...base, html: "a".repeat(VIEW_CONTENT_MAX_BYTES + 1) }), RangeError);
  await assert.rejects(client.updateViewContent(BUNDLE, { ...base, html: "\ud800" }), RangeError);
  await assert.rejects(client.updateViewContent(BUNDLE, { ...base, expectedContentVersion: "v1" }), RangeError);
  await assert.rejects(client.updateViewContent(BUNDLE, { ...base, registryId: "notes/x" }), RangeError);
  await assert.rejects(client.readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: "nope" }), RangeError);
  assert.equal(sent.length, 0);
  const denied = createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: async () => Promise.reject(new Error("signed out")), fetch });
  await assert.rejects(denied.updateViewContent(BUNDLE, base), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  assert.equal(sent.length, 0);
});

test("within: the View content routes name the bundle in the workspace", async () => {
  const { fetch, sent } = host(() => json(readData()));
  await clientOf(fetch).within("acme").readViewContent(BUNDLE, { registryId: VIEW, expectedRegistryVersion: REGISTRY });
  assert.equal(sent[0]!.body.bundleId, `acme/${BUNDLE}`);
});
