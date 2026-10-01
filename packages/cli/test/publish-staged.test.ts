// `superbee publish --to hosted` for a bundle past one request's bounds: the staged creation
// (`src/hosted/publish-staged.ts`) against the fake host's staged routes
// (`support/fake-hosted-create.ts`, held to the golden staged exchanges by
// `hosted-create-fake-contract.test.ts`). No request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";

import { bundleHomeAt } from "../src/bundle-home.js";
import { publish } from "../src/commands/publish.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath, checkoutStoreDir } from "../src/hosted/binding.js";
import { qualifyingCarrier } from "../src/hosted/client.js";
import { readCheckoutMarker } from "../src/hosted/marker.js";
import { readPendingCreate } from "../src/hosted/publish-state.js";
import { stagedBlockers, STAGED_PUBLISH_BOUNDS, type CreateHistory, type PlanContent } from "../src/hosted/publish-plan.js";
import { folderConflicts, folderMatchesProjection, readProjection } from "../src/hosted/sync-scan.js";
import { FakeCreateHost, FAKE_STAGE_BOUNDS } from "./support/fake-hosted-create.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  auth: HostedAuthDeps;
  out: string[];
  err: string[];
}

async function harness(): Promise<Harness> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "sb-staged-home-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-staged-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  return { home, cwd, auth, out: [], err: [] };
}

const slept: number[] = [];

async function run(h: Harness, argv: string[], fake: FakeCreateHost): Promise<Record<string, unknown>> {
  await publish(argv, {
    stdout: (text) => h.out.push(text),
    stderr: (text) => h.err.push(text),
    sleep: async (ms) => void slept.push(ms),
    auth: h.auth,
    cwd: h.cwd,
    fetch: fake.fetch,
  });
  const last = h.out.at(-1)!.trim();
  return (last.startsWith("{") ? JSON.parse(last) : decode(last)) as Record<string, unknown>;
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

const ROOT = '---\nokf_version: "0.2"\ntitle: Big notes\n---\n# Big notes\n';
const BIG_FILE = 2 * 1024 * 1024;

/**
 * A bundle past one request's bounds: `count` documents of about 2 KiB (so the parts split on
 * objects and on bytes), a reserved file, two files over 1 MB (one of them twice, under two keys)
 * and a small one.
 */
async function writeBigBundle(folder: string, count = 1_200): Promise<void> {
  await mkdir(path.join(folder, "notes"), { recursive: true });
  await mkdir(path.join(folder, "assets"), { recursive: true });
  await writeFile(path.join(folder, "index.md"), ROOT);
  await writeFile(path.join(folder, "notes", "index.md"), "# Notes\n");
  const filler = "lorem ipsum dolor sit amet ".repeat(80);
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(folder, "notes", `n${String(i).padStart(5, "0")}.md`), `---\ntype: Note\ntitle: Note ${i}\n---\nBody ${i}. ${filler}\n`);
  }
  const big = Buffer.alloc(BIG_FILE, 7);
  await writeFile(path.join(folder, "assets", "big.bin"), big);
  await writeFile(path.join(folder, "assets", "big-copy.bin"), big);
  await writeFile(path.join(folder, "assets", "other.bin"), Buffer.alloc(BIG_FILE + 1, 9));
  await writeFile(path.join(folder, "assets", "logo.txt"), "logo");
}

const routesOf = (fake: FakeCreateHost) => fake.requests.map((request) => request.path.replace(/^\/sync\/v1\//, ""));
const stageBodies = (fake: FakeCreateHost) => fake.requests.filter((request) => request.path.endsWith("/bundle-create-stage")).map((request) => request.body as { documents: unknown[]; reserved: unknown[]; history: unknown[] });
const requestIds = (fake: FakeCreateHost) => new Set(fake.requests.filter((request) => request.path.includes("bundle-create")).map((request) => request.headers.get("x-superbee-write-request")));

async function assertCheckout(h: Harness, folder: string): Promise<void> {
  assert.equal((await bundleHomeAt(folder, { home: h.home })).home, "hosted");
  const binding = await bindingForPath(h.home, folder);
  assert.ok(binding, "the folder is a hosted checkout");
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try {
    const projection = await readProjection(h.home, binding.checkout_id, store);
    assert.equal(await folderMatchesProjection(folder, projection), true);
    assert.deepEqual(await folderConflicts(folder, store, projection), []);
  } finally {
    await store.close();
  }
}

test("the preview names the staged path past one request's bounds; a small bundle stays one request", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 1_001);
  const fake = new FakeCreateHost();
  const preview = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST], fake);
  assert.equal(fake.requests.length, 0, "a preview is offline");
  assert.equal(preview.ready, true);
  const travels = preview.travels as Record<string, unknown>;
  assert.equal(travels.documents, 1_001);
  assert.match(String(travels.sent), /^staged: 1001 documents \(one request carries at most 1000\)/);
  // One file over 1 MB alone makes a small bundle staged.
  const small = path.join(h.cwd, "small");
  await mkdir(small, { recursive: true });
  await writeFile(path.join(small, "index.md"), ROOT);
  await writeFile(path.join(small, "a.md"), "---\ntype: Note\n---\nA\n");
  await writeFile(path.join(small, "big.bin"), Buffer.alloc(BIG_FILE));
  assert.match(String(((await run(h, ["--to", "hosted", "--dir", small, "--host", HOST], fake)).travels as Record<string, unknown>).sent), /^staged: a file over 1 MB \(big\.bin\)/);
  await writeFile(path.join(small, "big.bin"), "tiny");
  assert.equal(((await run(h, ["--to", "hosted", "--dir", small, "--host", HOST], fake)).travels as Record<string, unknown>).sent, "one request");
  // A file over 16 MiB blocks either way.
  await writeFile(path.join(small, "big.bin"), Buffer.alloc(STAGED_PUBLISH_BOUNDS.blobBytes + 1));
  const blocked = await run(h, ["--to", "hosted", "--dir", small, "--host", HOST], fake);
  assert.equal(blocked.ready, false);
  assert.match(JSON.stringify(blocked.blockers), /over the 16 MiB a file may hold/);
});

test("--yes stages the bundle: begin, files, disjoint bounded parts, commits, then the one-shot's conversion", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder);
  const before = await readFile(path.join(folder, "notes", "n00000.md"));
  const fake = new FakeCreateHost();
  fake.commitSteps = 2;
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"], fake);
  assert.equal(receipt.published, "created");
  assert.deepEqual(receipt.sent, { documents: 1_200, reserved_files: 2, other_files: 4, history: { imported: 0, verified: false } });
  // No one-shot request; one request id names the whole creation.
  assert.equal(fake.creates.length, 0);
  assert.equal(requestIds(fake).size, 1);
  const routes = routesOf(fake).filter((route) => route.startsWith("bundle-create"));
  assert.equal(routes[0], "bundle-create-begin");
  assert.equal(routes.filter((route) => route === "bundle-create-begin").length, 1);
  // Files first (each distinct version once: the copy shares its version), then parts, then commits.
  assert.equal(routes.filter((route) => route === "bundle-create-blob").length, 3);
  assert.deepEqual(routes.slice(-3), ["bundle-create-commit", "bundle-create-commit", "bundle-create-commit"]);
  // Parts: within the host's bounds, about 1 MiB, and disjoint, covering every version once.
  const parts = fake.requests.filter((request) => request.path.endsWith("/bundle-create-stage"));
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  const seen = new Set<string>();
  for (const part of parts) {
    const body = part.body as { documents: { id: string }[]; reserved: { dir: string; name: string }[]; history: unknown[] };
    const objects = body.documents.length + body.reserved.length + body.history.length;
    assert.ok(objects <= FAKE_STAGE_BOUNDS.partObjects, `${objects} objects`);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 1.1 * 1024 * 1024, "about 1 MiB");
    for (const id of [...body.documents.map((doc) => doc.id), ...body.reserved.map((r) => `${r.dir}/${r.name}`)]) {
      assert.ok(!seen.has(id), `${id} staged twice`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, 1_200 + 2);
  // Progress on stderr, one line per event; stdout is the one receipt.
  assert.equal(h.out.length, 1);
  assert.match(h.err[0]!, /^publish: staging: 0\/1202 objects and 0\/3 files on the host\n$/);
  assert.ok(h.err.some((line) => /^publish: sent part 1\/\d+ \(\d+ objects\)\n$/.test(line)));
  assert.ok(h.err.some((line) => /^publish: sent file \d\/3 assets\/\S+ \(2\.0 MiB\)\n$/.test(line)));
  // The host names at most 1,000 missing versions: the first commit names the rest, which are staged then.
  assert.equal(h.err.find((line) => line.startsWith("publish: commit 1:")), "publish: commit 1: staging\n");
  assert.ok(h.err.some((line) => /^publish: commit 2: importing \(written: /.test(line)));
  // Past what a checkout holds, the folder is left as it is, and the receipt says why.
  assert.deepEqual(await readFile(path.join(folder, "notes", "n00000.md")), before);
  assert.equal(readCheckoutMarker(folder), null);
  assert.equal(await bindingForPath(h.home, folder), null);
  assert.equal(receipt.home, "local");
  assert.match(String(receipt.checkout), /^not converted: .* at most 1000 documents/);
  assert.equal(await readPendingCreate(h.home, folder, "big.notes"), null);
  const bundle = fake.bundles.get("big.notes")!;
  assert.equal(bundle.docs.size, 1_200);
  assert.deepEqual(bundle.blobs.map((blob) => blob.key).sort(), ["assets/big-copy.bin", "assets/big.bin", "assets/logo.txt", "assets/other.bin"]);
});

test("--json reports progress as JSON lines on stderr; a staged bundle a checkout can hold is converted as one request's is", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 600);
  const fake = new FakeCreateHost();
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes", "--json"], fake);
  assert.equal(receipt.published, "created");
  const events = h.err.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(events.every((event) => event.event === "publish.progress"));
  assert.deepEqual([...new Set(events.map((event) => event.phase))], ["begin", "blob", "stage"]);
  assert.deepEqual(events[0], { event: "publish.progress", phase: "begin", state: "staging", versions: 602, staged: 0, blobs: 3, stagedBlobs: 0 });
  assert.equal(readCheckoutMarker(folder)?.bundle_id, "big-notes");
  await assertCheckout(h, folder);
  assert.deepEqual(receipt.checkout, { matched: 600, placed: 0, conflicts: 0, local_only: 0 });
});

test("killed mid-stage, the same command resumes under the same request id and stages only what is missing", async () => {
  for (const applied of [false, true]) {
    const h = await harness();
    const folder = path.join(h.cwd, "big");
    await writeBigBundle(folder, 1_000);
    const fake = new FakeCreateHost();
    // The connection drops at the second part: before the host saw it, or after it kept it.
    fake.interrupt = { route: "bundle-create-stage", after: 1, applied };
    const argv = ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"];
    const unknown = await rejects(run(h, argv, fake));
    assert.equal(unknown.code, "TRANSIENT");
    assert.equal(unknown.details?.reason, "write_outcome_unknown");
    assert.match(unknown.help ?? "", /resumes the same creation/);
    assert.equal(await bindingForPath(h.home, folder), null);
    const first = stageBodies(fake).length;
    const firstIds = new Set(stageBodies(fake).slice(0, applied ? 2 : 1).flatMap((body) => (body.documents as { id: string }[]).map((doc) => doc.id)));
    assert.equal(fake.stagedState([...requestIds(fake)][0]!), "staging");
    const receipt = await run(h, argv, fake);
    assert.equal(receipt.published, "created");
    assert.equal(requestIds(fake).size, 1, "one request id across both runs");
    // The resumed run sends no file again and no version the host kept.
    const resumed = stageBodies(fake).slice(first).flatMap((body) => (body.documents as { id: string }[]).map((doc) => doc.id));
    assert.equal(resumed.filter((id) => firstIds.has(id)).length, 0, `applied=${applied}`);
    assert.equal(resumed.length + firstIds.size, 1_000);
    assert.equal(routesOf(fake).filter((route) => route === "bundle-create-blob").length, 3);
    await assertCheckout(h, folder);
  }
});

test("killed mid-commit, the same command goes on committing without staging again", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 300);
  const fake = new FakeCreateHost();
  fake.commitSteps = 3;
  fake.interrupt = { route: "bundle-create-commit", after: 1, applied: true };
  const argv = ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"];
  assert.equal((await rejects(run(h, argv, fake))).code, "TRANSIENT");
  const requestId = [...requestIds(fake)][0]!;
  assert.equal(fake.stagedState(requestId), "importing");
  const sent = fake.requests.length;
  const receipt = await run(h, argv, fake);
  assert.equal(receipt.published, "created");
  const resumed = routesOf(fake).slice(sent).filter((route) => route.startsWith("bundle-create"));
  assert.deepEqual(resumed, ["bundle-create-begin", "bundle-create-commit", "bundle-create-commit"]);
  assert.equal(requestIds(fake).size, 1);
  await assertCheckout(h, folder);
});

test("a 503 from commit is retried in the same run", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 200);
  const fake = new FakeCreateHost();
  fake.failNextCommit = true;
  slept.length = 0;
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake);
  assert.equal(receipt.published, "created");
  assert.equal(routesOf(fake).filter((route) => route === "bundle-create-commit").length, 2);
  assert.deepEqual(slept, [500]);
});

test("a creation whose manifest the host swept is begun again and re-staged, before and after the reservation", async () => {
  for (const reserved of [false, true]) {
    const h = await harness();
    const folder = path.join(h.cwd, "big");
    await writeBigBundle(folder, 300);
    const fake = new FakeCreateHost();
    if (reserved) fake.commitSteps = 1;
    // The sweep runs just before the first (or, once reserved, the second) commit.
    const at = reserved ? 2 : 1;
    fake.onRequest = (route, count) => {
      if (route === "bundle-create-commit" && count === at) fake.sweepStaging();
    };
    const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"], fake);
    assert.equal(receipt.published, "created");
    const routes = routesOf(fake).filter((route) => route.startsWith("bundle-create"));
    assert.equal(routes.filter((route) => route === "bundle-create-begin").length, 2, `reserved=${reserved}`);
    // Everything was staged twice, the files too.
    assert.equal(routes.filter((route) => route === "bundle-create-blob").length, 6);
    assert.equal(fake.bundles.get("big.notes")!.docs.size, 300);
    await assertCheckout(h, folder);
  }
});

test("staged refusals map to the CLI taxonomy: an id taken at commit, too many open creations", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 100);
  const taken = new FakeCreateHost();
  taken.onRequest = (route, count) => {
    // Another creation takes the id while this one stages.
    if (route === "bundle-create-commit" && count === 1) taken.bundles.set("big.notes", { workspace: "tenant:a", name: "x", docs: new Map(), root: null, reserved: [], blobs: [], history: [] });
  };
  const exists = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"], taken));
  assert.equal(exists.code, "ALREADY_EXISTS");
  assert.equal(await readPendingCreate(h.home, folder, "big.notes"), null);
  // Three unfinished staged creations already open in the workspace.
  const busy = new FakeCreateHost();
  for (const id of ["a.one", "a.two", "a.three"]) {
    busy.interrupt = { route: "bundle-create-stage", after: busy.routeCounts.get("bundle-create-stage") ?? 0, applied: false };
    await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", id, "--yes"], busy));
  }
  const open = await rejects(run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "a.four", "--yes"], busy));
  assert.equal(open.code, "FORBIDDEN");
  assert.equal(open.details?.reason, "bundle_create_limit");
  assert.match(open.message, /unfinished large publishes/);
});

test("the staged preview blocks past 5,000 earlier versions and past a 3 MiB manifest, naming the remedy", () => {
  const doc = (id: string) => ({ id, frontmatter: { type: "Note" }, body: "x\n" });
  const row = (documentId: string, i: number): CreateHistory => ({
    documentId,
    label: `imported:git/${i.toString(16).padStart(40, "0")}`,
    author: "Ada <ada@example.com>",
    authoredAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    frontmatter: { type: "Note" },
    body: `v${i}\n`,
  });
  const root = { dir: "", name: "index.md", content: ROOT };
  const versions: PlanContent = { documents: [doc("a")], reserved: [root], blobs: [], history: Array.from({ length: 5_001 }, (_, i) => row("a", i)) };
  const tooMany = stagedBlockers(versions);
  assert.deepEqual(tooMany.map((b) => b.reason), ["too_much_history"]);
  assert.match(tooMany[0]!.message, /5001 earlier versions; .* at most 5000: publish without --with-history/);
  // Long ids: within the count bounds, past the manifest's 3 MiB.
  const long = (i: number) => `notes/${"x".repeat(300)}/${String(i).padStart(5, "0")}`;
  const wide: PlanContent = { documents: Array.from({ length: 9_000 }, (_, i) => doc(long(i))), reserved: [root], blobs: [], history: [] };
  const manifest = stagedBlockers(wide);
  assert.deepEqual(manifest.map((b) => b.reason), ["manifest_too_large"]);
  assert.match(manifest[0]!.message, /the host takes at most 3 MiB: publish fewer files/);
  const withHistory = stagedBlockers({ ...wide, history: [row(long(0), 1)] });
  assert.match(withHistory.at(-1)!.message, /publish without --with-history/);
});

test("a qualifying client sends the staged routes unqualified, and raw bytes only to them", async () => {
  const sent: { route: string; input: unknown }[] = [];
  const inner = {
    json: async (route: string, input: unknown) => (sent.push({ route, input }), { status: 200, headers: new Headers(), body: {} }),
    stream: async () => assert.fail("no stream"),
    bytes: async (route: string) => (sent.push({ route, input: "bytes" }), { status: 200, headers: new Headers(), body: {} }),
  };
  const carrier = qualifyingCarrier(inner, "/sync/v1", "acme");
  const signal = new AbortController().signal;
  for (const route of ["bundle-create-begin", "bundle-create-stage", "bundle-create-commit"]) await carrier.json(`/sync/v1/${route}`, { bundleId: "big.notes" }, signal, { maximum: 1 });
  await carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array(1), signal, { maximum: 1 });
  await carrier.json("/sync/v1/heads", { bundleId: "big.notes" }, signal, { maximum: 1 });
  assert.deepEqual(sent, [
    { route: "/sync/v1/bundle-create-begin", input: { bundleId: "big.notes" } },
    { route: "/sync/v1/bundle-create-stage", input: { bundleId: "big.notes" } },
    { route: "/sync/v1/bundle-create-commit", input: { bundleId: "big.notes" } },
    { route: "/sync/v1/bundle-create-blob", input: "bytes" },
    { route: "/sync/v1/heads", input: { bundleId: "acme/big.notes" } },
  ]);
  await assert.rejects(carrier.bytes!("/sync/v1/heads", new Uint8Array(1), signal, { maximum: 1 }), TypeError);
});

test("a retryable request_conflict from begin waits a minute and begins again; past five it is final", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 50);
  const fake = new FakeCreateHost();
  fake.busyBegins = 2;
  slept.length = 0;
  const receipt = await run(h, ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"], fake);
  assert.equal(receipt.published, "created");
  assert.deepEqual(slept, [60_000, 60_000]);
  assert.equal(h.err.filter((line) => line.startsWith("publish: waiting 60 s:")).length, 2);
  const other = path.join(h.cwd, "other");
  await writeBigBundle(other, 50);
  fake.busyBegins = 6;
  const conflict = await rejects(run(h, ["--to", "hosted", "--dir", other, "--host", HOST, "--bundle-id", "other.notes", "--yes"], fake));
  assert.equal(conflict.code, "CONFLICT");
  assert.ok(await readPendingCreate(h.home, other, "other.notes"), "the request id is kept to finish it");
});

test("the created answer lost on the way, the same command confirms the creation and converts the folder", async () => {
  const h = await harness();
  const folder = path.join(h.cwd, "big");
  await writeBigBundle(folder, 50);
  const fake = new FakeCreateHost();
  fake.interrupt = { route: "bundle-create-commit", after: 0, applied: true };
  const argv = ["--to", "hosted", "--dir", folder, "--host", HOST, "--bundle-id", "big.notes", "--yes"];
  assert.equal((await rejects(run(h, argv, fake))).code, "TRANSIENT");
  assert.equal(fake.stagedState([...requestIds(fake)][0]!), "created");
  fake.sweepStaging();
  const sent = fake.requests.length;
  const receipt = await run(h, argv, fake);
  assert.equal(receipt.published, "created");
  assert.deepEqual(routesOf(fake).slice(sent).filter((route) => route.startsWith("bundle-create")), ["bundle-create-begin", "bundle-create-commit"]);
  await assertCheckout(h, folder);
});
