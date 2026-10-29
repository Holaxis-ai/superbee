// `superbee view read` and `superbee view update` in a hosted checkout: a registered View's page
// read and replaced whole on the host (`/sync/v1/view-content-read`, `/sync/v1/view-content-update`),
// against the stateful fake of the sync routes. Sync never sends `views/`; these commands are the
// one way a checkout changes a page, pinned to the registration's and the page's versions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { view } from "../src/commands/view.js";
import { init } from "../src/commands/init.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { checkoutDir, bindingForPath } from "../src/hosted/binding.js";
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
  assert.deepEqual(routes(h), ["/sync/v1/whoami", "/sync/v1/read", "/sync/v1/view-content-read"]);
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
  assert.match(String(record.note), /does not approve execution/);
  assert.match(String(record.note), /pin/);
  assert.match(String(record.note), /approving again/);
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
  assert.match(String((record.notes as string[])[0]), /still holds the previous page/);
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
  assert.deepEqual(routes(applied).slice(-2), ["/sync/v1/read", "/sync/v1/view-content-read"]);

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
  assert.equal(notApplied.details?.write_state, "not_applied");
  assert.match(notApplied.help ?? "", /re-run the same command/);
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
