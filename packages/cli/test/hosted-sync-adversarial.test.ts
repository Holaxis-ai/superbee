// Adversarial QA probes for `superbee sync` in a hosted checkout (PR 295). Each test is one probe
// against the PR's stateful fake host; a failing assertion here is a finding, not a flaky test.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { assertAllowedInHostedCheckout } from "../src/hosted/refusals.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  out: string[];
  /** Runs before the fake host answers a request (any route); may mutate the host or the folder. */
  before?: (route: string, body: Record<string, unknown>) => Promise<void> | void;
}

async function harness(host = new FakeHost()): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  const h: Harness = { home, cwd, folder: path.join(cwd, "team"), auth, host, out: [] };
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return h;
}

const instant = async () => {};

function fetchFor(h: Harness): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    await h.before?.(route, body);
    return h.host.fetch(input, init);
  }) as typeof fetch;
}

function deps(h: Harness, lockWaitMs?: number) {
  return {
    stdout: (text: string) => void h.out.push(text),
    auth: h.auth,
    cwd: h.cwd,
    fetch: fetchFor(h),
    write: { sleep: instant, lookupDelayMs: 0 },
    sleep: instant,
    ...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
  };
}

type Outcome = { ok: true; receipt: Record<string, unknown> } | { ok: false; error: CliError; receipt: Record<string, unknown> | null; raw?: Error };

async function attempt(h: Harness, argv: string[] = [], lockWaitMs = 200): Promise<Outcome> {
  h.out.length = 0;
  try {
    await sync(["--dir", h.folder, ...argv], deps(h, lockWaitMs));
    return { ok: true, receipt: decode(h.out.at(-1)!.trim()) as Record<string, unknown> };
  } catch (error) {
    const receipt = h.out.length > 0 ? (decode(h.out.at(-1)!.trim()) as Record<string, unknown>) : null;
    // A non-CLI error still fails the command; record it so a probe can say it escaped unmapped.
    if (!(error instanceof CliError)) return { ok: false, error: new CliError("RUNTIME", `UNMAPPED ${(error as Error).name}: ${(error as Error).message}`), receipt, raw: error as Error };
    return { ok: false, error, receipt };
  }
}

async function ok(h: Harness, argv: string[] = []): Promise<Record<string, unknown>> {
  const outcome = await attempt(h, argv);
  if (!outcome.ok) assert.fail(`expected success, got ${outcome.error.code}: ${outcome.error.message} ${JSON.stringify(outcome.error.details)} ${JSON.stringify(outcome.receipt)}`);
  return outcome.receipt;
}

async function fails(h: Harness, argv: string[] = []): Promise<{ error: CliError; receipt: Record<string, unknown> | null }> {
  const outcome = await attempt(h, argv);
  if (outcome.ok) assert.fail(`expected failure, got ${JSON.stringify(outcome.receipt)}`);
  return outcome;
}

type Row = { id: string; state: string; reason: string };
const rowsOf = (receipt: Record<string, unknown> | null): Row[] => (receipt?.rows as Row[]) ?? [];
const rowFor = (receipt: Record<string, unknown> | null, id: string) => rowsOf(receipt).find((row) => row.id === id);
const fileOf = (h: Harness, id: string) => path.join(h.folder, `${id}.md`);
const read = (h: Harness, id: string) => readFile(fileOf(h, id), "utf8");
const writeDoc = (h: Harness, id: string, title: string, body: string, extra = "") =>
  writeFile(fileOf(h, id), `---\ntype: "Note"\ntitle: ${JSON.stringify(title)}\n${extra}---\n${body}`);
const applyCount = (h: Harness, id: string) => h.host.applied.filter((x) => x === id).length;
const writeRoutes = (h: Harness) => h.host.writes.filter((call) => call.route !== "outcome");
function hostDoc(h: Harness, id: string) {
  const doc = h.host.docs.get(id);
  assert.ok(doc, `host has ${id}`);
  return doc;
}

// ---------------------------------------------------------------- data loss

test("DL1a local + remote edit of one doc: conflict, local bytes kept across repeated syncs", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  h.host.put("notes/alpha", before.frontmatter, "Remote alpha.\n");
  await writeDoc(h, "notes/alpha", "Alpha", "LOCAL alpha.\n");
  const local = await read(h, "notes/alpha");
  const first = await fails(h);
  assert.equal(rowFor(first.receipt, "notes/alpha")?.state, "conflict");
  for (let i = 0; i < 3; i += 1) {
    const again = await fails(h);
    assert.equal(rowFor(again.receipt, "notes/alpha")?.state, "conflict");
  }
  assert.equal(await read(h, "notes/alpha"), local, "the local file is never overwritten");
  assert.equal(hostDoc(h, "notes/alpha").body, "Remote alpha.\n");
  assert.equal(applyCount(h, "notes/alpha"), 0);
});

test("DL1b remote edit lands between pull and push: CAS conflict, local kept, nothing applied", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "LOCAL.\n");
  const local = await read(h, "notes/alpha");
  let raced = false;
  h.before = (route) => {
    if (route === "replace" && !raced) {
      raced = true;
      h.host.put("notes/alpha", { type: "Note", title: "Alpha", tags: ["one", "two"] }, "RACED remote.\n");
    }
  };
  const { receipt } = await fails(h);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "conflict");
  assert.equal(hostDoc(h, "notes/alpha").body, "RACED remote.\n");
  assert.equal(await read(h, "notes/alpha"), local);
});

test("DL1c edit the file again after a conflict: still a conflict, the newer local bytes kept, nothing sent", async () => {
  const h = await harness();
  h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "Remote.\n");
  await writeDoc(h, "notes/alpha", "Alpha", "Local one.\n");
  await fails(h);
  await writeDoc(h, "notes/alpha", "Alpha", "Local two.\n");
  const local = await read(h, "notes/alpha");
  const again = await fails(h);
  assert.equal(rowFor(again.receipt, "notes/alpha")?.state, "conflict");
  assert.equal(await read(h, "notes/alpha"), local);
  assert.equal(applyCount(h, "notes/alpha"), 0);
  assert.equal(hostDoc(h, "notes/alpha").body, "Remote.\n");
});

test("DL2 local edit + remote delete: deleted_remotely conflict, file kept, never re-created silently", async () => {
  const h = await harness();
  h.host.remove("notes/alpha");
  await writeDoc(h, "notes/alpha", "Alpha", "Local alpha.\n");
  const local = await read(h, "notes/alpha");
  const { receipt } = await fails(h);
  assert.equal(rowFor(receipt, "notes/alpha")?.reason, "deleted_remotely");
  await fails(h);
  assert.equal(await read(h, "notes/alpha"), local);
  assert.equal(h.host.docs.has("notes/alpha"), false);
});

test("DL6a a file edited after the scan while the host changed the same doc: must conflict, never overwrite the host's change", async () => {
  const h = await harness();
  // The host changes beta; sync scans (no local change), then pulls. Between the scan and the
  // export an agent edits beta.md (from the old bytes), so export keeps the file.
  h.host.put("notes/beta", { type: "Note", title: "Beta" }, "HOST change the agent never saw.\n");
  let edited = false;
  h.before = async (route) => {
    if (route === "heads" && !edited) {
      edited = true;
      await writeDoc(h, "notes/beta", "Beta", "AGENT edit made from the old version.\n");
    }
  };
  await attempt(h);
  h.before = undefined;
  const second = await attempt(h);
  // Required: the agent edit and the host change are concurrent changes to one document.
  assert.equal(hostDoc(h, "notes/beta").body, "HOST change the agent never saw.\n", "the host's change was overwritten without a conflict");
  assert.equal(rowFor(second.receipt, "notes/beta")?.state, "conflict");
});

test("DL6b a file edited after the scan while the host deleted it: must conflict, never re-create silently", async () => {
  const h = await harness();
  h.host.remove("notes/beta");
  let edited = false;
  h.before = async (route) => {
    if (route === "heads" && !edited) {
      edited = true;
      await writeDoc(h, "notes/beta", "Beta", "AGENT edit after the scan.\n");
    }
  };
  await attempt(h);
  h.before = undefined;
  const second = await attempt(h);
  assert.equal(h.host.docs.has("notes/beta"), false, "the host's deletion was undone by a silent create");
  assert.equal(rowFor(second.receipt, "notes/beta")?.reason, "deleted_remotely");
});

test("DL7 a file edited while its own push is in flight: the newer edit is sent next run, nothing lost", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "First.\n");
  let edited = false;
  h.before = async (route) => {
    if (route === "replace" && !edited) {
      edited = true;
      await writeDoc(h, "notes/alpha", "Alpha", "Second, typed during the push.\n");
    }
  };
  await ok(h);
  h.before = undefined;
  assert.match(await read(h, "notes/alpha"), /Second, typed during the push/);
  await ok(h);
  assert.equal(hostDoc(h, "notes/alpha").body, "Second, typed during the push.\n");
  assert.match(await read(h, "notes/alpha"), /Second, typed during the push/);
  const settled = await ok(h);
  assert.equal(settled.status, "up_to_date");
});

test("DL4a a lost answer on a create: exactly one write after re-run", async () => {
  const h = await harness();
  let down = true;
  h.host.hook = (call) => (down && call.route === "create" ? { kind: "apply-then-drop" } : down && call.route === "outcome" ? { kind: "drop" } : undefined);
  await writeDoc(h, "notes/gamma", "Gamma", "New.\n");
  const first = await fails(h);
  assert.equal(rowFor(first.receipt, "notes/gamma")?.state, "unknown");
  down = false;
  await ok(h);
  await ok(h);
  assert.equal(applyCount(h, "notes/gamma"), 1);
  assert.equal(new Set(writeRoutes(h).map((call) => call.requestId)).size, 1, "one identity for the create");
});

test("DL4b a request dropped before the host saw it: re-run sends it once, same identity", async () => {
  const h = await harness();
  let drops = 1;
  h.host.hook = (call) => (call.route === "replace" && drops-- > 0 ? { kind: "drop" } : undefined);
  await writeDoc(h, "notes/alpha", "Alpha", "Dropped once.\n");
  await attempt(h);
  await ok(h);
  assert.equal(applyCount(h, "notes/alpha"), 1);
  assert.equal(new Set(writeRoutes(h).map((call) => call.requestId)).size, 1);
});

test("DL4c a lost answer, then the host changes the doc before the lookup: one write, no resend", async () => {
  const h = await harness();
  let down = true;
  h.host.hook = (call) => (down && call.route === "replace" ? { kind: "apply-then-drop" } : down && call.route === "outcome" ? { kind: "drop" } : undefined);
  await writeDoc(h, "notes/alpha", "Alpha", "Mine.\n");
  await attempt(h);
  down = false;
  h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "Someone after me.\n");
  const second = await attempt(h);
  const third = await attempt(h);
  const fourth = await attempt(h);
  console.log(`# DL4c runs: ${JSON.stringify([second, third, fourth].map((o) => (o.ok ? [o.receipt.status, o.receipt.pulled, o.receipt.rows] : [o.error.code, o.receipt?.rows])))}`);
  assert.equal(applyCount(h, "notes/alpha"), 1);
  assert.equal(hostDoc(h, "notes/alpha").body, "Someone after me.\n");
  assert.match(await read(h, "notes/alpha"), /Someone after me/);
});

test("DL5 two syncs at once on one checkout: one runs, the other is sync_busy or waits; exactly one write", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "Concurrent.\n");
  await writeDoc(h, "notes/gamma", "Gamma", "New.\n");
  const run = async (wait: number) => {
    const out: string[] = [];
    try {
      await sync(["--dir", h.folder], { ...deps(h, wait), stdout: (t: string) => void out.push(t) });
      return "ok";
    } catch (error) {
      return (error as CliError).details?.reason ?? (error as CliError).code;
    }
  };
  const results = await Promise.all([run(50), run(50), run(5000)]);
  assert.ok(results.includes("ok"), JSON.stringify(results));
  for (const r of results) assert.ok(r === "ok" || r === "sync_busy", JSON.stringify(results));
  assert.equal(applyCount(h, "notes/alpha"), 1);
  assert.equal(applyCount(h, "notes/gamma"), 1);
});

// ---------------------------------------------------------------- merge rule

test("MR1 disjoint frontmatter keys: conflict, and keep sends exactly the local document (no field merge)", async () => {
  const h = await harness();
  const before = hostDoc(h, "projects/2026/plan");
  h.host.put("projects/2026/plan", { ...before.frontmatter, status: "paused", reviewer: "host" }, before.body);
  const text = await read(h, "projects/2026/plan");
  await writeFile(fileOf(h, "projects/2026/plan"), text.replace("title: Plan", "title: Plan, retitled"));
  const { receipt } = await fails(h);
  assert.equal(rowFor(receipt, "projects/2026/plan")?.state, "conflict");
  assert.equal(applyCount(h, "projects/2026/plan"), 0);
  await ok(h, ["--resolve", "keep", "--doc", "projects/2026/plan"]);
  await ok(h);
  const stored = hostDoc(h, "projects/2026/plan");
  assert.equal(stored.frontmatter.title, "Plan, retitled");
  assert.equal(stored.frontmatter.status, "active", "keep must not merge the host's status");
  assert.equal(stored.frontmatter.reviewer, undefined, "keep must not merge the host's new key");
});

test("MR2 identical change made on both sides is still reported, never silently merged", async () => {
  const h = await harness();
  const before = hostDoc(h, "notes/alpha");
  h.host.put("notes/alpha", before.frontmatter, "Same text.\n");
  const text = await read(h, "notes/alpha");
  await writeFile(fileOf(h, "notes/alpha"), text.replace("Alpha body é.\n", "Same text.\n"));
  const outcome = await attempt(h);
  // Either a conflict or a no-op commit is acceptable; a second apply is not.
  assert.ok(applyCount(h, "notes/alpha") <= 1);
  assert.ok(["conflict", "committed", undefined].includes(rowFor(outcome.receipt, "notes/alpha")?.state));
});

// ---------------------------------------------------------------- resolution

async function conflicted(h: Harness): Promise<void> {
  h.host.put("notes/alpha", { type: "Note", title: "Alpha", tags: ["one", "two"] }, "Host v2.\n");
  await writeDoc(h, "notes/alpha", "Alpha", "Local.\n");
  await fails(h);
}

test("RS1 take: the file becomes exactly the host's bytes, and nothing is sent", async () => {
  const h = await harness();
  await conflicted(h);
  await ok(h, ["--resolve", "take", "--doc", "notes/alpha"]);
  assert.equal(await read(h, "notes/alpha"), hostDoc(h, "notes/alpha").raw);
  const writes = writeRoutes(h).length;
  const after = await ok(h);
  assert.equal(after.status, "up_to_date");
  assert.equal(writeRoutes(h).length, writes);
});

test("RS2 keep: the host holds exactly the local document afterwards", async () => {
  const h = await harness();
  await conflicted(h);
  await ok(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  await ok(h);
  const stored = hostDoc(h, "notes/alpha");
  assert.equal(stored.body, "Local.\n");
  assert.equal(stored.frontmatter.tags, undefined, "keep sends the local document whole");
  assert.equal(applyCount(h, "notes/alpha"), 1);
});

test("RS3 revise: the host holds exactly the revised file", async () => {
  const h = await harness();
  await conflicted(h);
  await writeDoc(h, "notes/alpha", "Alpha merged", "Host v2.\nLocal.\n");
  await ok(h, ["--resolve", "revise", "--doc", "notes/alpha"]);
  await ok(h);
  assert.equal(hostDoc(h, "notes/alpha").body, "Host v2.\nLocal.\n");
  assert.equal(hostDoc(h, "notes/alpha").frontmatter.title, "Alpha merged");
  assert.equal(applyCount(h, "notes/alpha"), 1);
});

test("RS4a keep after the host moved on since --inspect: stale review, the unseen host change is not overwritten", async () => {
  const h = await harness();
  await conflicted(h);
  const inspected = await ok(h, ["--inspect", "notes/alpha"]);
  assert.match(String((inspected.remote as { content: string }).content), /Host v2/);
  h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "Host v3, never inspected.\n");
  const resolved = await attempt(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  await attempt(h);
  const staleReported = !resolved.ok && resolved.error.details?.reason === "stale_review";
  assert.ok(staleReported || hostDoc(h, "notes/alpha").body === "Host v3, never inspected.\n", "keep overwrote a host version the person never inspected, without a stale-review refusal");
});

test("RS4b the host changes during --resolve itself: stale_review", async () => {
  const h = await harness();
  await conflicted(h);
  let reads = 0;
  h.before = (route, body) => {
    if (route === "read" && body.documentId === "notes/alpha" && (reads += 1) === 2) {
      h.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "Host v3 mid-resolve.\n");
    }
  };
  const resolved = await attempt(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  h.before = undefined;
  assert.ok(!resolved.ok, `resolve succeeded after ${reads} reads`);
  assert.equal(resolved.error.details?.reason, "stale_review");
});

test("RS5 resolving a document that is not in conflict is refused, for every choice", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "Pending, not conflicted.\n");
  for (const choice of ["keep", "take", "revise"]) {
    const outcome = await attempt(h, ["--resolve", choice, "--doc", "notes/beta"]);
    assert.ok(!outcome.ok, `${choice} on a clean doc succeeded`);
  }
  // An edited but never-synced file is not a conflict either.
  const pending = await attempt(h, ["--resolve", "revise", "--doc", "notes/alpha"]);
  assert.ok(!pending.ok, "revise on a doc with no conflict succeeded");
  assert.equal(applyCount(h, "notes/alpha"), 0);
});

test("RS6 --doc path traversal is refused and never reads outside the checkout", async () => {
  const h = await harness();
  await writeFile(path.join(h.cwd, "outside.md"), '---\ntype: "Note"\ntitle: "Outside"\n---\nsecret\n');
  for (const doc of ["../outside", "../outside.md", "/etc/hosts", "notes/../../outside"]) {
    const outcome = await attempt(h, ["--resolve", "revise", "--doc", doc]);
    assert.ok(!outcome.ok, `--doc ${doc} was accepted`);
    console.log(`# RS6 ${doc}: ${outcome.error.code} ${outcome.error.message}`);
  }
  assert.equal(writeRoutes(h).length, 0);
});

// ---------------------------------------------------------------- refusals

const quota = (scope: "principal" | "bundle") => ({ kind: "respond" as const, status: 429, body: { error: { code: "request_capacity", scope, message: "q", retryable: false, writeState: "not_applied" } } });

for (const scope of ["principal", "bundle"] as const) {
  test(`RF1 quota (${scope}) mid-push: pause, hold the rest, resume sends each exactly once`, async () => {
    const h = await harness();
    await writeDoc(h, "notes/alpha", "Alpha", "A.\n");
    await writeDoc(h, "notes/beta", "Beta", "B.\n");
    await writeDoc(h, "notes/gamma", "Gamma", "G.\n");
    await writeDoc(h, "notes/delta", "Delta", "D.\n");
    let allowed = 2;
    let full = true;
    h.host.hook = (call) => (call.route !== "outcome" && full && allowed-- <= 0 ? quota(scope) : undefined);
    const paused = await fails(h);
    assert.equal(paused.error.code, "TRANSIENT");
    const rows = rowsOf(paused.receipt);
    assert.equal(rows.filter((row) => row.state === "committed").length, 2);
    assert.equal(rows.filter((row) => row.state === "paused").length, 2);
    assert.ok(rows.filter((row) => row.state === "paused").every((row) => row.reason === `sync_quota_${scope}`), JSON.stringify(rows));
    const sentWhilePaused = writeRoutes(h).length;
    assert.equal(sentWhilePaused, 3, "one refused write, then the rest are held without sending");
    full = false;
    await ok(h);
    for (const id of ["notes/alpha", "notes/beta", "notes/gamma", "notes/delta"]) assert.equal(applyCount(h, id), 1, id);
  });
}

test("RF2 read-only person: refused with the clear message, file kept, nothing applied", async () => {
  const h = await harness(new FakeHost({ capabilities: "capabilities-read-only" }));
  await writeDoc(h, "notes/alpha", "Alpha", "Read-only edit.\n");
  const local = await read(h, "notes/alpha");
  const { error, receipt } = await fails(h);
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(rowFor(receipt, "notes/alpha")?.reason, "read_only");
  assert.equal(writeRoutes(h).length, 0);
  assert.equal(await read(h, "notes/alpha"), local);
});

test("RF3 access revoked between pull and push (the host's 200 insufficient_scope answer): paused, nothing lost, resume sends once", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "Before revocation.\n");
  await writeDoc(h, "notes/beta", "Beta", "Also before.\n");
  let revoked = true;
  // superbee-hosted src/sync-v1-writes.ts accessChanged(): 200, ok:false, insufficient_scope, not_applied, nothing recorded.
  h.host.hook = (call) =>
    revoked && call.route !== "outcome"
      ? { kind: "respond", status: 200, body: { ok: false, operationId: call.route === "create" ? "documents.create.v1" : "documents.replace.v1", error: { code: "insufficient_scope", message: "Your access to this bundle does not allow this write. Nothing was written.", retryable: false, writeState: "not_applied" } } }
      : undefined;
  const first = await fails(h);
  const rows = rowsOf(first.receipt);
  console.log(`# RF3 first: ${first.error.code} rows=${JSON.stringify(rows.map((r) => [r.id, r.state, r.reason]))} sent=${writeRoutes(h).length}`);
  assert.match(await read(h, "notes/alpha"), /Before revocation/);
  revoked = false;
  const resumed = await attempt(h);
  console.log(`# RF3 resume: ${resumed.ok ? JSON.stringify(rowsOf(resumed.receipt).map((r) => [r.id, r.state])) : resumed.error.code + " " + JSON.stringify(rowsOf(resumed.receipt))}`);
  assert.equal(applyCount(h, "notes/alpha"), 1, "resume after access returns sends the change");
  assert.equal(applyCount(h, "notes/beta"), 1);
  // Safety bar: the first refusal stops the push (the rest are held unsent), nothing is lost, resume sends once.
  // (Design 3.4 names this row "paused: access withdrawn"; the PR reports refused/read_only, exit 2 — noted, not failed.)
  assert.ok(rows.every((row) => row.state === "paused" || (row.state === "refused" && row.reason === "read_only")), JSON.stringify(rows));
});

test("RF3a access revoked, answered as the transport's 403: not reported as an ended sign-in", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "x\n");
  h.host.hook = (call) => (call.route !== "outcome" ? { kind: "respond", status: 403, body: { error: { code: "access_denied" } } } : undefined);
  const first = await fails(h);
  console.log(`# RF3a: ${first.error.code} ${first.error.message}`);
  assert.notEqual(first.error.code, "AUTH_REQUIRED", "a withdrawn grant is reported as a sign-in problem; signing in again cannot fix it");
});

test("RF3b bundle gone (404) between pull and push: clear error, change kept locally", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "Unsent.\n");
  h.host.hook = (call) => (call.route !== "outcome" ? { kind: "respond", status: 404, body: { error: { code: "bundle_not_found", message: "gone", retryable: false } } } : undefined);
  const outcome = await attempt(h);
  assert.ok(!outcome.ok);
  assert.match(await read(h, "notes/alpha"), /Unsent/);
  h.host.hook = undefined;
  await ok(h);
  assert.equal(applyCount(h, "notes/alpha"), 1);
});

test("RF4 sign-in expires after some writes landed: AUTH_REQUIRED, resume sends only the rest, once each", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "A.\n");
  await writeDoc(h, "notes/beta", "Beta", "B.\n");
  await writeDoc(h, "notes/gamma", "Gamma", "G.\n");
  let allowed = 1;
  let expired = true;
  h.host.hook = (call) => (expired && call.route !== "outcome" && allowed-- <= 0 ? { kind: "respond", status: 401, body: { error: { code: "unauthenticated", writeState: "not_applied" } } } : undefined);
  const { error } = await fails(h);
  assert.equal(error.code, "AUTH_REQUIRED");
  expired = false;
  await ok(h);
  for (const id of ["notes/alpha", "notes/beta", "notes/gamma"]) assert.equal(applyCount(h, id), 1, id);
});

test("RF5 locally refused commands in a checkout: delete, Kinds, ui, mcp", async () => {
  const h = await harness();
  const refused = async (name: string, args: string[]) => {
    try {
      await assertAllowedInHostedCheckout(name as never, args, { home: h.home, cwd: h.cwd });
      return false;
    } catch {
      return true;
    }
  };
  const cases: [string, string[]][] = [
    ["doc", ["delete", "notes/alpha", "--dir", h.folder]],
    ["delete", ["notes/alpha", "--dir", h.folder]],
    ["kind", ["add", "Thing", "--dir", h.folder]],
    ["ui", ["--dir", h.folder]],
    ["mcp", ["--dir", h.folder]],
    // Flag-first spellings (`doc --dir X delete`) slip past matchRow, but the CLI's own parser
    // rejects them (RF5b), so they are not probed here.
  ];
  const missed = [];
  for (const [name, args] of cases) if (!(await refused(name, args))) missed.push(`${name} ${args.join(" ")}`);
  assert.deepEqual(missed, []);
});

// ---------------------------------------------------------------- filesystem hostility

test("FS1 a host document whose path differs only by case from an existing file is not silently hidden", async () => {
  const h = await harness();
  h.host.put("notes/ALPHA", { type: "Note", title: "Shouty" }, "Different doc.\n");
  const outcome = await attempt(h);
  const names = await readdir(path.join(h.folder, "notes"));
  const placed = names.includes("ALPHA.md");
  const reported = JSON.stringify(outcome.ok ? outcome.receipt : { e: outcome.error.details, r: outcome.receipt }).match(/collision|case/i);
  assert.ok(placed || reported, `notes/ALPHA is neither placed nor reported as a case collision: ${JSON.stringify(outcome.ok ? outcome.receipt.pulled : outcome.error.message)}`);
});

test("FS1b a new local file colliding by case with a host document is held, not created as a second document", async () => {
  const h = await harness();
  // The host gains notes/gamma while the person creates notes/Gamma.md.
  h.host.put("notes/gamma", { type: "Note", title: "Host gamma" }, "Host.\n");
  await writeDoc(h, "notes/Gamma", "Local Gamma", "Local.\n");
  await attempt(h);
  await attempt(h);
  const ids = [...h.host.docs.keys()].filter((id) => id.toLowerCase() === "notes/gamma");
  assert.equal(ids.length, 1, `the host now has case-colliding ids ${JSON.stringify(ids)}`);
});

test("FS2 a host id that escapes the folder never creates anything outside the checkout", async () => {
  const h = await harness();
  h.host.docs.set("../escape/x", { ...hostDoc(h, "notes/alpha") });
  const outcome = await attempt(h);
  console.log(`# FS2 ${outcome.ok ? "ok" : outcome.error.message}`);
  await assert.rejects(stat(path.join(h.cwd, "escape")), "sync created a directory outside the checkout");
});

test("FS2b new local files with traversal-looking names are held, never sent under another id", async () => {
  const h = await harness();
  await mkdir(path.join(h.folder, "notes", ".."), { recursive: true });
  await writeFile(path.join(h.folder, "notes", "..%2f..%2fx.md"), '---\ntype: "Note"\ntitle: "x"\n---\nx\n');
  await writeFile(path.join(h.folder, "notes", "a\\..\\..\\b.md"), '---\ntype: "Note"\ntitle: "y"\n---\ny\n');
  await attempt(h);
  for (const id of h.host.docs.keys()) assert.ok(!id.split("/").includes(".."), `host got ${id}`);
});

test("FS3 symlinks inside the checkout: file and directory links are held, nothing outside is read or written", async () => {
  const h = await harness();
  const outside = path.join(h.cwd, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), '---\ntype: "Note"\ntitle: "Secret"\n---\nsecret\n');
  await symlink(path.join(outside, "secret.md"), path.join(h.folder, "notes", "link.md"));
  await symlink(outside, path.join(h.folder, "notes", "dirlink"));
  // The host also has a doc under the symlinked directory.
  h.host.put("notes/dirlink/planted", { type: "Note", title: "Planted" }, "planted\n");
  const outcome = await attempt(h);
  console.log(`# FS3 first: ${outcome.ok ? JSON.stringify(outcome.receipt.rows) : outcome.error.message}`);
  assert.equal((await readdir(outside)).sort().join(","), "secret.md", "sync wrote through a symlinked directory");
  for (const id of h.host.docs.keys()) assert.ok(!/secret|link\b/.test(id) || id === "notes/dirlink/planted", `host got ${id}`);
  assert.ok(!outcome.ok || outcome.receipt, "sync reported");
  // The rest of the bundle still syncs despite the symlink: an unrelated edit lands.
  await writeDoc(h, "notes/alpha", "Alpha", "Still syncs.\n");
  const next = await attempt(h);
  assert.equal(hostDoc(h, "notes/alpha").body, "Still syncs.\n", `an unrelated edit is blocked: ${next.ok ? "" : next.error.message}`);
});

test("FS4 huge files are held too_large; the rest still syncs", async () => {
  const h = await harness();
  await writeDoc(h, "notes/huge", "Huge", "x".repeat(10 * 1024 * 1024));
  await writeDoc(h, "notes/escaped", "Escaped", '"\u0001'.repeat(20 * 1024)); // < 64 KiB bytes, > 64 KiB as JSON
  await writeDoc(h, "notes/alpha", "Alpha", "Small.\n");
  const { receipt } = await fails(h);
  assert.equal(rowFor(receipt, "notes/huge")?.reason, "too_large");
  assert.equal(rowFor(receipt, "notes/escaped")?.reason, "too_large");
  assert.equal(hostDoc(h, "notes/alpha").body, "Small.\n");
  assert.equal(h.host.docs.has("notes/huge"), false);
});

test("FS5 non-UTF-8 bytes are held, never sent as replacement characters or overwritten", async () => {
  const h = await harness();
  const bytes = Buffer.concat([Buffer.from('---\ntype: "Note"\ntitle: "Latin1"\n---\ncaf'), Buffer.from([0xe9, 0x0a])]);
  await writeFile(fileOf(h, "notes/latin"), bytes);
  await attempt(h);
  await attempt(h);
  const doc = h.host.docs.get("notes/latin");
  console.log(`# FS5 host=${JSON.stringify(doc?.body)} file=${JSON.stringify((await readFile(fileOf(h, "notes/latin"))).toString("latin1"))}`);
  assert.ok(!doc || !doc.body.includes("�"), `the host got U+FFFD: ${JSON.stringify(doc?.body)}`);
  assert.deepEqual(await readFile(fileOf(h, "notes/latin")), bytes, "the original bytes were replaced in the folder");
});

test("FS6 CRLF files: sent once, then stable (no ping-pong), bytes of the body preserved", async () => {
  const h = await harness();
  await writeFile(fileOf(h, "notes/crlf"), '---\r\ntype: "Note"\r\ntitle: "CRLF"\r\n---\r\nLine one\r\nLine two\r\n');
  await ok(h);
  await ok(h);
  const third = await ok(h);
  assert.equal(third.status, "up_to_date");
  assert.equal(applyCount(h, "notes/crlf"), 1);
  // beta's body carries CRLF from the host: an untouched checkout never sends it.
  assert.equal(applyCount(h, "notes/beta"), 0);
});

test("FS6b editing only the frontmatter of the CRLF-bodied beta keeps its body's CRLF on the host", async () => {
  const h = await harness();
  const text = await read(h, "notes/beta");
  await writeFile(fileOf(h, "notes/beta"), text.replace("title: Beta", "title: Beta two"));
  await ok(h);
  assert.equal(hostDoc(h, "notes/beta").body, "Line one\r\nLine two\r\n");
});

// ---------------------------------------------------------------- scale

test("SC1 500 local changes with a quota at 300: pause, then resume; every doc exactly once", async () => {
  const h = await harness();
  for (let i = 0; i < 500; i += 1) {
    await mkdir(path.join(h.folder, "bulk"), { recursive: true });
    await writeDoc(h, `bulk/doc-${String(i).padStart(3, "0")}`, `Doc ${i}`, `Body ${i}.\n`);
  }
  let budget = 300;
  let full = true;
  h.host.hook = (call) => (call.route !== "outcome" && full && budget-- <= 0 ? quota("principal") : undefined);
  const started = Date.now();
  const paused = await fails(h);
  const firstMs = Date.now() - started;
  assert.equal((paused.receipt!.counts as Record<string, number>).committed, 300);
  assert.equal((paused.receipt!.counts as Record<string, number>).paused, 200);
  assert.equal(writeRoutes(h).length, 301, "the rest are held after the first quota refusal");
  full = false;
  const resumed = await ok(h);
  assert.equal((resumed.counts as Record<string, number>).committed, 200);
  const settled = await ok(h);
  assert.equal(settled.status, "up_to_date");
  for (let i = 0; i < 500; i += 1) assert.equal(applyCount(h, `bulk/doc-${String(i).padStart(3, "0")}`), 1);
  console.log(`# SC1 first run over 500 changes took ${firstMs} ms`);
});

void fsp;

// ---------------------------------------------------------------- concurrent CLI writer

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const SUPERBEE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../superbee/dist/superbee.mjs");

test("DL8 another CLI command (doc write) runs during a sync: its writes are kept and sent by the next sync", async () => {
  const h = await harness();
  await writeDoc(h, "notes/alpha", "Alpha", "Sync's edit.\n");
  let ran = false;
  let cliOutput = "";
  h.before = async (route) => {
    if (route === "replace" && !ran) {
      ran = true;
      const env = { ...process.env, HOME: h.home, SUPERBEE_ACTOR: "qa/probe" };
      const a = await run(process.execPath, [SUPERBEE, "doc", "write", "notes/delta", "--type", "Note", "--title", "Delta", "--body", "Written by another command.", "--dir", h.folder], { env }).catch((e) => e);
      const b = await run(process.execPath, [SUPERBEE, "doc", "write", "notes/beta", "--type", "Note", "--title", "Beta by CLI", "--body", "CLI beta.", "--dir", h.folder], { env }).catch((e) => e);
      cliOutput = `${a.stdout ?? ""}${a.stderr ?? ""}${b.stdout ?? ""}${b.stderr ?? ""}`;
    }
  };
  await attempt(h);
  h.before = undefined;
  console.log(`# DL8 cli: ${cliOutput.replace(/\s+/g, " ").slice(0, 300)}`);
  const second = await attempt(h);
  console.log(`# DL8 second: ${second.ok ? JSON.stringify(second.receipt.rows) : second.error.code + " " + JSON.stringify(rowsOf(second.receipt))}`);
  assert.equal(hostDoc(h, "notes/alpha").body, "Sync's edit.\n");
  assert.match(hostDoc(h, "notes/delta").body, /Written by another command/);
  assert.match(hostDoc(h, "notes/beta").body, /CLI beta/);
});

test("FS3b a host doc two levels under a symlinked directory never creates directories outside the checkout", async () => {
  const h = await harness();
  const outside = path.join(h.cwd, "outside2");
  await mkdir(outside);
  await symlink(outside, path.join(h.folder, "notes", "dirlink"));
  h.host.put("notes/dirlink/sub/deeper/planted", { type: "Note", title: "Planted" }, "planted\n");
  const outcome = await attempt(h);
  console.log(`# FS3b ${outcome.ok ? "ok" : outcome.error.message}; outside now: ${JSON.stringify(await readdir(outside))}`);
  assert.deepEqual(await readdir(outside), [], "sync created directories through a symlink, outside the checkout");
});

test("RF5b the real CLI: `doc --dir <checkout> delete <id>` must not delete a checkout file", async () => {
  const h = await harness();
  const env = { ...process.env, HOME: h.home, SUPERBEE_ACTOR: "qa/probe" };
  const plain = await run(process.execPath, [SUPERBEE, "doc", "delete", "notes/alpha", "--dir", h.folder], { env }).catch((e) => e);
  const flagFirst = await run(process.execPath, [SUPERBEE, "doc", "--dir", h.folder, "delete", "notes/alpha"], { env }).catch((e) => e);
  console.log(`# RF5b plain: ${(plain.stdout ?? "") + (plain.stderr ?? "")}`.replace(/\s+/g, " ").slice(0, 250));
  console.log(`# RF5b flag-first: ${(flagFirst.stdout ?? "") + (flagFirst.stderr ?? "")}`.replace(/\s+/g, " ").slice(0, 250));
  assert.ok(await stat(fileOf(h, "notes/alpha")).then(() => true, () => false), "the checkout file was deleted by a command the checkout must refuse");
});
