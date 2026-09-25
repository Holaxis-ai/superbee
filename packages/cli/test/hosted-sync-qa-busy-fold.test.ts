// QA probes for the busy-refusal fold and requeue in a hosted checkout. The fold retires a busy
// head and its never-sent edit into one fresh intent; the requeue resends a lone busy head under a
// fresh identity. Both are sound only when a busy refusal is definitive (not_applied), so the
// probes pin that: a changed document's bytes only ever travel under the identity that may have
// landed them, a chain never wedges, and nothing applies twice.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { parseMarkdown } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  folder: string;
  cwd: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  fetch: typeof fetch;
}

async function harness(): Promise<Harness> {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa-busy-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa-busy-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return { folder: path.join(cwd, "team"), cwd, auth, host, fetch: host.fetch };
}

const instant = async () => {};

/** One sync; the receipt it printed, whether or not it exited non-zero. */
async function syncOnce(h: Harness): Promise<Record<string, unknown>> {
  const out: string[] = [];
  try {
    await sync(["--dir", h.folder], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant, lockWaitMs: 200 });
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
  }
  assert.ok(out.length > 0, "sync printed a receipt");
  return decode(out.at(-1)!.trim()) as Record<string, unknown>;
}

type Row = { id: string; state: string; reason: string; message: string };
const rowFor = (receipt: Record<string, unknown>, id: string): Row | undefined => ((receipt.rows as Row[]) ?? []).find((row) => row.id === id);

async function setBody(h: Harness, id: string, body: string): Promise<void> {
  const file = path.join(h.folder, `${id}.md`);
  const parsed = parseMarkdown(await readFile(file, "utf8"), id);
  const yaml = Object.entries(parsed.frontmatter as Record<string, unknown>).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(file, `---\n${yaml}\n---\n${body}`);
}

/** The document writes (not lookups) whose body is `body`, by whether they carried `identity`. */
const sentWith = (h: Harness, body: string) => h.host.writes.filter((call) => call.route !== "outcome" && call.body.body === body);

/**
 * First run: the change's submission and its lookups are all lost, so it is possibly delivered.
 * Returns the identity that carried it.
 */
async function loseFirstAnswer(h: Harness, route: "create" | "replace" | "delete"): Promise<() => string> {
  let first: string | null = null;
  h.host.hook = (call) => {
    if (call.route === route) first ??= call.requestId;
    return { kind: "drop" };
  };
  const unknown = await syncOnce(h);
  assert.ok(first, "the change was sent");
  h.host.hook = undefined;
  assert.equal(rowFor(unknown, "notes/alpha")?.state ?? rowFor(unknown, "notes/new")?.state, "unknown");
  return () => first!;
}

/**
 * The host applies and records the write, but answers it `concurrent_change` with write state
 * `unknown` under the settled header: the answer is recorded, not proof the write never applied.
 */
function answerLandedAsBusy(h: Harness, identity: () => string): void {
  let mangled = false;
  h.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await h.host.fetch(input, init);
    const call = h.host.writes.at(-1);
    if (mangled || !call || call.route !== "replace" || call.requestId !== identity()) return response;
    mangled = true;
    const body = { ok: false, operationId: "documents.replace.v1", error: { code: "concurrent_change", message: "busy", retryable: false, writeState: "unknown" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-superbee-write-settled": identity() } });
  }) as typeof fetch;
}

test("qa: a resend that lands but is answered busy with write state unknown is looked up, never requeued under a fresh identity (lone change and chained edit)", async () => {
  for (const chained of [false, true]) {
    const h = await harness();
    const original = h.host.docs.get("notes/alpha")!.version;
    await setBody(h, "notes/alpha", "First.\n");
    const first = await loseFirstAnswer(h, "replace");
    if (chained) await setBody(h, "notes/alpha", "Second.\n");
    answerLandedAsBusy(h, first);
    h.host.writes.length = 0;
    const receipt = await syncOnce(h);
    const label = chained ? "chained" : "lone";

    // The first change's bytes travel only under the identity that landed them.
    assert.deepEqual(sentWith(h, "First.\n").map((call) => call.requestId === first()), [true], `${label}: First. is never resent under a fresh identity`);
    assert.equal(receipt.status, "synced", `${label}: ${JSON.stringify(receipt)}`);
    assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed", label);
    if (chained) {
      // The edit follows the landed change, against the version the host committed it at.
      const [second, ...more] = sentWith(h, "Second.\n");
      assert.deepEqual(more, [], label);
      assert.notEqual(second!.body.expectedVersion, original, `${label}: the edit is based on the landed change, not the original`);
      assert.equal(h.host.docs.get("notes/alpha")!.body, "Second.\n", label);
      assert.equal(h.host.applied.length, 2, `${label}: each change applied once`);
    } else {
      assert.equal(h.host.docs.get("notes/alpha")!.body, "First.\n", label);
      assert.equal(h.host.applied.length, 1, `${label}: applied once`);
    }
  }
});

test("qa: a busy head, then the fold's fresh intent busy too, then the requeue: the first change's bytes only ever under its own identity, the edit lands once", async () => {
  const h = await harness();
  const original = h.host.docs.get("notes/alpha")!.version;
  await setBody(h, "notes/alpha", "First.\n");
  const first = await loseFirstAnswer(h, "replace");
  await setBody(h, "notes/alpha", "Second.\n");
  const busy = new Set<string>();
  h.host.hook = (call) => {
    if (call.route !== "replace") return undefined;
    // The first change, and the first fresh identity that carries the edit, are refused busy.
    if (call.requestId === first() || (call.body.body === "Second.\n" && busy.size < 2)) {
      busy.add(call.requestId!);
      return { kind: "record", code: "concurrent_change" };
    }
    return undefined;
  };
  h.host.writes.length = 0;
  const receipt = await syncOnce(h);
  assert.equal(receipt.status, "synced", JSON.stringify(receipt));
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.deepEqual(sentWith(h, "First.\n").map((call) => call.requestId === first()), [true], "the first change is never sent under a fresh identity");
  const edits = sentWith(h, "Second.\n");
  assert.equal(edits.length, 2, "the fold's fresh intent, then its requeue");
  assert.notEqual(edits[0]!.requestId, edits[1]!.requestId);
  assert.ok(edits.every((call) => call.requestId !== first() && call.body.expectedVersion === original), "each on the premise the host still holds");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Second.\n");
  assert.deepEqual(h.host.applied, ["notes/alpha"], "one application: the edit");
  h.host.writes.length = 0;
  assert.equal((await syncOnce(h)).status, "up_to_date");
  assert.equal(h.host.writes.length, 0, "nothing is sent again");
});

test("qa: a busy refusal on a create with a chained edit folds into one create of the edit", async () => {
  const h = await harness();
  const file = path.join(h.folder, "notes/new.md");
  await writeFile(file, `---\ntype: "Note"\ntitle: "New"\n---\nFirst.\n`);
  const first = await loseFirstAnswer(h, "create");
  await setBody(h, "notes/new", "Second.\n");
  h.host.hook = (call) => (call.route === "create" && call.requestId === first() ? { kind: "record", code: "backend_unavailable" } : undefined);
  h.host.writes.length = 0;
  const receipt = await syncOnce(h);
  assert.equal(receipt.status, "synced", JSON.stringify(receipt));
  assert.deepEqual(sentWith(h, "First.\n").map((call) => call.requestId === first()), [true]);
  const [create, ...more] = sentWith(h, "Second.\n");
  assert.deepEqual(more, []);
  assert.equal(create!.route, "create");
  assert.equal(h.host.docs.get("notes/new")!.body, "Second.\n");
  assert.deepEqual(h.host.applied, ["notes/new"]);
});

test("qa: a busy delete with a chained re-create folds into a replace of the version the host still holds; nothing is deleted", async () => {
  const h = await harness();
  const original = h.host.docs.get("notes/alpha")!.version;
  const saved = await readFile(path.join(h.folder, "notes/alpha.md"), "utf8");
  await unlink(path.join(h.folder, "notes/alpha.md"));
  const first = await loseFirstAnswer(h, "delete");
  await writeFile(path.join(h.folder, "notes/alpha.md"), saved.replace(/\n---\n[\s\S]*$/, "\n---\nRecreated.\n"));
  h.host.hook = (call) => (call.route === "delete" && call.requestId === first() ? { kind: "record", code: "deadline_exceeded" } : undefined);
  h.host.writes.length = 0;
  // Creates are offered before deletes, so the re-create meets its predecessor still unsettled in
  // the run that settles the delete busy; the fold happens by the next run at the latest.
  let receipt = await syncOnce(h);
  const runs = [String(receipt.status)];
  if (receipt.status !== "synced") {
    assert.deepEqual([rowFor(receipt, "notes/alpha")?.state, rowFor(receipt, "notes/alpha")?.reason], ["paused", "busy"], JSON.stringify(receipt));
    receipt = await syncOnce(h);
    runs.push(String(receipt.status));
  }
  assert.equal(receipt.status, "synced", `${runs.join(" -> ")}: ${JSON.stringify(receipt)}`);
  const writes = h.host.writes.filter((call) => call.route !== "outcome");
  assert.deepEqual(writes.map((call) => [call.route, call.requestId === first()]), [["delete", true], ["replace", false]], "the delete once, then one replace");
  assert.deepEqual([writes[1]!.body.expectedVersion, writes[1]!.body.body], [original, "Recreated.\n"]);
  assert.equal(h.host.tombstones.get("notes/alpha"), undefined, "the host never deleted it");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Recreated.\n");
  assert.deepEqual(h.host.applied, ["notes/alpha"]);
});
