import { commitLocal } from "@superbee/browser-local";
import { artifact } from "../src/commands/artifact.js";
import { publications, initialArtifactOwner, admitArtifactRecord } from "../src/hosted/artifact.js";
// `superbee sync` in a hosted checkout, against a stateful fake of the hosted sync route family
// that starts from the host's golden transport fixtures (`support/fake-hosted-sync.ts`). No
// request leaves the process.
//
// Mike's frozen-scope rule (docs/core, 2026-09-22) is pinned here: automatic merge happens only
// across different documents; any concurrent change to one document, even to disjoint frontmatter
// keys, is an explicit conflict and nothing is sent for that document.
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { decodePreparedBlobIntent, isOrdinaryBlobKey } from "@superbee/core/storage";
import { BLOB_SYNC_META_KEY, encodeBlobSyncMap, admitOfflineBlob } from "../src/hosted/blob-sync.js";
import { digestOf } from "../src/hosted/projection.js";
import { parseMarkdown } from "@superbee/core";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { catalog } from "../src/commands/catalog.js";
import { loadCatalog } from "../src/catalog.js";
import { sync } from "../src/commands/sync.js";
import { promote } from "../src/commands/promote.js";
import { deleteCommand } from "../src/commands/delete.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { FakeIssuer } from "./support/fake-issuer.js";
import { bindingForPath, checkoutDir, checkoutLockName, checkoutStoreDir } from "../src/hosted/binding.js";
import { hostedStatus } from "../src/hosted/status.js";
import { hostedPull } from "../src/hosted/sync.js";
import { recoverPlacements } from "../src/hosted/sync-scan.js";
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
  // The host stamped a field of its own, so the folder holds the host's bytes, not the ones sent.
  assert.equal(await readFile(path.join(h.folder, "notes/alpha.md"), "utf8"), hostDoc(h, "notes/alpha").raw);
  const { sync: state } = await hostedStatus((await bindingForPath(h.home, h.folder))!, h.home);
  assert.equal(state.state, "clean");

  // Nothing changed since: no write, no conflict, exit 0.
  h.host.writes.length = 0;
  const again = await runSync(h);
  assert.equal(again.status, "up_to_date");
  assert.deepEqual(rowsOf(again), []);
  assert.equal(h.host.writes.length, 0);
});

test("a file edited while its own send is in flight keeps the edit, with no conflict; the next run sends it and takes the host's bytes", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha body, revised.\n"));
  const file = path.join(h.folder, "notes/alpha.md");
  const sent = await readFile(file, "utf8");
  const typed = sent.replace("Alpha body, revised.\n", "Typed during the send.\n");
  let once = true;
  h.host.hook = (call) => {
    if (once && call.route === "replace") {
      once = false;
      writeFileSync(file, typed);
    }
    return undefined;
  };
  const first = await runSync(h);
  assert.equal(rowFor(first, "notes/alpha")?.state, "committed");
  assert.equal(await readFile(file, "utf8"), typed, "the edit made during the send is never replaced");
  const acknowledged = hostDoc(h, "notes/alpha").version;
  h.host.hook = undefined;
  h.host.writes.length = 0;
  const second = await runSync(h);
  assert.equal(second.status, "synced");
  const [write] = writeRoutes(h);
  assert.equal(write!.body.expectedVersion, acknowledged, "sent against the host's real version");
  assert.equal(hostDoc(h, "notes/alpha").body, "Typed during the send.\n");
  assert.equal(await readFile(file, "utf8"), hostDoc(h, "notes/alpha").raw);
});

test("a run that stops between the host's acknowledgement and taking its bytes takes them on the next run", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha body, revised.\n"));
  let accepted = false;
  h.fetch = async (input, init) => {
    if (accepted) throw new TypeError("fetch failed");
    const response = await h.host.fetch(input as Request, init);
    if (h.host.writes.some((call) => call.route === "replace")) accepted = true;
    return response;
  };
  await failingSync(h);
  const file = path.join(h.folder, "notes/alpha.md");
  assert.notEqual(await readFile(file, "utf8"), hostDoc(h, "notes/alpha").raw, "the run stopped before taking the host's bytes");
  h.fetch = undefined;
  h.host.writes.length = 0;
  await runSync(h);
  assert.deepEqual(writeRoutes(h), [], "nothing is sent again");
  assert.equal(await readFile(file, "utf8"), hostDoc(h, "notes/alpha").raw);
  const { sync: state } = await hostedStatus((await bindingForPath(h.home, h.folder))!, h.home);
  assert.equal(state.state, "clean");
});

test("writes name the agent the sync runs under (X-Superbee-Via), and a token the host would refuse is never sent", async () => {
  for (const [env, via, ignored] of [
    [{}, null, false],
    [{ CLAUDECODE: "1" }, "claude-code", false],
    [{ CLAUDECODE: "1", SUPERBEE_VIA: "codex" }, "codex", false],
    [{ CLAUDECODE: "1", SUPERBEE_NO_VIA: "1" }, null, false],
    [{ CLAUDECODE: "1", SUPERBEE_VIA: "codex", SUPERBEE_NO_VIA: "1" }, null, false],
    [{ CLAUDECODE: "true" }, null, false],
    [{ SUPERBEE_VIA: " codex " }, "codex", false],
    [{ CLAUDECODE: "1", SUPERBEE_VIA: "" }, "claude-code", false],
    [{ CLAUDECODE: "1", SUPERBEE_VIA: "Claude Code" }, null, true],
    [{ SUPERBEE_VIA: "superbee-cli" }, null, true],
  ] as const) {
    const h = await harness(new FakeHost(), { SUPERBEE_ACCESS_TOKEN: TOKEN, ...env });
    await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha body, revised.\n"));
    const receipt = await runSync(h);
    assert.equal(receipt.status, "synced", JSON.stringify(env));
    assert.deepEqual(
      h.host.writes.map((call) => call.via),
      [via],
      JSON.stringify(env),
    );
    // A dropped token is named in the receipt; the sync itself runs as usual.
    assert.equal(typeof receipt.via_ignored === "string", ignored, JSON.stringify(env));
  }
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
  assert.equal(HOSTED_CHECKOUT_REFUSALS.some((row) => row.words.join(" ") === "doc delete"), false);
  // Protected targets remain refused; ordinary blobs enter offline admission and document deletes retain their existing route.
  assert.ok(HOSTED_CHECKOUT_REFUSALS.find((row) => row.words.join(" ") === "delete")?.when !== undefined);
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

test("a lost answer, then an edit, then a content refusal of the first change: the edit is sent in its place in the same run", async () => {
  const h = await harness();
  const original = hostDoc(h, "notes/alpha").version;
  let lost = true;
  let first: string | null = null;
  h.host.hook = (call) => {
    if (call.route === "outcome") return lost ? { kind: "drop" } : undefined;
    if (call.route !== "replace") return undefined;
    first ??= call.requestId;
    if (lost) return { kind: "drop" };
    return call.requestId === first ? { kind: "record", code: "validation_failed" } : undefined;
  };
  await edit(h, "notes/alpha", (doc) => void (doc.body = "First.\n"));
  const unknown = await failingSync(h);
  assert.equal(rowFor(unknown.receipt, "notes/alpha")?.state, "unknown");

  // The next edit chains behind the possibly delivered change; the host then refuses that change.
  lost = false;
  h.host.writes.length = 0;
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Second.\n"));
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.equal(hostDoc(h, "notes/alpha").body, "Second.\n");
  const replaces = h.host.writes.filter((call) => call.route === "replace");
  assert.deepEqual(replaces.map((call) => [call.requestId === first, call.body.body, call.body.expectedVersion]), [
    [true, "First.\n", original],
    [false, "Second.\n", original],
  ], "the refused change once, then the edit alone against the version the host still holds");
  assert.deepEqual(h.host.applied, ["notes/alpha"]);
});

test("a lost answer, then an edit, then a busy refusal (concurrent_change) of the first change: the edit is sent in its place in the same run, and the first change never lands", async () => {
  const h = await harness();
  const original = hostDoc(h, "notes/alpha").version;
  let lost = true;
  let first: string | null = null;
  h.host.hook = (call) => {
    if (call.route === "outcome") return lost ? { kind: "drop" } : undefined;
    if (call.route !== "replace") return undefined;
    first ??= call.requestId;
    if (lost) return { kind: "drop" };
    return call.requestId === first ? { kind: "record", code: "concurrent_change" } : undefined;
  };
  await edit(h, "notes/alpha", (doc) => void (doc.body = "First.\n"));
  const unknown = await failingSync(h);
  assert.equal(rowFor(unknown.receipt, "notes/alpha")?.state, "unknown");

  // The next edit chains behind the possibly delivered change; the host then answers that change busy.
  lost = false;
  h.host.writes.length = 0;
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Second.\n"));
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced", JSON.stringify(receipt));
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.equal(hostDoc(h, "notes/alpha").body, "Second.\n");
  const replaces = h.host.writes.filter((call) => call.route === "replace");
  assert.deepEqual(replaces.map((call) => [call.requestId === first, call.body.body, call.body.expectedVersion]), [
    [true, "First.\n", original],
    [false, "Second.\n", original],
  ], "the busy change once, then the edit alone against the version the host still holds");
  assert.deepEqual(h.host.applied, ["notes/alpha"], "one application: the edit, never the busy change");

  const after = await runSync(h);
  assert.ok(["synced", "up_to_date"].includes(String(after.status)), JSON.stringify(after));
  assert.equal(h.host.writes.filter((call) => call.route === "replace").length, 2, "nothing is sent again");
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

test("sync and mcp are not refused in a checkout; ui (View writes) is", async () => {
  const h = await harness();
  const context = { home: h.home, cwd: h.cwd };
  await assertAllowedInHostedCheckout("sync", ["--dir", h.folder], context);
  await assert.rejects(assertAllowedInHostedCheckout("ui", ["--dir", h.folder], context), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN" && error.details?.do_this_in === "app");
  await assertAllowedInHostedCheckout("mcp", ["--dir", h.folder], context);
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

test("a checkout naming no workspace whose id another workspace gains is told so, not that its bundle was deleted", async () => {
  const h = await harness();
  // The host now serves the id in two of the person's workspaces: the bare id selects neither,
  // and the list names each by its reference.
  const listed: string[] = [];
  h.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.slice("/sync/v1/".length);
    if (route === "capabilities") return Response.json({ error: { code: "bundle_not_found", message: "The bundle is unavailable for this operation.", retryable: false } }, { status: 404 });
    if (route === "bundles") {
      return Response.json({
        ok: true,
        operationId: "bundles.list.v1",
        data: { bundles: listed.map((bundleId) => ({ bundleId, name: bundleId, purpose: "", domains: [], lifecycle: "active", sensitivity: "internal" })) },
      });
    }
    return h.host.fetch(input, init);
  }) as typeof fetch;
  listed.push(`north/${BUNDLE}`, `south/${BUNDLE}`);
  const { error } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.details?.reason, "ambiguous_bundle");
  assert.deepEqual(error.details?.references, [`north/${BUNDLE}`, `south/${BUNDLE}`]);
  assert.match(error.help ?? "", /checkout --adopt .* --host https:\/\/hosted\.example --workspace <workspace>/);
  // Listed bare in one workspace and by reference in another, or bare twice: still ambiguous.
  for (const shape of [[BUNDLE, `north/${BUNDLE}`], [BUNDLE, BUNDLE]]) {
    listed.splice(0, listed.length, ...shape);
    assert.equal((await failingSync(h)).error.details?.reason, "ambiguous_bundle", shape.join(","));
  }
  // Gone from every workspace: the bundle is gone.
  listed.length = 0;
  assert.equal((await failingSync(h)).error.details?.reason, "bundle_deleted_remotely");
});

// ── the bundle's front page (the root index.md), lane front-page ───────────────────────────────

const ROOT_V1 = "sha256:2d4238b1970c24a72552dc8e00a8ec0afa9a66d5f56418f8ac2fe5498945b107";
const frontPage = (title: string, extra = "") => `---\nokf_version: "0.2"\ntitle: ${title}\n---\n# ${title}\n${extra}`;
const rootFile = (h: Harness) => path.join(h.folder, "index.md");

test("an edited front page is sent against the host's version where the host takes root writes, with no request identity", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  // A root `index generate` rewrote (its generator marker) is an ordinary edit, and is sent like one.
  const edited = frontPage("Team knowledge, revised", "<!-- agentstate-lite:generated-index:v1 -->\n- [Alpha](notes/alpha.md)\n");
  await writeFile(rootFile(h), edited);
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced", JSON.stringify(receipt));
  const row = rowFor(receipt, "index.md")!;
  assert.equal(row.state, "committed");
  assert.equal(h.host.root()?.content, edited, "the host stores the file's exact bytes");
  assert.equal(row.version, h.host.root()?.version);
  const [call] = h.host.rootCalls;
  assert.equal(h.host.rootCalls.length, 1);
  assert.deepEqual(call!.body, { bundleId: BUNDLE, content: edited, expectedVersion: ROOT_V1 });
  assert.equal(call!.writeRequest, null, "a root write is not identified: no X-Superbee-Write-Request");
  assert.match(call!.binding!, /^sha256:[0-9a-f]{64}$/);
  assert.equal(writeRoutes(h).length, 0, "nothing goes through the document routes");

  // Up to date after: nothing is sent again, and a second edit goes against the new version.
  assert.equal((await runSync(h)).status, "up_to_date");
  assert.equal(h.host.rootCalls.length, 1);
  await writeFile(rootFile(h), frontPage("Third"));
  assert.equal(rowFor(await runSync(h), "index.md")?.state, "committed");
  assert.equal(h.host.rootCalls[1]!.body.expectedVersion, row.version);
});

test("without root writes the edited front page stays held as before: an older host, or one that refuses them", async () => {
  for (const host of [new FakeHost(), new FakeHost({ rootWrites: "refused" })]) {
    const h = await harness(host);
    await writeFile(rootFile(h), frontPage("Changed"));
    const { error, receipt } = await failingSync(h);
    assert.equal(error.code, "CONFLICT");
    const row = rowFor(receipt, "index.md")!;
    assert.deepEqual([row.state, row.reason], ["held", "reserved_file"]);
    assert.match(row.message, /^the bundle's root index is edited in the Superbee app\./);
    assert.equal(h.host.rootCalls.length, 0, "nothing is sent to the root route");
    assert.equal(h.host.root()?.version, ROOT_V1);
  }
});

test("with root writes, a subdirectory index.md and every log.md stay held", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  await writeFile(path.join(h.folder, "notes", "index.md"), "---\ntitle: Notes\n---\n# Notes\n");
  await writeFile(path.join(h.folder, "log.md"), "# Log\n");
  await writeFile(path.join(h.folder, "notes", "log.md"), "# Notes log\n");
  const { receipt } = await failingSync(h);
  const reasons = Object.fromEntries(rowsOf(receipt).map((row) => [row.id, [row.state, row.reason]]));
  assert.deepEqual(reasons, { "log.md": ["held", "reserved_file"], "notes/index.md": ["held", "reserved_file"], "notes/log.md": ["held", "reserved_file"] });
  assert.equal(h.host.rootCalls.length, 0);
});

test("a front page changed on the host replaces an unedited file, and the base moves with it", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const hostPage = frontPage("Renamed on the host");
  const hostVersion = h.host.putRoot(hostPage);
  const receipt = await runSync(h);
  assert.equal(receipt.status, "up_to_date", JSON.stringify(receipt));
  assert.equal((receipt.pulled as { refreshed: number }).refreshed, 1);
  assert.equal(await readFile(rootFile(h), "utf8"), hostPage);
  assert.equal(h.host.rootCalls.length, 0, "a pull sends nothing");
  // The next edit is sent against the version pulled, not the one the checkout started from.
  await writeFile(rootFile(h), frontPage("Mine"));
  await runSync(h);
  assert.equal(h.host.rootCalls[0]!.body.expectedVersion, hostVersion);
});

test("an edited front page the host also changed is a conflict: nothing is sent or merged, and take places the host's", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const hostPage = frontPage("Theirs");
  h.host.putRoot(hostPage);
  await writeFile(rootFile(h), frontPage("Mine"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  const row = rowFor(receipt, "index.md")!;
  assert.deepEqual([row.state, row.reason], ["conflict", "changed_remotely"]);
  assert.equal(h.host.rootCalls.length, 0, "nothing is sent over the host's change");
  assert.equal(await readFile(rootFile(h), "utf8"), frontPage("Mine"), "the file keeps the edit");
  assert.match(String((receipt!.help as string[])[0]), new RegExp(`sync --inspect --doc index.md --dir ${h.folder}$`));
  // Still a conflict on the next run: the base did not move.
  assert.equal(rowFor((await failingSync(h)).receipt, "index.md")?.state, "conflict");

  const review = await runSync(h, ["--inspect", "--doc", "index.md"]);
  assert.equal(review.conflict, "index.md");
  assert.equal((review.base as { version: string }).version, ROOT_V1);
  assert.equal((review.remote as { content: string }).content, hostPage);
  assert.match(String((review.local as { content: string }).content), /Mine/);

  const resolved = await runSync(h, ["--resolve", "take", "--doc", "index.md"]);
  assert.equal(resolved.file_state, "replaced");
  assert.equal(await readFile(rootFile(h), "utf8"), hostPage);
  assert.equal((await runSync(h)).status, "up_to_date");
  assert.equal(h.host.rootCalls.length, 0);
});

test("keep on a front-page conflict needs an --inspect of the host's version, then the next sync replaces it", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const theirs = h.host.putRoot(frontPage("Theirs"));
  const mine = frontPage("Mine");
  await writeFile(rootFile(h), mine);
  await failingSync(h);
  const blind = await failingSync(h, ["--resolve", "keep", "--doc", "index.md"]);
  assert.equal(blind.error.details?.reason, "not_inspected");
  await runSync(h, ["--inspect", "--doc", "index.md"]);
  // The host moved again after the inspection: keep would overwrite a version never shown.
  const newer = h.host.putRoot(frontPage("Theirs, again"));
  assert.equal((await failingSync(h, ["--resolve", "keep", "--doc", "index.md"])).error.details?.reason, "stale_review");
  await runSync(h, ["--inspect", "--doc", "index.md"]);
  const resolved = await runSync(h, ["--resolve", "keep", "--doc", "index.md"]);
  assert.equal(resolved.sent, false);
  assert.equal(resolved.file_state, "unchanged");
  assert.equal(h.host.rootCalls.length, 0, "a resolution sends nothing");
  assert.notEqual(newer, theirs);

  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "index.md")?.state, "committed");
  assert.equal(h.host.rootCalls[0]!.body.expectedVersion, newer, "sent against the host's version the person kept theirs over");
  assert.equal(h.host.root()?.content, mine);
});

test("a front-page write whose answer was lost is settled by the host's root version, now or on the next run, and never sent twice", async () => {
  // Applied, answer lost: the re-read finds the bytes sent.
  const landed = await harness(new FakeHost({ rootWrites: "allowed" }));
  landed.host.rootHook = () => ({ kind: "apply-then-drop" });
  await writeFile(rootFile(landed), frontPage("Mine"));
  const first = await runSync(landed);
  assert.equal(rowFor(first, "index.md")?.state, "committed", JSON.stringify(first));
  assert.equal(landed.host.root()?.content, frontPage("Mine"));
  landed.host.rootHook = undefined;
  assert.equal((await runSync(landed)).status, "up_to_date");
  assert.equal(landed.host.rootCalls.length, 1);

  // Not applied, answer lost: the re-read finds the base, and the next sync sends it.
  const dropped = await harness(new FakeHost({ rootWrites: "allowed" }));
  dropped.host.rootHook = () => ({ kind: "drop" });
  await writeFile(rootFile(dropped), frontPage("Mine"));
  const lost = await failingSync(dropped);
  assert.deepEqual([rowFor(lost.receipt, "index.md")?.state, rowFor(lost.receipt, "index.md")?.reason], ["paused", "not_landed"]);
  dropped.host.rootHook = undefined;
  assert.equal(rowFor(await runSync(dropped), "index.md")?.state, "committed");
  assert.equal(dropped.host.rootCalls.length, 2);

  // Applied, answer lost, and the re-read fails too: the next run settles it without sending.
  const later = await harness(new FakeHost({ rootWrites: "allowed" }));
  later.host.rootHook = () => ({ kind: "apply-then-drop" });
  let capabilityReads = 0;
  later.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/capabilities") && later.host.rootCalls.length > 0 && capabilityReads++ === 0) throw new TypeError("fetch failed");
    return later.host.fetch(input, init);
  }) as typeof fetch;
  await writeFile(rootFile(later), frontPage("Mine"));
  const unknown = await failingSync(later);
  assert.deepEqual([rowFor(unknown.receipt, "index.md")?.state, rowFor(unknown.receipt, "index.md")?.reason], ["unknown", "possibly_delivered"]);
  later.host.rootHook = undefined;
  // Edited again before the next run: the settled write is the base the new edit goes against,
  // never a conflict with the person's own landed write.
  await writeFile(rootFile(later), frontPage("Next"));
  const settled = await runSync(later);
  assert.equal(rowFor(settled, "index.md")?.state, "committed", JSON.stringify(settled));
  assert.equal(later.host.rootCalls.length, 2, "the landed write is never sent again");
  assert.equal(later.host.rootCalls[1]!.body.content, frontPage("Next"));
  assert.equal(later.host.rootCalls[1]!.body.expectedVersion, `sha256:${createHash("sha256").update(frontPage("Mine")).digest("hex")}`, "the settled write is the new base");
});

test("a front page the host would refuse, or over the 64 KiB a write carries, is held and never sent", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  await writeFile(rootFile(h), frontPage("Big", `${"x".repeat(70 * 1024)}\n`));
  const big = await failingSync(h);
  assert.deepEqual([rowFor(big.receipt, "index.md")?.state, rowFor(big.receipt, "index.md")?.reason], ["held", "too_large"]);
  await writeFile(rootFile(h), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(frontPage("BOM"))]));
  const bom = await failingSync(h);
  assert.deepEqual([rowFor(bom.receipt, "index.md")?.state, rowFor(bom.receipt, "index.md")?.reason], ["held", "not_sendable"]);
  assert.equal(h.host.rootCalls.length, 0);
  // The host's own refusal (an edition change) is a refused row naming its code; nothing changed there.
  await writeFile(rootFile(h), `---\nokf_version: "0.1"\ntitle: Old\n---\n`);
  const refused = await failingSync(h);
  assert.deepEqual([rowFor(refused.receipt, "index.md")?.state, rowFor(refused.receipt, "index.md")?.reason], ["refused", "validation_failed"]);
  assert.equal(h.host.root()?.version, ROOT_V1);
});

test("a stale base the host reports on the write itself is a front-page conflict", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  h.host.rootHook = () => {
    h.host.rootHook = undefined;
    return { kind: "respond", status: 200, body: { ok: false, operationId: "bundles.root.replace.v1", error: { code: "version_conflict", message: "stale", retryable: false, writeState: "not_applied" } } };
  };
  await writeFile(rootFile(h), frontPage("Mine"));
  const { receipt } = await failingSync(h);
  assert.deepEqual([rowFor(receipt, "index.md")?.state, rowFor(receipt, "index.md")?.reason], ["conflict", "changed_remotely"]);
});

test("a copied folder adopted with a front page that differs from the host's is a conflict, never sent over the host's", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const copy = path.join(h.cwd, "copy");
  await cp(h.folder, copy, { recursive: true });
  await writeFile(path.join(copy, "index.md"), frontPage("Mine"));
  const out: string[] = [];
  await checkout(["--adopt", copy, "--host", HOST], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  const adopted = decode(out.at(-1)!.trim()) as Record<string, unknown>;
  assert.match(String(adopted.root_index), /^kept \(differs/);
  h.folder = await realpath(copy);
  const { receipt } = await failingSync(h);
  assert.deepEqual([rowFor(receipt, "index.md")?.state, rowFor(receipt, "index.md")?.reason], ["conflict", "changed_remotely"]);
  assert.equal(h.host.rootCalls.length, 0);
});

// ── front page: review fixes (links, folders, keep, legacy records, pull-only, recovery, status) ──

/** The checkout's projection record file, read and written as JSON. */
async function projectionRecord(h: Harness): Promise<{ file: string; record: Record<string, unknown> }> {
  const binding = await bindingForPath(h.home, h.folder);
  assert.ok(binding);
  const file = path.join(checkoutDir(h.home, binding.checkout_id), "projection.json");
  return { file, record: JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> };
}

const versionOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("a front page that is a symbolic link is held under index.md alone: nothing outside the folder is read, sent or replaced", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const outside = path.join(h.cwd, "outside.md");
  await writeFile(outside, frontPage("Outside the checkout"));
  await unlink(rootFile(h));
  await symlink(outside, rootFile(h));
  h.host.putRoot(frontPage("Theirs"));
  const { receipt } = await failingSync(h);
  const rows = rowsOf(receipt).filter((row) => row.id === "index.md" || row.id === "index");
  assert.deepEqual(rows.map((row) => [row.id, row.state, row.reason]), [["index.md", "held", "symlink"]], "one row, one id");
  assert.equal(h.host.rootCalls.length, 0, "the link's target is never sent");
  assert.equal(await readFile(outside, "utf8"), frontPage("Outside the checkout"), "the host's front page is never placed through the link");
});

test("a front page that is a folder is held, and the rest of the sync goes on", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  await unlink(rootFile(h));
  await mkdir(rootFile(h));
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha, while index.md is a folder.\n"));
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  assert.deepEqual([rowFor(receipt, "index.md")?.state, rowFor(receipt, "index.md")?.reason], ["held", "unsafe_path"]);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.equal(h.host.rootCalls.length, 0);
});

test("after keep on a front-page conflict, the file is sent as it is at the next sync, even when it went back to its old bytes", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  const original = await readFile(rootFile(h), "utf8");
  const theirs = h.host.putRoot(frontPage("Theirs"));
  await writeFile(rootFile(h), frontPage("Mine"));
  await failingSync(h);
  await runSync(h, ["--inspect", "--doc", "index.md"]);
  await runSync(h, ["--resolve", "keep", "--doc", "index.md"]);
  await writeFile(rootFile(h), original);
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "index.md")?.state, "committed", JSON.stringify(receipt));
  assert.deepEqual(h.host.rootCalls.map((call) => [call.body.content, call.body.expectedVersion]), [[original, theirs]]);
  assert.equal(h.host.root()?.content, original, "the folder and the host agree again");
});

test("a record from before root writes: an edited front page is a conflict, never sent over the host's; an unedited one is refreshed", async () => {
  const edited = await harness(new FakeHost({ rootWrites: "allowed" }));
  await writeFile(rootFile(edited), frontPage("Edited while held by an older sync"));
  const legacy = await projectionRecord(edited);
  delete legacy.record.rootBase;
  await writeFile(legacy.file, `${JSON.stringify(legacy.record)}\n`);
  const { receipt } = await failingSync(edited);
  assert.deepEqual([rowFor(receipt, "index.md")?.state, rowFor(receipt, "index.md")?.reason], ["conflict", "changed_remotely"]);
  assert.equal(edited.host.rootCalls.length, 0);
  assert.equal(edited.host.root()?.version, ROOT_V1);

  const clean = await harness(new FakeHost({ rootWrites: "allowed" }));
  const record = await projectionRecord(clean);
  delete record.record.rootBase;
  await writeFile(record.file, `${JSON.stringify(record.record)}\n`);
  clean.host.putRoot(frontPage("Theirs"));
  assert.equal((await runSync(clean)).status, "up_to_date");
  assert.equal(await readFile(rootFile(clean), "utf8"), frontPage("Theirs"));
});

test("a pull with no push (a read's pull) refreshes an unedited front page and sends nothing", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  h.host.putRoot(frontPage("Theirs"));
  const binding = await bindingForPath(h.home, h.folder);
  assert.ok(binding);
  const pulled = await hostedPull(binding, { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  assert.deepEqual(pulled, { state: "pulled", refreshed: 1, removed: 0, kept: 0 });
  assert.equal(await readFile(rootFile(h), "utf8"), frontPage("Theirs"));
  // An edited one is left as it is, and nothing is sent.
  h.host.putRoot(frontPage("Theirs again"));
  await writeFile(rootFile(h), frontPage("Mine"));
  await hostedPull(binding, { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  assert.equal(await readFile(rootFile(h), "utf8"), frontPage("Mine"));
  assert.equal(h.host.rootCalls.length, 0);
});

test("recovery after a crash mid-replacement of the front page drops the moved-aside bytes it had placed, and puts back a missing file", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "sb-root-recover-"));
  const placed = frontPage("Placed");
  const projection = { files: {}, root: versionOf(placed) };
  // Crashed after the new bytes were linked: the pre-image is the recorded root, so it goes.
  await writeFile(path.join(folder, "index.md"), frontPage("Host's"));
  await writeFile(path.join(folder, ".index.md.superbee-pre-abc123.tmp"), placed);
  await recoverPlacements(folder, projection);
  assert.deepEqual((await readdir(folder)).sort(), ["index.md"]);
  // Crashed before: the name is free, and the pre-image goes back under it.
  await unlink(path.join(folder, "index.md"));
  await writeFile(path.join(folder, ".index.md.superbee-pre-def456.tmp"), placed);
  await recoverPlacements(folder, projection);
  assert.equal(await readFile(path.join(folder, "index.md"), "utf8"), placed);
  assert.deepEqual(await readdir(folder), ["index.md"]);
});

test("status shows a front-page conflict the last sync reported as a conflict, not as an unsent change", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  h.host.putRoot(frontPage("Theirs"));
  await writeFile(rootFile(h), frontPage("Mine"));
  await failingSync(h);
  const { sync: state } = await hostedStatus((await bindingForPath(h.home, h.folder))!, h.home);
  assert.equal(state.conflicts, 1);
  assert.deepEqual(state.conflict_ids, ["index.md"]);
  assert.equal(state.unsent, 0);
});

test("a front-page write the host denies (403) is access withdrawn, and a malformed-request 400 never blames the file", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  await writeFile(rootFile(h), frontPage("Mine"));
  h.host.rootHook = () => ({ kind: "respond", status: 403, body: { error: "access_denied" } });
  const denied = await failingSync(h);
  assert.deepEqual([rowFor(denied.receipt, "index.md")?.state, rowFor(denied.receipt, "index.md")?.reason], ["refused", "access_withdrawn"]);
  h.host.rootHook = () => ({ kind: "respond", status: 400, body: { error: { code: "invalid_input" } } });
  const malformed = await failingSync(h);
  const row = rowFor(malformed.receipt, "index.md")!;
  assert.equal(row.state, "refused");
  assert.match(row.message, /malformed/);
  assert.doesNotMatch(row.message, /Edit index\.md/);
});

test("a front-page write that did not land when re-read but lands late is settled as landed, never a conflict with your own write", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  h.host.rootHook = () => ({ kind: "drop" });
  await writeFile(rootFile(h), frontPage("Mine"));
  const lost = await failingSync(h);
  assert.equal(rowFor(lost.receipt, "index.md")?.reason, "not_landed");
  // The dropped request reaches the host after all, and the person edits the file again meanwhile.
  h.host.rootHook = undefined;
  h.host.putRoot(frontPage("Mine"));
  await writeFile(rootFile(h), frontPage("Next"));
  const receipt = await runSync(h);
  assert.equal(rowFor(receipt, "index.md")?.state, "committed", JSON.stringify(receipt));
  assert.equal(h.host.rootCalls.at(-1)!.body.expectedVersion, versionOf(frontPage("Mine")));
  assert.equal(h.host.root()?.content, frontPage("Next"));
});

async function seedCaptureMap(h: Harness, key: string, bytes: Uint8Array, desiredContentType?: string) {
  const binding = (await bindingForPath(h.home, h.folder))!;
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  const scope = { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
  try { await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap({ schemaVersion: 1, scope, entries: [{ key, head: { key, version: digestOf(bytes), contentType: 'application/octet-stream; profile="old"' }, placedDigest: digestOf(bytes), ...(desiredContentType === undefined ? {} : { desiredContentType }) }] })); }
  finally { await store.close(); }
  return binding;
}
function captureFetch(h: Harness, beforeHeads?: () => Promise<void>, allowed = true): typeof fetch {
  return (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith("/heads")) await beforeHeads?.();
    const answer = await h.host.fetch(input, init);
    if (route.endsWith("/capabilities") && answer.status === 200) {
      const caps = await answer.json() as Record<string, unknown> & { limits?: Record<string, unknown> };
      return Response.json({ ...caps, blobWrites: allowed ? "allowed" : "refused", limits: { ...caps.limits, blobWriteBytes: 16 * 1024 * 1024 } });
    }
    return answer;
  }) as typeof fetch;
}
test("tracked blob capture precedes failed pull and survives restart, later edits and in-flight reopen with lookup only", async () => {
  const h = await harness();
  const key = "opaque.bin", file = path.join(h.folder, key), base = Buffer.from("base"), sent = Buffer.from([0, 255, 128, 1]);
  await writeFile(file, base);
  const binding = await seedCaptureMap(h, key, base, 'image/svg+xml; charset="utf-8"');
  await writeFile(file, sent);
  h.fetch = captureFetch(h, async () => { await writeFile(file, "later"); throw new Error("lost document pull"); });
  await failingSync(h);
  let store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  const rows = await store.listBlobIntents();
  assert.equal(rows.length, 1);
  const original = rows[0]!, payload = decodePreparedBlobIntent(original.prepared);
  assert.equal(payload.intent.operationId, "blobs.replace.v1");
  assert.equal(payload.intent.expectedContentType, 'application/octet-stream; profile="old"');
  assert.equal(payload.intent.contentType, 'image/svg+xml; charset="utf-8"');
  assert.deepEqual(Buffer.from(payload.bytesBase64!, "base64"), sent);
  await store.updateBlobIntent(original.requestId, "pending", { state: "in_flight", attempts: 1 }, { guard: (await store.readBlobWithJournal(key)).guard });
  await store.close();
  await writeFile(file, base); // even a revert cannot rewrite the earlier frozen attempt
  h.fetch = captureFetch(h);
  const receipt = (await failingSync(h)).receipt!;
  assert.equal(receipt.status, "incomplete");
  assert.equal((receipt.blobs as any).rows[0].state, "unknown");
  assert.equal((receipt.counts as Record<string, number>).committed, 0);
  store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id), readOnly: true });
  try { const after = await store.listBlobIntents(); assert.equal(after.length, 1); assert.equal(after[0]!.requestId, original.requestId); assert.equal(after[0]!.prepared, original.prepared); assert.equal(after[0]!.state, "unknown"); assert.equal(after[0]!.attempts, 1); }
  finally { await store.close(); }
  assert.ok(h.host.writes.length > 0 && h.host.writes.every(row => row.route === "outcome"));
  assert.ok(!h.host.requests.some(row => /blob-(?:create|replace|delete)$/.test(row.path)));
});
test("pull-only captures legal opaque blobs and reports held without document writes", async () => {
  const h = await harness();
  const key = "data/opaque.bin", file = path.join(h.folder, key), base = Buffer.from("base");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, base);
  const binding = await seedCaptureMap(h, key, base);
  const opaque = Buffer.from([0, 255, 128]);
  await writeFile(file, opaque);
  h.host.put("notes/alpha", { type: "Note", title: "Changed remotely" }, "new remote representation\n");
  h.fetch = captureFetch(h);
  const result = await hostedPull(binding, { auth: h.auth, cwd: h.cwd, fetch: h.fetch, sleep: instant });
  assert.equal(result.state, "pulled");
  assert.ok(result.state === "pulled" && result.held! > 0);
  assert.deepEqual(await readFile(file), opaque);
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id), readOnly: true });
  try { assert.equal((await store.listIntents()).length, 0); assert.equal((await store.listBlobIntents()).length, 1); }
  finally { await store.close(); }
  assert.equal(h.host.writes.length, 0);
});
test("unsupported and UNKNOWN blob baselines remain held with zero blob or document sends", async () => {
  for (const unknown of [false, true]) {
    const h = await harness(), key = "legacy.bin", file = path.join(h.folder, key), base = Buffer.from("old");
    await writeFile(file, base);
    const binding = await seedCaptureMap(h, key, base);
    if (unknown) {
      const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
      try { const value = JSON.parse((await store.readMeta<string>(BLOB_SYNC_META_KEY))!) as { entries: { head?: unknown }[] }; delete value.entries[0]!.head; await store.writeMeta(BLOB_SYNC_META_KEY, JSON.stringify(value)); }
      finally { await store.close(); }
    }
    await writeFile(file, "new local edit");
    h.fetch = captureFetch(h, undefined, unknown);
    const receipt = (await failingSync(h)).receipt!;
    assert.equal(receipt.status, "incomplete");
    assert.equal(rowFor(receipt, key)?.state, "held");
    const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id), readOnly: true });
    try { assert.equal((await store.listBlobIntents()).length, 0); assert.equal((await store.listIntents()).length, 0); }
    finally { await store.close(); }
    assert.equal(h.host.writes.length, 0);
  }
});

/** Only the read family is modeled here; any blob mutation route is a test failure. */
function refreshFetch(h: Harness, rows: { key: string; bytes: Buffer; contentType: string }[]): typeof fetch {
  return (async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (/blob-(?:create|replace|delete)/.test(route)) throw new Error("read-side refresh must not send");
    const heads = rows.map(row => ({ key: row.key, version: digestOf(row.bytes), contentType: row.contentType })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (route.endsWith("/blob-heads")) return Response.json({ schemaVersion: 1, bundleId: BUNDLE, revision: 1, digest: digestOf(Buffer.from(JSON.stringify([1, heads.map(head => [head.key, head.version, head.contentType])]))), total: heads.length, heads, next: null });
    if (route.endsWith("/blob-read")) {
      const request = JSON.parse(String(init?.body)) as { key: string }, row = rows.find(row => row.key === request.key)!;
      return new Response(row.bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(row.bytes.length), "x-superbee-blob-version": digestOf(row.bytes), "x-superbee-content-type": row.contentType } });
    }
    const answer = await h.host.fetch(input, init);
    if (route.endsWith("/capabilities") && answer.status === 200) { const caps = await answer.json() as { limits?: object }; return Response.json({ ...caps, blobReads: "allowed", blobWrites: "refused", limits: { ...caps.limits, blobReadBytes: 16 * 1024 * 1024 } }); }
    return answer;
  }) as typeof fetch;
}
test("sync and pull-only refresh ordinary files once with read-only capabilities and retain document-only defaults", async () => {
  const h = await harness(), key = "opaque.bin", file = path.join(h.folder, key), base = Buffer.from("base");
  await writeFile(file, base); const binding = await seedCaptureMap(h, key, base);
  const bytes = Buffer.from([0, 255, 128]);
  h.fetch = refreshFetch(h, [{ key, bytes, contentType: 'image/svg+xml; profile="first"' }]);
  const receipt = await runSync(h);
  assert.deepEqual(await readFile(file), bytes);
  const pulled = receipt.pulled as { refreshed: number; blobs: { refreshed: number; removed: number } };
  assert.equal(pulled.refreshed, 0); assert.equal(pulled.blobs.refreshed, 1); assert.equal(pulled.blobs.removed, 0); assert.equal((receipt.counts as { committed: number }).committed, 0);
  h.fetch = refreshFetch(h, [{ key, bytes, contentType: 'image/svg+xml; profile="second"' }]);
  const result = await hostedPull(binding, { auth: h.auth, cwd: h.cwd, fetch: h.fetch, sleep: instant });
  assert.equal(result.state, "pulled"); assert.ok(result.state === "pulled" && result.blobs?.metadata_updated === 1); assert.ok(result.state === "pulled" && result.refreshed === 0);
  assert.equal(h.host.writes.length, 0);
  const legacy = await harness(); const old = await runSync(legacy); assert.equal(Object.hasOwn(old.pulled as object, "blobs"), false);
});
test("sync routes blobs confirmation only to the exact recorded ordinary-file deletion set", async () => {
  const h = await harness(), keys = Array.from({ length: 8 }, (_, i) => `opaque${i}.bin`), base = Buffer.from("base");
  const binding = (await bindingForPath(h.home, h.folder))!;
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try {
    const scope = { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
    await store.writeMeta(BLOB_SYNC_META_KEY, encodeBlobSyncMap({ schemaVersion: 1, scope, entries: keys.map(key => ({ key, head: { key, version: digestOf(base), contentType: "x/old" }, placedDigest: digestOf(base) })) }));
  } finally { await store.close(); }
  for (const key of keys) await writeFile(path.join(h.folder, key), base);
  h.fetch = refreshFetch(h, []);
  const first = (await failingSync(h)).receipt!, refusal = (first.pulled as { blobs: { refused_deletions: { token: string; count: number } } }).blobs.refused_deletions;
  assert.match(refusal.token, /^blobs:8:[0-9a-f]{12}$/); assert.equal(refusal.count, 8); assert.equal(first.status, "incomplete");
  const wrong = (await failingSync(h, ["--take-host-deletions", refusal.token.slice(6)])).receipt!;
  assert.equal((wrong.take_host_deletions as { taken: boolean }).taken, false); assert.equal(await readFile(path.join(h.folder, keys[0]!), "utf8"), "base");
  await writeFile(path.join(h.folder, keys[0]!), "local edit after refusal");
  const stale = (await failingSync(h, ["--take-host-deletions", refusal.token])).receipt!;
  assert.equal((stale.take_host_deletions as { taken: boolean }).taken, false);
  assert.equal((stale.pulled as { blobs: { removed: number; refused_deletions?: unknown } }).blobs.removed, 0);
  assert.equal((stale.pulled as { blobs: { refused_deletions?: unknown } }).blobs.refused_deletions, undefined);
  assert.match((stale.take_host_deletions as { message: string }).message, /without that token/);
  for (const key of keys.slice(1)) assert.equal(await readFile(path.join(h.folder, key), "utf8"), "base");
  await writeFile(path.join(h.folder, keys[0]!), base);
  const accepted = await runSync(h, ["--take-host-deletions", refusal.token]);
  assert.equal((accepted.take_host_deletions as { taken: boolean }).taken, true); assert.equal((accepted.pulled as { blobs: { removed: number } }).blobs.removed, 8);
  await assert.rejects(readFile(path.join(h.folder, keys[0]!)), { code: "ENOENT" }); assert.equal(h.host.writes.length, 0);
});


test("offline hosted promote durably admits canonical binary create and MIME replacement without auth or fetch", async () => {
  const h = await harness(), key = "opaque.bin", file = path.join(h.folder, key), bytes = Buffer.from([0, 255, 128]);
  await writeFile(file, bytes); let printed = "";
  const firstAdmission = await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, contentType: 'image/svg+xml; profile="offline"', home: h.home, cwd: h.cwd }); printed = JSON.stringify(firstAdmission!.receipt);
  const receipt = JSON.parse(printed); assert.equal(receipt.promote, "pending"); assert.equal(receipt.submitted, false); assert.equal(receipt.status, "incomplete"); assert.equal(h.host.requests.length, 0);
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try {
    const rows = await store.listBlobIntents(); assert.equal(rows.length, 1); const prepared = decodePreparedBlobIntent(rows[0]!.prepared);
    assert.equal(prepared.intent.operationId, "blobs.create.v1"); assert.equal(prepared.intent.expectedVersion, null); assert.equal(prepared.intent.expectedContentType, null); assert.equal(prepared.intent.contentType, 'image/svg+xml; profile="offline"'); assert.deepEqual(Buffer.from(prepared.bytesBase64!, "base64"), bytes);
    const map = JSON.parse((await store.readMeta<string>(BLOB_SYNC_META_KEY))!); assert.equal(Object.hasOwn(map.entries[0], "head"), false); assert.equal(map.entries[0].placedDigest, null);
    await filesystemPushRoleLocks().request(checkoutLockName(h.folder), {}, async () => { await assert.rejects(promote([file, "--doc-key", key, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /busy/); });
  } finally { await store.close(); }
  const resumed = await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, contentType: 'image/svg+xml; profile="offline"', home: h.home, cwd: h.cwd }); assert.equal(resumed!.resumed, true); assert.deepEqual(resumed!.requestIds, firstAdmission!.requestIds);
  const defaultFile = path.join(h.folder, "new.svg"); await writeFile(defaultFile, "<svg/>"); let defaultOut = "";
  defaultOut = JSON.stringify((await admitOfflineBlob({ operation: "promote", key: "new.svg", source: defaultFile, dir: h.folder, home: h.home, cwd: h.cwd }))!.receipt);
  assert.equal(JSON.parse(defaultOut).content_type, "image/svg+xml");
  const other = await harness(), typeKey = "type.bin", typeFile = path.join(other.folder, typeKey), old = Buffer.from("old"); await writeFile(typeFile, old); const bound = await seedCaptureMap(other, typeKey, old);
  await assert.rejects(promote([typeFile, "--doc-key", typeKey, "--dir", other.folder, "--expected-version", digestOf(Buffer.from("wrong"))], { home: other.home, cwd: other.cwd, stdout() {} }), /baseline/);
  await admitOfflineBlob({ operation: "promote", key: typeKey, source: typeFile, dir: other.folder, expectedVersion: digestOf(old), contentType: "x/type-only", home: other.home, cwd: other.cwd });
  const reopened = await FileJournaledBackend.open({ directory: checkoutStoreDir(other.home, bound.checkout_id) });
  try { const row = (await reopened.listBlobIntents())[0]!, prepared = decodePreparedBlobIntent(row.prepared); assert.equal(prepared.intent.operationId, "blobs.replace.v1"); if (prepared.intent.operationId !== "blobs.replace.v1") throw new Error("expected replacement"); assert.equal(prepared.intent.expectedContentType, 'application/octet-stream; profile="old"'); assert.equal(prepared.intent.contentType, "x/type-only"); assert.equal(prepared.intent.version, digestOf(old)); }
  finally { await reopened.close(); }
  assert.equal(other.host.requests.length, 0);
});
test("offline admission refuses external/hardlink/symlink, namespace and copied bindings before mutation", async () => {
  const h = await harness(), key = "opaque.bin", file = path.join(h.folder, key); await writeFile(file, "target");
  const outside = path.join(h.cwd, "outside.bin"); await writeFile(outside, "external");
  await assert.rejects(promote([outside, "--doc-key", key, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /target pathname/);
  const { link } = await import("node:fs/promises"); await unlink(outside); await link(file, outside);
  await assert.rejects(promote([outside, "--doc-key", key, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /target pathname/);
  await unlink(file); await symlink(outside, file);
  await assert.rejects(promote([file, "--doc-key", key, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /unsafe/);
  for (const protectedKey of ["References/a.bin", "views/a.html", "conventions/x.bin", "../escape.bin"]) await assert.rejects(promote([file, "--doc-key", protectedKey, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /reserved|publisher/);
  const copy = path.join(h.cwd, "copy"); await cp(h.folder, copy, { recursive: true });
  await assert.rejects(deleteCommand(["--doc-key", key, "--dir", copy], { home: h.home, cwd: h.cwd, stdout() {} }), /adopted/);
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try { assert.equal((await store.listBlobIntents()).length, 0); } finally { await store.close(); }
  assert.equal(await readFile(outside, "utf8"), "target"); assert.equal(h.host.requests.length, 0);
});
test("offline opaque delete uses preserved clean pins; failed admission leaves truthful local absence for later scan", async () => {
  for (const failAdmission of [false, true]) {
    const h = await harness(), key = "opaque.bin", file = path.join(h.folder, key), old = Buffer.from("old"); await writeFile(file, old); const binding = await seedCaptureMap(h, key, old);
    await writeFile(file, "dirty"); await assert.rejects(deleteCommand(["--doc-key", key, "--dir", h.folder], { home: h.home, cwd: h.cwd, stdout() {} }), /locally changed/); await writeFile(file, old);
    const original = FileJournaledBackend.prototype.admitPreparedBlob;
    let receipt = "";
    try {
      if (failAdmission) FileJournaledBackend.prototype.admitPreparedBlob = async () => { throw new RangeError("injected admission capacity refusal"); };
      const work = admitOfflineBlob({ operation: "delete", key, dir: h.folder, home: h.home, cwd: h.cwd }).then(admitted => { receipt = JSON.stringify(admitted!.receipt); });
      if (failAdmission) await assert.rejects(work, (error: unknown) => error instanceof CliError && error.details?.reason === "blob_delete_local_unsubmitted" && error.details.local_removed === true && error.details.submitted === false);
      else { await work; assert.equal(JSON.parse(receipt).delete, "pending"); }
    } finally { FileJournaledBackend.prototype.admitPreparedBlob = original; }
    await assert.rejects(readFile(file), { code: "ENOENT" });
    const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
    try { assert.equal((await store.listBlobIntents()).length, failAdmission ? 0 : 1); const map = JSON.parse((await store.readMeta<string>(BLOB_SYNC_META_KEY))!); assert.equal(map.entries[0].head.version, digestOf(old)); assert.equal(map.entries[0].head.contentType, 'application/octet-stream; profile="old"'); }
    finally { await store.close(); }
    if (failAdmission) { h.fetch = captureFetch(h); await failingSync(h); const recovered = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) }); try { assert.equal(decodePreparedBlobIntent((await recovered.listBlobIntents())[0]!.prepared).intent.operationId, "blobs.delete.v1"); } finally { await recovered.close(); } }
    assert.ok(h.host.writes.every(row => row.route === "outcome"));
    if (!failAdmission) assert.ok(!h.host.requests.some(row => /blob-(?:create|replace|delete)$/.test(row.path)));
  }
});

/** Stateful read/write wire seam only; authority and journal selection remain the production owners. */
function blobAuthority(h: Harness, options: { priorDeletes?: number; baseline?: number; beforeWrite?: (key: string) => Promise<void>; lostAck?: boolean; rehold?: boolean; slug?: string; holdDiagnostics?: Record<string, { deletions: number; baseline: number }>; collides?: (key: string) => boolean; createRefusal?: string } = {}) {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>(), outcomes = new Map<string, { binding: string; result: any }>();
  const calls: { key: string; requestId: string; operationId: string; allowance: number | null; bundle: string; via: string | null; expectedVersion?: string | null; expectedType?: string | null; contentType?: string | null }[] = [];
  let deletes = options.priorDeletes ?? 0, dropped = false;
  const fetcher: typeof fetch = (async (input, init) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (route.endsWith("/blob-heads")) {
      const heads = [...objects].map(([key, row]) => ({ key, version: digestOf(row.bytes), contentType: row.contentType })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      return Response.json({ schemaVersion: 1, bundleId: BUNDLE, revision: 1, digest: digestOf(Buffer.from(JSON.stringify([1, heads.map(head => [head.key, head.version, head.contentType])]))), total: heads.length, heads, next: null });
    }
    if (route.endsWith("/blob-read")) { const body = await request.json() as { key: string }, object = objects.get(body.key)!; return new Response(object.bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(object.bytes.length), "x-superbee-blob-version": digestOf(object.bytes), "x-superbee-content-type": object.contentType } }); }
    if (/\/blob-(?:create|replace|delete)$/.test(route)) {
      const deletion = route.endsWith("blob-delete"), body = deletion ? await request.json() as any : undefined;
      const key = deletion ? body.key : Buffer.from(request.headers.get("x-superbee-blob-key")!, "base64url").toString("utf8"), requestId = request.headers.get("x-superbee-write-request")!, binding = request.headers.get("x-superbee-checkout")!;
      const operationId = deletion ? "blobs.delete.v1" : route.endsWith("blob-create") ? "blobs.create.v1" : "blobs.replace.v1";
      const expectedVersion = deletion ? body.expectedVersion : operationId === "blobs.create.v1" ? null : request.headers.get("x-superbee-expected-version"), expectedType = deletion ? body.expectedContentType : operationId === "blobs.create.v1" ? null : request.headers.get("x-superbee-expected-content-type");
      const bundle = deletion ? body.bundleId : request.headers.get("x-superbee-bundle")!;
      assert.equal(bundle, options.slug ? `${options.slug}/${BUNDLE}` : BUNDLE);
      const allowance = request.headers.has("x-superbee-accept-deletes") ? Number(request.headers.get("x-superbee-accept-deletes")) : null;
      calls.push({ key, requestId, operationId, allowance, bundle, via: request.headers.get("x-superbee-via"), expectedVersion, expectedType, contentType: deletion ? null : request.headers.get("x-superbee-content-type") });
      await options.beforeWrite?.(key);
      if (deletion && (options.rehold || (deletes + 1 > (options.baseline ?? 10) / 2 && (allowance === null || allowance < deletes + 1)))) return Response.json({ error: { code: "deletions_held", message: "person confirmation required", retryable: false, writeState: "not_applied", deletions: options.holdDiagnostics?.[key]?.deletions ?? deletes + 1, baseline: options.holdDiagnostics?.[key]?.baseline ?? options.baseline ?? 10 } }, { status: 428 });
      const existing = objects.get(key), actual = existing ? digestOf(existing.bytes) : null;
      // As hosted answers a create refused before any write: a 200 with no settled marker, nothing recorded.
      if (operationId === "blobs.create.v1" && !existing && options.collides?.(key)) return Response.json({ ok: false, operationId, error: { code: options.createRefusal ?? "path_collision", message: "Another file or document in this bundle differs from this path only by letter case or Unicode form. Nothing was written.", retryable: false, writeState: "not_applied" } });
      let result: any;
      if (expectedVersion !== actual || expectedType !== (existing?.contentType ?? null)) result = { ok: false, operationId, error: { code: "version_conflict", message: "head changed", retryable: false, writeState: "not_applied", expected: expectedVersion, actual, expectedContentType: expectedType, actualContentType: existing?.contentType ?? null } };
      else if (deletion) { deletes++; objects.delete(key); result = { ok: true, operationId, data: { key, version: actual, contentType: existing!.contentType, deleted: true } }; }
      else { const bytes = Buffer.from(await request.arrayBuffer()), contentType = request.headers.get("x-superbee-content-type")!; assert.equal(digestOf(bytes), request.headers.get("x-superbee-blob-version")); objects.set(key, { bytes, contentType }); result = { ok: true, operationId, data: { key, version: digestOf(bytes), contentType, changed: !existing || actual !== digestOf(bytes) || existing.contentType !== contentType } }; }
      outcomes.set(requestId, { binding, result });
      if (options.lostAck && !dropped) { dropped = true; throw new Error("lost mutation ACK"); }
      return Response.json(result, { headers: { "x-superbee-write-settled": requestId } });
    }
    if (route.endsWith("/outcome")) {
      const body = await request.clone().json() as any;
      if (String(body.operationId).startsWith("blobs.")) {
        const requestId = request.headers.get("x-superbee-write-request")!, binding = request.headers.get("x-superbee-checkout")!, terminal = outcomes.get(requestId);
        return Response.json({ schemaVersion: 1, requestId, binding, status: terminal ? terminal.result.ok ? "committed" : "refused" : "absent", ...(terminal ? { result: terminal.result } : {}) });
      }
    }
    const answer = await h.host.fetch(input, init);
    if (route.endsWith("/capabilities") && answer.status === 200) { const caps = await answer.json() as { limits?: object }; return Response.json({ ...caps, blobReads: "allowed", blobWrites: "allowed", limits: { ...caps.limits, blobReadBytes: 16 * 1024 * 1024, blobWriteBytes: 16 * 1024 * 1024 } }); }
    return answer;
  }) as typeof fetch;
  return { fetch: fetcher, objects, outcomes, calls, setDeletes: (count: number) => { deletes = count; } };
}
function commandDeps(h: Harness, wire: ReturnType<typeof blobAuthority>, out: string[] = []) {
  return { home: h.home, cwd: h.cwd, stdout: (text: string) => { out.push(text); }, hosted: { auth: h.auth, fetch: wire.fetch, write: { sleep: instant, lookupDelayMs: 0, maxLookups: 1 }, sleep: instant } };
}
async function retainedBlobRows(h: Harness) {
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try { return await store.listBlobIntents(); } finally { await store.close(); }
}
test("targeted promote freezes before auth/gate, resumes exactly, and leaves unrelated docs/root/blobs untouched", async () => {
  const h = await harness(), key = "selected.svg", file = path.join(h.folder, key), bytes = Buffer.from([0, 255, 128]), output: string[] = [];
  await writeFile(file, bytes); const wire = blobAuthority(h), deps = commandDeps(h, wire, output);
  const { execFileSync } = await import("node:child_process"); execFileSync("git", ["init", "-q", h.folder]); execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", "exit 3"]);
  await assert.rejects(promote([file, "--doc-key", key, "--content-type", "image/svg+xml; profile=exact", "--dir", h.folder], deps), (error: unknown) => error instanceof CliError && error.code === "GATE_FAILED");
  const frozen = (await retainedBlobRows(h))[0]!; assert.equal(frozen.attempts, 0); assert.equal(wire.calls.length, 0);
  await writeFile(file, "changed after failure"); await assert.rejects(promote([file, "--doc-key", key, "--content-type", "image/svg+xml; profile=exact", "--dir", h.folder], deps), /differs.*bytes or MIME/); assert.equal(wire.calls.length, 0); await writeFile(file, bytes);
  await assert.rejects(promote([file, "--doc-key", key, "--content-type", "x/different", "--dir", h.folder], deps), /differs/);
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try { await store.writeJournaled("notes/unrelated", { id: "notes/unrelated", frontmatter: { type: "Note" }, body: "private pending" }, { intent: { requestId: "unrelated-document", target: "notes/unrelated", kind: "document.write", base: null, baseContent: null, createdAt: new Date().toISOString() } }); }
  finally { await store.close(); }
  const other = path.join(h.folder, "other.bin"); await writeFile(other, "pending other"); await admitOfflineBlob({ operation: "promote", key: "other.bin", source: other, dir: h.folder, home: h.home, cwd: h.cwd });
  await writeFile(path.join(h.folder, "index.md"), "changed root deliberately not sent");
  execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", "exit 0"]);
  await promote([file, "--doc-key", key, "--content-type", "image/svg+xml; profile=exact", "--dir", h.folder, "--json"], deps);
  assert.equal(JSON.parse(output.at(-1)!).promote, "committed"); assert.equal(wire.calls.length, 1); assert.equal(wire.calls[0]!.requestId, frozen.requestId); assert.deepEqual(wire.objects.get(key)?.bytes, bytes); assert.equal(h.host.writes.length, 0); assert.equal(h.host.rootCalls.length, 0);
  const rows = await retainedBlobRows(h); assert.equal(rows.find(row => row.requestId === frozen.requestId)?.attempts, 1); assert.equal(rows.find(row => row.target === "other.bin")?.attempts, 0);
  await promote([file, "--doc-key", key, "--content-type", "image/svg+xml; profile=exact", "--dir", h.folder], deps); assert.equal(wire.calls.length, 1);
});
test("targeted authentication failure retains exact admitted identity and unchanged retry uses it", async () => {
  const h = await harness(), key = "auth.bin", file = path.join(h.folder, key); await writeFile(file, "frozen"); const wire = blobAuthority(h), good = commandDeps(h, wire);
  const denied = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input).endsWith("/whoami") ? Response.json({ error: { code: "unauthenticated", message: "expired" } }, { status: 401 }) : wire.fetch(input, init)) as typeof fetch;
  await assert.rejects(promote([file, "--doc-key", key, "--dir", h.folder], { ...good, hosted: { ...good.hosted, fetch: denied } }), (error: unknown) => error instanceof CliError && error.code === "AUTH_REQUIRED");
  const before = (await retainedBlobRows(h))[0]!; assert.equal(before.attempts, 0); assert.equal(wire.calls.length, 0);
  await promote([file, "--doc-key", key, "--dir", h.folder], good); assert.equal(wire.calls[0]!.requestId, before.requestId);
});
test("blob-only declared gate edits or preexisting frozen mismatch hold without claims; normal sync shares gate", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const mutate of [false, true]) {
    const h = await harness(), key = "gate.bin", file = path.join(h.folder, key); await writeFile(file, "frozen"); const binding = (await bindingForPath(h.home, h.folder))!;
    const admission = (await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, home: h.home, cwd: h.cwd }))!;
    const wire = blobAuthority(h); h.fetch = wire.fetch; execFileSync("git", ["init", "-q", h.folder]); execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", mutate ? "printf newer > gate.bin" : "exit 0"]);
    if (!mutate) await writeFile(file, "newer before gate");
    const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js");
    const deliver = () => deliverHostedBlobRequests(binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch, cwd: h.cwd, write: { sleep: instant, maxLookups: 1 } });
    if (mutate) await assert.rejects(deliver(), (error: unknown) => error instanceof CliError && error.code === "GATE_FAILED");
    else assert.equal((await deliver()).counts.held, 1); assert.equal(wire.calls.length, 0); assert.equal((await retainedBlobRows(h))[0]!.attempts, 0); assert.equal(await readFile(file, "utf8"), mutate ? "newer" : "newer before gate");
  }
  const h = await harness(), key = "normal.bin", file = path.join(h.folder, key); await writeFile(file, "old"); await seedCaptureMap(h, key, Buffer.from("old")); await writeFile(file, "new");
  const wire = blobAuthority(h); wire.objects.set(key, { bytes: Buffer.from("old"), contentType: 'application/octet-stream; profile="old"' }); h.fetch = wire.fetch;
  execFileSync("git", ["init", "-q", h.folder]); execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", "exit 3"]);
  await assert.rejects(runSync(h), (error: unknown) => error instanceof CliError && error.code === "GATE_FAILED"); assert.equal(wire.calls.length, 0); assert.equal((await retainedBlobRows(h))[0]!.attempts, 0);
  execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", "exit 0"]); const sent = await runSync(h);
  assert.equal(sent.status, "synced"); assert.equal((sent.blobs as any).counts.committed, 1); assert.equal((sent.counts as any).committed, 0); assert.equal((sent.counts as any).held, 0); assert.equal(wire.calls.length, 1);
});

async function heldBlobDeletes(count: number, diagnostics?: Record<string, { deletions: number; baseline: number }>) {
  const h = await harness(), wire = blobAuthority(h, { priorDeletes: 7, holdDiagnostics: diagnostics }); h.fetch = wire.fetch;
  const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js");
  const binding = (await bindingForPath(h.home, h.folder))!, ids: string[] = [], tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = `held-${i}.bin`, bytes = Buffer.from(`frozen-${i}`); await writeFile(path.join(h.folder, key), bytes); await seedCaptureMapMerged(h, key, bytes);
    wire.objects.set(key, { bytes, contentType: 'application/octet-stream; profile="old"' });
    const admission = (await admitOfflineBlob({ operation: "delete", key, expectedVersion: digestOf(bytes), dir: h.folder, home: h.home, cwd: h.cwd }))!; ids.push(...admission.requestIds);
    const held = await deliverHostedBlobRequests(binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch, cwd: h.cwd });
    assert.equal(held.counts.held, 1); tokens.push(held.deletions_held!.token);
  }
  const report = await deliverHostedBlobRequests(binding, ids, { auth: h.auth, fetch: wire.fetch, cwd: h.cwd });
  return { h, wire, binding, ids, tokens, report, deliverHostedBlobRequests };
}
async function seedCaptureMapMerged(h: Harness, key: string, bytes: Uint8Array) {
  const { readBlobSyncState, changeBlobSyncEntry } = await import("../src/hosted/blob-sync.js");
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  const scope = { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
  try { const snapshot = await readBlobSyncState(store, key, scope); await store.writeBlobMeta(key, { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(changeBlobSyncEntry(snapshot.map, { key, head: { key, version: digestOf(bytes), contentType: 'application/octet-stream; profile="old"' }, placedDigest: digestOf(bytes) })) }] }, { guard: snapshot.journal.guard }); } finally { await store.close(); }
}
test("blob held confirmation names three files but sends max historical window plus N, never summed baselines", async () => {
  const f = await heldBlobDeletes(3, { "held-0.bin": { deletions: 8, baseline: 10 }, "held-1.bin": { deletions: 6, baseline: 9 }, "held-2.bin": { deletions: 7, baseline: 11 } });
  assert.equal(f.report.deletions_held?.allowance, 10);
  const before = f.wire.calls.length, out: string[] = [], prompts: string[] = [];
  await sync(["--dir", f.h.folder, "--accept-deletes", f.report.deletions_held!.token, "--json"], { ...commandDeps(f.h, f.wire), auth: f.h.auth, fetch: f.wire.fetch, stdout: text => { out.push(text); }, terminal: { interactive: true, ask: async prompt => { prompts.push(prompt); return "3"; } } });
  assert.equal(JSON.parse(out.at(-1)!).blobs.counts.committed, 3); assert.match(prompts[0]!, /3 deleted ordinary file/); assert.match(prompts[0]!, /allowance is 10, distinct from the 3/);
  assert.deepEqual(f.wire.calls.slice(before).map(row => row.allowance), [10, 10, 10]); assert.deepEqual(f.wire.calls.slice(before).map(row => row.requestId).sort(), [...f.ids].sort());
  assert.ok((await retainedBlobRows(f.h)).every(row => row.state === "acknowledged" && row.attempts === 2)); assert.equal(f.h.host.writes.length, 0); assert.equal(f.h.host.rootCalls.length, 0);
});
test("blob acceptance is person-only and exact-set addressed; singleton survives unrelated holds while full set changes invalidate", async () => {
  const f = await heldBlobDeletes(3), before = f.wire.calls.length;
  await assert.rejects(f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch, terminal: { interactive: false, ask: async () => { throw new Error("agent must not be prompted"); } } }, f.report.deletions_held!.token), (error: unknown) => error instanceof CliError && error.details?.reason === "needs_person_at_terminal");
  assert.equal(f.wire.calls.length, before);
  const wrong = await f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch }, "blobs:3:000000000000"); assert.equal(wrong.counts.held, 3); assert.equal(f.wire.calls.length, before);
  // A fourth current hold invalidates the old full set, without inventing arbitrary subset matching.
  const key = "held-3.bin", bytes = Buffer.from("fourth"); await writeFile(path.join(f.h.folder, key), bytes); await seedCaptureMapMerged(f.h, key, bytes); f.wire.objects.set(key, { bytes, contentType: 'application/octet-stream; profile="old"' });
  const admission = (await admitOfflineBlob({ operation: "delete", key, expectedVersion: digestOf(bytes), dir: f.h.folder, home: f.h.home, cwd: f.h.cwd }))!;
  await f.deliverHostedBlobRequests(f.binding, admission.requestIds, { auth: f.h.auth, fetch: f.wire.fetch }); const afterFourth = f.wire.calls.length;
  const stale = await f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch, terminal: { interactive: true, ask: async () => { throw new Error("stale token must not prompt"); } } }, f.report.deletions_held!.token); assert.equal(stale.counts.held, 4); assert.equal(f.wire.calls.length, afterFourth);
  const singleton = await f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch, terminal: { interactive: true, ask: async prompt => { assert.match(prompt, /Type 1/); return "1"; } } }, f.tokens[0]);
  assert.equal(singleton.counts.committed, 1); assert.equal(f.wire.calls.length, afterFourth + 1); assert.equal(f.wire.calls.at(-1)!.requestId, f.ids[0]); assert.equal((await retainedBlobRows(f.h)).filter(row => row.state === "pending").length, 3);
});
test("held delete rechecks physical absence and window growth without implicit escalation or automatic resend", async () => {
  const f = await heldBlobDeletes(1), before = f.wire.calls.length;
  await writeFile(path.join(f.h.folder, "held-0.bin"), "recreated");
  const changed = await f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch, terminal: { interactive: true, ask: async () => { throw new Error("recreated target must not prompt"); } } }, f.tokens[0]); assert.equal(changed.counts.held, 1); assert.equal(f.wire.calls.length, before);
  await unlink(path.join(f.h.folder, "held-0.bin")); f.wire.setDeletes(9);
  const heldAgain = await f.deliverHostedBlobRequests(f.binding, undefined, { auth: f.h.auth, fetch: f.wire.fetch, terminal: { interactive: true, ask: async () => "1" } }, f.tokens[0]);
  assert.equal(heldAgain.counts.held, 1); assert.equal(f.wire.calls.at(-1)!.allowance, 8); assert.equal(f.wire.calls.length, before + 1);
  const row = (await retainedBlobRows(f.h))[0]!; assert.equal(row.attempts, 2); assert.equal(row.notAppliedThrough, 2); assert.equal(row.deletionHold?.deletions, 10);
  const lookupOnly = await f.deliverHostedBlobRequests(f.binding, f.ids, { auth: f.h.auth, fetch: f.wire.fetch }); assert.equal(lookupOnly.counts.held, 1); assert.equal(f.wire.calls.length, before + 1);
});
test("blob delivery keeps edits made during wire dispatch dirty and recovers lost ACK without resend", async () => {
  const h = await harness(), key = "late.bin", file = path.join(h.folder, key), original = Buffer.from("original"); await writeFile(file, original);
  const admission = (await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, home: h.home, cwd: h.cwd }))!;
  const wire = blobAuthority(h, { lostAck: true, beforeWrite: async () => { await writeFile(file, "newer local edit"); } });
  const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js");
  const result = await deliverHostedBlobRequests(admission.binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch, write: { sleep: instant, maxLookups: 1, lookupDelayMs: 0 } });
  assert.equal(result.counts.committed, 1); assert.deepEqual(result.kept_local_edits, [key]); assert.deepEqual(wire.objects.get(key)?.bytes, original); assert.equal(await readFile(file, "utf8"), "newer local edit"); assert.equal(wire.calls.length, 1);
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, admission.binding.checkout_id) });
  try { const map = JSON.parse((await store.readMeta(BLOB_SYNC_META_KEY))!); assert.equal(map.entries[0].placedDigest, digestOf(original)); } finally { await store.close(); }
  await deliverHostedBlobRequests(admission.binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch }); assert.equal(wire.calls.length, 1);
});

test("blob receipt persistence failure reports unknown then lookup settles original ID without another write", async () => {
  const h = await harness(), key = "persist.bin", file = path.join(h.folder, key); await writeFile(file, "frozen");
  const admission = (await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, home: h.home, cwd: h.cwd }))!, wire = blobAuthority(h);
  const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js"), original = FileJournaledBackend.prototype.updateBlobIntent; let fail = true;
  FileJournaledBackend.prototype.updateBlobIntent = async function (id, state, patch, guard) { if (patch.receipt && fail) { fail = false; throw new RangeError("injected receipt capacity refusal"); } return original.call(this, id, state, patch, guard); };
  try {
    const result = await deliverHostedBlobRequests(admission.binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch }); assert.equal(result.counts.unknown, 1); assert.equal(result.counts.committed, 0);
    const row = (await retainedBlobRows(h))[0]!; assert.equal(row.state, "in_flight"); assert.equal(row.receipt, undefined); assert.equal(row.attempts, 1);
  } finally { FileJournaledBackend.prototype.updateBlobIntent = original; }
  const { readBlobSyncState, changeBlobSyncEntry } = await import("../src/hosted/blob-sync.js");
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, admission.binding.checkout_id) });
  const scope = decodePreparedBlobIntent((await store.listBlobIntents())[0]!.prepared).scope;
  try { const snapshot = await readBlobSyncState(store, key, scope); await store.writeBlobMeta(key, { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(changeBlobSyncEntry(snapshot.map, { ...snapshot.map.entries[0]!, desiredContentType: "x/later-choice" })) }] }, { guard: snapshot.journal.guard }); } finally { await store.close(); }
  const recovered = await deliverHostedBlobRequests(admission.binding, admission.requestIds, { auth: h.auth, fetch: wire.fetch }); assert.equal(recovered.counts.committed, 1); assert.deepEqual(recovered.kept_local_edits, [key]); assert.equal(wire.calls.length, 1); assert.equal((await retainedBlobRows(h))[0]!.attempts, 1);
});
test("blob-only ACK clears stale capture holds but preserves a distinct document with the same concept ID", async () => {
  const h = await harness(), key = "images/chart.svg", file = path.join(h.folder, key); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "old"); await seedCaptureMap(h, key, Buffer.from("old")); await writeFile(file, "new");
  await writeFile(`${file}.md`, "this intentionally lacks a document type");
  const wire = blobAuthority(h); wire.objects.set(key, { bytes: Buffer.from("old"), contentType: 'application/octet-stream; profile="old"' }); h.fetch = wire.fetch;
  const result = await failingSync(h); assert.equal(result.receipt?.status, "incomplete"); assert.equal((result.receipt?.blobs as any).counts.committed, 1);
  const rows = result.receipt?.rows as { id: string; path?: string; reason: string }[]; assert.ok(rows.some(row => row.id === key && row.reason === "not_sendable")); assert.equal(wire.calls.length, 1);
  await unlink(`${file}.md`); const next = await runSync(h); assert.equal(next.status, "up_to_date"); assert.equal(wire.calls.length, 1);
});
test("pull-only captures without sends, and equal-byte MIME conflict remains a durable conflict", async () => {
  const h = await harness(), key = "typed.bin", file = path.join(h.folder, key), bytes = Buffer.from("same bytes"); await writeFile(file, bytes); await seedCaptureMap(h, key, bytes, "x/desired");
  const wire = blobAuthority(h); wire.objects.set(key, { bytes, contentType: "x/concurrent" }); h.fetch = wire.fetch;
  await hostedPull((await bindingForPath(h.home, h.folder))!, { auth: h.auth, cwd: h.cwd, fetch: wire.fetch, sleep: instant }); assert.equal(wire.calls.length, 0); const before = (await retainedBlobRows(h))[0]!; assert.equal(before.attempts, 0);
  const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js"), result = await deliverHostedBlobRequests((await bindingForPath(h.home, h.folder))!, [before.requestId], { auth: h.auth, fetch: wire.fetch });
  assert.equal(result.counts.conflict, 1); assert.equal(wire.objects.get(key)?.contentType, "x/concurrent"); assert.equal((await retainedBlobRows(h))[0]!.receipt?.result.ok, false); assert.equal(await readFile(file, "utf8"), bytes.toString());
});

test("targeted opaque create/type-only replace/delete preserve workspace qualification and original MIME pins", async () => {
  const h = await harness(new FakeHost({ workspaces: [{ tenantId: "tenant-a", slug: "team" }], slug: "team" }));
  const folder = path.join(h.cwd, "qualified"); await checkout([`team/${BUNDLE}`, "--host", HOST, "--dir", folder], { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch }); h.folder = folder;
  const wire = blobAuthority(h, { slug: "team" }), key = "opaque.svg", file = path.join(folder, key), bytes = Buffer.from([0, 255, 128]); await writeFile(file, bytes);
  await promote([file, "--doc-key", key, "--dir", folder, "--content-type", "image/svg+xml; profile=original"], commandDeps(h, wire));
  const version = digestOf(bytes);
  await promote([file, "--doc-key", key, "--dir", folder, "--expected-version", version, "--content-type", "image/svg+xml; profile=revised"], commandDeps(h, wire));
  assert.equal(wire.objects.get(key)?.contentType, "image/svg+xml; profile=revised"); assert.deepEqual(wire.objects.get(key)?.bytes, bytes);
  await deleteCommand(["--doc-key", key, "--dir", folder, "--expected-version", version], commandDeps(h, wire));
  assert.deepEqual(wire.calls.map(row => row.operationId), ["blobs.create.v1", "blobs.replace.v1", "blobs.delete.v1"]); assert.ok(wire.calls.every(row => row.bundle === `team/${BUNDLE}`)); assert.equal(wire.objects.has(key), false);
  const rows = await retainedBlobRows(h), deleted = rows.at(-1)!; assert.equal(deleted.receipt?.result.ok && deleted.receipt.result.data.contentType, "image/svg+xml; profile=revised"); assert.equal(deleted.receipt && "head" in deleted.receipt && deleted.receipt.head, null); assert.equal(decodePreparedBlobIntent(deleted.prepared).scope.workspaceSlug, "team");
  await deleteCommand(["--doc-key", key, "--dir", folder, "--expected-version", version], commandDeps(h, wire)); assert.equal(wire.calls.length, 3);
  await writeFile(file, "recreated after delete"); await assert.rejects(deleteCommand(["--doc-key", key, "--dir", folder, "--expected-version", version], commandDeps(h, wire)), /preserved observed digest/); assert.equal(wire.calls.length, 3); assert.equal(await readFile(file, "utf8"), "recreated after delete");
});

test("historical blob ACK reuse requires its current acknowledged baseline; conflict terminals do not cache new explicit commands", async () => {
  const h = await harness(), key = "historical.bin", file = path.join(h.folder, key), bytes = Buffer.from("same bytes"); await writeFile(file, bytes);
  const wire = blobAuthority(h), output: string[] = [], deps = commandDeps(h, wire, output);
  const args = [file, "--doc-key", key, "--dir", h.folder, "--content-type", "x/original", "--json"];
  await promote(args, deps); const first = (await retainedBlobRows(h))[0]!;
  await promote(args, deps); assert.equal(JSON.parse(output.at(-1)!).resumed, true); assert.equal(wire.calls.length, 1);
  // A verified same-byte remote MIME refresh changes the current baseline, not the old receipt.
  wire.objects.set(key, { bytes, contentType: "x/remote-new" });
  const pulled = await hostedPull((await bindingForPath(h.home, h.folder))!, { auth: h.auth, cwd: h.cwd, fetch: wire.fetch }); assert.equal(pulled.state, "pulled");
  await assert.rejects(promote(args, deps), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
  const conflicted = (await retainedBlobRows(h)).at(-1)!; assert.notEqual(conflicted.requestId, first.requestId); assert.equal(conflicted.state, "conflict"); assert.equal(JSON.parse(output.at(-1)!).resumed, false); assert.equal(wire.calls.length, 2);
  // Repeating an explicit no-ID command admits a new valid CAS attempt, not a cached refusal.
  wire.objects.delete(key);
  await promote(args, deps); const next = (await retainedBlobRows(h)).at(-1)!; assert.notEqual(next.requestId, conflicted.requestId); assert.equal(next.state, "acknowledged"); assert.equal(JSON.parse(output.at(-1)!).resumed, false); assert.equal(wire.calls.length, 3);
});
test("a multi-request blob batch reloads full guards and preserves every original intent when unrelated map metadata changes", async () => {
  const h = await harness(), ids: string[] = [];
  for (let i = 0; i < 3; i++) { const key = `batch-${i}.bin`, file = path.join(h.folder, key); await writeFile(file, `frozen-${i}`); ids.push(...(await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, home: h.home, cwd: h.cwd }))!.requestIds); }
  const before = await retainedBlobRows(h), binding = (await bindingForPath(h.home, h.folder))!, scope = decodePreparedBlobIntent(before[0]!.prepared).scope;
  const original = FileJournaledBackend.prototype.updateBlobIntent; let active: FileJournaledBackend | undefined, changed = false;
  FileJournaledBackend.prototype.updateBlobIntent = async function (...args) { active = this; return original.apply(this, args); };
  const wire = blobAuthority(h, { beforeWrite: async () => {
    if (changed) return; changed = true;
    const { readBlobSyncState, changeBlobSyncEntry } = await import("../src/hosted/blob-sync.js");
    const snapshot = await readBlobSyncState(active!, "unrelated.bin", scope);
    await active!.writeBlobMeta("unrelated.bin", { meta: [{ key: BLOB_SYNC_META_KEY, value: encodeBlobSyncMap(changeBlobSyncEntry(snapshot.map, { key: "unrelated.bin", placedDigest: null, desiredContentType: "x/local" })) }] }, { guard: snapshot.journal.guard });
  } });
  const { deliverHostedBlobRequests } = await import("../src/hosted/sync.js");
  try {
    const result = await deliverHostedBlobRequests(binding, ids, { auth: h.auth, fetch: wire.fetch }); assert.equal(result.counts.committed, 0); assert.equal(result.counts.unknown, 3); assert.equal(wire.calls.length, 1);
  } finally { FileJournaledBackend.prototype.updateBlobIntent = original; }
  const after = await retainedBlobRows(h); assert.deepEqual(after.map(row => row.prepared), before.map(row => row.prepared)); assert.deepEqual(after.map(row => row.attempts), [1, 0, 0]); assert.ok(after.every(row => !row.receipt));
  const recovered = await deliverHostedBlobRequests(binding, ids, { auth: h.auth, fetch: wire.fetch }); assert.equal(recovered.counts.committed, 3); assert.equal(wire.calls.length, 3); assert.deepEqual((await retainedBlobRows(h)).map(row => row.attempts), [1, 1, 1]);
});

test("a create the host refuses as path_collision is a refused row naming the key, exit 5, never unknown and never resent", async () => {
  // Through promote: the receipt names the key and the next step; nothing is left to look up.
  const h = await harness(), key = "Images/chart.svg", file = path.join(h.folder, key); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "<svg/>");
  const wire = blobAuthority(h, { collides: candidate => candidate === key }), output: string[] = [];
  await assert.rejects(promote([file, "--doc-key", key, "--dir", h.folder, "--json"], commandDeps(h, wire, output)), (error: unknown) => error instanceof CliError && error.code === "CONFLICT" && error.exitCode === 5);
  const receipt = JSON.parse(output.at(-1)!), row = receipt.blobs.rows[0];
  assert.equal(receipt.status, "incomplete"); assert.equal(receipt.blobs.counts.unknown, 0); assert.equal(receipt.blobs.counts.refused, 1);
  assert.equal(row.state, "refused"); assert.equal(row.key, key); assert.equal(row.result.error.code, "path_collision");
  assert.match(row.message, /^Images\/chart\.svg was not created: .*only by letter case or Unicode form.*Nothing was written; rename/);
  assert.deepEqual(wire.calls.map(call => call.operationId), ["blobs.create.v1"]);
  h.fetch = wire.fetch;
  await failingSync(h).catch(() => undefined); assert.equal(wire.calls.length, 1, "the refused create is never sent again");

  // Through sync: a create admitted offline and delivered by the normal run.
  const s = await harness(), sKey = "notes/Diagram.png", sFile = path.join(s.folder, sKey); await mkdir(path.dirname(sFile), { recursive: true }); await writeFile(sFile, "png");
  await admitOfflineBlob({ operation: "promote", key: sKey, source: sFile, dir: s.folder, home: s.home, cwd: s.cwd });
  const sWire = blobAuthority(s, { collides: () => true }); s.fetch = sWire.fetch;
  const { error, receipt: synced } = await failingSync(s);
  assert.equal(error.code, "CONFLICT"); assert.equal(error.exitCode, 5);
  const blobs = synced?.blobs as { counts: Record<string, number>; rows: { key: string; state: string; message: string }[] };
  assert.equal(blobs.counts.unknown, 0); assert.equal(blobs.rows[0]!.state, "refused"); assert.equal(blobs.rows[0]!.key, sKey); assert.match(blobs.rows[0]!.message, /notes\/Diagram\.png was not created/);
  assert.equal(sWire.calls.length, 1);
  await failingSync(s).catch(() => undefined); assert.equal(sWire.calls.length, 1, "a later sync does not resend it");
  assert.ok((await retainedBlobRows(s)).every(retained => retained.state !== "unknown" && retained.state !== "in_flight"));
});

test("a blob refusal code the client does not know still stays unknown and is never resent", async () => {
  const h = await harness(), key = "odd.bin", file = path.join(h.folder, key); await writeFile(file, "bytes");
  await admitOfflineBlob({ operation: "promote", key, source: file, dir: h.folder, home: h.home, cwd: h.cwd });
  const wire = blobAuthority(h, { collides: () => true, createRefusal: "path_collision_v2" }); h.fetch = wire.fetch;
  const { error, receipt } = await failingSync(h);
  assert.equal(error.code, "TRANSIENT");
  const blobs = receipt?.blobs as { counts: Record<string, number>; rows: { state: string }[] };
  assert.equal(blobs.counts.unknown, 1); assert.equal(blobs.rows[0]!.state, "unknown"); assert.equal(wire.calls.length, 1);
  await failingSync(h); assert.equal(wire.calls.length, 1);
});

test("native spelling aliases refuse ordinary-file admission before journal/map mutation", async t => {
  const h = await harness(), lower = path.join(h.folder, "a.svg"), upper = path.join(h.folder, "A.svg"); await writeFile(lower, "old");
  let upperStat; try { upperStat = await stat(upper); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lowerStat = await stat(lower), names = await readdir(h.folder);
  if (!upperStat || lowerStat.dev !== upperStat.dev || lowerStat.ino !== upperStat.ino || names.includes("A.svg")) { t.skip("native filesystem does not alias a.svg/A.svg; portable ownership remains covered separately"); return; }
  t.diagnostic("native a.svg/A.svg resolve to one inode and only lower spelling is listed");
  const binding = await seedCaptureMap(h, "a.svg", Buffer.from("old"));
  const beforeStore = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) }); let before;
  try { before = await beforeStore.readMeta(BLOB_SYNC_META_KEY); } finally { await beforeStore.close(); }
  await assert.rejects(admitOfflineBlob({ operation: "promote", key: "A.svg", source: upper, contentType: "image/svg+xml", dir: h.folder, cwd: h.cwd, home: h.home }), /aliases another/);
  const afterStore = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try { assert.equal(await afterStore.readMeta(BLOB_SYNC_META_KEY), before); assert.equal((await afterStore.listBlobIntents()).length, 0); } finally { await afterStore.close(); }
  assert.equal(await readFile(lower, "utf8"), "old"); assert.equal(await readFile(upper, "utf8"), "old");
  // Even without another tracked owner, an existing native alias may not be treated as an exact target.
  const untrackedLower = path.join(h.folder, "untracked.svg"), untrackedUpper = path.join(h.folder, "UNTRACKED.svg"); await writeFile(untrackedLower, "local");
  await assert.rejects(admitOfflineBlob({ operation: "promote", key: "UNTRACKED.svg", source: untrackedUpper, contentType: "image/svg+xml", dir: h.folder, cwd: h.cwd, home: h.home }), /unsafe parent/);
  assert.equal(await readFile(untrackedLower, "utf8"), "local"); assert.equal((await retainedBlobRows(h)).length, 0);
});

// Blob version conflicts. Checkout B is simulated by writing the shared wire's objects directly:
// the harness builds each checkout's blob baseline from its own promote, and a second checkout of
// the same fake host would not carry one.
async function blobMap(h: Harness) {
  const binding = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try { return JSON.parse((await store.readMeta<string>(BLOB_SYNC_META_KEY))!) as { entries: { key: string; head?: { version: string; contentType: string } | null; placedDigest: string | null; desiredContentType?: string }[] }; }
  finally { await store.close(); }
}
async function blobConflict(local: "edit" | "delete" = "edit") {
  const h = await harness(), key = "images/diagram.svg", file = path.join(h.folder, key);
  await mkdir(path.dirname(file), { recursive: true });
  const wire = blobAuthority(h); h.fetch = wire.fetch;
  const base = Buffer.from("<svg>base</svg>"), theirs = Buffer.from("<svg>theirs</svg>"), mine = Buffer.from("<svg>mine</svg>");
  await writeFile(file, base);
  await promote([file, "--doc-key", key, "--dir", h.folder, "--content-type", "image/svg+xml"], commandDeps(h, wire));
  wire.objects.set(key, { bytes: theirs, contentType: "image/svg+xml" });
  if (local === "edit") await writeFile(file, mine); else await unlink(file);
  const { error } = await failingSync(h);
  assert.equal(error.code, "CONFLICT");
  const conflict = (await retainedBlobRows(h)).find(row => row.state === "conflict")!;
  assert.ok(conflict, "the sync recorded a version conflict");
  return { h, wire, key, file, base, theirs, mine, conflictId: conflict.requestId };
}
const outstandingBlobRows = async (h: Harness) => (await retainedBlobRows(h)).filter(row => row.state !== "acknowledged");

test("a blob conflict holds its file: a later sync names the resolve command and sends nothing", async () => {
  const f = await blobConflict(), calls = f.wire.calls.length;
  const again = await failingSync(f.h);
  assert.equal(f.wire.calls.length, calls);
  assert.ok((again.receipt?.help as string[]).some(line => line.includes("--resolve keep") && line.includes(f.key)));
  assert.ok(rowsOf(again.receipt).some(row => row.id === f.key && /--resolve keep or take/.test(row.message)));
});

test("blob conflict take places the host's bytes, leaves no intent, and the key syncs normally after", async () => {
  const f = await blobConflict();
  const resolved = await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  assert.equal(resolved.route, "blob"); assert.equal(resolved.file_state, "placed");
  assert.deepEqual(await readFile(f.file), f.theirs);
  const entry = (await blobMap(f.h)).entries.find(row => row.key === f.key)!;
  assert.equal(entry.head?.version, digestOf(f.theirs)); assert.equal(entry.placedDigest, digestOf(f.theirs)); assert.equal(entry.desiredContentType, undefined);
  assert.equal((await outstandingBlobRows(f.h)).length, 0);
  const calls = f.wire.calls.length;
  const quiet = await runSync(f.h); assert.equal(quiet.status, "up_to_date"); assert.equal(f.wire.calls.length, calls);
  await writeFile(f.file, "<svg>later</svg>");
  const later = await runSync(f.h); assert.equal((later.blobs as { counts: { committed: number } }).counts.committed, 1);
  assert.equal(f.wire.objects.get(f.key)?.bytes.toString(), "<svg>later</svg>");
  assert.equal(f.wire.calls.at(-1)!.expectedVersion, digestOf(f.theirs));
});

test("blob conflict keep sends a new request pinned to the host's version and never resends the conflicted one", async () => {
  const f = await blobConflict(), calls = f.wire.calls.length;
  const resolved = await runSync(f.h, ["--resolve", "keep", "--doc", f.key]);
  assert.equal(resolved.choice, "keep"); assert.equal(f.wire.calls.length, calls, "resolve sends nothing");
  assert.deepEqual(await readFile(f.file), f.mine);
  const synced = await runSync(f.h); assert.equal((synced.blobs as { counts: { committed: number } }).counts.committed, 1);
  const sent = f.wire.calls.at(-1)!;
  assert.notEqual(sent.requestId, f.conflictId); assert.equal(sent.operationId, "blobs.replace.v1");
  assert.equal(sent.expectedVersion, digestOf(f.theirs)); assert.equal(sent.expectedType, "image/svg+xml");
  assert.deepEqual(f.wire.objects.get(f.key)?.bytes, f.mine);
  assert.equal(f.wire.calls.filter(call => call.requestId === f.conflictId).length, 1);
  assert.equal((await outstandingBlobRows(f.h)).length, 0);
});

test("blob conflict revise is keep", async () => {
  const f = await blobConflict();
  const resolved = await runSync(f.h, ["--resolve", "revise", "--doc", f.key]);
  assert.equal(resolved.choice, "keep"); assert.equal(resolved.requested, "revise");
  await runSync(f.h); assert.deepEqual(f.wire.objects.get(f.key)?.bytes, f.mine);
});

test("blob keep after the host moved again conflicts again, overwrites nothing, and resolves again", async () => {
  const f = await blobConflict();
  await runSync(f.h, ["--resolve", "keep", "--doc", f.key]);
  const third = Buffer.from("<svg>third</svg>"); f.wire.objects.set(f.key, { bytes: third, contentType: "image/svg+xml" });
  const { error } = await failingSync(f.h); assert.equal(error.code, "CONFLICT");
  assert.deepEqual(f.wire.objects.get(f.key)?.bytes, third);
  const second = (await outstandingBlobRows(f.h)).find(row => row.state === "conflict")!;
  assert.notEqual(second.requestId, f.conflictId);
  await runSync(f.h, ["--resolve", "keep", "--doc", f.key]);
  await runSync(f.h);
  assert.deepEqual(f.wire.objects.get(f.key)?.bytes, f.mine);
  assert.equal(f.wire.calls.at(-1)!.expectedVersion, digestOf(third));
  assert.equal(new Set(f.wire.calls.map(call => call.requestId)).size, f.wire.calls.length, "no request id is sent twice");
});

test("promote --expected-version of the recorded host version resolves keep and commits under a new id; a stale one is refused", async () => {
  const f = await blobConflict(), calls = f.wire.calls.length;
  await assert.rejects(promote([f.file, "--doc-key", f.key, "--dir", f.h.folder, "--expected-version", digestOf(f.base)], commandDeps(f.h, f.wire)),
    (error: unknown) => error instanceof CliError && error.code === "CONFLICT" && error.details?.reason === "blob_conflict" && String(error.message).includes(digestOf(f.theirs)));
  assert.equal(f.wire.calls.length, calls);
  assert.equal((await outstandingBlobRows(f.h)).filter(row => row.state === "conflict").length, 1);
  const output: string[] = [];
  await promote([f.file, "--doc-key", f.key, "--dir", f.h.folder, "--expected-version", digestOf(f.theirs), "--json"], commandDeps(f.h, f.wire, output));
  assert.equal(JSON.parse(output.at(-1)!).promote, "committed");
  assert.deepEqual(f.wire.objects.get(f.key)?.bytes, f.mine);
  assert.notEqual(f.wire.calls.at(-1)!.requestId, f.conflictId); assert.equal(f.wire.calls.at(-1)!.expectedVersion, digestOf(f.theirs));
  assert.equal((await outstandingBlobRows(f.h)).length, 0);
});

test("blob take is refused when the file changed after the conflict, and nothing is removed", async () => {
  const f = await blobConflict();
  await writeFile(f.file, "<svg>edited after</svg>");
  const { error } = await failingSync(f.h, ["--resolve", "take", "--doc", f.key]);
  assert.equal(error.code, "CONFLICT"); assert.equal(error.details?.reason, "edited_since_conflict");
  assert.equal(await readFile(f.file, "utf8"), "<svg>edited after</svg>");
  assert.equal((await outstandingBlobRows(f.h)).filter(row => row.requestId === f.conflictId).length, 1);
  // Removing the file is the way to discard those edits.
  await unlink(f.file);
  await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  assert.deepEqual(await readFile(f.file), f.theirs);
});

test("a blob delete conflict: take brings the host's version back; keep sends a delete pinned to it", async () => {
  const taken = await blobConflict("delete");
  await runSync(taken.h, ["--resolve", "take", "--doc", taken.key]);
  assert.deepEqual(await readFile(taken.file), taken.theirs);
  assert.equal((await outstandingBlobRows(taken.h)).length, 0);

  const kept = await blobConflict("delete");
  await runSync(kept.h, ["--resolve", "keep", "--doc", kept.key]);
  await runSync(kept.h);
  const sent = kept.wire.calls.at(-1)!;
  assert.equal(sent.operationId, "blobs.delete.v1"); assert.equal(sent.expectedVersion, digestOf(kept.theirs)); assert.notEqual(sent.requestId, kept.conflictId);
  assert.equal(kept.wire.objects.has(kept.key), false);
});

test("blob keep preserves the person's MIME choice from the conflicted request", async () => {
  const f = await blobConflict(), chosen = "image/svg+xml; profile=mine";
  await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  f.wire.objects.set(f.key, { bytes: Buffer.from("<svg>moved</svg>"), contentType: "image/svg+xml; profile=host" });
  await writeFile(f.file, f.mine);
  await assert.rejects(promote([f.file, "--doc-key", f.key, "--dir", f.h.folder, "--expected-version", digestOf(f.theirs), "--content-type", chosen], commandDeps(f.h, f.wire)), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
  await runSync(f.h, ["--resolve", "keep", "--doc", f.key]);
  assert.equal((await blobMap(f.h)).entries.find(row => row.key === f.key)!.desiredContentType, chosen);
  await runSync(f.h);
  assert.equal(f.wire.calls.at(-1)!.contentType, chosen); assert.equal(f.wire.calls.at(-1)!.expectedType, "image/svg+xml; profile=host");
  assert.equal(f.wire.objects.get(f.key)?.contentType, chosen);
});

test("blob keep without a MIME choice adopts the host's MIME change instead of reverting it", async () => {
  const f = await blobConflict();
  await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  assert.equal((await blobMap(f.h)).entries.find(row => row.key === f.key)!.desiredContentType, undefined);
  f.wire.objects.set(f.key, { bytes: Buffer.from("<svg>moved</svg>"), contentType: "image/svg+xml; profile=host" });
  await writeFile(f.file, f.mine);
  await assert.rejects(runSync(f.h), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
  await runSync(f.h, ["--resolve", "keep", "--doc", f.key]);
  assert.equal((await blobMap(f.h)).entries.find(row => row.key === f.key)!.desiredContentType, undefined);
  await runSync(f.h);
  assert.equal(f.wire.calls.at(-1)!.contentType, "image/svg+xml; profile=host"); assert.equal(f.wire.calls.at(-1)!.expectedType, "image/svg+xml; profile=host");
  assert.deepEqual(f.wire.objects.get(f.key)?.bytes, Buffer.from(f.mine));
});

test("blob keep is refused when the edited file went missing, so it never becomes a host deletion", async () => {
  const f = await blobConflict(), calls = f.wire.calls.length;
  await unlink(f.file);
  await assert.rejects(runSync(f.h, ["--resolve", "keep", "--doc", f.key]), (error: unknown) => error instanceof CliError && error.code === "CONFLICT" && error.details?.reason === "missing_since_conflict");
  assert.equal((await retainedBlobRows(f.h)).find(row => row.requestId === f.conflictId)?.state, "conflict");
  assert.equal((await failingSync(f.h)).error.code, "CONFLICT");
  assert.equal(f.wire.calls.length, calls); assert.deepEqual(f.wire.objects.get(f.key)?.bytes, f.theirs);
});

test("blob take on a file with no conflict refuses before signing in or making a request", async () => {
  const f = await blobConflict();
  await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  const calls = f.wire.calls.length, requests = f.h.host.requests.length;
  await assert.rejects(runSync(f.h, ["--resolve", "take", "--doc", f.key]), (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND");
  assert.equal(f.wire.calls.length, calls); assert.equal(f.h.host.requests.length, requests);
});

test("blob inspect reports the recorded conflict pins offline", async () => {
  const f = await blobConflict(), calls = f.wire.calls.length, requests = f.h.host.requests.length;
  const shown = await runSync(f.h, ["--inspect", "--doc", f.key]);
  assert.equal(shown.route, "blob"); assert.equal(shown.request_id, f.conflictId);
  assert.deepEqual(shown.base, { version: digestOf(f.base), content_type: "image/svg+xml" });
  assert.deepEqual(shown.remote, { version: digestOf(f.theirs), content_type: "image/svg+xml" });
  assert.equal(shown.file_now, "as_conflicted");
  assert.equal(f.wire.calls.length, calls); assert.equal(f.h.host.requests.length, requests);
});

test("status reports tracked ordinary files as blobs with their state and sends nothing", async () => {
  const statusOf = async (h: Harness) => (await hostedStatus((await bindingForPath(h.home, h.folder))!, h.home)).sync as Record<string, any>;
  const f = await blobConflict();
  // conflict
  let before = [f.wire.calls.length, f.h.host.requests.length];
  let block = await statusOf(f.h);
  assert.deepEqual([f.wire.calls.length, f.h.host.requests.length], before);
  assert.equal(block.state, "needs_decision"); assert.equal(block.blobs.conflict, 1);
  assert.deepEqual(block.blob_rows, [{ key: f.key, state: "conflict" }]);
  assert.ok(!(block.held_rows ?? []).some((row: { id: string }) => row.id === f.key));
  // clean
  await runSync(f.h, ["--resolve", "take", "--doc", f.key]);
  block = await statusOf(f.h);
  assert.equal(block.state, "clean"); assert.deepEqual(block.blobs, { clean: 1 }); assert.equal(block.held_files, 0); assert.equal(block.blob_rows, undefined);
  // pending
  await writeFile(f.file, "<svg>unsent</svg>");
  block = await statusOf(f.h);
  assert.equal(block.state, "unsent_changes"); assert.deepEqual(block.blob_rows, [{ key: f.key, state: "pending" }]); assert.equal(block.held_files, 0);
  // unknown: the write lands, its answer is lost, and the lookup cannot reach the host
  const lost = blobAuthority(f.h, { lostAck: true }); lost.objects.set(f.key, { bytes: f.theirs, contentType: "image/svg+xml" });
  f.h.fetch = (async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/outcome")) throw new Error("lookup unreachable");
    return lost.fetch(input, init);
  }) as typeof fetch;
  await assert.rejects(sync(["--dir", f.h.folder], { stdout: () => {}, auth: f.h.auth, cwd: f.h.cwd, fetch: f.h.fetch, write: { sleep: instant, lookupDelayMs: 0, maxLookups: 1 }, sleep: instant }));
  assert.equal((await outstandingBlobRows(f.h))[0]!.state, "unknown");
  before = [lost.calls.length, f.h.host.requests.length];
  block = await statusOf(f.h);
  assert.deepEqual([lost.calls.length, f.h.host.requests.length], before);
  assert.equal(block.state, "unsent_changes"); assert.deepEqual(block.blob_rows, [{ key: f.key, state: "unknown" }]);
});

test("a blob conflict with a host deletion: keep admits a new create of the file, take removes it", async () => {
  for (const choice of ["keep", "take"] as const) {
    const h = await harness(), key = "gone.svg", file = path.join(h.folder, key), wire = blobAuthority(h); h.fetch = wire.fetch;
    await writeFile(file, "<svg>base</svg>");
    await promote([file, "--doc-key", key, "--dir", h.folder, "--content-type", "image/svg+xml"], commandDeps(h, wire));
    wire.objects.delete(key); await writeFile(file, "<svg>mine</svg>");
    await failingSync(h);
    const conflictId = (await retainedBlobRows(h)).find(row => row.state === "conflict")!.requestId;
    const resolved = await runSync(h, ["--resolve", choice, "--doc", key]);
    if (choice === "keep") {
      assert.ok(typeof resolved.request_id === "string" && resolved.request_id !== conflictId);
      await runSync(h);
      assert.equal(wire.calls.at(-1)!.operationId, "blobs.create.v1"); assert.equal(wire.calls.at(-1)!.contentType, "image/svg+xml");
      assert.equal(wire.objects.get(key)?.bytes.toString(), "<svg>mine</svg>");
    } else {
      await assert.rejects(readFile(file), { code: "ENOENT" });
      const calls = wire.calls.length; await runSync(h); assert.equal(wire.calls.length, calls);
    }
    assert.equal((await outstandingBlobRows(h)).length, 0);
  }
});

test("a blob refusal the host never records is reported once, retired, and the next sync sends the file again", async () => {
  const cases = [
    { status: 429, code: "request_capacity", extra: { scope: "principal", resetAt: "2026-10-19T00:00:00Z" }, exit: "TRANSIENT" },
    { status: 200, code: "request_capacity", extra: { scope: "bundle" }, exit: "TRANSIENT" },
    { status: 200, code: "insufficient_scope", extra: {}, exit: "FORBIDDEN" },
  ] as const;
  for (const { status, code, extra, exit } of cases) {
    const h = await harness(), key = "quota.bin", file = path.join(h.folder, key);
    await writeFile(file, "old"); await seedCaptureMap(h, key, Buffer.from("old")); await writeFile(file, "new");
    const wire = blobAuthority(h); wire.objects.set(key, { bytes: Buffer.from("old"), contentType: 'application/octet-stream; profile="old"' });
    let refuse = 1; const uploads: string[] = [], lookups: string[] = [];
    h.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init), route = new URL(request.url).pathname;
      if (/\/blob-(?:create|replace)$/.test(route)) {
        uploads.push(request.headers.get("x-superbee-write-request")!);
        if (refuse-- > 0) {
          const error = { code, message: "refused before dispatch", retryable: false, writeState: "not_applied", ...extra };
          return status === 429 ? Response.json({ error }, { status: 429 }) : Response.json({ ok: false, operationId: route.endsWith("create") ? "blobs.create.v1" : "blobs.replace.v1", error });
        }
      }
      if (route.endsWith("/outcome")) { const body = await request.clone().json() as { operationId?: string }; if (String(body.operationId).startsWith("blobs.")) lookups.push(request.headers.get("x-superbee-write-request")!); }
      return wire.fetch(input, init);
    }) as typeof fetch;
    const label = `${status} ${code}`;
    // Sync 1: the refusal is reported as refused, classed as document writes class it, and retired.
    const error = await runSync(h).then(() => assert.fail(`${label}: sync 1 must not succeed`), (thrown: unknown) => thrown as CliError);
    assert.equal(error.code, exit, label);
    const first = decode(h.out.at(-1)!.trim()) as { blobs: { rows: { key: string; state: string; message?: string }[] } };
    assert.deepEqual(first.blobs.rows.map(row => [row.key, row.state]), [[key, "refused"]], label);
    assert.match(first.blobs.rows[0]!.message ?? "", /Nothing was lost/, label);
    assert.deepEqual(await retainedBlobRows(h), [], `${label}: the refused receipt is retired`);
    assert.deepEqual(lookups, [], `${label}: a refusal the host never recorded is never looked up`);
    // Sync 2: the file is captured anew and sent under a fresh identity; it commits.
    await runSync(h);
    assert.equal(uploads.length, 2, label);
    assert.notEqual(uploads[1], uploads[0], `${label}: a new identity`);
    assert.equal(wire.objects.get(key)?.bytes.toString(), "new", label);
    assert.deepEqual((await retainedBlobRows(h)).map(row => row.state), ["acknowledged"], label);
  }
});

test("a recorded blob refusal is reported once and retired too, so an edit is sent on the next sync", async () => {
  const h = await harness(), key = "busy.bin", file = path.join(h.folder, key);
  await writeFile(file, "old"); await seedCaptureMap(h, key, Buffer.from("old")); await writeFile(file, "new");
  const wire = blobAuthority(h); wire.objects.set(key, { bytes: Buffer.from("old"), contentType: 'application/octet-stream; profile="old"' });
  let refuse = 1;
  h.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init), route = new URL(request.url).pathname;
    if (/\/blob-replace$/.test(route) && refuse-- > 0) {
      const id = request.headers.get("x-superbee-write-request")!;
      return Response.json({ ok: false, operationId: "blobs.replace.v1", error: { code: "backend_unavailable", message: "down", retryable: false, writeState: "not_applied" } }, { headers: { "x-superbee-write-settled": id } });
    }
    return wire.fetch(input, init);
  }) as typeof fetch;
  const error = await runSync(h).then(() => assert.fail("sync 1 must not succeed"), (thrown: unknown) => thrown as CliError);
  assert.equal(error.code, "CONFLICT");
  assert.deepEqual((decode(h.out.at(-1)!.trim()) as { blobs: { rows: { state: string }[] } }).blobs.rows.map(row => row.state), ["refused"]);
  assert.deepEqual(await retainedBlobRows(h), []);
  await writeFile(file, "newer");
  await runSync(h);
  assert.equal(wire.objects.get(key)?.bytes.toString(), "newer");
});

test("the CLI's ordinary-file key policy is core's: protected folders and reserved files are never blob keys", async () => {
  for (const key of ["views/a.html", "Views/a.html", "pages/a.html", "views-registry/x", "pages-registry/x", "conventions/a.png", "recipes/x.bin", "REFERENCES/x.pdf", "index.md", "log.md"]) assert.equal(isOrdinaryBlobKey(key), false, key);
  for (const key of ["media/a.png", "diagrams/café.svg", "viewsx/a.html", "a/views/b.png"]) assert.equal(isOrdinaryBlobKey(key), true, key);
});


test("hosted Artifact acknowledges bytes then queues one visible record; edits and deletes keep ordinary ownership", async () => {
  const h = await harness(), wire = blobAuthority(h);
  const file = path.join(h.folder, "artifacts/result.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "<h1>Result</h1>");
  const out: string[] = [], args = ["create", file, "--title", "Result", "--actor", "process:artifact-test", "--dir", h.folder, "--json"];
  await artifact(args, commandDeps(h, wire, out));
  const first = JSON.parse(out.at(-1)!);
  assert.equal(first.artifact, "record_pending"); assert.equal(wire.calls.length, 1);
  assert.equal(h.host.writes.length, 0);
  const recordFile = path.join(h.folder, "artifacts/result.md"); assert.match(await readFile(recordFile, "utf8"), /entry_version: .?sha256:/);
  await artifact(args, commandDeps(h, wire, out)); assert.equal(JSON.parse(out.at(-1)!).record_request_id, first.record_request_id); assert.equal(wire.calls.length, 1);
  h.fetch = wire.fetch; await runSync(h); await runSync(h);
  assert.ok(h.host.docs.get("artifacts/result"));
  await writeFile(recordFile, (await readFile(recordFile, "utf8")).replace("title: Result", "title: Edited"));
  await runSync(h); await runSync(h); assert.equal(h.host.docs.get("artifacts/result")!.frontmatter.title, "Edited");
  await assert.rejects(artifact(args, commandDeps(h, wire, out)), /evidence changed|retired/);
  await unlink(recordFile); await runSync(h); await runSync(h); assert.equal(h.host.docs.get("artifacts/result"), undefined);
});

test("hosted Artifact lost ACK recovers original identity; changed bytes and supersedes send nothing", async () => {
  const h = await harness(), wire = blobAuthority(h, { lostAck: true });
  const file = path.join(h.folder, "artifacts/lost.html"); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "<p>frozen</p>");
  const args = ["create", file, "--title", "Lost", "--actor", "process:artifact-test", "--dir", h.folder, "--json"], out: string[] = [];
  await artifact(args, commandDeps(h, wire, out)); assert.equal(JSON.parse(out.at(-1)!).artifact, "record_pending");
  await artifact(args, commandDeps(h, wire, out)); assert.equal(wire.calls.length, 1);
  await writeFile(file, "changed"); await assert.rejects(artifact(args, commandDeps(h, wire, out)), /frozen/);
  await assert.rejects(artifact([...args, "--supersedes", "artifacts/old"], commandDeps(h, wire, out)), /not supported/);
  assert.equal(wire.calls.length, 1); assert.equal(h.host.writes.length, 0);
});

test("hosted Artifact later projection and already admitted intent cannot be recaptured", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/pending.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "bytes");
  await artifact(["create", file, "--title", "Pending", "--actor", "process:artifact-test", "--dir", h.folder], commandDeps(h, wire));
  const b = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { const p = (await publications(store))[0]!; assert.ok(p.record); await assert.rejects(admitArtifactRecord(store, p, digestOf(Buffer.from("bytes")), 1000000), /empty create-null/); assert.equal(await initialArtifactOwner(store, { root: null, files: { [p.id]: { digest: "later", version: "later" } } }, p), null); }
  finally { await store.close(); }
});


test("hosted Artifact absent lookup after lost ACK never queues record or resends; later exact outcome unlocks once", async () => {
  const h = await harness(), wire = blobAuthority(h, { lostAck: true }); let showOutcome = false;
  const wrapped: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/outcome") && !showOutcome) {
      const body = await request.clone().json() as { operationId?: string };
      if (body.operationId?.startsWith("blobs.")) return Response.json({ schemaVersion: 1, requestId: request.headers.get("x-superbee-write-request"), binding: request.headers.get("x-superbee-checkout"), status: "absent" });
    }
    return wire.fetch(input, init);
  };
  const file = path.join(h.folder, "artifacts/uncertain.html"); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  const args = ["create", file, "--title", "Uncertain", "--actor", "process:artifact-test", "--dir", h.folder, "--json"], out: string[] = [], deps = commandDeps(h, { ...wire, fetch: wrapped }, out);
  await assert.rejects(artifact(args, deps), /unresolved/); assert.equal(JSON.parse(out.at(-1)!).artifact, "blob_pending");
  await assert.rejects(readFile(path.join(h.folder, "artifacts/uncertain.md")));
  await assert.rejects(artifact(args, deps), /unresolved/); assert.equal(JSON.parse(out.at(-1)!).artifact, "blob_pending"); assert.equal(wire.calls.length, 1);
  showOutcome = true; await artifact(args, deps); assert.equal(JSON.parse(out.at(-1)!).artifact, "record_pending"); assert.equal(wire.calls.length, 1); assert.equal(h.host.writes.length, 0);
});


test("hosted Artifact placement collision suppresses only original request; explicit successor still syncs twice", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/collision.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  await artifact(["create", file, "--title", "Collision", "--actor", "process:artifact-test", "--dir", h.folder], commandDeps(h, wire));
  const b = (await bindingForPath(h.home, h.folder))!, projectionFile = path.join(checkoutDir(h.home, b.checkout_id), "projection.json"), projection = JSON.parse(await readFile(projectionFile, "utf8"));
  delete projection.files["artifacts/collision"]; await writeFile(projectionFile, JSON.stringify(projection));
  const markdown = path.join(h.folder, "artifacts/collision.md"); await writeFile(markdown, "different physical file"); h.fetch = wire.fetch;
  await failingSync(h); assert.equal(h.host.writes.length, 0); assert.equal(await readFile(markdown, "utf8"), "different physical file");
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { await commitLocal(store, "artifacts/collision", { mode: "patch", buildCandidate: doc => ({ frontmatter: { ...doc!.frontmatter, title: "Successor" }, body: doc!.body }) }); await writeFile(markdown, (await store.readWithJournal("artifacts/collision")).raw!); }
  finally { await store.close(); }
  await runSync(h); await runSync(h); assert.equal(h.host.docs.get("artifacts/collision")!.frontmatter.title, "Successor");
});


test("review: refused original with placement collision never escapes hold during resume", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/review-hold.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  await artifact(["create", file, "--title", "Review hold", "--actor", "process:review", "--dir", h.folder], commandDeps(h, wire));
  const b = (await bindingForPath(h.home, h.folder))!, projectionFile = path.join(checkoutDir(h.home, b.checkout_id), "projection.json"), projection = JSON.parse(await readFile(projectionFile, "utf8"));
  delete projection.files["artifacts/review-hold"]; await writeFile(projectionFile, JSON.stringify(projection));
  const markdown = path.join(h.folder, "artifacts/review-hold.md"); await writeFile(markdown, "different physical file");
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { const p = (await publications(store))[0]!; await store.updateIntent(p.record!.requestId, "pending", { state: "refused", refusal: { code: "FORBIDDEN", message: "lost grant" } }); }
  finally { await store.close(); }
  h.fetch = wire.fetch;
  await failingSync(h);
  assert.equal(h.host.writes.length, 0, "original with unresolved placement must not be sent by resume");
});

test("review: cancellation before resumed record admission preserves blob-only state", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/review-cancel.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  const original = FileJournaledBackend.prototype.writeJournaled;
  let refuseOnce = true;
  FileJournaledBackend.prototype.writeJournaled = async function(id, doc, options) { if (id === "artifacts/review-cancel" && refuseOnce) { refuseOnce = false; throw new Error("review crash before record admission"); } return original.call(this,id,doc,options); };
  const args = ["create", file, "--title", "Review cancel", "--actor", "process:review", "--dir", h.folder];
  try { await assert.rejects(artifact(args, commandDeps(h, wire)), /record is not queued/); }
  finally { FileJournaledBackend.prototype.writeJournaled = original; }
  const controller = new AbortController(); controller.abort();
  const deps = commandDeps(h, wire);
  try { await artifact(args, { ...deps, hosted: { ...deps.hosted, write: { ...deps.hosted.write, signal: controller.signal } } }); } catch {}
  const b = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { const p = (await publications(store))[0]!; assert.equal(p.state, "blob_admitted", "already cancelled replay must not queue a document"); assert.equal((await store.listIntents()).length,0); }
  finally { await store.close(); }
});

test("review: hosted oversized source never passes through unbounded readFile", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/review-large.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  const fs = await import("node:fs/promises"), original = fs.default.readFile;
  let unboundedReads = 0;
  fs.default.readFile = async function(this: typeof fs.default, ...args: Parameters<typeof original>) { if (String(args[0]) === file) unboundedReads++; return original.apply(this,args as any); } as typeof original;
  try { await assert.rejects(artifact(["create",file,"--title","Review large","--actor","process:review","--dir",h.folder],commandDeps(h,wire))); }
  finally { fs.default.readFile = original; }
  assert.equal(wire.calls.length,0);
  assert.equal(unboundedReads,0,"hosted source acquisition must use bounded no-follow reader exclusively");
});

for (const refusalCode of ["FORBIDDEN", "concurrent_change"]) test(`Artifact ${refusalCode} collision stays held on repeated resume; real successor remains ordinary-owned`, async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/refused.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  await artifact(["create", file, "--title", "Refused", "--actor", "process:fix", "--dir", h.folder], commandDeps(h, wire));
  const b = (await bindingForPath(h.home, h.folder))!, projectionFile = path.join(checkoutDir(h.home, b.checkout_id), "projection.json"), projection = JSON.parse(await readFile(projectionFile, "utf8"));
  delete projection.files["artifacts/refused"]; await writeFile(projectionFile, JSON.stringify(projection));
  const markdown = path.join(h.folder, "artifacts/refused.md"); await writeFile(markdown, "collision");
  let store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { const p = (await publications(store))[0]!; await store.updateIntent(p.record!.requestId, "pending", { state: "refused", refusal: { code: refusalCode, message: "held refusal" } }); } finally { await store.close(); }
  h.fetch = wire.fetch; await failingSync(h); await failingSync(h); assert.equal(h.host.writes.length, 0);
  store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { await commitLocal(store, "artifacts/refused", { mode: "patch", buildCandidate: doc => ({ frontmatter: { ...doc!.frontmatter, title: "Successor" }, body: doc!.body }) }); await writeFile(markdown, (await store.readWithJournal("artifacts/refused")).raw!); } finally { await store.close(); }
  await runSync(h); await runSync(h); assert.equal(h.host.docs.get("artifacts/refused")!.frontmatter.title, "Successor");
});

test("Artifact cancelled fresh acquisition admits nothing; cancellation after commit reports the queued record honestly", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/cancelled.html"), controller = new AbortController();
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  const args = ["create", file, "--title", "Cancelled", "--actor", "process:fix", "--dir", h.folder, "--json"], out: string[] = [], deps = commandDeps(h, wire, out);
  controller.abort();
  await assert.rejects(artifact(args, { ...deps, hosted: { ...deps.hosted, write: { ...deps.hosted.write, signal: controller.signal } } }), { name: "AbortError" });
  assert.equal(wire.calls.length, 0);
  const after = new AbortController(), original = FileJournaledBackend.prototype.writeJournaled;
  FileJournaledBackend.prototype.writeJournaled = async function(id, doc, options) { const saved = await original.call(this, id, doc, options); if (id === "artifacts/cancelled") after.abort(); return saved; };
  try { await artifact(args, { ...deps, hosted: { ...deps.hosted, write: { ...deps.hosted.write, signal: after.signal } } }); } finally { FileJournaledBackend.prototype.writeJournaled = original; }
  const receipt = JSON.parse(out.at(-1)!); assert.equal(receipt.artifact, "record_pending"); assert.equal(receipt.local_placement, "pending_after_cancellation");
  assert.equal(wire.calls.length, 1); assert.equal(h.host.writes.length, 0);
  await artifact(args, deps); assert.equal(JSON.parse(out.at(-1)!).record_request_id, receipt.record_request_id); assert.equal(wire.calls.length, 1);
});

test("Artifact hosted source uses injected cwd and refuses symlink/missing input without a legacy acquisition", async () => {
  const h = await harness(), wire = blobAuthority(h), dir = path.join(h.folder, "artifacts"); await mkdir(dir, { recursive: true });
  const outside = path.join(h.cwd, "source-outside"); await writeFile(outside, "frozen"); const file = path.join(dir, "source.html"); await symlink(outside, file);
  const args = ["create", "artifacts/source.html", "--title", "Source", "--actor", "process:fix", "--dir", h.folder], base = commandDeps(h, wire), deps = { ...base, cwd: h.folder };
  await assert.rejects(artifact(args, deps), /unsafe|missing/); assert.equal(wire.calls.length, 0);
  await unlink(file); await assert.rejects(artifact(args, deps), /unsafe|missing/); assert.equal(wire.calls.length, 0);
  await writeFile(file, "frozen"); await artifact(args, deps); assert.equal(wire.calls.length, 1);
});

test("Artifact cancellation after awaited host preflight precedes new blob reservation", async () => {
  const h = await harness(), wire = blobAuthority(h), controller = new AbortController(), file = path.join(h.folder, "artifacts/preflight.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  const base = commandDeps(h, wire), fetcher: typeof fetch = async (input, init) => { const answer = await wire.fetch(input, init); if (new URL(String(input)).pathname.endsWith("/blob-heads")) controller.abort(); return answer; };
  await assert.rejects(artifact(["create", file, "--title", "Preflight", "--actor", "process:fix", "--dir", h.folder], { ...base, hosted: { ...base.hosted, fetch: fetcher, write: { ...base.hosted.write, signal: controller.signal } } }));
  const b = (await bindingForPath(h.home, h.folder))!, store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, b.checkout_id) });
  try { assert.deepEqual(await publications(store), []); assert.deepEqual(await store.listBlobIntents(), []); assert.deepEqual(await store.listIntents(), []); } finally { await store.close(); }
  assert.equal(wire.calls.length, 0);
});

test('independent QA: projection persistence failure after durable record admission reopens exact record',async()=>{
 const h=await harness(),wire=blobAuthority(h),file=path.join(h.folder,'artifacts/persist.html');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'frozen');
 const b=(await bindingForPath(h.home,h.folder))!,pf=path.join(checkoutDir(h.home,b.checkout_id),'projection.json'),saved=await readFile(pf);const original=FileJournaledBackend.prototype.writeJournaled;let injected=false;
 FileJournaledBackend.prototype.writeJournaled=async function(id,doc,options){const result=await original.call(this,id,doc,options);if(id==='artifacts/persist'&&!injected){injected=true;await unlink(pf);await mkdir(pf);}return result;};
 const out:string[]=[],args=['create',file,'--title','Persist','--actor','process:qa','--dir',h.folder,'--json'];
 try{await assert.rejects(artifact(args,commandDeps(h,wire,out)), (error: unknown) => {
   assert.ok(error instanceof CliError); assert.equal(error.handled,true); assert.notEqual(error.exitCode,0);
   const committedFailure=(error as Error).cause as Error & {cleanupCause?:unknown};
   assert.ok(committedFailure.cause instanceof Error); assert.ok(committedFailure.cleanupCause instanceof Error); return true;
 });}finally{FileJournaledBackend.prototype.writeJournaled=original;await rm(pf,{recursive:true});await writeFile(pf,saved);}
 assert.ok(injected);assert.ok(out.some(text => text.includes('record_pending') && text.includes('local_placement_incomplete')), 'postcommit projection failure must emit promised record_pending/local_placement_incomplete receipt');const state=await (async()=>{const store=await FileJournaledBackend.open({directory:checkoutStoreDir(h.home,b.checkout_id)});try{return {p:(await publications(store))[0],blobs:await store.listBlobIntents(),intents:await store.listIntents()};}finally{await store.close();}})();assert.equal(state.p!.state,'record_admitted');assert.equal(state.blobs[0]!.state,'acknowledged');assert.equal(state.intents.length,1);assert.equal(h.host.writes.length,0);
 const failedReceipt=JSON.parse(out.at(-1)!);assert.equal(failedReceipt.record_request_id,state.p!.record!.requestId);assert.equal(failedReceipt.blob_request_id,state.p!.blobRequestId);
 await artifact(args,commandDeps(h,wire,out));const receipt=JSON.parse(out.at(-1)!);assert.equal(receipt.artifact,'record_pending');assert.equal(receipt.record_request_id,state.p!.record!.requestId);assert.equal(receipt.blob_request_id,state.p!.blobRequestId);assert.equal(wire.calls.length,1);assert.equal(h.host.writes.length,0);
 h.fetch=wire.fetch;await runSync(h);const md=path.join(h.folder,'artifacts/persist.md');await writeFile(md,(await readFile(md,'utf8')).replace('title: Persist','title: Later'));await runSync(h);await runSync(h);assert.equal(h.host.docs.get('artifacts/persist')!.frontmatter.title,'Later');await unlink(md);await runSync(h);await runSync(h);assert.ok(!h.host.docs.has('artifacts/persist'));
});


test("Artifact final session cleanup failure retains committed receipt and original cause", async () => {
  const h = await harness(), wire = blobAuthority(h), file = path.join(h.folder, "artifacts/cleanup.html");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "frozen");
  const write = FileJournaledBackend.prototype.writeJournaled, close = FileJournaledBackend.prototype.close;
  const fault = new Error("injected final cleanup failure"); let committed = false, injected = false;
  FileJournaledBackend.prototype.writeJournaled = async function(id, doc, options) {
    const result = await write.call(this, id, doc, options); if (id === "artifacts/cleanup") committed = true; return result;
  };
  FileJournaledBackend.prototype.close = async function() {
    await close.call(this); if (committed && !injected) { injected = true; throw fault; }
  };
  const out: string[] = [], args = ["create", file, "--title", "Cleanup", "--actor", "process:qa", "--dir", h.folder, "--json"];
  try {
    await assert.rejects(artifact(args, commandDeps(h, wire, out)), (error: unknown) => {
      assert.ok(error instanceof CliError); assert.equal(error.handled, true); assert.notEqual(error.exitCode, 0);
      assert.equal(((error as Error).cause as Error)?.cause, fault); return true;
    });
  } finally { FileJournaledBackend.prototype.writeJournaled = write; FileJournaledBackend.prototype.close = close; }
  assert.ok(injected); assert.equal(out.length, 1);
  const receipt = JSON.parse(out[0]!); assert.equal(receipt.artifact, "record_pending"); assert.equal(receipt.local_placement, "local_placement_incomplete");
  assert.equal(h.host.writes.length, 0);
  await artifact(args, commandDeps(h, wire, out)); const replay = JSON.parse(out.at(-1)!);
  assert.equal(replay.record_request_id, receipt.record_request_id); assert.equal(replay.blob_request_id, receipt.blob_request_id); assert.equal(wire.calls.length, 1);
});

test("catalog remove refuses a journaled unsent change in the checkout's folder, and reports it stranded once the folder is gone or replaced", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Unsent.\n"));
  h.host.hook = (call) => (call.route !== "outcome" ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "q", retryable: false, writeState: "not_applied" } } } : undefined);
  await failingSync(h);
  const remove = async () => {
    const out: string[] = [];
    await catalog(["remove", BUNDLE, "--json"], { stdout: (text) => void out.push(text), home: () => h.home, cwd: () => h.cwd });
    return JSON.parse(out.join("")) as Record<string, unknown>;
  };
  const refused = await remove().then(() => assert.fail("expected a refusal"), (error: unknown) => error as CliError);
  assert.equal(refused.code, "CONFLICT");
  assert.equal(refused.details?.reason, "unsent_changes");
  assert.equal(refused.details?.unsent, 1);

  // Replaced by another folder: nothing of the checkout's to scan; the journaled change is reported.
  const canonical = await realpath(h.folder);
  await rm(h.folder, { recursive: true });
  await mkdir(h.folder);
  const removed = await remove();
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.checkout, { bundle_id: BUNDLE, host: HOST, folder: "replaced" });
  assert.equal(removed.stranded_unsent, 1);
  assert.ok((removed.help as string[]).some((line) => line.endsWith(`checkout --release ${canonical}`)), JSON.stringify(removed.help));
  assert.deepEqual((await loadCatalog(h.home)).entries, []);
  assert.ok((await stat(checkoutStoreDir(h.home, (await import("../src/hosted/binding.js").then((m) => m.indexedBindingForPath(h.home, canonical)))!.checkout_id))).isDirectory(), "the store is kept");
});
