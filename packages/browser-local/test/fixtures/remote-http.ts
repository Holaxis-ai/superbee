/**
 * Serve a {@link RemoteFixture} as a real HTTP origin on 127.0.0.1 so a page in Chromium reaches
 * the disposable authority through `fetch`. Each node:http request is converted to a Fetch
 * `Request`, handed to the fixture's hosted handler, and its `Response` written back. A handler
 * that throws (the fixture's carrier-failure knobs) resets the socket instead of answering, so
 * the browser sees exactly what a dropped connection looks like: a rejected fetch with no
 * status, from which it cannot tell whether the write was applied.
 *
 * The page and the authority are different origins, as a browser-local client and a hosted
 * authority would be, so the bridge answers CORS preflights and exposes the version header.
 * Every response also carries `cross-origin-resource-policy: cross-origin`, so a page served
 * under `cross-origin-embedder-policy: require-corp` (the measurement driver) may still fetch
 * it. Those headers are this test fixture's concern; nothing here touches `@superbee/server`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { BASE_URL, type RemoteFixture } from "./remote-fixture.ts";

export interface ServedFixture {
  fixture: RemoteFixture;
  /** `http://127.0.0.1:<port>`, the base URL a page's RemoteBackend and transport use. */
  origin: string;
  /** Requests whose bodies the bridge fully received, by method and path, for assertions about traffic. */
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

/**
 * Every response closes its connection. Chromium resends a request whose reused socket resets
 * before any response byte arrives, which would hide the fixture's dropped acknowledgement
 * behind its own deduplication; on a fresh socket the reset reaches the page as the network
 * error it is meant to be.
 */
const COMMON_HEADERS: Record<string, string> = {
  connection: "close",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, if-match, if-none-match, idempotency-key, x-actor, x-agent, authorization",
  "access-control-expose-headers": "x-version, etag",
  "access-control-max-age": "0",
  "cross-origin-resource-policy": "cross-origin",
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function toFetchRequest(request: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    if (name.toLowerCase() === "host") continue;
    headers.append(name, request.rawHeaders[index + 1]!);
  }
  const method = request.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body);
  return new Request(`${BASE_URL}${request.url ?? "/"}`, init);
}

async function bridge(fixture: RemoteFixture, requests: ServedFixture["requests"], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  // Recorded once the body is in hand, so a caller waiting on this list knows the fixture will run.
  requests.push({ method: request.method ?? "GET", path: request.url ?? "/" });
  if (request.method === "OPTIONS") {
    response.writeHead(204, COMMON_HEADERS);
    response.end();
    return;
  }
  let answer: Response;
  try {
    answer = await fixture.hosted(toFetchRequest(request, body));
  } catch {
    // The carrier failed after whatever the handler did: reset the socket so the client sees
    // a network error, not a status.
    response.destroy();
    return;
  }
  if (response.destroyed) return;
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  answer.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const text = await answer.text();
  response.writeHead(answer.status, headers);
  response.end(text);
}

export async function serveRemoteFixture(fixture: RemoteFixture): Promise<ServedFixture> {
  const requests: ServedFixture["requests"] = [];
  const server: Server = createServer((request, response) => {
    bridge(fixture, requests, request, response).catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    fixture,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
