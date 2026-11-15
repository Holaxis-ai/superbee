/**
 * The UI host is the repository's only listener for the wire routes, and it must bind loopback only.
 * The handle's `host` is a constant, so this reads the real socket: it records the `node:http` server
 * the host creates and checks the address that server actually bound, then tries the same port on a
 * non-loopback interface, which must refuse the connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Server } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

import { MemoryBackend } from "@superbee/core";

import { bootUiServer } from "../src/server.js";

function nonLoopbackIPv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2_000, () => { socket.destroy(); resolve(false); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

test("the UI host's socket binds 127.0.0.1 and is unreachable on a non-loopback interface", async () => {
  const listened: Server[] = [];
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    listened.push(this);
    return (listen as (...a: unknown[]) => Server).apply(this, args);
  } as typeof Server.prototype.listen;
  let handle;
  try {
    handle = await bootUiServer({
      mode: "dir",
      bundle: { root: "mem://loopback-binding", backend: new MemoryBackend() },
      sessionSecret: "loopback-binding-secret",
      renderDocument: ({ body }) => ({ html: body, bounded: false }),
      serveAsset: () => ({ status: 404, headers: {}, body: null }),
    });
  } finally {
    Server.prototype.listen = listen;
  }
  try {
    assert.equal(listened.length, 1, "the host creates exactly one listener");
    const address = listened[0]!.address();
    assert.ok(address !== null && typeof address === "object");
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.port, handle.port);
    assert.equal(await connects("127.0.0.1", handle.port), true);
    const external = nonLoopbackIPv4();
    if (external !== undefined) assert.equal(await connects(external, handle.port), false, `reachable on ${external}`);
  } finally {
    await handle.close();
  }
});
