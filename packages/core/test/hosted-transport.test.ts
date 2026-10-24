/**
 * `@superbee/core/hosted-transport` against hosted's golden exchanges: each fixture under
 * `fixtures/hosted-transport/` is one request and the exact answer a hosted route emitted, and
 * `index.json` names the answer row it belongs to. Every write and outcome fixture must land on
 * the row it names, every read fixture must decode or refuse as its row says, and the
 * whole-document transport must reach the shared primitive's outcome for each answer.
 *
 * The fixtures are copied verbatim from Holaxis-ai/superbee-hosted (see FIXTURE_SOURCE) until the
 * hosted browser imports this module; then hosted runs these rows against its own encoders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readHistoryListing,
  type HostedHistoryAnswer,
  type HostedHistoryRequest,
  type HostedHistoryVersion,
  classifyWriteAnswer,
  createFetchCarrier,
  createHostedReadAdapter,
  createWholeDocumentTransport,
  decodeHeadsPage,
  decodeHostedCapabilities,
  HeadsPages,
  isPageRestart,
  isSnapshotRestart,
  PAGE_RESTART_DELAYS_MS,
  retrySnapshotRestarts,
  SNAPSHOT_RESTART_ATTEMPTS,
  decodeOutcomeAnswer,
  capacityScopeOf,
  HostedCarrierError,
  HostedOutcomeError,
  isAgentLabelVia,
  OUTCOME_ANSWER_ROWS,
  READ_ANSWER_ROWS,
  UPDATE_ANSWER_ROWS,
  wholeDocumentRequest,
  HOSTED_MANAGED_FIELDS,
  IMPORT_CARRIED_FIELDS,
  IMPORT_DROPPED_FIELDS,
  WHOLE_DOCUMENT_SETTLEMENT,
  WholeDocumentInputError,
  type HostedAnswer,
  type HostedCarrier,
  type HostedRequestOptions,
  type HostedStream,
  classifyRootAnswer,
  rootLanding,
  rootVersionOf,
  rootWriteRequest,
  RootWriteInputError,
  ROOT_OPERATION_ID,
  sendRootWrite,
} from "../src/hosted-transport/index.js";
import { RemoteError } from "../src/remote-error.js";
import { SNAPSHOT_TRUNCATED } from "../src/remote-parsers.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { LOOKUP_PENDING, isAuthorizationRefusal, performUncertainWrite, type OperationIntent, type Outcome } from "../src/uncertain-write.js";
import { versionOfBytes } from "../src/versioning.js";

/** The hosted commit the fixtures were copied from. */
const FIXTURE_SOURCE = "Holaxis-ai/superbee-hosted PR 605 head 52d1fc97 (test/fixtures/hosted-transport)";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-transport");

interface Exchange {
  name: string;
  rows: string[];
  route: string;
  request: { method: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
}

const index = JSON.parse(readFileSync(path.join(FIXTURES, "index.json"), "utf8")) as { exchanges: { name: string; file: string; route: string; rows: string[]; status: number }[] };
const exchanges = new Map<string, Exchange>(index.exchanges.map((entry) => [entry.name, JSON.parse(readFileSync(path.join(FIXTURES, entry.file), "utf8")) as Exchange]));
const fixture = (name: string): Exchange => exchanges.get(name) ?? assert.fail(`no fixture ${name}`);

function answerOf(exchange: Exchange, rewrite: (body: string) => string = (body) => body): HostedAnswer {
  const body = rewrite(exchange.response.body);
  return { status: exchange.response.status, headers: new Headers(exchange.response.headers), body: body === "" ? undefined : JSON.parse(body) };
}

function streamOf(exchange: Exchange): HostedStream {
  const headers = new Headers(exchange.response.headers);
  if (exchange.response.status !== 200) return { status: exchange.response.status, headers, ok: false, body: JSON.parse(exchange.response.body) };
  const bytes = new TextEncoder().encode(exchange.response.body);
  return { status: 200, headers, ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

const tableFor = (route: string): readonly { answer: string }[] =>
  route === "/editor/update" ? UPDATE_ANSWER_ROWS : route === "/editor/outcome" ? OUTCOME_ANSWER_ROWS : READ_ANSWER_ROWS;

// ── the index ──────────────────────────────────────────────────────────────────────────────

test(`golden fixtures (${FIXTURE_SOURCE}): every exchange names rows the shared tables hold, and every read row is exercised`, () => {
  assert.equal(index.exchanges.length, 33);
  for (const entry of index.exchanges) {
    const exchange = fixture(entry.name);
    assert.equal(exchange.name, entry.name);
    assert.equal(exchange.route, entry.route);
    assert.equal(exchange.response.status, entry.status);
    assert.deepEqual(exchange.rows, entry.rows);
    const table = tableFor(entry.route).map((row) => row.answer);
    for (const row of entry.rows) assert.ok(table.includes(row), `${entry.name} names '${row}', which ${entry.route}'s table lacks`);
  }
  const named = new Set(index.exchanges.flatMap((entry) => entry.rows));
  for (const row of READ_ANSWER_ROWS) assert.ok(named.has(row.answer), `read row '${row.answer}' has no golden exchange`);
});

// ── identified-write answers ───────────────────────────────────────────────────────────────

for (const entry of index.exchanges.filter((candidate) => candidate.route === "/editor/update")) {
  test(`write answer row: ${entry.name} is '${entry.rows.join("' / '")}'`, () => {
    const exchange = fixture(entry.name);
    const request = JSON.parse(exchange.request.body) as { bundleId: string; documentId: string };
    const { row, result } = classifyWriteAnswer(answerOf(exchange), { operationIds: ["documents.update.v1"], documentId: request.documentId, bundleId: request.bundleId });
    assert.ok(entry.rows.includes(row.answer), `classified as '${row.answer}'`);
    if (row.answer.startsWith("200 ")) assert.ok(result, "a 200 answer carries its validated envelope");
  });
}

test("write answer rows: an envelope for another operation, document or bundle is '200 other', never a receipt", () => {
  const ok = fixture("update-200-ok");
  for (const expected of [
    { operationIds: ["documents.replace.v1"], documentId: "notes/alpha", bundleId: "team.knowledge" },
    { operationIds: ["documents.update.v1"], documentId: "notes/beta", bundleId: "team.knowledge" },
    { operationIds: ["documents.update.v1"], documentId: "notes/alpha", bundleId: "other.bundle" },
  ]) assert.equal(classifyWriteAnswer(answerOf(ok), expected).row.answer, "200 other");
  const unknownButNotApplied = answerOf(fixture("update-200-write-outcome-unknown"), (body) => body.replace('"writeState":"unknown"', '"writeState":"not_applied"'));
  assert.equal(classifyWriteAnswer(unknownButNotApplied, { operationIds: ["documents.update.v1"], documentId: "notes/alpha" }).row.answer, "200 other");
});

// ── outcome answers ────────────────────────────────────────────────────────────────────────

for (const entry of index.exchanges.filter((candidate) => candidate.route === "/editor/outcome" && candidate.status === 200)) {
  test(`outcome answer: ${entry.name} decodes as its row`, () => {
    const exchange = fixture(entry.name);
    const request = JSON.parse(exchange.request.body) as { bundleId: string; documentId: string };
    const decoded = decodeOutcomeAnswer(answerOf(exchange).body, {
      requestId: exchange.request.headers["x-superbee-write-request"]!,
      binding: exchange.request.headers["x-superbee-recovery-target"]!,
      bundleId: request.bundleId,
      documentId: request.documentId,
      operationIds: ["documents.update.v1"],
    });
    assert.ok(entry.rows.some((row) => row === `200 ${decoded.status}` || row.startsWith(`200 ${decoded.status} `)));
    if (decoded.status === "committed") assert.equal(versionOfBytes(new TextDecoder().decode(decoded.content.bytes)), decoded.content.version);
  });
}

test("outcome answer: another identity or binding, or a refused result that is not definitive, is malformed evidence", () => {
  const exchange = fixture("outcome-200-committed");
  const expected = { requestId: exchange.request.headers["x-superbee-write-request"]!, binding: exchange.request.headers["x-superbee-recovery-target"]!, bundleId: "team.knowledge", documentId: "notes/alpha", operationIds: ["documents.update.v1"] };
  const body = answerOf(exchange).body;
  for (const wrong of [{ ...expected, requestId: "00000000-0000-4000-8000-000000000000" }, { ...expected, binding: "sha256:" + "c".repeat(64) }, { ...expected, documentId: "notes/beta" }]) {
    assert.throws(() => decodeOutcomeAnswer(body, wrong), (error: unknown) => error instanceof HostedOutcomeError && error.reason === "malformed");
  }
  const refused = answerOf(fixture("outcome-200-refused"), (text) => text.replace('"writeState":"not_applied"', '"writeState":"unknown"')).body;
  assert.throws(() => decodeOutcomeAnswer(refused, expected), HostedOutcomeError);
});

// ── read routes ────────────────────────────────────────────────────────────────────────────

/** A carrier that answers each route from a queue of golden exchanges and records every request. */
function replayCarrier(script: Record<string, (Exchange | ((input: unknown, options?: HostedRequestOptions) => HostedAnswer))[]>, rewrite?: (body: string) => string) {
  const requests: { path: string; input: unknown; options?: HostedRequestOptions }[] = [];
  const next = (routePath: string) => {
    const queue = script[routePath];
    if (!queue || queue.length === 0) assert.fail(`unexpected request to ${routePath}`);
    return queue.shift()!;
  };
  const carrier: HostedCarrier = {
    async json(routePath, input, _signal, options) {
      requests.push({ path: routePath, input, options });
      const entry = next(routePath);
      return typeof entry === "function" ? entry(input, options) : answerOf(entry, rewrite);
    },
    async stream(routePath, input) {
      requests.push({ path: routePath, input });
      const entry = next(routePath);
      return streamOf(entry as Exchange);
    },
  };
  return { carrier, requests };
}

test("read rows: capabilities decode with and without operations and a root; heads 200, 304 and the empty bundle; the root version drops a held answer", async () => {
  const { carrier, requests } = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-operations"), fixture("capabilities-read-only")],
    "/reader/heads": [fixture("heads-200"), fixture("heads-304"), fixture("heads-empty-no-root")],
  });
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  const capabilities = await adapter.hostedCapabilities();
  assert.equal(capabilities.operations, true);
  assert.equal(capabilities.operationsRetentionMs, 2_592_000_000);
  assert.equal((await adapter.readReserved("", "index.md"))!.version, capabilities.root!.version);
  assert.deepEqual(await adapter.wireCapabilities(), { heads: true, snapshot: true, operations: true, history: true, enforced_cas: true, projections: true, backlinks: false, blobs: false });

  const heads = await adapter.heads();
  assert.equal(heads!.heads.length, 3);
  assert.equal(await adapter.heads({ ifNoneMatch: heads!.digest }), null);
  // The held answer's root is still current after both answers: no second capabilities read yet.
  assert.equal(requests.filter((request) => request.path === "/reader/capabilities").length, 1);

  const empty = await adapter.heads();
  assert.deepEqual(empty, { digest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", heads: [] });
  // The empty bundle states no root, which the held answer contradicts, so the next read asks again.
  const again = await adapter.hostedCapabilities();
  assert.equal(again.root, null);
  assert.equal(again.operations, false);
  assert.equal(requests.filter((request) => request.path === "/reader/capabilities").length, 2);
});

test("read rows: a complete snapshot streams every document; a truncated one fails as truncation", async () => {
  const { carrier } = replayCarrier({ "/reader/snapshot": [fixture("snapshot-complete"), fixture("snapshot-truncated")] });
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  const complete = await adapter.snapshot();
  const ids: string[] = [];
  for await (const doc of complete.docs) ids.push(doc.id);
  assert.deepEqual(ids, ["notes/alpha", "notes/beta", "projects/2026/plan"]);
  const truncated = await adapter.snapshot();
  await assert.rejects(async () => { for await (const _ of truncated.docs) void _; }, (error: unknown) => error instanceof RemoteError && error.code === SNAPSHOT_TRUNCATED);
});

for (const [name, expected] of [
  ["refusal-bundle-not-found", { code: "bundle_not_found", status: 404 }],
  ["refusal-result-too-large", { code: "result_too_large", status: 422 }],
  ["refusal-validation-failed", { code: "validation_failed", status: 422 }],
  ["refusal-invalid-input", { code: "invalid_input", status: 400 }],
  ["refusal-unauthenticated", { code: "unauthenticated", status: 401 }],
  ["refusal-backend-unavailable", "offline"],
] as const) {
  test(`read rows: ${name} is ${expected === "offline" ? "a carrier failure, not an authority answer" : `the authority's ${expected.status} ${expected.code}`}`, async () => {
    const exchange = fixture(name);
    const { carrier } = replayCarrier({ [exchange.route]: [exchange] });
    const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
    const call = exchange.route === "/reader/snapshot" ? adapter.snapshot() : adapter.heads();
    await assert.rejects(call, (error: unknown) =>
      expected === "offline"
        ? error instanceof HostedCarrierError && error.code === "unavailable"
        : error instanceof RemoteError && error.code === expected.code && error.status === expected.status);
  });
}

// ── pages ──────────────────────────────────────────────────────────────────────────────────

/** A capabilities answer without the paged bound: a host from before paging. */
const unpaged = (body: string) => body.replace(/,"paged":\{"documents":\d+\}/, "");
const cursorOf = (name: string): string => (JSON.parse(fixture(name).request.body) as { cursor: string }).cursor;

test("pages: a paged host's heads pages assemble into the unpaged listing, one request per page", async () => {
  assert.doesNotMatch(unpaged(fixture("capabilities-read-only").response.body), /paged/);
  const { carrier, requests } = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-read-only")],
    "/reader/heads": [fixture("heads-page-first"), fixture("heads-page-last")],
  });
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  assert.deepEqual((await adapter.hostedCapabilities()).paged, { documents: 10_000 });
  const heads = await adapter.heads();
  const whole = JSON.parse(fixture("heads-200").response.body) as { digest: string; heads: unknown[] };
  assert.deepEqual(heads, { digest: whole.digest, heads: whole.heads });
  assert.deepEqual(requests.filter((request) => request.path === "/reader/heads").map((request) => request.input), [
    { bundleId: "team.knowledge" },
    { bundleId: "team.knowledge", cursor: cursorOf("heads-page-last") },
  ]);
});

test("pages: a paged host's snapshot pages stitch into the unpaged body's documents", async () => {
  const { carrier, requests } = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-read-only")],
    "/reader/snapshot": [fixture("snapshot-page-first"), fixture("snapshot-page-last")],
  });
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  const snapshot = await adapter.snapshot();
  const expected = fixture("snapshot-complete").response.body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(snapshot.header, { count: expected[0]!.count, digest: expected[0]!.digest });
  const docs = [];
  for await (const doc of snapshot.docs) docs.push({ kind: "doc", ...doc });
  assert.deepEqual(docs, expected.slice(1, -1));
  assert.deepEqual(requests.filter((request) => request.path === "/reader/snapshot").map((request) => request.input), [
    { bundleId: "team.knowledge" },
    { bundleId: "team.knowledge", cursor: cursorOf("snapshot-page-last") },
  ]);
});

test("pages: a restart refusal starts heads again from the first page, and stands after three attempts", async () => {
  const restarted = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-operations")],
    "/reader/heads": [fixture("heads-page-first"), fixture("refusal-concurrent-change"), fixture("heads-page-first"), fixture("heads-page-last")],
  });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const adapter = createHostedReadAdapter({ carrier: restarted.carrier, bundleId: "team.knowledge", sleep });
  await adapter.hostedCapabilities();
  assert.equal((await adapter.heads())!.heads.length, 3);
  // One pause before the restart: about a quarter second, jittered to half of it or more.
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! >= PAGE_RESTART_DELAYS_MS[0]! / 2 && sleeps[0]! <= PAGE_RESTART_DELAYS_MS[0]!);
  assert.deepEqual(restarted.requests.filter((request) => request.path === "/reader/heads").map((request) => (request.input as { cursor?: unknown }).cursor === undefined), [true, false, true, false]);
  // The restart says nothing about the caller: the held answer stands and is not read again.
  assert.equal(restarted.requests.filter((request) => request.path === "/reader/capabilities").length, 1);
  const moving = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-operations")],
    "/reader/heads": Array.from({ length: 3 }, () => [fixture("heads-page-first"), fixture("refusal-concurrent-change")]).flat(),
  });
  const movingSleeps: number[] = [];
  await assert.rejects(createHostedReadAdapter({ carrier: moving.carrier, bundleId: "team.knowledge", sleep: async (ms) => { movingSleeps.push(ms); } }).heads(), (error: unknown) => isPageRestart(error));
  assert.equal(movingSleeps.length, 2, "a pause before each of the two restarts, none after the last refusal");
  assert.ok(movingSleeps[1]! >= PAGE_RESTART_DELAYS_MS[1]! / 2);
  // An abort during the pause ends the listing as the carrier's failure.
  const aborted = replayCarrier({ "/reader/heads": [fixture("heads-page-first"), fixture("refusal-concurrent-change")] });
  const stopping = createHostedReadAdapter({ carrier: aborted.carrier, bundleId: "team.knowledge", sleep: async () => { stopping.abort(); throw new Error("aborted"); } });
  await assert.rejects(stopping.heads(), (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");
});

test("pages: a root that moved between heads pages drops the held answer and the listing stands", async () => {
  const moved = (body: string) => body;
  const last = fixture("heads-page-last");
  const { carrier, requests } = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-operations"), fixture("capabilities-read-only")],
    "/reader/heads": [fixture("heads-page-first"), { ...last, response: { ...last.response, headers: { ...last.response.headers, "x-superbee-root-version": "none" } } }],
  }, moved);
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  await adapter.hostedCapabilities();
  assert.equal((await adapter.heads())!.heads.length, 3);
  assert.equal((await adapter.hostedCapabilities()).root, null);
  assert.equal(requests.filter((request) => request.path === "/reader/capabilities").length, 2);
});

test("pages: a snapshot consumer runs again after a restart truncation, a bounded number of times", async () => {
  const restartTruncation = new RemoteError("cut", SNAPSHOT_TRUNCATED, 200, new RemoteError("moved", "concurrent_change", 409));
  assert.equal(isSnapshotRestart(restartTruncation), true);
  assert.equal(isSnapshotRestart(new RemoteError("cut", SNAPSHOT_TRUNCATED, 200)), false);
  const sleeps: number[] = [];
  let runs = 0;
  assert.equal(await retrySnapshotRestarts(async () => { if (++runs < 3) throw restartTruncation; return "done"; }, { signal: new AbortController().signal, sleep: async (ms) => { sleeps.push(ms); } }), "done");
  assert.equal(runs, 3);
  assert.equal(sleeps.length, 2);
  runs = 0;
  await assert.rejects(retrySnapshotRestarts(async () => { runs += 1; throw restartTruncation; }, { signal: new AbortController().signal, sleep: async () => {} }), (error: unknown) => error === restartTruncation);
  assert.equal(runs, SNAPSHOT_RESTART_ATTEMPTS);
  // The adapter's own snapshot truncation after a refused later page is a restart truncation.
  const { carrier } = replayCarrier({ "/reader/snapshot": [fixture("snapshot-page-first"), fixture("refusal-concurrent-change")] });
  const snapshot = await createHostedReadAdapter({ carrier, bundleId: "team.knowledge" }).snapshot();
  await assert.rejects(async () => { for await (const _ of snapshot.docs) void _; }, (error: unknown) => isSnapshotRestart(error));
});

test("pages: a snapshot whose later page is refused, cut or contradicts the first ends as truncation", async () => {
  const lastWithHeader = (header: Record<string, unknown>) => (body: string) => {
    const lines = body.split("\n");
    return [JSON.stringify(header), ...lines.slice(1)].join("\n");
  };
  const first = JSON.parse(fixture("snapshot-page-first").response.body.split("\n")[0]!) as Record<string, unknown>;
  const cases: [string, Exchange | HostedStream][] = [
    ["a restart refusal", fixture("refusal-concurrent-change")],
    ["a cut page", fixture("snapshot-truncated")],
    ["a header for another listing", { ...fixture("snapshot-page-last"), response: { ...fixture("snapshot-page-last").response, body: lastWithHeader({ ...first, count: 4 })(fixture("snapshot-page-last").response.body) } }],
  ];
  for (const [why, second] of cases) {
    const { carrier } = replayCarrier({
      "/reader/capabilities": [fixture("capabilities-read-only")],
      "/reader/snapshot": [fixture("snapshot-page-first"), second as Exchange],
    });
    const snapshot = await createHostedReadAdapter({ carrier, bundleId: "team.knowledge" }).snapshot();
    const ids: string[] = [];
    await assert.rejects(async () => { for await (const doc of snapshot.docs) ids.push(doc.id); }, (error: unknown) => error instanceof RemoteError && error.code === SNAPSHOT_TRUNCATED, why);
    assert.deepEqual(ids, ["notes/alpha", "notes/beta"], why);
  }
  // A first page the host refuses is the snapshot's own refusal.
  const { carrier } = replayCarrier({ "/reader/capabilities": [fixture("capabilities-read-only")], "/reader/snapshot": [fixture("refusal-concurrent-change")] });
  await assert.rejects(createHostedReadAdapter({ carrier, bundleId: "team.knowledge" }).snapshot(), (error: unknown) => isPageRestart(error));
});

test("pages: heads pages that disagree, repeat a row or stall are malformed, never diffed", () => {
  const page = decodeHeadsPage(JSON.parse(fixture("heads-page-first").response.body));
  const last = decodeHeadsPage(JSON.parse(fixture("heads-page-last").response.body));
  const other = { ...last, digest: "sha256:" + "0".repeat(64) };
  for (const [why, pages] of [
    ["another digest", [page, other]],
    ["a repeated row", [page, { ...last, heads: [page.heads[1]!, ...last.heads] }]],
    ["an empty page that names a next", [{ ...page, heads: [] }]],
    ["more rows than the count", [page, { ...last, heads: [...last.heads, { id: "zz", version: last.heads[0]!.version }] }]],
  ] as const) {
    const collected = new HeadsPages();
    assert.throws(() => { for (const each of pages) collected.add(each); }, (error: unknown) => error instanceof RemoteError && error.status === 502, why);
  }
  for (const body of [{ ...JSON.parse(fixture("heads-page-first").response.body), next: "" }, { count: -1, digest: page.digest, heads: [] }, []])
    assert.throws(() => decodeHeadsPage(body), (error: unknown) => error instanceof RemoteError && error.status === 502);
});

test("pages: a bundle within one page is read with the one request a host from before paging answers", async () => {
  const { carrier, requests } = replayCarrier({
    "/reader/capabilities": [fixture("capabilities-read-only")],
    "/reader/heads": [fixture("heads-200")],
    "/reader/snapshot": [fixture("snapshot-complete")],
  }, unpaged);
  const adapter = createHostedReadAdapter({ carrier, bundleId: "team.knowledge" });
  assert.equal((await adapter.hostedCapabilities()).paged, null);
  assert.equal((await adapter.heads())!.heads.length, 3);
  const snapshot = await adapter.snapshot();
  for await (const _ of snapshot.docs) void _;
  assert.deepEqual(requests.filter((request) => request.path !== "/reader/capabilities").map((request) => request.input), [{ bundleId: "team.knowledge" }, { bundleId: "team.knowledge" }]);
  assert.throws(() => decodeHostedCapabilities({ ...JSON.parse(fixture("capabilities-read-only").response.body), paged: { documents: 10 } }), RemoteError, "a paged bound below one page");
});

// ── the whole-document transport ───────────────────────────────────────────────────────────

const REQUEST_ID = "4a2f9c1e-8b3d-4e6f-9a1b-2c3d4e5f6a7b";
const BINDING = "sha256:" + "b".repeat(64);
const BASE = "sha256:" + "a".repeat(64);
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const toReplace = (body: string) => body.replaceAll('"documents.update.v1"', '"documents.replace.v1"');
const toCreate = (body: string) => body.replaceAll('"documents.update.v1"', '"documents.create.v1"');

function intentOf(base: string | null, frontmatter: Record<string, unknown> = { type: "Note", title: "Alpha", timestamp: "2026-09-01T00:00:00.000Z", actor: "someone" }, body = "Alpha body changed é\r\n"): OperationIntent {
  const content = stringifyDoc(frontmatter as never, body);
  return { requestId: REQUEST_ID, kind: "document.write", target: "notes/alpha", base, local: versionOfBytes(content), content, createdAt: new Date(NOW - 60_000).toISOString(), attempts: 0, state: "pending" };
}

function transportOver(script: Parameters<typeof replayCarrier>[0], intent: OperationIntent, options: { rewrite?: (body: string) => string; headVersion?: string; now?: number } = {}) {
  const replay = replayCarrier(script, options.rewrite ?? (intent.base === null ? toCreate : toReplace));
  const reads: string[] = [];
  const transport = createWholeDocumentTransport({
    carrier: replay.carrier,
    bundleId: "team.knowledge",
    binding: BINDING,
    intentFor: async (id) => (id === intent.requestId ? intent : undefined),
    remote: {
      async read(id) {
        reads.push(id);
        if (!options.headVersion) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { doc: { id, frontmatter: { type: "Note" }, body: "" }, version: options.headVersion };
      },
      operationsRetentionMs: async () => 2_592_000_000,
    },
    now: () => options.now ?? NOW,
  });
  const deliver = (candidate = intent) => performUncertainWrite(transport, candidate, { settlement: transport.settlement, sleep: async () => {}, lookupDelayMs: 0 });
  return { transport, deliver, reads, requests: replay.requests };
}

test("whole-document request: a base makes a replace against it, no base a create-only write, managed fields never leave", () => {
  const replace = wholeDocumentRequest("team.knowledge", intentOf(BASE));
  assert.equal(replace.kind, "replace");
  assert.deepEqual(replace.payload, { bundleId: "team.knowledge", documentId: "notes/alpha", frontmatter: { type: "Note", title: "Alpha" }, body: "Alpha body changed é\r\n", expectedVersion: BASE });
  const create = wholeDocumentRequest("team.knowledge", intentOf(null));
  assert.deepEqual(create, { kind: "create", operationId: "documents.create.v1", payload: { bundleId: "team.knowledge", documentId: "notes/alpha", expectAbsent: true, frontmatter: { type: "Note", title: "Alpha" }, body: "Alpha body changed é\r\n" } });
  assert.equal(WHOLE_DOCUMENT_SETTLEMENT, "recorded-only");
});

test("whole-document transport: a committed replace carries one identity and binding to the write route, answered by the host's version", async () => {
  const intent = intentOf(BASE);
  const { deliver, requests } = transportOver({ "/sync/v1/replace": [fixture("update-200-ok")] }, intent);
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "committed", version: "sha256:e83157678e87513662c069849c1ff1095c24189bfc5207b5a37f9243413eac6f" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.options!.writeRequest, REQUEST_ID);
  assert.equal(requests[0]!.options!.binding, BINDING);
});

test("whole-document transport: a recorded version conflict without a current version is a conflict against the served head, never a commit", async () => {
  const intent = intentOf(BASE);
  const head = "sha256:" + "d".repeat(64);
  const { deliver, reads } = transportOver({ "/sync/v1/replace": [fixture("update-200-version-conflict")] }, intent, { headVersion: head });
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: head });
  assert.deepEqual(reads, ["notes/alpha"]);
  // Even a head equal to the intent's own local bytes stays a conflict under recorded-only settlement.
  const same = transportOver({ "/sync/v1/replace": [fixture("update-200-version-conflict")] }, intent, { headVersion: intent.local });
  assert.deepEqual((await same.deliver()).outcome, { kind: "conflict", actual: intent.local });
});

test("whole-document transport: an unsettled transient refusal is settled by one lookup with the same body, identity and binding", async () => {
  const intent = intentOf(BASE);
  const { deliver, requests } = transportOver({ "/sync/v1/replace": [fixture("update-200-backend-unavailable-unsettled")], "/sync/v1/outcome": [fixture("outcome-200-refused")] }, intent, { headVersion: "sha256:" + "e".repeat(64) });
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: "sha256:" + "e".repeat(64) });
  assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/replace", "/sync/v1/outcome"]);
  assert.deepEqual(requests[1]!.input, requests[0]!.input);
  assert.deepEqual(requests[1]!.options, { maximum: 2 * 1024 * 1024, writeRequest: REQUEST_ID, binding: BINDING });
});

test("whole-document transport: a settled busy refusal settles from the answer only when it says not_applied; one whose write state is unknown is looked up", async () => {
  const intent = intentOf(BASE);
  const busy = (code: string, writeState: string) => (): HostedAnswer => ({
    status: 200,
    headers: new Headers({ "x-superbee-write-settled": REQUEST_ID }),
    body: { ok: false, operationId: "documents.replace.v1", error: { code, message: "busy", retryable: false, writeState } },
  });
  const storedUnknown = (code: string) => (): HostedAnswer => ({
    status: 200,
    headers: new Headers(),
    body: { schemaVersion: 1, requestId: REQUEST_ID, binding: BINDING, status: "refused", result: { ok: false, operationId: "documents.replace.v1", error: { code, message: "busy", retryable: false, writeState: "unknown" } } },
  });
  for (const code of ["concurrent_change", "backend_unavailable", "internal_error", "deadline_exceeded", "cancelled"]) {
    const recorded = transportOver({ "/sync/v1/replace": [busy(code, "not_applied")] }, intent);
    assert.deepEqual((await recorded.deliver()).outcome, { kind: "refused", code, message: "busy" }, code);
    assert.deepEqual(recorded.requests.map((request) => request.path), ["/sync/v1/replace"], code);
    // The write may have landed: the lookup decides, and a committed record is a commit, never a refusal.
    const landed = transportOver({ "/sync/v1/replace": [busy(code, "unknown")], "/sync/v1/outcome": [fixture("outcome-200-committed")] }, intent);
    const result = await landed.deliver();
    assert.equal(result.outcome.kind, "committed", code);
    assert.deepEqual(landed.requests.map((request) => request.path), ["/sync/v1/replace", "/sync/v1/outcome"], code);
    // A stored refusal that is not definitive is no evidence: unknown, never refused.
    const vague = transportOver({ "/sync/v1/replace": [busy(code, "unknown")], "/sync/v1/outcome": [storedUnknown(code), storedUnknown(code), storedUnknown(code)] }, intent);
    assert.deepEqual((await vague.deliver()).outcome, { kind: "unknown" }, code);
  }
});

for (const name of ["update-200-write-outcome-unknown", "update-401-write-outcome-unknown", "update-503-write-outcome-unknown"]) {
  test(`whole-document transport: ${name} may have applied, so the primitive looks it up and settles from the recorded result`, async () => {
    const intent = intentOf(BASE);
    const { deliver, requests } = transportOver({ "/sync/v1/replace": [fixture(name)], "/sync/v1/outcome": [fixture("outcome-200-committed")] }, intent);
    const result = await deliver();
    assert.deepEqual(result.outcome, { kind: "committed", version: "sha256:e83157678e87513662c069849c1ff1095c24189bfc5207b5a37f9243413eac6f" });
    assert.equal(result.lookups, 1);
    assert.equal(requests.filter((request) => request.path === "/sync/v1/replace").length, 1);
  });
}

test("whole-document transport: absent within retention allows the one resubmission; absent past retention stays unknown and never resubmits", async () => {
  const intent = intentOf(BASE);
  const fresh = transportOver({ "/sync/v1/replace": [fixture("update-503-write-outcome-unknown"), fixture("update-200-ok")], "/sync/v1/outcome": [fixture("outcome-200-absent")] }, intent);
  const delivered = await fresh.deliver();
  assert.equal(delivered.outcome.kind, "committed");
  assert.equal(delivered.intent.attempts, 2);

  const old = transportOver({ "/sync/v1/replace": [fixture("update-503-write-outcome-unknown")], "/sync/v1/outcome": [fixture("outcome-200-absent")] }, intent, { now: NOW + 2_592_000_000 });
  const expired = await old.deliver();
  assert.deepEqual(expired.outcome, { kind: "unknown" });
  assert.equal(old.requests.filter((request) => request.path === "/sync/v1/replace").length, 1);
});

test("whole-document transport: a pending claim is not evidence either way, and lookup refusals leave the outcome unknown", async () => {
  const intent = intentOf(BASE);
  for (const outcome of ["outcome-400", "outcome-401", "outcome-503"]) {
    const { transport } = transportOver({ "/sync/v1/outcome": [fixture(outcome)] }, intent);
    await assert.rejects(transport.lookup(REQUEST_ID), (error: unknown) => error instanceof HostedOutcomeError && error.reason === "refused" && error.status === fixture(outcome).response.status);
  }
  const { transport } = transportOver({ "/sync/v1/outcome": [fixture("outcome-200-pending")] }, intent);
  // Pending is told apart from absent: a delivery was admitted and may still commit.
  assert.deepEqual(await transport.lookup(REQUEST_ID), LOOKUP_PENDING);
  await assert.rejects(transport.lookup("00000000-0000-4000-8000-000000000000"), HostedOutcomeError);
});

test("whole-document transport: a committed lookup whose result and content disagree is a contradiction, not a commit", async () => {
  const intent = intentOf(BASE);
  const contradiction = (body: string) => toReplace(body).replace(/"changed":true/, '"changed":false');
  const { deliver } = transportOver({ "/sync/v1/replace": [fixture("update-503-write-outcome-unknown")], "/sync/v1/outcome": [fixture("outcome-200-committed"), fixture("outcome-200-committed"), fixture("outcome-200-committed")] }, intent, { rewrite: contradiction });
  assert.deepEqual((await deliver()).outcome, { kind: "unknown" });
});

test("whole-document transport: authorization refusals pause, and a request that was never sent is refused as such", async () => {
  const intent = intentOf(BASE);
  const refused = transportOver({ "/sync/v1/replace": [fixture("update-401-not-applied")] }, intent);
  const outcome = (await refused.deliver()).outcome;
  assert.equal(outcome.kind, "refused");
  assert.ok(isAuthorizationRefusal(outcome));

  const denied: HostedCarrier = { json: async () => { throw new HostedCarrierError("denied"); }, stream: async () => { throw new HostedCarrierError("denied"); } };
  const transport = createWholeDocumentTransport({ carrier: denied, bundleId: "team.knowledge", binding: BINDING, intentFor: async () => intent, remote: { read: async () => assert.fail(), operationsRetentionMs: async () => 1 } });
  const never = await transport.submit(intent);
  assert.ok(isAuthorizationRefusal(never));
  const lost: HostedCarrier = { json: async () => { throw new HostedCarrierError("unavailable"); }, stream: async () => assert.fail() };
  const unknown = createWholeDocumentTransport({ carrier: lost, bundleId: "team.knowledge", binding: BINDING, intentFor: async () => intent, remote: { read: async () => assert.fail(), operationsRetentionMs: async () => 1 } });
  assert.deepEqual(await unknown.submit(intent), { kind: "unknown" });
});

test("whole-document transport: a create that finds the document is a conflict against the served head, settled or not", async () => {
  const intent = intentOf(null);
  const head = "sha256:" + "f".repeat(64);
  const exists = (settled: boolean) => (): HostedAnswer => ({
    status: 200,
    headers: new Headers(settled ? { "x-superbee-write-settled": REQUEST_ID } : {}),
    body: { ok: false, operationId: "documents.create.v1", error: { code: "document_exists", message: "exists", retryable: false, writeState: "not_applied" } },
  });
  for (const settled of [true, false]) {
    const { deliver, requests } = transportOver({ "/sync/v1/create": [exists(settled)] }, intent, { headVersion: head });
    assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: head } satisfies Outcome);
    assert.equal(requests[0]!.path, "/sync/v1/create");
  }
});

test("whole-document transport: frontmatter that is not plain JSON, or a document over the request bound, is refused without sending", async () => {
  let sent = 0;
  const carrier: HostedCarrier = { json: async () => { sent++; return assert.fail(); }, stream: async () => assert.fail() };
  const transport = createWholeDocumentTransport({ carrier, bundleId: "team.knowledge", binding: BINDING, intentFor: async () => undefined, remote: { read: async () => assert.fail(), operationsRetentionMs: async () => 1 } });
  const infinite = intentOf(BASE);
  // YAML reads `.inf` as Infinity, which JSON would silently turn into null.
  infinite.content = "---\ntype: Note\nweight: .inf\n---\nbody\n";
  const outcomes = [await transport.submit(infinite), await transport.submit(intentOf(BASE, { type: "Note" }, "x".repeat(70_000)))];
  for (const outcome of outcomes) assert.equal(outcome.kind === "refused" && outcome.code, "invalid_input");
  assert.equal(sent, 0);
});

const capacityAnswer = (status: 200 | 429, error: Record<string, unknown>) => (): HostedAnswer => ({
  status,
  headers: new Headers(),
  body: status === 200 ? { ok: false, operationId: "documents.replace.v1", error: { message: "quota", retryable: false, writeState: "not_applied", code: "request_capacity", ...error } } : { error: { code: "request_capacity", ...error } },
});

test("whole-document transport: a spent sync quota pauses with its scope, never reads as possibly delivered", async () => {
  const intent = intentOf(BASE);
  for (const [status, scope, code] of [[200, "principal", "REQUEST_CAPACITY_PRINCIPAL"], [429, "bundle", "REQUEST_CAPACITY_BUNDLE"]] as const) {
    const { deliver, requests } = transportOver({ "/sync/v1/replace": [capacityAnswer(status, { scope, resetAt: "2026-09-23T00:00:00.000Z" })] }, intent);
    const result = await deliver();
    assert.equal(result.outcome.kind === "refused" && result.outcome.code, code);
    assert.equal(capacityScopeOf(result.outcome), scope);
    assert.ok(isAuthorizationRefusal(result.outcome), "the shared primitive pauses the store on it");
    assert.match((result.outcome as { message: string }).message, /2026-09-23T00:00:00.000Z/);
    assert.equal(result.intent.state, "refused");
    assert.equal(requests.length, 1, "no lookup and no resubmission");
  }
  // A capacity refusal that names no valid scope is not one the client admits.
  assert.equal(classifyWriteAnswer(capacityAnswer(200, { scope: "tenant" })(), { operationIds: ["documents.replace.v1"], documentId: "notes/alpha" }).row.answer, "200 other");
  assert.equal(classifyWriteAnswer(capacityAnswer(200, {})(), { operationIds: ["documents.replace.v1"], documentId: "notes/alpha" }).row.answer, "200 other");
  assert.equal(capacityScopeOf({ kind: "refused", code: "validation_failed" }), null);
});

test("whole-document transport: a 400 or an unrecorded invalid_input is a terminal refusal, not an unknown to look up", async () => {
  const intent = intentOf(BASE);
  const four = transportOver({ "/sync/v1/replace": [fixture("update-400")] }, intent);
  const refused = await four.deliver();
  assert.deepEqual([refused.outcome.kind, (refused.outcome as { code?: string }).code], ["refused", "invalid_input"]);
  assert.equal(four.requests.length, 1);
  const invalid = (): HostedAnswer => ({ status: 200, headers: new Headers(), body: { ok: false, operationId: "documents.replace.v1", error: { code: "invalid_input", message: "too many fields", retryable: false, writeState: "not_applied" } } });
  const unsettled = transportOver({ "/sync/v1/replace": [invalid] }, intent);
  // Still terminal on a first send; marked so it never settles an identity a lookup says is held.
  assert.deepEqual((await unsettled.deliver()).outcome, { kind: "refused", code: "invalid_input", message: "too many fields", executed: "unknown" });
  assert.deepEqual(unsettled.requests.map((request) => request.path), ["/sync/v1/replace"]);
});

test("whole-document request: the kernel's structural bounds refuse a document before it leaves", () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, index]));
  assert.throws(() => wholeDocumentRequest("team.knowledge", intentOf(BASE, { type: "Note", ...many })), /at most 32/);
  assert.throws(() => wholeDocumentRequest("team.knowledge", intentOf(BASE, { title: "no type" })), /no type/);
  assert.throws(() => wholeDocumentRequest("team.knowledge", intentOf(BASE, { type: "  " })), /no type/);
  assert.throws(() => wholeDocumentRequest("team.knowledge", intentOf(BASE, { type: "Note", constructor: "x" })), /reserved object key/);
  // Managed fields do not count toward the bound: they never leave.
  const managed = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`f${index}`, index]));
  assert.equal(wholeDocumentRequest("team.knowledge", intentOf(BASE, { type: "Note", ...managed, timestamp: "2026-09-22T00:00:00.000Z", actor: "a" })).kind, "replace");
});

test("whole-document request: an import create carries every managed field as authored, attribution and verification included", () => {
  const generated = { by: "agent:writer", at: "2026-09-01T00:00:00.000Z" };
  const verified = [{ by: "person:ada", at: "2026-09-02T00:00:00.000Z" }];
  const authored = { type: "Note", title: "Alpha", generated, verified, superbee_updated_by: "person:ada", timestamp: "2026-09-01T00:00:00.000Z", actor: "someone", okf_version: "0.2" };
  assert.deepEqual([...IMPORT_CARRIED_FIELDS, ...IMPORT_DROPPED_FIELDS].sort(), [...HOSTED_MANAGED_FIELDS].sort(), "every managed field is either carried or dropped");
  assert.deepEqual([...IMPORT_DROPPED_FIELDS], []);
  const create = wholeDocumentRequest("team.knowledge", intentOf(null, authored), "0.2", { mode: "import" });
  assert.equal(create.kind, "create");
  assert.deepEqual(create.payload.frontmatter, authored);
  assert.deepEqual(create.kind === "create" && create.provenance, { carried: ["generated", "verified", "superbee_updated_by", "timestamp", "actor", "okf_version"], dropped: [] });
  // The same document as an ordinary write: no managed field leaves, and no provenance is reported.
  const write = wholeDocumentRequest("team.knowledge", intentOf(null, authored), "0.2");
  assert.deepEqual(write.payload, { bundleId: "team.knowledge", documentId: "notes/alpha", expectAbsent: true, frontmatter: { type: "Note", title: "Alpha" }, body: "Alpha body changed é\r\n" });
  assert.equal("provenance" in write, false);
  const replace = wholeDocumentRequest("team.knowledge", intentOf(BASE, authored), "0.2");
  assert.deepEqual(replace.kind === "replace" && replace.payload.frontmatter, { type: "Note", title: "Alpha" });
  // Only a create imports: a replace or a delete asking to is refused before anything is read.
  for (const intent of [intentOf(BASE, authored), { ...intentOf(BASE), kind: "document.delete" }]) {
    assert.throws(() => wholeDocumentRequest("team.knowledge", intent, "0.2", { mode: "import" }), (error: unknown) => error instanceof WholeDocumentInputError && error.code === "unsupported_operation");
  }
  // Carried fields are the host's to hold and do not count toward the authored-field bound.
  const many = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`f${index}`, index]));
  const full = wholeDocumentRequest("team.knowledge", intentOf(null, { type: "Note", ...many, generated, timestamp: "2026-09-01T00:00:00.000Z", actor: "a", okf_version: "0.1" }), "0.1", { mode: "import" });
  assert.equal(Object.keys(full.kind === "create" ? full.payload.frontmatter : {}).length, 36);
  // A v0.1 document keeps its unquoted YAML timestamp as the normalized ISO string a local engine reads.
  const v01 = wholeDocumentRequest("team.knowledge", { ...intentOf(null), content: "---\ntype: Note\ntimestamp: 2026-07-01T12:05:00Z\nactor: person:ada\n---\nx\n" }, "0.1", { mode: "import" });
  assert.deepEqual(v01.kind === "create" && v01.payload.frontmatter, { type: "Note", timestamp: "2026-07-01T12:05:00.000Z", actor: "person:ada" });
});

test("whole-document transport: a create whose conflict read finds the document deleted is unknown, and the next delivery creates it", async () => {
  const intent = intentOf(null);
  const exists = (): HostedAnswer => ({
    status: 200,
    headers: new Headers({ "x-superbee-write-settled": REQUEST_ID }),
    body: { ok: false, operationId: "documents.create.v1", error: { code: "document_exists", message: "exists", retryable: false, writeState: "not_applied" } },
  });
  const { transport, deliver, requests, reads } = transportOver({ "/sync/v1/create": [exists, fixture("update-200-ok")], "/sync/v1/outcome": [fixture("outcome-200-absent")] }, intent);
  assert.deepEqual(await transport.submit(intent), { kind: "unknown" });
  assert.deepEqual(reads, ["notes/alpha"]);
  const result = await deliver({ ...intent, attempts: 1 });
  assert.equal(result.outcome.kind, "committed");
  assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/create", "/sync/v1/outcome", "/sync/v1/create"]);
});

// ── a create refused over a tombstone ─────────────────────────────────────────────────────

/** Storage's typed tombstone refusal as the kernel answers it: `version_conflict` naming the tombstone. */
const TOMBSTONE = "sha256:" + "7".repeat(64);
const tombstoned = (body: string) => toCreate(body).replace('"code":"version_conflict",', `"code":"version_conflict","currentVersion":"${TOMBSTONE}",`);

test("tombstone refusal: a create of a deleted id without the recreate header is a conflict against no document, never against the tombstone", async () => {
  const intent = intentOf(null);
  const { deliver, requests, reads } = transportOver({ "/sync/v1/create": [fixture("update-200-version-conflict")] }, intent, { rewrite: tombstoned });
  const result = await deliver();
  assert.deepEqual(result.outcome, { kind: "conflict", actual: null, tombstone: TOMBSTONE }, "deleted remotely, carrying the tombstone keep needs");
  assert.equal(result.intent.state, "conflict");
  assert.deepEqual(reads, ["notes/alpha"], "the served head decides, not currentVersion");
  assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/create"], "no lookup and no resubmission");
  assert.deepEqual(requests[0]!.options, { maximum: 65536, writeRequest: REQUEST_ID, binding: BINDING }, "no recreate acknowledgement is sent");
});

test("tombstone refusal: a create whose id was deleted and recreated elsewhere conflicts with the served head", async () => {
  const intent = intentOf(null);
  const head = "sha256:" + "9".repeat(64);
  const { deliver, reads } = transportOver({ "/sync/v1/create": [fixture("update-200-version-conflict")] }, intent, { rewrite: tombstoned, headVersion: head });
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: head });
  assert.deepEqual(reads, ["notes/alpha"]);
});

test("tombstone refusal: a lookup that finds a create recorded as refused over a tombstone settles the same conflict", async () => {
  const intent = { ...intentOf(null), attempts: 1 };
  const { deliver, requests, reads } = transportOver({ "/sync/v1/outcome": [fixture("outcome-200-refused")] }, intent, { rewrite: tombstoned });
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: null, tombstone: TOMBSTONE });
  assert.deepEqual(requests.map((request) => request.path), ["/sync/v1/outcome"]);
  assert.deepEqual(reads, ["notes/alpha"]);
});

test("tombstone refusal: a create's version conflict with no current version and no served head is a conflict, not unknown", async () => {
  const intent = intentOf(null);
  const { deliver } = transportOver({ "/sync/v1/create": [fixture("update-200-version-conflict")] }, intent);
  assert.deepEqual((await deliver()).outcome, { kind: "conflict", actual: null });
});

// ── the intent-kind guard ──────────────────────────────────────────────────────────────────

/** A transport whose carrier records every request and answers each write committed. */
function guardedTransport(intent: OperationIntent) {
  const sent: string[] = [];
  const carrier: HostedCarrier = {
    json: async (route) => {
      sent.push(route);
      return answerOf(fixture("update-200-ok"), route === "/sync/v1/create" ? toCreate : toReplace);
    },
    stream: async () => assert.fail("no stream"),
  };
  const transport = createWholeDocumentTransport({ carrier, bundleId: "team.knowledge", binding: BINDING, intentFor: async (id) => (id === intent.requestId ? intent : undefined), remote: { read: async () => assert.fail("no read"), operationsRetentionMs: async () => 2_592_000_000 }, now: () => NOW });
  const deliver = (candidate = intent) => performUncertainWrite(transport, candidate, { settlement: transport.settlement, sleep: async () => {}, lookupDelayMs: 0 });
  return { transport, deliver, sent };
}

test("intent-kind guard: a chained body update with no base, as the body engine mints it, is refused and never sent as a create", async () => {
  // local-bundle's body composer mints `{ kind: "document.body.update", base: base ?? null, after }`:
  // a body update chained after an unsettled create carries base null. Chosen by base alone, it
  // would leave as documents.create.v1, an unintended create of the document.
  const intent: OperationIntent = { ...intentOf(null), kind: "document.body.update" };
  const { transport, deliver, sent } = guardedTransport(intent);
  const outcome = await transport.submit(intent);
  assert.equal(outcome.kind === "refused" && outcome.code, "unsupported_operation");
  assert.match((outcome as { message: string }).message, /document\.body\.update.*not sent/);
  const result = await deliver();
  assert.equal(result.outcome.kind === "refused" && result.outcome.code, "unsupported_operation");
  assert.equal(result.intent.state, "refused");
  // A body update with a base would otherwise leave as a whole-document replace.
  const based: OperationIntent = { ...intentOf(BASE), kind: "document.body.update" };
  const replace = guardedTransport(based);
  assert.equal((await replace.deliver()).outcome.kind, "refused");
  assert.deepEqual([...sent, ...replace.sent], []);
});

test("intent-kind guard: an explicit kind that disagrees with its base is refused before any request leaves", async () => {
  for (const [kind, base, why] of [
    ["document.create", BASE, /document\.create.*has a base/],
    ["document.replace", null, /document\.replace.*has no base/],
    ["document.delete", null, /document\.delete.*has no base/],
  ] as const) {
    const intent: OperationIntent = { ...intentOf(base), kind };
    assert.throws(() => wholeDocumentRequest("team.knowledge", intent), (error: unknown) => error instanceof WholeDocumentInputError && error.code === "unsupported_operation" && why.test(error.message));
    const { transport, deliver, sent } = guardedTransport(intent);
    const outcome = await transport.submit(intent);
    assert.equal(outcome.kind === "refused" && outcome.code, "unsupported_operation", kind);
    assert.equal((await deliver()).outcome.kind, "refused");
    assert.deepEqual(sent, [], `${kind} with base ${base} sent nothing`);
  }
});

test("intent-kind guard: every unsupported kind is refused, never mapped to create, replace or delete", async () => {
  for (const kind of ["document.body.update", "document.write.v2", "Document.Write", "Document.Delete", ""]) {
    for (const base of [null, BASE]) {
      const intent: OperationIntent = { ...intentOf(base), kind };
      assert.throws(() => wholeDocumentRequest("team.knowledge", intent), (error: unknown) => error instanceof WholeDocumentInputError && error.code === "unsupported_operation");
      const { transport, sent } = guardedTransport(intent);
      const outcome = await transport.submit(intent);
      assert.deepEqual(outcome.kind === "refused" && [outcome.code, /it was not sent/.test(outcome.message)], ["unsupported_operation", true], `${kind || "(empty)"} with base ${base}`);
      assert.deepEqual(sent, []);
    }
  }
});

test("intent-kind guard: a lookup of an unsupported or mismatched intent is held, and nothing is sent to the outcome route", async () => {
  for (const intent of [
    { ...intentOf(null), kind: "document.delete", attempts: 1 },
    { ...intentOf(null), kind: "document.body.update", attempts: 1 },
    { ...intentOf(BASE), kind: "document.create", attempts: 1 },
  ] satisfies OperationIntent[]) {
    const { transport, deliver, sent } = guardedTransport(intent);
    await assert.rejects(transport.lookup(intent.requestId), (error: unknown) => error instanceof HostedOutcomeError && error.reason === "unavailable");
    const result = await deliver();
    assert.deepEqual(result.outcome, { kind: "unknown" }, "held for a later call, never resubmitted");
    assert.deepEqual(sent, []);
  }
});

test("intent-kind guard: document.create and document.replace that agree with their base go to their own routes; document.write still chooses by base", async () => {
  for (const [kind, base, route] of [
    ["document.create", null, "/sync/v1/create"],
    ["document.replace", BASE, "/sync/v1/replace"],
    ["document.write", null, "/sync/v1/create"],
    ["document.write", BASE, "/sync/v1/replace"],
  ] as const) {
    const intent: OperationIntent = { ...intentOf(base), kind };
    assert.equal(wholeDocumentRequest("team.knowledge", intent).kind, route.endsWith("create") ? "create" : "replace");
    const { deliver, sent } = guardedTransport(intent);
    assert.equal((await deliver()).outcome.kind, "committed", `${kind} with base ${base}`);
    assert.deepEqual(sent, [route]);
  }
});

// ── the fetch carrier ──────────────────────────────────────────────────────────────────────

test("fetch carrier: a stream that is cancelled or fails mid-body leaves no idle timer behind", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const bodies = [
    new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array([1])) }),
    new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array([1])), pull: (controller) => controller.error(new Error("reset")) }),
  ];
  const fetcher = (async () => new Response(bodies.shift()!, { status: 200 })) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://host.example", fetch: fetcher, deadlineMs: 5_000, credentials: async () => ({}) });
  const before = timers();

  // A consumer that refuses the export partway, as a too-large or stopped download does.
  const cancelled = await carrier.stream("/sync/v1/export", {}, new AbortController().signal);
  assert.equal(cancelled.ok, true);
  const reader = (cancelled.body as ReadableStream<Uint8Array>).getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  assert.equal(timers(), before + 1);
  await reader.cancel("too large");
  assert.equal(timers(), before);

  const failed = await carrier.stream("/sync/v1/export", {}, new AbortController().signal);
  const failing = (failed.body as ReadableStream<Uint8Array>).getReader();
  await failing.read();
  await assert.rejects(failing.read());
  assert.equal(timers(), before);
});

test("fetch carrier: credential, identity and binding headers ride every request; no credential sends nothing; an oversize answer is unavailable", async () => {
  const seen: Request[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push(new Request(url, init));
    return new Response(JSON.stringify({ ok: true, padding: "x".repeat(100) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://host.example", fetch: fetcher, credentials: async () => ({ Authorization: "Bearer token" }) });
  const answer = await carrier.json("/sync/v1/replace", { a: 1 }, new AbortController().signal, { maximum: 1024, writeRequest: REQUEST_ID, binding: BINDING });
  assert.equal(answer.status, 200);
  assert.equal(seen[0]!.url, "https://host.example/sync/v1/replace");
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer token");
  assert.equal(seen[0]!.headers.get("x-superbee-write-request"), REQUEST_ID);
  assert.equal(seen[0]!.headers.get("x-superbee-checkout"), BINDING);
  await assert.rejects(carrier.json("/sync/v1/replace", {}, new AbortController().signal, { maximum: 10 }), (error: unknown) => error instanceof HostedCarrierError && error.code === "unavailable");

  const signedOut = createFetchCarrier({ baseUrl: "https://host.example", fetch: fetcher, credentials: async () => { throw new Error("signed out"); } });
  const before = seen.length;
  await assert.rejects(signedOut.json("/sync/v1/heads", {}, new AbortController().signal, { maximum: 1024 }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  await assert.rejects(carrier.json("/sync/v1/replace", {}, new AbortController().signal, { maximum: 1024, writeRequest: "not-a-uuid" }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  // An unbounded answer is never read: a missing or nonsensical maximum refuses before sending.
  for (const maximum of [Number.NaN, 0, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
    await assert.rejects(carrier.json("/sync/v1/replace", {}, new AbortController().signal, { maximum }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
    await assert.rejects(carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array([1]), new AbortController().signal, { maximum }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  }
  assert.equal(seen.length, before);
});

test("fetch carrier: a raw request carries the binding and via exactly as a JSON request does, refuses a malformed one before sending, and is unchanged without them", async () => {
  const seen: Request[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push(new Request(url, init));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://host.example", fetch: fetcher, credentials: async () => ({ Authorization: "Bearer token" }) });
  const signal = new AbortController().signal;
  const superbee = (request: Request) => [...request.headers].filter(([name]) => name.startsWith("x-superbee-"));
  const identity = { writeRequest: REQUEST_ID, binding: BINDING, via: "claude-code" };
  await carrier.json("/sync/v1/replace", {}, signal, { maximum: 1024, ...identity });
  await carrier.bytes!("/sync/v1/blob", new Uint8Array([1, 2]), signal, { maximum: 1024, ...identity, headers: { "X-Superbee-Blob-Version": "v" } });
  assert.deepEqual(superbee(seen[1]!).filter(([name]) => name !== "x-superbee-blob-version"), superbee(seen[0]!));
  assert.deepEqual(superbee(seen[1]!), [
    ["x-superbee-blob-version", "v"],
    ["x-superbee-checkout", BINDING],
    ["x-superbee-via", "claude-code"],
    ["x-superbee-write-request", REQUEST_ID],
  ]);
  // A carrier that names another binding header uses it for raw requests too.
  const editor = createFetchCarrier({ baseUrl: "https://host.example", fetch: fetcher, bindingHeader: "X-Superbee-Editor", credentials: async () => ({}) });
  await editor.bytes!("/sync/v1/blob", new Uint8Array([1]), signal, { maximum: 1024, binding: BINDING });
  assert.equal(seen[2]!.headers.get("x-superbee-editor"), BINDING);
  assert.equal(seen[2]!.headers.get("x-superbee-checkout"), null);
  // Without either option the raw request carries only what it did before.
  await carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array([3]), signal, { maximum: 1024, writeRequest: REQUEST_ID });
  assert.deepEqual(superbee(seen[3]!), [["x-superbee-write-request", REQUEST_ID]]);
  // Each malformed binding or via is refused on both paths alike, and nothing leaves.
  const before = seen.length;
  const bad: Record<string, string>[] = [{ binding: "sha256:" + "B".repeat(64) }, { binding: "not-a-digest" }, { via: "superbee-cli" }, { via: "Claude" }, { via: "" }];
  for (const option of bad) {
    const denied = (error: unknown) => error instanceof HostedCarrierError && error.code === "denied";
    await assert.rejects(carrier.json("/sync/v1/replace", {}, signal, { maximum: 1024, ...option }), denied, JSON.stringify(option));
    await assert.rejects(carrier.bytes!("/sync/v1/blob", new Uint8Array([1]), signal, { maximum: 1024, ...option }), denied, JSON.stringify(option));
  }
  assert.equal(seen.length, before);
});

test("via: the agent a client names rides each write and its lookup exactly as the golden exchange sends it, and an invalid token never leaves", async () => {
  const golden = JSON.parse(readFileSync(path.join(HERE, "fixtures", "hosted-sync-v1", "create-200-ok-via.json"), "utf8")) as Exchange;
  const sent: { path: string; headers: Headers }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ path: new URL(String(input)).pathname, headers: new Headers(init?.headers) });
    return new Response(golden.response.body, { status: golden.response.status, headers: golden.response.headers });
  }) as typeof globalThis.fetch;
  const carrier = createFetchCarrier({ baseUrl: "https://hosted.example", fetch, credentials: async () => ({ Authorization: "Bearer token" }) });
  const content = stringifyDoc({ type: "Note" } as never, "via");
  // The golden request's own identity and binding, so every superbee header can be compared whole.
  const requestId = golden.request.headers["x-superbee-write-request"]!;
  const binding = golden.request.headers["x-superbee-checkout"]!;
  const intent: OperationIntent = { requestId, kind: "document.write", target: "notes/via", base: null, local: versionOfBytes(content), content, createdAt: new Date(NOW).toISOString(), attempts: 0, state: "pending" };
  const over = (via?: string) => createWholeDocumentTransport({ carrier, bundleId: "notes.a", binding, intentFor: async () => intent, remote: { read: async () => assert.fail("no read"), operationsRetentionMs: async () => 2_592_000_000 }, now: () => NOW, ...(via === undefined ? {} : { via }) });
  const superbee = (headers: Headers | Record<string, string>) => [...new Headers(headers)].filter(([name]) => name.startsWith("x-superbee-"));
  // The write carries the same superbee headers the host was sent, the via token included.
  await over("claude-code").submit(intent);
  assert.equal(sent[0]!.path, "/sync/v1/create");
  assert.deepEqual(superbee(sent[0]!.headers), superbee(golden.request.headers));
  assert.equal(sent[0]!.headers.get("x-superbee-via"), "claude-code");
  // Its lookup carries it too; without a token, nothing is sent.
  await over("claude-code").lookup(requestId).catch(() => null);
  assert.deepEqual([sent[1]!.path, sent[1]!.headers.get("x-superbee-via")], ["/sync/v1/outcome", "claude-code"]);
  await over().submit(intent);
  assert.equal(sent[2]!.headers.get("x-superbee-via"), null);
  // The grammar is the host's: these it accepts, and every token its tests refuse is refused here.
  for (const via of ["a", "0", "codex", "claude-code", "gpt-5.1", "my_agent", "a".repeat(32)]) assert.equal(isAgentLabelVia(via), true, via);
  const refused = ["", "Claude-Code", "Codex", "claude code", "a".repeat(33), "superbee", "superbee-cli", "superbee.cli", "superbee_cli", "superbeecli", "a;via=b", "a/b", "claude-code, codex"];
  // A token the host would refuse is never sent: the transport refuses to be built, the carrier to send.
  for (const via of refused) {
    assert.equal(isAgentLabelVia(via), false, via);
    assert.throws(() => over(via), TypeError, via);
    await assert.rejects(carrier.json("/sync/v1/create", {}, new AbortController().signal, { maximum: 1024, via }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied", via);
  }
  assert.equal(sent.length, 3);
});

// ── history pages ────────────────────────────────────────────────────────────────────────────

/** A lineage served as the host pages it: newest first, `total` on the first page, content on request. */
function lineage(length: number, tag = "a") {
  const rows: HostedHistoryVersion[] = [];
  const append = (n: number) => {
    for (let index = 0; index < n; index += 1) {
      const seq = rows.length + 1;
      rows.push({ seq, version: `sha256:${(tag + seq.toString(16)).padStart(64, "0").slice(-64)}`, actor: "person:a", timestamp: `2030-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z` });
    }
  };
  append(length);
  const requests: HostedHistoryRequest[] = [];
  const state = { rows, append, requests, absent: false, onRequest: undefined as ((request: HostedHistoryRequest) => void) | undefined };
  const read = async (request: HostedHistoryRequest): Promise<HostedHistoryAnswer> => {
    requests.push(request);
    state.onRequest?.(request);
    if (state.absent) return { ok: false, refusal: { code: "document_not_found", message: "gone", retryable: false } };
    const older = [...state.rows].reverse().filter((row) => request.before === undefined || row.seq < request.before);
    const versions = older.slice(0, request.limit).map((row) => (request.includeContent ? { ...row, content: `content ${row.seq}` } : row));
    return { ok: true, page: { documentId: request.documentId, versions, more: older.length > versions.length, ...(request.before === undefined ? { total: state.rows.length } : {}) } };
  };
  return { state, read };
}

const listing = (read: (request: HostedHistoryRequest) => Promise<HostedHistoryAnswer>, wanted: number, extra: { includeContent?: boolean; pageSize?: number } = {}, sleeps: number[] = []) =>
  readHistoryListing(read, { documentId: "notes/a", wanted, ...extra }, { signal: new AbortController().signal, sleep: async (ms) => void sleeps.push(ms) });

test("history pages: one page is one request; more pages follow `before` and re-read the newest version by its seq", async () => {
  const one = lineage(3);
  assert.deepEqual(await listing(one.read, 20), { status: "listed", versions: [...one.state.rows].reverse(), total: 3 });
  assert.equal(one.state.requests.length, 1);

  const many = lineage(7);
  const listed = await listing(many.read, 20, { pageSize: 3, includeContent: true });
  assert.equal(listed.status, "listed");
  if (listed.status !== "listed") return;
  assert.deepEqual(listed.versions.map((row) => row.seq), [7, 6, 5, 4, 3, 2, 1]);
  assert.ok(listed.versions.every((row) => row.content === `content ${row.seq}`), "content passes through on every page");
  assert.deepEqual(
    many.state.requests.map(({ limit, before, includeContent }) => [limit, before, includeContent]),
    [
      [3, undefined, true],
      [3, 5, true],
      [3, 2, true],
      [1, 8, undefined],
    ],
  );
  // `wanted` bounds the listing, and the last page asks only for what is left.
  const capped = lineage(7);
  const five = await listing(capped.read, 5, { pageSize: 3 });
  assert.deepEqual(five.status === "listed" && [five.versions.length, five.total], [5, 7]);
  assert.deepEqual(capped.state.requests.map(({ limit, before }) => [limit, before]), [[3, undefined], [2, 5], [1, 8]]);
});

test("history pages: a write that only appends keeps the listing; a new lineage starts it again, and one that keeps changing is moved", async () => {
  const appended = lineage(5);
  appended.state.onRequest = (request) => {
    if (request.before !== undefined && request.limit > 1) appended.state.append(1);
  };
  const kept = await listing(appended.read, 20, { pageSize: 2 });
  assert.equal(kept.status, "listed");
  assert.deepEqual(kept.status === "listed" && [kept.total, kept.versions.map((row) => row.seq)], [5, [5, 4, 3, 2, 1]]);

  // Deleted and recreated after the first page of the first attempt: a lineage with other versions.
  const recreated = lineage(5);
  let swapped = false;
  recreated.state.onRequest = (request) => {
    if (!swapped && request.before !== undefined) {
      swapped = true;
      recreated.state.rows.splice(0, recreated.state.rows.length, ...lineage(6, "b").state.rows);
    }
  };
  const sleeps: number[] = [];
  const again = await listing(recreated.read, 20, { pageSize: 2 }, sleeps);
  assert.deepEqual(again.status === "listed" && [again.total, again.versions[0]!.version], [6, recreated.state.rows[5]!.version]);
  assert.equal(sleeps.length, 1, "one pause before starting again");

  const churning = lineage(4);
  let generation = 0;
  churning.state.onRequest = (request) => {
    if (request.before !== undefined && request.limit > 1) churning.state.rows.splice(0, churning.state.rows.length, ...lineage(4, `c${(generation += 1)}`).state.rows);
  };
  assert.deepEqual(await listing(churning.read, 20, { pageSize: 2 }), { status: "moved" });

  // A later page that answers document_not_found: the lineage ended between pages.
  const deleted = lineage(4);
  deleted.state.onRequest = (request) => void (deleted.state.absent = request.before !== undefined);
  assert.deepEqual(await listing(deleted.read, 20, { pageSize: 2 }), { status: "moved" });
});

test("history pages: absence on the first page is the answer, and any other refusal passes through", async () => {
  const gone = lineage(2);
  gone.state.absent = true;
  assert.deepEqual(await listing(gone.read, 20), { status: "absent" });
  const refusal = { code: "insufficient_scope", message: "no", retryable: false };
  assert.deepEqual(await listing(async () => ({ ok: false, refusal }), 20), { status: "refused", refusal });
  await assert.rejects(listing(lineage(1).read, 20, { pageSize: 101 }), RangeError);
});

// ── the front page: bundles.root.replace.v1 (lane front-page wire contract) ─────────────────────

const ROOT_BUNDLE = "team.knowledge";
const ROOT_BASE = `sha256:${"a".repeat(64)}`;
const rootPage = "---\nokf_version: \"0.2\"\ntitle: Front\n---\n# Front\n";
const rootFailure = (code: string, writeState = "not_applied", extra: Record<string, unknown> = {}) => ({ ok: false, operationId: ROOT_OPERATION_ID, error: { code, message: `refused: ${code}`, retryable: false, writeState, ...extra } });

test("a root write is a CAS replace or create, measured as encoded, refused before sending when the host could only refuse it", () => {
  assert.deepEqual(rootWriteRequest(ROOT_BUNDLE, rootPage, ROOT_BASE).payload, { bundleId: ROOT_BUNDLE, content: rootPage, expectedVersion: ROOT_BASE });
  assert.deepEqual(rootWriteRequest(ROOT_BUNDLE, rootPage, null).payload, { bundleId: ROOT_BUNDLE, content: rootPage, expectAbsent: true });
  assert.equal(rootVersionOf(rootPage), versionOfBytes(rootPage), "the host's version is the digest of the UTF-8 bytes");
  // The bound is the encoded request, not the content: escapes count.
  const quotes = '"'.repeat(40 * 1024);
  assert.ok(new TextEncoder().encode(quotes).byteLength < 65536);
  assert.throws(() => rootWriteRequest(ROOT_BUNDLE, quotes, ROOT_BASE), (error: unknown) => error instanceof RootWriteInputError && error.code === "too_large");
  assert.throws(() => rootWriteRequest(ROOT_BUNDLE, `﻿${rootPage}`, ROOT_BASE), (error: unknown) => error instanceof RootWriteInputError && error.code === "invalid_input");
  assert.throws(() => rootWriteRequest(ROOT_BUNDLE, `${rootPage}\uD800`, ROOT_BASE), (error: unknown) => error instanceof RootWriteInputError && error.code === "invalid_input");
});

test("a root write's answers: success only for the bytes sent, refusals final, anything the host may have applied unknown", () => {
  const sent = rootVersionOf(rootPage);
  const expected = { bundleId: ROOT_BUNDLE, sent };
  const classify = (status: number, body: unknown) => classifyRootAnswer({ status, body }, expected);
  assert.deepEqual(classify(200, { ok: true, operationId: ROOT_OPERATION_ID, data: { bundleId: ROOT_BUNDLE, version: sent, changed: true } }), { kind: "committed", version: sent, changed: true });
  // A success for other bytes, another bundle or another operation is not evidence about this write.
  assert.equal(classify(200, { ok: true, operationId: ROOT_OPERATION_ID, data: { bundleId: ROOT_BUNDLE, version: ROOT_BASE, changed: true } }).kind, "unknown");
  assert.equal(classify(200, { ok: true, operationId: ROOT_OPERATION_ID, data: { bundleId: "other", version: sent, changed: true } }).kind, "unknown");
  assert.equal(classify(200, { ok: true, operationId: "documents.replace.v1", data: { bundleId: ROOT_BUNDLE, version: sent, changed: true } }).kind, "unknown");
  assert.deepEqual(classify(200, rootFailure("version_conflict", "not_applied", { currentVersion: ROOT_BASE })), { kind: "conflict", current: ROOT_BASE });
  assert.deepEqual(classify(200, rootFailure("document_exists", "not_applied", { currentVersion: ROOT_BASE })), { kind: "conflict", current: ROOT_BASE });
  assert.deepEqual(classify(200, rootFailure("validation_failed")), { kind: "refused", code: "validation_failed", message: "refused: validation_failed" });
  assert.equal((classify(200, rootFailure("insufficient_scope")) as { authorization?: string }).authorization, "PERMISSION_DENIED");
  assert.equal(classify(200, rootFailure("write_outcome_unknown", "unknown")).kind, "unknown");
  assert.deepEqual(classify(400, { error: { code: "invalid_input" } }), { kind: "refused", code: "invalid_input", message: "The host refused the request as malformed; nothing was written.", malformed: true });
  // As the identified writes' 403 row: access withdrawn, under AUTH_REQUIRED, never a read-only refusal.
  assert.deepEqual(classify(403, { error: "access_denied" }), { kind: "refused", code: "access_withdrawn", message: "The host denied access to this bundle.", authorization: "AUTH_REQUIRED" });
  assert.equal((classify(401, { error: { code: "unauthenticated", writeState: "not_applied" } }) as { authorization?: string }).authorization, "AUTH_REQUIRED");
  assert.equal(classify(401, { error: { code: "write_outcome_unknown", writeState: "unknown" } }).kind, "unknown");
  assert.equal(classify(503, { error: { code: "write_outcome_unknown", writeState: "unknown" } }).kind, "unknown");
  assert.equal(classify(503, { error: { code: "backend_unavailable", writeState: "not_applied" } }).kind, "refused");
  assert.equal(classify(502, undefined).kind, "unknown");
});

test("a root write never carries a request identity, and a lost answer is settled by the root version alone", async () => {
  const seen: HostedRequestOptions[] = [];
  const carrier: HostedCarrier = {
    async json(_route, _input, _signal, options) {
      seen.push(options);
      throw new HostedCarrierError("unavailable");
    },
    stream: async () => {
      throw new Error("unused");
    },
  };
  const binding = `sha256:${"b".repeat(64)}`;
  assert.deepEqual(await sendRootWrite({ carrier, route: "/sync/v1/root", bundleId: ROOT_BUNDLE, binding, via: "claude-code", content: rootPage, base: ROOT_BASE }), { kind: "unknown" });
  assert.equal(seen[0]!.writeRequest, undefined);
  assert.equal(seen[0]!.binding, binding);
  assert.equal(seen[0]!.via, "claude-code");
  const sent = rootVersionOf(rootPage);
  assert.equal(rootLanding(sent, sent, ROOT_BASE), "landed");
  assert.equal(rootLanding(ROOT_BASE, sent, ROOT_BASE), "not_landed");
  assert.equal(rootLanding(null, sent, null), "not_landed");
  assert.equal(rootLanding(`sha256:${"c".repeat(64)}`, sent, ROOT_BASE), "conflict");
});

test("whole-document transport: a refusal that is not the identity's recorded answer says so, from the row's `recorded`", async () => {
  const intent = intentOf(BASE);
  const submitted = async (exchange: string, rewrite?: (body: string) => string) =>
    transportOver({ "/sync/v1/replace": [fixture(exchange)] }, intent, rewrite ? { rewrite: (body) => rewrite(toReplace(body)) } : {}).transport.submit({ ...intent, attempts: 1, state: "in_flight" });
  // Rows recorded "no": refused before dispatch.
  for (const exchange of ["update-401-not-applied", "update-400"]) {
    const outcome = await submitted(exchange);
    assert.equal(outcome.kind, "refused", exchange);
    assert.equal(outcome.kind === "refused" && outcome.executed, false, exchange);
  }
  // "401 other": the row cannot say whether the attempt ran.
  const other = await submitted("update-401-not-applied", () => JSON.stringify({ error: { code: "unrecognized" } }));
  assert.equal(other.kind === "refused" && other.executed, "unknown");
  // Nothing sent: no credential, or input the transport will not send.
  const unsent = await createWholeDocumentTransport({ carrier: { json: async () => { throw new HostedCarrierError("denied"); } } as never, bundleId: "team.knowledge", binding: BINDING, intentFor: async () => intent, remote: { read: async () => { throw new Error("unused"); }, operationsRetentionMs: async () => 0 } }).submit(intent);
  assert.equal(unsent.kind === "refused" && unsent.executed, false);
});

import { createHostedDocumentBackend, HostedDocumentBackendError, type HostedDocumentIntent, type HostedDocumentIntentPort, type HostedDocumentScope } from "../src/hosted-transport/index.js";
import { VersionConflict } from "../src/version-transport.js";
import { mutateDocument } from "../src/document-mutation.js";
const documentScope: HostedDocumentScope = { tenant: "tenant", bundleId: "team.knowledge", registration: "registration", binding: `sha256:${"b".repeat(64)}`, workspace: "workspace", okfVersion: "0.2", mode: "write", bodyPolicy: "protected", tombstonePolicy: "refuse" };
const documentRequest = "4a2f9c1e-8b3d-4e6f-9a1b-2c3d4e5f6a7b";
const documentInput = { id: "notes/alpha", frontmatter: { type: "Note", title: "Alpha" }, body: "body\n" };
function documentHost() {
  const records = new Map<string, HostedDocumentIntent>();
  const documents = new Map<string, { content: string; version: string; frontmatter: Record<string, unknown>; body: string }>();
  const receipts = new Map<string, unknown>();
  const calls: { route: string; payload: any; options?: HostedRequestOptions }[] = [];
  let claimAckLost = false, settlementLost = false, responseLost = false;
  let lookupStatus: "absent" | "pending" | undefined;
  let denial: 401 | 403 | undefined;
  const port: HostedDocumentIntentPort = {
    async prepareOrReadAndClaim(candidate) {
      const key = candidate.intent.requestId, known = records.get(key);
      if (known) return { record: structuredClone(known), fresh: false };
      records.set(key, structuredClone(candidate));
      if (claimAckLost) throw new Error("claim acknowledgement lost");
      return { record: structuredClone(candidate), fresh: true };
    },
    async settle(record, outcome) {
      if (settlementLost) throw new Error("settlement store unavailable");
      const current = records.get(record.intent.requestId)!;
      assert.equal(current.digest, record.digest);
      if (!current.outcome || current.outcome.kind === "unknown" || current.outcome.kind === "refused" && current.outcome.executed === "unknown") records.set(record.intent.requestId, { ...current, outcome: structuredClone(outcome) });
    },
  };
  const carrier: HostedCarrier = {
    async json(route, payload, _signal, opts) {
      calls.push({ route, payload, options: opts });
      if (denial) return { status: denial, headers: new Headers(), body: { error: { code: "insufficient_scope" } } };
      if (route.endsWith("/capabilities")) return answerOf(fixture("capabilities-operations"));
      if (route.endsWith("/read")) {
        const found = documents.get((payload as any).documentId);
        return { status: 200, headers: new Headers(), body: found ? { ok: true, operationId: "documents.read.v1", data: { version: found.version, document: { id: (payload as any).documentId, frontmatter: found.frontmatter, body: found.body } } } : { ok: false, operationId: "documents.read.v1", error: { code: "document_not_found", message: "absent" } } };
      }
      if (route.endsWith("/outcome")) return { status: 200, headers: new Headers(), body: lookupStatus ? { schemaVersion: 1, requestId: opts!.writeRequest, binding: opts!.binding, status: lookupStatus } : receipts.get(opts!.writeRequest!) ?? { schemaVersion: 1, requestId: opts!.writeRequest, binding: opts!.binding, status: "absent" } };
      const p = payload as any;
      assert.equal(records.get(opts!.writeRequest!)!.intent.state, "in_flight");
      assert.equal(records.get(opts!.writeRequest!)!.intent.attempts, 1);
      const operationId = route.endsWith("/create") ? "documents.create.v1" : "documents.replace.v1";
      const current = documents.get(p.documentId);
      if (p.expectAbsent ? current !== undefined : current?.version !== p.expectedVersion) return { status: 200, headers: new Headers(), body: { ok: false, operationId, error: { code: "version_conflict", message: "moved", retryable: false, writeState: "not_applied", currentVersion: current?.version ?? null } } };
      const frontmatter = { ...p.frontmatter, superbee_updated_by: "human:host" };
      const content = stringifyDoc(frontmatter, p.body), version = versionOfBytes(content);
      const result = { ok: true, operationId, data: { bundleId: p.bundleId, documentId: p.documentId, version, changed: true } };
      documents.set(p.documentId, { content, version, frontmatter, body: p.body });
      receipts.set(opts!.writeRequest!, { schemaVersion: 1, requestId: opts!.writeRequest, binding: opts!.binding, status: "committed", result, content: { encoding: "base64", version, bytes: Buffer.from(content).toString("base64") } });
      if (responseLost) throw new Error("response lost after commit");
      return { status: 200, headers: new Headers(), body: result };
    },
    async stream() { throw new Error("not used"); },
  };
  const reader = createHostedReadAdapter({ carrier, bundleId: documentScope.bundleId });
  const backend = (scope = documentScope, intentPort = port) => createHostedDocumentBackend({ reader, carrier, scope, intents: intentPort, maximumDocuments: 3, now: () => Date.parse("2026-10-24T00:00:00Z") });
  return { records, documents, calls, reader, carrier, port, backend, setClaimAckLost: () => { claimAckLost = true; }, setSettlementLost: (v: boolean) => { settlementLost = v; }, setResponseLost: () => { responseLost = true; }, setLookup: (v: typeof lookupStatus) => { lookupStatus = v; }, setDenial: (v: typeof denial) => { denial = v; } };
}
const unknownDocumentOutcome = (e: unknown) => e instanceof HostedDocumentBackendError && e.code === "outcome_unknown" && e.requestId === documentRequest;

test("document backend: complete golden paged inventory precedes prefix filtering and bound admission", async () => {
  let page = 0; const h = documentHost();
  const reader = createHostedReadAdapter({ bundleId: documentScope.bundleId, carrier: { ...h.carrier, async json() { return answerOf(fixture(page++ % 2 === 0 ? "heads-page-first" : "heads-page-last")); } } });
  const build = (maximumDocuments: number) => createHostedDocumentBackend({ reader, carrier: h.carrier, scope: documentScope, intents: h.port, maximumDocuments });
  assert.deepEqual(await build(3).list("projects/"), ["projects/2026/plan"]); assert.equal(page, 2);
  await assert.rejects(build(2).list("projects/"), { code: "inventory_bound" }); assert.equal(page, 4);
  assert.equal("wireCapabilities" in build(3), false); assert.equal("inventoryGuard" in build(3), false);
  assert.deepEqual(build(3).capabilities!(), { enforced_cas: true, history: false, blobs: false });
});
test("document backend: ENOENT alone means exists false; root and read denial retain their owner", async () => {
  const h = documentHost(), b = h.backend();
  assert.equal(await b.exists("notes/absent"), false); assert.ok(await b.readReserved("", "index.md")); assert.equal(await b.readReserved("nested", "index.md"), null);
  h.setDenial(403);
  await assert.rejects(b.exists("notes/absent"), (e: any) => e instanceof RemoteError && e.status === 403);
  await assert.rejects(b.readMany(["notes/absent"]), (e: any) => e instanceof RemoteError && e.status === 403);
});
test("document backend: create/replace CAS returns host version and retains the acknowledged descriptor", async () => {
  const h = documentHost(), b = h.backend();
  const created = await b.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest, actor: "process:import", bodyReplace: undefined });
  assert.notEqual(created, versionOfBytes(stringifyDoc(documentInput.frontmatter, documentInput.body))); assert.equal(h.records.get(documentRequest)!.outcome!.kind, "committed");
  const replaced = await b.write(documentInput.id, { ...documentInput, body: "next\n" }, { expectedVersion: created, requestId: documentRequest.replace("4a2f", "5a2f") }); assert.notEqual(replaced, created);
  await assert.rejects(b.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest.replace("4a2f", "6a2f") }), VersionConflict);
  await assert.rejects(b.write(documentInput.id, documentInput, { expectedVersion: created, requestId: documentRequest.replace("4a2f", "7a2f") }), VersionConflict);
  assert.equal((await b.readMany([documentInput.id]))[0].version, replaced);
});
test("document backend: concurrent callers share one persisted-before-send fresh claim", async () => {
  const h = documentHost();
  const results = await Promise.allSettled([h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest })]);
  assert.ok(results.some((r) => r.status === "fulfilled")); assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1); assert.equal(h.records.get(documentRequest)!.intent.attempts, 1);
  assert.equal(await h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), h.documents.get(documentInput.id)!.version);
  assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1);
});
test("document backend: lost claim acknowledgement and stored absent/pending claims never send", async () => {
  for (const status of ["absent", "pending"] as const) {
    const h = documentHost(); h.setClaimAckLost(); h.setLookup(status);
    await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), unknownDocumentOutcome); assert.equal(h.calls.length, 0);
    if (status === "pending") { const r = h.records.get(documentRequest)!; h.records.set(documentRequest, { ...r, intent: { ...r.intent, attempts: 0, state: "pending" } }); }
    await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), unknownDocumentOutcome);
    assert.equal(h.calls.filter((c) => /\/(create|replace)$/.test(c.route)).length, 0);
  }
});
test("document backend: lost commit response resolves original receipt; settlement persistence loss stays unknown", async () => {
  for (const responseLost of [false, true]) {
    const h = documentHost(); if (responseLost) h.setResponseLost(); h.setSettlementLost(true); let failed: any;
    try { await h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }); } catch (e) { failed = e; }
    assert.ok(unknownDocumentOutcome(failed)); assert.equal(failed.record.outcome.kind, "committed"); h.setSettlementLost(false);
    assert.equal(await h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), h.documents.get(documentInput.id)!.version);
    assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1); assert.ok(h.calls.some((c) => c.route.endsWith("/outcome")));
  }
});
test("document backend: changed durable scope, payload, premise or digest refuses before lookup/send", async () => {
  const h = documentHost(); h.setClaimAckLost();
  await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), unknownDocumentOutcome);
  for (const scope of [{ ...documentScope, tenant: "other" }, { ...documentScope, registration: "other" }, { ...documentScope, workspace: null }, { ...documentScope, binding: `sha256:${"c".repeat(64)}` }, { ...documentScope, okfVersion: "0.1" as const }])
    await assert.rejects(h.backend(scope).write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), { code: "intent_conflict" });
  await assert.rejects(h.backend().write(documentInput.id, { ...documentInput, body: "different" }, { expectedVersion: null, requestId: documentRequest }), { code: "intent_conflict" });
  await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: `sha256:${"a".repeat(64)}`, requestId: documentRequest }), { code: "intent_conflict" });
  const r = h.records.get(documentRequest)!; h.records.set(documentRequest, { ...r, intent: { ...r.intent, createdAt: "2026-10-23T00:00:00Z" } });
  await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), { code: "intent_conflict" }); assert.equal(h.calls.length, 0);
});
test("document backend: unsupported families/options and malformed identity/CAS have no effects", async () => {
  const h = documentHost(), b = h.backend();
  for (const opts of [undefined, { requestId: documentRequest }, { expectedVersion: null }, { expectedVersion: "", requestId: documentRequest }, { expectedVersion: null, requestId: "wrong" }, { expectedVersion: null, requestId: documentRequest, actor: "untrusted" }, { expectedVersion: null, requestId: documentRequest, agent: "agent" }, { expectedVersion: null, requestId: documentRequest, bodyReplace: {} }]) await assert.rejects(b.write(documentInput.id, documentInput, opts as any));
  for (const id of ["../bad", "index", "nested/log", "a//b"]) await assert.rejects(b.write(id, documentInput, { expectedVersion: null, requestId: documentRequest }));
  for (const call of [() => b.delete("a"), () => b.versions("a"), () => b.writeReserved("", "index.md", "x"), () => b.readBlob("x"), () => b.existsBlob("x"), () => b.listBlobs(), () => b.writeBlob("x", new Uint8Array()), () => b.deleteBlob("x")]) await assert.rejects(async () => call(), { code: "unsupported" });
  assert.equal(h.records.size, 0); assert.equal(h.calls.length, 0);
});
test("document backend: host and local authorization refusals retain classification", async () => {
  const h = documentHost(); h.setDenial(403);
  await assert.rejects(h.backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), (e: any) => e.code === "AUTH_REQUIRED");
  const local = documentHost(); const carrier: HostedCarrier = { ...local.carrier, async json() { throw new HostedCarrierError("denied"); } };
  const b = createHostedDocumentBackend({ carrier, reader: local.reader, scope: documentScope, intents: local.port, maximumDocuments: 3 });
  await assert.rejects(b.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), (e: any) => e.code === "AUTH_REQUIRED");
  assert.equal(local.calls.filter((c) => c.route.endsWith("/outcome")).length, 0);
  assert.equal(local.records.get(documentRequest)!.outcome!.kind, "refused");
  assert.equal((local.records.get(documentRequest)!.outcome as any).executed, false);
});
test("document backend: actual mutateDocument create/replace consumer with a stable request identity bridge", async () => {
  const h = documentHost(), backend = h.backend(); let requestId = documentRequest;
  // A4 owns forwarding requestId from mutateDocument; this models only that narrow bridge.
  const bound = { ...backend, write: (id: string, doc: any, opts: any) => backend.write(id, doc, { ...opts, requestId }) };
  const common = { bundle: { root: "/unused", backend: bound }, id: documentInput.id, registry: { kinds: new Map(), warnings: [] }, strict: false, actor: "process:source-import" };
  const created = await mutateDocument({ ...common, mode: "create-only", buildCandidate: () => documentInput }); requestId = documentRequest.replace("4a2f", "8a2f");
  await mutateDocument({ ...common, mode: "replace-document", expectedVersion: created.version, onAbsent: "fail", maxAttempts: 1, buildCandidate: () => ({ ...documentInput, body: "replacement\n" }) });
  assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1); assert.equal(h.calls.filter((c) => c.route.endsWith("/replace")).length, 1);
  assert.equal(h.documents.get(documentInput.id)!.frontmatter.superbee_updated_by, "human:host");
});

test("document backend: tombstoned create refuses without recreation or follow-up write", async () => {
  const h = documentHost();
  const source = JSON.parse(readFileSync(path.join(HERE, "fixtures/hosted-sync-v1/create-200-version-conflict-tombstone.json"), "utf8")) as Exchange;
  const carrier: HostedCarrier = { ...h.carrier, async json(route, payload, signal, opts) {
    if (!route.endsWith("/create")) return h.carrier.json(route, payload, signal, opts);
    h.calls.push({ route, payload, options: opts });
    assert.equal(opts?.recreate, undefined);
    return answerOf(source);
  } };
  const b = createHostedDocumentBackend({ reader: h.reader, carrier, scope: documentScope, intents: h.port, maximumDocuments: 3 });
  await assert.rejects(b.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), (e: any) => e instanceof VersionConflict && e.actual === null);
  assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1);
  assert.equal(h.records.get(documentRequest)!.outcome!.kind, "conflict");
});

test("document backend: public Worker bundle executes the synthetic carrier consumer without Node globals", async () => {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const bundled = await build({ stdin: { contents: 'export { createHostedDocumentBackend, createHostedReadAdapter } from "@superbee/core/hosted-transport";', resolveDir: HERE }, platform: "browser", format: "iife", globalName: "hosted", bundle: true, write: false, metafile: true });
  assert.ok(!Object.keys(bundled.metafile!.inputs).some((name) => name.startsWith("node:")));
  const context = { TextEncoder, TextDecoder, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, atob, btoa };
  const api = runInNewContext(`${bundled.outputFiles[0].text}\nhosted`, context);
  const h = documentHost(); h.setResponseLost();
  const reader = api.createHostedReadAdapter({ carrier: h.carrier, bundleId: documentScope.bundleId });
  const backend = api.createHostedDocumentBackend({ reader, carrier: h.carrier, scope: documentScope, intents: h.port, maximumDocuments: 3 });
  const version = await backend.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest });
  assert.equal(version, h.documents.get(documentInput.id)!.version);
  assert.ok(h.calls.some((c) => c.route.endsWith("/outcome")));
  assert.equal((await backend.read(documentInput.id)).version, version);
});

test("document backend: unknown, expired and unavailable receipt lookups retain original intent without resending", async () => {
  for (const response of ["absent", "pending", "malformed", "unavailable"] as const) {
    const h = documentHost(); h.setClaimAckLost();
    const old = createHostedDocumentBackend({ reader: h.reader, carrier: h.carrier, scope: documentScope, intents: h.port, maximumDocuments: 3, now: () => 0 });
    await assert.rejects(old.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), unknownDocumentOutcome);
    const original = structuredClone(h.records.get(documentRequest));
    const carrier: HostedCarrier = { ...h.carrier, async json(route, payload, signal, opts) {
      if (!route.endsWith("/outcome")) return h.carrier.json(route, payload, signal, opts);
      h.calls.push({ route, payload, options: opts });
      if (response === "unavailable") throw new HostedCarrierError("unavailable");
      return { status: 200, headers: new Headers(), body: response === "malformed" ? {} : { schemaVersion: 1, requestId: opts!.writeRequest, binding: opts!.binding, status: response } };
    } };
    const restarted = createHostedDocumentBackend({ reader: h.reader, carrier, scope: documentScope, intents: h.port, maximumDocuments: 3 });
    await assert.rejects(restarted.write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest }), unknownDocumentOutcome);
    assert.deepEqual(h.records.get(documentRequest)!.intent, original!.intent);
    assert.equal(h.calls.filter((c) => /\/(create|replace)$/.test(c.route)).length, 0);
  }
});

test("document backend: actual attempt-only execution-unknown refusal remains lookup-only until recorded truth", async () => {
  for (const storedLegacy of [false, true]) for (const waiting of ["pending", "absent"] as const) for (const truth of ["committed", "refused"] as const) {
    const h = documentHost(); h.setLookup(waiting);
    const carrier: HostedCarrier = { ...h.carrier, async json(route, payload, signal, opts) {
      const answer = await h.carrier.json(route, payload, signal, opts);
      if (route.endsWith("/create")) return { status: 200, headers: new Headers(), body: { ok: false, operationId: "documents.create.v1",
        error: { code: "invalid_input", message: "Attempt-only refusal", retryable: false, writeState: "not_applied" } } };
      if (route.endsWith("/outcome") && truth === "refused" && (answer.body as any).status === "committed")
        return { ...answer, body: { schemaVersion: 1, requestId: opts!.writeRequest, binding: opts!.binding, status: "refused",
          result: { ok: false, operationId: "documents.create.v1", error: { code: "invalid_input", message: "Recorded refusal", retryable: false, writeState: "not_applied" } } } };
      return answer;
    } };
    const backend = () => createHostedDocumentBackend({ reader: h.reader, carrier, scope: documentScope, intents: h.port, maximumDocuments: 3 });
    const write = () => backend().write(documentInput.id, documentInput, { expectedVersion: null, requestId: documentRequest });
    await assert.rejects(write(), unknownDocumentOutcome);
    const original = structuredClone(h.records.get(documentRequest)!);
    if (storedLegacy) h.records.set(documentRequest, { ...original, outcome: { kind: "refused", code: "invalid_input", message: "Earlier attempt-only refusal", executed: "unknown" } });
    // Settlement loss must not turn an attempt refusal into a terminal answer either.
    h.setSettlementLost(true);
    await assert.rejects(write(), unknownDocumentOutcome);
    h.setSettlementLost(false);
    await assert.rejects(write(), unknownDocumentOutcome);
    h.setLookup(undefined);
    if (truth === "committed") assert.equal(await write(), h.documents.get(documentInput.id)!.version);
    else await assert.rejects(write(), (error: any) => error.code === "invalid_input" && error.record.outcome.executed === undefined);
    assert.deepEqual(h.records.get(documentRequest)!.intent, original.intent);
    assert.deepEqual(h.records.get(documentRequest)!.scope, original.scope);
    assert.equal(h.records.get(documentRequest)!.digest, original.digest);
    assert.equal(h.records.get(documentRequest)!.outcome!.kind, truth);
    const settledCalls = h.calls.length;
    if (truth === "committed") assert.equal(await write(), h.documents.get(documentInput.id)!.version);
    else await assert.rejects(write(), (error: any) => error.code === "invalid_input");
    assert.equal(h.calls.length, settledCalls, "definitive recorded truth stays cached");
    assert.equal(h.calls.filter((c) => c.route.endsWith("/create")).length, 1);
    assert.ok(h.calls.filter((c) => c.route.endsWith("/outcome")).length >= 3);
  }
});
