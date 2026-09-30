// The local MCP server over a hosted checkout (designs/seamless-multi-backend-cli, section 4.3):
// the checkout is served through its folder. Reads are served and kept fresh by the automatic
// pull; a document write sync can send lands in the folder and the next `sync` sends it; a write
// sync would hold (a View's entry blob, conventions, reserved files, a retype, an oversize
// document) is refused before the file changes, with the reason the sync scan would record. Both
// open paths (the catalog resolver and `mcp --dir`) serve the same guarded bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteDoc, queryHeads, readDoc, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { WHOLE_DOCUMENT_BOUNDS } from "@superbee/core/hosted-transport";
import { createMcpAppServer, type McpWorkspaceResolver } from "@superbee/mcp-app";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";

import { addCatalogEntry, listCatalogEntries } from "../src/catalog.js";
import { openBundle } from "../src/bundle.js";
import { catalog } from "../src/commands/catalog.js";
import { checkout } from "../src/commands/checkout.js";
import { mcp } from "../src/commands/mcp.js";
import { status } from "../src/commands/status.js";
import { sync } from "../src/commands/sync.js";
import { CliError } from "../src/errors.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { IN_PLACE_JOURNAL, IN_PLACE_STAGING } from "../src/hosted/export-archive.js";
import { recordPulled } from "../src/hosted/freshness.js";
import { assertAllowedInHostedCheckout } from "../src/hosted/refusals.js";
import { servedBundle } from "../src/hosted/served-bundle.js";
import { createCatalogMcpWorkspaceResolver } from "../src/mcp-workspace-resolver.js";
import { BUNDLE, FakeHost, HOST, syncFixture, TOKEN, type OperationDescriptor } from "./support/fake-hosted-sync.js";
import { FakeIssuer } from "./support/fake-issuer.js";
import { seedHostedSession } from "./support/hosted-session.js";

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

test("an MCP write landing while sync places the host's change to the same document is kept, as a conflict, never overwritten", async () => {
  const c = await hostedCheckout();
  const context = await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE);
  const alpha = await readDoc(context.bundle, "notes/alpha");
  c.host.put("notes/alpha", { type: "Note", title: "Alpha from the app" }, "Changed on the host.\n");
  let wrote = false;
  // The host's change is pulled, then placed with the pre-image guard (replaceGuarded); the MCP
  // write lands after the pull read the listing and before the placement.
  const during: typeof c.host.fetch = async (input, init) => {
    const response = await c.host.fetch(input, init);
    const route = new URL(String(input)).pathname.split("/").pop();
    if (!wrote && (route === "read" || route === "snapshot")) {
      wrote = true;
      await writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha through MCP" }, body: alpha.body });
    }
    return response;
  };
  await runSync(c, during).catch((error: unknown) => assert.ok(error instanceof CliError && error.code === "CONFLICT", String(error)));
  assert.ok(wrote);
  assert.match(await readFile(path.join(c.folder, "notes", "alpha.md"), "utf8"), /Alpha through MCP/, "the MCP write is kept");
  assert.equal(c.host.docs.get("notes/alpha")?.frontmatter.title, "Alpha from the app", "the host's change is not overwritten");
  await assert.rejects(runSync(c), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
});

test("the guard: an unknown storage method is refused, an unsafe id is unsafe_path, a document delete is admitted and synced", async () => {
  const c = await hostedCheckout();
  const context = await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE);
  const backend = context.bundle.backend as unknown as Record<string, unknown>;
  // A method the guard's table does not name is refused, whatever it would do.
  const unguarded = (await openBundle(c.folder)).backend as unknown as Record<string, unknown>;
  const probe = Object.getPrototypeOf(unguarded) as Record<string, unknown>;
  probe.rewrite = async () => "written";
  try {
    assert.throws(() => (backend.rewrite as () => unknown)(), /does not know the storage method 'rewrite'/);
  } finally {
    delete probe.rewrite;
  }
  await assert.rejects(context.bundle.backend!.write("../outside", { id: "../outside", frontmatter: { type: "Note" }, body: "" }), refusedAs("unsafe_path", false));
  await deleteDoc(context.bundle, "notes/beta");
  assert.equal(await exists(path.join(c.folder, "notes", "beta.md")), false);
  await runSync(c);
  assert.equal(c.host.docs.has("notes/beta"), false, "the delete reached the host");
});

test("an MCP write that changes verified is refused before the file changes; an ordinary edit carries it and is sent", async () => {
  const c = await hostedCheckout();
  const reviewed = { by: "human:reviewer", at: "2026-09-26T12:00:00Z" };
  c.host.put("notes/alpha", { type: "Note", title: "Alpha", verified: [reviewed] }, "Alpha body.\n");
  await runSync(c);
  const context = await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE);
  const alpha = await readDoc(context.bundle, "notes/alpha");
  assert.deepEqual(alpha.frontmatter.verified, [reviewed], "the host's verification is in the folder");
  const alphaFile = path.join(c.folder, "notes", "alpha.md");
  const before = await readFile(alphaFile, "utf8");
  c.host.requests.length = 0;

  const managed = (error: unknown): true => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.equal(error.code, "FORBIDDEN");
    const details = error.details as Record<string, unknown>;
    assert.deepEqual([details.reason, details.command, details.field, details.bundle_id, details.do_this_in], ["not_syncable", "mcp write", "verified", BUNDLE, "app"]);
    assert.match(error.message, /verification is a managed field the host records/);
    return true;
  };
  // Only verified changes: appended, replaced, removed. And a new document that carries it.
  await assert.rejects(writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, verified: [reviewed, { by: "human:someone", at: "2026-09-27T09:00:00Z" }] }, body: alpha.body }), managed);
  await assert.rejects(writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, verified: [{ by: "human:someone", at: "2026-09-27T09:00:00Z" }] }, body: alpha.body }), managed);
  const { verified: _dropped, ...unverified } = alpha.frontmatter;
  await assert.rejects(context.bundle.backend!.write("notes/alpha", { id: "notes/alpha", frontmatter: unverified, body: alpha.body }), managed);
  await assert.rejects(writeDoc(context.bundle, { id: "notes/claimed", frontmatter: { type: "Note", title: "Claimed", verified: [reviewed] }, body: "" }), managed);
  assert.equal(await readFile(alphaFile, "utf8"), before, "a refused write leaves the file as it was");
  assert.equal(await exists(path.join(c.folder, "notes", "claimed.md")), false);
  assert.deepEqual([(await syncState(c)).state, (await syncState(c)).unsent], ["clean", 0]);

  // A write made against an older version meets the version check first: a conflict the caller
  // retries, not a final refusal (a pull may have brought the new verification in meanwhile).
  await assert.rejects(
    context.bundle.backend!.write("notes/alpha", { id: "notes/alpha", frontmatter: unverified, body: alpha.body }, { expectedVersion: "stale-version" }),
    (error: unknown) => {
      assert.ok(!(error instanceof CliError), `a version conflict, not a refusal: ${String(error)}`);
      assert.match(String(error), /version|conflict/i);
      return true;
    },
  );
  assert.equal(await readFile(alphaFile, "utf8"), before);

  // An ordinary edit of the verified document carries verified forward unchanged, and is sent.
  await writeDoc(context.bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha, retitled" }, body: alpha.body });
  assert.match(await readFile(alphaFile, "utf8"), /Alpha, retitled/);
  await runSync(c);
  assert.equal(c.host.docs.get("notes/alpha")?.frontmatter.title, "Alpha, retitled");
  assert.deepEqual(c.host.applied, ["notes/alpha"]);
});

/** The `unbound_copy` refusal an MCP write gets in a copy of a checkout, naming the adopt command. */
function refusedAsCopy(folder: string) {
  return (error: unknown): true => {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.equal(error.code, "FORBIDDEN");
    const details = error.details as Record<string, unknown>;
    assert.deepEqual([details.reason, details.command, details.folder, details.marker_bundle_id, details.marker_host], ["unbound_copy", "mcp write", folder, BUNDLE, HOST]);
    assert.equal(details.or, `to use it as a plain local bundle instead, delete ${path.join(folder, ".superbee", "checkout.json")}`);
    assert.match(error.help ?? "", /checkout --adopt .* --host https:\/\/hosted\.example/);
    return true;
  };
}

test("an unbound copy of a checkout is served for reading, and every MCP write is refused until it is adopted or its marker goes", async () => {
  const c = await hostedCheckout();
  await cp(c.folder, path.join(c.cwd, "copy"), { recursive: true });
  const copy = await realpath(path.join(c.cwd, "copy"));
  await addCatalogEntry("copy", copy, { home: c.home });
  const alphaFile = path.join(copy, "notes", "alpha.md");
  const before = await readFile(alphaFile, "utf8");

  // Both open paths: the catalog resolver and `mcp --dir`.
  const cataloged = (await createCatalogMcpWorkspaceResolver({ home: c.home }).open("copy")).bundle;
  let direct: Bundle | undefined;
  const { withIsolatedUserEnv } = await import("./support/user-env.js");
  await withIsolatedUserEnv(c.home, () =>
    mcp(["--dir", copy, "--actor", "process:test"], { stdout: () => {}, stderr: () => {}, startServer: async (options) => void (direct = (options as { bundle: Bundle }).bundle) }),
  );
  assert.ok(direct);
  for (const bundle of [cataloged, direct]) {
    const alpha = await readDoc(bundle, "notes/alpha");
    assert.ok((await queryHeads(bundle)).length > 0, "reads are served");
    await assert.rejects(writeDoc(bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha in the copy" }, body: alpha.body }), refusedAsCopy(copy));
    await assert.rejects(writeDoc(bundle, { id: "notes/new", frontmatter: { type: "Note", title: "New" }, body: "" }), refusedAsCopy(copy));
    await assert.rejects(deleteDoc(bundle, "notes/beta"), refusedAsCopy(copy));
    await assert.rejects(writeBlob(bundle, "views/probe/index.html", new TextEncoder().encode("<p/>"), "text/html"), refusedAsCopy(copy));
    await assert.rejects(bundle.backend!.writeReserved("", "log.md", "# Log\n"), refusedAsCopy(copy));
  }
  assert.equal(await readFile(alphaFile, "utf8"), before, "a refused write leaves the file as it was");
  assert.equal(await exists(path.join(copy, "notes", "new.md")), false);
  assert.equal(await exists(path.join(copy, "notes", "beta.md")), true);
  assert.equal(c.host.requests.length, 0, "nothing reaches the host");
  // The original checkout is still served through its own guard, and still writable.
  const original = (await createCatalogMcpWorkspaceResolver({ home: c.home }).open(BUNDLE)).bundle;
  const alpha = await readDoc(original, "notes/alpha");
  await writeDoc(original, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha in the checkout" }, body: alpha.body });

  // Adopted mid-session: the same served bundle takes the checkout's guard, with no reopen.
  await checkout(["--adopt", copy, "--host", HOST, "--json"], { stdout: () => {}, auth: c.auth, cwd: c.cwd, fetch: c.host.fetch });
  const adopted = await readDoc(cataloged, "notes/alpha");
  await writeDoc(cataloged, { id: "notes/alpha", frontmatter: { ...adopted.frontmatter, title: "Alpha, adopted" }, body: adopted.body });
  assert.match(await readFile(alphaFile, "utf8"), /Alpha, adopted/);
  await assert.rejects(writeDoc(cataloged, { id: "conventions/probe", frontmatter: { type: "Convention", title: "Probe", governs: "Probe" }, body: "" }), refusedAs("convention_folder", true));

  // Deleting the marker keeps a copy as a plain local bundle: writes work at once, no reopen.
  await cp(c.folder, path.join(c.cwd, "kept"), { recursive: true });
  const kept = await realpath(path.join(c.cwd, "kept"));
  const local = await servedBundle(await openBundle(kept), { home: c.home });
  await assert.rejects(writeDoc(local, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha, kept" }, body: alpha.body }), refusedAsCopy(kept));
  await unlink(path.join(kept, ".superbee", "checkout.json"));
  await writeDoc(local, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha, kept" }, body: alpha.body });
  assert.match(await readFile(path.join(kept, "notes", "alpha.md"), "utf8"), /Alpha, kept/);
});

test("a copy made a Git board mid-session is written as sync takes it; a stopped in-place export names its resume, not deleting the marker", async () => {
  const c = await hostedCheckout();
  await cp(c.folder, path.join(c.cwd, "copy"), { recursive: true });
  const copy = await realpath(path.join(c.cwd, "copy"));
  const bundle = await servedBundle(await openBundle(copy), { home: c.home });
  const alpha = await readDoc(bundle, "notes/alpha");
  await assert.rejects(writeDoc(bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha" }, body: "x" }), refusedAsCopy(copy));

  // An in-place export that stopped part way leaves the marker and no binding: the refusal names the
  // resume, and never suggests deleting the marker, which would abandon it.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(copy, IN_PLACE_STAGING), { recursive: true });
  await writeFile(path.join(copy, IN_PLACE_STAGING, IN_PLACE_JOURNAL), "{}\n");
  await assert.rejects(writeDoc(bundle, { id: "notes/alpha", frontmatter: alpha.frontmatter, body: "x" }), (error: unknown) => {
    assert.ok(error instanceof CliError);
    const details = error.details as Record<string, unknown>;
    assert.equal(details.reason, "unbound_copy");
    assert.equal("or" in details, false);
    assert.match(error.help ?? "", /export --in-place --dir /);
    return true;
  });
  const refused = await rejects(sync(["--dir", copy], { auth: c.auth, cwd: c.cwd }));
  assert.equal("or" in (refused.details ?? {}), false);
  await rm(path.join(copy, IN_PLACE_STAGING), { recursive: true });

  // Made a Git board (as sync --establish leaves it): sync takes it through Git, so the same served
  // bundle writes to it with no reopen.
  execFileSync("git", ["init", "-q", "-b", "board"], { cwd: copy, stdio: "ignore" });
  await writeDoc(bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha on the board" }, body: alpha.body });
  assert.match(await readFile(path.join(copy, "notes", "alpha.md"), "utf8"), /Alpha on the board/);
});

async function rejects(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

test("a Git board that carries a checkout marker syncs through Git, so local MCP serves it unguarded", async () => {
  const c = await hostedCheckout();
  await cp(c.folder, path.join(c.cwd, "board"), { recursive: true });
  const board = await realpath(path.join(c.cwd, "board"));
  execFileSync("git", ["init", "-q", "-b", "board"], { cwd: board, stdio: "ignore" });
  const bundle = await servedBundle(await openBundle(board), { home: c.home });
  const alpha = await readDoc(bundle, "notes/alpha");
  await writeDoc(bundle, { id: "notes/alpha", frontmatter: { ...alpha.frontmatter, title: "Alpha on the board" }, body: alpha.body });
  assert.match(await readFile(path.join(board, "notes", "alpha.md"), "utf8"), /Alpha on the board/);
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

// ------------------------------------------------------------------------ one discovery (S3)

/** `catalog list --json` with the checkout's home and the fake's fetch for the host's routes. */
async function listCatalog(c: Checkout, extra: string[] = [], auth: HostedAuthDeps = defaultHostedAuthDeps(c.home, { env: {}, fetch: async () => { throw new Error("no sign-in may start"); } }), fetch: typeof c.host.fetch = c.host.fetch): Promise<Record<string, unknown>> {
  let out = "";
  await catalog(["list", ...extra, "--json"], { stdout: (text) => void (out += text), home: () => c.home, auth, fetch });
  return JSON.parse(out) as Record<string, unknown>;
}

test("catalog list: signed out it lists the folders alone and asks no host; signed in it adds the hosted bundles with no folder here", async () => {
  const c = await hostedCheckout();
  // No stored sign-in (the checkout used an environment token): exactly the folders, no request.
  const signedOut = await listCatalog(c);
  assert.deepEqual(signedOut, await listCatalog(c, ["--local"]));
  assert.equal("hosted" in signedOut, false);
  assert.equal(c.host.requests.length, 0);
  // An expired session with nothing to refresh it is signed out too: nothing starts a sign-in.
  await seedHostedSession(c.home, { host: HOST, accessToken: TOKEN, expiresAtMs: 0 });
  assert.equal("hosted" in (await listCatalog(c)), false);
  assert.equal(c.host.requests.length, 0);

  // An access token in the environment that is for another host: that host is not asked, and
  // nothing is said about it.
  const otherHostToken = defaultHostedAuthDeps(c.home, { env: { SUPERBEE_ACCESS_TOKEN: new FakeHost({ origin: "https://other.example" }).token }, fetch: async () => { throw new Error("no sign-in may start"); } });
  assert.deepEqual(await listCatalog(c, [], otherHostToken), signedOut);
  assert.equal(c.host.requests.length, 0);

  // Signed in: the bundles the host lists that have no folder here, each with its checkout command;
  // an id two of the person's workspaces hold gets none (checkout refuses it).
  // An id the host lists once per workspace, by reference, gets one checkout command per reference.
  const signedIn = new FakeHost({ bundles: [BUNDLE, "team.archive", "team.shared", "team.shared", "north/team.dup", "south/team.dup"] });
  await seedHostedSession(c.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  const merged = await listCatalog(c, [], undefined, signedIn.fetch);
  assert.deepEqual((merged.entries as unknown[]).length, 1, "the checkout stays one folder entry");
  const hosted = merged.hosted as { host: string; bundles: { bundle_id: string; folder: null; checkout: string }[] }[];
  assert.equal(hosted.length, 1);
  assert.equal(hosted[0]!.host, HOST);
  assert.deepEqual(hosted[0]!.bundles.map((row) => [row.bundle_id, row.folder]), [["team.dup", null], ["team.dup", null], ["team.archive", null], ["team.shared", null]]);
  assert.match(hosted[0]!.bundles[0]!.checkout, /checkout north\/team\.dup --host /);
  assert.match(hosted[0]!.bundles[1]!.checkout, /checkout south\/team\.dup --host /);
  assert.match(hosted[0]!.bundles[2]!.checkout, /checkout team\.archive --host /);
  assert.equal("checkout" in hosted[0]!.bundles[3]!, false);
  // --local never asks.
  signedIn.requests.length = 0;
  assert.equal("hosted" in (await listCatalog(c, ["--local"], undefined, signedIn.fetch)), false);
  assert.equal(signedIn.requests.length, 0);
});

test("catalog list: a host that does not answer in time leaves the folders listed, with one note", async () => {
  const c = await hostedCheckout();
  await seedHostedSession(c.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  const hanging = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const started = Date.now();
  const listed = await listCatalog(c, [], undefined, hanging);
  assert.ok(Date.now() - started < 4_500, "inside the 3-second budget");
  assert.equal((listed.entries as unknown[]).length, 1);
  assert.deepEqual(listed.hosted, []);
  assert.match(String(listed.note), /were not listed \(no answer in time\); list them with: .*catalog list --hosted --host/);
});

test("list_workspaces names the reachable hosted bundles with no folder here, from one answer a minute; an ambiguous id points at the full listing", async () => {
  const c = await hostedCheckout();
  let asked = 0;
  let clock = 0;
  const resolver = createCatalogMcpWorkspaceResolver({
    home: c.home,
    now: () => clock,
    reachable: async () => {
      asked += 1;
      return {
        hosts: [{
          host: HOST,
          complete: true,
          ask: "superbee catalog list --hosted --host hosted.example",
          bundles: [
            { bundle_id: "team.archive", reference: "team.archive", name: "Archive", lifecycle: "active", folder: null, ambiguous: false, checkout: "superbee checkout team.archive --host hosted.example" },
            { bundle_id: "team.shared", reference: "team.shared", name: "Shared", lifecycle: "active", folder: null, ambiguous: true },
          ],
        }],
        notes: ["a note"],
      };
    },
  });
  assert.deepEqual(await resolver.reachable!(), {
    workspaces: [
      { id: "team.archive", name: "Archive", home: "hosted", location: HOST, command: "superbee checkout team.archive --host hosted.example" },
      { id: "team.shared", name: "Shared", home: "hosted", location: HOST, command: "superbee catalog list --hosted --host hosted.example" },
    ],
    notes: ["a note"],
  });
  await resolver.reachable!();
  assert.equal(asked, 1, "reused within the minute");
  clock = 60_000;
  await resolver.reachable!();
  assert.equal(asked, 2);
  // Such a bundle is not a workspace here: opening it by name is refused like any unknown label.
  await assert.rejects(resolver.open("team.archive"));
});

test("catalog --local is only for list, and never with --hosted", async () => {
  const c = await hostedCheckout();
  for (const argv of [["add", "x", "--local"], ["resolve", BUNDLE, "--local"], ["list", "--local", "--hosted"]]) {
    await assert.rejects(catalog(argv, { stdout: () => {}, home: () => c.home }), (error: unknown) => error instanceof CliError && error.code === "USAGE", argv.join(" "));
  }
});

// list_operations and run_operation (designs/seamless-multi-backend-cli, G3): the host's reads by
// id, through the catalog resolver's optional methods and the one checkout connection `op` uses,
// over the real MCP server. No code here names an operation but the golden one.

type ToolAnswer = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };

async function mcpClient(resolver: McpWorkspaceResolver): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>; close: () => Promise<void> }> {
  const server = createMcpAppServer({ workspaceResolver: resolver, version: "test" });
  const client = new Client({ name: "operations-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolAnswer,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const historyDescriptor = (): OperationDescriptor => (JSON.parse(syncFixture("operations-200").response.body) as { operations: OperationDescriptor[] }).operations[0]!;

test("list_operations and run_operation reach a hosted checkout's host reads by id, the run's answer passed through unchanged", async () => {
  const c = await hostedCheckout();
  const id = [...c.host.docs.keys()][0]!;
  c.host.put(id, { type: "Note" }, "edited on the host");
  const mcp = await mcpClient(createCatalogMcpWorkspaceResolver({ home: c.home, hosted: { auth: c.auth, fetch: c.host.fetch } }));
  try {
    const listed = await mcp.call("list_operations", { workspace: BUNDLE });
    assert.equal(listed.isError, undefined, listed.content[0]?.text);
    const golden = historyDescriptor();
    const operations = listed.structuredContent!.operations as Record<string, unknown>[];
    assert.deepEqual(operations.map((operation) => operation.operationId), ["documents.history.v1"]);
    assert.equal(operations[0]!.title, golden.title);
    const schema = operations[0]!.inputJsonSchema as { properties: Record<string, unknown>; required: string[] };
    assert.equal(Object.hasOwn(schema.properties, "bundleId"), false, "bundleId is the workspace's");
    assert.equal(schema.required.includes("bundleId"), false);
    assert.ok(Object.hasOwn(schema.properties, "documentId"));
    assert.deepEqual(c.host.requests.map((request) => request.path), ["/sync/v1/whoami", "/sync/v1/operations"]);
    assert.deepEqual(c.host.requests[1]!.body, { bundleId: BUNDLE });
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(c.folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path");

    c.host.requests.length = 0;
    const ran = await mcp.call("run_operation", { workspace: BUNDLE, operationId: "documents.history.v1", input: { documentId: id } });
    assert.equal(ran.isError, undefined, ran.content[0]?.text);
    const direct = (await (await c.host.fetch(`${HOST}/sync/v1/history`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ bundleId: BUNDLE, documentId: id }) })).json()) as { data: unknown };
    assert.deepEqual(ran.structuredContent, { workspace: BUNDLE, operationId: "documents.history.v1", result: direct.data });
    assert.deepEqual(JSON.parse(ran.content[0]!.text.split("\n").slice(1).join("\n")), ran.structuredContent, "the text repeats the structured answer");
    assert.deepEqual(c.host.requests.slice(0, 2).map((request) => request.path), ["/sync/v1/whoami", "/sync/v1/run"], "one run request, never the history route");
    assert.deepEqual(c.host.requests[1]!.body, { bundleId: BUNDLE, operationId: "documents.history.v1", input: { bundleId: BUNDLE, documentId: id } });

    // The host's own refusal is a tool error naming its code.
    c.host.requests.length = 0;
    const unknown = await mcp.call("run_operation", { workspace: BUNDLE, operationId: "documents.replace.v1", input: {} });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0]!.text, /refused documents\.replace\.v1 \(unknown_operation\).*Call list_operations/);
  } finally {
    await mcp.close();
  }
});

test("a hosted checkout's reads the folder answers are neither listed nor run, and an input naming another bundle is refused, with no request at all", async () => {
  const c = await hostedCheckout();
  c.host.operationsListing = [{ ...historyDescriptor(), operationId: "documents.read.v1" }, { ...historyDescriptor(), operationId: "documents.query.v1" }, historyDescriptor()];
  const mcp = await mcpClient(createCatalogMcpWorkspaceResolver({ home: c.home, hosted: { auth: c.auth, fetch: c.host.fetch } }));
  try {
    const listed = await mcp.call("list_operations", { workspace: BUNDLE });
    assert.deepEqual((listed.structuredContent!.operations as { operationId: string }[]).map((row) => row.operationId), ["documents.history.v1"]);
    assert.deepEqual(listed.structuredContent!.notes, [
      "documents.read.v1 is not listed: the folder answers it, which sees unsent edits",
      "documents.query.v1 is not listed: the folder answers it, which sees unsent edits",
    ]);
    for (const operationId of ["documents.read.v1", "documents.query.v1"]) {
      c.host.requests.length = 0;
      const refused = await mcp.call("run_operation", { workspace: BUNDLE, operationId, input: { documentId: "notes/alpha" } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0]!.text, /answers documents\.(read|query)\.v1 from its folder.*show_document/);
      assert.deepEqual(c.host.requests, [], operationId);
    }
    c.host.requests.length = 0;
    const mismatch = await mcp.call("run_operation", { workspace: BUNDLE, operationId: "documents.history.v1", input: { bundleId: "team.other", documentId: "notes/alpha" } });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0]!.text, /\(invalid_input\): the input names another bundle/);
    assert.deepEqual(c.host.requests, []);
  } finally {
    await mcp.close();
  }
});

test("a gateway from before the operations routes is the tool error saying the host does not offer them yet", async () => {
  const host = new FakeHost({ operations: false });
  const c = await hostedCheckout();
  const mcp = await mcpClient(createCatalogMcpWorkspaceResolver({ home: c.home, hosted: { auth: c.auth, fetch: host.fetch } }));
  try {
    for (const [name, args] of [["list_operations", { workspace: BUNDLE }], ["run_operation", { workspace: BUNDLE, operationId: "documents.history.v1", input: { documentId: "notes/alpha" } }]] as const) {
      const answer = await mcp.call(name, args);
      assert.equal(answer.isError, true, name);
      assert.match(answer.content[0]!.text, /\(NOT_IMPLEMENTED\)\. The workspace's host does not offer operations by id yet\.$/);
    }
  } finally {
    await mcp.close();
  }
});

test("a local workspace has no host operations: an empty listing naming the typed tools, and a run refused, with no request", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-mcp-ops-local-home-"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mcp-ops-local-bundle-")));
  const { initBundle } = await import("@superbee/core");
  await initBundle(root);
  await addCatalogEntry("local", root, { home });
  const mcp = await mcpClient(createCatalogMcpWorkspaceResolver({ home, hosted: { auth: defaultHostedAuthDeps(home), fetch: async () => assert.fail("a local workspace makes no request") } }));
  try {
    const listed = await mcp.call("list_operations", { workspace: "local" });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(listed.structuredContent, { workspace: "local", operations: [], notes: ["a local bundle has no host operations; use show_document, list_views and show_view"] });
    const ran = await mcp.call("run_operation", { workspace: "local", operationId: "documents.history.v1", input: {} });
    assert.equal(ran.isError, true);
    assert.match(ran.content[0]!.text, /is a local bundle: it has no host operations\. Use show_document/);
    const unknown = await mcp.call("list_operations", { workspace: "missing" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.content[0]!.text, "Could not list the host's operations for workspace 'missing' (NOT_FOUND). Call list_workspaces and retry with an available exact ID or label.");
    assert.doesNotMatch(JSON.stringify([listed, ran, unknown]), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path");
  } finally {
    await mcp.close();
  }
});

test("a hosted workspace with no session answers the one sign-in link to relay, never a prompt, with no request to the host", async () => {
  const issuer = await new FakeIssuer().start();
  try {
    const host = new FakeHost({ origin: issuer.base });
    const home = await mkdtemp(path.join(tmpdir(), "sb-mcp-ops-auth-"));
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-mcp-ops-cwd-")));
    const signedIn = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: host.token } });
    await checkout([BUNDLE, "--host", issuer.base, "--dir", "team"], { stdout: () => {}, auth: signedIn, cwd, fetch: host.fetch });
    host.requests.length = 0;
    const signedOut = defaultHostedAuthDeps(home, { env: { [CREDENTIAL_STORE_ENV]: "file" } });
    const mcp = await mcpClient(createCatalogMcpWorkspaceResolver({ home, hosted: { auth: signedOut, fetch: host.fetch } }));
    try {
      for (const [name, args] of [["list_operations", { workspace: BUNDLE }], ["run_operation", { workspace: BUNDLE, operationId: "documents.history.v1", input: { documentId: "notes/alpha" } }]] as const) {
        const answer = await mcp.call(name, args);
        assert.equal(answer.isError, true, name);
        assert.match(answer.content[0]!.text, new RegExp(`is required: ask the person to open http://127\\.0\\.0\\.1:\\d+/activate\\?user_code=\\S+ and confirm the code \\S+, then call ${name} again\\.$`));
        assert.doesNotMatch(answer.content[0]!.text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path");
      }
      // Stops decided on this machine come first, signed in or not.
      const folder = await mcp.call("run_operation", { workspace: BUNDLE, operationId: "documents.read.v1", input: { documentId: "notes/alpha" } });
      assert.match(folder.content[0]!.text, /answers documents\.read\.v1 from its folder/);
      assert.deepEqual(host.requests, [], "no host request before sign-in");
    } finally {
      await mcp.close();
    }
  } finally {
    await issuer.stop();
  }
});
