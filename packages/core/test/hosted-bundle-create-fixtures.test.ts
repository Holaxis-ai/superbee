/**
 * The fetch carrier against the `bundles.create.v1` golden exchanges (`fixtures/hosted-bundle-create-v1/`):
 * the one-shot `bundle-create` and the staged `bundle-create-begin`, `-stage`, `-blob` and
 * `-commit`. The files are generated in superbee-hosted (`test/support/sync-v1-exchanges.ts`) and
 * copied here unchanged; a hosted CI job fails when these copies and the generator's output differ,
 * so edit them only by copying.
 *
 * Every captured request leaves the carrier exactly as the host was sent it: the same JSON bytes,
 * or for the blob the same raw bytes with the same route headers and length, and every captured
 * answer comes back as its status and parsed body. The CLI's fake of these routes is held to the
 * same exchanges by `packages/cli/test/hosted-create-fake-contract.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFetchCarrier, HostedCarrierError, type HostedCarrier } from "../src/hosted-transport/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-bundle-create-v1");

interface Exchange {
  name: string;
  route: string;
  request: { method: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
}

const index = JSON.parse(readFileSync(path.join(FIXTURES, "index.json"), "utf8")) as { exchanges: { name: string; file: string; route: string; status: number }[] };
const exchanges = index.exchanges.map((entry) => JSON.parse(readFileSync(path.join(FIXTURES, entry.file), "utf8")) as Exchange);

/** The headers the carrier sets for a route's own fields: every `x-superbee-` header but the identity. */
const ROUTE_FIELDS = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-superbee-") && name !== "x-superbee-write-request"));

interface Sent {
  path: string;
  headers: Headers;
  body: Uint8Array;
}

/** A carrier whose fetch records each request and answers it with `golden`'s exact bytes. */
function carrierAnswering(golden: Exchange, sent: Sent[]): HostedCarrier {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    sent.push({ path: new URL(String(input)).pathname, headers: new Headers(init?.headers), body: typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array) });
    return new Response(golden.response.body, { status: golden.response.status, headers: golden.response.headers });
  }) as typeof globalThis.fetch;
  return createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
}

test("every captured exchange is a staged or one-shot creation route, and each is sent below", () => {
  const routes = new Set(index.exchanges.map((entry) => entry.route));
  assert.deepEqual([...routes].sort(), ["/sync/v1/bundle-create", "/sync/v1/bundle-create-begin", "/sync/v1/bundle-create-blob", "/sync/v1/bundle-create-commit", "/sync/v1/bundle-create-stage"]);
  for (const exchange of exchanges) assert.equal(exchange.request.method, "POST", exchange.name);
});

for (const golden of exchanges) {
  test(`the carrier sends ${golden.name} as the host was sent it, and reads its answer`, async () => {
    const sent: Sent[] = [];
    const carrier = carrierAnswering(golden, sent);
    const requestId = golden.request.headers["x-superbee-write-request"];
    const signal = new AbortController().signal;
    const raw = golden.request.headers["content-type"] === "application/octet-stream";
    const answer = raw
      ? await carrier.bytes!(golden.route, new TextEncoder().encode(golden.request.body), signal, { maximum: 64 * 1024, ...(requestId ? { writeRequest: requestId } : {}), headers: ROUTE_FIELDS(golden.request.headers) })
      : await carrier.json(golden.route, JSON.parse(golden.request.body), signal, { maximum: 128 * 1024, ...(requestId ? { writeRequest: requestId } : {}) });
    assert.equal(sent.length, 1);
    const request = sent[0]!;
    assert.equal(request.path, golden.route);
    // The same bytes, so the same length the host was told.
    assert.equal(new TextDecoder().decode(request.body), golden.request.body);
    if (golden.request.headers["content-length"] !== undefined) assert.equal(String(request.body.byteLength), golden.request.headers["content-length"]);
    assert.equal(request.headers.get("content-type"), golden.request.headers["content-type"]);
    const superbee = (headers: Headers | Record<string, string>) => [...new Headers(headers)].filter(([name]) => name.startsWith("x-superbee-"));
    assert.deepEqual(superbee(request.headers), superbee(golden.request.headers));
    assert.equal(request.headers.get("authorization"), "Bearer token");
    assert.equal(answer.status, golden.response.status);
    assert.deepEqual(answer.body, JSON.parse(golden.response.body));
    assert.equal(answer.headers.get("x-superbee-write-settled"), golden.response.headers["x-superbee-write-settled"] ?? null);
  });
}

test("a raw body leaves with its exact Content-Length and octet-stream type over a real socket", async () => {
  const golden = exchanges.find((exchange) => exchange.route === "/sync/v1/bundle-create-blob")!;
  const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(golden.response.status, golden.response.headers).end(golden.response.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const carrier = createFetchCarrier({ baseUrl: `http://127.0.0.1:${port}`, credentials: async () => ({ Authorization: "Bearer token" }) });
    // Every byte value, so nothing is re-encoded on the way.
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const answer = await carrier.bytes!(golden.route, bytes, new AbortController().signal, { maximum: 1024, writeRequest: golden.request.headers["x-superbee-write-request"]!, headers: ROUTE_FIELDS(golden.request.headers) });
    assert.equal(answer.status, 200);
    assert.equal(seen[0]!.headers["content-length"], "256");
    assert.equal(seen[0]!.headers["content-type"], "application/octet-stream");
    assert.equal(seen[0]!.headers["transfer-encoding"], undefined);
    assert.deepEqual(new Uint8Array(seen[0]!.body), bytes);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a raw request never names a header the carrier owns, a credential, or a malformed field; nothing is sent", async () => {
  const sent: Sent[] = [];
  const carrier = carrierAnswering(exchanges.find((exchange) => exchange.route === "/sync/v1/bundle-create-blob")!, sent);
  const signal = new AbortController().signal;
  const refused: Record<string, string>[] = [
    { Authorization: "Bearer other" },
    { "Content-Type": "application/json" },
    { "Content-Length": "1" },
    { "X-Superbee-Write-Request": "4a2f9c1e-8b3d-4e6f-9a1b-0000000000d1" },
    { "X-Superbee-Checkout": `sha256:${"0".repeat(64)}` },
    { "X-Superbee-Recreate": `sha256:${"0".repeat(64)}` },
    { "X-Superbee-Via": "codex" },
    { "X-Superbee-Accept-Deletes": "1" },
    { "X-Superbee-Workspace": "tenant:a\r\nX-Other: 1" },
    { "X-Superbee-Workspace": "tenänt" },
    { "X-Superbee-Workspace": "a", "x-superbee-workspace": "b" },
    { "X-Superbee-": "a" },
  ];
  for (const headers of refused) {
    await assert.rejects(carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array(1), signal, { maximum: 1024, headers }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied", JSON.stringify(headers));
  }
  await assert.rejects(carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array(1), signal, { maximum: 1024, writeRequest: "not-a-uuid" }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  assert.equal(sent.length, 0);
});

test("a raw request's answer is bounded as a JSON request's is", async () => {
  const sent: Sent[] = [];
  const carrier = carrierAnswering(exchanges.find((exchange) => exchange.route === "/sync/v1/bundle-create-blob")!, sent);
  await assert.rejects(carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array(4), new AbortController().signal, { maximum: 10 }), (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");
});
