/**
 * `agentstate-lite serve` — the CLI command that boots the reference wire-protocol server
 * (`@superbee/server`) over a local bundle.
 *
 * Runs the command function in-process (no subprocess) against a real temp filesystem bundle,
 * mirroring `link.test.ts`'s node:test + ts-loader pattern. `bootServer`/`waitForShutdown` are
 * injected so the foreground-until-signal shape is testable without a real OS signal or a
 * lingering listener after the test exits (see `src/commands/serve.ts`'s `ServeCliDeps`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:net";

import { initBundle } from "@superbee/core";
import { serve as bootServer } from "@superbee/server";
import { serve, DEFAULT_SERVE_PORT } from "../src/commands/serve.js";
import { CliError } from "../src/errors.js";

async function makeFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-serve-test-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Bind a throwaway listener on an ephemeral port so a test can provoke a real EADDRINUSE. */
async function bindThrowawayListener(): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind a throwaway TCP address");
  return { port: addr.port, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("serve: documents a stable default port (4818); tests themselves always bind ephemeral (0) to avoid port flakiness", () => {
  assert.equal(DEFAULT_SERVE_PORT, 4818);
});

test("serve: prints the TOON receipt first (url/root/help), boots a real listener, then closes cleanly on shutdown", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let out = "";
    await serve(["--dir", dir, "--port", "0", "--json"], {
      stdout: (s) => (out += s),
      bootServer,
      waitForShutdown: () => Promise.resolve(),
    });

    const receipt = JSON.parse(out);
    assert.equal(receipt.serve, "listening");
    assert.match(receipt.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(receipt.root, dir);
    assert.match(receipt.auth, /none/);
    assert.match(receipt.concurrency, /across same-user local processes/);
    assert.match(receipt.concurrency, /fails closed/);
    assert.match(receipt.help[0], /list --remote http:\/\/127\.0\.0\.1:\d+/);

    // waitForShutdown resolved immediately, so the command already closed the listener before
    // returning — a further request must fail to connect (ECONNREFUSED), not hang or succeed.
    await assert.rejects(() => fetch(`${receipt.url}/v0/capabilities`));
  } finally {
    await cleanup();
  }
});

test("serve: defaults host to 127.0.0.1 (loopback) when --host is omitted", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let out = "";
    await serve(["--dir", dir, "--port", "0", "--json"], {
      stdout: (s) => (out += s),
      bootServer,
      waitForShutdown: () => Promise.resolve(),
    });
    const receipt = JSON.parse(out);
    assert.match(receipt.url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await cleanup();
  }
});

test("serve: the bundle actually served is reachable over HTTP before shutdown fires", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let capturedUrl = "";
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const run = serve(["--dir", dir, "--port", "0", "--json"], {
      stdout: (s) => {
        const receipt = JSON.parse(s);
        capturedUrl = receipt.url;
      },
      bootServer,
      waitForShutdown: () => shutdown,
    });

    // Poll briefly for the receipt to land (stdout write happens synchronously before
    // waitForShutdown is awaited, but give the microtask queue a tick).
    while (!capturedUrl) await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${capturedUrl}/v0/capabilities`);
    assert.equal(res.status, 200);

    resolveShutdown();
    await run;

    await assert.rejects(() => fetch(`${capturedUrl}/v0/capabilities`));
  } finally {
    await cleanup();
  }
});

test("serve --port abc: USAGE (exit 2), not a bare parse crash", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () => serve(["--dir", dir, "--port", "abc"], { bootServer, waitForShutdown: () => Promise.resolve() }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("serve --port 99999: USAGE (exit 2), not an uncaught ERR_SOCKET_BAD_PORT from node:net", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () => serve(["--dir", dir, "--port", "99999"], { bootServer, waitForShutdown: () => Promise.resolve() }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("serve --port <in-use>: maps a real EADDRINUSE to a structured RUNTIME envelope with a fixing help hint (exit 1), not a raw Node error", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  const listener = await bindThrowawayListener();
  try {
    await assert.rejects(
      () =>
        serve(["--dir", dir, "--port", String(listener.port)], {
          bootServer,
          waitForShutdown: () => Promise.resolve(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        assert.equal(err.exitCode, 1);
        assert.match(err.message, new RegExp(String(listener.port)));
        assert.match(err.message, /already in use/);
        assert.match(err.help ?? "", /--port 0/);
        return true;
      },
    );
  } finally {
    await listener.close();
    await cleanup();
  }
});

test("serve --help: prints usage and does not boot a server", async () => {
  let out = "";
  let booted = false;
  await serve(["--help"], {
    stdout: (s) => (out += s),
    bootServer: async (opts) => {
      booted = true;
      return bootServer(opts);
    },
    waitForShutdown: () => Promise.resolve(),
  });
  assert.match(out, /superbee serve/);
  assert.equal(booted, false);
});

test("serve --dir <missing>: NOT_FOUND (exit 6), delegated from openBundle — not a raw crash", async () => {
  // serve() opens the bundle before binding a socket; an unavailable dir must surface the
  // same structured NOT_FOUND every other bundle command gives, not an unhandled error.
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-serve-empty-"));
  try {
    await assert.rejects(
      () => serve(["--dir", path.join(dir, "missing")], { bootServer, waitForShutdown: () => Promise.resolve() }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.exitCode, 6);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
