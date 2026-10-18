/**
 * A scripted provider and the memory transport that reaches it. The peer stands in for the
 * network: it answers every request from a script and records exactly what arrived, headers
 * included, so a test can see what a transport sent. The memory transport honours the transport
 * contract (no redirect following, a refused rather than truncated body over the bound, the
 * credential only toward its hosts over https), so it passes the conformance suite.
 */
import type { HttpMethod, Transport, TransportResult } from "../source-engine/types.js";

/** A request as it reached the provider. */
export interface PeerRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}

export type PeerResponse =
  | { status: number; headers?: Readonly<Record<string, string>>; body?: string }
  /** Never answers: the request waits for the run's deadline. */
  | { hang: true }
  /** The connection fails. */
  | { fail: true };

export interface ScriptedExchange {
  request: { method?: HttpMethod; url: string };
  response: PeerResponse;
}

/** The credential a transport under test holds: a header sent only toward `hosts` over https. */
export interface TransportCredential {
  hosts: readonly string[];
  header: string;
  value: string;
}

export class ScriptedPeer {
  /** Every request that reached the provider, in order. */
  readonly received: PeerRequest[] = [];
  private readonly handler: (request: PeerRequest) => PeerResponse;
  private readonly onHang: (() => void) | undefined;

  constructor(handler: (request: PeerRequest) => PeerResponse, options: { onHang?: () => void } = {}) {
    this.handler = handler;
    this.onHang = options.onHang;
  }

  answer(request: PeerRequest): PeerResponse {
    const copy: PeerRequest = { url: request.url, method: request.method, headers: { ...request.headers }, ...(request.body !== undefined ? { body: request.body } : {}) };
    this.received.push(copy);
    const response = this.handler(copy);
    if ("hang" in response) this.onHang?.();
    return response;
  }

  /** Requests received for one hostname. */
  to(hostname: string): PeerRequest[] {
    return this.received.filter((request) => new URL(request.url).hostname === hostname);
  }
}

const normalized = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
};

/** A peer answering from exchanges, each used once, matched on method and URL in order. */
export class ExchangePeer extends ScriptedPeer {
  /** Requests no exchange matched (answered 404); robots.txt is answered 404 without being listed. */
  readonly unscripted: string[];
  private readonly pending: ScriptedExchange[];

  constructor(exchanges: readonly ScriptedExchange[], options: { onHang?: () => void } = {}) {
    const pending = [...exchanges];
    const unscripted: string[] = [];
    super((request) => {
      const url = normalized(request.url);
      const index = pending.findIndex((exchange) => (exchange.request.method ?? "GET") === request.method && normalized(exchange.request.url) === url);
      if (index === -1) {
        if (new URL(url).pathname !== "/robots.txt") unscripted.push(`${request.method} ${url}`);
        return { status: 404, body: "" };
      }
      return pending.splice(index, 1)[0]!.response;
    }, options);
    this.pending = pending;
    this.unscripted = unscripted;
  }

  /** Exchanges no request used. */
  unused(): ScriptedExchange[] {
    return [...this.pending];
  }
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const abortedError = (): Error => Object.assign(new Error("request aborted"), { name: "AbortError" });

/**
 * A transport over a scripted peer. It adds `credential` only to https requests whose host is one
 * of its hosts, returns redirects unfollowed, refuses a body over `maxBytes` and rejects when the
 * request's signal aborts.
 */
export function peerTransport(peer: ScriptedPeer, options: { credential?: TransportCredential } = {}): Transport {
  const credential = options.credential;
  return {
    async request(input): Promise<TransportResult> {
      if (input.signal?.aborted) throw abortedError();
      const url = new URL(input.url);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
      if (credential && url.protocol === "https:" && credential.hosts.includes(url.hostname)) headers[credential.header.toLowerCase()] = credential.value;
      const response = peer.answer({ url: url.href, method: input.method, headers, ...(input.body !== undefined ? { body: input.body } : {}) });
      if ("fail" in response) throw new Error("connection failed");
      if ("hang" in response) {
        const signal = input.signal;
        if (!signal) throw abortedError();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw abortedError();
      }
      const body = response.body ?? "";
      const bytes = utf8Bytes(body);
      if (bytes > input.maxBytes) return { ok: false, refused: "too_large" };
      const lower: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers ?? {})) lower[name.toLowerCase()] = value;
      return { ok: true, status: response.status, headers: lower, body, bytes };
    },
  };
}
