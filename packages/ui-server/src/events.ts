// The loopback UI server's Server-Sent-Events fan-out (tasks/ui-pages-spike, "Live updates"): the SHELL
// (and only the shell) holds an `EventSource('/events')`; pages never see SSE — their
// `connect-src 'none'` CSP forbids it. The watcher (`watch.ts`) diffs head-version snapshots and
// calls {@link SseHub.broadcast}; the shell then fans each change into subscribed iframes over the
// postMessage bridge. Kept deliberately tiny — one Set of live node responses, no per-client
// queueing (a change event is a delta the shell refetches against, so a dropped frame self-heals
// on the next one).
import type { ServerResponse } from "node:http";

/** How often to emit an SSE comment heartbeat, keeping intermediaries from idling the stream shut and surfacing a dead client promptly via a failed write. */
const HEARTBEAT_MS = 25_000;

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  /**
   * Attach a freshly-opened SSE response: write the event-stream headers, register it, and
   * de-register it on close. `extraHeaders` carries the session cookie when the connecting
   * request authenticated via the URL token (mirrors the main server's cookie-grant path).
   *
   * After {@link close}, a late-arriving stream (an EventSource reconnect racing onto a
   * kept-alive socket mid-shutdown) is severed instead of registered — a post-close stream
   * would never be ended and would hold the http server's `close()` open forever.
   */
  add(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
    if (this.closed) {
      res.destroy();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...extraHeaders,
    });
    // A first comment flushes headers so the browser's EventSource fires `onopen` immediately.
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    this.ensureHeartbeat();
  }

  /** Serialize `payload` as one `data:` frame and write it to every live client (dropping any whose write throws). */
  broadcast(payload: unknown, event?: "document-offers"): void {
    const frame = `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Number of live SSE clients (test/observability). */
  size(): number {
    return this.clients.size;
  }

  /** End every stream, stop the heartbeat, and refuse any later {@link add} — called on server shutdown so no timer (or late reconnect) keeps the server alive. */
  close(): void {
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(": ping\n\n");
        } catch {
          this.clients.delete(res);
        }
      }
    }, HEARTBEAT_MS);
    // Never let the heartbeat alone keep the event loop alive.
    this.heartbeat.unref?.();
  }
}
