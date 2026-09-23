// `superbee checkout` against a fake hosted sync family that replays the host's golden transport
// fixtures (superbee-hosted `test/fixtures/hosted-transport/`, pinned byte-for-byte in core's
// `test/fixtures/hosted-transport/`). No request leaves the process: the fake is a `fetch`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode } from "@toon-format/toon";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";
import { headsDigest } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { checkout, CHECKOUT_DOCUMENT_LIMIT } from "../src/commands/checkout.js";
import { list } from "../src/commands/list.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { bindingForPath, checkoutLockName, folderIdentity, hostedCheckoutsRoot, sameFolder, writeBinding } from "../src/hosted/binding.js";
import { WORKSPACE_HEADER } from "../src/hosted/client.js";
import { hostedAuthRoot } from "../src/hosted-auth/session.js";
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
  const requests: { path: string; body: unknown; authorization: string | null; workspace: string | null }[] = [];
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
    requests.push({ path: url.pathname, body, authorization: headers.get("authorization"), workspace: headers.get(WORKSPACE_HEADER) });
    assert.equal(url.origin, HOST);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
      const refusal = fixture("refusal-unauthenticated").response;
      return new Response(refusal.body, { status: refusal.status, headers: refusal.headers });
    }
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    if (route === "whoami") {
      return Response.json({ principalId: PRINCIPAL, credentialId: "cli", tenantIds: options.tenants ?? ["tenant-a"], surface: "sync" });
    }
    if (route === "bundles") {
      const ids = options.bundles ?? [BUNDLE];
      return Response.json({
        ok: true,
        operationId: "bundles.list.v1",
        data: { bundles: ids.map((bundleId) => ({ bundleId, name: bundleId, purpose: "", domains: [], lifecycle: "active", sensitivity: "internal" })) },
      });
    }
    const raw = options.raw?.[route];
    if (raw) return new Response(raw.body, { status: raw.status, headers: raw.headers });
    const name = routes[route];
    if (!name) return Response.json({ error: "not_found" }, { status: 404 });
    assert.deepEqual(body, { bundleId: BUNDLE });
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

  assert.deepEqual(await filesUnder(folder), ["index.md", "notes/alpha.md", "notes/beta.md", "projects/2026/plan.md"]);
  const root = await readFile(path.join(folder, "index.md"), "utf8");
  assert.equal(root, '---\nokf_version: "0.2"\ntitle: Team knowledge\n---\n# Team knowledge\n');
  const alpha = await readFile(path.join(folder, "notes/alpha.md"), "utf8");
  assert.match(alpha, /^---\n/);
  assert.match(alpha, /Alpha body é\.\n$/);
  // CRLF bodies stay byte-exact.
  assert.match(await readFile(path.join(folder, "notes/beta.md"), "utf8"), /Line one\r\nLine two\r\n$/);

  // No URL and no binding file in the folder: the link lives in private state only.
  for (const file of await filesUnder(folder)) {
    assert.doesNotMatch(await readFile(path.join(folder, file), "utf8"), /hosted\.example/);
  }
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
  const refused: [string, string[]][] = [
    ["doc", ["verify", "notes/alpha", "--dir", folder]],
    ["kind", ["field", "Note", "add", "owner", "--dir", folder]],
    ["kind", ["draft", "Note", "--dir", folder]],
    ["kind", ["dismiss", "Note", "--dir", folder]],
    ["recipe", ["add", "core", "--dir", folder]],
    ["recipe", ["evolve", "core", "--dir", folder]],
    ["artifact", ["create", "x.pdf", "--title", "x", "--dir", folder]],
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
  // sync runs in a checkout (hosted sync); ui and mcp are refused because they write Views.
  await assertAllowedInHostedCheckout("sync", ["--dir", folder], context);
  assert.equal((await rejects(assertAllowedInHostedCheckout("ui", ["--dir", folder], context))).details?.do_this_in, "app");
  assert.equal((await rejects(assertAllowedInHostedCheckout("mcp", ["--dir", folder], context))).details?.do_this_in, "app");
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
  assert.equal(HOSTED_CHECKOUT_REFUSALS.length, 10);
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
  assert.equal(envelope.error.details.do_this_in, "app");
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

test("--workspace is sent on every request, and an id in two workspaces is ambiguous, not a Git source", async () => {
  const h = await harness();
  const fake = fakeSyncFamily({ tenants: ["tenant-a", "tenant-b"] });
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--workspace", "tenant-b"], fake);
  assert.equal(receipt.workspace, "tenant-b");
  assert.ok(fake.requests.every((r) => r.workspace === "tenant-b"));

  const twice = fakeSyncFamily({ tenants: ["tenant-a", "tenant-b"], bundles: [BUNDLE, BUNDLE], fixtures: { capabilities: "refusal-bundle-not-found" } });
  const error = await rejects(run(h, [BUNDLE, "--host", HOST, "--workspace", "tenant-a", "--dir", "amb"], twice));
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "ambiguous_bundle");
  assert.deepEqual(error.details?.workspaces, ["tenant-a", "tenant-b"]);
  assert.ok(!twice.requests.some((r) => r.path.endsWith("/capabilities")));
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
