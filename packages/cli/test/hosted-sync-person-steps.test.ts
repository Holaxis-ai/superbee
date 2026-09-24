// The steps of a hosted sync that stay with the person, and the rough edges the staging dogfood
// found around them:
// - accepting a held mass delete needs the person's typed confirmation in a terminal; an agent's
//   shell is refused, while --restore-deletes and --resolve take stay open to agents;
// - the hold counts in journal order, and the checkout's own older additions never dilute it;
// - host deletions the pull refused can be taken back explicitly (--take-host-deletions);
// - a host document whose id cannot be a file is held with a row, and the rest syncs;
// - a resolution says plainly that it is not sent yet, and resolving again is not NOT_FOUND.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { withoutUnsafeIds } from "../src/hosted/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";
import { noTerminal, personAtTerminal, type FakeTerminal } from "./support/fake-terminal.js";

// The hold compares acknowledgement times with the clock; `new Date()` stamps the journal, so the
// constructor is faked as well as `Date.now`.
const HOUR = 3600 * 1000;
let skew = 0;
const realNow = Date.now;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(realNow() + skew);
    else super(...(args as [number]));
  }
  static override now(): number {
    return realNow() + skew;
  }
}
(globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;

interface H {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  terminal: FakeTerminal;
  idRule?: (id: string) => void;
}

async function harness(host = new FakeHost()): Promise<H> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-person-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-person-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("no sign-in");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  host.writes.length = 0;
  return { home, cwd, folder: path.join(cwd, "team"), auth, host, terminal: noTerminal() };
}

type Outcome = { ok: true; receipt: Record<string, unknown> } | { ok: false; error: CliError; receipt: Record<string, unknown> | null };

async function attempt(h: H, argv: string[] = []): Promise<Outcome> {
  const out: string[] = [];
  const instant = async () => {};
  try {
    await sync(["--dir", h.folder, ...argv], { stdout: (t: string) => void out.push(t), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant, lockWaitMs: 200, terminal: h.terminal, ...(h.idRule ? { idRule: h.idRule } : {}) });
    return { ok: true, receipt: decode(out.at(-1)!.trim()) as Record<string, unknown> };
  } catch (error) {
    assert.ok(error instanceof CliError, String((error as Error).stack));
    return { ok: false, error, receipt: out.length > 0 ? (decode(out.at(-1)!.trim()) as Record<string, unknown>) : null };
  }
}
async function ok(h: H, argv: string[] = []): Promise<Record<string, unknown>> {
  const r = await attempt(h, argv);
  if (!r.ok) assert.fail(`expected success, got ${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)} ${JSON.stringify(r.receipt)}`);
  return r.receipt;
}
async function fails(h: H, argv: string[] = []): Promise<Extract<Outcome, { ok: false }>> {
  const r = await attempt(h, argv);
  if (r.ok) assert.fail(`expected failure, got ${JSON.stringify(r.receipt)}`);
  return r;
}

type Row = { id: string; state: string; reason: string; message: string };
const rowsOf = (r: Record<string, unknown> | null): Row[] => (r?.rows as Row[]) ?? [];
const rowFor = (r: Record<string, unknown> | null, id: string) => rowsOf(r).find((row) => row.id === id);
const heldDeletes = (r: Record<string, unknown> | null) => rowsOf(r).filter((row) => row.reason === "bulk_deletion").map((row) => row.id);
const fileOf = (h: H, id: string) => path.join(h.folder, `${id}.md`);
const exists = (h: H, id: string) => readFile(fileOf(h, id)).then(() => true, () => false);
const deletes = (h: H) => h.host.writes.filter((call) => call.route === "delete");
const writeDoc = async (h: H, id: string, body: string) => {
  await mkdir(path.dirname(fileOf(h, id)), { recursive: true });
  await writeFile(fileOf(h, id), `---\ntype: "Note"\ntitle: ${JSON.stringify(id)}\n---\n${body}`);
};

/** A host with `n` documents under bulk/, plus the fixture's three. */
function bulkHost(n: number): FakeHost {
  const host = new FakeHost();
  for (let i = 0; i < n; i += 1) host.put(`bulk/n${String(i).padStart(2, "0")}`, { type: "Note", title: `N${i}` }, `bulk ${i}\n`);
  return host;
}
const bulkIds = (n: number) => Array.from({ length: n }, (_, i) => `bulk/n${String(i).padStart(2, "0")}`);
const all23 = () => ["notes/alpha", "notes/beta", "projects/2026/plan", ...bulkIds(20)];

interface Hold {
  count: number;
  accept_mismatch?: string;
  accept_declined?: string;
  counted_over?: string;
  confirmation_required: { token: string; agent_instruction: string; command_for_person: string };
}
const holdOf = (r: Record<string, unknown> | null) => r?.deletions_held as Hold | undefined;

async function heldMassDelete(h: H, ids: string[]): Promise<Hold> {
  for (const id of ids) await unlink(fileOf(h, id));
  const first = await fails(h);
  assert.equal(heldDeletes(first.receipt).length, ids.length);
  return holdOf(first.receipt)!;
}

// ── typed confirmation ──────────────────────────────────────────────────────────────────────

test("an agent's shell cannot accept a held mass delete: refused before anything is read or sent, with the command for the person", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  const hold = await heldMassDelete(h, bulkIds(9));
  assert.match(hold.confirmation_required.agent_instruction, /own terminal/);
  assert.match(hold.confirmation_required.command_for_person, new RegExp(`--accept-deletes ${hold.confirmation_required.token}`));
  h.host.requests.length = 0;

  const refused = await fails(h, ["--accept-deletes", hold.confirmation_required.token]);
  assert.equal(refused.error.code, "FORBIDDEN");
  assert.equal(refused.error.exitCode, 2);
  const details = refused.error.details as { reason: string; token: string; command_for_person: string; agent_instruction: string };
  assert.equal(details.reason, "needs_person_at_terminal");
  assert.equal(details.token, hold.confirmation_required.token);
  assert.match(details.command_for_person, /--accept-deletes/);
  assert.match(details.agent_instruction, /ask them to run the command in their own terminal/);
  assert.match(refused.error.help ?? "", /own terminal/);
  assert.equal(refused.receipt, null, "nothing ran, so no receipt");
  assert.equal(h.host.requests.length, 0, "refused before any request");
  assert.equal(h.terminal.prompts.length, 0);

  // The hold stands: a plain sync still holds all nine, and the host still has them.
  const again = await fails(h);
  assert.equal(heldDeletes(again.receipt).length, 9);
  assert.equal(deletes(h).length, 0);
  assert.equal(bulkIds(9).filter((id) => h.host.docs.has(id)).length, 9);
});

test("the person accepts by typing the held count at the prompt, which names the documents", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  const hold = await heldMassDelete(h, bulkIds(9));
  h.terminal = personAtTerminal();
  const accepted = await ok(h, ["--accept-deletes", hold.confirmation_required.token]);
  assert.equal(accepted.deletions_accepted, 9);
  assert.equal(h.terminal.prompts.length, 1);
  const [prompt] = h.terminal.prompts;
  for (const id of bulkIds(9)) assert.match(prompt!, new RegExp(id));
  assert.match(prompt!, /Type 9 to remove them/);
  assert.match(prompt!, new RegExp(`hosted bundle '${BUNDLE.replace(".", "\\.")}'`));
  assert.equal(deletes(h).length, 9);
  assert.equal(bulkIds(9).filter((id) => h.host.docs.has(id)).length, 0);
});

test("a typed answer other than the count accepts nothing; a token for another set is not even asked", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  const hold = await heldMassDelete(h, bulkIds(9));
  for (const typed of ["", "y", "yes", "8", "10", " 9 9"]) {
    h.terminal = personAtTerminal(() => typed);
    const declined = await fails(h, ["--accept-deletes", hold.confirmation_required.token]);
    assert.equal(declined.error.code, "CONFLICT");
    assert.match(holdOf(declined.receipt)!.accept_declined ?? "", /not 9; nothing was accepted/);
    assert.equal(heldDeletes(declined.receipt).length, 9, typed);
  }
  h.terminal = personAtTerminal();
  const mismatch = await fails(h, ["--accept-deletes", `9:${"0".repeat(12)}`]);
  assert.match(holdOf(mismatch.receipt)!.accept_mismatch ?? "", /does not name the held set/);
  assert.equal(h.terminal.prompts.length, 0, "a token for another set asks nothing");
  assert.equal(deletes(h).length, 0);
});

test("--restore-deletes and --resolve take need no terminal: agents keep them", async () => {
  skew = 0;
  const h = await harness(bulkHost(9));
  await heldMassDelete(h, bulkIds(9));
  assert.equal(h.terminal.interactive, false);
  const one = await ok(h, ["--resolve", "take", "--doc", "bulk/n00"]);
  assert.equal(one.file_state, "restored");
  assert.equal(await exists(h, "bulk/n00"), true);
  const restored = await ok(h, ["--restore-deletes"]);
  assert.equal(restored.restored, 8);
  for (const id of bulkIds(9)) assert.equal(await exists(h, id), true, id);
  const after = await ok(h);
  assert.equal(after.status, "up_to_date");
  assert.equal(deletes(h).length, 0);
});

// ── the hold's count ────────────────────────────────────────────────────────────────────────

test("the checkout's own additions never dilute the hold, even a day later (QA O1)", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  for (let i = 0; i < 23; i += 1) await writeDoc(h, `junk/j${String(i).padStart(2, "0")}`, "junk\n");
  await ok(h);
  skew = 25 * HOUR;
  for (const id of all23()) await unlink(fileOf(h, id));
  const r = await fails(h);
  skew = 0;
  assert.equal(heldDeletes(r.receipt).length, 23);
  assert.equal(holdOf(r.receipt)!.counted_over, "the documents this checkout did not create itself");
  assert.match(rowFor(r.receipt, "notes/alpha")!.message, /23 of the 23 documents this checkout did not create itself/);
  assert.equal(deletes(h).length, 0);
});

test("deleting some of the checkout's own older additions is not held", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const junk = Array.from({ length: 23 }, (_, i) => `junk/j${String(i).padStart(2, "0")}`);
  for (const id of junk) await writeDoc(h, id, "junk\n");
  await ok(h);
  skew = 25 * HOUR;
  for (const id of junk.slice(0, 12)) await unlink(fileOf(h, id));
  const r = await ok(h);
  skew = 0;
  assert.equal(heldDeletes(r).length, 0);
  assert.equal(deletes(h).length, 12);
});

test("an acceptance is ordered by the journal, not the clock: accepted while the clock ran fast, later deletes still count (QA O2)", async () => {
  skew = 0;
  const h = await harness(bulkHost(20));
  const ids = all23();
  const hold = await heldMassDelete(h, ids.slice(0, 12));
  skew = 48 * HOUR;
  h.terminal = personAtTerminal();
  await ok(h, ["--accept-deletes", hold.confirmation_required.token]);
  skew = 0;
  h.terminal = noTerminal();
  // 11 documents are left. Three deletes pass; three more make 6 of the 11, which is held.
  for (const id of ids.slice(12, 15)) await unlink(fileOf(h, id));
  const first = await ok(h);
  assert.equal(heldDeletes(first).length, 0);
  for (const id of ids.slice(15, 18)) await unlink(fileOf(h, id));
  const second = await fails(h);
  assert.equal(heldDeletes(second.receipt).length, 3);
  assert.equal(ids.filter((id) => h.host.docs.has(id)).length, 8);
});

// ── host deletions the pull refused (review S2) ─────────────────────────────────────────────

test("host deletions the pull refused are taken back with --take-host-deletions, and only with the matching token", async () => {
  skew = 0;
  const h = await harness(bulkHost(12));
  for (const id of bulkIds(12)) h.host.remove(id);
  const refusedRun = await ok(h);
  const pulled = refusedRun.pulled as { removed: number; refused_deletions?: { count: number; token: string; take: string; message: string } };
  assert.equal(pulled.removed, 0);
  const refused = pulled.refused_deletions!;
  assert.equal(refused.count, 12);
  assert.match(refused.token, /^12:[0-9a-f]{12}$/);
  assert.match(refused.take, new RegExp(`--take-host-deletions ${refused.token}`));
  assert.match(refused.message, /really shrank/);
  assert.ok((refusedRun.help as string[]).some((line) => line.includes("--take-host-deletions")));
  for (const id of bulkIds(12)) assert.equal(await exists(h, id), true);

  // A token for another refusal removes nothing, and says why.
  const wrong = await ok(h, ["--take-host-deletions", `12:${"0".repeat(12)}`]);
  assert.equal((wrong.take_host_deletions as { taken: boolean }).taken, false);
  assert.match((wrong.take_host_deletions as { message: string }).message, new RegExp(refused.token));
  for (const id of bulkIds(12)) assert.equal(await exists(h, id), true);

  // The matching token takes the host's version: the files go, and nothing is sent. No terminal needed.
  h.host.writes.length = 0;
  const taken = await ok(h, ["--take-host-deletions", refused.token]);
  assert.equal((taken.take_host_deletions as { taken: boolean }).taken, true);
  assert.equal((taken.pulled as { removed: number }).removed, 12);
  assert.equal((taken.pulled as { refused_deletions?: unknown }).refused_deletions, undefined);
  for (const id of bulkIds(12)) assert.equal(await exists(h, id), false);
  assert.equal(h.host.writes.length, 0);
  assert.equal((await ok(h)).status, "up_to_date");
});

test("a listing that moved since the refusal is refused afresh; the old token takes nothing", async () => {
  skew = 0;
  const h = await harness(bulkHost(12));
  for (const id of bulkIds(10)) h.host.remove(id);
  const first = await ok(h);
  const token = (first.pulled as { refused_deletions: { token: string } }).refused_deletions.token;
  h.host.remove("bulk/n10");
  const moved = await ok(h, ["--take-host-deletions", token]);
  assert.equal((moved.take_host_deletions as { taken: boolean }).taken, false);
  const again = (moved.pulled as { refused_deletions: { count: number; token: string } }).refused_deletions;
  assert.equal(again.count, 11);
  assert.notEqual(again.token, token);
  for (const id of bulkIds(11)) assert.equal(await exists(h, id), true);
});

// ── host ids the folder cannot hold (review F10) ────────────────────────────────────────────

test("a host document whose id cannot be a file is held with a row, and the rest of the bundle syncs", async () => {
  skew = 0;
  const h = await harness();
  h.host.put("a/../b", { type: "Note", title: "Traversal" }, "x\n");
  h.host.put("x.md/y", { type: "Note", title: "Under a file" }, "y\n");
  h.host.put("notes/gamma", { type: "Note", title: "Gamma" }, "Gamma\n");
  await writeDoc(h, "notes/delta", "Delta\n");
  const r = await fails(h);
  assert.equal(r.error.code, "CONFLICT");
  for (const id of ["a/../b", "x.md/y"]) {
    const row = rowFor(r.receipt, id)!;
    assert.equal(row.state, "held", id);
    assert.equal(row.reason, "unsafe_id", id);
    assert.match(row.message, /cannot be a file in this folder/);
    assert.match(row.message, /Rename it in the Superbee app/);
  }
  assert.equal(await exists(h, "notes/gamma"), true, "a new host document is still pulled");
  assert.equal(rowFor(r.receipt, "notes/delta")!.state, "committed", "a local create is still sent");
  assert.equal(await readFile(path.join(h.folder, "b.md")).then(() => true, () => false), false);

  // Reported again on every sync until it is renamed on the host, then gone.
  const again = await fails(h);
  assert.deepEqual(rowsOf(again.receipt).map((row) => row.reason), ["unsafe_id", "unsafe_id"]);
  h.host.remove("a/../b");
  h.host.remove("x.md/y");
  assert.equal((await ok(h)).status, "up_to_date");
});

test("a host document whose id differs only in case from a folder document is held, and other changes still sync", async () => {
  skew = 0;
  const h = await harness();
  h.host.put("notes/Alpha", { type: "Note", title: "Twin" }, "twin\n");
  await writeDoc(h, "notes/delta", "Delta\n");
  const r = await fails(h);
  const row = rowFor(r.receipt, "notes/Alpha")!;
  assert.equal(row.state, "held");
  assert.equal(row.reason, "case_collision");
  assert.equal(rowFor(r.receipt, "notes/delta")!.state, "committed");
});

// ── resolutions (dogfood nits 1 and 2) ──────────────────────────────────────────────────────

async function conflicted(h: H): Promise<void> {
  const file = fileOf(h, "notes/alpha");
  await writeFile(file, (await readFile(file, "utf8")).replace(/\n$/, "\nlocal line\n"));
  const doc = h.host.docs.get("notes/alpha")!;
  h.host.put("notes/alpha", doc.frontmatter, `${doc.body}host line\n`);
  const r = await fails(h);
  assert.equal(rowFor(r.receipt, "notes/alpha")!.state, "conflict");
}

for (const choice of ["keep", "revise"] as const) {
  test(`--resolve ${choice} says it is not sent yet and names the sync; resolving again says it is waiting to send`, async () => {
    skew = 0;
    const h = await harness();
    await conflicted(h);
    await ok(h, ["--inspect", "--doc", "notes/alpha"]);
    h.host.writes.length = 0;
    const resolved = await ok(h, ["--resolve", choice, "--doc", "notes/alpha"]);
    assert.equal(resolved.resolved, "notes/alpha");
    assert.equal(resolved.choice, choice);
    assert.equal(resolved.sent, false);
    assert.match(resolved.next as string, /^resolved, not sent yet: run .* sync --dir .* to send it/);
    assert.equal((resolved.help as string[]).length, 1);
    assert.match((resolved.help as string[])[0]!, / sync --dir /);
    assert.equal(h.host.writes.length, 0, "--resolve itself sends nothing");

    const again = await ok(h, ["--resolve", choice, "--doc", "notes/alpha"]);
    assert.equal(again.already_resolved, true);
    assert.equal(again.requested, choice);
    assert.match(again.next as string, /^already resolved; waiting to send/);
    assert.equal((again.help as string[]).length, 1);

    const inspect = await fails(h, ["--inspect", "--doc", "notes/alpha"]);
    assert.equal(inspect.error.code, "NOT_FOUND");
    assert.equal((inspect.error.details as { reason: string }).reason, "waiting_to_send");
    assert.match(inspect.error.message, /its change is waiting to send/);

    const sent = await ok(h);
    assert.equal(rowFor(sent, "notes/alpha")!.state, "committed");
    assert.match(h.host.docs.get("notes/alpha")!.body, /local line/);
  });
}

test("--resolve take says there is nothing to send, in the same shape", async () => {
  skew = 0;
  const h = await harness();
  await conflicted(h);
  const file = fileOf(h, "notes/alpha");
  const resolved = await ok(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(resolved.choice, "take");
  assert.equal(resolved.sent, false);
  assert.equal(resolved.next, "resolved: nothing to send for this document");
  assert.deepEqual(resolved.help, []);
  assert.match(await readFile(file, "utf8"), /host line/);
  const again = await fails(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(again.error.code, "NOT_FOUND");
  assert.match(again.error.message, /has no conflict to resolve/);
});

// ── a later resolution replaces the earlier one, or is refused (review F1) ─────────────────

for (const first of ["keep", "revise"] as const) {
  test(`${first} then take: take replaces the unsent ${first}, and the next sync sends nothing`, async () => {
    skew = 0;
    const h = await harness();
    await conflicted(h);
    await ok(h, ["--inspect", "--doc", "notes/alpha"]);
    await ok(h, ["--resolve", first, "--doc", "notes/alpha"]);
    const again = await ok(h, ["--resolve", first, "--doc", "notes/alpha"]);
    assert.equal(again.already_resolved, true);
    h.host.writes.length = 0;
    const taken = await ok(h, ["--resolve", "take", "--doc", "notes/alpha"]);
    assert.equal(taken.choice, "take");
    assert.equal(taken.replaces, first);
    assert.equal(taken.file_state, "replaced");
    assert.equal(taken.next, "resolved: nothing to send for this document");
    const file = await readFile(fileOf(h, "notes/alpha"), "utf8");
    assert.match(file, /host line/);
    assert.doesNotMatch(file, /local line/);
    const after = await ok(h);
    assert.equal(after.status, "up_to_date");
    assert.equal(h.host.writes.filter((call) => call.route !== "outcome").length, 0, "the discarded keep is never sent");
    assert.doesNotMatch(h.host.docs.get("notes/alpha")!.body, /local line/);
  });
}

test("take then keep: keep is refused (there is no conflict left), and the host's version stands", async () => {
  skew = 0;
  const h = await harness();
  await conflicted(h);
  await ok(h, ["--inspect", "--doc", "notes/alpha"]);
  await ok(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  const keep = await fails(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(keep.error.code, "NOT_FOUND");
  assert.match(keep.error.message, /has no conflict to resolve/);
  h.host.writes.length = 0;
  assert.equal((await ok(h)).status, "up_to_date");
  assert.equal(h.host.writes.length, 0);
  assert.match(h.host.docs.get("notes/alpha")!.body, /host line/);
});

test("take over a keep that may already have been sent is refused with the way forward, never ignored", async () => {
  skew = 0;
  const h = await harness();
  await conflicted(h);
  await ok(h, ["--inspect", "--doc", "notes/alpha"]);
  await ok(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  h.host.hook = (call) => (call.route === "outcome" ? undefined : { kind: "drop" });
  await fails(h);
  h.host.hook = () => ({ kind: "drop" });
  const take = await fails(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(take.error.code, "CONFLICT");
  assert.equal((take.error.details as { reason: string }).reason, "resolution_not_replaceable");
  assert.match(take.error.message, /may already have been sent/);
});

test("a second resolve on a plain unsent edit (never a conflict) is refused as unsent_change", async () => {
  skew = 0;
  const h = await harness();
  await writeDoc(h, "notes/delta", "Delta\n");
  h.host.hook = () => ({ kind: "drop" });
  await fails(h);
  const take = await fails(h, ["--resolve", "take", "--doc", "notes/delta"]);
  assert.equal(take.error.code, "CONFLICT");
  assert.equal((take.error.details as { reason: string }).reason, "unsent_change");
});

// ── unsafe ids: no 304 hide, no removal under a stricter rule (review F2, F3) ──────────────

test("a filtered listing never carries the host's digest, so a recorded digest cannot hide the row", async () => {
  const listing = { digest: "sha256:host", heads: [{ id: "notes/alpha", version: "v1" }, { id: "a/../b", version: "v2" }] };
  const reader = { heads: async () => listing } as unknown as Parameters<typeof withoutUnsafeIds>[0];
  const store = { readMeta: async () => undefined } as unknown as Parameters<typeof withoutUnsafeIds>[2];
  const unsafe = new Map<string, string>();
  const answer = (await withoutUnsafeIds(reader, unsafe, store).heads())!;
  assert.notEqual(answer.digest, listing.digest);
  assert.deepEqual(answer.heads.map((head) => head.id), ["notes/alpha"]);
  assert.deepEqual([...unsafe.keys()], ["a/../b"]);
  const clean = { digest: "sha256:host", heads: [{ id: "notes/alpha", version: "v1" }] };
  const plain = (await withoutUnsafeIds({ heads: async () => clean } as unknown as Parameters<typeof withoutUnsafeIds>[0], new Map(), store).heads())!;
  assert.equal(plain.digest, clean.digest);
});

test("a document the checkout holds that a stricter id rule refuses is held as it is, never removed", async () => {
  skew = 0;
  const h = await harness();
  const before = await readFile(fileOf(h, "notes/beta"), "utf8");
  const doc = h.host.docs.get("notes/beta")!;
  h.host.put("notes/beta", doc.frontmatter, `${doc.body}host change\n`);
  h.idRule = (id) => {
    if (id === "notes/beta") throw new Error("refused by a stricter rule");
  };
  const r = await fails(h);
  const row = rowFor(r.receipt, "notes/beta")!;
  assert.equal(row.state, "held");
  assert.equal(row.reason, "unsafe_id");
  assert.equal(await readFile(fileOf(h, "notes/beta"), "utf8"), before, "neither removed nor refreshed");
  assert.equal((r.receipt!.pulled as { removed: number }).removed, 0);
  assert.equal(deletes(h).length, 0);
});
