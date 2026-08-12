/**
 * Thin `node:http` bootstrap for {@link createRouter}: adapts Node's
 * `IncomingMessage`/`ServerResponse` to the router's Web-standard
 * `Request`/`Response` shape and binds a TCP listener.
 *
 * NO AUTH in v0: the `Authorization` header slot is reserved on the wire
 * (`docs/WIRE-PROTOCOL.md`) but not enforced here. Binding `127.0.0.1` by default
 * (rather than `0.0.0.0`) is the stated v0 mitigation — a process on the same
 * machine can reach it, nothing on the network can. This is a REFERENCE
 * implementation for proving the protocol end-to-end, not a production deployment.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createRouter } from "./router.js";
import type { Bundle } from "@superbee/core";

/** Options for {@link serve}. */
export interface ServeOptions {
  /** The bundle to serve. */
  bundle: Bundle;
  /** Host to bind. Defaults to `127.0.0.1` (loopback-only — see module doc). */
  host?: string;
  /** Port to bind. `0` (the default) picks an ephemeral port — read it back via {@link ServerHandle.port}. */
  port?: number;
}

/** A running server, returned by {@link serve}. */
export interface ServerHandle {
  /** The host it bound to. */
  readonly host: string;
  /** The port it actually bound to (resolved even when `port: 0` was requested). */
  readonly port: number;
  /** Stop listening and release the socket. */
  close(): Promise<void>;
}

export interface RequestAdapterOptions {
  /** Reject while streaming once this many body bytes would be exceeded. Omit for no adapter cap. */
  maxBodyBytes?: number;
}

export class RequestBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/** Read a Node request body into a `Buffer`, or `undefined` for a body-less method. */
function readBody(req: IncomingMessage, maxBodyBytes?: number): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  if (maxBodyBytes !== undefined) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return Promise.reject(new RequestBodyTooLargeError(maxBodyBytes));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (maxBodyBytes !== undefined && total > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(maxBodyBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(chunks.length > 0 ? Buffer.concat(chunks, total) : undefined);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * Adapt a Node `IncomingMessage` into a Web-standard `Request` the router accepts. EXPORTED
 * (the `ui` command's SMALL ADDITIVE surface, `plans/ui-v1.md` rev 3.2): `agentstate-lite ui
 * --dir` needs to mount THIS SAME router in-process behind its own token/Host/CSP middleware
 * (a single node:http listener serving both the SPA and `/v0/*`, same origin) — reusing this
 * adapter means the CLI never forks the Request/Response marshaling this module already owns.
 */
export async function requestFromIncomingMessage(
  req: IncomingMessage,
  origin: string,
  options: RequestAdapterOptions = {},
): Promise<Request> {
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const body = await readBody(req, options.maxBodyBytes);
  return new Request(url, { method: req.method ?? "GET", headers, body });
}

/** Write a Web-standard `Response` back onto a Node `ServerResponse`. EXPORTED — see {@link requestFromIncomingMessage}. */
export async function writeResponseToServerResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  const bytes = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.end(bytes);
}

/**
 * Start the wire-protocol v0 reference server for `bundle` and resolve once it is
 * listening. See the module doc for the no-auth / loopback-only caveat.
 */
export function serve(options: ServeOptions): Promise<ServerHandle> {
  const router = createRouter(options.bundle);
  const host = options.host ?? "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const origin = `http://${req.headers.host ?? `${host}:0`}`;
      requestFromIncomingMessage(req, origin)
        .then((request) => router(request))
        .then((response) => writeResponseToServerResponse(res, response))
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "RUNTIME", message: err instanceof Error ? err.message : String(err) } }));
        });
    });
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("failed to bind a TCP address"));
        return;
      }
      resolve({
        host,
        port: addr.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
