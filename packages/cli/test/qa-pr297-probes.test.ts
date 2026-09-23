// Adversarial QA probes for PR 297 (head 2163424d, adopted with the fixes for M1, M2, L1-L3): delete sync, the tombstone-based re-create,
// and the mass-delete hold, against the PR's stateful fake host. Each test is one probe; a failing
// assertion is a finding, not a flaky test. Probes that pin a design gap log `# FINDING` and
// assert the observed behavior so the suite documents it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, realpath, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { doc as docCommand } from "../src/commands/doc.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface H {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  out: string[];
  before?: (route: string, body: Record<string, unknown>) => Promise<void> | void;
}

async function harness(host = new FakeHost()): Promise<H> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa297-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa297-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  const h: H = { home, cwd, folder: path.join(cwd, "team"), auth, host, out: [] };
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  host.writes.length = 0;
  host.applied.length = 0;
  return h;
}

const instant = async () => {};
const fetchFor = (h: H) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.replace(/^\/sync\/v1\//, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    await h.before?.(route, body);
    return h.host.fetch(input, init);
  }) as typeof fetch;

type Outcome = { ok: true; receipt: Record<string, unknown> } | { ok: false; error: CliError; receipt: Record<string, unknown> | null };

async function attempt(h: H, argv: string[] = [], lockWaitMs = 200): Promise<Outcome> {
  const out: string[] = [];
  try {
    await sync(["--dir", h.folder, ...argv], { stdout: (t: string) => void out.push(t), auth: h.auth, cwd: h.cwd, fetch: fetchFor(h), write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant, lockWaitMs });
    h.out = out;
    return { ok: true, receipt: decode(out.at(-1)!.trim()) as Record<string, unknown> };
  } catch (error) {
    h.out = out;
    const receipt = out.length > 0 ? (decode(out.at(-1)!.trim()) as Record<string, unknown>) : null;
    if (!(error instanceof CliError)) return { ok: false, error: new CliError("RUNTIME", `UNMAPPED ${(error as Error).name}: ${(error as Error).message}`), receipt };
    return { ok: false, error, receipt };
  }
}
async function ok(h: H, argv: string[] = []) {
  const r = await attempt(h, argv);
  if (!r.ok) assert.fail(`expected success, got ${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)} ${JSON.stringify(r.receipt)}`);
  return r.receipt;
}
async function fails(h: H, argv: string[] = []) {
  const r = await attempt(h, argv);
  if (r.ok) assert.fail(`expected failure, got ${JSON.stringify(r.receipt)}`);
  return r;
}

type Row = { id: string; state: string; reason: string; version: string | null; message: string };
const rowsOf = (r: Record<string, unknown> | null): Row[] => (r?.rows as Row[]) ?? [];
const rowFor = (r: Record<string, unknown> | null, id: string) => rowsOf(r).find((row) => row.id === id);
const fileOf = (h: H, id: string) => path.join(h.folder, `${id}.md`);
const readFileOrNull = (h: H, id: string) => readFile(fileOf(h, id), "utf8").catch(() => null);
const writeDoc = async (h: H, id: string, title: string, body: string) => {
  await mkdir(path.dirname(fileOf(h, id)), { recursive: true });
  await writeFile(fileOf(h, id), `---\ntype: "Note"\ntitle: ${JSON.stringify(title)}\n---\n${body}`);
};
const writeRoutes = (h: H) => h.host.writes.filter((c) => c.route !== "outcome");
const deletes = (h: H) => h.host.writes.filter((c) => c.route === "delete");
const tombstones = (h: H, id: string) => h.host.tombstones.get(id)?.length ?? 0;

/** A host with `n` extra documents under bulk/, plus the fixture's three. */
function bulkHost(n: number): FakeHost {
  const host = new FakeHost();
  for (let i = 0; i < n; i += 1) host.put(`bulk/n${String(i).padStart(2, "0")}`, { type: "Note", title: `N${i}` }, `bulk ${i}\n`);
  return host;
}
const bulkIds = (n: number) => Array.from({ length: n }, (_, i) => `bulk/n${String(i).padStart(2, "0")}`);

// ------------------------------------------------------------------------------ delete conflicts

test("DC1 local delete vs host edit of the same document: conflict, the host edit is never deleted, across repeated syncs", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  const theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "HOST edit.\n");
  const first = await fails(h);
  assert.deepEqual([rowFor(first.receipt, "notes/alpha")?.state, rowFor(first.receipt, "notes/alpha")?.reason], ["conflict", "changed_remotely"]);
  for (let i = 0; i < 3; i += 1) {
    const again = await fails(h);
    assert.equal(rowFor(again.receipt, "notes/alpha")?.state, "conflict");
  }
  assert.equal(h.host.docs.get("notes/alpha")?.version, theirs, "the host edit survived");
  assert.equal(tombstones(h, "notes/alpha"), 0);
  assert.equal(deletes(h).length, 1, "the stale delete is sent once and never resent");
  assert.match(rowFor(first.receipt, "notes/alpha")!.message, /changed on the host while you deleted it/);
});

test("DC1b the host edits the document while the delete is in flight (between scan and push): conflict, edit kept", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  let theirs = "";
  h.before = (route) => {
    if (route === "delete" && !theirs) theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "HOST raced.\n");
  };
  const r = await fails(h);
  h.before = undefined;
  assert.equal(rowFor(r.receipt, "notes/alpha")?.state, "conflict");
  assert.equal(h.host.docs.get("notes/alpha")?.version, theirs);
});

test("DC1c a scoped run cannot sneak the delete past a host edit: file deleted, host edits, resolve of another doc, then sync", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  const theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "HOST edit C.\n");
  // A plain sync that does not reach push for alpha: simulate a pull-only run by making the push paused (quota).
  h.host.hook = (call) => (call.route === "delete" ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "quota", retryable: false, writeState: "not_applied" } } } : undefined);
  await fails(h);
  h.host.hook = undefined;
  const r = await attempt(h);
  assert.ok(h.host.docs.has("notes/alpha"), `the host edit was deleted: ${JSON.stringify(r.ok ? r.receipt : r.receipt)}`);
  assert.equal(h.host.docs.get("notes/alpha")?.version, theirs);
});

test("DC2 local delete plus host delete at the same base: one tombstone, a committed 'deleted' row, nothing re-sent", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  const t = h.host.deleteWithTombstone("notes/alpha");
  const r = await attempt(h);
  const row = rowFor(r.receipt, "notes/alpha");
  console.log(`# DC2 row=${JSON.stringify(row)} ok=${r.ok}`);
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.ok(!h.host.docs.has("notes/alpha"));
  const again = await ok(h);
  assert.equal(again.status, "up_to_date");
  // The checkout adopted the other deleter's tombstone as its own (changed:false names it).
  await writeDoc(h, "notes/alpha", "Alpha", "back\n");
  const back = await attempt(h);
  const create = writeRoutes(h).at(-1)!;
  console.log(`# DC2 re-create after a shared delete: route=${create.route} recreate=${create.recreate === t ? "the other deleter's tombstone" : create.recreate} ok=${back.ok}`);
});

test("DC3 deleting a document with inbound links warns (scan receipt and row), never refuses; a linker added in the same sync is counted", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  await writeDoc(h, "notes/fresh", "Fresh", "See [Alpha](alpha.md).\n");
  const r = await ok(h);
  assert.equal(rowFor(r, "notes/alpha")?.reason, "deleted");
  const deletions = r.deletions as { id: string; still_linked_from?: string[]; warning?: string }[];
  assert.ok(deletions[0]!.still_linked_from!.includes("notes/fresh"), JSON.stringify(deletions));
  assert.match(deletions[0]!.warning!, /still link/);
  assert.match(rowFor(r, "notes/alpha")!.message, /notes\/fresh/);
  assert.ok(h.host.docs.has("notes/fresh"));
  assert.ok(!h.host.docs.has("notes/alpha"));
});

test("DC3b `doc delete` in a hosted checkout: does the command itself warn about inbound links?", async () => {
  const h = await harness();
  const out: string[] = [];
  let error: unknown = null;
  try {
    await docCommand(["delete", "notes/alpha", "--dir", h.folder], { stdout: (t: string) => void out.push(t) } as never);
  } catch (e) {
    error = e;
  }
  const text = out.join("");
  console.log(`# DC3b doc delete: error=${error ? (error as Error).message.slice(0, 160) : "none"} output=${JSON.stringify(text.slice(0, 300))}`);
  const r = await attempt(h);
  console.log(`# DC3b next sync alpha row=${JSON.stringify(rowFor(r.receipt, "notes/alpha"))} deletions=${JSON.stringify(r.receipt?.deletions)}`);
});

// ------------------------------------------------------------------------------------ re-create

async function deletedRemotelyConflict(): Promise<{ h: H; t1: string }> {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "LOCAL alpha.\n");
  const t1 = h.host.deleteWithTombstone("notes/alpha");
  const r = await fails(h);
  assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "deleted_remotely");
  return { h, t1 };
}

/** The same, advanced to a conflict that names the tombstone: the replace's document_not_found names none, so a first inspect+keep sends an unacknowledged create that the host refuses naming it. */
async function tombstonedConflict(): Promise<{ h: H; t1: string }> {
  const { h, t1 } = await deletedRemotelyConflict();
  const first = await ok(h, ["--inspect", "notes/alpha"]);
  assert.equal((first.remote as { deleted_as?: string }).deleted_as, undefined);
  await attempt(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const r = await fails(h);
  assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.ok(!h.host.docs.has("notes/alpha"), "an unacknowledged create re-created a tombstoned document");
  return { h, t1 };
}

test("RC1 keep (and revise) on 'deleted remotely' without --inspect is refused; nothing is sent", async () => {
  const { h } = await deletedRemotelyConflict();
  const before = h.host.writes.length;
  for (const choice of ["keep", "revise"]) {
    const r = await fails(h, ["--resolve", choice, "--doc", "notes/alpha"]);
    assert.equal(r.error.details?.reason, "not_inspected", `${choice}: ${r.error.code} ${JSON.stringify(r.error.details)}`);
  }
  assert.equal(h.host.writes.length, before);
  assert.ok(!h.host.docs.has("notes/alpha"));
});

test("RC2 keep after --inspect whose tombstone went stale (re-created and deleted again): a fresh conflict naming the newer tombstone", async () => {
  const { h, t1 } = await tombstonedConflict();
  const shown = await ok(h, ["--inspect", "notes/alpha"]);
  assert.equal((shown.remote as { deleted_as?: string }).deleted_as, t1);
  h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "someone re-created\n");
  const t2 = h.host.deleteWithTombstone("notes/alpha");
  const keep = await attempt(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const next = await attempt(h);
  assert.ok(!h.host.docs.has("notes/alpha"), "a stale acknowledgement re-created the document");
  const shown2r = await attempt(h, ["--inspect", "notes/alpha"]);
  console.log(`# RC2 keep=${keep.ok ? JSON.stringify(rowFor(keep.receipt, "notes/alpha")) : `${keep.error.code} ${JSON.stringify(keep.error.details)}`} next=${JSON.stringify(rowFor(next.receipt, "notes/alpha"))} inspect=${shown2r.ok ? JSON.stringify(shown2r.receipt.remote) : shown2r.error.message} t1=${t1.slice(7, 15)} t2=${t2.slice(7, 15)} creates=${JSON.stringify(h.host.writes.filter((c) => c.route === "create").map((c) => c.recreate?.slice(7, 15) ?? null))}`);
  const shown2 = shown2r.ok ? shown2r.receipt : {};
  assert.equal((shown2.remote as { deleted_as?: string }).deleted_as, t2, `keep=${keep.ok ? "ok" : keep.error.details?.reason} next=${JSON.stringify(rowFor(next.receipt, "notes/alpha"))}`);
});

test("RC2b keep after --inspect, but the host re-created the document meanwhile (present): never overwrites it", async () => {
  const { h } = await tombstonedConflict();
  await ok(h, ["--inspect", "notes/alpha"]);
  const theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "someone re-created\n");
  const keep = await attempt(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  await attempt(h);
  console.log(`# RC2b keep=${keep.ok ? "ok" : `${keep.error.code} ${keep.error.details?.reason}`}`);
  assert.equal(h.host.docs.get("notes/alpha")?.version, theirs, "the host's re-created version was overwritten");
});

test("RC3 the checkout's own delete then re-create works, and a second own delete/re-create cycle too (fresh tombstones each time)", async () => {
  const h = await harness();
  const saved = (await readFileOrNull(h, "notes/alpha"))!;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await unlink(fileOf(h, "notes/alpha"));
    await ok(h);
    const t = h.host.latestTombstone("notes/alpha")!.tombstone;
    await writeFile(fileOf(h, "notes/alpha"), saved);
    const r = await ok(h);
    assert.equal(rowFor(r, "notes/alpha")?.state, "committed");
    assert.equal(writeRoutes(h).at(-1)!.recreate, t);
  }
  assert.equal(tombstones(h, "notes/alpha"), 2);
  const set = new Set(h.host.tombstones.get("notes/alpha")!.map((x) => x.tombstone));
  assert.equal(set.size, 2, "tombstones are unique across delete/recreate/delete of the same bytes");
});

test("RC3b own delete, then someone re-creates and deletes it again: the local re-create's auto-acknowledgement is stale and conflicts", async () => {
  const h = await harness();
  const saved = (await readFileOrNull(h, "notes/alpha"))!;
  await unlink(fileOf(h, "notes/alpha"));
  await ok(h);
  h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "other re-create\n");
  await ok(h); // pulls it back
  const t2 = h.host.deleteWithTombstone("notes/alpha");
  await ok(h); // pulls the deletion
  await writeFile(fileOf(h, "notes/alpha"), saved);
  const r = await fails(h);
  assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.ok(!h.host.docs.has("notes/alpha"));
  assert.notEqual(writeRoutes(h).at(-1)!.recreate, t2, "never acknowledges a deletion it did not observe");
});

test("RC4 someone else's delete, then a local re-create without resolving: conflict, never auto-acknowledged, on every sync", async () => {
  const h = await harness();
  const saved = (await readFileOrNull(h, "notes/alpha"))!;
  h.host.deleteWithTombstone("notes/alpha");
  await ok(h);
  assert.equal(await readFileOrNull(h, "notes/alpha"), null, "the pull removed the file");
  await writeFile(fileOf(h, "notes/alpha"), saved);
  for (let i = 0; i < 3; i += 1) {
    const r = await fails(h);
    assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "deleted_remotely");
  }
  assert.ok(!h.host.docs.has("notes/alpha"));
  assert.deepEqual(h.host.writes.filter((c) => c.route === "create").map((c) => c.recreate), [null], "one create, no acknowledgement");
});

test("RC4b someone else's delete; take it; re-create the file: still a conflict (take never adopts their tombstone)", async () => {
  const { h } = await deletedRemotelyConflict();
  await ok(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  await writeDoc(h, "notes/alpha", "Alpha", "again\n");
  const r = await fails(h);
  assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "deleted_remotely");
  assert.ok(h.host.writes.filter((c) => c.route === "create").every((c) => c.recreate === null));
});

test("RC5 own delete whose answer is lost past retention settles by read-back; a later re-create then conflicts (no tombstone known)", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  h.host.hook = (call) => (call.route === "delete" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  const lost = await fails(h);
  assert.equal(rowFor(lost.receipt, "notes/alpha")?.state, "unknown");
  h.host.hook = undefined;
  h.host.recorded.clear();
  const realNow = Date.now;
  Date.now = () => realNow() + 400 * 24 * 3600 * 1000;
  try {
    const settled = await attempt(h);
    console.log(`# RC5 settle past retention: ${JSON.stringify(rowFor(settled.receipt, "notes/alpha"))}`);
    const saved = '---\ntype: "Note"\ntitle: "Alpha"\n---\nback\n';
    await writeFile(fileOf(h, "notes/alpha"), saved);
    const back = await attempt(h);
    console.log(`# RC5 own re-create after a read-back settle: ${JSON.stringify(rowFor(back.receipt, "notes/alpha"))}`);
  } finally {
    Date.now = realNow;
  }
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.equal(deletes(h).length, 1, "never resent past retention");
});

test("RC6 a delete sent but unanswered, then the file re-created before the next sync: one tombstone, the re-create is not auto-acknowledged (recorded before the commit)", async () => {
  const h = await harness();
  const saved = (await readFileOrNull(h, "notes/alpha"))!;
  await unlink(fileOf(h, "notes/alpha"));
  h.host.hook = (call) => (call.route === "delete" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  await fails(h);
  h.host.hook = undefined;
  await writeFile(fileOf(h, "notes/alpha"), saved);
  const r = await attempt(h);
  const r2 = await attempt(h);
  assert.equal(rowFor(r2.receipt, "notes/alpha")?.state ?? rowFor(r.receipt, "notes/alpha")?.state, "committed", "review S3: the own deletion is acknowledged");
  console.log(`# RC6 re-create chained after an in-flight own delete: ${JSON.stringify(rowFor(r.receipt, "notes/alpha"))} then ${JSON.stringify(rowFor(r2.receipt, "notes/alpha"))}; creates=${JSON.stringify(h.host.writes.filter((c) => c.route === "create").map((c) => c.recreate))}`);
  assert.equal(tombstones(h, "notes/alpha"), 1);
});

// ----------------------------------------------------------------------- chained intents + delete

test("CH1 an edit whose answer was lost, then the file deleted: the edit lands and the chained delete removes the document (not a false conflict)", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "edited\n");
  h.host.hook = (call) => (call.route === "replace" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  await fails(h);
  h.host.hook = undefined;
  await unlink(fileOf(h, "notes/alpha"));
  const r = await attempt(h);
  const r2 = await attempt(h);
  console.log(`# CH1 rows ${JSON.stringify(rowFor(r.receipt, "notes/alpha"))} -> ${JSON.stringify(rowFor(r2.receipt, "notes/alpha"))}; delete bodies=${JSON.stringify(deletes(h).map((c) => c.body.expectedVersion === h.host.latestTombstone("notes/alpha")?.deletedVersion))}`);
  assert.ok(!h.host.docs.has("notes/alpha"), `the chained delete did not land: ${JSON.stringify(rowFor(r2.receipt, "notes/alpha"))}`);
});

test("CH2 a create whose answer was lost, then the file deleted: the chained delete removes the created document", async () => {
  const h = await harness();
  await writeDoc(h, "notes/newbie", "Newbie", "new\n");
  h.host.hook = (call) => (call.route === "create" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  await fails(h);
  h.host.hook = undefined;
  await unlink(fileOf(h, "notes/newbie"));
  const r = await attempt(h);
  const r2 = await attempt(h);
  console.log(`# CH2 rows ${JSON.stringify(rowFor(r.receipt, "notes/newbie"))} -> ${JSON.stringify(rowFor(r2.receipt, "notes/newbie"))}`);
  assert.ok(!h.host.docs.has("notes/newbie"), `the chained delete did not land: ${JSON.stringify(rowFor(r2.receipt, "notes/newbie"))}`);
});

test("CH3 a create never sent (quota-paused), then the file deleted: collapses to nothing, no request", async () => {
  const h = await harness();
  await writeDoc(h, "notes/newbie", "Newbie", "new\n");
  h.host.hook = () => ({ kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "q", retryable: false, writeState: "not_applied" } } });
  await fails(h);
  h.host.hook = undefined;
  await unlink(fileOf(h, "notes/newbie"));
  const r = await ok(h);
  assert.ok(!h.host.docs.has("notes/newbie"));
  assert.equal(deletes(h).length, 0, JSON.stringify(rowsOf(r)));
});

// ------------------------------------------------------------------------------ replay / races

test("RP1 a lost delete answer across runs (delete and lookup both dropped), then rerun: exactly one tombstone, one delete request identity", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  h.host.hook = (call) => (call.route === "delete" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  const lost = await fails(h);
  assert.equal(rowFor(lost.receipt, "notes/alpha")?.state, "unknown");
  h.host.hook = undefined;
  const r = await ok(h);
  assert.equal(rowFor(r, "notes/alpha")?.state, "committed");
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.equal(new Set(deletes(h).map((c) => c.requestId)).size, 1);
  assert.equal((await ok(h)).status, "up_to_date");
});

test("RP2 a delete dropped before it reached the host, then rerun: sent again under the same identity, one tombstone", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  h.host.hook = (call) => (call.route === "delete" || call.route === "outcome" ? { kind: "drop" } : undefined);
  await fails(h);
  h.host.hook = undefined;
  await ok(h);
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.equal(new Set(deletes(h).map((c) => c.requestId)).size, 1);
});

test("RP3 two syncs while a delete is in flight: the second is refused sync_busy; one tombstone", async () => {
  const h = await harness();
  await unlink(fileOf(h, "notes/alpha"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => (entered = resolve));
  h.before = async (route) => {
    if (route === "delete") {
      entered();
      await gate;
    }
  };
  const first = attempt(h, [], 5_000);
  await inFlight;
  const h2: H = { ...h, out: [], before: undefined };
  const second = await attempt(h2, [], 200);
  release();
  const firstResult = await first;
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.details?.reason, "sync_busy", !second.ok ? `${second.error.code} ${JSON.stringify(second.error.details)}` : "");
  assert.equal(firstResult.ok, true);
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.equal(deletes(h).length, 1);
});

// ------------------------------------------------------------------------------ mass-delete hold

test("MD1 rm -rf of every document in a 23-document checkout: held as a whole, nothing sent; how is it released?", async () => {
  const h = await harness(bulkHost(20));
  const all = ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(20)];
  for (const id of all) await unlink(fileOf(h, id));
  const r = await fails(h);
  assert.equal(rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").length, 23);
  assert.deepEqual(writeRoutes(h), []);
  const again = await fails(h);
  const restored = (await Promise.all(all.map((id) => readFileOrNull(h, id)))).filter((x) => x !== null).length;
  console.log(`# MD1 second sync: ${rowsOf(again.receipt).filter((row) => row.reason === "bulk_deletion").length} still held; ${restored} files put back by sync; exit=${again.error.code}; help=${JSON.stringify(rowsOf(again.receipt)[0]?.message)}`);
  assert.equal(h.host.docs.size, 23);
});

test("MD2 7 deletions sync, 8 are held (15-document checkout)", async () => {
  const seven = await harness(bulkHost(12));
  for (const id of bulkIds(7)) await unlink(fileOf(seven, id));
  await ok(seven);
  assert.equal(deletes(seven).length, 7);
  const eight = await harness(bulkHost(12));
  for (const id of bulkIds(8)) await unlink(fileOf(eight, id));
  const r = await fails(eight);
  assert.equal(rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").length, 8);
  assert.equal(deletes(eight).length, 0);
});

test("MD3 a small checkout (5 documents): deleting every file is held; nothing is sent", async () => {
  const h = await harness(bulkHost(2));
  const all = ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(2)];
  for (const id of all) await unlink(fileOf(h, id));
  const r = await attempt(h);
  console.log(`# MD3 rm -rf of a 5-document checkout: ${deletes(h).length} deletes sent; host now holds ${h.host.docs.size} documents; status=${r.ok ? r.receipt.status : r.error.code}`);
  assert.equal(h.host.docs.size, 5, "held");
  assert.equal(deletes(h).length, 0);
});

test("MD4 a mass delete split across syncs (7 per sync) is held once the day's deletes pass half: 7 of 23 deleted", async () => {
  const h = await harness(bulkHost(20));
  const all = ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(20)];
  for (let i = 0; i < all.length; i += 7) {
    for (const id of all.slice(i, i + 7)) await unlink(fileOf(h, id));
    await attempt(h);
  }
  console.log(`# MD4 host holds ${h.host.docs.size} of 23 after four syncs of <= 7 deletes each`);
  assert.equal(h.host.docs.size, 16, "the first 7 go; the window holds the rest");
});

test("MD5 deletions journaled while the push could not run count in the hold: only the first 7 of 20 are sent", async () => {
  const h = await harness(bulkHost(17));
  const all = ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(17)];
  h.host.hook = () => ({ kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "q", retryable: false, writeState: "not_applied" } } });
  for (const id of all.slice(0, 7)) await unlink(fileOf(h, id));
  await fails(h);
  for (const id of all.slice(7, 14)) await unlink(fileOf(h, id));
  await fails(h);
  h.host.hook = undefined;
  h.host.writes.length = 0;
  await attempt(h);
  console.log(`# MD5 one push sent ${deletes(h).length} deletes; host holds ${h.host.docs.size} of 20`);
  assert.equal(deletes(h).length, 7, "the second batch was held");
});

test("MD6 new files in the same scan dilute the 'more than half' denominator: moving 12 of 15 documents is sent as 12 deletes", async () => {
  const h = await harness(bulkHost(12));
  for (const id of bulkIds(12)) {
    const bytes = (await readFileOrNull(h, id))!;
    await unlink(fileOf(h, id));
    await mkdir(path.join(h.folder, "moved"), { recursive: true });
    await writeFile(path.join(h.folder, `moved/${path.basename(id)}.md`), bytes);
  }
  const r = await attempt(h);
  console.log(`# MD6 move of 12 of 15: deletes=${deletes(h).length} creates=${h.host.writes.filter((c) => c.route === "create").length} held=${rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").length}`);
});

// ------------------------------------------------------------------------------------ refusals

test("RF1 a read-only person deleting: refused, the host keeps the document, and the file can be brought back", async () => {
  const h = await harness();
  h.host.hook = (call) => (call.route !== "outcome" ? { kind: "respond", status: 200, body: { ok: false, operationId: `documents.${call.route}.v1`, error: { code: "insufficient_scope", message: "read only", retryable: false, writeState: "not_applied" } } } : undefined);
  await unlink(fileOf(h, "notes/alpha"));
  const r = await fails(h);
  assert.equal(r.error.code, "FORBIDDEN");
  assert.equal(rowFor(r.receipt, "notes/alpha")?.reason, "read_only");
  assert.ok(h.host.docs.has("notes/alpha"));
  const again = await fails(h);
  const take = await attempt(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.ok(take.ok, "L2: take restores a refused delete");
  assert.notEqual(await readFileOrNull(h, "notes/alpha"), null, "L2: the refused delete's file is back");
  console.log(`# RF1 second sync=${rowFor(again.receipt, "notes/alpha")?.reason}; take=ok; file=${(await readFileOrNull(h, "notes/alpha")) !== null ? "present" : "absent"}; help=${JSON.stringify(rowFor(r.receipt, "notes/alpha")?.message)}`);
});

test("RF2 a bundle served without writes: the delete is not sent", async () => {
  const h = await harness();
  h.host.capabilities = "capabilities-read-only";
  await unlink(fileOf(h, "notes/alpha"));
  const r = await fails(h);
  assert.equal(r.error.code, "FORBIDDEN");
  assert.deepEqual(h.host.writes, []);
  assert.ok(h.host.docs.has("notes/alpha"));
});

test("RF3 quota: a delete paused by request_capacity is kept and sent once when the quota admits it; one tombstone", async () => {
  const h = await harness();
  let full = true;
  h.host.hook = (call) => (full && call.route !== "outcome" ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "principal", message: "q", retryable: false, writeState: "not_applied" } } } : undefined);
  await unlink(fileOf(h, "notes/alpha"));
  await unlink(fileOf(h, "notes/beta"));
  const r = await fails(h);
  assert.deepEqual(rowsOf(r.receipt).map((row) => row.state), ["paused", "paused"]);
  full = false;
  const after = await ok(h);
  assert.deepEqual(rowsOf(after).map((row) => [row.state, row.reason]), [["committed", "deleted"], ["committed", "deleted"]]);
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.equal(tombstones(h, "notes/beta"), 1);
});

test("RF4 quota runs out mid-batch: the first delete commits, the rest pause; nothing is lost or duplicated", async () => {
  const h = await harness(bulkHost(4));
  let admitted = 0;
  h.host.hook = (call) => (call.route === "delete" && admitted++ >= 1 ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "bundle", message: "q", retryable: false, writeState: "not_applied" } } } : undefined);
  for (const id of ["notes/alpha", "notes/beta", "projects/2026/plan"]) await unlink(fileOf(h, id));
  await fails(h);
  h.host.hook = undefined;
  await ok(h);
  for (const id of ["notes/alpha", "notes/beta", "projects/2026/plan"]) assert.equal(tombstones(h, id), 1, id);
  assert.equal(h.host.docs.size, 4);
});

test("CH0 (baseline, not new in this PR) an edit whose answer was lost, then a second edit: does the chained replace land?", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "edited\n");
  h.host.hook = (call) => (call.route === "replace" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  await fails(h);
  h.host.hook = undefined;
  await writeDoc(h, "notes/alpha", "Alpha", "edited twice\n");
  const r = await attempt(h);
  console.log(`# CH0 chained replace: ${JSON.stringify(rowFor(r.receipt, "notes/alpha"))}; host body=${JSON.stringify(h.host.docs.get("notes/alpha")?.body)}`);
});

test("RP4 a delete answered busy (concurrent_change) is re-recorded under a fresh identity and lands in the same run; one tombstone", async () => {
  const h = await harness();
  let busy = true;
  h.host.hook = (call) => {
    if (call.route === "delete" && busy) {
      busy = false;
      return { kind: "respond", status: 200, body: { ok: false, operationId: "documents.delete.v1", error: { code: "concurrent_change", message: "busy", retryable: true, writeState: "not_applied" } } };
    }
    return undefined;
  };
  await unlink(fileOf(h, "notes/alpha"));
  const r = await attempt(h);
  console.log(`# RP4 row=${JSON.stringify(rowFor(r.ok ? r.receipt : r.receipt, "notes/alpha"))} identities=${new Set(deletes(h).map((c) => c.requestId)).size}`);
  assert.equal(tombstones(h, "notes/alpha"), 1);
  assert.ok(!h.host.docs.has("notes/alpha"));
});

test("DC1d a scoped resolve of another document pulls a host edit of a document whose file is deleted: the edit is not deleted", async () => {
  const h = await harness();
  await writeDoc(h, "notes/beta", "Beta", "LOCAL beta\n");
  h.host.put("notes/beta", { type: "Note", title: "Beta" }, "HOST beta\n");
  await fails(h);
  await unlink(fileOf(h, "notes/alpha"));
  const theirs = h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "HOST alpha edit\n");
  const take = await attempt(h, ["--resolve", "take", "--doc", "notes/beta"]);
  const r = await attempt(h);
  const r2 = await attempt(h);
  console.log(`# DC1d take=${take.ok ? "ok" : take.error.code}; sync alpha=${JSON.stringify(rowFor(r.receipt, "notes/alpha"))}; next=${JSON.stringify(rowFor(r2.receipt, "notes/alpha"))}; file=${(await readFileOrNull(h, "notes/alpha"))?.includes("HOST alpha edit") ? "host version placed back" : String(await readFileOrNull(h, "notes/alpha"))}`);
  assert.equal(h.host.docs.get("notes/alpha")?.version, theirs, "the host edit was deleted");
});

test("MD1c a held mass delete is released only by --accept-deletes naming the exact held set, and restored by --restore-deletes", async () => {
  const h = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  const held = await fails(h);
  const hold = held.receipt?.deletions_held as { count: number; restore: string; confirmation_required: { token: string; agent_instruction: string; command_after_confirmation: string } };
  assert.equal(hold.count, 9);
  assert.match(hold.confirmation_required.token, /^9:[0-9a-f]{12}$/);
  assert.match(hold.confirmation_required.agent_instruction, /Do not run this yourself/);
  assert.match(hold.confirmation_required.command_after_confirmation, new RegExp(`--accept-deletes ${hold.confirmation_required.token}`));
  assert.ok(!("accept" in hold), "the accept is never offered as a ready next step");
  const wrong = await fails(h, ["--accept-deletes", `8:${hold.confirmation_required.token.split(":")[1]}`]);
  assert.match(String((wrong.receipt?.deletions_held as { accept_mismatch?: string }).accept_mismatch), /does not name the held set/);
  assert.equal(deletes(h).length, 0);
  const accepted = await ok(h, ["--accept-deletes", hold.confirmation_required.token]);
  assert.equal(accepted.deletions_accepted, 9);
  assert.equal(deletes(h).length, 9);
  // The acceptance starts a new window: one more delete is not held by the ones just accepted.
  await unlink(fileOf(h, "notes/beta"));
  await ok(h);
  assert.equal(deletes(h).length, 10);

  const r = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(r, id));
  await fails(r);
  const restored = await ok(r, ["--restore-deletes"]);
  assert.equal(restored.restored, 9);
  for (const id of bulkIds(9)) assert.notEqual(await readFileOrNull(r, id), null, id);
  assert.equal((await ok(r)).status, "up_to_date");
  assert.equal(deletes(r).length, 0);
});

test("MD7 the hold's boundaries: 1 of 1 and 2 of 2 are held, 1 of 2 is not; 3 of 5 held, 2 of 5 not; 10 of 21 not, 11 of 21 held", async () => {
  const cases: [number, number, boolean][] = [[1, 1, true], [2, 2, true], [2, 1, false], [5, 3, true], [5, 2, false], [21, 10, false], [21, 11, true]];
  for (const [size, count, heldExpected] of cases) {
    const host = new FakeHost();
    for (const id of [...host.docs.keys()]) host.remove(id);
    for (let i = 0; i < size; i += 1) host.put(`bulk/n${String(i).padStart(2, "0")}`, { type: "Note", title: `N${i}` }, `b ${i}\n`);
    const h = await harness(host);
    for (const id of bulkIds(count)) await unlink(fileOf(h, id));
    const r = await attempt(h);
    const heldRows = rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").length;
    assert.equal(heldRows > 0, heldExpected, `${count} of ${size}`);
    assert.equal(deletes(h).length, heldExpected ? 0 : count, `${count} of ${size}`);
  }
});

test("MD8 new files never count in the baseline: deleting 10 of 13 while writing 14 new files is held", async () => {
  const h = await harness(bulkHost(10));
  for (const id of bulkIds(10)) await unlink(fileOf(h, id));
  for (let i = 0; i < 14; i += 1) await writeDoc(h, `fresh/f${i}`, `F${i}`, "new\n");
  const r = await fails(h);
  assert.equal(rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").length, 10);
  assert.equal(deletes(h).length, 0);
});

test("MD1b after a bulk hold, is there a command that restores the held files?", async () => {
  const h = await harness(bulkHost(20));
  for (const id of bulkIds(20)) await unlink(fileOf(h, id));
  await fails(h);
  const take = await attempt(h, ["--resolve", "take", "--doc", "bulk/n00"]);
  const inspect = await attempt(h, ["--inspect", "bulk/n00"]);
  assert.notEqual(await readFileOrNull(h, "bulk/n00"), null, "take restores a held delete");
  console.log(`# MD1b take=${take.ok ? "ok" : `${take.error.code} ${take.error.message.slice(0, 100)}`}; inspect=${inspect.ok ? "ok" : `${inspect.error.code}`}; file=${(await readFileOrNull(h, "bulk/n00")) === null ? "absent" : "restored"}`);
});

test("CS1 a case-only rename (alpha.md -> Alpha.md) on this filesystem", async () => {
  const h = await harness();
  const bytes = (await readFileOrNull(h, "notes/alpha"))!;
  await unlink(fileOf(h, "notes/alpha"));
  await writeFile(path.join(h.folder, "notes/Alpha.md"), bytes);
  const r = await attempt(h);
  console.log(`# CS1 rows=${JSON.stringify(rowsOf(r.receipt).map((row) => [row.id, row.state, row.reason]))}; host has alpha=${h.host.docs.has("notes/alpha")} Alpha=${h.host.docs.has("notes/Alpha")}; writes=${JSON.stringify(writeRoutes(h).map((c) => [c.route, c.body.documentId]))}`);
});
