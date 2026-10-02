// A loopback HTTP bridge in front of an in-process `FakeHost`, so a child process (the built CLI,
// or a crash-test child) reaches the fake over real HTTP on 127.0.0.1. The bridge adds no
// behavior: each request goes to the fake the getter names now, at that fake's own origin, and its
// answer comes back byte for byte. A fake that throws closes the socket, as a lost connection.
import { createServer, type Server } from "node:http";

import type { FakeHost } from "./fake-hosted-sync.js";

export interface FakeHostBridge {
  readonly server: Server;
  /** `http://127.0.0.1:<port>`: a fake built with this `origin` admits the token for `<url>/mcp`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface FakeHostBridgeOptions {
  /** The origin a request is forwarded under (the crash tests keep a fake at its default origin). */
  readonly origin?: () => string;
  /**
   * Where a request outside `/sync/v1/` goes, when the host's other surface is faked too: the base
   * URL of a local fake (for example `FakeIssuer`, whose discovery and sign-in routes then answer
   * at the bridge's own origin).
   */
  readonly others?: () => string;
}

/** Serve `host()` on a loopback port. */
export async function startFakeHostBridge(host: () => FakeHost, options: FakeHostBridgeOptions = {}): Promise<FakeHostBridge> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers.set(k, v);
      try {
        const fake = host();
        const body = Buffer.concat(chunks).toString("utf8");
        const others = options.others?.();
        const response = others !== undefined && !(req.url ?? "").startsWith("/sync/v1/")
          ? await fetch(`${others}${req.url}`, { method: req.method, headers, ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }) })
          : await fake.fetch(`${options.origin?.() ?? fake.origin}${req.url}`, { method: req.method, headers, body });
        const out: Record<string, string> = {};
        response.headers.forEach((v, k) => (out[k] = v));
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.socket?.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
