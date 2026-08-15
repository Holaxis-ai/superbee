/**
 * `agentstate-lite ui` — the CLI command that boots the local web UI (plans/ui-v1.md rev 3.2).
 * Runs the command function in-process against a real temp filesystem bundle, mirroring
 * `serve.test.ts`'s pattern exactly (injectable `bootUiServer`/`waitForShutdown`, no real OS
 * signals, no lingering listener after a test exits).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:net";

import { initBundle, writeDoc } from "@superbee/core";
import { ui } from "../src/commands/ui.js";
import { docOpen } from "../src/commands/doc/open.js";
import { bootUiServer } from "../src/ui/server.js";
import { CliError } from "../src/errors.js";
import { BUNDLE_NAME_DOC_ID, BUNDLE_NAME_DOC_TYPE } from "../src/bundle-name.js";
import { CONVENTIONAL_BUNDLE_DIR_NAME } from "../src/bundle.js";

async function makeFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-test-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function bindThrowawayListener(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind a throwaway TCP address");
  return { port: addr.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("ui --help: prints usage and does not boot a server", async () => {
  let out = "";
  let booted = false;
  await ui(["--help"], {
    stdout: (s) => (out += s),
    bootUiServer: async (opts) => {
      booted = true;
      return bootUiServer(opts);
    },
    waitForShutdown: () => Promise.resolve(),
    openBrowser: () => {},
  });
  assert.match(out, /superbee ui/);
  assert.equal(booted, false);
});

test("doc open --help: teaches the exact-document browser path and does not boot a server", async () => {
  let out = "";
  let booted = false;
  await docOpen(["--help"], {
    stdout: (s) => (out += s),
    bootUiServer: async (opts) => {
      booted = true;
      return bootUiServer(opts);
    },
    waitForShutdown: () => Promise.resolve(),
    openBrowser: () => {},
  });
  assert.match(out, /superbee doc open <id>/);
  assert.match(out, /existing local web UI/);
  assert.equal(booted, false);
});

test("doc open verifies and opens one exact document through the existing DocPage route", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  await writeDoc(
    { root: dir },
    { id: "docs/review", frontmatter: { type: "Doc", title: "Review me" }, body: "# Evidence" },
  );
  try {
    let out = "";
    let opened: string | undefined;
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const run = docOpen(["docs/review", "--dir", dir, "--port", "0", "--json"], {
      stdout: (s) => (out += s),
      bootUiServer,
      waitForShutdown: () => shutdown,
      openBrowser: (url) => {
        opened = url;
      },
      writeUrlFile: async () => {},
      clearUrlFile: async () => {},
    });

    while (!out) await new Promise((resolve) => setTimeout(resolve, 5));
    const receipt = JSON.parse(out);
    const url = new URL(receipt.url);
    assert.equal(receipt.ui, "listening");
    assert.equal(receipt.document, "docs/review");
    assert.equal(url.searchParams.get("view"), "doc");
    assert.equal(url.searchParams.get("id"), "docs/review");
    assert.ok(url.searchParams.get("token"));
    assert.equal(opened, receipt.url, "doc open opens without a redundant --open flag");
    assert.equal((await fetch(receipt.url)).status, 200);

    resolveShutdown();
    await run;
  } finally {
    await cleanup();
  }
});

test("doc open refuses a missing document before booting or opening misleading UI", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let booted = false;
    let opened = false;
    await assert.rejects(
      () =>
        docOpen(["docs/missing", "--dir", dir], {
          bootUiServer: async (opts) => {
            booted = true;
            return bootUiServer(opts);
          },
          waitForShutdown: () => Promise.resolve(),
          openBrowser: () => {
            opened = true;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "NOT_FOUND");
        assert.match(error.message, /docs\/missing/);
        return true;
      },
    );
    assert.equal(booted, false);
    assert.equal(opened, false);
  } finally {
    await cleanup();
  }
});

test("doc open refuses malformed Markdown before booting or opening misleading UI", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "broken.md"), "---\ntype: [\n---\n# Broken\n", "utf8");
  try {
    let booted = false;
    let opened = false;
    await assert.rejects(
      () =>
        docOpen(["docs/broken", "--dir", dir], {
          bootUiServer: async (opts) => {
            booted = true;
            return bootUiServer(opts);
          },
          waitForShutdown: () => Promise.resolve(),
          openBrowser: () => {
            opened = true;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "RUNTIME");
        assert.match(error.message, /malformed frontmatter/);
        return true;
      },
    );
    assert.equal(booted, false);
    assert.equal(opened, false);
  } finally {
    await cleanup();
  }
});

test("ui --port abc: USAGE (exit 2), not a bare parse crash", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () => ui(["--dir", dir, "--port", "abc"], { bootUiServer, waitForShutdown: () => Promise.resolve(), openBrowser: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("ui --dir <missing>: NOT_FOUND (exit 6), delegated from openBundle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-empty-"));
  try {
    await assert.rejects(
      () => ui(["--dir", path.join(dir, "missing")], { bootUiServer, waitForShutdown: () => Promise.resolve(), openBrowser: () => {} }),
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

test("ui --dir x --remote y: USAGE — mutually exclusive, same as every other remote-capable command", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () =>
        ui(["--dir", dir, "--remote", "http://127.0.0.1:4818"], {
          bootUiServer,
          waitForShutdown: () => Promise.resolve(),
          openBrowser: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("ui --port <in-use>: maps a real EADDRINUSE to a structured RUNTIME envelope (exit 1)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  const listener = await bindThrowawayListener();
  try {
    await assert.rejects(
      () =>
        ui(["--dir", dir, "--port", String(listener.port)], {
          bootUiServer,
          waitForShutdown: () => Promise.resolve(),
          openBrowser: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        assert.equal(err.exitCode, 1);
        assert.match(err.help ?? "", /--port 0/);
        return true;
      },
    );
  } finally {
    await listener.close();
    await cleanup();
  }
});

test("ui --dir: prints a tokenized receipt, boots a real listener enforcing the session gate, then closes cleanly on shutdown", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let out = "";
    let opened: string | undefined;
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const run = ui(["--dir", dir, "--port", "0", "--json", "--open"], {
      stdout: (s) => (out += s),
      bootUiServer,
      waitForShutdown: () => shutdown,
      openBrowser: (url) => {
        opened = url;
      },
      // Inject no-ops so the test never writes to the real ~/.agentstate/ui-url.
      writeUrlFile: async () => {},
      clearUrlFile: async () => {},
    });

    while (!out) await new Promise((r) => setTimeout(r, 5));
    const receipt = JSON.parse(out);
    assert.equal(receipt.ui, "listening");
    assert.equal(receipt.mode, "dir");
    assert.equal(receipt.root, dir);
    assert.match(receipt.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/);
    assert.equal(opened, receipt.url);

    const origin = new URL(receipt.url).origin;

    // No credentials at all -> 403, both for an asset request and a /v0 request.
    assert.equal((await fetch(origin + "/")).status, 403);
    assert.equal((await fetch(origin + "/v0/bundles/default/docs")).status, 403);

    // The tokenized receipt URL authenticates AND exchanges the token for a session cookie.
    const first = await fetch(receipt.url);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const setCookie = first.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];

    const withCookie = await fetch(origin + "/v0/bundles/default/docs", { headers: { cookie: cookie ?? "" } });
    assert.equal(withCookie.status, 200);

    // A mutation still needs X-Requested-With even with a valid cookie.
    const mutationNoHeader = await fetch(origin + "/v0/bundles/default/docs/tasks/x", {
      method: "PUT",
      headers: { cookie: cookie ?? "", "content-type": "application/json" },
      body: JSON.stringify({ frontmatter: { type: "Task" }, body: "" }),
    });
    assert.equal(mutationNoHeader.status, 403);

    resolveShutdown();
    await run;
    await assert.rejects(() => fetch(origin + "/v0/bundles/default/docs"));
  } finally {
    await cleanup();
  }
});

test("ui --dir over a CONVENTIONAL bundle: /__ui/config names the PROJECT (parent dir), and an explicit docs/bundle doc overrides it live (tasks/bundle-display-name)", async () => {
  // The field report's exact shape: the bundle rooted at `<project>/.agentstate-lite/`, which
  // used to make EVERY project's shell header/bridge hello read ".agentstate-lite".
  const tmp = await mkdtemp(path.join(tmpdir(), "agentstate-lite-ui-name-"));
  const bundleRoot = path.join(tmp, "my-project", CONVENTIONAL_BUNDLE_DIR_NAME);
  await mkdir(bundleRoot, { recursive: true });
  await initBundle(bundleRoot);
  try {
    let out = "";
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const run = ui(["--dir", bundleRoot, "--port", "0", "--json"], {
      stdout: (s) => (out += s),
      bootUiServer,
      waitForShutdown: () => shutdown,
      openBrowser: () => {},
      writeUrlFile: async () => {},
      clearUrlFile: async () => {},
    });
    while (!out) await new Promise((r) => setTimeout(r, 5));
    const receipt = JSON.parse(out);
    const token = new URL(receipt.url).searchParams.get("token");

    // Chain rung (b): the conventional dir's PARENT — the project — not ".agentstate-lite".
    const config = await fetch(`${new URL(receipt.url).origin}/__ui/config?token=${token}`);
    assert.equal(config.status, 200);
    const body = (await config.json()) as { name: string; mode: string };
    assert.equal(body.mode, "dir");
    assert.equal(body.name, "my-project");

    // SILENT-APPROPRIATION guard (PR #67 review): an ORDINARY doc at the well-known id — any
    // type other than the marker — must NOT rename the project.
    await writeDoc({ root: bundleRoot }, { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: "Doc", title: "Bundle Storage Reference" }, body: "" });
    const configOrdinary = await fetch(`${new URL(receipt.url).origin}/__ui/config?token=${token}`);
    assert.equal(((await configOrdinary.json()) as { name: string }).name, "my-project");

    // Chain rung (a), LIVE: writing the MARKER-typed doc changes the name on the next config
    // fetch with no server restart — the same JSON the shell header and the bridge's
    // hello.bundle.name render.
    await writeDoc({ root: bundleRoot }, { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: BUNDLE_NAME_DOC_TYPE, title: "Renamed Project" }, body: "" });
    const config2 = await fetch(`${new URL(receipt.url).origin}/__ui/config?token=${token}`);
    const body2 = (await config2.json()) as { name: string };
    assert.equal(body2.name, "Renamed Project");

    resolveShutdown();
    await run;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
