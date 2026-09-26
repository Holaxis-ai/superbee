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
import { parseMarkdown } from "@superbee/core";
import { BODY_PREVIEW_LIMIT } from "../src/body-replace-guards.js";

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
      [1, 252],
    ],
    "a listing of more than one page re-reads its newest version by seq",
  );
});

/** The fake's fetch, with `after` run once a history request has been answered. */
function afterHistory(h: Harness, after: (body: { before?: number; limit?: number }) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = await h.host.fetch(input, init);
    if (String(input).endsWith("/history")) after(JSON.parse(String(init?.body ?? "{}")) as { before?: number; limit?: number });
    return answer;
  }) as typeof fetch;
}

test("a write between pages keeps the listing (older versions never change); a delete and recreate starts it again", async () => {
  const h = await harness();
  edits(h.host, h.id, 150);
  // A write lands after the first page: the listing is the lineage as the first page saw it.
  let writes = 1;
  const appended = afterHistory(h, (body) => {
    if (body.before === undefined && writes > 0) {
      writes -= 1;
      edits(h.host, h.id, 1);
    }
  });
  const kept = JSON.parse(await history(h, [h.id, "--limit", "0", "--json"], appended)) as { count: number; versions: { seq: number }[] };
  assert.equal(kept.count, 151);
  assert.deepEqual(kept.versions.map((row) => row.seq), Array.from({ length: 151 }, (_, index) => 151 - index));
  assert.equal(historyRequests(h.host).length, 3, "no restart");

  // Deleted and recreated after the first page: the rows from the old lineage are never merged in.
  h.host.requests.length = 0;
  let recreated = false;
  const recreate = afterHistory(h, (body) => {
    if (body.before === undefined && !recreated) {
      recreated = true;
      h.host.remove(h.id);
      edits(h.host, h.id, 120);
    }
  });
  const fresh = JSON.parse(await history(h, [h.id, "--limit", "0", "--json"], recreate)) as { count: number; versions: { seq: number; version: string }[] };
  assert.equal(fresh.count, 120);
  assert.deepEqual(fresh.versions.map((row) => row.version), [...h.host.histories.get(h.id)!].reverse().map((row) => row.version));
  assert.deepEqual(
    historyRequests(h.host).map(({ limit, before }) => [limit, before]),
    [
      [100, undefined],
      [100, 53],
      [1, 153],
      [100, undefined],
      [100, 21],
      [1, 121],
    ],
  );

  // A lineage replaced after every first page: refused, retryable, after the attempts.
  const churn = afterHistory(h, (body) => {
    if (body.before === undefined && body.limit === 100) {
      h.host.remove(h.id);
      edits(h.host, h.id, 120);
    }
  });
  const error = await rejects(() => history(h, [h.id, "--limit", "0"], churn));
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
  const ceilingHelp = new RegExp(`^showing the newest ${HOSTED_HISTORY_CEILING} of ${HOSTED_HISTORY_CEILING + 5} — a listing stops at ${HOSTED_HISTORY_CEILING}`);
  assert.match((record.help as string[])[0]!, ceilingHelp);
  assert.equal(historyRequests(h.host).length, HOSTED_HISTORY_CEILING / 100 + 1);
  // A --limit above the ceiling is held to it, with the same help.
  h.host.requests.length = 0;
  const above = await historyJson(h, [h.id, "--limit", String(HOSTED_HISTORY_CEILING * 2)]);
  assert.deepEqual([above.count, above.shown, (above.versions as unknown[]).length], [HOSTED_HISTORY_CEILING + 5, HOSTED_HISTORY_CEILING, HOSTED_HISTORY_CEILING]);
  assert.match((above.help as string[])[0]!, ceilingHelp);
  assert.equal(historyRequests(h.host).length, HOSTED_HISTORY_CEILING / 100 + 1);
});

test("--seq shows that version as a record with a bounded body preview; with --json, its row and the whole content", async () => {
  const h = await harness();
  edits(h.host, h.id, 2);
  const [first, second] = h.host.histories.get(h.id)!;
  const shown = decode((await history(h, [h.id, "--seq", "1"])).trim()) as Record<string, unknown>;
  const parsed = parseMarkdown(first!.raw);
  assert.deepEqual(shown, { id: h.id, seq: 1, version: first!.version, actor: first!.actor, timestamp: first!.timestamp, frontmatter: parsed.frontmatter, body: parsed.body });
  assert.deepEqual(historyRequests(h.host).at(-1), { bundleId: BUNDLE, documentId: h.id, limit: 1, before: 2, includeContent: true });
  // A long body is a preview, never the whole body, and the record names the complete channel.
  h.host.put(h.id, { type: "Note" }, "x".repeat(BODY_PREVIEW_LIMIT * 3));
  const long = decode((await history(h, [h.id, "--seq", "4"])).trim()) as Record<string, unknown>;
  assert.equal(long.body, undefined);
  assert.equal(long.body_truncated, true);
  assert.equal(long.body_chars, parseMarkdown(h.host.histories.get(h.id)!.at(-1)!.raw).body.length);
  assert.ok((long.body_preview as string).length < BODY_PREVIEW_LIMIT * 2);
  assert.deepEqual(long.help, [`${cliInvocation()} doc history ${h.id} --seq 4 --json`]);
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
  // Any other 404 is the host's refusal, not a missing route.
  const h2 = await harness();
  const otherNotFound = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/history") ? Response.json({ error: { code: "bundle_not_found" } }, { status: 404 }) : h2.host.fetch(input, init)) as typeof fetch;
  const refused = await rejects(() => history(h2, [h2.id], otherNotFound));
  assert.notEqual(refused.code, "NOT_IMPLEMENTED");
});

test("a bundle the host no longer serves is the checkout's conflict, as sync reports it; other refusals go through the hosted translation", async () => {
  const h = await harness();
  const refusing = (code: string, retryable = false) =>
    (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/history")
        ? Response.json({ ok: false, operationId: "documents.history.v1", error: { code, message: code, retryable } })
        : h.host.fetch(input, init)) as typeof fetch;
  const gone = await rejects(() => history(h, [h.id], refusing("bundle_not_found")));
  assert.equal(gone.code, "CONFLICT");
  assert.equal(gone.details?.reason, "bundle_deleted_remotely");
  assert.equal((await rejects(() => history(h, [h.id], refusing("insufficient_scope")))).code, "FORBIDDEN");
  assert.equal((await rejects(() => history(h, [h.id], refusing("backend_unavailable", true)))).code, "TRANSIENT");
  const large = await rejects(() => history(h, [h.id], refusing("result_too_large")));
  assert.equal(large.code, "RUNTIME");
  assert.match(large.help ?? "", /--limit 10/);
  const largeVersion = await rejects(() => history(h, [h.id, "--seq", "1"], refusing("result_too_large")));
  assert.match(largeVersion.help ?? "", /doc read/);
});

test("an explicit --remote wins over the checkout's binding: the remote path runs and no request reaches the checkout's host", async () => {
  const h = await harness();
  const deps = { stdout: () => {}, hosted: { auth: h.auth, fetch: h.host.fetch } };
  // Inside the checkout, without --dir: the binding would be found, and --remote still decides.
  const cwd = process.cwd();
  process.chdir(h.folder);
  try {
    const remote = await rejects(() => doc(["history", h.id, "--remote", "http://127.0.0.1:9"], deps));
    assert.equal(remote.code, "RUNTIME");
    assert.match(remote.message, /could not reach the remote bundle at http:\/\/127\.0\.0\.1:9/);
    assert.deepEqual(h.host.requests, []);
    // The same folder without --remote reads the checkout's host.
    const out: string[] = [];
    await doc(["history", h.id, "--json"], { ...deps, stdout: (text) => void out.push(text) });
    assert.equal((JSON.parse(out.join("")) as { count: number }).count, 1);
    assert.ok(historyRequests(h.host).length > 0);
  } finally {
    process.chdir(cwd);
  }
  // --remote with --dir is the command's own usage refusal, before either is read.
  h.host.requests.length = 0;
  const both = await rejects(() => doc(["history", h.id, "--remote", "http://127.0.0.1:9", "--dir", h.folder], deps));
  assert.equal(both.code, "USAGE");
  assert.match(both.message, /--remote and --dir are mutually exclusive/);
  assert.deepEqual(h.host.requests, []);
});

test("a document the host lists no versions for says so, with a help line", async () => {
  const h = await harness();
  h.host.histories.set(h.id, []);
  const record = await historyJson(h, [h.id]);
  assert.deepEqual(record, {
    id: h.id,
    count: 0,
    versions: [],
    help: [`the host lists no versions for '${h.id}' (imported history is not served yet); its current version is \`${cliInvocation()} doc read ${h.id}\``],
  });
});

test("a document the host does not have is the definitive empty state, as a local bundle answers it", async () => {
  const h = await harness();
  const record = await historyJson(h, ["notes/never-sent"]);
  assert.equal(record.count, 0);
  assert.deepEqual(record.versions, []);
  const help = record.help as string[];
  assert.match(help[0]!, /no version history for 'notes\/never-sent' on https:\/\/hosted\.example/);
  assert.equal(help[1], `${cliInvocation()} sync --dir ${h.folder}`);
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
