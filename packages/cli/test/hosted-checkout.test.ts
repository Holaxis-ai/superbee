// `superbee checkout` against a fake hosted sync family that replays the host's golden transport
// fixtures (superbee-hosted `test/fixtures/hosted-transport/`, pinned byte-for-byte in core's
// `test/fixtures/hosted-transport/`). No request leaves the process: the fake is a `fetch`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode } from "@toon-format/toon";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import { headsDigest } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { checkout, CHECKOUT_DOCUMENT_LIMIT } from "../src/commands/checkout.js";
import { catalog } from "../src/commands/catalog.js";
import { list } from "../src/commands/list.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { bindingForPath, checkoutLockName, checkoutStoreDir, folderIdentity, hostedCheckoutsRoot, sameFolder, writeBinding } from "../src/hosted/binding.js";
import { bundleHomeAt, homeDetail } from "../src/bundle-home.js";
import { sync } from "../src/commands/sync.js";
import { loadCatalog } from "../src/catalog.js";
import { readCheckoutMarker } from "../src/hosted/marker.js";
import { folderConflicts, readProjection } from "../src/hosted/sync-scan.js";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { createHostedSyncClient } from "../src/hosted/client.js";
import { hostedAuthRoot, hostedWriteHost, storedSessionHosts, writeDefaultHost } from "../src/hosted-auth/session.js";
import { seedHostedSession } from "./support/hosted-session.js";
import { writeUserStateFileAtomic0600 } from "../src/user-state.js";
import { assertAllowedInHostedCheckout, HOSTED_CHECKOUT_REFUSALS } from "../src/hosted/refusals.js";
import { findPathCollision, placeNew, replaceGuarded } from "../src/hosted/projection.js";
import { FakeIssuer } from "./support/fake-issuer.js";
import { isolatedUserEnv } from "./support/user-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../core/test/fixtures/hosted-transport");
const HOST = "https://hosted.example";
const BUNDLE = "team.knowledge";
const PRINCIPAL = "principal-7";
const TOKEN_CLAIMS = { aud: `${HOST}/mcp`, sub: "auth0|person" };

interface Fixture {
  response: { status: number; headers: Record<string, string>; body: string };
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

const TOKEN = jwt(TOKEN_CLAIMS);

interface FakeOptions {
  /** Route (under `/sync/v1/`) to fixture name, over the defaults. */
  fixtures?: Record<string, string>;
  bundles?: string[];
  tenants?: string[];
  /** Each workspace with its slug, as whoami names them; absent is a host from before qualified references. */
  workspaces?: { tenantId: string; slug: string | null }[];
  /** The slug of the workspace holding the bundle: bundle-scoped bodies then name `<slug>/<bundle>`. */
  slug?: string;
  /** Raw answers by route for a body naming the bundle in another workspace (`<slug>/<bundle>`), by slug. */
  elsewhere?: Record<string, Record<string, { status: number; headers: Record<string, string>; body: string }>>;
  /** Raw answers by route, over the fixtures. */
  raw?: Record<string, { status: number; headers: Record<string, string>; body: string }>;
}

/**
 * The sync route family as the hosted routes answer it. Capabilities, heads and snapshot replay
 * the golden fixtures. Whoami and bundles have no fixture yet; their bodies follow the route
 * source (`src/sync-v1-reads.ts` in hosted PR 587): `{ principalId, credentialId, tenantIds,
 * surface }` and the `bundles.list.v1` result envelope.
 */
function fakeSyncFamily(options: FakeOptions = {}) {
  const requests: { path: string; body: unknown; authorization: string | null }[] = [];
  const routes: Record<string, string> = {
    capabilities: "capabilities-operations",
    heads: "heads-200",
    snapshot: "snapshot-complete",
    ...options.fixtures,
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, body, authorization: headers.get("authorization") });
    assert.equal(url.origin, HOST);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
      const refusal = fixture("refusal-unauthenticated").response;
      return new Response(refusal.body, { status: refusal.status, headers: refusal.headers });
    }
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    if (route === "whoami") {
      return Response.json({
        principalId: PRINCIPAL,
        credentialId: "cli",
        tenantIds: options.tenants ?? ["tenant-a"],
        ...(options.workspaces ? { workspaces: options.workspaces } : {}),
        surface: "sync",
      });
    }
    if (route === "bundles") {
      const ids = options.bundles ?? [BUNDLE];
      return Response.json({
        ok: true,
        operationId: "bundles.list.v1",
        data: { bundles: ids.map((bundleId) => ({ bundleId, name: bundleId, purpose: "", domains: [], lifecycle: "active", sensitivity: "internal" })) },
      });
    }
    const named = (body as { bundleId?: string } | undefined)?.bundleId;
    const other = typeof named === "string" && named.includes("/") ? options.elsewhere?.[named.split("/")[0]!]?.[route] : undefined;
    if (other) return new Response(other.body, { status: other.status, headers: other.headers });
    const raw = options.raw?.[route];
    if (raw) return new Response(raw.body, { status: raw.status, headers: raw.headers });
    const name = routes[route];
    if (!name) return Response.json({ error: "not_found" }, { status: 404 });
    // Qualified by the fake's workspace, or (a read of another holder) by another of the person's
    // workspaces, which serves the same fixture unless `elsewhere` says otherwise.
    const ids = options.slug ? (options.workspaces ?? []).filter((w) => w.slug !== null).map((w) => `${w.slug}/${BUNDLE}`) : [BUNDLE];
    assert.deepEqual(Object.keys(body ?? {}), ["bundleId"]);
    assert.ok(ids.includes(named as string), `unexpected bundleId ${String(named)}`);
    const { response } = fixture(name);
    return new Response(response.status === 304 ? null : response.body, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  return { fetch: fetcher, requests };
}

interface Harness {
  home: string;
  cwd: string;
  auth: HostedAuthDeps;
  out: string[];
}

async function harness(env: NodeJS.ProcessEnv = { SUPERBEE_ACCESS_TOKEN: TOKEN }): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-checkout-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "sb-checkout-cwd-"));
  const auth = defaultHostedAuthDeps(home, {
    env,
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  return { home, cwd, auth, out: [] };
}

async function run(h: Harness, argv: string[], fake = fakeSyncFamily()) {
  await checkout(argv, { stdout: (text) => h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

async function rejects(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected a CliError");
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

test("checkout mirrors the bundle into a new folder and binds it privately", async () => {
  const h = await harness();
  const fake = fakeSyncFamily();
  const receipt = await run(h, [BUNDLE, "--host", HOST], fake);
  const folder = path.join(h.cwd, BUNDLE);
  assert.equal(receipt.checkout, "created");
  assert.equal(receipt.bundle_id, BUNDLE);
  assert.equal(receipt.principal, PRINCIPAL);
  assert.equal(receipt.workspace, "tenant-a");
  assert.equal(receipt.documents, 3);
  assert.equal(receipt.root_index, true);
  assert.equal(receipt.heads_digest, "sha256:e1049689bc22d94329e6438c8cb04e6debee695576f2f10dde18caee00d93f14");

  assert.deepEqual(await filesUnder(folder), [".superbee/checkout.json", "index.md", "notes/alpha.md", "notes/beta.md", "projects/2026/plan.md"]);
  const root = await readFile(path.join(folder, "index.md"), "utf8");
  assert.equal(root, '---\nokf_version: "0.2"\ntitle: Team knowledge\n---\n# Team knowledge\n');
  const alpha = await readFile(path.join(folder, "notes/alpha.md"), "utf8");
  assert.match(alpha, /^---\n/);
  assert.match(alpha, /Alpha body é\.\n$/);
  // CRLF bodies stay byte-exact.
  assert.match(await readFile(path.join(folder, "notes/beta.md"), "utf8"), /Line one\r\nLine two\r\n$/);

  // No binding in the folder: the link lives in private state only. The one file that names the
  // host is the read-only marker, which never routes (D3).
  for (const file of await filesUnder(folder)) {
    if (file === path.join(".superbee", "checkout.json")) continue;
    assert.doesNotMatch(await readFile(path.join(folder, file), "utf8"), /hosted\.example/);
  }
  const marker = JSON.parse(await readFile(path.join(folder, ".superbee", "checkout.json"), "utf8")) as Record<string, unknown>;
  assert.equal(marker.superbee_checkout, 1);
  assert.equal(marker.home, "hosted");
  assert.equal(marker.host, HOST);
  assert.equal(marker.bundle_id, BUNDLE);
  assert.equal((await stat(path.join(folder, ".superbee", "checkout.json"))).mode & 0o222, 0, "the marker is read-only");
  const binding = await bindingForPath(h.home, await import("node:fs/promises").then((fs) => fs.realpath(folder)));
  assert.ok(binding);
  assert.equal(binding.origin, HOST);
  assert.equal(binding.audience, `${HOST}/mcp`);
  assert.equal(binding.routes, "/sync/v1");
  assert.equal(binding.bundle_id, BUNDLE);
  assert.equal(binding.principal_id, PRINCIPAL);
  assert.equal(binding.workspace, "tenant-a");
  assert.equal(binding.state, "ready");
  const privateDir = path.join(hostedCheckoutsRoot(h.home), binding.checkout_id);
  assert.equal((await stat(privateDir)).mode & 0o077, 0);
  assert.ok((await readdir(path.join(privateDir, "store"))).includes("store.log"));

  // The token went only to the named host, in the Authorization header.
  assert.deepEqual(fake.requests.map((r) => r.path), ["/sync/v1/whoami", "/sync/v1/bundles", "/sync/v1/capabilities", "/sync/v1/heads", "/sync/v1/snapshot"]);
  assert.ok(fake.requests.every((r) => r.authorization === `Bearer ${TOKEN}`));

  // Idempotent: the same folder and bundle is a no-op that sends nothing.
  const again = await run(h, [BUNDLE, "--host", HOST], fake);
  assert.equal(again.checkout, "unchanged");
  assert.equal(fake.requests.length, 5);
});

test("existing commands run unchanged on the checkout folder", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  const out: string[] = [];
  await list(["--dir", folder, "--json"], { stdout: (s) => out.push(s) });
  const listed = JSON.parse(out.join("")) as { count?: number; docs?: { id: string }[] } & Record<string, unknown>;
  const ids = JSON.stringify(listed);
  for (const id of ["notes/alpha", "notes/beta", "projects/2026/plan"]) assert.ok(ids.includes(id), ids);
});

test("the host defaults to the last sign-in, never to SUPERBEE_HOST alone", async () => {
  const h = await harness({ SUPERBEE_ACCESS_TOKEN: TOKEN, SUPERBEE_HOST: HOST });
  const error = await rejects(run(h, [BUNDLE]));
  assert.equal(error.code, "USAGE");
  assert.match(error.help ?? "", /login --host/);

  await writeUserStateFileAtomic0600(h.home, hostedAuthRoot(h.home), "default-host.json", `${JSON.stringify({ host: HOST })}\n`);
  const receipt = await run(h, [BUNDLE]);
  assert.equal(receipt.checkout, "created");
  assert.equal(receipt.host, HOST);
});

test("signed in to two hosts, a checkout without --host refuses and names both; it never follows the last sign-in", async () => {
  const OTHER = "https://other-host.example";
  const h = await harness();
  await seedHostedSession(h.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  await seedHostedSession(h.home, { host: OTHER, accessToken: "other-token", expiresAtMs: Date.now() + 3_600_000 });
  // The last sign-in was the other host.
  await writeUserStateFileAtomic0600(h.home, hostedAuthRoot(h.home), "default-host.json", `${JSON.stringify({ host: OTHER })}\n`);
  const fake = fakeSyncFamily();
  const error = await rejects(run(h, [BUNDLE, "--dir", "team"], fake));
  assert.equal(error.code, "USAGE");
  assert.equal(error.details?.reason, "ambiguous_host");
  assert.deepEqual(error.details?.hosts, [HOST, OTHER]);
  assert.equal(error.details?.last_sign_in, OTHER);
  assert.match(error.message, /hosted\.example.*other-host\.example/);
  const commands = error.details?.commands as string[];
  assert.ok(commands.some((command) => command.includes(`--host ${HOST}`) && command.includes(`--dir ${path.join(h.cwd, "team")}`)), commands.join("\n"));
  assert.deepEqual(error.details?.with_session, [HOST, OTHER]);
  assert.equal(error.details?.no_session, undefined);
  assert.equal(fake.requests.length, 0, "no host is asked");
  assert.deepEqual(await readdir(h.cwd), [], "no folder is made");

  // Named, it binds the host it names, and the folder then keeps that host without --host.
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--dir", "team"], fake);
  assert.equal(receipt.checkout, "created");
  assert.equal(receipt.host, HOST);
  const again = await run(h, [BUNDLE, "--dir", "team"], fake);
  assert.equal(again.checkout, "unchanged");
  assert.equal(again.host, HOST);
});

test("one host signed in: a checkout without --host uses it, as before", async () => {
  const h = await harness();
  await seedHostedSession(h.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  await writeUserStateFileAtomic0600(h.home, hostedAuthRoot(h.home), "default-host.json", `${JSON.stringify({ host: HOST })}\n`);
  const receipt = await run(h, [BUNDLE]);
  assert.equal(receipt.checkout, "created");
  assert.equal(receipt.host, HOST);
});

test("the implicit write host: every way it is chosen or refused, from stored sessions and the last sign-in alone", async () => {
  const OTHER = "https://other-host.example";
  const retry = (host: string) => `publish --host ${host}`;
  const live = Date.now() + 3_600_000;
  const fresh = async () => (await harness()).home;

  // Nothing: no host.
  assert.equal(await hostedWriteHost(undefined, await fresh(), retry), null);
  // --host "" is not "no --host".
  assert.equal((await rejects(hostedWriteHost("", await fresh(), retry))).code, "USAGE");

  // One session, no remembered sign-in: that host.
  let home = await fresh();
  await seedHostedSession(home, { host: HOST, accessToken: TOKEN, expiresAtMs: live });
  assert.deepEqual(await hostedWriteHost(undefined, home, retry).then((c) => [c?.target.origin, c?.source]), [HOST, "only-session"]);

  // The same host in another spelling is one host, not two.
  home = await fresh();
  await seedHostedSession(home, { host: `${HOST}/mcp/`, accessToken: TOKEN, expiresAtMs: live });
  await writeDefaultHost(home, HOST);
  assert.deepEqual(await hostedWriteHost(undefined, home, retry).then((c) => [c?.target.origin, c?.source]), [HOST, "last-sign-in"]);

  // Signed out of everything, a sign-in still remembered: that host, labeled as having no session.
  home = await fresh();
  await writeDefaultHost(home, OTHER);
  assert.deepEqual(await hostedWriteHost(undefined, home, retry).then((c) => [c?.target.origin, c?.source]), [OTHER, "last-sign-in-signed-out"]);

  // Signed out of the last sign-in's host but still holding another's session: refused, naming which has none.
  await seedHostedSession(home, { host: HOST, accessToken: TOKEN, expiresAtMs: live });
  const error = await rejects(hostedWriteHost(undefined, home, retry));
  assert.equal(error.details?.reason, "ambiguous_host");
  assert.deepEqual(error.details?.hosts, [HOST, OTHER]);
  assert.deepEqual(error.details?.with_session, [HOST]);
  assert.deepEqual(error.details?.no_session, [OTHER]);
  assert.equal(error.details?.last_sign_in, OTHER);
  assert.deepEqual(error.details?.commands, [`publish --host ${HOST}`, `publish --host ${OTHER}`]);

  // Named, it is always the host named.
  assert.deepEqual(await hostedWriteHost(OTHER, home, retry).then((c) => [c?.target.origin, c?.source]), [OTHER, "flag"]);
});

test("a session record copied into another session's directory does not count as a signed-in host", async () => {
  const h = await harness();
  const file = await seedHostedSession(h.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  await mkdir(path.join(hostedAuthRoot(h.home), "elsewhere"), { recursive: true });
  await writeFile(path.join(hostedAuthRoot(h.home), "elsewhere", "session.json"), (await readFile(file, "utf8")).replace(HOST, "https://other-host.example"));
  assert.deepEqual(await storedSessionHosts(h.home), [HOST]);
});

test("AUTH_REQUIRED from sign-in passes through with its link and a resume command that re-runs checkout", async () => {
  const issuer = await new FakeIssuer().start();
  try {
    const home = await mkdtemp(path.join(tmpdir(), "sb-checkout-auth-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sb-checkout-cwd-"));
    const auth = defaultHostedAuthDeps(home, { env: { [CREDENTIAL_STORE_ENV]: "file" } });
    const fake = fakeSyncFamily();
    const error = await rejects(checkout([BUNDLE, "--host", issuer.base, "--dir", "team", "--workspace", "tenant-a", "--json"], { stdout: () => {}, auth, cwd, fetch: fake.fetch }));
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.exitCode, 4);
    assert.match(String(error.details?.sign_in_url), /activate\?user_code=/);
    const resume = String(error.details?.resume);
    assert.match(resume, new RegExp(`checkout ${BUNDLE.replace(".", "\\.")} --host`));
    assert.match(resume, /--workspace tenant-a/);
    assert.match(resume, / --json$/);
    assert.ok(resume.includes(`--dir ${path.join(await realpath(cwd), "team")}`) || resume.includes(`--dir ${path.join(cwd, "team")}`), resume);
    assert.equal(fake.requests.length, 0, "no sync request before sign-in");
    assert.deepEqual(await readdir(cwd), [], "no folder before sign-in");
  } finally {
    await issuer.stop();
  }
});

test("a host that refuses the token is AUTH_REQUIRED naming the login command", async () => {
  const h = await harness({ SUPERBEE_ACCESS_TOKEN: jwt({ ...TOKEN_CLAIMS, sub: "someone-else" }) });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST]));
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.match(error.help ?? "", /login --host/);
  assert.match(String(error.details?.resume), /checkout team\.knowledge --host/);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("a listed bundle the working copy routes do not serve is refused as not served (Git source named as a possibility)", async () => {
  const h = await harness();
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fakeSyncFamily({ fixtures: { capabilities: "refusal-bundle-not-found" } })));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "not_served");
  assert.match(error.message, /Git board/);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("a bundle not visible to the person is NOT_FOUND before any bundle route", async () => {
  const h = await harness();
  const fake = fakeSyncFamily({ bundles: ["other.bundle"] });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fake));
  assert.equal(error.code, "NOT_FOUND");
  assert.deepEqual(error.details?.visible, ["other.bundle"]);
  assert.match(error.help ?? "", /superbee catalog list --hosted --host https:\/\/hosted\.example$/);
  assert.deepEqual(fake.requests.map((r) => r.path), ["/sync/v1/whoami", "/sync/v1/bundles"]);
});

test(`bundles over ${CHECKOUT_DOCUMENT_LIMIT} documents are refused`, async () => {
  const h = await harness();
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fakeSyncFamily({ fixtures: { heads: "refusal-result-too-large" } })));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "bundle_too_large");
  assert.deepEqual(await readdir(h.cwd), []);
});

test("a truncated snapshot leaves no folder, no binding and no private store", async () => {
  const h = await harness();
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fakeSyncFamily({ fixtures: { snapshot: "snapshot-truncated" } })));
  assert.equal(error.code, "TRANSIENT");
  assert.deepEqual(await readdir(h.cwd), []);
  const root = hostedCheckoutsRoot(h.home);
  const entries = await readdir(root).catch(() => [] as string[]);
  assert.deepEqual(entries.filter((name) => name !== "paths"), []);
});

test("checkout refuses a non-empty folder, a folder inside a bundle, and another bundle's checkout", async () => {
  const h = await harness();
  await mkdir(path.join(h.cwd, "busy"));
  await writeFile(path.join(h.cwd, "busy", "note.txt"), "mine");
  assert.equal((await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "busy"]))).code, "ALREADY_EXISTS");
  assert.equal(await readFile(path.join(h.cwd, "busy", "note.txt"), "utf8"), "mine");

  await mkdir(path.join(h.cwd, "local"));
  await writeFile(path.join(h.cwd, "local", "index.md"), '---\nokf_version: "0.2"\n---\n');
  const nested = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "local/inner"]));
  assert.equal(nested.code, "FORBIDDEN");
  assert.equal(nested.details?.reason, "inside_bundle");

  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const other = await rejects(run(h, ["other.bundle", "--host", HOST, "--dir", "team"]));
  assert.equal(other.code, "ALREADY_EXISTS");
  assert.equal(other.details?.reason, "other_checkout");
});

test("a second writer holding the checkout lock makes checkout report busy and leaves the folder", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "team");
  await mkdir(folder);
  const canonical = await import("node:fs/promises").then((fs) => fs.realpath(folder));
  const locks = filesystemPushRoleLocks();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const holder = locks.request(checkoutLockName(canonical), { ifAvailable: true }, async (lock) => {
    assert.ok(lock);
    acquired();
    await held;
  });
  await ready;
  try {
    const error = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "team"]));
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.details?.reason, "checkout_busy");
    assert.deepEqual(await readdir(folder), []);
  } finally {
    release();
    await holder;
  }
});

test("up-front refusals: every command sync cannot send is refused in a checkout with 'do this in the app'", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  const context = { home: h.home, cwd: h.cwd };
  // The app cannot change Kinds either: these say what to do instead, and never send to the app.
  const kinds: [string, string[]][] = [
    ["kind", ["field", "Note", "add", "owner", "--dir", folder]],
    ["kind", ["draft", "Note", "--dir", folder]],
    ["kind", ["dismiss", "Note", "--dir", folder]],
    ["recipe", ["add", "core", "--dir", folder]],
    ["recipe", ["evolve", "core", "--dir", folder]],
  ];
  for (const [command, args] of kinds) {
    const error = await rejects(assertAllowedInHostedCheckout(command, args, context));
    assert.equal(error.code, "FORBIDDEN", `${command} ${args[0]}`);
    assert.equal(error.details?.do_this_in, undefined);
    assert.doesNotMatch(`${error.message} ${error.help}`, /app/);
    assert.match(error.message, /cannot be changed from a checkout/);
    assert.match(error.help ?? "", /local or Git bundle/);
    assert.equal(error.details?.bundle_id, BUNDLE);
  }
  const refused: [string, string[]][] = [
    ["doc", ["verify", "notes/alpha", "--dir", folder]],
    ["artifact", ["create", "x.pdf", "--title", "x", "--dir", folder]],
    // Both succeeded locally and were then held by sync forever: refuse them up front instead.
    ["index", ["generate", "--dir", folder]],
    ["delete", ["--doc-key", "assets/logo.png", "--dir", folder]],
    ["delete", ["--doc-key=views/board/index.html", "--dir", folder]],
  ];
  for (const [command, args] of refused) {
    const error = await rejects(assertAllowedInHostedCheckout(command, args, context));
    assert.equal(error.code, "FORBIDDEN", `${command} ${args[0]}`);
    assert.equal(error.details?.do_this_in, "app");
    assert.match(error.message, /do this in the Superbee app/);
    assert.equal(error.details?.bundle_id, BUNDLE);
  }
  // From inside the folder, with no --dir, the checkout is still found.
  const inside = await rejects(assertAllowedInHostedCheckout("doc", ["verify", "notes/alpha"], { home: h.home, cwd: path.join(folder, "notes") }));
  assert.equal(inside.code, "FORBIDDEN");
  // sync runs in a checkout (hosted sync); ui is refused because it writes Views. mcp serves the
  // checkout through its folder and refuses only the writes sync cannot send (served-bundle.ts).
  await assertAllowedInHostedCheckout("sync", ["--dir", folder], context);
  assert.equal((await rejects(assertAllowedInHostedCheckout("ui", ["--dir", folder], context))).details?.do_this_in, "app");
  await assertAllowedInHostedCheckout("mcp", ["--dir", folder], context);
  await assertAllowedInHostedCheckout("mcp", ["install", "--dir", folder], context);
  const init = await rejects(assertAllowedInHostedCheckout("init", ["--dir", folder], context));
  assert.equal(init.code, "FORBIDDEN");
  assert.equal(init.details?.reason, "checkout_target");

  // Everything else, help, remote targets, and other folders run unchanged.
  await assertAllowedInHostedCheckout("doc", ["update", "notes/alpha", "--title", "x", "--dir", folder], context);
  await assertAllowedInHostedCheckout("list", ["--dir", folder], context);
  // A deletion syncs as a delete now (documents.delete.v1), so neither spelling is refused.
  await assertAllowedInHostedCheckout("doc", ["delete", "notes/alpha", "--dir", folder], context);
  await assertAllowedInHostedCheckout("delete", ["--doc-key", "notes/alpha.md", "--dir", folder], context);
  await assertAllowedInHostedCheckout("delete", ["--doc-key", "notes/Alpha.MD", "--dir", folder], context);
  // index without generate (navigation help) is not a write.
  await assertAllowedInHostedCheckout("index", ["--dir", folder], context);
  // The read-only check writes nothing, so it runs.
  await assertAllowedInHostedCheckout("index", ["generate", "--check", "--dir", folder], context);
  await assertAllowedInHostedCheckout("doc", ["delete", "--help", "--dir", folder], context);
  await assertAllowedInHostedCheckout("doc", ["delete", "x", "--remote", "http://127.0.0.1:9"], context);
  const elsewhere = await mkdtemp(path.join(tmpdir(), "sb-local-"));
  await writeFile(path.join(elsewhere, "index.md"), '---\nokf_version: "0.2"\n---\n');
  await assertAllowedInHostedCheckout("doc", ["delete", "x", "--dir", elsewhere], context);
  // promote to a blob key and serve are refused; promote of a .md document key is not.
  const blob = await rejects(assertAllowedInHostedCheckout("promote", ["x.pdf", "--doc-key", "files/x.pdf", "--dir", folder], context));
  assert.equal(blob.details?.do_this_in, "app");
  const serve = await rejects(assertAllowedInHostedCheckout("serve", ["--dir", folder, "--port", "0"], context));
  assert.equal(serve.details?.do_this_in, "app");
  await assertAllowedInHostedCheckout("promote", ["x.md", "--doc-key", "notes/x.md", "--dir", folder], context);
  // A key under a folder of conventions, or a reserved file, is held whatever its extension.
  assert.equal((await rejects(assertAllowedInHostedCheckout("promote", ["x.md", "--doc-key", "conventions/x.md", "--dir", folder], context))).details?.do_this_in, "app");
  assert.equal((await rejects(assertAllowedInHostedCheckout("delete", ["--doc-key", "notes/index.md", "--dir", folder], context))).details?.do_this_in, "app");
  await assertAllowedInHostedCheckout("delete", ["--doc-key", "notes/X.MD", "--dir", folder], context);
  assert.equal(HOSTED_CHECKOUT_REFUSALS.length, 11);
});

test("projection placement never overwrites: new files are exclusive, replacements are pre-image guarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-projection-"));
  const file = path.join(dir, "a", "doc.md");
  assert.deepEqual(await placeNew(file, Buffer.from("one")), { placed: true });
  assert.deepEqual(await placeNew(file, Buffer.from("two")), { placed: false, reason: "occupied" });
  assert.equal(await readFile(file, "utf8"), "one");

  assert.deepEqual(await replaceGuarded(file, Buffer.from("one"), Buffer.from("three")), { placed: true });
  assert.equal(await readFile(file, "utf8"), "three");

  // An agent edited the file since the last export: its bytes stay and the edit is pending.
  await writeFile(file, "agent edit");
  assert.deepEqual(await replaceGuarded(file, Buffer.from("three"), Buffer.from("four")), { placed: false, reason: "changed" });
  assert.equal(await readFile(file, "utf8"), "agent edit");

  // A deleted file is not recreated behind the agent's back.
  const gone = path.join(dir, "a", "gone.md");
  assert.deepEqual(await replaceGuarded(gone, Buffer.from("x"), Buffer.from("y")), { placed: false, reason: "missing" });
  await assert.rejects(stat(gone));
  // No temporary or pre-image file is left behind.
  assert.deepEqual((await readdir(path.join(dir, "a"))).sort(), ["doc.md"]);
});

test("built CLI: checkout is registered, and a refused command in a checkout is a TOON FORBIDDEN envelope", async () => {
  const cli = path.resolve(here, "../../superbee/dist/superbee.mjs");
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  const env = isolatedUserEnv(h.home, { ASLITE_NO_UPDATE_CHECK: "1" });
  const runCli = (argv: string[]) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const proc = spawn(process.execPath, [cli, ...argv], { env, cwd: h.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      proc.stdout.on("data", (c) => (stdout += c));
      proc.on("close", (status) => resolve({ status, stdout }));
    });
  const help = await runCli(["checkout", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /checkout <bundle-id> \[--host <url>\]/);
  assert.match(help.stdout, /checkout --release <folder>/);

  // `doc delete` now syncs as a delete; a command sync still cannot send stays refused.
  const refused = await runCli(["kind", "list", "--dir", folder]);
  assert.equal(refused.status, 2, refused.stdout);
  const envelope = decode(refused.stdout.trim()) as { error: { code: string; details: Record<string, unknown> } };
  assert.equal(envelope.error.code, "FORBIDDEN");
  assert.equal(envelope.error.details.reason, "not_syncable");
  assert.ok((await stat(path.join(folder, "notes/alpha.md"))).isFile(), "the document is untouched");

  const read = await runCli(["doc", "read", "notes/alpha", "--dir", folder]);
  assert.equal(read.status, 0, read.stdout);
  assert.match(read.stdout, /Alpha/);

  const missingHost = await runCli(["checkout", BUNDLE]);
  assert.equal(missingHost.status, 2);
});

test("a checkout whose folder was deleted is replaced at the same path; one emptied in place is refused", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  await rm(folder, { recursive: true });
  const again = await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  assert.equal(again.checkout, "created");
  assert.deepEqual(again.replaced_stale_checkout, { bundle_id: BUNDLE, host: HOST });
  assert.ok((await stat(path.join(folder, "notes/alpha.md"))).isFile());

  // Emptied in place (same folder identity) is a pending change to the live checkout, not a
  // stale one: every file removed would sync as deletions once delete exists.
  for (const entry of await readdir(folder)) await rm(path.join(folder, entry), { recursive: true });
  const emptied = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "team"]));
  assert.equal(emptied.code, "ALREADY_EXISTS");
  assert.equal(emptied.details?.reason, "emptied_checkout");
  assert.match(emptied.help ?? "", /checkout --release/);
  // A new empty folder at the path (another identity) is replaced.
  await rm(folder, { recursive: true });
  await mkdir(folder);
  const third = await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  assert.equal(third.checkout, "created");
  assert.ok(third.replaced_stale_checkout);
  // Only one private checkout remains.
  const ids = (await readdir(hostedCheckoutsRoot(h.home))).filter((name) => name !== "paths");
  assert.equal(ids.length, 1);
});

test("a folder recreated with other files is not mistaken for the checkout", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  await rm(folder, { recursive: true });
  await mkdir(folder);
  await writeFile(path.join(folder, "index.md"), '---\nokf_version: "0.2"\n---\n');
  // The refusal table no longer applies: the marker (folder identity) does not match.
  await assertAllowedInHostedCheckout("doc", ["delete", "x", "--dir", folder], { home: h.home, cwd: h.cwd });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "team"]));
  assert.equal(error.details?.reason, "not_empty");
});

test("checkout --release forgets the binding, keeps the files, and is idempotent", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = path.join(h.cwd, "team");
  const released = await run(h, ["--release", folder]);
  assert.equal(released.released, true);
  assert.equal(released.marker, "removed");
  assert.deepEqual((await readdir(folder)).filter((name) => name.startsWith(".")), [], "the marker and its folder are gone");
  assert.ok((await stat(path.join(folder, "notes/alpha.md"))).isFile());
  assert.equal(await bindingForPath(h.home, await realpath(folder)), null);
  assert.deepEqual((await readdir(hostedCheckoutsRoot(h.home))).filter((name) => name !== "paths"), []);
  await assertAllowedInHostedCheckout("doc", ["delete", "notes/alpha", "--dir", folder], { home: h.home, cwd: h.cwd });
  const again = await run(h, ["--release", folder]);
  assert.equal(again.released, false);
  // Release also works for a deleted folder.
  await run(h, [BUNDLE, "--host", HOST, "--dir", "other"]);
  await rm(path.join(h.cwd, "other"), { recursive: true });
  assert.equal((await run(h, ["--release", path.join(h.cwd, "other")])).released, true);
});

const TWO_WORKSPACES = {
  tenants: ["tenant-a", "tenant-b"],
  workspaces: [
    { tenantId: "tenant-a", slug: "north" },
    { tenantId: "tenant-b", slug: "south" },
  ],
};

test("--workspace by id is checked and recorded, never sent; an id two workspaces list bare is ambiguous, not a Git source", async () => {
  const h = await harness();
  const fake = fakeSyncFamily({ tenants: ["tenant-a", "tenant-b"] });
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--workspace", "tenant-b"], fake);
  assert.equal(receipt.workspace, "tenant-b");
  // A host from before qualified references names no slug: the bundle is named bare, and no
  // request carries a workspace header.
  assert.equal(receipt.reference, undefined);
  assert.ok(fake.requests.every((r) => !JSON.stringify(r.body ?? {}).includes("/")));

  const twice = fakeSyncFamily({ tenants: ["tenant-a", "tenant-b"], bundles: [BUNDLE, BUNDLE], fixtures: { capabilities: "refusal-bundle-not-found" } });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST, "--workspace", "tenant-a", "--dir", "amb"], twice));
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "ambiguous_bundle");
  assert.deepEqual(error.details?.workspaces, ["tenant-a", "tenant-b"]);
  assert.ok(!twice.requests.some((r) => r.path.endsWith("/capabilities")));
  // A reference against a host that names no workspaces is refused before any bundle request.
  const unsupported = await rejects(run(h, [`south/${BUNDLE}`, "--host", HOST, "--dir", "old"], fake));
  assert.equal(unsupported.code, "USAGE");
  assert.equal(unsupported.details?.reason, "references_unsupported");
});

test("a reference, or --workspace <slug>, names the bundle in that workspace on every bundle request; the binding records it", async () => {
  const h = await harness();
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`];
  const fake = fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" });
  const receipt = await run(h, [`south/${BUNDLE}`, "--host", HOST], fake);
  assert.equal(receipt.bundle_id, BUNDLE);
  assert.equal(receipt.reference, `south/${BUNDLE}`);
  assert.equal(receipt.workspace, "tenant-b");
  assert.equal(receipt.folder, await realpath(path.join(h.cwd, BUNDLE)), "the folder is named by the bare id");
  const binding = (await bindingForPath(h.home, receipt.folder as string))!;
  assert.equal(binding.bundle_id, BUNDLE);
  assert.equal(binding.workspace_slug, "south");
  for (const request of fake.requests) {
    const route = request.path.slice("/sync/v1/".length);
    if (route === "whoami" || route === "bundles") assert.deepEqual(request.body, {}, route);
    else assert.equal((request.body as { bundleId: string }).bundleId, `south/${BUNDLE}`, route);
  }
  // The same checkout again is a no-op, spelled bare or qualified.
  assert.equal((await run(h, [BUNDLE, "--host", HOST], fake)).checkout, "unchanged");
  // --workspace by slug qualifies a bare id the same way.
  const bySlug = await run(h, [BUNDLE, "--host", HOST, "--workspace", "south", "--dir", "two"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" }));
  assert.equal(bySlug.reference, `south/${BUNDLE}`);

  // The bare id is in both: refused, naming each reference and the command for the first.
  const bare = fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed });
  const ambiguous = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "three"], bare));
  assert.equal(ambiguous.code, "CONFLICT");
  assert.equal(ambiguous.details?.reason, "ambiguous_bundle");
  assert.deepEqual(ambiguous.details?.references, listed);
  assert.deepEqual(ambiguous.details?.workspaces, ["north", "south"]);
  // The help never picks a workspace: it names the form to choose with.
  assert.match(ambiguous.help ?? "", /checkout <workspace>\/<bundle-id> /);
  assert.ok(!bare.requests.some((r) => r.path.endsWith("/capabilities")));
  // A workspace the person is not in, and a reference --workspace contradicts, are refused before any bundle request.
  const stranger = await rejects(run(h, [`west/${BUNDLE}`, "--host", HOST, "--dir", "four"], bare));
  assert.equal(stranger.code, "NOT_FOUND");
  assert.equal(stranger.details?.reason, "not_a_member");
  const contradicted = await rejects(run(h, [`south/${BUNDLE}`, "--host", HOST, "--workspace", "north", "--dir", "five"], bare));
  assert.equal(contradicted.code, "USAGE");
  assert.equal(bare.requests.filter((r) => r.path.endsWith("/capabilities")).length, 0);
});

test("a bare id listed once bare and once by reference, or bare twice, is ambiguous: never sent bare", async () => {
  const h = await harness();
  for (const listed of [[BUNDLE, `north/${BUNDLE}`], [BUNDLE, BUNDLE]]) {
    const fake = fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed });
    const error = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", "amb"], fake));
    assert.equal(error.code, "CONFLICT", listed.join(","));
    assert.equal(error.details?.reason, "ambiguous_bundle");
    assert.ok(!fake.requests.some((r) => r.path.endsWith("/capabilities")), listed.join(","));
  }
});

test("a checkout made bare whose id another workspace gained is bound again in place naming its workspace", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"], fakeSyncFamily(TWO_WORKSPACES));
  const folder = await realpath(path.join(h.cwd, "team"));
  const before = (await bindingForPath(h.home, folder))!;
  assert.equal(before.workspace_slug, undefined);
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`];
  // Without --host it is refused.
  assert.equal((await rejects(run(h, ["--adopt", folder, "--workspace", "south"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" })))).code, "USAGE");
  // A workspace whose bundle of that id shares no document version with this checkout is another
  // bundle: refused, and the checkout is left bound as it was.
  const other = await rejects(run(h, ["--adopt", folder, "--host", HOST, "--workspace", "north"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "north", raw: withDocs(["notes/elsewhere"]) })));
  assert.equal(other.details?.reason, "not_this_bundle");
  assert.equal((await bindingForPath(h.home, folder))?.checkout_id, before.checkout_id);
  // Both workspaces' bundles share this checkout's versions (published from one source): which one
  // it came from cannot be shown, so nothing is re-bound.
  const both = await rejects(run(h, ["--adopt", folder, "--host", HOST, "--workspace", "south"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" })));
  assert.equal(both.details?.reason, "origin_unknown");
  assert.equal((await bindingForPath(h.home, folder))?.checkout_id, before.checkout_id);
  // South's bundle is this checkout's and north's is another: the folder is bound to south's in place, files kept.
  const fake = fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south", elsewhere: { north: withDocs(["notes/elsewhere"]) } });
  const rebound = await run(h, ["--adopt", folder, "--host", HOST, "--workspace", "south"], fake);
  assert.equal(rebound.adopted, "rebound");
  assert.equal(rebound.reference, `south/${BUNDLE}`);
  const after = (await bindingForPath(h.home, folder))!;
  assert.equal(after.workspace_slug, "south");
  assert.notEqual(after.checkout_id, before.checkout_id, "a new store");
  // Every bundle request names a workspace: north's heads only for the check, the bundle itself from south.
  const bundleBodies = fake.requests.filter((r) => !/\/(whoami|bundles)$/.test(r.path)).map((r) => `${r.path} ${(r.body as { bundleId: string }).bundleId}`);
  assert.deepEqual(bundleBodies.filter((line) => !line.endsWith(`south/${BUNDLE}`)), [`/sync/v1/heads north/${BUNDLE}`]);
  assert.ok(bundleBodies.includes(`/sync/v1/snapshot south/${BUNDLE}`));
  // Naming the same workspace again changes nothing; naming another is refused, never a move.
  assert.equal((await run(h, ["--adopt", folder, "--host", HOST, "--workspace", "south"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" }))).adopted, "unchanged");
  const moved = await rejects(run(h, ["--adopt", folder, "--host", HOST, "--workspace", "north"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "north" })));
  assert.equal(moved.details?.reason, "other_workspace");
  assert.equal((await bindingForPath(h.home, folder))?.checkout_id, after.checkout_id);
});

test("a copied bare checkout cannot be adopted into a workspace it cannot show it came from; a rebind leaves its marker naming the workspace", async () => {
  const h = await harness();
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`];
  // A bare checkout, and a copy of it (its marker names no workspace).
  await run(h, [BUNDLE, "--host", HOST, "--dir", "bare"], fakeSyncFamily(TWO_WORKSPACES));
  const bareFolder = await realpath(path.join(h.cwd, "bare"));
  const copied = path.join(h.cwd, "bare-copy");
  await cp(bareFolder, copied, { recursive: true });
  const refused = await rejects(run(h, ["--adopt", copied, "--host", HOST, "--workspace", "north"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "north" })));
  assert.equal(refused.details?.reason, "origin_unknown");
  assert.equal(await bindingForPath(h.home, await realpath(copied)), null, "nothing bound");
  // A verified rebind rewrites the marker to name the workspace before the old binding goes.
  const rebound = await run(h, ["--adopt", bareFolder, "--host", HOST, "--workspace", "north"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "north", elsewhere: { south: withDocs(["notes/elsewhere"]) } }));
  assert.equal(rebound.adopted, "rebound");
  assert.equal(readCheckoutMarker(bareFolder)?.workspace_slug, "north");
});

test("a checkout made in the person's only workspace is re-bound only to that workspace", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"], fakeSyncFamily({ tenants: ["tenant-a"], workspaces: [{ tenantId: "tenant-a", slug: "north" }] }));
  const folder = await realpath(path.join(h.cwd, "team"));
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`];
  // The person joined south, which holds the same id with the same versions: the checkout's own
  // record names north as its workspace, so south is refused and north is taken.
  const wrong = await rejects(run(h, ["--adopt", folder, "--host", HOST, "--workspace", "south"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" })));
  assert.equal(wrong.details?.reason, "not_this_bundle");
  const right = await run(h, ["--adopt", folder, "--host", HOST, "--workspace", "north"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "north" }));
  assert.equal(right.adopted, "rebound");
  // A host that names no workspaces leaves a bare checkout as it is.
  const h2 = await harness();
  await run(h2, [BUNDLE, "--host", HOST, "--dir", "team"], fakeSyncFamily({ tenants: ["tenant-a"] }));
  const bare = await run(h2, ["--adopt", await realpath(path.join(h2.cwd, "team")), "--host", HOST, "--workspace", "tenant-a"], fakeSyncFamily({ tenants: ["tenant-a"] }));
  assert.equal(bare.adopted, "unchanged");
});

test("whoami's workspaces are read strictly: absent is an older host, a mismatched list is malformed", async () => {
  const answering = (body: unknown) =>
    createHostedSyncClient({ target: { origin: HOST, audience: `${HOST}/mcp` } as never, accessToken: TOKEN, fetch: (async () => Response.json(body)) as typeof fetch });
  const base = { principalId: PRINCIPAL, credentialId: "cli", tenantIds: ["tenant-b", "tenant-a"], surface: "sync" };
  assert.deepEqual((await answering(base).whoami()).workspaces, [
    { tenantId: "tenant-a", slug: null },
    { tenantId: "tenant-b", slug: null },
  ]);
  for (const workspaces of [[{ tenantId: "tenant-a", slug: "north" }], [{ tenantId: "tenant-a", slug: "North" }, { tenantId: "tenant-b", slug: null }], [{ tenantId: "tenant-a", slug: "n" }, { tenantId: "tenant-a", slug: "m" }]])
    await assert.rejects(answering({ ...base, workspaces }).whoami(), (error: unknown) => error instanceof CliError && error.code === "RUNTIME");
});

test("the client names the bundle by its reference on every sync route but whoami, bundles and bundle-create", async () => {
  const sent: { path: string; body: unknown }[] = [];
  const recorder = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const client = createHostedSyncClient({ target: { origin: HOST, audience: `${HOST}/mcp` } as never, accessToken: TOKEN, fetch: recorder }).within("south");
  // Including the generic operation routes and a route no client knows yet: scoped by default.
  const scoped = ["capabilities", "heads", "snapshot", "read", "history", "create", "replace", "delete", "outcome", "operations", "run", "later-read"];
  for (const route of [...scoped, "whoami", "bundles", "bundle-create"])
    await client.carrier.json(`/sync/v1/${route}`, { bundleId: BUNDLE, n: 1 }, client.signal, { maximum: 1024 }).catch(() => {});
  await client.carrier.stream("/sync/v1/export", { bundleId: BUNDLE }, client.signal).catch(() => {});
  for (const { path: route, body } of sent) {
    const name = route.slice("/sync/v1/".length);
    const expected = [...scoped, "export"].includes(name) ? `south/${BUNDLE}` : BUNDLE;
    assert.equal((body as { bundleId: string }).bundleId, expected, name);
  }
  assert.equal(sent.length, scoped.length + 4);
  // A body that names no bundle is sent as it is; one that already names a reference is a bug.
  sent.length = 0;
  await client.carrier.json("/sync/v1/read", { documentId: "x" }, client.signal, { maximum: 1024 }).catch(() => {});
  assert.deepEqual(sent.map((r) => r.body), [{ documentId: "x" }]);
  await assert.rejects(client.carrier.json("/sync/v1/read", { bundleId: `north/${BUNDLE}` }, client.signal, { maximum: 1024 }), TypeError);
  assert.equal(sent.length, 1);
});

function withDocs(ids: string[]) {
  // A heads answer with these ids under their true digest; the snapshot is never reached when
  // checkout refuses first.
  const heads = ids.map((id) => ({ id, version: `sha256:${"0".repeat(64)}` }));
  return {
    heads: {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "x-superbee-root-version": "sha256:2d4238b1970c24a72552dc8e00a8ec0afa9a66d5f56418f8ac2fe5498945b107" },
      body: JSON.stringify({ count: heads.length, digest: headsDigest(heads), heads }),
    },
  };
}

test("ids that differ only in letter case are refused before any file is written", async () => {
  assert.deepEqual(findPathCollision(["Notes/A", "notes/b"]), { first: "Notes/", second: "notes/" });
  assert.deepEqual(findPathCollision(["notes/Straße", "notes/STRASSE"]), { first: "notes/Straße.md", second: "notes/STRASSE.md" });
  assert.equal(findPathCollision(["notes/a", "notes/b", "projects/x"]), null);
  assert.deepEqual(findPathCollision(["INDEX"]), { first: "index.md", second: "INDEX.md" });

  const h = await harness();
  const fake = fakeSyncFamily({ raw: withDocs(["notes/Alpha", "notes/alpha"]) });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fake));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "path_collision");
  assert.deepEqual(await readdir(h.cwd), []);
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/snapshot")));
});

test("the client-side document limit refuses a heads listing over it", async () => {
  const h = await harness();
  const ids = Array.from({ length: CHECKOUT_DOCUMENT_LIMIT + 1 }, (_, index) => `notes/n${index}`);
  const error = await rejects(run(h, [BUNDLE, "--host", HOST], fakeSyncFamily({ raw: withDocs(ids) })));
  assert.equal(error.details?.reason, "bundle_too_large");
  assert.equal(error.details?.documents, CHECKOUT_DOCUMENT_LIMIT + 1);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("a folder that reuses the checkout folder's inode (Linux) is told apart by its birth time", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = await realpath(path.join(h.cwd, "team"));
  const binding = (await bindingForPath(h.home, folder))!;
  const now = (await folderIdentity(folder))!;
  assert.ok(sameFolder(now, binding.folder_identity));
  // The same device and inode with another birth time is another folder, as when Linux hands a
  // freed inode to a folder recreated at the same path.
  if (now.birth) {
    await writeBinding(h.home, { ...binding, folder_identity: { dev: now.dev, ino: now.ino, birth: now.birth - 1000 } });
    assert.equal(await bindingForPath(h.home, folder), null);
  }
  // A filesystem without birth times falls back to device and inode.
  assert.ok(sameFolder({ dev: 1, ino: 2 }, { dev: 1, ino: 2, birth: 5 }));
  assert.ok(!sameFolder({ dev: 1, ino: 2, birth: 4 }, { dev: 1, ino: 2, birth: 5 }));
});

test("a moved checkout reads as an unbound copy, and --adopt binds it back with no network", async () => {
  const h = await harness();
  const fake = fakeSyncFamily();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"], fake);
  const before = await bindingForPath(h.home, await realpath(path.join(h.cwd, "team")));
  assert.ok(before);
  await rename(path.join(h.cwd, "team"), path.join(h.cwd, "moved"));
  const moved = await realpath(path.join(h.cwd, "moved"));

  // The marker never routes: the moved folder is local, and says it is a copy of a checkout.
  const facts = await bundleHomeAt(moved, { home: h.home });
  assert.equal(facts.home, "local");
  const detail = homeDetail(facts).copy_of_checkout as Record<string, unknown>;
  assert.equal(detail.bound, false);
  assert.equal(detail.bundle_id, BUNDLE);
  assert.equal(detail.host, HOST);
  assert.match(String(detail.help), /checkout --adopt .*moved --host https:\/\/hosted\.example/);

  // sync refuses it with the adopt command, instead of treating it as a Git board.
  const refused = await rejects(sync(["--dir", moved], { auth: h.auth, cwd: h.cwd }));
  assert.equal(refused.code, "USAGE");
  assert.equal(refused.details?.reason, "unbound_copy");
  assert.match(refused.help ?? "", /checkout --adopt/);

  const requests = fake.requests.length;
  const adopted = await run(h, ["--adopt", moved], fake);
  assert.equal(adopted.adopted, "moved");
  assert.equal(adopted.from, before.path);
  assert.equal(fake.requests.length, requests, "moving back is local: no request");
  const after = await bindingForPath(h.home, moved);
  assert.ok(after);
  assert.equal(after.checkout_id, before.checkout_id, "the same private store carries over");
  assert.equal(await bindingForPath(h.home, before.path), null);
  assert.equal((await bundleHomeAt(moved, { home: h.home })).home, "hosted");
  // The catalog entry follows the folder.
  assert.equal((adopted.catalog as Record<string, unknown>).relocated, true);
  const entries = (await loadCatalog(h.home)).entries;
  assert.deepEqual(entries.map((entry) => entry.locator.path), [moved]);

  // Adopting a bound folder is a no-op, and restores a missing marker.
  await unlink(path.join(moved, ".superbee", "checkout.json"));
  const again = await run(h, ["--adopt", moved], fake);
  assert.equal(again.adopted, "unchanged");
  assert.equal(again.marker, "written");
  assert.equal(readCheckoutMarker(moved)?.bundle_id, BUNDLE);
});

test("a copied checkout is adopted only for a host the person names, and never overwrites a file", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const original = await realpath(path.join(h.cwd, "team"));
  await cp(original, path.join(h.cwd, "copy"), { recursive: true });
  const copy = await realpath(path.join(h.cwd, "copy"));
  const alpha = path.join(copy, "notes/alpha.md");
  await chmod(alpha, 0o644);
  const edited = (await readFile(alpha, "utf8")).replace("Alpha body", "Alpha edited in the copy");
  await writeFile(alpha, edited);
  await rm(path.join(copy, "notes/beta.md"));
  await writeFile(path.join(copy, "notes/gamma.md"), "---\ntype: Note\ntitle: Gamma\n---\nOnly in the copy.\n");

  // A plain checkout into it names the adopt command.
  const occupied = await rejects(run(h, [BUNDLE, "--host", HOST, "--dir", copy]));
  assert.equal(occupied.details?.reason, "unbound_copy");
  assert.match(occupied.help ?? "", /checkout --adopt/);

  // Without --host, adopt only previews: the marker's host is shown, never contacted.
  const fake = fakeSyncFamily();
  const preview = await run(h, ["--adopt", copy], fake);
  assert.equal(preview.adopted, "preview");
  assert.equal(fake.requests.length, 0);
  assert.match(String((preview.help as string[])[0]), /--adopt .* --host https:\/\/hosted\.example/);
  // A host other than the marker's is refused before any request.
  const other = await rejects(run(h, ["--adopt", copy, "--host", "https://other.example"], fake));
  assert.equal(other.details?.reason, "marker_host_mismatch");
  assert.equal(fake.requests.length, 0);

  const adopted = await run(h, ["--adopt", copy, "--host", HOST], fake);
  assert.equal(adopted.adopted, "copy");
  assert.deepEqual(adopted.documents, { placed: 1, matched: 1, conflicts: 1, local_only: 1 });
  assert.deepEqual((adopted.conflicts as { ids: string[] }).ids, ["notes/alpha"]);
  assert.deepEqual((adopted.local_only as { ids: string[] }).ids, ["notes/gamma"]);
  assert.equal(await readFile(alpha, "utf8"), edited, "the differing file is kept as it is");
  assert.ok((await stat(path.join(copy, "notes/beta.md"))).isFile(), "the missing document is placed");

  const binding = await bindingForPath(h.home, copy);
  assert.ok(binding);
  assert.notEqual(binding.checkout_id, (await bindingForPath(h.home, original))?.checkout_id, "a copy gets its own store");
  // The differing file is a conflict for sync --inspect/--resolve, never a silent send.
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try {
    const projection = await readProjection(h.home, binding.checkout_id, store);
    assert.deepEqual(await folderConflicts(copy, store, projection), [{ id: "notes/alpha", reason: "changed_remotely" }]);
  } finally {
    await store.close();
  }
});

test("--adopt refuses a folder with no marker and no moved checkout", async () => {
  const h = await harness();
  await mkdir(path.join(h.cwd, "plain"));
  await writeFile(path.join(h.cwd, "plain", "index.md"), '---\nokf_version: "0.2"\n---\n');
  const error = await rejects(run(h, ["--adopt", path.join(h.cwd, "plain"), "--host", HOST]));
  assert.equal(error.code, "NOT_FOUND");
  assert.equal(error.details?.reason, "not_a_checkout_copy");
});

test("a folder matched by device and inode alone is never adopted as moved: it is treated as a copy", async () => {
  const h = await harness();
  const fake = fakeSyncFamily();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"], fake);
  const original = await realpath(path.join(h.cwd, "team"));
  const binding = await bindingForPath(h.home, original);
  assert.ok(binding);
  await cp(original, path.join(h.cwd, "restored"), { recursive: true });
  const restored = await realpath(path.join(h.cwd, "restored"));
  await rm(original, { recursive: true });
  // A filesystem with no birth time that reused the freed inode for the restore.
  const identity = await folderIdentity(restored);
  assert.ok(identity);
  await writeBinding(h.home, { ...binding, folder_identity: { dev: identity.dev, ino: identity.ino } });
  const requests = fake.requests.length;
  const receipt = await run(h, ["--adopt", restored], fake);
  assert.equal(receipt.adopted, "preview", "no rebind to the old store without a birth-time match");
  assert.equal(fake.requests.length, requests);
  assert.equal(await bindingForPath(h.home, restored), null);
});

test("a copy of a checkout that names its workspace is adopted naming it; the marker's recorded workspace never qualifies", async () => {
  const h = await harness();
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`];
  await run(h, [`south/${BUNDLE}`, "--host", HOST, "--dir", "team"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" }));
  const copy = path.join(h.cwd, "copy");
  await cp(path.join(h.cwd, "team"), copy, { recursive: true });
  const fake = fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" });
  const adopted = await run(h, ["--adopt", copy, "--host", HOST], fake);
  assert.equal(adopted.reference, `south/${BUNDLE}`);
  assert.equal((await bindingForPath(h.home, await realpath(copy)))?.workspace_slug, "south");
  // A copy of a bare checkout is adopted bare, whatever workspace its marker recorded: here the
  // id is in two workspaces, so it is refused as ambiguous rather than bound to the recorded one.
  const bareCopy = path.join(h.cwd, "bare-copy");
  await cp(copy, bareCopy, { recursive: true });
  const marker = path.join(bareCopy, ".superbee", "checkout.json");
  await chmod(marker, 0o644);
  const { workspace_slug: _, ...recorded } = JSON.parse(await readFile(marker, "utf8"));
  await writeFile(marker, JSON.stringify({ ...recorded, workspace: "tenant-b" }));
  const ambiguous = await rejects(run(h, ["--adopt", bareCopy, "--host", HOST], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed })));
  assert.equal(ambiguous.details?.reason, "ambiguous_bundle");
});

// ------------------------------------------------------------------------ catalog list --hosted

async function listHosted(h: Harness, argv: string[], fake = fakeSyncFamily()) {
  await catalog(["list", "--hosted", ...argv], { stdout: (text) => h.out.push(text), home: () => h.home, auth: h.auth, fetch: fake.fetch });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

test("catalog list --hosted lists each reachable bundle once, with the folder of a live checkout here", async () => {
  const h = await harness();
  await run(h, [BUNDLE, "--host", HOST, "--dir", "team"]);
  const folder = await realpath(path.join(h.cwd, "team"));
  const fake = fakeSyncFamily({ tenants: ["tenant-a", "tenant-b"], bundles: ["zeta.notes", BUNDLE, "shared.id", "shared.id"] });
  const receipt = await listHosted(h, ["--host", HOST], fake);
  assert.deepEqual(fake.requests.map((r) => r.path), ["/sync/v1/whoami", "/sync/v1/bundles"]);
  assert.equal(receipt.host, HOST);
  assert.equal(receipt.principal, PRINCIPAL);
  assert.deepEqual(receipt.workspaces, ["tenant-a", "tenant-b"]);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.bundles, [
    { bundle_id: "shared.id", reference: "shared.id", name: "shared.id", lifecycle: "active", folder: null, ambiguous: true },
    { bundle_id: BUNDLE, reference: BUNDLE, name: BUNDLE, lifecycle: "active", folder, ambiguous: false },
    { bundle_id: "zeta.notes", reference: "zeta.notes", name: "zeta.notes", lifecycle: "active", folder: null, ambiguous: false },
  ]);

  // A checkout of the same bundle id on another host is not this host's checkout.
  const binding = await bindingForPath(h.home, folder);
  assert.ok(binding);
  await writeBinding(h.home, { ...binding, origin: "https://other.example", audience: "https://other.example/mcp" });
  const elsewhere = await listHosted(h, ["--host", HOST], fake);
  assert.equal((elsewhere.bundles as { bundle_id: string; folder: unknown }[]).find((row) => row.bundle_id === BUNDLE)?.folder, null);
  await writeBinding(h.home, binding);

  // A checkout whose folder was deleted is not a checkout here, although its binding remains.
  await rm(folder, { recursive: true });
  const after = await listHosted(h, ["--host", HOST], fake);
  assert.equal((after.bundles as { bundle_id: string; folder: unknown }[]).find((row) => row.bundle_id === BUNDLE)?.folder, null);
});

test("catalog list --hosted lists an id two workspaces hold by each reference, with the folder that names it", async () => {
  const h = await harness();
  const listed = [`north/${BUNDLE}`, `south/${BUNDLE}`, "zeta.notes"];
  await run(h, [`south/${BUNDLE}`, "--host", HOST, "--dir", "team"], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed, slug: "south" }));
  const folder = await realpath(path.join(h.cwd, "team"));
  const receipt = await listHosted(h, ["--host", HOST], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: listed }));
  assert.deepEqual(receipt.workspaces, ["north", "south"]);
  assert.deepEqual(receipt.bundles, [
    { bundle_id: BUNDLE, reference: `north/${BUNDLE}`, name: `north/${BUNDLE}`, lifecycle: "active", folder: null, ambiguous: false },
    { bundle_id: BUNDLE, reference: `south/${BUNDLE}`, name: `south/${BUNDLE}`, lifecycle: "active", folder, ambiguous: false },
    { bundle_id: "zeta.notes", reference: "zeta.notes", name: "zeta.notes", lifecycle: "active", folder: null, ambiguous: false },
  ]);
  // Once the id is in one workspace again it is listed bare, and the checkout is still its folder.
  const single = await listHosted(h, ["--host", HOST], fakeSyncFamily({ ...TWO_WORKSPACES, bundles: [BUNDLE] }));
  assert.deepEqual((single.bundles as { folder: unknown }[]).map((row) => row.folder), [folder]);
});

test("catalog list --hosted says when the host's list stopped at its cap", async () => {
  const h = await harness();
  const ids = Array.from({ length: 100 }, (_, index) => `bundle.n${index}`);
  const receipt = await listHosted(h, ["--host", HOST], fakeSyncFamily({ bundles: ids }));
  assert.equal(receipt.count, 100);
  assert.equal(receipt.complete, false);
});

test("catalog list --hosted signs in with a resume that re-runs it, and --host is refused without --hosted", async () => {
  const h = await harness({ SUPERBEE_ACCESS_TOKEN: jwt({ ...TOKEN_CLAIMS, sub: "someone-else" }) });
  const error = await rejects(listHosted(h, ["--host", HOST, "--json"]));
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.match(String(error.details?.resume), /superbee catalog list --hosted --host https:\/\/hosted\.example --json$/);

  const fake = fakeSyncFamily();
  const usage = await rejects(catalog(["list", "--host", HOST], { stdout: () => {}, home: () => h.home, auth: h.auth, fetch: fake.fetch }));
  assert.equal(usage.code, "USAGE");
  assert.equal(fake.requests.length, 0);
});
