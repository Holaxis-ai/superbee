// `superbee view read` and `superbee view update` in a hosted checkout: a registered View's page
// read and replaced whole on the host (`/sync/v1/view-content-read`, `/sync/v1/view-content-update`),
// against the stateful fake of the sync routes. Sync never sends `views/`; these commands are the
// one way a checkout changes a page, pinned to the registration's and the page's versions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rename, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { view } from "../src/commands/view.js";
import { init } from "../src/commands/init.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { checkoutDir, bindingForPath, checkoutLockName } from "../src/hosted/binding.js";
import { isViewPagePath } from "../src/hosted/sync-scan.js";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import { BUNDLE, FakeHost, HOST, pageVersion, TOKEN, type FakeHostOptions } from "./support/fake-hosted-sync.js";

const VIEW = "views-registry/board";
const KEY = "views/board.html";
const PAGE = "<!doctype html><p>board v1</p>\n";
const ZERO = `sha256:${"0".repeat(64)}`;

interface Harness {
  readonly home: string;
  readonly cwd: string;
  readonly folder: string;
  readonly auth: HostedAuthDeps;
  readonly host: FakeHost;
  /** The page's version as the host installed it. */
  readonly v1: string;
  fetch?: typeof fetch;
}

async function harness(options: FakeHostOptions = {}, page = PAGE): Promise<Harness> {
  const host = new FakeHost(options);
  const { version } = host.putView(VIEW, KEY, page);
  // The export places the page in the checkout, as it does every file other than a document.
  host.exportExtras.set(KEY, new Uint8Array(Buffer.from(page, "utf8")));
  const home = await mkdtemp(path.join(tmpdir(), "sb-viewc-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-viewc-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return { home, cwd, folder: path.join(cwd, "team"), auth, host, v1: version };
}

async function run(h: Harness, argv: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  await view([...argv, "--dir", h.folder, "--json"], { stdout: (text) => void out.push(text), hosted: { auth: h.auth, fetch: h.fetch ?? h.host.fetch }, cwd: h.cwd });
  return JSON.parse(out.join("")) as Record<string, unknown>;
}

async function rejects(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected the command to fail");
}

const update = (h: Harness, expected: string, extra: string[] = []) => run(h, ["update", VIEW, "--expected-version", expected, ...extra]);
const routes = (h: Harness) => h.host.requests.map((request) => request.path);
const sentUpdates = (h: Harness) => h.host.requests.filter((request) => request.path === "/sync/v1/view-content-update");

test("view read: the page's key, version, size and type, pinned to the registration's host version; no html printed", async () => {
  const h = await harness();
  const record = await run(h, ["read", VIEW]);
  assert.deepEqual(
    { ...record, help: undefined },
    { view: "read", registry_id: VIEW, registry_version: h.host.docs.get(VIEW)!.version, key: KEY, version: h.v1, byte_count: Buffer.byteLength(PAGE), content_type: "text/html; charset=utf-8", help: undefined },
  );
  assert.match(String((record.help as string[])[0]), new RegExp(`view update ${VIEW} --expected-version ${h.v1}`));
  assert.doesNotMatch(JSON.stringify(record), /board v1/);
  assert.deepEqual(routes(h), ["/sync/v1/whoami", "/sync/v1/run", "/sync/v1/view-content-read"]);
  assert.deepEqual(h.host.requests.at(-1)!.body, { bundleId: BUNDLE, registryId: VIEW, expectedRegistryVersion: h.host.docs.get(VIEW)!.version });
  // The TOON rendering carries the same record.
  const out: string[] = [];
  await view(["read", VIEW, "--dir", h.folder], { stdout: (text) => void out.push(text), hosted: { auth: h.auth, fetch: h.host.fetch } });
  assert.equal((decode(out.join("").trim()) as Record<string, unknown>).version, h.v1);
});

test("view read --out writes the exact bytes (a BOM kept) to a new file, and never over an existing one", async () => {
  const page = "﻿<p>café</p>";
  const h = await harness({}, page);
  const out = path.join(h.cwd, "backup.html");
  const record = await run(h, ["read", VIEW, "--out", out]);
  assert.equal(record.out, out);
  assert.deepEqual(await readFile(out), Buffer.from(page, "utf8"));
  assert.equal((await readFile(out))[0], 0xef, "the BOM's bytes lead the file");
  const again = await rejects(run(h, ["read", VIEW, "--out", out]));
  assert.equal(again.code, "ALREADY_EXISTS");
  // An in-bundle .md target would be read as a document: refused before anything is read.
  const inside = await rejects(run(h, ["read", VIEW, "--out", path.join(h.folder, "notes", "page.md")]));
  assert.equal(inside.code, "USAGE");
});

test("view update: the checkout's entry is sent byte for byte, pinned to both versions; the output says execution approval is separate", async () => {
  const h = await harness();
  const next = "<!doctype html><p>board v2</p>\n";
  await writeFile(path.join(h.folder, KEY), next);
  const record = await update(h, h.v1);
  assert.equal(record.update, "changed");
  assert.equal(record.previous_version, h.v1);
  assert.equal(record.version, pageVersion(next));
  assert.equal(record.byte_count, Buffer.byteLength(next));
  assert.equal(record.key, KEY);
  assert.equal(record.checkout_copy, "current");
  const notes = (record.notes as string[]).join("\n");
  assert.match(notes, /does not approve execution/);
  assert.match(notes, /pin/);
  assert.match(notes, /approving again/);
  assert.equal(record.note, undefined, "one notes list");
  assert.deepEqual(sentUpdates(h).map((request) => request.body), [
    { bundleId: BUNDLE, registryId: VIEW, expectedRegistryVersion: h.host.docs.get(VIEW)!.version, expectedContentVersion: h.v1, html: next },
  ]);
  assert.equal(h.host.viewPages.get(VIEW)!.html, next);
  // The checkout's copy is recorded as the host's: sync leaves it be instead of holding it.
  const binding = (await bindingForPath(h.home, h.folder))!;
  const projection = JSON.parse(await readFile(path.join(checkoutDir(h.home, binding.checkout_id), "projection.json"), "utf8")) as { extras?: Record<string, string> };
  assert.equal(projection.extras?.[KEY], pageVersion(next));
});

test("view update: the same bytes are unchanged; a page with a leading BOM is sent exactly", async () => {
  const h = await harness();
  assert.equal((await update(h, h.v1)).update, "unchanged");
  const bom = "﻿<p>bom</p>";
  await writeFile(path.join(h.folder, KEY), bom);
  const record = await update(h, h.v1);
  assert.equal(record.update, "changed");
  assert.equal(record.version, pageVersion(bom));
  assert.equal((sentUpdates(h).at(-1)!.body as { html: string }).html, bom);
  assert.equal(h.host.viewPages.get(VIEW)!.html.charCodeAt(0), 0xfeff);
});

test("view update --file outside the checkout: sent, and the checkout's copy reported stale, never touched", async () => {
  const h = await harness();
  const file = path.join(h.cwd, "draft.html");
  await writeFile(file, "<p>draft</p>");
  const record = await update(h, h.v1, ["--file", file]);
  assert.equal(record.update, "changed");
  assert.equal(record.checkout_copy, "stale");
  assert.match((record.notes as string[]).join("\n"), /still holds the previous page/);
  assert.equal(await readFile(path.join(h.folder, KEY), "utf8"), PAGE);
});

test("view update: a content conflict names the host's version and how to look before re-running", async () => {
  const h = await harness();
  h.host.viewPages.get(VIEW)!.html = "<p>someone else</p>";
  const error = await rejects(update(h, h.v1));
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "content_version_conflict");
  assert.equal(error.details?.actual, pageVersion("<p>someone else</p>"));
  assert.match(error.message, /nothing changed/);
  assert.match(error.help ?? "", /view read views-registry\/board --out <new-file>/);
  assert.match(error.help ?? "", new RegExp(`--expected-version ${pageVersion("<p>someone else</p>")}`));
  assert.equal(sentUpdates(h).length, 1, "sent once, never resent");
});

test("view update: a registration that moved between the read and the update is a registry conflict", async () => {
  const h = await harness();
  h.host.viewContentHook = (route) => {
    if (route !== "view-content-update") return undefined;
    return Response.json({ ok: false, operationId: "views.content.update.v1", error: { code: "version_conflict", target: "registry", expected: ZERO, actual: null, writeState: "not_applied", retryable: false } }, { status: 409 });
  };
  const error = await rejects(update(h, h.v1));
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "registry_version_conflict");
  assert.match(error.help ?? "", /re-run: .*view update views-registry\/board --expected-version/);
});

test("view update: view_not_found, bundle_access_denied and concurrent_change from the host", async () => {
  const h = await harness();
  for (const [code, status, cli] of [["view_not_found", 404, "NOT_FOUND"], ["bundle_access_denied", 403, "FORBIDDEN"], ["concurrent_change", 409, "CONFLICT"], ["invalid_input", 400, "USAGE"]] as const) {
    h.host.viewContentHook = () => Response.json({ ok: false, operationId: "views.content.update.v1", error: { code, writeState: "not_applied", retryable: false } }, { status });
    const error = await rejects(update(h, h.v1));
    assert.equal(error.code, cli, code);
  }
  h.host.viewContentHook = undefined;
  h.host.viewPages.delete(VIEW);
  assert.equal((await rejects(run(h, ["read", VIEW]))).code, "NOT_FOUND");
});

test("view update: definition_writes_refused from the host, and from the binding before anything is sent", async () => {
  const h = await harness();
  h.host.viewContentHook = () => Response.json({ ok: false, operationId: "views.content.update.v1", error: { code: "definition_writes_refused", writeState: "not_applied", retryable: false } }, { status: 403 });
  const fromHost = await rejects(update(h, h.v1));
  assert.equal(fromHost.code, "FORBIDDEN");
  assert.equal(fromHost.details?.reason, "definitions_refused");
  assert.match(fromHost.message, /you don't have permission to change this bundle's model/);

  const refused = await harness({ definitionWrites: "refused" });
  const upFront = await rejects(update(refused, refused.v1));
  assert.equal(upFront.code, "FORBIDDEN");
  assert.equal(upFront.details?.reason, "definitions_refused");
  assert.match(upFront.help ?? "", /ask whoever manages access to it/);
  assert.deepEqual(routes(refused), [], "refused before any request");
});

test("a host without the routes: NOT_IMPLEMENTED, View content updates not offered yet", async () => {
  const h = await harness({ viewContent: false });
  for (const argv of [["read", VIEW], ["update", VIEW, "--expected-version", h.v1]]) {
    const error = await rejects(run(h, argv));
    assert.equal(error.code, "NOT_IMPLEMENTED");
    assert.match(error.message, /does not offer View content updates yet/);
  }
});

test("an unauthenticated update is AUTH_REQUIRED carrying the command to resume", async () => {
  const h = await harness();
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/view-content-update")) return Response.json({ error: "invalid_token" }, { status: 401 });
    return h.host.fetch(input, init);
  }) as typeof fetch;
  const error = await rejects(update(h, h.v1));
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.match(String(error.details?.resume), /view update views-registry\/board --expected-version/);
});

test("a lost answer is settled by one re-read: applied, not applied, or someone else's change; never resent", async () => {
  // 503 write_outcome_unknown after the write applied: confirmed by the re-read.
  const applied = await harness();
  applied.host.viewContentHook = (route) =>
    route === "view-content-update" ? { applyThen: Response.json({ ok: false, operationId: "views.content.update.v1", error: { code: "write_outcome_unknown", writeState: "unknown", retryable: false } }, { status: 503 }) } : undefined;
  await writeFile(path.join(applied.folder, KEY), "<p>v2</p>");
  const record = await update(applied, applied.v1);
  assert.equal(record.update, "changed");
  assert.equal(record.version, pageVersion("<p>v2</p>"));
  assert.match(String(record.confirmed_by), /re-read/);
  assert.equal(sentUpdates(applied).length, 1);
  assert.deepEqual(routes(applied).slice(-2), ["/sync/v1/run", "/sync/v1/view-content-read"]);

  // A carrier failure before any answer, and nothing applied: safe to re-run, said so.
  const lost = await harness();
  lost.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/view-content-update")) {
      lost.host.requests.push({ path: "/sync/v1/view-content-update", body: JSON.parse(String(init?.body)), headers: new Headers() });
      throw new TypeError("socket hang up");
    }
    return lost.host.fetch(input, init);
  }) as typeof fetch;
  await writeFile(path.join(lost.folder, KEY), "<p>v2</p>");
  const notApplied = await rejects(update(lost, lost.v1));
  assert.equal(notApplied.code, "TRANSIENT");
  assert.equal(notApplied.details?.write_state, "not_applied_as_observed");
  assert.match(notApplied.message, /had not applied when the page was read again/);
  assert.match(notApplied.help ?? "", /re-running is safe because it is pinned to --expected-version/);
  assert.equal(sentUpdates(lost).length, 1);

  // An unreadable answer, and meanwhile someone else's page: a conflict naming it.
  const raced = await harness();
  raced.host.viewContentHook = (route) => {
    if (route !== "view-content-update") return undefined;
    raced.host.viewPages.get(VIEW)!.html = "<p>theirs</p>";
    return new Response("<html>bad gateway</html>", { status: 502 });
  };
  await writeFile(path.join(raced.folder, KEY), "<p>v2</p>");
  const conflict = await rejects(update(raced, raced.v1));
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.details?.actual, pageVersion("<p>theirs</p>"));
  assert.equal(sentUpdates(raced).length, 1);
});

test("a page over 512 KiB, invalid UTF-8, a symbolic link, or no page: refused before anything is sent", async () => {
  const h = await harness();
  const big = path.join(h.cwd, "big.html");
  await writeFile(big, Buffer.alloc(512 * 1024 + 1, 0x61));
  const tooLarge = await rejects(update(h, h.v1, ["--file", big]));
  assert.equal(tooLarge.code, "USAGE");
  assert.equal(tooLarge.details?.reason, "too_large");
  const bad = path.join(h.cwd, "bad.html");
  await writeFile(bad, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
  assert.equal((await rejects(update(h, h.v1, ["--file", bad]))).details?.reason, "invalid_utf8");
  const link = path.join(h.cwd, "link.html");
  await symlink(big, link);
  assert.equal((await rejects(update(h, h.v1, ["--file", link]))).details?.reason, "unsafe_file");
  assert.equal((await rejects(update(h, h.v1, ["--file", path.join(h.cwd, "missing.html")]))).code, "NOT_FOUND");
  // Exactly the bound is admitted (and sent).
  const exact = path.join(h.cwd, "exact.html");
  await writeFile(exact, Buffer.alloc(512 * 1024, 0x61));
  assert.equal((await update(h, h.v1, ["--file", exact])).byte_count, 512 * 1024);
  assert.equal(sentUpdates(h).length, 1);
});

test("arguments: --expected-version is required and must be a sha256 version; the id must be a View registration", async () => {
  const h = await harness();
  assert.equal((await rejects(run(h, ["update", VIEW]))).code, "USAGE");
  assert.equal((await rejects(update(h, "abc"))).code, "USAGE");
  assert.equal((await rejects(run(h, ["read", "notes/alpha"]))).code, "USAGE");
  assert.equal((await rejects(run(h, ["read", VIEW, "extra"]))).code, "USAGE");
  assert.deepEqual(routes(h), []);
});

test("not a hosted checkout: USAGE saying to read or edit the file directly", async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-viewc-local-")));
  const home = await mkdtemp(path.join(tmpdir(), "sb-viewc-local-home-"));
  await init(["--create-only", "--recipe", "none", "--dir", path.join(cwd, "b")], { stdout: () => {} });
  const deps = { stdout: () => {}, cwd, hosted: { auth: defaultHostedAuthDeps(home, { env: {} }) } };
  const read = await rejects(view(["read", VIEW, "--dir", path.join(cwd, "b")], deps));
  assert.equal(read.code, "USAGE");
  assert.equal(read.details?.reason, "not_a_hosted_checkout");
  assert.match(read.message, /read the file directly/);
  const edit = await rejects(view(["update", VIEW, "--expected-version", ZERO, "--dir", path.join(cwd, "b")], deps));
  assert.match(edit.message, /edit the file directly/);
});

test("sync still never sends views/: an edited page is held, naming view update", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, KEY), "<p>edited in place</p>");
  const out: string[] = [];
  const error = await rejects(
    sync(["--dir", h.folder, "--json"], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: async () => {}, lookupDelayMs: 0 }, sleep: async () => {} }),
  );
  assert.equal(error.code, "CONFLICT");
  const receipt = JSON.parse(out.at(-1)!) as { rows: { id: string; state: string; reason: string; message?: string }[] };
  const row = receipt.rows.find((candidate) => candidate.id === KEY)!;
  assert.equal(row.state, "held");
  assert.equal(row.reason, "not_a_document");
  assert.match(JSON.stringify(row), /view update <viewId> --expected-version <version>/);
  assert.equal(sentUpdates(h).length, 0);
  assert.equal(h.host.viewPages.get(VIEW)!.html, PAGE);
});

test("a content conflict whose host version is the bytes being sent is already applied: success-shaped and recorded", async () => {
  const h = await harness();
  const next = "<p>v2</p>";
  await writeFile(path.join(h.folder, KEY), next);
  // The update landed earlier (its answer lost); the author re-runs from the version they started at.
  h.host.viewPages.get(VIEW)!.html = next;
  const record = await update(h, h.v1);
  assert.equal(record.already_applied, true);
  assert.equal(record.update, "unchanged");
  assert.equal(record.version, pageVersion(next));
  assert.equal(record.checkout_copy, "current");
  assert.match((record.notes as string[])[0]!, /already held exactly these bytes/);
  const binding = (await bindingForPath(h.home, h.folder))!;
  const projection = JSON.parse(await readFile(path.join(checkoutDir(h.home, binding.checkout_id), "projection.json"), "utf8")) as { extras?: Record<string, string> };
  assert.equal(projection.extras?.[KEY], pageVersion(next));
});

test("a busy checkout lock: the update lands and the note names the no-op update that records the copy", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, KEY), "<p>v2</p>");
  const binding = (await bindingForPath(h.home, h.folder))!;
  let record: Record<string, unknown> | undefined;
  await filesystemPushRoleLocks().request(checkoutLockName(binding.path), {}, async () => {
    record = await update(h, h.v1);
  });
  assert.equal(record!.update, "changed");
  assert.equal(record!.checkout_copy, "current");
  const note = (record!.notes as string[]).find((text) => text.includes("another command holds the checkout"))!;
  assert.match(note, new RegExp(`view update ${VIEW} --expected-version ${pageVersion("<p>v2</p>")}`));
  assert.match(note, /no-op update/);
  // That no-op update, run once the lock is free, records it.
  const again = await update(h, pageVersion("<p>v2</p>"));
  assert.equal(again.update, "unchanged");
  assert.equal(again.checkout_copy, "current");
  assert.equal((again.notes as string[]).some((text) => text.includes("another command holds the checkout")), false);
});

test("the default page is never read through a symbolic link on its folder", async () => {
  const h = await harness();
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "sb-viewc-outside-")));
  await writeFile(path.join(outside, "board.html"), "<p>secret from outside</p>");
  await rename(path.join(h.folder, "views"), path.join(h.cwd, "views-moved"));
  await symlink(outside, path.join(h.folder, "views"));
  const error = await rejects(update(h, h.v1));
  assert.equal(error.code, "USAGE");
  assert.equal(error.details?.reason, "unsafe_file");
  assert.equal(sentUpdates(h).length, 0);
  assert.deepEqual(routes(h), [], "refused before any request");
});

test("a malformed 200 update answer is settled by the re-read, never resent", async () => {
  const h = await harness();
  h.host.viewContentHook = (route) => (route === "view-content-update" ? { applyThen: Response.json({ ok: true, operationId: "views.content.update.v1", data: { bundleId: BUNDLE } }) } : undefined);
  await writeFile(path.join(h.folder, KEY), "<p>v2</p>");
  const record = await update(h, h.v1);
  assert.equal(record.update, "changed");
  assert.equal(record.version, pageVersion("<p>v2</p>"));
  assert.match(String(record.confirmed_by), /re-read/);
  assert.equal(sentUpdates(h).length, 1);
});

test("only a path that could be a View's page points at view update", () => {
  for (const rel of ["views/board.html", "Views/a/b.HTM", "pages/legacy.html"]) assert.equal(isViewPagePath(rel), true, rel);
  for (const rel of ["views/logo.png", "views/board.md", "notes/page.html", "views", "viewsx/a.html"]) assert.equal(isViewPagePath(rel), false, rel);
});

// ── view create ───────────────────────────────────────────────────────────────

const NEW_NAME = "product-overview";
const NEW_VIEW = `views-registry/${NEW_NAME}`;
const NEW_KEY = `views/${NEW_NAME}.html`;
const NEW_PAGE = "<!doctype html><p>product overview</p>\n";
const sentCreates = (h: Harness) => h.host.requests.filter((request) => request.path === "/sync/v1/view-create");
const create = (h: Harness, extra: string[] = []) => run(h, ["create", NEW_NAME, "--title", "Product Overview", ...extra]);
const syncOnce = async (h: Harness) => {
  const out: string[] = [];
  await sync(["--dir", h.folder, "--json"], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: async () => {}, lookupDelayMs: 0 }, sleep: async () => {} });
  return JSON.parse(out.at(-1)!) as { rows: { id: string; state: string }[] };
};

test("view create: the checkout's views/<name>.html is sent with the title and default access; the record and page are created", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, NEW_KEY), NEW_PAGE);
  const record = await create(h, ["--description", "  What we sell  "]);
  assert.equal(record.view, "create");
  assert.equal(record.create, "created");
  assert.equal(record.registry_id, NEW_VIEW);
  assert.equal(record.key, NEW_KEY);
  assert.equal(record.version, pageVersion(NEW_PAGE));
  assert.equal(record.byte_count, Buffer.byteLength(NEW_PAGE));
  assert.equal(record.access, "bundle-read");
  assert.equal(record.checkout_copy, "current");
  assert.equal(record.resent, undefined);
  assert.match((record.notes as string[]).join("\n"), /listed now in this workspace's Views; run sync to pull the record/);
  assert.match((record.help as string[])[0]!, /sync --dir/);
  assert.deepEqual(sentCreates(h).map((request) => request.body), [{ bundleId: BUNDLE, name: NEW_NAME, title: "Product Overview", description: "What we sell", access: "bundle-read", html: NEW_PAGE }]);
  assert.deepEqual(routes(h), ["/sync/v1/whoami", "/sync/v1/view-create"]);
  assert.equal(h.host.viewPages.get(NEW_VIEW)!.html, NEW_PAGE);
  assert.deepEqual(h.host.docs.get(NEW_VIEW)!.frontmatter, { type: "View", title: "Product Overview", description: "What we sell", entry: NEW_KEY, access: "bundle-read" });
});

test("view create then sync: the unsent local page meets the new record and page, and the checkout ends clean with no conflict or duplicate", async () => {
  const h = await harness();
  // The usual journey: the page is written in the checkout first. Sync holds it (it never sends views/).
  await writeFile(path.join(h.folder, NEW_KEY), NEW_PAGE);
  const before = await rejects(syncOnce(h));
  assert.equal(before.code, "CONFLICT", "before the create, sync holds the unsent page");
  await create(h, ["--file", path.join(h.folder, NEW_KEY), "--access", "none"]);
  const receipt = await syncOnce(h);
  assert.deepEqual(receipt.rows.filter((row) => row.state !== "committed"), [], "nothing held, conflicted or refused");
  // The record came down beside the page; the page is the bytes sent, recorded as the host's.
  const pulled = await readFile(path.join(h.folder, `${NEW_VIEW}.md`), "utf8");
  assert.match(pulled, /type: View/);
  assert.match(pulled, /entry: views\/product-overview\.html/);
  assert.match(pulled, /access: none/);
  assert.equal(await readFile(path.join(h.folder, NEW_KEY), "utf8"), NEW_PAGE);
  // A second sync has nothing to do, and nothing was sent as a document or a page.
  const again = await syncOnce(h);
  assert.deepEqual(again.rows.filter((row) => row.state !== "committed"), []);
  assert.equal(sentCreates(h).length, 1);
  assert.equal(sentUpdates(h).length, 0);
  assert.equal(h.host.applied.length, 0, "no document write: the record is the host's");
});

test("view create --file outside the checkout: created, the checkout holds no copy until sync brings the record", async () => {
  const h = await harness();
  const file = path.join(h.cwd, "draft.html");
  await writeFile(file, NEW_PAGE);
  const record = await create(h, ["--file", file]);
  assert.equal(record.create, "created");
  assert.equal(record.checkout_copy, "absent");
});

test("view create: a View or page of that name already exists: CONFLICT naming it and view update; nothing saved", async () => {
  const h = await harness();
  await writeFile(path.join(h.cwd, "board.html"), NEW_PAGE);
  const taken = await rejects(run(h, ["create", "board", "--title", "Board", "--file", path.join(h.cwd, "board.html")]));
  assert.equal(taken.code, "CONFLICT");
  assert.equal(taken.details?.reason, "already_exists");
  assert.equal(taken.details?.target, "registry");
  assert.match(taken.message, /a View or file named board already exists .*\(registry: the record views-registry\/board, version sha256:[0-9a-f]{64}\): nothing was saved/);
  assert.match(taken.help ?? "", /view read views-registry\/board .* view update views-registry\/board --expected-version <version>/);
  // A page at the key with no record (an orphan): the content target, and the update pinned to it.
  h.host.viewPages.set("views-registry/orphan", { key: "views/orphan.html", contentType: "text/html", html: "<p>orphan</p>" });
  const orphan = await rejects(run(h, ["create", "orphan", "--title", "Orphan", "--file", path.join(h.cwd, "board.html")]));
  assert.equal(orphan.details?.target, "content");
  assert.match(orphan.message, /\(content: the page views\/orphan\.html, version /);
  assert.match(orphan.help ?? "", new RegExp(`view update views-registry/orphan --expected-version ${pageVersion("<p>orphan</p>")}`));
  assert.equal(h.host.viewCreates.length, 0);
});

test("view create: refusals from the host each say nothing was saved; a person without the model permission is refused before sending", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, NEW_KEY), NEW_PAGE);
  for (const [code, status, cli] of [["definition_writes_refused", 403, "FORBIDDEN"], ["bundle_access_denied", 403, "FORBIDDEN"], ["invalid_input", 400, "USAGE"], ["concurrent_change", 409, "CONFLICT"]] as const) {
    h.host.viewContentHook = () => Response.json({ ok: false, operationId: "views.create.v1", error: { code, writeState: "not_applied", retryable: false } }, { status });
    const error = await rejects(create(h));
    assert.equal(error.code, cli, code);
    assert.match(error.message, /nothing was saved/, code);
  }
  assert.equal(sentCreates(h).length, 4, "a refusal is never resent");
  assert.equal(h.host.viewCreates.length, 0);

  const refused = await harness({ definitionWrites: "refused" });
  await writeFile(path.join(refused.folder, NEW_KEY), NEW_PAGE);
  const upFront = await rejects(create(refused));
  assert.equal(upFront.code, "FORBIDDEN");
  assert.equal(upFront.details?.reason, "definitions_refused");
  assert.equal(upFront.details?.command, "view create");
  assert.match(upFront.message, /you don't have permission to change this bundle's model/);
  assert.deepEqual(routes(refused), [], "refused before any request");
});

test("view create: a lost answer is resent once; a landed first attempt answers already created", async () => {
  // 503 write_outcome_unknown after the create landed: the resend answers created: false.
  const landed = await harness();
  let calls = 0;
  landed.host.viewContentHook = (route) =>
    route === "view-create" && ++calls === 1 ? { applyThen: Response.json({ ok: false, operationId: "views.create.v1", error: { code: "write_outcome_unknown", writeState: "unknown", retryable: false } }, { status: 503 }) } : undefined;
  await writeFile(path.join(landed.folder, NEW_KEY), NEW_PAGE);
  const record = await create(landed);
  assert.equal(record.create, "already_created");
  assert.equal(record.resent, true);
  assert.match((record.notes as string[])[0]!, /already created: your earlier attempt was saved/);
  assert.equal(record.checkout_copy, "current");
  assert.equal(sentCreates(landed).length, 2);
  assert.equal(landed.host.viewCreates.length, 1, "created once");

  // No answer at all and nothing landed: the resend creates it.
  const lost = await harness();
  let dropped = false;
  lost.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/view-create") && !dropped) {
      dropped = true;
      lost.host.requests.push({ path: "/sync/v1/view-create", body: JSON.parse(String(init?.body)), headers: new Headers() });
      throw new TypeError("socket hang up");
    }
    return lost.host.fetch(input, init);
  }) as typeof fetch;
  await writeFile(path.join(lost.folder, NEW_KEY), NEW_PAGE);
  const resent = await create(lost);
  assert.equal(resent.create, "created");
  assert.equal(resent.resent, true);
  assert.equal(sentCreates(lost).length, 2);

  // Both answers lost: outcome unknown, sent exactly twice, naming how to check.
  const twice = await harness();
  twice.host.viewContentHook = (route) => (route === "view-create" ? new Response("<html>bad gateway</html>", { status: 502 }) : undefined);
  await writeFile(path.join(twice.folder, NEW_KEY), NEW_PAGE);
  const unknown = await rejects(create(twice));
  assert.equal(unknown.code, "RUNTIME");
  assert.equal(unknown.details?.reason, "write_outcome_unknown");
  assert.match(unknown.message, /may or may not have been saved/);
  assert.match(unknown.help ?? "", /view read views-registry\/product-overview/);
  assert.equal(sentCreates(twice).length, 2);
});

test("view create: the name, title, description, access and page are checked before anything is sent", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, NEW_KEY), NEW_PAGE);
  for (const argv of [
    ["create", "Product", "--title", "T"],
    ["create", "a/b", "--title", "T"],
    ["create", `a${"b".repeat(55)}`, "--title", "T"],
    ["create", NEW_NAME],
    ["create", NEW_NAME, "--title", "   "],
    ["create", NEW_NAME, "--title", "t".repeat(121)],
    ["create", NEW_NAME, "--title", "T", "--description", "d".repeat(321)],
    ["create", NEW_NAME, "--title", "T", "--access", "bundle-propose"],
    ["create", "missing-page", "--title", "T"],
  ]) {
    const error = await rejects(run(h, argv));
    assert.ok(error.code === "USAGE" || error.code === "NOT_FOUND", `${argv.join(" ")}: ${error.code}`);
  }
  const big = path.join(h.cwd, "big.html");
  await writeFile(big, Buffer.alloc(512 * 1024 + 1, 0x61));
  assert.equal((await rejects(create(h, ["--file", big]))).details?.reason, "too_large");
  const bad = path.join(h.cwd, "bad.html");
  await writeFile(bad, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
  assert.equal((await rejects(create(h, ["--file", bad]))).details?.reason, "invalid_utf8");
  assert.deepEqual(routes(h), []);
});

test("view create: a host without the route is NOT_IMPLEMENTED; a local bundle is told to add the files", async () => {
  const h = await harness({ viewCreate: false });
  await writeFile(path.join(h.folder, NEW_KEY), NEW_PAGE);
  const error = await rejects(create(h));
  assert.equal(error.code, "NOT_IMPLEMENTED");
  assert.match(error.message, /does not offer View creation yet/);

  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-viewc-local-")));
  const home = await mkdtemp(path.join(tmpdir(), "sb-viewc-local-home-"));
  await init(["--create-only", "--recipe", "none", "--dir", path.join(cwd, "b")], { stdout: () => {} });
  const local = await rejects(view(["create", NEW_NAME, "--title", "T", "--dir", path.join(cwd, "b")], { stdout: () => {}, cwd, hosted: { auth: defaultHostedAuthDeps(home, { env: {} }) } }));
  assert.equal(local.details?.reason, "not_a_hosted_checkout");
  assert.match(local.message, /add the page and its views-registry\/ record as plain files/);
});
