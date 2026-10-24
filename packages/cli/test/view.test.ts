import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeBlob, writeDoc } from "@superbee/core";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { view } from "../src/commands/view.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { bootUiServer, type UiServerHandle } from "@superbee/ui-server";
import { createRouter } from "@superbee/server";
import { CliError } from "../src/errors.js";
import type { ManagedUiControllerOptions } from "../src/ui/managed-authority.js";

test("view list is discoverable and projects the shared durable catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-view-list-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "views-registry/roadmap",
      frontmatter: {
        type: "View",
        title: "Roadmap",
        entry: "views/roadmap.html",
        access: "bundle-read",
        presentation: "workspace",
      },
      body: "",
    });
    await writeBlob(
      bundle,
      "views/roadmap.html",
      new TextEncoder().encode("<!doctype html><title>Roadmap</title>"),
      "text/html; charset=utf-8",
    );
    let output = "";
    await view(["list", "--dir", dir, "--json"], {
      stdout: (text) => { output += text; },
      autoPull: async () => {},
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.views.count, 1);
    assert.equal(parsed.views.rows[0].id, "views-registry/roadmap");
    assert.equal(parsed.views.rows[0].entry, undefined);
    assert.equal(parsed.views.rows[0].presentation, "workspace");
    assert.ok(KNOWN_COMMANDS.includes("view"));
    assert.ok(COMMAND_GROUPS.flatMap((group) => group.commands).some((row) => row.usage.startsWith("view list")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("view open drives the real managed handoff for the exact selected View without leaking reusable secrets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-view-open-"));
  const home = await mkdtemp(path.join(tmpdir(), "superbee-view-open-home-"));
  const bundle = await initBundle(dir);
  await writeDoc(bundle, { id: "views-registry/probe", frontmatter: { type: "View", entry: "views/probe.html", access: "bundle-read" }, body: "" });
  await writeBlob(bundle, "views/probe.html", new TextEncoder().encode("<!doctype html><title>Probe</title>"), "text/html");
  let server: UiServerHandle | undefined;
  let spawns = 0;
  const SESSION = "synthetic-view-open-browser-secret";
  const managedController: ManagedUiControllerOptions = {
    home,
    spawnWorker: async (input) => {
      spawns++;
      server = await bootUiServer({
        mode: "dir", bundle, router: createRouter(bundle), sessionSecret: SESSION,
        sessionCookieName: "superbee_test_view_open", renderDocument: ({ body }) => ({ html: body, bounded: false }),
        serveAsset: () => ({ status: 200, headers: {}, body: new TextEncoder().encode("shell") }),
        management: { secret: input.management_secret, identity: {
          protocol: input.authority.protocol, mode: "dir", authority_key: input.authority.key,
          bundle_root: input.authority.bundle_root, launch_root: input.authority.launch_root,
          actor: input.authority.actor, launch_nonce: "synthetic-launch-nonce", pid: 123,
          started_at: "2026-10-24T00:00:00.000Z",
        } },
      });
      return { host: server.host as "127.0.0.1", port: server.port, browser_token: server.token,
        launch_nonce: "synthetic-launch-nonce", pid: 123, started_at: "2026-10-24T00:00:00.000Z" };
    },
  };
  const opened: string[] = [];
  let output = "";
  const deps = { managedController, stdout: (text: string) => { output = text; }, openBrowser: (value: string) => { opened.push(value); } };
  try {
    await view(["open", "views-registry/probe", "--dir", dir, "--actor", "human:probe", "--no-open", "--json"], deps);
    const receipt = JSON.parse(output);
    assert.equal(receipt.view, "views-registry/probe");
    assert.equal(receipt.root, await realpath(dir));
    assert.equal(receipt.actor, "human:probe");
    assert.equal(receipt.presentation, "handoff_prepared");
    assert.equal(opened.length, 0);
    const destination = new URL(receipt.url);
    assert.equal(destination.searchParams.get("view"), "page");
    assert.equal(destination.searchParams.get("id"), receipt.view);
    assert.equal(destination.searchParams.get("token"), null);
    assert.ok(!output.includes(SESSION));
    const handoff = new URL(receipt.browser_launch.url);
    assert.equal(handoff.pathname, "/__ui/browser-launch");
    assert.ok(receipt.browser_launch.private && receipt.browser_launch.one_use);
    const enroll = await fetch(`${handoff.origin}${handoff.pathname}`, {
      method: "POST", headers: { origin: handoff.origin, "x-requested-with": "superbee-browser-launch", "content-type": "application/json" },
      body: JSON.stringify({ ticket: handoff.hash.slice(1) }),
    });
    assert.equal(enroll.status, 200);
    const cookie = enroll.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await fetch(receipt.url)).status, 403, "credential-free link grants nothing to another browser");
    const mint = await fetch(`${destination.origin}/__page/mint`, {
      method: "POST", headers: { cookie, "x-requested-with": "superbee", "content-type": "application/json" },
      body: JSON.stringify({ registryId: receipt.view }),
    });
    assert.equal(mint.status, 200);
    assert.equal(((await mint.json()) as { authorization: { authorized: boolean } }).authorization.authorized, false, "enrollment is not active View approval");
    await view(["open", receipt.view, "--dir", dir, "--actor", "human:probe"], deps);
    assert.equal(spawns, 1);
    assert.equal(opened.length, 1);
    assert.equal(new URL(opened[0]!).pathname, "/__ui/browser-launch");
    assert.ok(!output.includes(SESSION) && !output.includes(new URL(opened[0]!).hash.slice(1)));
    assert.match(output, /open_requested/);
  } finally {
    await server?.close();
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
  }
});

test("view open refuses unsupported selectors and targets before starting an authority", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-view-open-denied-"));
  const bundle = await initBundle(dir);
  await writeDoc(bundle, { id: "notes/plain", frontmatter: { type: "Reference" }, body: "" });
  let spawns = 0;
  try {
    for (const args of [
      ["open", "notes/plain", "--dir", dir],
      ["open", "missing", "--dir", dir],
      ["open", "notes/plain", "--dir", dir, "--no-open"],
      ["open", "notes/plain", "--remote", "http://127.0.0.1:9"],
      ["open", "notes/plain", "extra", "--dir", dir],
    ]) {
      await assert.rejects(() => view(args, { managedController: { spawnWorker: async () => { spawns++; throw new Error("unexpected start"); } } }),
        (error: unknown) => error instanceof CliError && ["USAGE", "NOT_FOUND"].includes(error.code));
    }
    assert.equal(spawns, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
