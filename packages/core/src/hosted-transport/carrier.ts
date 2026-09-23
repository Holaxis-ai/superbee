/**
 * The carrier seam: how a hosted request leaves and what comes back, with the credential kept on
 * the carrier's side. The browser's carrier sends the session cookie and CSRF token; the CLI's
 * sends a bearer token. Everything above the seam (the read adapter, the whole-document
 * transport, the answer rows) is the same for both, so one answer grammar serves every client.
 *
 * A carrier reports two failures and never a third: `denied` says nothing left (the credential
 * was already gone, so the request was never sent), and `unavailable` says the request may have
 * left and its answer is unknown. It never reports "not applied" on its own.
 */

/** A hosted answer as the route sent it: the status, the headers, and the bounded JSON body (undefined when there is none). */
export type HostedAnswer = { status: number; headers: Headers; body: unknown };

/** A streamed answer: the body as a stream for a `2xx`, otherwise the bounded refusal envelope. */
export type HostedStream = { status: number; headers: Headers } & ({ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; body: unknown });

export interface HostedRequestOptions {
  /** Largest answer body admitted, in bytes; a larger or undecodable body is `unavailable`. */
  maximum: number;
  /** The request identity of an identified write or its outcome lookup. */
  writeRequest?: string;
  /**
   * The binding the request is pinned to: the browser's editor recovery target, or the CLI
   * checkout's digest. The carrier decides which header carries it.
   */
  binding?: string;
  /**
   * The tombstone a create acknowledges it re-creates (`X-Superbee-Recreate`), on a create and
   * on that create's outcome lookup only. It is part of the request identity on the host, so a
   * lookup must carry exactly what the write carried.
   */
  recreate?: string;
}

/** The header that carries {@link HostedRequestOptions.recreate}. */
export const RECREATE_HEADER = "X-Superbee-Recreate";

export interface HostedCarrier {
  json(path: string, input: unknown, signal: AbortSignal, options: HostedRequestOptions): Promise<HostedAnswer>;
  stream(path: string, input: unknown, signal: AbortSignal): Promise<HostedStream>;
}

export class HostedCarrierError extends Error {
  override readonly name = "HostedCarrierError";
  readonly code: "denied" | "unavailable";
  constructor(code: "denied" | "unavailable", options?: { cause?: unknown }) {
    super(code, options);
    this.code = code;
  }
}

const WRITE_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING = /^sha256:[a-f0-9]{64}$/;

export interface FetchCarrierOptions {
  /** The host's origin, e.g. `https://superbee.example`; paths are resolved against it. */
  baseUrl: string;
  /**
   * The credential headers for one request, such as `{ Authorization: "Bearer …" }`. A rejection
   * means no credential is available: the request is not sent and the carrier reports `denied`.
   */
  credentials(signal: AbortSignal): Promise<Record<string, string>>;
  /** The header that carries `binding`. Default `X-Superbee-Checkout`. */
  bindingHeader?: string;
  fetch?: typeof fetch;
  /** Every request is answered within this many milliseconds; a stream restarts it at each chunk. Default 15 s. */
  deadlineMs?: number;
}

async function readBounded(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new HostedCarrierError("unavailable");
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (size === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (cause) {
    throw new HostedCarrierError("unavailable", { cause });
  }
}

/** Restart `deadlineMs` at every chunk, so a slow but live stream is not cut and a stalled one is. */
function idleBounded(body: ReadableStream<Uint8Array>, deadlineMs: number, abort: () => void): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(abort, deadlineMs);
  };
  arm();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        arm();
        controller.enqueue(chunk);
      },
      flush() {
        clearTimeout(timer);
      },
    }),
  );
}

/**
 * A carrier over `fetch` with caller-supplied credential headers: the shape the CLI's bearer
 * carrier takes. Requests are `POST` with a JSON body, never follow redirects, and are refused
 * before sending when the identity or binding is malformed.
 */
export function createFetchCarrier(options: FetchCarrierOptions): HostedCarrier {
  const fetcher = options.fetch ?? fetch;
  const deadlineMs = options.deadlineMs ?? 15_000;
  const bindingHeader = options.bindingHeader ?? "X-Superbee-Checkout";
  const base = new URL(options.baseUrl);

  async function send(path: string, input: unknown, signal: AbortSignal, extra: Record<string, string>, deadline: AbortSignal): Promise<Response> {
    if (!path.startsWith("/")) throw new TypeError(`hosted route '${path}' must be absolute`);
    let credentials: Record<string, string>;
    try {
      credentials = await options.credentials(signal);
    } catch (cause) {
      throw new HostedCarrierError("denied", { cause });
    }
    if (signal.aborted) throw new HostedCarrierError("denied");
    try {
      return await fetcher(new URL(path, base), {
        method: "POST",
        redirect: "error",
        headers: { ...credentials, ...extra, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.any([signal, deadline]),
      });
    } catch (cause) {
      throw new HostedCarrierError("unavailable", { cause });
    }
  }

  return {
    async json(path, input, signal, request) {
      if (request.writeRequest !== undefined && !WRITE_REQUEST.test(request.writeRequest)) throw new HostedCarrierError("denied");
      if (request.binding !== undefined && !BINDING.test(request.binding)) throw new HostedCarrierError("denied");
      if (request.recreate !== undefined && !BINDING.test(request.recreate)) throw new HostedCarrierError("denied");
      const extra: Record<string, string> = {};
      if (request.writeRequest !== undefined) extra["X-Superbee-Write-Request"] = request.writeRequest;
      if (request.binding !== undefined) extra[bindingHeader] = request.binding;
      if (request.recreate !== undefined) extra[RECREATE_HEADER] = request.recreate;
      const deadline = AbortSignal.timeout(deadlineMs);
      const response = await send(path, input, signal, extra, deadline);
      let body: unknown;
      try {
        body = await readBounded(response, request.maximum);
      } catch (error) {
        // A refusal's envelope is best effort: its status already decides, and an unreadable
        // body must never read as "not applied".
        if (response.ok) throw error instanceof HostedCarrierError ? error : new HostedCarrierError("unavailable", { cause: error });
        body = undefined;
      }
      return { status: response.status, headers: response.headers, body };
    },
    async stream(path, input, signal) {
      const idle = new AbortController();
      const firstByte = setTimeout(() => idle.abort(), deadlineMs);
      let response: Response;
      try {
        response = await send(path, input, signal, {}, idle.signal);
      } finally {
        clearTimeout(firstByte);
      }
      if (!response.ok || !response.body) {
        const body = await readBounded(response, 64 * 1024).catch(() => undefined);
        return { status: response.status, headers: response.headers, ok: false, body };
      }
      return { status: response.status, headers: response.headers, ok: true, body: idleBounded(response.body, deadlineMs, () => idle.abort()) };
    },
  };
}
