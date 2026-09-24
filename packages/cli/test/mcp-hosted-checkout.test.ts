// The local MCP server over a cataloged hosted checkout: reads are served, writes are refused.
//
// A hosted checkout syncs whole documents only, and never Views, blobs or conventions. `superbee
// mcp` run in the checkout is refused up front, but the catalog path (plain `superbee mcp`, then a
// workspace label) opened the same folder with no check, so a View saved there was written to the
// folder and then held by sync forever: silent data loss (designs/local-git-hosted-cli-experience,
// seam 3). The catalog resolver now opens a hosted entry read-only.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { queryHeads, readDoc, writeBlob, writeDoc } from "@superbee/core";
import { decode } from "@toon-format/toon";

import { addCatalogEntry, listCatalogEntries } from "../src/catalog.js";
import { catalog } from "../src/commands/catalog.js";
import { checkout } from "../src/commands/checkout.js";
import { status } from "../src/commands/status.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import { createCatalogMcpWorkspaceResolver } from "../src/mcp-workspace-resolver.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

async function hostedCheckout(before?: (home: string) => Promise<void>): Promise<{ home: string; folder: string; host: FakeHost; receipt: Record<string, unknown> }> {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-mcp-hosted-home-"));
  await before?.(home);
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mcp-hosted-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  let out = "";
  await checkout([BUNDLE, "--host", HOST, "--dir", "team", "--json"], { stdout: (text) => void (out += text), auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return { home, folder: path.join(cwd, "team"), host, receipt: JSON.parse(out) as Record<string, unknown> };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function assertRefused(error: unknown): true {
  assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
  assert.equal(error.code, "FORBIDDEN");
  assert.equal((error.details as { do_this_in?: string }).do_this_in, "app");
  assert.equal((error.details as { bundle_id?: string }).bundle_id, BUNDLE);
  assert.match(error.message, /do this in the Superbee app/);
  return true;
}

test("local MCP over a cataloged hosted checkout serves reads and refuses every write before it touches the folder", async () => {
  // Checkout registers the folder in the catalog; the local MCP app opens it by that label.
  const { home, folder, host, receipt } = await hostedCheckout();
  assert.deepEqual({ ...(receipt.catalog as Record<string, unknown>), id: undefined }, { registered: true, label: BUNDLE, id: undefined, home: "hosted" });
  const context = await createCatalogMcpWorkspaceResolver({ home }).open(BUNDLE);

  // Reads work exactly as before.
  const heads = await queryHeads(context.bundle);
  assert.ok(heads.length > 0, "the checkout's documents are readable");
  const first = heads[0]!;
  assert.equal((await readDoc(context.bundle, first.id)).id, first.id);

  // A View entry blob and its registration: the writes save_transient_view makes. Neither can sync.
  await assert.rejects(
    writeBlob(context.bundle, "views/probe/index.html", new TextEncoder().encode("<p>probe</p>"), "text/html"),
    assertRefused,
  );
  await assert.rejects(
    writeDoc(context.bundle, {
      id: "views-registry/probe",
      frontmatter: { type: "View", title: "Probe", entry: "views/probe/index.html" },
      body: "",
    }),
    assertRefused,
  );
  // A document write through the MCP bridge is refused too: the app is where a checkout's Views run.
  await assert.rejects(
    writeDoc(context.bundle, { id: first.id, frontmatter: { ...first.frontmatter, title: "changed" }, body: "" }),
    assertRefused,
  );
  assert.equal(await exists(path.join(folder, "views", "probe", "index.html")), false);
  assert.equal(await exists(path.join(folder, "views-registry", "probe.md")), false);

  // Nothing is left for sync to hold.
  let out = "";
  await status(["--dir", folder], { stdout: (text) => void (out += text), autoPull: async () => undefined, home });
  const block = (decode(out.trim()) as { sync: { state: string; held_files: number; unsent: number } }).sync;
  assert.equal(block.state, "clean");
  assert.equal(block.held_files, 0);
  assert.equal(block.unsent, 0);
  assert.equal(host.requests.length, 0, "the MCP path sends nothing to the host");
});

test("a local bundle in the catalog stays writable through local MCP", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-mcp-local-home-"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mcp-local-bundle-")));
  const { initBundle } = await import("@superbee/core");
  await initBundle(root);
  await addCatalogEntry("local", root, { home });
  const context = await createCatalogMcpWorkspaceResolver({ home }).open("local");
  await writeDoc(context.bundle, { id: "notes/ok", frontmatter: { type: "Note", title: "OK" }, body: "" });
  assert.equal((await readDoc(context.bundle, "notes/ok")).frontmatter.title, "OK");
});

test("catalog list names each entry's home, and a hosted entry's host, bundle and checkout time", async () => {
  const { home, folder } = await hostedCheckout();
  const [entry] = await listCatalogEntries(home);
  assert.equal(entry!.locator.path, folder);
  assert.equal(entry!.home, "hosted");
  assert.equal(entry!.available, true);

  let out = "";
  await catalog(["list", "--json"], { stdout: (text) => void (out += text), home: () => home });
  const listed = JSON.parse(out) as { entries: Record<string, unknown>[] };
  const row = listed.entries[0]!;
  assert.equal(row.home, "hosted");
  assert.deepEqual(row.hosted, { host: HOST, bundle_id: BUNDLE, checked_out_at: (row.hosted as { checked_out_at: string }).checked_out_at });
  assert.ok(!Number.isNaN(Date.parse((row.hosted as { checked_out_at: string }).checked_out_at)));
});

test("checkout takes the next free catalog label when the bundle id is already a label", async () => {
  const { initBundle } = await import("@superbee/core");
  const other = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mcp-other-")));
  await initBundle(other);
  const { home, folder, receipt } = await hostedCheckout(async (dir) => void (await addCatalogEntry(BUNDLE, other, { home: dir })));
  assert.equal((receipt.catalog as { label: string }).label, `${BUNDLE}-2`);
  const entries = await listCatalogEntries(home);
  assert.deepEqual(entries.map((entry) => [entry.label, entry.home, entry.locator.path]), [
    [BUNDLE, "local", other],
    [`${BUNDLE}-2`, "hosted", folder],
  ]);
});
