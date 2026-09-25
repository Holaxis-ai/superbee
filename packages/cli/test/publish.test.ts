// `superbee publish --to hosted` against the fake `bundles.create.v1` host
// (`support/fake-hosted-create.ts`, held to the golden exchanges captured from the real gateway by
// `hosted-create-fake-contract.test.ts`). No request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";

import { hostedCheckoutAt } from "../src/autopull.js";
import { bundleHomeAt } from "../src/bundle-home.js";
import { publish, bundleIdFrom } from "../src/commands/publish.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath, checkoutStoreDir } from "../src/hosted/binding.js";
import { readCheckoutMarker } from "../src/hosted/marker.js";
import { folderConflicts, folderMatchesProjection, readProjection, scanCheckout } from "../src/hosted/sync-scan.js";
import { openLocalBundle } from "@superbee/browser-local";
import { FakeCreateHost } from "./support/fake-hosted-create.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";

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
  await publish(argv, { stdout: (text) => h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: fake.fetch });
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
    history: { mode: "current-only", versions: 0, note: "history starts at publish" },
  });
  assert.equal((preview.stays as { total: number }).total, 1);
  assert.equal((preview.to as Record<string, unknown>).bundle_id, "team-notes");
  assert.match(String((preview.help as string[])[0]), /publish --to hosted --dir .* --host https:\/\/hosted\.example --bundle-id team-notes --yes$/);
  assert.equal(await bindingForPath(h.home, folder), null);
});

test("--to is required and names the one destination", async () => {
  const h = await harness();
  const error = await rejects(run(h, ["--to", "git"], new FakeCreateHost()));
  assert.equal(error.code, "USAGE");
  assert.match(error.help ?? "", /publish --to hosted/);
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
  await writeFile(path.join(folder, "notes", "huge.md"), `---\ntype: Note\n---\n${"x".repeat(70 * 1024)}\n`);
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(preview.ready, false);
  assert.equal((preview.blockers as { rows: { path: string }[] }).rows[0]!.path, "notes/huge.md");
  const error = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake));
  assert.equal(error.details?.reason, "blocked");
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
  gitAs(board, ["commit", "-q", "-am", "v1"], "B".repeat(240));
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
  assert.equal([...history[1]!.author].length, 200, "an author is cut to the host's 200 characters");
  const unbound = receipt.git as Record<string, unknown>;
  assert.equal(unbound.unbound, true);
  assert.equal(unbound.head, head);
  // The folder is no longer a worktree; the branch and its commit are untouched.
  await assert.rejects(stat(path.join(canonical, ".git")));
  assert.equal(git(project, ["rev-parse", "board"]), head);
  assert.doesNotMatch(git(project, ["worktree", "list"]), /\.superbee/);
  assert.equal((await bundleHomeAt(canonical, { home: h.home })).home, "hosted");
  const state = await checkoutState(h.home, canonical);
  assert.equal(state.matches, true);
  // Hooks and reads run from the project root find the published board as the hosted checkout.
  assert.equal((await hostedCheckoutAt(project, h.home))?.bundle_id, "team.board");
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
