/**
 * The loopback listener's `node:http` adapter: Node's `IncomingMessage`/`ServerResponse` to and from
 * the Web-standard `Request`/`Response` the router and every UI route use.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

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

/** Adapt a Node `IncomingMessage` into a Web-standard `Request` the router accepts. */
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

/**
 * Write a Web-standard `Response` back onto a Node `ServerResponse`.
 *
 * The body is piped, never buffered: a streamed response (the snapshot route) reaches the socket
 * chunk by chunk under backpressure and is never held in memory a second time. A body that fails
 * mid-stream destroys the socket, so the client observes a truncated body rather than a
 * well-formed short one, and this call rejects after the headers have already been sent.
 */
export async function writeResponseToServerResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res);
}
