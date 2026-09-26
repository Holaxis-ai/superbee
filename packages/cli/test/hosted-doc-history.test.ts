// `superbee doc history` in a hosted checkout: the host's version chain over `/sync/v1/history`
// (`documents.history.v1`), read through the checkout's own signed-in person, against the stateful
// fake of the hosted sync routes. The fake's history answers are held to the host's golden
// exchanges by `hosted-fake-contract.test.ts`. A local bundle keeps its own behavior (`doc.test.ts`).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { versionOfBytes } from "@superbee/core/versioning";

import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { checkout } from "../src/commands/checkout.js";
import { doc } from "../src/commands/doc.js";
import { HOSTED_HISTORY_CEILING } from "../src/commands/doc/common.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  /** The document the checkout projected first. */
  id: string;
}

async function harness(host = new FakeHost()): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-dochist-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-dochist-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return { folder: path.join(cwd, "team"), auth, host, id: [...host.docs.keys()][0]! };
}

async function history(h: Harness, argv: string[], fetch: typeof globalThis.fetch = h.host.fetch): Promise<string> {
  const out: string[] = [];
  await doc(["history", ...argv, "--dir", h.folder], { stdout: (text) => void out.push(text), hosted: { auth: h.auth, fetch } });
  return out.join("");
}

async function historyJson(h: Harness, argv: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await history(h, [...argv, "--json"])) as Record<string, unknown>;
}

async function rejects(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected doc history to fail");
}

/** `n` further versions of `id` on the host, each a change made there. */
function edits(host: FakeHost, id: string, n: number): void {
  for (let index = 0; index < n; index += 1) host.put(id, { type: "Note" }, `edit ${index}`);
}

const historyRequests = (host: FakeHost) => host.requests.filter((request) => request.path === "/sync/v1/history").map((request) => request.body as Record<string, unknown>);

test("a hosted checkout lists the host's chain newest first, with seq, principal ids and agent labels, and no --expected-version line", async () => {
  const h = await harness();
  edits(h.host, h.id, 2);
  h.host.histories.get(h.id)!.at(-1)!.agent = "sync/credential:cli;via=codex";
  const record = await historyJson(h, [h.id]);
  const rows = h.host.histories.get(h.id)!;
  assert.deepEqual(record, {
    id: h.id,
    count: 3,
    versions: [...rows].reverse().map((row) => ({ seq: row.seq, version: row.version, actor: row.actor, timestamp: row.timestamp, ...(row.agent ? { agent: row.agent } : {}) })),
    help: [`${cliInvocation()} doc history ${h.id} --seq 3`],
  });
  assert.deepEqual(
    h.host.requests.map((request) => request.path),
    ["/sync/v1/whoami", "/sync/v1/history"],
    "the checkout's person is checked before the history is read",
  );
  assert.deepEqual(historyRequests(h.host), [{ bundleId: BUNDLE, documentId: h.id, limit: 20 }]);
  // The TOON rendering carries the same record.
  assert.deepEqual(decode((await history(h, [h.id])).trim()), record);
});

test("--limit truncates to the newest n and count stays the host's true total", async () => {
  const h = await harness();
  edits(h.host, h.id, 25);
  const record = await historyJson(h, [h.id]);
  assert.equal(record.count, 26);
  assert.equal(record.shown, 20);
  assert.deepEqual((record.versions as { seq: number }[]).map((row) => row.seq), Array.from({ length: 20 }, (_, index) => 26 - index));
  assert.equal((record.help as string[])[0], `showing 20 of 26 — run \`${cliInvocation()} doc history ${h.id} --limit 0\` (or a higher --limit) for all`);
  const three = await historyJson(h, [h.id, "--limit", "3"]);
  assert.deepEqual([three.count, three.shown, (three.versions as unknown[]).length], [26, 3, 3]);
});

test("--limit 0 pages back 100 at a time with before, to the whole chain", async () => {
  const h = await harness();
  edits(h.host, h.id, 250);
  const record = await historyJson(h, [h.id, "--limit", "0"]);
  assert.equal(record.count, 251);
  assert.equal(record.shown, undefined);
  const seqs = (record.versions as { seq: number }[]).map((row) => row.seq);
  assert.deepEqual(seqs, Array.from({ length: 251 }, (_, index) => 251 - index));
  assert.deepEqual(
    historyRequests(h.host).map(({ limit, before }) => [limit, before]),
    [
      [100, undefined],
      [100, 152],
      [100, 52],
      [1, undefined],
    ],
    "a listing of more than one page is checked against a fresh first page",
  );
});

test("a write that lands between pages starts the listing again; a chain that keeps moving is a retryable refusal", async () => {
  const h = await harness();
  edits(h.host, h.id, 150);
  let writes = 1;
  // One host write after the first page of the first attempt only.
  const oneWrite = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = await h.host.fetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { before?: number; limit?: number };
    if (String(input).endsWith("/history") && body.before === undefined && body.limit === 100 && writes > 0) {
      writes -= 1;
      edits(h.host, h.id, 1);
    }
    return answer;
  }) as typeof fetch;
  const record = JSON.parse(await history(h, [h.id, "--limit", "0", "--json"], oneWrite)) as { count: number; versions: { seq: number }[] };
  assert.equal(record.count, 152, "the second attempt's total");
  assert.deepEqual(record.versions.map((row) => row.seq), Array.from({ length: 152 }, (_, index) => 152 - index));
  assert.deepEqual(
    historyRequests(h.host).map(({ limit, before }) => [limit, before]),
    [
      [100, undefined],
      [100, 52],
      [1, undefined],
      [100, undefined],
      [100, 53],
      [1, undefined],
    ],
  );
  // A write after every first page: never merged, refused after the attempts.
  const always = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = await h.host.fetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { before?: number; limit?: number };
    if (String(input).endsWith("/history") && body.before === undefined && body.limit === 100) edits(h.host, h.id, 1);
    return answer;
  }) as typeof fetch;
  const error = await rejects(() => history(h, [h.id, "--limit", "0"], always));
  assert.equal(error.code, "TRANSIENT");
  assert.equal(error.details?.reason, "history_moved");
  assert.equal(error.details?.retryable, true);
});

test("--limit 0 stops at the listing ceiling and says so", async () => {
  const h = await harness();
  const rows = h.host.histories.get(h.id)!;
  const [seed] = rows;
  for (let seq = 2; seq <= HOSTED_HISTORY_CEILING + 5; seq += 1) rows.push({ ...seed!, seq, version: versionOfBytes(String(seq)) });
  const record = await historyJson(h, [h.id, "--limit", "0"]);
  assert.equal(record.count, HOSTED_HISTORY_CEILING + 5);
  assert.equal(record.shown, HOSTED_HISTORY_CEILING);
  assert.equal((record.versions as unknown[]).length, HOSTED_HISTORY_CEILING);
  assert.match((record.help as string[])[0]!, new RegExp(`^showing the newest ${HOSTED_HISTORY_CEILING} of ${HOSTED_HISTORY_CEILING + 5} — the listing stops at ${HOSTED_HISTORY_CEILING}`));
  assert.equal(historyRequests(h.host).length, HOSTED_HISTORY_CEILING / 100 + 1);
});

test("--seq prints that version's stored content; with --json, its row and the content", async () => {
  const h = await harness();
  edits(h.host, h.id, 2);
  const [first, second] = h.host.histories.get(h.id)!;
  assert.equal(await history(h, [h.id, "--seq", "1"]), first!.raw);
  assert.deepEqual(historyRequests(h.host).at(-1), { bundleId: BUNDLE, documentId: h.id, limit: 1, before: 2, includeContent: true });
  const record = await historyJson(h, [h.id, "--seq", "2"]);
  assert.deepEqual(record, { id: h.id, seq: 2, version: second!.version, actor: second!.actor, timestamp: second!.timestamp, content: second!.raw });
  assert.equal(versionOfBytes(record.content as string), record.version);
  const missing = await rejects(() => history(h, [h.id, "--seq", "9"]));
  assert.equal(missing.code, "NOT_FOUND");
  assert.match(missing.message, /has no version 9/);
});

test("--seq is refused outside a hosted checkout, before anything is read", async () => {
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-dochist-local-")));
  for (const argv of [["notes/one", "--seq", "1", "--dir", plain], ["notes/one", "--seq", "1", "--remote", "http://127.0.0.1:9"]]) {
    const error = await rejects(() => doc(["history", ...argv], { stdout: () => assert.fail("nothing is printed") }));
    assert.equal(error.code, "USAGE");
    assert.equal(error.details?.reason, "no_hosted_history");
    assert.match(error.help ?? "", /doc read notes\/one/);
  }
  const h = await harness();
  const both = await rejects(() => history(h, [h.id, "--seq", "1", "--limit", "2"]));
  assert.equal(both.code, "USAGE");
  for (const bad of ["0", "x", "-1"]) assert.equal((await rejects(() => history(h, [h.id, `--seq=${bad}`]))).code, "USAGE");
});

test("a gateway from before /history answers its unknown-route 404: 'does not serve document history yet'", async () => {
  const h = await harness(new FakeHost({ history: false }));
  const error = await rejects(() => history(h, [h.id]));
  assert.equal(error.code, "NOT_IMPLEMENTED");
  assert.match(error.message, /does not serve document history yet/);
  assert.equal(error.details?.status, 404);
});

test("a document the host does not have is the definitive empty state, as a local bundle answers it", async () => {
  const h = await harness();
  const record = await historyJson(h, ["notes/never-sent"]);
  assert.equal(record.count, 0);
  assert.deepEqual(record.versions, []);
  assert.match(record.help as string, /no version history for 'notes\/never-sent' on https:\/\/hosted\.example/);
});

test("the checkout's person is required: another signed-in identity is refused before any history is read", async () => {
  const h = await harness();
  h.host.principal = "principal-other";
  const error = await rejects(() => history(h, [h.id]));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "other_principal");
  assert.deepEqual(historyRequests(h.host), []);
});

test("an answer outside the page asked for is a contract mismatch, not a listing", async () => {
  const h = await harness();
  const unasked = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = await h.host.fetch(input, init);
    if (!String(input).endsWith("/history")) return answer;
    const body = (await answer.json()) as { data: { versions: Record<string, unknown>[] } };
    body.data.versions[0]!.content = "not asked for";
    return Response.json(body);
  }) as typeof fetch;
  const error = await rejects(() => history(h, [h.id], unasked));
  assert.equal(error.code, "RUNTIME");
  assert.equal(error.details?.route, "/sync/v1/history");
  assert.equal(error.details?.retryable, false);
});
