// Adversarial QA round 2 for PR 297 (head 18466ef1): bypasses of the cumulative mass-delete hold, --accept-deletes and --restore-deletes. Harness from round 1: delete sync, the tombstone-based re-create,
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


const HOUR = 3600 * 1000;
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const held = (r: Outcome) => rowsOf(r.receipt).filter((row) => row.reason === "bulk_deletion").map((row) => row.id);
const hold = (r: Outcome) => r.receipt?.deletions_held as { count: number; accept_mismatch?: string; confirmation_required: { token: string; agent_instruction: string; command_after_confirmation: string } } | undefined;
/** The token the hold printed: what an agent runs only after the person confirms. */
const tokenOf = (r: Outcome) => hold(r)!.confirmation_required.token;
const all23 = () => ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(20)];

test("W1 7-at-a-time within a day: the second batch is held", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const ids = all23();
  for (const id of ids.slice(0, 7)) await unlink(fileOf(h, id));
  await ok(h);
  for (const id of ids.slice(7, 14)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  assert.equal(held(r).length, 7);
  assert.equal(h.host.docs.size, 16);
});

test("W2 7-at-a-time, spaced 25 hours apart with a fake clock: how fast can the checkout be emptied?", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const ids = all23();
  const log: string[] = [];
  let next = 0;
  for (let day = 0; day < 10 && next < ids.length; day += 1) {
    skew = day * 25 * HOUR;
    // Delete as many as possible today, one at a time, until one is held.
    for (;;) {
      if (next >= ids.length) break;
      const bytes = (await readFileOrNull(h, ids[next]!))!;
      await unlink(fileOf(h, ids[next]!));
      const r = await attempt(h);
      if (held(r).length > 0) {
        await writeFile(fileOf(h, ids[next]!), bytes);
        await attempt(h);
        break;
      }
      next += 1;
    }
    log.push(`day ${day}: ${23 - h.host.docs.size} deleted`);
  }
  skew = 0;
  console.log(`# W2 one delete per sync, waiting out the window: ${log.join("; ")}`);
});

test("W3 the window is 24h of acknowledgement time: 23 hours later the first batch still counts", async () => {
  const h = await harness(bulkHost(20));
  const ids = all23();
  skew = 0;
  for (const id of ids.slice(0, 7)) await unlink(fileOf(h, id));
  await ok(h);
  skew = 23 * HOUR;
  for (const id of ids.slice(7, 14)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  skew = 0;
  assert.equal(held(r).length, 7);
});

test("W4 a clock set back (or a future-dated window row) keeps counting, never expires early", async () => {
  const h = await harness(bulkHost(20));
  const ids = all23();
  skew = 48 * HOUR;
  for (const id of ids.slice(0, 7)) await unlink(fileOf(h, id));
  await ok(h);
  skew = 0;
  for (const id of ids.slice(7, 14)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  console.log(`# W4 recorded 48h in the future, then clock back: second batch held=${held(r).length}`);
});

test("L1 laundering by dilution: add as many new files, sync, then delete every original in one scan", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  for (let i = 0; i < 23; i += 1) await writeDoc(h, `junk/j${i}`, `J${i}`, "junk\n");
  await ok(h);
  for (const id of all23()) await unlink(fileOf(h, id));
  const r = await attempt(h);
  console.log(`# L1 after committing 23 new files, deleting all 23 originals: held=${held(r).length} deletes sent=${deletes(h).length} originals left on host=${all23().filter((id) => h.host.docs.has(id)).length}`);
  assert.equal(held(r).length, 23, "files created within the window never join the baseline");
});

test("L2 laundering by delete-then-recreate of the same ids: does re-creating reset the count?", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const ids = bulkIds(20);
  const saved = new Map<string, string>();
  for (const id of ids.slice(0, 7)) { saved.set(id, (await readFileOrNull(h, id))!); await unlink(fileOf(h, id)); }
  await ok(h);
  for (const [id, bytes] of saved) await writeFile(fileOf(h, id), bytes);
  await ok(h);
  let deleted = 7;
  const rounds: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const batch = ids.slice(7 + round * 5, 12 + round * 5);
    for (const id of batch) await unlink(fileOf(h, id));
    const r = await attempt(h);
    rounds.push(held(r).length);
    if (held(r).length === 0) deleted += batch.length;
  }
  console.log(`# L2 recreate 7 then delete 5 per sync: held per round=${JSON.stringify(rounds)}; host holds ${h.host.docs.size}`);
});

test("R1 renames: moving 12 of 15 is held (old ids count, new files do not); does the next plain sync release it by itself?", async () => {
  skew = 0;
  const h = await harness(bulkHost(12));
  await mkdir(path.join(h.folder, "moved"), { recursive: true });
  for (const id of bulkIds(12)) {
    const bytes = (await readFileOrNull(h, id))!;
    await unlink(fileOf(h, id));
    await writeFile(path.join(h.folder, `moved/${path.basename(id)}.md`), bytes);
  }
  const r = await attempt(h);
  assert.equal(held(r).length, 12);
  const creates = h.host.writes.filter((c) => c.route === "create").length;
  // No --accept-deletes: a plain sync after the held run.
  const aa = await attempt(h);
  console.log(`# R1 plain sync after the held move: ok=${aa.ok} held=${held(aa).length} deletes sent=${deletes(h).length}`);
  assert.equal(held(aa).length, 12, "N1: the held set stays held on a plain sync");
  assert.equal(deletes(h).length, 0);
  console.log(`# R1 creates sent while the deletes were held: ${creates} (the move is half-applied until accepted)`);
});

test("R2 mixing: 4 renames + 4 deletes of 15 are 8 deletions: held", async () => {
  skew = 0;
  const h = await harness(bulkHost(12));
  await mkdir(path.join(h.folder, "moved"), { recursive: true });
  for (const id of bulkIds(4)) {
    const bytes = (await readFileOrNull(h, id))!;
    await unlink(fileOf(h, id));
    await writeFile(path.join(h.folder, `moved/${path.basename(id)}.md`), bytes);
  }
  for (const id of bulkIds(8).slice(4)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  assert.equal(held(r).length, 8);
  assert.equal(deletes(h).length, 0);
});

test("A1 accept with a wrong count (lower, higher, zero, junk) accepts nothing", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  const first = await fails(h);
  const digest = tokenOf(first).split(":")[1]!;
  for (const n of [`8:${digest}`, `10:${digest}`, "9:000000000000", `23:${digest}`]) {
    const r = await attempt(h, ["--accept-deletes", n]);
    assert.ok(hold(r)?.accept_mismatch, `n=${n}`);
  }
  for (const n of ["0", "-1", "9x", "09", " 9", "9", `09:${digest}`, `9:${digest}0`]) {
    const r = await attempt(h, ["--accept-deletes", n]);
    assert.equal(r.ok, false, `n=${n}`);
  }
  assert.equal(deletes(h).length, 0);
});

test("A2 accept binds the held set: hold 9, restore one by hand, delete another, the old token accepts nothing", async () => {
  skew = 0;
  const h = await harness(bulkHost(12));
  const ids = bulkIds(12);
  const bytes = (await readFileOrNull(h, ids[0]!))!;
  for (const id of ids.slice(0, 9)) await unlink(fileOf(h, id));
  const first = await attempt(h);
  const shown = held(first);
  await writeFile(fileOf(h, ids[0]!), bytes);
  await unlink(fileOf(h, ids[9]!));
  const a = await attempt(h, ["--accept-deletes", tokenOf(first)]);
  const sent = deletes(h).map((c) => String(c.body.documentId));
  const unseen = sent.filter((id) => !shown.includes(id));
  console.log(`# A2 accept 9 after the set changed: ok=${a.ok} sent=${sent.length} never shown as held=${JSON.stringify(unseen)}`);
  assert.ok(hold(a)?.accept_mismatch, "R1/N3: a different set of the same count is refused");
  assert.deepEqual(sent, []);
});

test("A3 accept on a sync with no hold does nothing, and is not remembered for a later hold", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  await ok(h, ["--accept-deletes", "9:000000000000"]);
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  assert.equal(held(r).length, 9);
});

test("A4 after accepting, the window restarts: a further mass delete is held again", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const ids = all23();
  for (const id of ids.slice(0, 12)) await unlink(fileOf(h, id));
  const heldRun = await fails(h);
  await ok(h, ["--accept-deletes", tokenOf(heldRun)]);
  for (const id of ids.slice(12, 18)) await unlink(fileOf(h, id));
  const r = await attempt(h);
  assert.equal(held(r).length, 6, "6 of 11 remaining is more than half");
});

test("P1 restore after a partial push: quota stops after the first delete; --restore-deletes puts back only what never left", async () => {
  skew = 0;
  const h = await harness(bulkHost(4));
  let admitted = 0;
  h.host.hook = (call) => (call.route === "delete" && admitted++ >= 1 ? { kind: "respond", status: 429, body: { error: { code: "request_capacity", scope: "bundle", message: "q", retryable: false, writeState: "not_applied" } } } : undefined);
  for (const id of ["notes/alpha", "notes/beta", "projects/2026/plan"]) await unlink(fileOf(h, id));
  await fails(h);
  h.host.hook = undefined;
  const gone = ["notes/alpha", "notes/beta", "projects/2026/plan"].filter((id) => !h.host.docs.has(id));
  const r = await ok(h, ["--restore-deletes"]);
  const files = await Promise.all(["notes/alpha", "notes/beta", "projects/2026/plan"].map(async (id) => [id, (await readFileOrNull(h, id)) !== null] as const));
  const after = await attempt(h);
  console.log(`# P1 deleted on host=${JSON.stringify(gone)} restored=${r.restored} files=${JSON.stringify(files)}; next sync=${after.ok ? after.receipt.status : after.error.code} rows=${JSON.stringify(rowsOf(after.receipt).map((x) => [x.id, x.state, x.reason]))}`);
  for (const [id, present] of files) assert.equal(present, !gone.includes(id), `${id}: a restored file must be exactly one still on the host`);
  assert.equal(after.ok && after.receipt.status, "up_to_date");
  assert.equal(deletes(h).length, 2, "restored deletes are never sent later");
});

test("P2 restore after a lost answer (in flight): the maybe-sent delete is not restored; sync settles it", async () => {
  skew = 0;
  const h = await harness();
  h.host.hook = (call) => (call.route === "delete" ? { kind: "apply-then-drop" } : call.route === "outcome" ? { kind: "drop" } : undefined);
  await unlink(fileOf(h, "notes/alpha"));
  await fails(h);
  h.host.hook = undefined;
  const r = await ok(h, ["--restore-deletes"]);
  assert.equal(r.restored, 0);
  const s = await ok(h);
  assert.equal(rowFor(s, "notes/alpha")?.reason, "deleted");
  assert.equal(await readFileOrNull(h, "notes/alpha"), null);
});

test("P3 restore never overwrites a file written meanwhile", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  await fails(h);
  await writeDoc(h, "bulk/n00", "Mine", "new content\n");
  await ok(h, ["--restore-deletes"]);
  assert.match((await readFileOrNull(h, "bulk/n00"))!, /new content/);
});

test("C1 a hold and a second sync process: accept blocked in flight, a concurrent restore and sync are sync_busy; state is consistent", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  const heldRun = await fails(h);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  h.before = async (route) => {
    if (route === "delete" && first) { first = false; entered(); await gate; }
  };
  const accepting = attempt(h, ["--accept-deletes", tokenOf(heldRun)], 5_000);
  await inFlight;
  const other: H = { ...h, out: [], before: undefined };
  const restore = await attempt(other, ["--restore-deletes"], 200);
  const plain = await attempt(other, [], 200);
  release();
  const a = await accepting;
  assert.equal(!restore.ok && restore.error.details?.reason, "sync_busy");
  assert.equal(!plain.ok && plain.error.details?.reason, "sync_busy");
  assert.ok(a.ok, !a.ok ? `${a.error.code} ${a.error.message}` : "");
  assert.equal(bulkIds(9).filter((id) => h.host.docs.has(id)).length, 0);
  const after = await ok(h);
  assert.equal(after.status, "up_to_date");
});

test("C2 two processes race hold-then-accept against restore (the restore wins the lock first): accept finds nothing held", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  for (const id of bulkIds(9)) await unlink(fileOf(h, id));
  const heldRun = await fails(h);
  await ok(h, ["--restore-deletes"]);
  const a = await attempt(h, ["--accept-deletes", tokenOf(heldRun)]);
  assert.equal(deletes(h).length, 0);
  assert.ok(a.ok);
});

test("R3 rm -rf plus the same number of regenerated files: held once, then released by a plain second sync", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  for (const id of all23()) await unlink(fileOf(h, id));
  for (let i = 0; i < 23; i += 1) await writeDoc(h, `regen/r${i}`, `R${i}`, "regenerated\n");
  const first = await attempt(h);
  const second = await attempt(h);
  console.log(`# R3 first run held=${held(first).length}; second plain run held=${held(second).length}; originals left on host=${all23().filter((id) => h.host.docs.has(id)).length}`);
  assert.equal(held(second).length, 23, "N1: regenerated files never release the held originals");
  assert.equal(all23().filter((id) => h.host.docs.has(id)).length, 23);
});
