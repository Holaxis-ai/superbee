// The local MCP server over a hosted checkout (designs/seamless-multi-backend-cli, section 4.3):
// the checkout is served through its folder. Reads are served and kept fresh by the automatic
// pull; a document write sync can send lands in the folder and the next `sync` sends it; a write
// sync would hold (a View's entry blob, conventions, reserved files, a retype, an oversize
// document) is refused before the file changes, with the reason the sync scan would record. Both
// open paths (the catalog resolver and `mcp --dir`) serve the same guarded bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteDoc, queryHeads, readDoc, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { WHOLE_DOCUMENT_BOUNDS } from "@superbee/core/hosted-transport";
import { decode } from "@toon-format/toon";

import { addCatalogEntry, listCatalogEntries } from "../src/catalog.js";
import { openBundle } from "../src/bundle.js";
import { catalog } from "../src/commands/catalog.js";
import { checkout } from "../src/commands/checkout.js";
import { mcp } from "../src/commands/mcp.js";
import { status } from "../src/commands/status.js";
import { sync } from "../src/commands/sync.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { recordPulled } from "../src/hosted/freshness.js";
import { assertAllowedInHostedCheckout } from "../src/hosted/refusals.js";
import { servedBundle } from "../src/hosted/served-bundle.js";
import { createCatalogMcpWorkspaceResolver } from "../src/mcp-workspace-resolver.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Checkout {
  home: string;
  cwd: string;
  folder: string;
  host: FakeHost;
  auth: HostedAuthDeps;
  receipt: Record<string, unknown>;
}

async function hostedCheckout(before?: (home: string) => Promise<void>): Promise<Checkout> {
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
  return { home, cwd, folder: path.join(cwd, "team"), host, auth, receipt: JSON.parse(out) as Record<string, unknown> };
}

async function runSync(c: Checkout, fetch: typeof c.host.fetch = c.host.fetch): Promise<void> {
  await sync(["--dir", c.folder], { stdout: () => {}, auth: c.auth, cwd: c.cwd, fetch, write: { sleep: async () => {}, lookupDelayMs: 0 }, sleep: async () => {} });
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The held refusal, with the reason the sync scan records; `app` when only the Superbee app can do it. */
function refusedAs(heldReason: string, app: boolean) {
  return (error: unknown): true => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.equal(error.code, "FORBIDDEN");
    const details = error.details as { reason?: string; held_reason?: string; bundle_id?: string; do_this_in?: string };
    assert.equal(details.reason, "not_syncable");
    assert.equal(details.held_reason, heldReason);
    assert.equal(details.bundle_id, BUNDLE);
    assert.equal(details.do_this_in, app ? "app" : undefined);
    return true;
  };
}

async function syncState(c: Checkout): Promise<{ state: string; held_files: number; unsent: number }> {
  let out = "";
  await status(["--dir", c.folder], { stdout: (text) => void (out += text), autoPull: async () => undefined, home: c.home });
  return (decode(out.trim()) as { sync: { state: string; held_files: number; unsent: number } }).sync;
}

test("local MCP over a cataloged hosted checkout: reads served, a sendable document write synced, held writes refused before the file changes", async () => {
  const c = await hostedCheckout();
  assert.deepEqual({ ...(c.receipt.catalog as Record<string, unknown>), id: undefined }, { registered: true, label: BUNDLE, id: undefined, home: "hosted" });
  const context = await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE);

  // Reads work exactly as before.
  const heads = await queryHeads(context.bundle);
  assert.ok(heads.length > 0, "the checkout's documents are readable");
  const alpha = await readDoc(context.bundle, "notes/alpha");
  const alphaFile = path.join(c.folder, "notes", "alpha.md");
  const before = await readFile(alphaFile, "utf8");

  // What a View saves (its entry blob), conventions and reserved files: only the app changes them.
  await assert.rejects(writeBlob(context.bundle, "views/probe/index.html", new TextEncoder().encode("<p>probe</p>"), "text/html"), refusedAs("not_a_document", true));
  await assert.rejects(writeDoc(context.bundle, { id: "conventions/probe", frontmatter: { type: "Convention", title: "Probe", governs: "Probe" }, body: "" }), refusedAs("convention_folder", true));
  await assert.rejects(context.bundle.backend!.writeReserved("", "log.md", "# Log\n"), refusedAs("reserved_file", true));
  await assert.rejects(deleteDoc(context.bundle, "conventions/probe"), refusedAs("convention_folder", true));
  // A document sync would hold: a retype, and one over the bound a sync write carries.
  await assert.rejects(writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, type: "Project" }, body: alpha.body }), refusedAs("type_change", false));
  await assert.rejects(writeDoc(context.bundle, { id: "notes/alpha", frontmatter: alpha.frontmatter, body: "x".repeat(WHOLE_DOCUMENT_BOUNDS.payloadBytes + 1) }), refusedAs("too_large", false));
  assert.equal(await readFile(alphaFile, "utf8"), before, "a refused write leaves the file as it was");
  assert.equal(await exists(path.join(c.folder, "views", "probe", "index.html")), false);
  assert.equal(await exists(path.join(c.folder, "conventions", "probe.md")), false);
  const clean = await syncState(c);
  assert.deepEqual([clean.state, clean.held_files, clean.unsent], ["clean", 0, 0], "nothing is left for sync to hold");
  assert.equal(c.host.requests.length, 0, "no MCP write reaches the host");

  // A document write sync can send lands in the folder, as `doc update` would, and the next sync sends it.
  await writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha through MCP" }, body: alpha.body });
  assert.match(await readFile(alphaFile, "utf8"), /Alpha through MCP/);
  assert.equal((await syncState(c)).unsent, 1);
  await runSync(c);
  assert.equal(c.host.docs.get("notes/alpha")?.frontmatter.title, "Alpha through MCP");
  assert.deepEqual(c.host.applied, ["notes/alpha"]);
  assert.equal((await syncState(c)).state, "clean");
});

test("an MCP write while sync holds the checkout does not wait, keeps the file, and the next sync sends it", async () => {
  const c = await hostedCheckout();
  const context = await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE);
  const beta = await readDoc(context.bundle, "notes/beta");
  c.host.put("notes/alpha", { type: "Note", title: "Alpha from the app" }, "Changed on the host.\n");
  let wrote = false;
  // The write lands between the pull and the placement of the host's change, with the lock held.
  const during: typeof c.host.fetch = async (input, init) => {
    if (!wrote && new URL(String(input)).pathname.endsWith("/heads")) {
      wrote = true;
      await writeDoc(context.bundle, { id: "notes/beta", frontmatter: { ...beta.frontmatter, title: "Beta during sync" }, body: beta.body });
      // A retype is still refused while the lock is held: the folder's file is the comparison.
      await assert.rejects(writeDoc(context.bundle, { id: "notes/beta", frontmatter: { ...beta.frontmatter, type: "Project" }, body: beta.body }), refusedAs("type_change", false));
    }
    return c.host.fetch(input, init);
  };
  await runSync(c, during);
  assert.ok(wrote);
  assert.match(await readFile(path.join(c.folder, "notes", "beta.md"), "utf8"), /Beta during sync/, "the write is kept");
  assert.match(await readFile(path.join(c.folder, "notes", "alpha.md"), "utf8"), /Changed on the host/, "the host's change is placed");
  await runSync(c);
  assert.equal(c.host.docs.get("notes/beta")?.frontmatter.title, "Beta during sync");
});

test("mcp --dir on a checkout serves the same guarded bundle, and mcp is no longer refused in a checkout", async () => {
  const c = await hostedCheckout();
  await assertAllowedInHostedCheckout("mcp", ["--dir", c.folder], { home: c.home, cwd: c.cwd });
  await assertAllowedInHostedCheckout("mcp", [], { home: c.home, cwd: c.folder });
  let served: Bundle | undefined;
  const { withIsolatedUserEnv } = await import("./support/user-env.js");
  await withIsolatedUserEnv(c.home, () =>
    mcp(["--dir", c.folder, "--actor", "process:test"], { stdout: () => {}, stderr: () => {}, startServer: async (options) => void (served = (options as { bundle: Bundle }).bundle) }),
  );
  assert.ok(served);
  await assert.rejects(writeBlob(served, "views/probe.html", new TextEncoder().encode("<p/>"), "text/html"), refusedAs("not_a_document", true));
  const alpha = await readDoc(served, "notes/alpha");
  await writeDoc(served, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha via --dir" }, body: alpha.body });
  assert.equal((await syncState(c)).unsent, 1);
});

test("an MCP read of a stale checkout pulls first, once per stale window in the process", async () => {
  const c = await hostedCheckout();
  const binding = (await bindingForPath(c.home, c.folder))!;
  await recordPulled(c.home, binding.checkout_id, new Date(Date.now() - 10 * 60 * 1000));
  c.host.put("notes/alpha", { type: "Note", title: "Alpha from the app" }, "Pulled.\n");
  const notes: string[] = [];
  const bundle = await servedBundle(await openBundle(c.folder), { home: c.home, autoPull: { env: {}, stderr: (text) => void notes.push(text), sync: { auth: c.auth, fetch: c.host.fetch } } });
  assert.equal((await readDoc(bundle, "notes/alpha")).frontmatter.title, "Alpha from the app");
  const pulls = c.host.requests.filter((request) => request.path.endsWith("/heads")).length;
  assert.equal(pulls, 1);
  await recordPulled(c.home, binding.checkout_id, new Date(Date.now() - 10 * 60 * 1000));
  await readDoc(bundle, "notes/beta");
  assert.equal(c.host.requests.filter((request) => request.path.endsWith("/heads")).length, pulls, "no second pull in the same stale window");
  assert.deepEqual(notes, []);
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
