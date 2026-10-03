// `superbee publish --to hosted` against the fake `bundles.create.v1` host
// (`support/fake-hosted-create.ts`, held to the golden exchanges captured from the real gateway by
// `hosted-create-fake-contract.test.ts`). No request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";

import { hostedCheckoutAt } from "../src/autopull.js";
import { bundleHomeAt } from "../src/bundle-home.js";
import { publish, bundleIdFrom } from "../src/commands/publish.js";
import { sync as gitSync } from "../src/commands/sync/orchestrate.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps, writeDefaultHost, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { seedHostedSession } from "./support/hosted-session.js";
import { bindingForPath, checkoutStoreDir } from "../src/hosted/binding.js";
import { readCheckoutMarker } from "../src/hosted/marker.js";
import { readMovedMarker } from "../src/hosted/moved-marker.js";
import { folderConflicts, folderMatchesProjection, readProjection, scanCheckout } from "../src/hosted/sync-scan.js";
import { openLocalBundle } from "@superbee/browser-local";
import { FakeCreateHost } from "./support/fake-hosted-create.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";
import { CURRENT_HOST_DOCUMENT_INPUT_BYTES } from "@superbee/core/hosted-transport";

interface Harness {
  home: string;
  cwd: string;
  auth: HostedAuthDeps;
  out: string[];
}

async function harness(): Promise<Harness> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "sb-publish-home-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-publish-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  return { home, cwd, auth, out: [] };
}

async function run(h: Harness, argv: string[], fake: FakeCreateHost): Promise<Record<string, unknown>> {
  await publish(argv, { stdout: (text) => h.out.push(text), stderr: () => {}, auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
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

const ROOT = '---\nokf_version: "0.2"\ntitle: Team notes\n---\n# Team notes\n';

async function writeBundle(folder: string): Promise<void> {
  await mkdir(path.join(folder, "notes"), { recursive: true });
  await mkdir(path.join(folder, "assets"), { recursive: true });
  await writeFile(path.join(folder, "index.md"), ROOT);
  await writeFile(path.join(folder, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nAlpha body é.\n");
  await writeFile(path.join(folder, "notes", "beta.md"), "---\ntype: Note\ntitle: Beta\n---\nLine one\r\nLine two\r\n");
  await writeFile(path.join(folder, "notes", "index.md"), "# Notes\n");
  await writeFile(path.join(folder, "assets", "logo.txt"), "logo");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function gitAs(cwd: string, args: string[], author: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "b@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } });
  assert.equal(result.status, 0, result.stderr);
}

/**
 * A copy of the host's strict request schema (superbee-hosted `src/person-bundle-create.ts`,
 * `personBundleCreateInput` at 09e577e6): the keys, types and bounds a CLI-built body must meet.
 */
function assertCreateSchema(body: Record<string, unknown>): void {
  const text = (value: unknown, max: number, min = 0) => typeof value === "string" && [...value].length >= min && value.length <= max;
  const plain = (value: unknown) => typeof value === "string" && /^[^\p{Cc}\p{Cf}]*$/u.test(value);
  const keys = (value: unknown, allowed: string[]) => typeof value === "object" && value !== null && Object.keys(value).every((key) => allowed.includes(key));
  const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
  assert.ok(keys(body, ["workspace", "bundleId", "name", "documents", "reserved", "blobs", "history"]), "only the schema's keys");
  assert.ok(body.name === undefined || (text(body.name, 200, 1) && plain(body.name)), "name");
  const documents = body.documents as unknown[];
  assert.ok(Array.isArray(documents) && documents.length <= 1000);
  for (const doc of documents) assert.ok(keys(doc, ["id", "frontmatter", "body"]) && text((doc as { id: unknown }).id, 512, 1) && record((doc as { frontmatter: unknown }).frontmatter) && typeof (doc as { body: unknown }).body === "string", JSON.stringify(doc));
  const reserved = body.reserved as { dir: unknown; name: unknown; content: unknown }[];
  assert.ok(Array.isArray(reserved) && reserved.length >= 1 && reserved.length <= 1000);
  for (const file of reserved) assert.ok(keys(file, ["dir", "name", "content"]) && text(file.dir, 512) && (file.name === "index.md" || file.name === "log.md") && typeof file.content === "string");
  const blobs = (body.blobs ?? []) as { key: unknown; contentType: unknown; base64: unknown }[];
  assert.ok(Array.isArray(blobs) && blobs.length <= 100);
  for (const blob of blobs) assert.ok(keys(blob, ["key", "contentType", "base64"]) && text(blob.key, 512, 1) && text(blob.contentType, 200, 1) && typeof blob.base64 === "string");
  const history = (body.history ?? []) as Record<string, unknown>[];
  assert.ok(Array.isArray(history) && history.length <= 1000);
  for (const row of history) {
    assert.ok(keys(row, ["documentId", "label", "author", "authoredAt", "frontmatter", "body"]), "history keys");
    assert.ok(text(row.documentId, 512, 1));
    assert.match(String(row.label), /^imported:git\/(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.ok(row.author === undefined || (typeof row.author === "string" && row.author.length <= 200 && plain(row.author)), `author ${String(row.author)}`);
    assert.ok(typeof row.authoredAt === "string" && !Number.isNaN(Date.parse(row.authoredAt)) && /(Z|[+-]\d\d:\d\d)$/.test(row.authoredAt));
    assert.ok(record(row.frontmatter) && typeof row.body === "string");
  }
}

async function checkoutState(home: string, folder: string) {
  const binding = await bindingForPath(home, folder);
  assert.ok(binding, "the folder is a hosted checkout");
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id) });
  try {
    const projection = await readProjection(home, binding.checkout_id, store);
    const scan = await scanCheckout({ folder, bundleId: binding.bundle_id, okfVersion: "0.2", local: openLocalBundle(binding.checkout_id, { backend: store }), projection, preview: true });
    return { binding, matches: await folderMatchesProjection(folder, projection), conflicts: await folderConflicts(folder, store, projection), held: scan.held, pending: scan.pending };
  } finally {
    await store.close();
  }
}

test("bundle ids come from the bundle's name", () => {
  assert.equal(bundleIdFrom("Team notes"), "team-notes");
  assert.equal(bundleIdFrom("2026 Plans!"), "bundle-2026-plans");
  assert.equal(bundleIdFrom("Équipe"), "equipe");
});

test("the preview makes no request and lists what travels, what stays, and the next command", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  await writeFile(path.join(folder, ".hidden"), "x");
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(fake.requests.length, 0, "a preview is offline");
  assert.equal(preview.publish, "preview");
  assert.equal(preview.ready, true);
  assert.equal(preview.home, "local");
  assert.deepEqual(preview.travels, {
    documents: 2,
    reserved_files: 2,
    other_files: 1,
    sent: "one request",
    history: { mode: "current-only", versions: 0, note: "history starts at publish" },
  });
  assert.equal((preview.stays as { total: number }).total, 1);
  assert.equal((preview.to as Record<string, unknown>).bundle_id, "team-notes");
  assert.match(String((preview.help as string[])[0]), /publish --to hosted --dir .* --host https:\/\/hosted\.example --bundle-id team-notes --yes$/);
  // Sharing is named as a command an agent can run, with the app as the other way.
  assert.match(String((preview.then as string[])[0]), /until you share it: .*access grant team-notes <email> --level write --host https:\/\/hosted\.example, or in the app$/);
  assert.equal(await bindingForPath(h.home, folder), null);
});

test("--to is required and names the one destination", async () => {
  const h = await harness();
  const error = await rejects(run(h, ["--to", "git"], new FakeCreateHost()));
  assert.equal(error.code, "USAGE");
  assert.match(error.help ?? "", /publish --to hosted/);
});

test("a host that names workspaces: the new checkout names its bundle in the workspace it was created in", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  const fake = new FakeCreateHost({ workspaces: [{ tenantId: "tenant:a", slug: "north" }] });
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake);
  assert.equal(receipt.published, "created");
  const binding = (await bindingForPath(h.home, await realpath(folder)))!;
  assert.equal(binding.bundle_id, "team-notes");
  assert.equal(binding.workspace_slug, "north");
  assert.match(String(receipt.access), /access grant north\/team-notes <email> --level write --host https:\/\/hosted\.example, or in the app\)$/);
  assert.equal(readCheckoutMarker(folder)?.workspace_slug, "north");
  // Every read after the creation names the bundle in that workspace.
  const after = fake.requests.slice(fake.requests.findIndex((r) => r.path.endsWith("/bundle-create")) + 1);
  for (const request of after.filter((r) => r.body.bundleId !== undefined)) assert.equal(request.body.bundleId, "north/team-notes", request.path);
  assert.ok(after.some((r) => r.path.endsWith("/snapshot")));
});

test("--yes creates the bundle and converts the folder in place, rewriting nothing", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  const before = await readFile(path.join(folder, "notes", "alpha.md"));
  const fake = new FakeCreateHost();
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake);
  assert.equal(receipt.published, "created");
  assert.equal(receipt.bundle_id, "team-notes");
  assert.equal(receipt.workspace, "tenant:a");
  assert.match(String(receipt.access), /^write \(only you, until you share it: .*access grant team-notes <email> --level write --host https:\/\/hosted\.example, or in the app\)$/);
  assert.deepEqual(receipt.sent, { documents: 2, reserved_files: 2, other_files: 1, history: { imported: 0, verified: false } });
  assert.deepEqual(receipt.checkout, { matched: 2, placed: 0, conflicts: 0, local_only: 0 });
  // One creation request, identified, carrying the whole bundle.
  assert.equal(fake.creates.length, 1);
  assertCreateSchema(fake.creates[0]!.body);
  const sent = fake.creates[0]!.body as { documents: { id: string }[]; reserved: { dir: string; name: string }[]; blobs: { key: string }[] };
  assert.deepEqual(sent.documents.map((doc) => doc.id).sort(), ["notes/alpha", "notes/beta"]);
  assert.deepEqual(sent.reserved.map((r) => `${r.dir}/${r.name}`).sort(), ["/index.md", "notes/index.md"]);
  assert.deepEqual(sent.blobs.map((b) => b.key), ["assets/logo.txt"]);
  // The folder is now a hosted checkout, unchanged except for the marker.
  assert.deepEqual(await readFile(path.join(folder, "notes", "alpha.md")), before);
  assert.equal((await bundleHomeAt(folder, { home: h.home })).home, "hosted");
  assert.equal(readCheckoutMarker(folder)?.bundle_id, "team-notes");
  // Nothing to send and nothing held: the reserved file and the blob the host already has are left be.
  const state = await checkoutState(h.home, folder);
  assert.equal(state.matches, true);
  assert.deepEqual(state.conflicts, []);
  assert.deepEqual(state.held, []);
  assert.deepEqual(state.pending, []);
  // Once the blob is edited, sync holds it like any file it cannot send.
  await writeFile(path.join(folder, "assets", "logo.txt"), "logo v2");
  assert.deepEqual((await checkoutState(h.home, folder)).held.map((row) => row.reason), ["not_a_document"]);
  // Publishing again is refused: it is already hosted.
  const again = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake));
  assert.equal(again.details?.reason, "already_hosted");
});

test("signed in to two hosts, publish without --host previews a blocker and refuses --yes; it never follows the last sign-in", async () => {
  const OTHER = "https://other-host.example";
  const h = await harness();
  await seedHostedSession(h.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  await seedHostedSession(h.home, { host: OTHER, accessToken: "other-token", expiresAtMs: Date.now() + 3_600_000 });
  await writeDefaultHost(h.home, OTHER);
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  const fake = new FakeCreateHost();

  const preview = await run(h, ["--to", "hosted", "--dir", folder], fake);
  assert.equal(preview.ready, false);
  assert.equal((preview.to as Record<string, unknown>).host, null);
  assert.deepEqual((preview.to as Record<string, unknown>).signed_in_hosts, [HOST, OTHER]);
  assert.ok(JSON.stringify(preview.blockers).includes("ambiguous_host"));
  const help = preview.help as string[];
  assert.equal(help.length, 2);
  assert.ok(help.every((command) => command.includes("--host ") && command.includes("--yes")), help.join("\n"));

  const error = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--yes"], fake));
  assert.equal(error.code, "USAGE");
  assert.equal(error.details?.reason, "ambiguous_host");
  assert.deepEqual(error.details?.hosts, [HOST, OTHER]);
  assert.equal(fake.requests.length, 0, "nothing is sent to either host");
  assert.equal(await bindingForPath(h.home, folder), null);

  // Named, it goes to the host named, and says so before sending.
  const stderr: string[] = [];
  await publish(["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], { stdout: (text) => h.out.push(text), stderr: (text) => stderr.push(text), auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
  const receipt = decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
  assert.equal(receipt.host, HOST);
  assert.equal(receipt.host_from, "flag");
  assert.match(stderr[0] ?? "", new RegExp(`^publish: creating 'team-notes' on ${HOST.replace(/[.]/g, "\\.")} \\(host from --host\\)\\n$`));
});

test("one host signed in: publish --yes without --host uses it and names it before sending", async () => {
  const h = await harness();
  await seedHostedSession(h.home, { host: HOST, accessToken: TOKEN, expiresAtMs: Date.now() + 3_600_000 });
  await writeDefaultHost(h.home, HOST);
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  const fake = new FakeCreateHost();
  const stderr: string[] = [];
  await publish(["--to", "hosted", "--dir", folder, "--yes", "--json"], { stdout: (text) => h.out.push(text), stderr: (text) => stderr.push(text), auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
  const receipt = JSON.parse(h.out.at(-1)!) as Record<string, unknown>;
  assert.equal(receipt.published, "created");
  assert.equal(receipt.host, HOST);
  assert.equal(receipt.host_from, "last-sign-in");
  assert.deepEqual(JSON.parse(stderr[0]!), { event: "publish.target", host: HOST, host_from: "last-sign-in", bundle_id: "team-notes" });
});

test("an unknown outcome is TRANSIENT, and the retry re-sends the same request", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  const fake = new FakeCreateHost();
  fake.failNextCreate = true;
  const argv = ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "team.notes", "--yes"];
  const unknown = await rejects(run(h, argv, fake));
  assert.equal(unknown.code, "TRANSIENT");
  assert.equal(unknown.details?.reason, "write_outcome_unknown");
  assert.equal(await bindingForPath(h.home, folder), null);
  const receipt = await run(h, argv, fake);
  assert.equal(receipt.published, "created");
  assert.equal(fake.creates.length, 2);
  assert.equal(fake.creates[0]!.requestId, fake.creates[1]!.requestId, "the same request id finishes the one creation");
});

test("host refusals map to the CLI taxonomy, and nothing in the folder changes", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  const taken = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "held.id", "--yes"], new FakeCreateHost({ taken: ["held.id"] })));
  assert.equal(taken.code, "ALREADY_EXISTS");
  assert.match(taken.help ?? "", /--bundle-id <another id>/);
  const limit = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], new FakeCreateHost({ limit: 0 })));
  assert.equal(limit.code, "FORBIDDEN");
  assert.equal(limit.details?.reason, "bundle_create_limit");
  const off = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], new FakeCreateHost({ unavailable: true })));
  assert.equal(off.details?.reason, "bundle_create_unavailable");
  assert.equal(readCheckoutMarker(folder), null);
  assert.equal(await bindingForPath(h.home, folder), null);
});

test("a document the host would refuse blocks the preview and --yes, before any request", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  await writeFile(path.join(folder, "notes", "huge.md"), `---\ntype: Note\n---\n${"x".repeat(CURRENT_HOST_DOCUMENT_INPUT_BYTES)}\n`);
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(preview.ready, false);
  assert.equal((preview.blockers as { rows: { path: string }[] }).rows[0]!.path, "notes/huge.md");
  const error = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake));
  assert.equal(error.details?.reason, "blocked");
  assert.equal(fake.requests.length, 0);
});

test("a document over 64 KiB publishes to a host that states the larger bound, and is refused before creation by one that states none", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  await writeFile(path.join(folder, "notes", "long.md"), `---\ntype: Note\n---\n${"x".repeat(70 * 1024)}\n`);
  const old = new FakeCreateHost({ documentInputBytes: null });
  const error = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], old));
  assert.equal(error.details?.reason, "blocked");
  assert.match(error.message, /accepts up to 64 KiB/);
  assert.equal(old.creates.length, 0, "nothing is created on a host that would refuse it");
  const current = new FakeCreateHost();
  await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], current);
  assert.equal(current.creates.length, 1);
});

test("a document that does not satisfy its Kind, or a Kind convention with a problem, blocks before any request", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  await mkdir(path.join(folder, "conventions"), { recursive: true });
  await mkdir(path.join(folder, "tasks"), { recursive: true });
  const task = "---\ntype: Convention\ngoverns: Task\nfields:\n  required:\n    - owner\n    - actor\n    - timestamp\n---\n# Task\n";
  await writeFile(path.join(folder, "conventions", "task.md"), task);
  // A write supplies the actor and the timestamp, so lacking only those is not a blocker.
  await writeFile(path.join(folder, "tasks", "ready.md"), "---\ntype: Task\ntitle: Ready\nowner: ada\n---\nx\n");
  const fake = new FakeCreateHost();
  const clean = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(clean.ready, true, JSON.stringify(clean.blockers));

  await writeFile(path.join(folder, "tasks", "unowned.md"), "---\ntype: Task\ntitle: Unowned\n---\nx\n");
  // A malformed standard field an edit leaves alone does not hide the Kind problem behind it.
  await writeFile(path.join(folder, "tasks", "numeric.md"), "---\ntype: Task\ntitle: 5\n---\nx\n");
  await writeFile(path.join(folder, "conventions", "broken.md"), "---\ntype: Convention\n---\n# No governs\n");
  await writeFile(path.join(folder, "conventions", "task-again.md"), task);
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(preview.ready, false);
  const rows = (preview.blockers as { rows: { path: string; reason: string; message: string }[] }).rows;
  assert.deepEqual(
    rows.map((row) => [row.reason, row.path]),
    [
      ["kind_convention", "conventions/broken.md"],
      ["kind_convention", "conventions/"],
      ["kind_conformance", "tasks/numeric.md"],
      ["kind_conformance", "tasks/unowned.md"],
    ],
  );
  assert.match(rows[3]!.message, /'tasks\/unowned' does not satisfy the 'Task' kind: .*owner/);
  const error = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake));
  assert.equal(error.details?.reason, "blocked");
  assert.equal(error.details?.blockers_total, 4);

  // An OKF 0.1 bundle: a write supplies the timestamp and actor there too.
  await writeFile(path.join(folder, "index.md"), "---\ntitle: Team notes\n---\n# Team notes\n");
  const v01 = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.deepEqual(
    (v01.blockers as { rows: { path: string; reason: string }[] }).rows.filter((row) => row.reason === "kind_conformance").map((row) => row.path),
    ["tasks/numeric.md", "tasks/unowned.md"],
  );
  // An edition no hosted write can use blocks on the root index.
  await writeFile(path.join(folder, "index.md"), '---\nokf_version: "0.3"\n---\n# Team notes\n');
  const edition = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.deepEqual(
    (edition.blockers as { rows: { path: string; reason: string }[] }).rows.filter((row) => row.path === "index.md").map((row) => row.reason),
    ["unsupported_okf_version"],
  );
  assert.equal(fake.requests.length, 0);
});

test("an id the host's canonical spelling refuses blocks before any request; a joiner between visible characters does not", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  const refused = ["notes/zero\u200bwidth.md", "notes/\u200bedge.md", "notes/edge\u2060.md", "notes/a\u202eb.md", "notes/nai\u0308ve.md"];
  for (const rel of refused) await writeFile(path.join(folder, rel), "---\ntype: Note\n---\nx\n");
  await writeFile(path.join(folder, "notes", "\u{1f469}\u200d\u{1f4bb}.md"), "---\ntype: Note\n---\nx\n");
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(preview.ready, false);
  const rows = (preview.blockers as { rows: { path: string; reason: string }[] }).rows;
  // A filesystem may hand back the decomposed spelling as it was written; compare as written.
  assert.deepEqual(rows.map((row) => row.reason), refused.map(() => "document_id_not_canonical"), JSON.stringify(rows));
  assert.deepEqual(new Set(rows.map((row) => row.path)), new Set(refused));
  assert.equal(fake.requests.length, 0);
});

test("a Git board is published with its history, unbound, and its branch left as it was", async () => {
  const h = await harness();
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  await writeFile(path.join(board, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nAlpha v0.\n");
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v0"]);
  await writeFile(path.join(board, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nAlpha v1.\n");
  gitAs(board, ["commit", "-q", "-am", "v1"], "😀".repeat(150));
  await writeFile(path.join(board, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nAlpha body é.\n");
  git(board, ["commit", "-q", "-am", "v2"]);
  const head = git(board, ["rev-parse", "HEAD"]);
  const canonical = await realpath(board);
  assert.equal((await bundleHomeAt(canonical, { home: h.home })).home, "git");

  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", canonical, "--host", HOST, "--with-history"], fake);
  assert.equal(preview.home, "git");
  assert.equal((preview.travels as { history: { mode: string; versions: number } }).history.versions, 2);
  assert.equal((preview.git as Record<string, unknown>).head, head);

  const receipt = await run(h, ["--to", "hosted", "--dir", canonical, "--host", HOST, "--bundle-id", "team.board", "--with-history", "--yes"], fake);
  assert.equal(receipt.published, "created");
  assert.deepEqual(receipt.sent, { documents: 2, reserved_files: 2, other_files: 1, history: { imported: 2, verified: false } });
  const body = fake.creates[0]!.body;
  assertCreateSchema(body);
  const history = (body as { history: { documentId: string; label: string; author: string; body: string }[] }).history;
  // Oldest first, as the host numbers them.
  assert.deepEqual(history.map((row) => row.body), ["Alpha v0.\n", "Alpha v1.\n"]);
  assert.equal(history[0]!.documentId, "notes/alpha");
  assert.match(history[0]!.label, /^imported:git\/[0-9a-f]{40}$/);
  assert.equal(history[0]!.author, "Ada <ada@example.com>");
  assert.equal(history[1]!.author.length, 200, "an author is cut to the host's 200 UTF-16 units");
  assert.equal(history[1]!.author, "😀".repeat(100), "never half a surrogate pair");
  const unbound = receipt.git as Record<string, unknown>;
  assert.equal(unbound.unbound, true);
  assert.equal(unbound.head, head);
  // The folder is no longer a worktree. A board never shared on origin has no teammates to stop:
  // no marker, and the branch and its commit are untouched.
  await assert.rejects(stat(path.join(canonical, ".git")));
  assert.equal(git(project, ["rev-parse", "board"]), head);
  assert.match(String(unbound.moved_marker), /no shared board branch/);
  assert.equal(unbound.recovery, undefined);
  assert.doesNotMatch(git(project, ["worktree", "list"]), /\.superbee/);
  assert.equal((await bundleHomeAt(canonical, { home: h.home })).home, "hosted");
  const state = await checkoutState(h.home, canonical);
  assert.equal(state.matches, true);
  // Hooks and reads run from the project root find the published board as the hosted checkout.
  assert.equal((await hostedCheckoutAt(project, h.home))?.bundle_id, "team.board");
});

test("a moved board: publish pushes the marker, and a teammate's sync then refuses to push and names the checkout", async () => {
  const h = await harness();
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  git(project, ["remote", "add", "origin", remote]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v1"]);
  git(board, ["push", "-q", "-u", "origin", "board"]);
  const teammate = path.join(h.cwd, "teammate");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, teammate]);

  const receipt = await run(h, ["--to", "hosted", "--dir", await realpath(board), "--host", HOST, "--bundle-id", "team.board", "--yes"], new FakeCreateHost({ email: "mover@example.com" }));
  assert.equal(receipt.published, "created");
  assert.match(String((receipt.git as Record<string, unknown>).moved_marker), /committed and pushed/);
  const marker = JSON.parse(git(remote, ["show", "board:.superbee-moved-to-hosted.json"])) as Record<string, unknown>;
  assert.equal(marker.bundle, "team.board");
  assert.equal(marker.moved_by, "mover@example.com", "the marker names who moved the board");
  // Teammates reach the bundle only once it is shared: that is the first next step.
  assert.match(String((receipt.help as string[])[0]), /access grant team\.board <email> --level write --host /);

  // The teammate edits and syncs: the pull brings the marker, and nothing is pushed.
  await writeFile(path.join(teammate, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nTeammate edit.\n");
  const before = git(remote, ["rev-parse", "board"]);
  const error = await rejects(gitSync(["--dir", teammate, "--json"], { stdout: () => {}, stderr: () => {} }));
  assert.equal(error.details?.reason, "board_moved", `${error.code} ${error.message} ${JSON.stringify(error.details)}`);
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.bundle, "team.board");
  assert.match(error.help ?? "", /checkout team\.board --host /);
  assert.match(error.help ?? "", /if checkout says not found, ask mover@example\.com to share it: .*access grant team\.board <your email> --level write --host /);
  assert.equal(git(remote, ["rev-parse", "board"]), before, "nothing reached the board");
  // A second sync refuses before committing anything else.
  const again = await rejects(gitSync(["--dir", teammate, "--json"], { stdout: () => {}, stderr: () => {} }));
  assert.equal(again.details?.reason, "board_moved", `${again.code} ${again.message} ${JSON.stringify(again.details)}`);
  assert.equal(git(remote, ["rev-parse", "board"]), before);

  // A teammate whose board is a project's worktree (sync run from the project) is refused the same way.
  const project2 = path.join(h.cwd, "project2");
  git(h.cwd, ["clone", "-q", "--no-checkout", remote, project2]);
  git(project2, ["worktree", "add", "-q", path.join(project2, ".superbee"), "board"]);
  const owner = await rejects(gitSync(["--dir", project2, "--json"], { stdout: () => {}, stderr: () => {} }));
  assert.equal(owner.details?.reason, "board_moved", `${owner.code} ${owner.message} ${JSON.stringify(owner.details)}`);
  // ... but a pull-only sync never pushes, so it is not refused.
  await gitSync(["--dir", project2, "--pull-only", "--json"], { stdout: () => {}, stderr: () => {} });

  // Moving back: the publisher reverts the marker commit on the branch and pushes it. The teammate
  // with a local commit syncs as usual: origin no longer carries the marker, so their commit is
  // replayed onto the revert and pushed. The other pulls the revert in with a pull-only sync.
  const mover = path.join(h.cwd, "mover");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, mover]);
  git(mover, ["revert", "--no-edit", "HEAD"]);
  await writeFile(path.join(mover, "notes", "beta.md"), "---\ntype: Note\ntitle: Beta\n---\nMoved back.\n");
  git(mover, ["commit", "-q", "-am", "beta after the move back"]);
  git(mover, ["push", "-q", "origin", "board"]);
  const back: string[] = [];
  await gitSync(["--dir", teammate, "--json"], { stdout: (text) => void back.push(text), stderr: () => {} });
  // The entry check's fetch brought the move back in; the receipt still counts it as incoming.
  assert.match(back.join(""), /notes\/beta/, back.join(""));
  await assert.rejects(stat(path.join(teammate, ".superbee-moved-to-hosted.json")), "the revert removed the marker");
  assert.match(git(remote, ["show", "board:notes/alpha.md"]), /Teammate edit\./, "the teammate's edit reached the board again");
  // A project worktree's sync records no origin baseline while provisioning: the one taken before
  // the entry check's fetch is what lets its receipt count the move back as incoming.
  const owned: string[] = [];
  await gitSync(["--dir", project2, "--json"], { stdout: (text) => void owned.push(text), stderr: () => {} });
  await assert.rejects(stat(path.join(project2, ".superbee", ".superbee-moved-to-hosted.json")));
  assert.match(owned.join(""), /notes\/beta/, owned.join(""));
});

test("an unreadable moved marker still marks the board as moved: garbage, oversized, a link or a folder", async () => {
  const h = await harness();
  const root = path.join(h.cwd, "marker");
  await mkdir(root);
  const file = path.join(root, ".superbee-moved-to-hosted.json");
  assert.equal(readMovedMarker(root), null);
  await writeFile(file, JSON.stringify({ superbee_moved_to_hosted: 1, host: "https://hosted.example", bundle: "team.board", moved_at: "2026-10-03T00:00:00.000Z", moved_by: "a@example.com" }));
  assert.deepEqual(readMovedMarker(root), { host: "https://hosted.example", bundle: "team.board", moved_at: "2026-10-03T00:00:00.000Z", moved_by: "a@example.com" });
  await writeFile(file, "not json");
  assert.deepEqual(readMovedMarker(root), { unreadable: true });
  await writeFile(file, `{"pad":"${"x".repeat(5000)}"}`);
  assert.deepEqual(readMovedMarker(root), { unreadable: true });
  await rm(file);
  await writeFile(path.join(root, "elsewhere.json"), JSON.stringify({ superbee_moved_to_hosted: 1, host: "h", bundle: "b", moved_at: "t" }));
  await symlink(path.join(root, "elsewhere.json"), file);
  assert.deepEqual(readMovedMarker(root), { unreadable: true }, "a link is never followed");
  await rm(file);
  await mkdir(file);
  assert.deepEqual(readMovedMarker(root), { unreadable: true });

  // A board clone carrying an unreadable marker: sync refuses and names no checkout.
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const seed = path.join(h.cwd, "seed");
  await mkdir(seed);
  git(seed, ["init", "-q", "-b", "board"]);
  await writeBundle(seed);
  await writeFile(path.join(seed, ".superbee-moved-to-hosted.json"), "{ broken");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "v1"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "-u", "origin", "board"]);
  const clone = path.join(h.cwd, "clone");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, clone]);
  const error = await rejects(gitSync(["--dir", clone, "--json"], { stdout: () => {}, stderr: () => {} }));
  assert.equal(error.details?.reason, "board_moved", `${error.code} ${error.message}`);
  assert.equal(error.details?.marker, "unreadable");
  assert.match(error.help ?? "", /is unreadable/);
});

/** A project with a board worktree pushed to a bare origin, and a teammate's clone of it. */
async function sharedBoard(h: Harness): Promise<{ remote: string; project: string; board: string }> {
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  git(project, ["remote", "add", "origin", remote]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v1"]);
  git(board, ["push", "-q", "-u", "origin", "board"]);
  return { remote, project, board: await realpath(board) };
}

test("a marker push origin refuses (a protected branch) names lifting the rule, and the push", async () => {
  const h = await harness();
  const { remote, project, board } = await sharedBoard(h);
  await writeFile(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho protected >&2\nexit 1\n", { mode: 0o755 });
  const receipt = await run(h, ["--to", "hosted", "--dir", board, "--host", HOST, "--bundle-id", "team.board", "--yes"], new FakeCreateHost());
  const unbound = receipt.git as { moved_marker: string; recovery: string[] };
  assert.match(unbound.moved_marker, /origin refused the push \(a branch protection rule or server hook/);
  assert.match(unbound.moved_marker, /lift the rule/);
  assert.deepEqual(unbound.recovery, [`git -C ${await realpath(project)} push origin board`]);
});

test("a moved marker that cannot be committed is removed again, and the board is left clean", async () => {
  const h = await harness();
  const { project, board } = await sharedBoard(h);
  const head = git(board, ["rev-parse", "HEAD"]);
  // Another Git process holds the worktree's index: the marker's git add fails.
  await writeFile(path.join(git(board, ["rev-parse", "--absolute-git-dir"]), "index.lock"), "");
  const receipt = await run(h, ["--to", "hosted", "--dir", board, "--host", HOST, "--bundle-id", "team.board", "--yes"], new FakeCreateHost());
  assert.equal(receipt.published, "created");
  assert.match(String((receipt.git as Record<string, unknown>).moved_marker), /^could not write the moved marker/);
  await assert.rejects(stat(path.join(board, ".superbee-moved-to-hosted.json")), "the marker file was removed again");
  assert.equal(git(project, ["rev-parse", "board"]), head, "no marker commit");
  assert.equal(git(project, ["status", "--porcelain"]), "");
});

test("a marker committed here but never pushed: sync refuses, naming the push that finishes the move", async () => {
  const h = await harness();
  const { remote } = await sharedBoard(h);
  const clone = path.join(h.cwd, "clone");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, clone]);
  await writeFile(path.join(clone, ".superbee-moved-to-hosted.json"), JSON.stringify({ superbee_moved_to_hosted: 1, host: HOST, bundle: "team.board", moved_at: "2026-10-03T00:00:00.000Z" }));
  git(clone, ["add", "--force", ".superbee-moved-to-hosted.json"]);
  git(clone, ["commit", "-q", "-m", "moved"]);
  const before = git(remote, ["rev-parse", "board"]);
  const error = await rejects(gitSync(["--dir", clone, "--json"], { stdout: () => {}, stderr: () => {} }));
  assert.equal(error.details?.reason, "board_moved", `${error.code} ${error.message}`);
  assert.match(String(error.details?.marker_unpushed), /never reached origin.*git -C .*clone push origin board$/);
  assert.equal(git(remote, ["rev-parse", "board"]), before, "sync did not push the marker for them");
});

test("a board with origin but never pushed there gets no marker, and nothing is pushed", async () => {
  const h = await harness();
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "-q", "origin", "main"]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v1"]);
  const head = git(board, ["rev-parse", "HEAD"]);

  const receipt = await run(h, ["--to", "hosted", "--dir", await realpath(board), "--host", HOST, "--bundle-id", "team.board", "--yes"], new FakeCreateHost());
  assert.equal(receipt.published, "created");
  assert.match(String((receipt.git as Record<string, unknown>).moved_marker), /no shared board branch \(no origin\/board\): no teammates to stop/);
  assert.equal(git(project, ["ls-remote", "origin", "board"]), "", "the board branch was never pushed");
  assert.equal(git(project, ["rev-parse", "board"]), head, "no marker commit");
});

test("a teammate's push between the upload and the marker push: rejected, named, and the recovery commands finish it", async () => {
  const h = await harness();
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  git(project, ["remote", "add", "origin", remote]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v1"]);
  git(board, ["push", "-q", "-u", "origin", "board"]);
  const teammate = path.join(h.cwd, "teammate");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, teammate]);

  const fake = new FakeCreateHost();
  // The teammate pushes while the bundle is being uploaded: after publish's snapshot and fetch.
  fake.onRequest = (route) => {
    if (route !== "bundle-create") return;
    writeFileSync(path.join(teammate, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nRaced edit.\n");
    git(teammate, ["commit", "-q", "-am", "raced"]);
    git(teammate, ["push", "-q", "origin", "board"]);
  };
  const receipt = await run(h, ["--to", "hosted", "--dir", await realpath(board), "--host", HOST, "--bundle-id", "team.board", "--yes"], fake);
  assert.equal(receipt.published, "created");
  const unbound = receipt.git as { moved_marker: string; recovery: string[] };
  assert.match(unbound.moved_marker, /push was rejected: a teammate pushed to the board after your snapshot/);
  const top = await realpath(project);
  assert.equal(unbound.recovery[1], `git -C ${top} log board..origin/board`);
  assert.equal(unbound.recovery.length, 6);
  assert.match(unbound.recovery[2]!, /worktree add .*-board-marker board$/);
  assert.equal((await bundleHomeAt(await realpath(board), { home: h.home })).home, "hosted", "the folder was converted before the push");
  assert.doesNotMatch(git(remote, ["ls-tree", "--name-only", "board"]), /moved-to-hosted/, "the rejected marker is not on origin");

  // The recovery commands, run as printed, put the marker on top of the teammate's commit.
  for (const command of unbound.recovery) {
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  assert.match(git(remote, ["show", "board:.superbee-moved-to-hosted.json"]), /"bundle": "team.board"/);
  assert.match(git(remote, ["show", "board:notes/alpha.md"]), /Raced edit\./);
});

test("a board behind its upstream is a blocker until synced", async () => {
  const h = await harness();
  const remote = path.join(h.cwd, "remote.git");
  git(h.cwd, ["init", "-q", "--bare", remote]);
  const project = path.join(h.cwd, "project");
  await mkdir(project);
  git(project, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(project, ".gitignore"), ".superbee/\n");
  git(project, ["add", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "project"]);
  git(project, ["remote", "add", "origin", remote]);
  const board = path.join(project, ".superbee");
  git(project, ["worktree", "add", "-q", "--detach", board]);
  git(board, ["checkout", "-q", "--orphan", "board"]);
  git(board, ["rm", "-q", "-rf", "--ignore-unmatch", "."]);
  await writeBundle(board);
  git(board, ["add", "."]);
  git(board, ["commit", "-q", "-m", "v1"]);
  git(board, ["push", "-q", "-u", "origin", "board"]);
  // A teammate's commit on origin, fetched but not pulled.
  const other = path.join(h.cwd, "other");
  git(h.cwd, ["clone", "-q", "-b", "board", remote, other]);
  await writeFile(path.join(other, "notes", "gamma.md"), "---\ntype: Note\n---\nGamma.\n");
  git(other, ["add", "."]);
  git(other, ["commit", "-q", "-m", "teammate"]);
  git(other, ["push", "-q", "origin", "board"]);
  git(board, ["fetch", "-q", "origin"]);
  const preview = await run(h, ["--to", "hosted", "--dir", await realpath(board), "--host", HOST], new FakeCreateHost());
  assert.equal(preview.ready, false);
  assert.equal((preview.blockers as { rows: { reason: string }[] }).rows[0]!.reason, "board_behind");
  const fake = new FakeCreateHost();
  const error = await rejects(run(h, ["--to", "hosted", "--dir", await realpath(board), "--host", HOST, "--yes"], fake));
  assert.equal(fake.requests.length, 0);
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "board_behind");
  assert.match(error.help ?? "", /sync --dir/);
  // A clone of the board branch (its .git a repository) is refused before any request: publish
  // could not unbind it, and deleting its .git would lose the repository.
  const cloneFake = new FakeCreateHost();
  const clone = await rejects(run(h, ["--to", "hosted", "--dir", await realpath(other), "--host", HOST, "--yes"], cloneFake));
  assert.equal(clone.code, "FORBIDDEN");
  assert.equal(clone.details?.reason, "board_clone");
  assert.equal(cloneFake.requests.length, 0);
  assert.doesNotMatch(clone.help ?? "", /delete/);
});

test("an unfinished creation keeps its request id when the files change: the host says request_conflict", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  const fake = new FakeCreateHost();
  fake.failNextCreate = true;
  const argv = ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "team.notes", "--yes"];
  assert.equal((await rejects(run(h, argv, fake))).code, "TRANSIENT");
  await writeFile(path.join(folder, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nChanged meanwhile.\n");
  const conflict = await rejects(run(h, argv, fake));
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.details?.reason, "request_conflict");
  assert.equal(fake.creates[1]!.requestId, fake.creates[0]!.requestId, "never a second request holding the id");
  assert.match(conflict.help ?? "", /checkout --adopt/);
  // Putting the files back finishes the one creation.
  await writeFile(path.join(folder, "notes", "alpha.md"), "---\ntype: Note\ntitle: Alpha\n---\nAlpha body é.\n");
  assert.equal((await run(h, argv, fake)).published, "created");
  assert.equal(fake.creates[2]!.requestId, fake.creates[0]!.requestId);
});

test("a conversion that fails after the creation is finished by checkout --adopt, extras included", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "b");
  await writeBundle(folder);
  const fake = new FakeCreateHost();
  fake.hideCreated = true;
  const failed = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "team.notes", "--yes"], fake));
  assert.equal(failed.details?.reason, "bind_failed");
  assert.match(failed.help ?? "", /checkout --adopt .* --host https:\/\/hosted\.example/);
  assert.equal(readCheckoutMarker(folder)?.bundle_id, "team.notes", "the marker went in first");
  fake.hideCreated = false;
  const { checkout } = await import("../src/commands/checkout.js");
  const out: string[] = [];
  await checkout(["--adopt", folder, "--host", HOST], { stdout: (text) => out.push(text), auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
  assert.equal((decode(out.at(-1)!.trim()) as Record<string, unknown>).adopted, "copy");
  const state = await checkoutState(h.home, folder);
  assert.deepEqual(state.held, [], "the blob and nested index publish sent are not held");
  assert.deepEqual(state.pending, []);
});

test("publish with no host names the sign-in: USAGE with a token set, AUTH_REQUIRED not_signed_in on a first run, never a picked host", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "notes-bundle");
  await writeBundle(folder);
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder], fake);
  assert.equal(preview.ready, false);
  assert.match(JSON.stringify(preview.blockers), /no_host/);
  assert.match(String((preview.help as string[])[0]), /superbee login --host https:\/\/mcp\.getsuperbee\.com$/);
  const withToken = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--yes"], fake));
  assert.equal(withToken.code, "USAGE");
  assert.match(withToken.message, /SUPERBEE_ACCESS_TOKEN alone never chooses the host/);
  const firstRun = { ...h, auth: { ...h.auth, env: {} } };
  const notSignedIn = await rejects(run(firstRun, ["--to", "hosted", "--dir", folder, "--yes"], fake));
  assert.equal(notSignedIn.code, "AUTH_REQUIRED");
  assert.equal(notSignedIn.details?.status, "not_signed_in");
  assert.equal(fake.requests.length, 0, "nothing is sent without a host");
});
