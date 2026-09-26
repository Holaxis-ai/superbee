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

/**
 * Serve `host()` on a loopback port. `origin` overrides the origin the request is forwarded under
 * (the crash tests keep a fake at its default origin and reach it through the bridge).
 */
export async function startFakeHostBridge(host: () => FakeHost, origin?: () => string): Promise<FakeHostBridge> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers.set(k, v);
      try {
        const fake = host();
        const response = await fake.fetch(`${origin?.() ?? fake.origin}${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks).toString("utf8") });
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
