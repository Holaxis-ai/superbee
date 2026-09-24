// `superbee sync` in a hosted checkout, against a stateful fake of the hosted sync route family
// that starts from the host's golden transport fixtures (`support/fake-hosted-sync.ts`). No
// request leaves the process.
//
// Mike's frozen-scope rule (docs/core, 2026-09-22) is pinned here: automatic merge happens only
// across different documents; any concurrent change to one document, even to disjoint frontmatter
// keys, is an explicit conflict and nothing is sent for that document.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { parseMarkdown } from "@superbee/core";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { FakeIssuer } from "./support/fake-issuer.js";
import { checkoutLockName } from "../src/hosted/binding.js";
import { assertAllowedInHostedCheckout, HOSTED_CHECKOUT_REFUSALS } from "../src/hosted/refusals.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  out: string[];
  /** The fetch sync uses; the host's own unless a test wraps it. */
  fetch?: typeof fetch;
}

async function harness(host = new FakeHost(), env: NodeJS.ProcessEnv = { SUPERBEE_ACCESS_TOKEN: TOKEN }): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-sync-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-sync-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env,
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  const h: Harness = { home, cwd, folder: path.join(cwd, "team"), auth, host, out: [] };
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return h;
}

const instant = async () => {};

async function runSync(h: Harness, argv: string[] = []): Promise<Record<string, unknown>> {
  h.out.length = 0;
  await sync(["--dir", h.folder, ...argv], {
    stdout: (text: string) => void h.out.push(text),
    auth: h.auth,
    cwd: h.cwd,
    fetch: h.fetch ?? h.host.fetch,
    write: { sleep: instant, lookupDelayMs: 0 },
    sleep: instant,
  });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

/** A sync that must fail: the receipt it printed (when any) and the error. */
async function failingSync(h: Harness, argv: string[] = []): Promise<{ error: CliError; receipt: Record<string, unknown> | null }> {
  h.out.length = 0;
  try {
    await sync(["--dir", h.folder, ...argv], {
      stdout: (text: string) => void h.out.push(text),
      auth: h.auth,
      cwd: h.cwd,
      fetch: h.fetch ?? h.host.fetch,
      write: { sleep: instant, lookupDelayMs: 0 },
      sleep: instant,
      lockWaitMs: 200,
    });
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return { error, receipt: h.out.length > 0 ? (decode(h.out.at(-1)!.trim()) as Record<string, unknown>) : null };
  }
  assert.fail(`expected sync to fail; it printed ${h.out.join("")}`);
}

type Row = { id: string; state: string; reason: string; version: string | null; message: string };
const rowsOf = (receipt: Record<string, unknown> | null): Row[] => (receipt?.rows as Row[]) ?? [];
const rowFor = (receipt: Record<string, unknown> | null, id: string): Row | undefined => rowsOf(receipt).find((row) => row.id === id);

async function edit(h: Harness, id: string, change: (doc: { frontmatter: Record<string, unknown>; body: string }) => void): Promise<void> {
  const file = path.join(h.folder, `${id}.md`);
  const parsed = parseMarkdown(await readFile(file, "utf8"), id);
  const doc = { frontmatter: { ...(parsed.frontmatter as Record<string, unknown>) }, body: parsed.body };
  change(doc);
  const yaml = Object.entries(doc.frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  await writeFile(file, `---\n${yaml}\n---\n${doc.body}`);
}

function hostDoc(h: Harness, id: string) {
  const doc = h.host.docs.get(id);
  assert.ok(doc, `the host has ${id}`);
  return doc;
}

const writeRoutes = (h: Harness) => h.host.writes.filter((call) => call.route !== "outcome");

test("an edited file is sent as one whole document, then the checkout is up to date", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha body, revised.\n"));
  const receipt = await runSync(h);
  assert.equal(receipt.sync, "hosted");
  assert.equal(receipt.status, "synced");
  const row = rowFor(receipt, "notes/alpha")!;
  assert.equal(row.state, "committed");
  assert.equal(row.version, hostDoc(h, "notes/alpha").version);
  assert.equal(hostDoc(h, "notes/alpha").body, "Alpha body, revised.\n");

  const [write] = writeRoutes(h);
  assert.equal(write!.route, "replace");
  assert.equal(write!.body.expectedVersion, "sha256:7f677d62359613b3a8fe840c840b9d6c6d1be756e74013aee2a97c5739ee7fbe");
  assert.equal(write!.body.bundleId, BUNDLE);
  assert.ok(!("superbee_updated_by" in (write!.body.frontmatter as object)), "managed fields are never sent");
  assert.match(write!.binding!, /^sha256:[0-9a-f]{64}$/);

  // Nothing changed since: no write, no conflict, exit 0.
  h.host.writes.length = 0;
  const again = await runSync(h);
  assert.equal(again.status, "up_to_date");
  assert.deepEqual(rowsOf(again), []);
  assert.equal(h.host.writes.length, 0);
});

test("a new file is created against absence, and creates are sent before replaces", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Links to [Gamma](gamma.md).\n"));
  await writeFile(path.join(h.folder, "notes", "gamma.md"), '---\ntype: "Note"\ntitle: "Gamma"\n---\nGamma body.\n');
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "notes/gamma")?.state, "committed");
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.deepEqual(writeRoutes(h).map((call) => [call.route, call.body.documentId]), [
    ["create", "notes/gamma"],
    ["replace", "notes/alpha"],
  ]);
  assert.equal(writeRoutes(h)[0]!.body.expectAbsent, true);
  assert.equal(hostDoc(h, "notes/gamma").frontmatter.title, "Gamma");
});

test("an existing checkout pulls a document created, one replaced and one deleted on the host through /read", async () => {
  const h = await harness();
  const created = h.host.put("notes/delta", { type: "Note", title: "Delta from the host" }, "Delta body.\n");
  const replaced = h.host.put("notes/beta", { type: "Note", title: "Beta from the host" }, "Beta host body.\n");
  h.host.deleteWithTombstone("notes/alpha");
  const receipt = await runSync(h);
  // Nothing was sent, so the checkout is up to date; the pull brought in two documents and removed one.
  assert.equal(receipt.status, "up_to_date", JSON.stringify(receipt));
  assert.deepEqual(receipt.pulled, { refreshed: 2, removed: 1 });
  assert.deepEqual(rowsOf(receipt), []);
  // The new and the replaced documents are each read whole: the path a fresh checkout never takes.
  const reads = h.host.requests.filter((request) => request.path === "/sync/v1/read").map((request) => (request.body as { documentId: string }).documentId).sort();
  assert.deepEqual(reads, ["notes/beta", "notes/delta"]);
  const delta = parseMarkdown(await readFile(path.join(h.folder, "notes/delta.md"), "utf8"), "notes/delta");
  assert.equal(delta.frontmatter.title, "Delta from the host");
  assert.equal(delta.body, "Delta body.\n");
  const beta = parseMarkdown(await readFile(path.join(h.folder, "notes/beta.md"), "utf8"), "notes/beta");
  assert.equal(beta.frontmatter.title, "Beta from the host");
  assert.equal(beta.body, "Beta host body.\n");
  await assert.rejects(stat(path.join(h.folder, "notes/alpha.md")), { code: "ENOENT" });
  assert.notEqual(created, replaced);

  // The checkout now records the host's versions: the next sync sends and reads nothing.
  h.host.requests.length = 0;
  const again = await runSync(h);
  assert.equal(again.status, "up_to_date");
  assert.equal(h.host.requests.filter((request) => request.path === "/sync/v1/read").length, 0);
  assert.equal(h.host.writes.length, 0);

  // A local edit on a pulled document goes out against the host's version it pulled.
  await edit(h, "notes/delta", (doc) => void (doc.body = "Delta, edited here.\n"));
  const sent = await runSync(h);
  assert.equal(rowFor(sent, "notes/delta")?.state, "committed");
  assert.equal(writeRoutes(h).at(-1)!.body.expectedVersion, created);
});

test("an answer the CLI cannot read is a non-retryable RUNTIME naming the route, never TRANSIENT", async () => {
  const h = await harness();
  h.host.put("notes/beta", { type: "Note", title: "Beta from the host" }, "Beta host body.\n");
  // The host answers 200, in a shape this client does not admit (the write result's shape).
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await h.host.fetch(input, init);
    if (new URL(String(input)).pathname !== "/sync/v1/read") return response;
    const { data } = (await response.json()) as { data: { document: { id: string; frontmatter: unknown; body: string }; version: string } };
    return Response.json({ ok: true, operationId: "documents.read.v1", data: { bundleId: BUNDLE, documentId: data.document.id, version: data.version, document: { frontmatter: data.document.frontmatter, body: data.document.body } } });
  }) as typeof fetch;
  const { error } = await failingSync(h);
  assert.equal(error.code, "RUNTIME", error.message);
  assert.match(error.message, /\/sync\/v1\/read/);
  assert.match(error.message, /contract mismatch/);
  const details = error.details as { route?: string; retryable?: boolean; code?: string };
  assert.equal(details.route, "/sync/v1/read");
  assert.equal(details.retryable, false);
  assert.equal(details.code, "MALFORMED_ANSWER");
  assert.doesNotMatch(error.help ?? "", /retry the same command/);
});

test("different documents changed on each side both land, with no conflict", async () => {
  const h = await harness();
  h.host.put("notes/beta", { type: "Note", title: "Beta from the host" }, "Host body.\n");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Local alpha.\n"));
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.deepEqual(rowsOf(receipt).map((row) => [row.id, row.state]), [["notes/alpha", "committed"]]);
  assert.equal((receipt.pulled as { refreshed: number }).refreshed, 1);
  assert.equal(hostDoc(h, "notes/alpha").body, "Local alpha.\n");
  const beta = await readFile(path.join(h.folder, "notes/beta.md"), "utf8");
  assert.match(beta, /Beta from the host/);
  assert.match(beta, /Host body\./);
});

test("the same document changed on each side, even in disjoint frontmatter keys, is a conflict and nothing is sent for it", async () => {
  const h = await harness();
  const before = hostDoc(h, "projects/2026/plan");
  const remoteVersion = h.host.put("projects/2026/plan", { ...before.frontmatter, status: "paused" }, before.body);
  await edit(h, "projects/2026/plan", (doc) => void (doc.frontmatter.title = "Plan, retitled"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.exitCode, 5);
  const row = rowFor(receipt, "projects/2026/plan")!;
  assert.equal(row.state, "conflict");
  assert.equal(row.reason, "changed_remotely");
  // Nothing was merged or applied: the host keeps its own change only.
  assert.equal(hostDoc(h, "projects/2026/plan").version, remoteVersion);
  assert.equal(hostDoc(h, "projects/2026/plan").frontmatter.title, "Plan");
  assert.deepEqual(h.host.applied, []);
  // The local file keeps the local edit.
  assert.match(await readFile(path.join(h.folder, "projects/2026/plan.md"), "utf8"), /Plan, retitled/);
  assert.match(String((receipt!.help as string[])[0]), new RegExp(`sync --inspect --doc projects/2026/plan --dir ${h.folder}$`));

  // Inspect shows base, local and remote; nothing is written. `--inspect --doc <id>` is the
  // spelling the help names, like --resolve's; `--inspect <id>` is its alias and answers the same.
  const review = await runSync(h, ["--inspect", "--doc", "projects/2026/plan"]);
  assert.deepEqual(await runSync(h, ["--inspect", "projects/2026/plan"]), review);
  assert.deepEqual(await runSync(h, ["--doc", "projects/2026/plan", "--inspect"]), review);
  assert.equal(review.conflict, "projects/2026/plan");
  assert.equal(review.reason, "changed_remotely");
  assert.match(String((review.local as { content: string }).content), /Plan, retitled/);
  assert.match(String((review.remote as { content: string }).content), /status: paused/);
  assert.equal((review.remote as { version: string }).version, remoteVersion);
  assert.equal((review.base as { version: string }).version, "sha256:422eea40f06017c6ce64c5caa63af90c8e2f4caacc1209f8e46c8335ff3f7c0d");
});

test("--inspect takes its document from --doc, and refuses a missing or a second, different id", async () => {
  const h = await harness();
  const bare = await failingSync(h, ["--inspect"]);
  assert.equal(bare.error.code, "USAGE");
  assert.match(bare.error.message, /--inspect needs --doc <id>/);
  const both = await failingSync(h, ["--inspect", "notes/alpha", "--doc", "notes/beta"]);
  assert.equal(both.error.code, "USAGE");
  assert.match(both.error.message, /name one document/);
  const docOnly = await failingSync(h, ["--doc", "notes/alpha"]);
  assert.match(docOnly.error.message, /--doc names the document for --inspect or --resolve/);
});

test("--resolve take replaces the file with the host's version and nothing is sent", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  h.host.put("notes/alpha", before.frontmatter, "Host alpha.\n");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Local alpha.\n"));
  await failingSync(h);
  const resolved = await runSync(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(resolved.resolved, "notes/alpha");
  assert.equal(resolved.file_state, "replaced");
  assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /Host alpha\./);
  h.host.writes.length = 0;
  const after = await runSync(h);
  assert.equal(after.status, "up_to_date");
  assert.deepEqual(writeRoutes(h), []);
});

test("--resolve keep sends the local version against the host's current one", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  const remote = h.host.put("notes/alpha", before.frontmatter, "Host alpha.\n");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Local alpha.\n"));
  await failingSync(h);
  await runSync(h, ["--inspect", "notes/alpha"]);
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const after = await runSync(h);
  assert.equal(rowFor(after, "notes/alpha")?.state, "committed");
  assert.equal(hostDoc(h, "notes/alpha").body, "Local alpha.\n");
  assert.equal(writeRoutes(h).at(-1)!.body.expectedVersion, remote);
});

test("--resolve revise sends the file as edited after the conflict", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  h.host.put("notes/alpha", before.frontmatter, "Host alpha.\n");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Local alpha.\n"));
  await failingSync(h);
  // keep refuses a file edited since the conflict; revise sends it as it is now.
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Host alpha.\nLocal alpha.\n"));
  await runSync(h, ["--inspect", "notes/alpha"]);
  const keep = await failingSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(keep.error.code, "CONFLICT");
  assert.equal(keep.error.details?.reason, "file_edited");
  await runSync(h, ["--resolve", "revise", "--doc", "notes/alpha"]);
  const after = await runSync(h);
  assert.equal(rowFor(after, "notes/alpha")?.state, "committed");
  assert.equal(hostDoc(h, "notes/alpha").body, "Host alpha.\nLocal alpha.\n");
});

test("a document deleted on the host while edited locally is a 'deleted remotely' conflict; take removes the file", async () => {
  const h = await harness();
  h.host.remove("notes/alpha");
  h.host.remove("notes/beta");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Local alpha.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  const row = rowFor(receipt, "notes/alpha")!;
  assert.equal(row.state, "conflict");
  assert.equal(row.reason, "deleted_remotely");
  assert.equal(h.host.docs.has("notes/alpha"), false, "never re-created without a decision");
  // The untouched document the host deleted is removed from the folder.
  await assert.rejects(stat(path.join(h.folder, "notes/beta.md")));
  assert.equal((receipt!.pulled as { removed: number }).removed, 1);

  const review = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.equal(review.reason, "deleted_remotely");
  const taken = await runSync(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(taken.file_state, "removed");
  await assert.rejects(stat(path.join(h.folder, "notes/alpha.md")));
  const after = await runSync(h);
  assert.equal(after.status, "up_to_date");
});

test("keep on a file edited while the host deleted it re-creates only through the tombstone, after --inspect shows it", async () => {
  const h = await harness();
  const tombstone = h.host.deleteWithTombstone("notes/alpha");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Keep me.\n"));
  await failingSync(h);
  const review = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.equal(review.reason, "deleted_remotely");
  assert.deepEqual(Object.keys(review.choices as object).sort(), ["keep", "revise", "take"]);
  h.host.writes.length = 0;
  // The replace's refusal named no tombstone, so keep journals a create that acknowledges
  // nothing, and the host refuses it into a "deleted remotely" conflict that names the tombstone.
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const refused = await failingSync(h);
  assert.equal(rowFor(refused.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.deepEqual(writeRoutes(h).map((call) => [call.route, call.recreate]), [["create", null]]);
  assert.equal(h.host.docs.has("notes/alpha"), false, "never re-created without the acknowledgement");
  // keep without an inspection of that tombstone is refused, and sends nothing.
  const blind = await failingSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(blind.error.details?.reason, "not_inspected");
  const shown = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.equal((shown.remote as { deleted_as?: string }).deleted_as, tombstone);
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const done = await runSync(h);
  assert.equal(rowFor(done, "notes/alpha")?.state, "committed");
  const creates = writeRoutes(h).filter((call) => call.route === "create");
  assert.equal(creates.at(-1)!.recreate, tombstone, "the re-create acknowledges exactly the inspected tombstone");
  assert.notEqual(creates.at(-1)!.requestId, creates[0]!.requestId, "under a new identity");
  assert.equal(hostDoc(h, "notes/alpha").body, "Keep me.\n");
});

test("a stale tombstone is a conflict again, never last-writer-wins: a second delete after --inspect refuses the re-create", async () => {
  const h = await harness();
  const first = h.host.deleteWithTombstone("notes/alpha");
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Mine.\n"));
  await failingSync(h);
  await runSync(h, ["--inspect", "notes/alpha"]);
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  await failingSync(h);
  const shown = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.equal((shown.remote as { deleted_as?: string }).deleted_as, first);
  // Someone re-creates and deletes it again between the inspection and the keep.
  h.host.put("notes/alpha", { type: "Note", title: "Theirs" }, "Theirs.\n");
  const second = h.host.deleteWithTombstone("notes/alpha");
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const stale = await failingSync(h);
  assert.equal(rowFor(stale.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.equal(h.host.docs.has("notes/alpha"), false, "the stale acknowledgement re-created nothing");
  assert.equal(writeRoutes(h).at(-1)!.recreate, first);
  // The new conflict names the newer tombstone; an inspection of the old one no longer admits keep.
  const again = await failingSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(again.error.details?.reason, "not_inspected");
  const fresh = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.equal((fresh.remote as { deleted_as?: string }).deleted_as, second);
});

test("a deleted file syncs as a CAS-bound delete; the checkout's own later re-create acknowledges its tombstone", async () => {
  const h = await harness();
  const base = hostDoc(h, "notes/alpha").version;
  const saved = await readFile(path.join(h.folder, "notes/alpha.md"), "utf8");
  await unlink(path.join(h.folder, "notes/alpha.md"));
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.deepEqual([rowFor(receipt, "notes/alpha")?.state, rowFor(receipt, "notes/alpha")?.reason], ["committed", "deleted"]);
  const [call] = writeRoutes(h);
  assert.equal(call!.route, "delete");
  assert.deepEqual(call!.body, { bundleId: BUNDLE, documentId: "notes/alpha", expectedVersion: base });
  const tombstone = h.host.latestTombstone("notes/alpha")!;
  assert.equal(rowFor(receipt, "notes/alpha")?.version, tombstone.tombstone);
  assert.equal(h.host.docs.has("notes/alpha"), false);
  assert.equal((await runSync(h)).status, "up_to_date", "nothing more to send, and the file stays gone");
  // Writing the file again later is this checkout re-creating its own deletion: acknowledged automatically.
  await writeFile(path.join(h.folder, "notes/alpha.md"), saved);
  const again = await runSync(h);
  assert.equal(rowFor(again, "notes/alpha")?.state, "committed");
  const create = writeRoutes(h).at(-1)!;
  assert.deepEqual([create.route, create.recreate], ["create", tombstone.tombstone]);
  assert.ok(h.host.docs.has("notes/alpha"));
});

test("`doc delete` in a checkout is no longer refused; the next sync sends the delete", async () => {
  const h = await harness();
  assert.equal(HOSTED_CHECKOUT_REFUSALS.some((row) => row.words.join(" ") === "doc delete" || row.words.join(" ") === "delete"), false);
  const context = { home: h.home, cwd: h.cwd };
  await assertAllowedInHostedCheckout("doc", ["delete", "notes/alpha", "--dir", h.folder], context);
  await assertAllowedInHostedCheckout("delete", ["notes/alpha", "--dir", h.folder], context);
});

test("a lost delete answer is looked up by the same identity, and a retried no-op delete answers unchanged", async () => {
  const h = await harness();
  let dropped = false;
  h.host.hook = (call) => (call.route === "delete" && !dropped ? ((dropped = true), { kind: "apply-then-drop" }) : undefined);
  await unlink(path.join(h.folder, "notes/alpha.md"));
  const lost = await runSync(h);
  assert.equal(rowFor(lost, "notes/alpha")?.state, "committed", "the lookup found the recorded delete");
  const calls = h.host.writes.map((call) => call.route);
  assert.deepEqual(calls, ["delete", "outcome"]);
  assert.equal(h.host.writes[0]!.requestId, h.host.writes[1]!.requestId);
  assert.equal(h.host.tombstones.get("notes/alpha")!.length, 1);
});

test("a delete of a document the host changed is a conflict: keep deletes the host's version, take brings it back", async () => {
  for (const choice of ["keep", "take"] as const) {
    const h = await harness();
    await unlink(path.join(h.folder, "notes/alpha.md"));
    const theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "Changed on the host.\n");
    const first = await failingSync(h);
    assert.deepEqual([rowFor(first.receipt, "notes/alpha")?.state, rowFor(first.receipt, "notes/alpha")?.reason], ["conflict", "changed_remotely"]);
    assert.ok(h.host.docs.has("notes/alpha"), "a stale delete removed nothing");
    if (choice === "keep") {
      // Review S2: keeping the deletion removes the host's version, so it needs a current --inspect.
      const blind = await failingSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
      assert.equal(blind.error.details?.reason, "not_inspected");
      assert.ok(h.host.docs.has("notes/alpha"));
    }
    const review = await runSync(h, ["--inspect", "notes/alpha"]);
    assert.equal((review.local as { deleted?: boolean }).deleted, true);
    assert.equal((review.remote as { version: string }).version, theirs);
    const revise = await failingSync(h, ["--resolve", "revise", "--doc", "notes/alpha"]);
    assert.equal(revise.error.details?.reason, "deletion_conflict");
    await runSync(h, ["--resolve", choice, "--doc", "notes/alpha"]);
    const done = await runSync(h);
    if (choice === "keep") {
      assert.equal(rowFor(done, "notes/alpha")?.reason, "deleted");
      assert.equal(h.host.docs.has("notes/alpha"), false);
      assert.equal(writeRoutes(h).at(-1)!.body.expectedVersion, theirs);
    } else {
      assert.equal(done.status, "up_to_date");
      assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /Changed on the host\./);
      assert.ok(h.host.docs.has("notes/alpha"));
    }
  }
});

test("deleting most of the checkout at once is held as a whole, as pull bounds deletions; nothing is sent", async () => {
  const host = new FakeHost();
  for (let index = 0; index < 10; index += 1) host.put(`bulk/n${index}`, { type: "Note", title: `N${index}` }, "x\n");
  const h = await harness(host);
  for (let index = 0; index < 10; index += 1) await unlink(path.join(h.folder, `bulk/n${index}.md`));
  const { receipt } = await failingSync(h);
  assert.equal(rowsOf(receipt).filter((row) => row.reason === "bulk_deletion").length, 10);
  assert.deepEqual(writeRoutes(h), []);
  assert.equal(h.host.docs.size >= 10, true);
});

test("deleting a linked document warns with the documents that still link to it, and never refuses", async () => {
  const host = new FakeHost();
  host.put("notes/linker", { type: "Note", title: "Linker" }, "See [Alpha](alpha.md).\n");
  const h = await harness(host);
  await unlink(path.join(h.folder, "notes/alpha.md"));
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "notes/alpha")?.reason, "deleted");
  assert.match(rowFor(receipt, "notes/alpha")!.message, /still link here: .*notes\/linker/);
  // The fixture's plan links to alpha too.
  assert.deepEqual((receipt.deletions as { still_linked_from?: string[] }[])[0]!.still_linked_from, ["notes/linker", "projects/2026/plan"]);
  assert.equal(h.host.docs.has("notes/alpha"), false);
});

test("B2: a host delete of a document sync holds locally is a conflict, never a silent re-create", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.type = "Decision"));
  h.host.remove("notes/alpha");
  const first = await failingSync(h);
  assert.equal(first.error.code, "CONFLICT");
  assert.deepEqual([rowFor(first.receipt, "notes/alpha")?.state, rowFor(first.receipt, "notes/alpha")?.reason], ["conflict", "deleted_remotely"]);
  for (let run = 0; run < 2; run += 1) {
    const next = await failingSync(h);
    assert.equal(rowFor(next.receipt, "notes/alpha")?.reason, "deleted_remotely");
  }
  assert.deepEqual(writeRoutes(h), [], "no create is ever sent");
  assert.equal(h.host.docs.has("notes/alpha"), false);
  const keep = await failingSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(keep.error.details?.reason, "not_inspected", "a re-create waits for an inspection of the deletion");
  const taken = await runSync(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(taken.file_state, "removed");
  await assert.rejects(stat(path.join(h.folder, "notes/alpha.md")));
  assert.equal((await runSync(h)).status, "up_to_date");
  assert.deepEqual(writeRoutes(h), []);
});

test("B2: a file edited during the pull of a host delete is a conflict in that run and never re-created", async () => {
  const h = await harness();
  h.host.remove("notes/alpha");
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/heads")) await writeFile(path.join(h.folder, "notes/alpha.md"), '---\ntype: "Note"\n---\nAgent edit during pull.\n');
    return h.host.fetch(input, init);
  }) as typeof fetch;
  const first = await failingSync(h);
  assert.equal(first.error.code, "CONFLICT");
  assert.equal(rowFor(first.receipt, "notes/alpha")?.reason, "deleted_remotely");
  h.fetch = undefined;
  const second = await failingSync(h);
  assert.equal(rowFor(second.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.deepEqual(writeRoutes(h), []);
  assert.equal(h.host.docs.has("notes/alpha"), false);
  assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /Agent edit during pull\./);
});

test("B3: a file edited during the pull of a host change is a conflict in that run and never overwrites the host", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  const remote = h.host.put("notes/alpha", before.frontmatter, "Host change.\n");
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/heads")) await writeFile(path.join(h.folder, "notes/alpha.md"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nAgent edit made against the OLD version.\n');
    return h.host.fetch(input, init);
  }) as typeof fetch;
  const first = await failingSync(h);
  assert.equal(first.error.code, "CONFLICT", "the run that saw the edit is not up to date");
  assert.equal(first.error.exitCode, 5);
  assert.notEqual(first.receipt!.status, "up_to_date");
  assert.deepEqual([rowFor(first.receipt, "notes/alpha")?.state, rowFor(first.receipt, "notes/alpha")?.reason], ["conflict", "changed_remotely"]);
  h.fetch = undefined;
  const second = await failingSync(h);
  assert.equal(rowFor(second.receipt, "notes/alpha")?.state, "conflict");
  assert.deepEqual(writeRoutes(h), [], "nothing is sent over the host's change");
  assert.equal(hostDoc(h, "notes/alpha").version, remote);
  assert.equal(hostDoc(h, "notes/alpha").body, "Host change.\n");
  assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /OLD version/);

  // Inspect shows the file against the host's version; take places the host's version.
  const review = await runSync(h, ["--inspect", "notes/alpha"]);
  assert.match(String((review.local as { content: string }).content), /OLD version/);
  assert.match(String((review.remote as { content: string }).content), /Host change\./);
  const taken = await runSync(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(taken.file_state, "replaced");
  assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /Host change\./);
  assert.equal((await runSync(h)).status, "up_to_date");
  assert.deepEqual(writeRoutes(h), []);
});

test("B3: keep on a file edited during a pull sends it only as an explicit decision, against the host's version", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  const remote = h.host.put("notes/alpha", before.frontmatter, "Host change.\n");
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/heads")) await writeFile(path.join(h.folder, "notes/alpha.md"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nMine, decided.\n');
    return h.host.fetch(input, init);
  }) as typeof fetch;
  await failingSync(h);
  h.fetch = undefined;
  await runSync(h, ["--inspect", "notes/alpha"]);
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const after = await runSync(h);
  assert.equal(rowFor(after, "notes/alpha")?.state, "committed");
  assert.equal(writeRoutes(h).at(-1)!.body.expectedVersion, remote);
  assert.equal(hostDoc(h, "notes/alpha").body, "Mine, decided.\n");
});

test("B3: a held edit whose document the host changed meanwhile is a conflict, not a rebase", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.type = "Decision"));
  const before = hostDoc(h, "notes/alpha");
  const remote = h.host.put("notes/alpha", before.frontmatter, "Host change.\n");
  const first = await failingSync(h);
  assert.equal(rowFor(first.receipt, "notes/alpha")?.state, "conflict");
  // Restoring the type does not rebase the edit silently onto the host's change.
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.type = "Note"));
  const second = await failingSync(h);
  assert.equal(rowFor(second.receipt, "notes/alpha")?.reason, "changed_remotely");
  assert.deepEqual(writeRoutes(h), []);
  assert.equal(hostDoc(h, "notes/alpha").version, remote);
});

test("a frontmatter-only change against a body-only change to one document is a conflict too", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  h.host.put("notes/alpha", before.frontmatter, "Body changed on the host.\n");
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.owner = "me"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "conflict");
  assert.deepEqual(h.host.applied, []);
  assert.equal(hostDoc(h, "notes/alpha").frontmatter.owner, undefined);
});

test("a lost answer is looked up by the same identity through /outcome, never sent twice", async () => {
  const h = await harness();
  let dropped = false;
  h.host.hook = (call) => {
    if (call.route === "replace" && !dropped) {
      dropped = true;
      return { kind: "apply-then-drop" };
    }
    return undefined;
  };
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Once.\n"));
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.deepEqual(h.host.applied, ["notes/alpha"]);
  const replace = h.host.writes.find((call) => call.route === "replace")!;
  const lookups = h.host.writes.filter((call) => call.route === "outcome");
  assert.ok(lookups.length >= 1);
  assert.ok(lookups.every((call) => call.requestId === replace.requestId && call.binding === replace.binding));
  assert.equal(h.host.writes.filter((call) => call.route === "replace").length, 1);
});

test("an answer that stays lost is an 'unknown' row; the next sync settles it by the same identity", async () => {
  const h = await harness();
  let down = true;
  h.host.hook = (call) => (down && call.route === "replace" ? { kind: "apply-then-drop" } : down && call.route === "outcome" ? { kind: "drop" } : undefined);
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Maybe.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "TRANSIENT");
  assert.equal(error.exitCode, 1);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "unknown");
  const identity = h.host.writes.find((call) => call.route === "replace")!.requestId;

  down = false;
  h.host.writes.length = 0;
  const after = await runSync(h);
  assert.equal(rowFor(after, "notes/alpha")?.state, "committed");
  assert.equal(h.host.writes[0]!.route, "outcome", "the next sync looks up before sending");
  assert.ok(h.host.writes.every((call) => call.requestId === identity));
  assert.deepEqual(h.host.applied, ["notes/alpha"]);
});

test("the sync quota pauses sync with a row naming your quota for this bundle; nothing is lost", async () => {
  const h = await harness();
  let full = true;
  h.host.hook = (call) =>
    full && call.route !== "outcome"
      ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "quota", retryable: false, writeState: "not_applied" } } }
      : undefined;
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Quota alpha.\n"));
  await edit(h, "notes/beta", (doc) => void (doc.body = "Quota beta.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "TRANSIENT");
  const rows = rowsOf(receipt);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.state, "paused");
    assert.equal(row.reason, "sync_quota_principal");
    assert.match(row.message, /^paused: sync quota\. Your sync quota for this bundle/);
  }
  assert.equal(writeRoutes(h).length, 1, "sync stops at the first refusal");

  // A bundle-scope refusal names the bundle, not the person.
  h.host.hook = (call) =>
    call.route !== "outcome" ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "bundle", message: "quota", retryable: false, writeState: "not_applied" } } } : undefined;
  const bundle = await failingSync(h);
  assert.equal(rowsOf(bundle.receipt)[0]!.reason, "sync_quota_bundle");
  assert.match(rowsOf(bundle.receipt)[0]!.message, /This bundle's sync capacity/);

  // Once the quota admits writes, the same run of sync sends everything.
  full = false;
  h.host.hook = undefined;
  const after = await runSync(h);
  assert.deepEqual(rowsOf(after).map((row) => row.state), ["committed", "committed"]);
});

test("a read-only person is refused a push with a clear message", async () => {
  const h = await harness();
  h.host.hook = (call) =>
    call.route !== "outcome"
      ? { kind: "respond", status: 200, body: { ok: false, operationId: `documents.${call.route}.v1`, error: { code: "insufficient_scope", message: "read only", retryable: false, writeState: "not_applied" } } }
      : undefined;
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Not allowed.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "FORBIDDEN");
  const row = rowFor(receipt, "notes/alpha")!;
  assert.equal(row.state, "refused");
  assert.equal(row.reason, "read_only");
  assert.match(row.message, /read-only access/);
  assert.deepEqual(h.host.applied, []);
  assert.match(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), /Not allowed\./);
});

test("a bundle the host serves without writes is refused without sending anything", async () => {
  const h = await harness(new FakeHost());
  h.host.capabilities = "capabilities-read-only";
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Not sent.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(rowFor(receipt, "notes/alpha")?.reason, "read_only");
  assert.deepEqual(h.host.writes, []);
});

test("a session the host ends mid-sync is AUTH_REQUIRED with the resume command; the change is kept", async () => {
  const h = await harness();
  h.host.hook = (call) => (call.route === "replace" ? { kind: "respond", status: 401, body: { error: { code: "unauthenticated", writeState: "not_applied" } } } : undefined);
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Later.\n"));
  const { error } = await failingSync(h);
  assert.equal(error.code, "AUTH_REQUIRED");
  assert.equal(error.exitCode, 4);
  assert.match(String(error.details?.resume), /sync --dir /);
  assert.match(error.help ?? "", /login --host/);
  h.host.hook = undefined;
  const after = await runSync(h);
  assert.equal(rowFor(after, "notes/alpha")?.state, "committed");
});

test("AUTH_REQUIRED from a rejected token passes through before any write", async () => {
  const h = await harness();
  const other = defaultHostedAuthDeps(h.home, { env: { SUPERBEE_ACCESS_TOKEN: `${TOKEN}x` } });
  await edit(h, "notes/alpha", (doc) => void (doc.body = "x\n"));
  await assert.rejects(
    sync(["--dir", h.folder], { stdout: () => {}, auth: other, cwd: h.cwd, fetch: h.host.fetch }),
    (error: unknown) => error instanceof CliError && error.code === "AUTH_REQUIRED" && /sync --dir/.test(String(error.details?.resume)),
  );
  assert.deepEqual(h.host.writes, []);
});

test("AUTH_REQUIRED from sign-in passes through with its link and a resume command that re-runs sync", async () => {
  const issuer = await new FakeIssuer().start();
  try {
    const host = new FakeHost({ origin: issuer.base });
    const home = await mkdtemp(path.join(tmpdir(), "sb-sync-auth-"));
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-sync-cwd-")));
    const signedIn = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: host.token } });
    await checkout([BUNDLE, "--host", issuer.base, "--dir", "team"], { stdout: () => {}, auth: signedIn, cwd, fetch: host.fetch });
    host.requests.length = 0;
    const folder = path.join(cwd, "team");
    await writeFile(path.join(folder, "notes", "alpha.md"), '---\ntype: "Note"\n---\nEdited.\n');
    const signedOut = defaultHostedAuthDeps(home, { env: { [CREDENTIAL_STORE_ENV]: "file" } });
    await assert.rejects(
      sync(["--dir", folder, "--json"], { stdout: () => {}, auth: signedOut, cwd, fetch: host.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "AUTH_REQUIRED");
        assert.equal(error.exitCode, 4);
        assert.match(String(error.details?.sign_in_url), /activate\?user_code=/);
        assert.match(String(error.details?.resume), /sync --dir .*team --json$/);
        return true;
      },
    );
    assert.deepEqual(host.requests, [], "no sync request before sign-in");
  } finally {
    await issuer.stop();
  }
});

test("a change recorded as busy (concurrent_change) is resent under a fresh identity in the same run", async () => {
  const h = await harness();
  let busy = true;
  h.host.hook = (call) => {
    if (call.route === "replace" && busy) {
      busy = false;
      return { kind: "record", code: "concurrent_change" };
    }
    return undefined;
  };
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Busy host.\n"));
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  const replaces = h.host.writes.filter((call) => call.route === "replace");
  assert.equal(replaces.length, 2);
  assert.notEqual(replaces[0]!.requestId, replaces[1]!.requestId);
});

test("held files stay as they are and nothing is sent for them", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.type = "Decision"));
  await writeFile(path.join(h.folder, "index.md"), "---\nokf_version: \"0.2\"\ntitle: Changed\n---\n");
  await mkdir(path.join(h.folder, "views"), { recursive: true });
  await writeFile(path.join(h.folder, "views", "board.md"), '---\ntype: "View"\n---\n');
  await unlink(path.join(h.folder, "notes/beta.md"));
  await writeFile(path.join(h.folder, "notes", "untyped.md"), "---\ntitle: No type\n---\nx\n");
  await writeFile(path.join(h.folder, "notes", "image.png"), "png");
  await writeFile(path.join(h.folder, "notes", "badstatus.md"), '---\ntype: "Note"\nstatus: "reviewed"\n---\nx\n');
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  const reasons = Object.fromEntries(rowsOf(receipt).map((row) => [row.id, [row.state, row.reason]]));
  assert.deepEqual(reasons, {
    "index.md": ["held", "reserved_file"],
    "notes/alpha": ["held", "type_change"],
    "notes/badstatus": ["held", "not_sendable"],
    "notes/beta": ["committed", "deleted"],
    "notes/untyped": ["held", "not_sendable"],
    "notes/image.png": ["held", "not_a_document"],
    "views/board": ["held", "convention_folder"],
  });
  // The deleted file is the only thing sent: a delete of the version the file held.
  assert.deepEqual(writeRoutes(h).map((call) => call.route), ["delete"]);
  assert.equal(h.host.docs.has("notes/beta"), false);
});

test("a managed-only difference is not a change", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.frontmatter.superbee_updated_by = "me"));
  const receipt = await runSync(h);
  assert.equal(receipt.status, "up_to_date");
  assert.deepEqual(h.host.writes, []);
});

test("a second sync while one holds the checkout lock reports sync_busy", async () => {
  const h = await harness();
  const locks = filesystemPushRoleLocks();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const holder = locks.request(checkoutLockName(h.folder), { ifAvailable: true }, async () => {
    acquired();
    await held;
  });
  await ready;
  try {
    const { error } = await failingSync(h);
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.details?.reason, "sync_busy");
  } finally {
    release();
    await holder;
  }
});

test("the row list is bounded and names the total", async () => {
  const h = await harness();
  for (let index = 0; index < 4; index += 1) await writeFile(path.join(h.folder, `n${index}.md`), `---\ntype: "Note"\n---\nn${index}\n`);
  h.out.length = 0;
  await sync(["--dir", h.folder, "--limit", "2"], { stdout: (text: string) => void h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 } });
  const receipt = decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
  assert.equal(rowsOf(receipt).length, 2);
  assert.equal(receipt.rows_total, 4);
  assert.match(String(receipt.rows_all), /--limit 4/);
});

test("one sync command: Git-only flags are refused in a checkout, hosted verbs outside one", async () => {
  const h = await harness();
  const gitOnly = await failingSync(h, ["--pull-only"]);
  assert.equal(gitOnly.error.code, "USAGE");
  const elsewhere = await mkdtemp(path.join(tmpdir(), "sb-plain-"));
  await assert.rejects(
    sync(["--dir", elsewhere, "--inspect", "x"], { stdout: () => {}, auth: h.auth, cwd: h.cwd }),
    (error: unknown) => error instanceof CliError && error.code === "USAGE" && /hosted checkout/.test(error.message),
  );
  const help: string[] = [];
  await sync(["--help"], { stdout: (text: string) => void help.push(text) });
  assert.match(help.join(""), /share the board branch/);
  assert.match(help.join(""), /--resolve keep\|take\|revise --doc <id>/);
});

test("sync is no longer refused in a checkout; ui and mcp (View writes) are", async () => {
  const h = await harness();
  const context = { home: h.home, cwd: h.cwd };
  await assertAllowedInHostedCheckout("sync", ["--dir", h.folder], context);
  for (const [command, args] of [["ui", ["--dir", h.folder]], ["mcp", ["--dir", h.folder]]] as const) {
    await assert.rejects(assertAllowedInHostedCheckout(command, [...args], context), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN" && error.details?.do_this_in === "app");
  }
  await assertAllowedInHostedCheckout("mcp", ["status", "--dir", h.folder], context);
  assert.ok(HOSTED_CHECKOUT_REFUSALS.every((row) => row.words[0] !== "sync"));
});

test("checkout refuses to reclaim a checkout holding unsent changes, or one emptied in place", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Unsent.\n"));
  h.host.hook = (call) => (call.route !== "outcome" ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "q", retryable: false, writeState: "not_applied" } } } : undefined);
  await failingSync(h);
  // Emptied in place: every file removed is a pending change, not a stale checkout.
  for (const entry of await readdir(h.folder)) await rm(path.join(h.folder, entry), { recursive: true });
  const emptied = await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch }).then(
    () => assert.fail("expected a refusal"),
    (error: unknown) => error as CliError,
  );
  assert.equal(emptied.code, "ALREADY_EXISTS");
  assert.equal(emptied.details?.reason, "emptied_checkout");
  // Deleted and recreated: another folder, but the store still holds the unsent change.
  await rm(h.folder, { recursive: true });
  const unsent = await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch }).then(
    () => assert.fail("expected a refusal"),
    (error: unknown) => error as CliError,
  );
  assert.equal(unsent.code, "CONFLICT");
  assert.equal(unsent.details?.reason, "unsent_changes");
  assert.equal(unsent.details?.unsent, 1);
});

test("checkout into a symlinked --dir binds the real folder, and sync finds it through the link", async () => {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-sync-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-sync-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN } });
  await mkdir(path.join(cwd, "real"));
  await symlink(path.join(cwd, "real"), path.join(cwd, "link"));
  const out: string[] = [];
  await checkout([BUNDLE, "--host", HOST, "--dir", "link"], { stdout: (text) => void out.push(text), auth, cwd, fetch: host.fetch });
  const receipt = decode(out.at(-1)!.trim()) as Record<string, unknown>;
  assert.equal(receipt.folder, path.join(cwd, "real"));
  assert.equal(receipt.mode, "sync");
  assert.ok((await stat(path.join(cwd, "real", "notes/alpha.md"))).isFile());
  await writeFile(path.join(cwd, "link", "notes", "alpha.md"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nThrough the link.\n');
  out.length = 0;
  await sync(["--dir", path.join(cwd, "link")], { stdout: (text: string) => void out.push(text), auth, cwd, fetch: host.fetch, write: { sleep: instant, lookupDelayMs: 0 } });
  const synced = decode(out.at(-1)!.trim()) as Record<string, unknown>;
  assert.equal(rowFor(synced, "notes/alpha")?.state, "committed");
  assert.equal(host.docs.get("notes/alpha")!.body, "Through the link.\n");
});
