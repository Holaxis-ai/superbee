/**
 * `HostedClient.writeBlob`, `deleteBlob`, `lookupBlobWrite`, `settleBlobWrite`, `forgetBlobWrite`,
 * `heldBlobWrites`, `blobHeads`, `blobHead` and `readBlob`, and their owner `driveJournaledBlob`.
 * Plain answers replay the `/sync/v1` blob golden exchanges byte for byte (the client's own
 * binding substituted where an outcome names it); recovery and the adversarial rows run against
 * a stateful fake host with an identity ledger that can lose a request before or after applying it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bearerCredentials,
  createHostedClient,
  createMemoryBlobJournal,
  driveJournaledBlob,
  HostedBlobDeletionsNotAccepted,
  HostedBlobWriteNotSent,
  HostedBlobWritesNotServed,
  HostedRouteNotServed,
  isRouteNotServed,
  RemoteError,
  type BlobJournaledBackend,
  type HostedClientOptions,
  type MemoryBlobJournal,
} from "../src/hosted-client/index.js";
import { openHostedClientJournalWith } from "../src/hosted-client/journal.js";
import { HostedClientJournalError } from "../src/hosted-client/node.js";
import { prepareBlobIntent, type BlobIntentRecord, type BlobTargetScope } from "../src/blob-journal.js";
import { FILE_JOURNAL_LOG, FILE_JOURNAL_SNAPSHOT, FileJournaledBackend } from "../src/file-journaled-backend.js";
import { OPEN_LOG, type FileJournalHandle } from "../src/file-journaled-backend-internal.js";
import { JournalGuardConflict } from "../src/journaled-backend.js";
import { createFetchCarrier, decodeHostedCapabilities } from "../src/hosted-transport/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");
interface Exchange {
  route: string;
  request: { headers: Record<string, string>; body?: string; bodyBase64?: string };
  response: { status: number; headers: Record<string, string>; body?: string; bodyBase64?: string };
}
const fixture = (name: string): Exchange => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Exchange;
const replay = (name: string, edit: (body: string) => string = (body) => body): Response => {
  const { response } = fixture(name);
  const body = response.bodyBase64 !== undefined ? new Uint8Array(Buffer.from(response.bodyBase64, "base64")) : edit(response.body ?? "");
  return new Response(body, { status: response.status, headers: response.headers });
};
const idOf = (name: string) => fixture(name).request.headers["x-superbee-write-request"]!;

const ORIGIN = "https://hosted.example";
const PREFIX = "/sync/v1";
const BUNDLE = "notes.a";
const FIXTURE_BINDING = `sha256:${"c".repeat(64)}`;
const SVG = "image/svg+xml; charset=utf-8";
const FIXTURE_BYTES = new Uint8Array(Buffer.from("AP+ADQoAAQ==", "base64"));
const FIXTURE_VERSION = "sha256:fb329f8defe047af577e860c6a44adcd49c1f2106b41234d93cf69bda0c3ae33";
const CAFE = "diagrams/café.svg";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const text = (value: string) => new TextEncoder().encode(value);
const capabilitiesBody = (edit: (caps: Record<string, unknown>) => void = () => {}) => {
  const caps = JSON.parse(fixture("capabilities-200").response.body!) as Record<string, unknown>;
  edit(caps);
  return JSON.stringify(caps);
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Sent {
  readonly route: string;
  readonly headers: Headers;
  readonly body: string | Uint8Array;
}

/** A fetch that records every request and answers through `answer`. */
function recorder(answer: (route: string, headers: Headers, body: string | Uint8Array) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.slice(PREFIX.length + 1);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = raw instanceof Uint8Array ? new Uint8Array(raw) : String(raw ?? "");
    sent.push({ route, headers, body });
    return answer(route, headers, body);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const routes = (sent: readonly Sent[]) => sent.map((row) => row.route);
const blobRoutes = (sent: readonly Sent[]) => routes(sent).filter((route) => route !== "capabilities");

function clientOf(fetch: typeof globalThis.fetch, overrides: Partial<HostedClientOptions> = {}) {
  return createHostedClient({ target: { origin: ORIGIN, syncPrefix: PREFIX }, credentials: bearerCredentials(() => "token-1"), fetch, writeRecovery: { lookupDelayMs: 0 }, ...overrides });
}

/** A host answering by route with the named exchanges, in order per route. */
function golden(byRoute: Record<string, (string | (() => Response))[]>) {
  return recorder((route) => {
    const next = byRoute[route]?.shift();
    if (next === undefined) return assert.fail(`unexpected ${route}`);
    return typeof next === "string" ? replay(next) : next();
  });
}

// ── the stateful fake host ─────────────────────────────────────────────────────────────────

type Fault = "lost-request" | "lost-answer" | "throw";
interface StoredBlob {
  version: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A host with blob heads per bundle and an identity ledger. A queued fault applies to the next
 * request of its route: `lost-request` fails before anything applies, `lost-answer` applies and
 * records, then fails. `holdDeletes` answers a delete `428 deletions_held` until a request
 * accepts at least that many.
 */
function fakeHost(options: { capabilities?: () => string; holdDeletes?: number } = {}) {
  const heads = new Map<string, Map<string, StoredBlob>>();
  const ledger = new Map<string, { binding: string; result: Record<string, unknown> }>();
  const faults = new Map<string, Fault[]>();
  let revision = 0;
  const bundle = (id: string) => heads.get(id) ?? (heads.set(id, new Map()), heads.get(id)!);
  const fault = (route: string, kind: Fault) => faults.set(route, [...(faults.get(route) ?? []), kind]);
  const headOf = (stored: StoredBlob | undefined) => (stored ? { version: stored.version, contentType: stored.contentType } : undefined);
  const conflict = (operationId: string, expected: { version: string | null; contentType: string | null }, actual: StoredBlob | undefined) => ({
    ok: false,
    operationId,
    error: { code: "version_conflict", message: "The file changed since it was read. Nothing was written.", retryable: false, writeState: "not_applied", expected: expected.version, actual: actual?.version ?? null, expectedContentType: expected.contentType, actualContentType: actual?.contentType ?? null },
  });
  function apply(operationId: string, bundleId: string, key: string, expected: { version: string | null; contentType: string | null }, next?: { version: string; contentType: string; bytes: Uint8Array }) {
    const files = bundle(bundleId);
    const current = files.get(key);
    const matches = expected.version === null ? current === undefined : current !== undefined && current.version === expected.version && current.contentType === expected.contentType;
    if (!matches) return conflict(operationId, expected, current);
    revision += 1;
    if (!next) {
      files.delete(key);
      return { ok: true, operationId, data: { key, version: current!.version, contentType: current!.contentType, deleted: true } };
    }
    const changed = !current || current.version !== next.version || current.contentType !== next.contentType;
    files.set(key, next);
    return { ok: true, operationId, data: { key, version: next.version, contentType: next.contentType, changed } };
  }
  const recorded = recorder(async (route, headers, body) => {
    const queued = faults.get(route)?.shift();
    if (queued === "lost-request" || queued === "throw") throw new TypeError("network failure before the host");
    const requestId = headers.get("x-superbee-write-request") ?? "";
    const binding = headers.get("x-superbee-checkout") ?? "";
    const settled = (result: Record<string, unknown>) => {
      ledger.set(requestId, { binding, result });
      if (queued === "lost-answer") throw new TypeError("connection reset after the host applied it");
      return json(result, 200, { "x-superbee-write-settled": requestId });
    };
    switch (route) {
      case "capabilities":
        return new Response(options.capabilities?.() ?? capabilitiesBody(), { status: 200, headers: { "content-type": "application/json" } });
      case "blob-create":
      case "blob-replace": {
        const known = ledger.get(requestId);
        if (known) return json(known.result, 200, { "x-superbee-write-settled": requestId });
        const key = Buffer.from(headers.get("x-superbee-blob-key")!, "base64url").toString("utf8");
        const bytes = body as Uint8Array;
        const next = { version: headers.get("x-superbee-blob-version")!, contentType: headers.get("x-superbee-content-type")!, bytes };
        assert.equal(digest(bytes), next.version, "the upload's digest header names its bytes");
        const operationId = route === "blob-create" ? "blobs.create.v1" : "blobs.replace.v1";
        const expected = route === "blob-create" ? { version: null, contentType: null } : { version: headers.get("x-superbee-expected-version"), contentType: headers.get("x-superbee-expected-content-type") };
        return settled(apply(operationId, headers.get("x-superbee-bundle")!, key, expected, next));
      }
      case "blob-delete": {
        const request = JSON.parse(body as string) as { bundleId: string; key: string; expectedVersion: string; expectedContentType: string };
        const known = ledger.get(requestId);
        if (known) return json(known.result, 200, { "x-superbee-write-settled": requestId });
        const accepted = Number(headers.get("x-superbee-accept-deletes") ?? "0");
        if (options.holdDeletes !== undefined && accepted < options.holdDeletes) {
          return json({ error: { code: "deletions_held", deletions: options.holdDeletes, baseline: 5, message: "held", retryable: false, writeState: "not_applied" } }, 428);
        }
        return settled(apply("blobs.delete.v1", request.bundleId, request.key, { version: request.expectedVersion, contentType: request.expectedContentType }));
      }
      case "outcome": {
        const known = ledger.get(requestId);
        if (!known || known.binding !== binding) return json({ schemaVersion: 1, requestId, binding, status: "absent" });
        return json({ schemaVersion: 1, requestId, binding, status: known.result.ok ? "committed" : "refused", result: known.result });
      }
      case "blob-heads": {
        const { bundleId } = JSON.parse(body as string) as { bundleId: string };
        const rows = [...bundle(bundleId).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, stored]) => ({ key, version: stored.version, contentType: stored.contentType }));
        const listingDigest = `sha256:${createHash("sha256").update(JSON.stringify([revision, rows.map((row) => [row.key, row.version, row.contentType])]), "utf8").digest("hex")}`;
        return json({ schemaVersion: 1, bundleId, revision, digest: listingDigest, total: rows.length, heads: rows, next: null });
      }
      case "blob-read": {
        const request = JSON.parse(body as string) as { bundleId: string; key: string; version: string; contentType: string };
        const stored = bundle(request.bundleId).get(request.key);
        if (!stored || stored.version !== request.version || stored.contentType !== request.contentType) {
          return json({ error: { code: "version_conflict", expected: request.version, actual: stored?.version ?? null, expectedContentType: request.contentType, actualContentType: stored?.contentType ?? null } }, 409);
        }
        return new Response(stored.bytes, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(stored.bytes.byteLength), "x-superbee-blob-version": stored.version, "x-superbee-content-type": stored.contentType } });
      }
    }
    return assert.fail(`unexpected ${route}`);
  });
  return { ...recorded, heads, ledger, fault, head: (bundleId: string, key: string) => headOf(bundle(bundleId).get(key)) };
}

const scopeOf = (bundleId = BUNDLE, origin = ORIGIN): BlobTargetScope => ({ origin, prefix: PREFIX, bundleId, workspaceSlug: null });
/** A journal row as an earlier process left it (a claim found at open is never this handle's). */
function heldRow(name: string, overrides: { state?: BlobIntentRecord["state"]; attempts?: number; origin?: string; key?: string } = {}): BlobIntentRecord {
  const request = fixture(name).request;
  const h = request.headers;
  const body = request.body ? (JSON.parse(request.body) as Record<string, string | null>) : undefined;
  const route = fixture(name).route;
  const key = overrides.key ?? (body?.key as string | undefined) ?? Buffer.from(h["x-superbee-blob-key"]!, "base64url").toString("utf8");
  const operationId = body?.operationId ?? (route.endsWith("blob-create") ? "blobs.create.v1" : "blobs.replace.v1");
  const intent =
    operationId === "blobs.delete.v1"
      ? { operationId, key, expectedVersion: body!.expectedVersion, expectedContentType: body!.expectedContentType }
      : operationId === "blobs.create.v1"
        ? { operationId, key, expectedVersion: null, expectedContentType: null, version: body?.version ?? h["x-superbee-blob-version"], contentType: body?.contentType ?? h["x-superbee-content-type"] }
        : { operationId, key, expectedVersion: body?.expectedVersion ?? h["x-superbee-expected-version"], expectedContentType: body?.expectedContentType ?? h["x-superbee-expected-content-type"], version: body?.version ?? h["x-superbee-blob-version"], contentType: body?.contentType ?? h["x-superbee-content-type"] };
  const bytes = operationId === "blobs.delete.v1" ? undefined : FIXTURE_BYTES;
  const prepared = prepareBlobIntent({ scope: scopeOf(BUNDLE, overrides.origin), intent: intent as never, identity: { requestId: h["x-superbee-write-request"]!, binding: FIXTURE_BINDING }, createdAt: "2026-10-17T03:20:00.000Z" }, bytes);
  return { recordFamily: "blob", requestId: h["x-superbee-write-request"]!, target: key, prepared, sequence: 1, attempts: overrides.attempts ?? 1, state: overrides.state ?? "in_flight", updatedAt: "2026-10-17T03:20:00.000Z" };
}
const journalWith = (...rows: BlobIntentRecord[]) => createMemoryBlobJournal({ intents: rows.map((row, at) => ({ ...row, sequence: at + 1 })), meta: [], sequence: rows.length });

// ── golden exchanges ───────────────────────────────────────────────────────────────────────

test("golden: a create commits with the exchange's headers and bytes, and leaves the journal empty", async () => {
  const name = "blob-create-200-ok";
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], "blob-create": [name] });
  const blobJournal = createMemoryBlobJournal();
  const result = await clientOf(fetch, { blobJournal }).writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expectAbsent: true }, { requestId: idOf(name) });
  assert.deepEqual(result, { requestId: idOf(name), key: CAFE, operation: "create", status: "committed", head: { key: CAFE, version: FIXTURE_VERSION, contentType: SVG }, changed: true });
  assert.deepEqual(routes(sent), ["capabilities", "blob-create"]);
  const upload = sent[1]!;
  for (const [header, value] of Object.entries(fixture(name).request.headers)) {
    if (header === "x-superbee-checkout") assert.match(upload.headers.get(header) ?? "", /^sha256:[a-f0-9]{64}$/);
    else assert.equal(upload.headers.get(header), header === "content-length" ? null : value, header);
  }
  assert.deepEqual(upload.body, FIXTURE_BYTES);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

test("golden: create conflict, read grant, replace no-op, type-only, stale type, delete and delete of absent", async () => {
  const pin = { version: FIXTURE_VERSION, contentType: SVG };
  const cases: [string, (client: ReturnType<typeof clientOf>) => Promise<unknown>, unknown][] = [
    ["blob-create-200-conflict", (c) => c.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expectAbsent: true }, { requestId: idOf("blob-create-200-conflict") }), { status: "conflict", reason: "version_conflict", actual: pin }],
    ["blob-replace-200-noop", (c) => c.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expected: pin }, { requestId: idOf("blob-replace-200-noop") }), { status: "committed", changed: false }],
    ["blob-replace-200-type-only", (c) => c.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: "application/octet-stream", expected: pin }, { requestId: idOf("blob-replace-200-type-only") }), { status: "committed", changed: true, head: { key: CAFE, version: FIXTURE_VERSION, contentType: "application/octet-stream" } }],
    ["blob-replace-200-stale-type", (c) => c.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expected: pin }, { requestId: idOf("blob-replace-200-stale-type") }), { status: "conflict", reason: "version_conflict", actual: { version: FIXTURE_VERSION, contentType: "application/octet-stream" } }],
    ["blob-delete-200-ok", (c) => c.deleteBlob(BUNDLE, { key: CAFE, expected: { version: FIXTURE_VERSION, contentType: "application/octet-stream" } }, { requestId: idOf("blob-delete-200-ok"), acceptDeletes: 100000 }), { status: "committed", head: null, operation: "delete" }],
    ["blob-delete-200-absent", (c) => c.deleteBlob(BUNDLE, { key: CAFE, expected: { version: FIXTURE_VERSION, contentType: "application/octet-stream" } }, { requestId: idOf("blob-delete-200-absent") }), { status: "conflict", reason: "version_conflict", actual: null }],
  ];
  for (const [name, run, expected] of cases) {
    const route = fixture(name).route.slice(PREFIX.length + 1);
    const { fetch, sent } = golden({ capabilities: ["capabilities-200", "capabilities-200"], [route]: [name] });
    const blobJournal = createMemoryBlobJournal();
    const result = (await run(clientOf(fetch, { blobJournal }))) as Record<string, unknown>;
    for (const [field, value] of Object.entries(expected as Record<string, unknown>)) assert.deepEqual(result[field], value, `${name} ${field}`);
    assert.equal(sent[1]!.headers.get("x-superbee-write-request"), idOf(name));
    if (route === "blob-delete") {
      assert.deepEqual(JSON.parse(sent[1]!.body as string), JSON.parse(fixture(name).request.body!));
      assert.equal(sent[1]!.headers.get("x-superbee-accept-deletes"), fixture(name).request.headers["x-superbee-accept-deletes"] ?? null);
    } else assert.deepEqual(sent[1]!.body, FIXTURE_BYTES);
    assert.deepEqual(await blobJournal.listBlobIntents(), [], `${name} settles and retires`);
  }
});

test("golden: a read grant's refusal on a first attempt is final: refused, retired, never looked up", async () => {
  const name = "blob-create-200-read-grant";
  const blobJournal = createMemoryBlobJournal();
  const { fetch, sent } = golden({ capabilities: ["capabilities-200", "capabilities-200"], "blob-create": [name] });
  const client = clientOf(fetch, { blobJournal });
  const result = await client.writeBlob(BUNDLE, { key: "reader.svg", bytes: FIXTURE_BYTES, contentType: SVG, expectAbsent: true }, { requestId: idOf(name) });
  assert.deepEqual(result, { requestId: idOf(name), key: "reader.svg", operation: "create", status: "refused", code: "insufficient_scope", message: JSON.parse(fixture(name).response.body!).error.message });
  assert.deepEqual(blobRoutes(sent), ["blob-create"]);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

test("golden: a 400 answer is never a terminal blob answer: it is looked up, and absent stays unknown and held", async () => {
  const name = "blob-create-400-digest";
  const blobJournal = createMemoryBlobJournal();
  let binding = "";
  const { fetch, sent } = golden({
    capabilities: ["capabilities-200"],
    "blob-create": [name],
    outcome: [() => replay("blob-outcome-200-absent", (body) => body.replace(idOf("blob-outcome-200-absent"), idOf(name)).replace(FIXTURE_BINDING, binding))],
  });
  const client = clientOf(fetch, { blobJournal, writeRecovery: { lookupDelayMs: 0 } });
  const original = blobJournal.admitPreparedBlob.bind(blobJournal);
  blobJournal.admitPreparedBlob = async (prepared, options) => {
    binding = (JSON.parse(prepared) as { identity: { binding: string } }).identity.binding;
    return original(prepared, options);
  };
  const result = await client.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expectAbsent: true }, { requestId: idOf(name) });
  assert.equal(result.status, "unknown");
  assert.deepEqual(blobRoutes(sent).slice(0, 2), ["blob-create", "outcome"]);
  const [held] = await client.heldBlobWrites();
  assert.equal(held?.state, "unknown");
  assert.equal(held?.attempts, 1);
  assert.equal(held?.resendable, false);
});

test("golden: outcome answers settle a claim found at open: original commits and retires, refused conflicts, absent, malformed and forbidden stay unknown", async () => {
  const rows: [string, string, string | null][] = [
    ["blob-outcome-200-original", "blob-create-200-ok", "committed"],
    ["blob-outcome-200-refused", "blob-replace-200-stale-type", "conflict"],
    ["blob-outcome-200-absent", "blob-create-200-ok", "unknown"],
    ["blob-outcome-400-malformed", "blob-create-200-ok", "unknown"],
    ["blob-outcome-403-read-grant", "blob-create-200-ok", "unknown"],
  ];
  for (const [outcome, written, status] of rows) {
    const row = heldRow(written);
    const blobJournal = journalWith(row);
    const answer = () => replay(outcome, (body) => body.replace(idOf(outcome), row.requestId));
    const { fetch, sent } = golden({ capabilities: ["capabilities-200"], outcome: [answer, answer, answer] });
    const result = await clientOf(fetch, { blobJournal }).settleBlobWrite(row.requestId);
    assert.equal(result.status, status, outcome);
    assert.ok(blobRoutes(sent).every((route) => route === "outcome"), `${outcome}: lookups only, never an upload`);
    assert.ok(sent.filter((s) => s.route === "outcome").every((s) => s.headers.get("x-superbee-checkout") === FIXTURE_BINDING), "the binding recorded with the write");
    const left = await blobJournal.listBlobIntents();
    if (status === "unknown") assert.equal(left[0]?.state, "unknown");
    else assert.deepEqual(left, [], `${outcome} retires`);
  }
});

test("golden: readBlob verifies the pinned bytes; a stale pin reads null; a refused read is the host's error; blobHead lists", async () => {
  const pin = { version: FIXTURE_VERSION, contentType: SVG };
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], "blob-read": ["blob-read-200-binary", "blob-read-409-stale-type", "blob-read-400-view"] });
  const client = clientOf(fetch);
  const read = await client.readBlob(BUNDLE, CAFE, { pin });
  assert.deepEqual({ ...read!, bytes: [...read!.bytes] }, { key: CAFE, ...pin, bytes: [...FIXTURE_BYTES] });
  assert.deepEqual(JSON.parse(sent[1]!.body as string), JSON.parse(fixture("blob-read-200-binary").request.body!));
  assert.equal(await client.readBlob(BUNDLE, CAFE, { pin }), null);
  await assert.rejects(client.readBlob(BUNDLE, "views/private.html", { pin }), (error: unknown) => error instanceof RemoteError && error.code === "invalid_input");
  // The pin is required: a read never guesses the head it reads.
  await assert.rejects(async () => client.readBlob(BUNDLE, CAFE, undefined as never), TypeError);
  await assert.rejects(async () => client.readBlob(BUNDLE, CAFE, {} as never), TypeError);
});

test("golden: blobHeads restarts a listing the host moved, and blobHead answers the head or null", async () => {
  const listing = (heads: { key: string; version: string; contentType: string }[]) => () => {
    const rowsDigest = `sha256:${createHash("sha256").update(JSON.stringify([6, heads.map((h) => [h.key, h.version, h.contentType])]), "utf8").digest("hex")}`;
    return json({ schemaVersion: 1, bundleId: BUNDLE, revision: 6, digest: rowsDigest, total: heads.length, heads, next: null });
  };
  const head = { key: CAFE, version: FIXTURE_VERSION, contentType: SVG };
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], "blob-heads": ["blob-heads-200-page", "blob-heads-409-moved", listing([head]), listing([head])] });
  const client = clientOf(fetch);
  assert.deepEqual((await client.blobHeads(BUNDLE)).heads, [head]);
  assert.deepEqual(JSON.parse(sent[2]!.body as string), JSON.parse(fixture("blob-heads-409-moved").request.body!));
  assert.equal(await client.blobHead(BUNDLE, "missing.svg"), null);
});

// ── the capability gate ────────────────────────────────────────────────────────────────────

test("gate: a host refusing blob writes, or one from before them, throws HostedBlobWritesNotServed with no blob request and nothing journaled", async () => {
  const hosts = [
    capabilitiesBody((caps) => { caps.blobWrites = "refused"; }),
    capabilitiesBody((caps) => { delete caps.blobWrites; delete caps.blobReads; delete (caps.limits as Record<string, unknown>).blobWriteBytes; }),
  ];
  for (const body of hosts) {
    const blobJournal = createMemoryBlobJournal();
    const { fetch, sent } = recorder(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    const client = clientOf(fetch, { blobJournal });
    for (const call of [
      () => client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true }),
      () => client.deleteBlob(BUNDLE, { key: "a.svg", expected: { version: FIXTURE_VERSION, contentType: SVG } }),
    ]) {
      await assert.rejects(call(), (error: unknown) => error instanceof HostedBlobWritesNotServed && error instanceof HostedRouteNotServed && isRouteNotServed(error) && error.status === 404);
    }
    assert.deepEqual(blobRoutes(sent), []);
    assert.deepEqual(await blobJournal.listBlobIntents(), []);
  }
  // A held answer serves the gate: with it fresh, the refusal costs zero requests.
  const { fetch, sent } = recorder(() => new Response(hosts[0]!, { status: 200, headers: { "content-type": "application/json" } }));
  const client = clientOf(fetch);
  await assert.rejects(client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true }), HostedBlobWritesNotServed);
  const before = sent.length;
  await assert.rejects(client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true }), HostedBlobWritesNotServed);
  assert.equal(sent.length, before);
});

test("gate: an oversized body or an unsafe key is refused before admission; a capability flip cannot strand a claim", async () => {
  const small = capabilitiesBody((caps) => { (caps.limits as Record<string, number>).blobWriteBytes = 4; });
  const host = fakeHost({ capabilities: () => small });
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(host.fetch, { blobJournal });
  const oversized = await client.writeBlob(BUNDLE, { key: "big.bin", bytes: new Uint8Array(5), contentType: "application/octet-stream", expectAbsent: true });
  assert.equal(oversized.status, "refused");
  assert.equal(oversized.status === "refused" && oversized.code, "invalid_input");
  const unsafe = await client.writeBlob(BUNDLE, { key: "../escape.svg", bytes: new Uint8Array(1), contentType: SVG, expectAbsent: true });
  assert.equal(unsafe.status === "refused" && unsafe.code, "invalid_input");
  assert.deepEqual(blobRoutes(host.sent), []);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);

  // The host flips to refusing blob writes after the gate read: the adapter is handed the gate's
  // own answer, so it neither reads again nor refuses inside the send after the claim.
  let flips = 0;
  const flipping = fakeHost({ capabilities: () => (flips++ === 0 ? capabilitiesBody() : capabilitiesBody((caps) => { caps.blobWrites = "refused"; })) });
  const flipped = createMemoryBlobJournal();
  const result = await clientOf(flipping.fetch, { blobJournal: flipped, capabilitiesTtlMs: 0 }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true });
  assert.equal(result.status, "committed");
  assert.deepEqual(routes(flipping.sent), ["capabilities", "blob-create"]);
  assert.deepEqual(await flipped.listBlobIntents(), []);
});

test("gate: a capability downgraded within the TTL is learned from the refusal; the next write reads again and is not served", async () => {
  let downgraded = false;
  const host = fakeHost({ capabilities: () => capabilitiesBody((caps) => { if (downgraded) caps.blobWrites = "refused"; }) });
  const readGrant = fixture("blob-create-200-read-grant").response.body!;
  // Once downgraded, the host refuses an upload as a read grant: final on a first attempt.
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (downgraded && String(input).endsWith("/blob-create")) {
      const id = new Headers(init?.headers).get("x-superbee-write-request")!;
      return new Response(readGrant, { status: 200, headers: { "content-type": "application/json", "x-superbee-write-settled": id } });
    }
    return host.fetch(input, init);
  }) as typeof globalThis.fetch;
  const client = clientOf(fetch);
  assert.equal((await client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true })).status, "committed");
  downgraded = true;
  // Still within the TTL: the held answer says allowed, so this one is sent and the host refuses it.
  const refused = await client.writeBlob(BUNDLE, { key: "b.svg", bytes: text("1"), contentType: SVG, expectAbsent: true });
  assert.equal(refused.status === "refused" && refused.code, "insufficient_scope");
  // That refusal dropped the held capabilities: the next write reads them again and is not served.
  await assert.rejects(client.writeBlob(BUNDLE, { key: "c.svg", bytes: text("1"), contentType: SVG, expectAbsent: true }), HostedBlobWritesNotServed);
  assert.deepEqual(routes(host.sent), ["capabilities", "blob-create", "capabilities"]);
  assert.deepEqual(await client.heldBlobWrites(), []);
});

// ── refusals the host never records ────────────────────────────────────────────────────────

const unrecorded: [string, number, Record<string, unknown>][] = [
  ["insufficient_scope", 200, { code: "insufficient_scope", message: "no grant", retryable: false, writeState: "not_applied" }],
  ["bundle_not_found", 200, { code: "bundle_not_found", message: "no bundle", retryable: false, writeState: "not_applied" }],
  ["request_capacity", 200, { code: "request_capacity", message: "quota", retryable: false, writeState: "not_applied", scope: "bundle" }],
  ["request_capacity", 429, { code: "request_capacity", message: "quota", retryable: false, writeState: "not_applied", scope: "principal", resetAt: "2026-10-18T00:00:00Z" }],
];
/** The fake host, refusing the next `count` uploads with `refusal` before dispatch. */
function refusingHost(status: number, error: Record<string, unknown>, count = 1) {
  const host = fakeHost();
  let left = count;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (left > 0 && String(input).endsWith("/blob-create")) {
      left -= 1;
      host.sent.push({ route: "blob-create", headers: new Headers(init?.headers), body: "" });
      return status === 200 ? json({ ok: false, operationId: "blobs.create.v1", error }) : json({ error }, status);
    }
    return host.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { host, fetch };
}

test("unrecorded refusals: each code on a first attempt is refused and retired, and the key takes the next write", async () => {
  for (const [code, status, error] of unrecorded) {
    const { host, fetch } = refusingHost(status, error);
    const blobJournal = createMemoryBlobJournal();
    const client = clientOf(fetch, { blobJournal });
    const result = await client.writeBlob(BUNDLE, { key: "k.svg", bytes: text("1"), contentType: SVG, expectAbsent: true });
    assert.equal(result.status === "refused" && result.code, code, `${status} ${code}`);
    assert.deepEqual(blobRoutes(host.sent), ["blob-create"], "never looked up");
    assert.deepEqual(await blobJournal.listBlobIntents(), [], "retired");
    const next = await client.writeBlob(BUNDLE, { key: "k.svg", bytes: text("1"), contentType: SVG, expectAbsent: true });
    assert.equal(next.status, "committed", `${status} ${code}: the key is free`);
  }
});

test("unrecorded refusals: after an earlier unclear attempt the write stays unknown; it is only looked up, never re-uploaded", async () => {
  for (const [code, status, error] of unrecorded) {
    const { host, fetch } = refusingHost(status, error, 10);
    host.fault("outcome", "throw");
    host.fault("outcome", "throw");
    host.fault("outcome", "throw");
    const blobJournal = createMemoryBlobJournal();
    // The first attempt is unclear: the request may have reached the host.
    let first = true;
    const unclearFirst = (async (input: string | URL | Request, init?: RequestInit) => {
      if (first && String(input).endsWith("/blob-create")) {
        first = false;
        throw new TypeError("connection reset");
      }
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const client = clientOf(unclearFirst, { blobJournal });
    const written = await client.writeBlob(BUNDLE, { key: "k.svg", bytes: text("1"), contentType: SVG, expectAbsent: true });
    assert.equal(written.status, "unknown", code);
    host.sent.length = 0;
    assert.equal((await client.settleBlobWrite(written.requestId)).status, "unknown", `${status} ${code}`);
    assert.deepEqual(blobRoutes(host.sent), ["outcome"], "the refusing upload route is never asked again");
    assert.equal((await blobJournal.listBlobIntents())[0]?.state, "unknown");
  }
});

// ── may have been sent: never rolled back ──────────────────────────────────────────────────

/** The record is held lookup-only: never pending, never with non-execution evidence. */
async function lookupOnly(journal: BlobJournaledBackend, label: string): Promise<BlobIntentRecord> {
  const [row] = await journal.listBlobIntents();
  assert.ok(row, `${label}: the record is held`);
  assert.ok(row.state === "in_flight" || row.state === "unknown", `${label}: state ${row.state} must be in_flight or unknown`);
  assert.equal(row.notAppliedThrough, undefined, `${label}: never proven not applied`);
  assert.equal(row.notDispatched, undefined, `${label}: no not_dispatched evidence`);
  return row;
}

test("may have been sent: a caller abort while fetch holds the bytes is unknown and lookup-only, not not-dispatched", async () => {
  const host = fakeHost();
  const controller = new AbortController();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/blob-create")) return host.fetch(input, init);
    // The upload reached fetch: its bytes may be on the wire. The caller aborts now; fetch honours it.
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      queueMicrotask(() => controller.abort());
    });
  }) as typeof globalThis.fetch;
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(fetch, { blobJournal });
  const result = await client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true }, { signal: controller.signal });
  assert.equal(result.status, "unknown");
  const row = await lookupOnly(blobJournal, "abort after fetch");
  host.sent.length = 0;
  assert.equal((await client.settleBlobWrite(row.requestId)).status, "unknown");
  assert.deepEqual(blobRoutes(host.sent), ["outcome"], "settled by lookup, never re-uploaded");
});

test("may have been sent: a fetch that ignores the abort past the settle wait is unknown and lookup-only", { timeout: 20_000 }, async () => {
  const host = fakeHost();
  const controller = new AbortController();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/blob-create")) return host.fetch(input, init);
    queueMicrotask(() => controller.abort());
    return new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new TypeError("socket closed")), 2500));
  }) as typeof globalThis.fetch;
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(fetch, { blobJournal });
  const result = await client.writeBlob(BUNDLE, { key: "b.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true }, { signal: controller.signal });
  assert.equal(result.status, "unknown");
  const row = await lookupOnly(blobJournal, "fetch outlives the wait");
  await new Promise((resolve) => setTimeout(resolve, 2700));
  host.sent.length = 0;
  assert.equal((await client.settleBlobWrite(row.requestId)).status, "unknown");
  assert.deepEqual(blobRoutes(host.sent), ["outcome"]);
});

test("may have been sent: a delivery that throws after the upload reached the carrier is not rolled back", async () => {
  const { fetch, sent } = recorder(() => { throw new TypeError("connection reset after send"); });
  const carrier = createFetchCarrier({ baseUrl: ORIGIN, credentials: async () => ({ Authorization: "Bearer ok" }), fetch });
  const journal = createMemoryBlobJournal();
  const requestId = "4a2f9c1e-8b3d-4e6f-9a1b-0000000000d1";
  const prepared = prepareBlobIntent({ scope: scopeOf(), intent: { operationId: "blobs.create.v1", key: "d.svg", expectedVersion: null, expectedContentType: null, version: digest(text("1")), contentType: SVG }, identity: { requestId, binding: FIXTURE_BINDING }, createdAt: new Date().toISOString() }, text("1"));
  const capabilities = decodeHostedCapabilities(JSON.parse(capabilitiesBody()));
  let sleeps = 0;
  // The wait between lookups fails: the delivery throws after its send.
  const sleep = async () => { sleeps += 1; throw new Error("timer failed"); };
  await assert.rejects(driveJournaledBlob(journal, { scope: scopeOf(), carrier, capabilities: async () => capabilities, delivery: { sleep, lookupDelayMs: 1 } }, requestId, { start: "admit", prepared }), /timer failed/);
  assert.ok(routes(sent).includes("blob-create"), "the upload reached fetch");
  assert.ok(sleeps > 0);
  assert.equal((await lookupOnly(journal, "throw after send")).state, "in_flight");
});

// ── durability: fsync failures and a process that dies after its claim ─────────────────────

async function failingBackend(failAtSync: number) {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-write-"));
  let syncs = 0;
  const backend = await FileJournaledBackend[OPEN_LOG]({ directory: path.join(base, "journal"), lock: { lockRoot: path.join(base, "locks"), waitMs: 0 } }, async (file): Promise<FileJournalHandle> => {
    const real = await fs.open(file, "r+");
    return {
      write: (buffer, offset, length, position) => real.write(buffer, offset, length, position),
      async sync() {
        syncs += 1;
        if (syncs === failAtSync) throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
        return real.sync();
      },
      truncate: (length) => real.truncate(length),
      close: () => real.close(),
    };
  });
  return { backend, cleanup: async () => { await backend.close().catch(() => {}); await fs.rm(base, { recursive: true, force: true }); } };
}

test("durability: an fsync failure at admission or at the claim sends nothing", async () => {
  for (const failAtSync of [1, 2]) {
    const { backend, cleanup } = await failingBackend(failAtSync);
    try {
      const host = fakeHost();
      await assert.rejects(clientOf(host.fetch, { blobJournal: backend }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true }), /fsync|unavailable|cannot tell/i);
      assert.deepEqual(blobRoutes(host.sent), [], `fsync ${failAtSync}: no upload`);
      assert.equal(host.head(BUNDLE, "a.svg"), undefined);
    } finally {
      await cleanup();
    }
  }
});

test("durability: die after the claim; a new client with a new binding settles by lookup only, under the old binding", async () => {
  for (const recorded of [false, true]) {
    const host = fakeHost();
    const first = createMemoryBlobJournal();
    let crashed: ReturnType<MemoryBlobJournal["exportState"]> | undefined;
    const dying = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/blob-create")) {
        crashed = first.exportState();
        if (recorded) host.fault("blob-create", "lost-answer");
        else throw new TypeError("the process died before the request left");
      }
      if (crashed && !String(input).endsWith("/blob-create")) throw new TypeError("the process is gone");
      return host.fetch(input, init);
    }) as typeof globalThis.fetch;
    await clientOf(dying, { blobJournal: first }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true });
    const claim = crashed!.intents[0]!;
    assert.equal(claim.state, "in_flight");
    const oldBinding = (JSON.parse(claim.prepared) as { identity: { binding: string } }).identity.binding;
    host.sent.length = 0;

    const reopened = createMemoryBlobJournal(crashed);
    const second = clientOf(host.fetch, { blobJournal: reopened, credentials: bearerCredentials(() => "token-2") });
    const [held] = await second.heldBlobWrites();
    assert.equal(held?.state, "in_flight");
    const settled = await second.settleBlobWrite(claim.requestId);
    assert.ok(blobRoutes(host.sent).every((route) => route === "outcome"), "no upload is ever resent");
    assert.ok(host.sent.filter((s) => s.route === "outcome").every((s) => s.headers.get("x-superbee-checkout") === oldBinding && s.headers.get("authorization") === "Bearer token-2"));
    if (recorded) {
      assert.equal(settled.status, "committed");
      assert.deepEqual(await reopened.listBlobIntents(), []);
    } else {
      assert.equal(settled.status, "unknown");
      assert.equal((await reopened.listBlobIntents())[0]?.state, "unknown");
    }
  }
});

test("durability: the Node journal holds a claim across a crash, and a new process settles it by lookup", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-node-"));
  const directory = path.join(base, "journal");
  const open = () => openHostedClientJournalWith({ directory, lock: { waitMs: 0 } }, { lockRoot: path.join(base, "locks") });
  try {
    const host = fakeHost();
    const journal = await open();
    const dying = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/blob-create")) {
        host.fault("blob-create", "lost-answer");
        await host.fetch(input, init).catch(() => {});
        await journal.close();
        throw new TypeError("the process died");
      }
      if (String(input).endsWith("/outcome")) throw new TypeError("the process is gone");
      return host.fetch(input, init);
    }) as typeof globalThis.fetch;
    const first = await clientOf(dying, { intentStore: journal, blobJournal: journal.blobs }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true });
    assert.equal(first.status, "unknown");
    host.sent.length = 0;

    const reopened = await open();
    try {
      const second = clientOf(host.fetch, { intentStore: reopened, blobJournal: reopened.blobs });
      const [held] = await second.heldBlobWrites();
      assert.equal(held?.state, "in_flight");
      assert.equal((await second.settleBlobWrite(held!.requestId)).status, "committed");
      assert.deepEqual(blobRoutes(host.sent), ["outcome"]);
      assert.deepEqual(await second.heldBlobWrites(), []);
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("durability: a lost acknowledgement settles to committed by lookup, with one upload", async () => {
  const host = fakeHost();
  host.fault("blob-create", "lost-answer");
  const blobJournal = createMemoryBlobJournal();
  const result = await clientOf(host.fetch, { blobJournal }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true });
  assert.equal(result.status, "committed");
  assert.deepEqual(blobRoutes(host.sent), ["blob-create", "outcome"]);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

// ── not dispatched: rolled back to resendable ──────────────────────────────────────────────

test("not dispatched: credentials denied after the claim roll it back to pending; settle sends it once", async () => {
  const host = fakeHost();
  let deny = false;
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(host.fetch, {
    blobJournal,
    credentials: async () => {
      if (deny) throw new Error("token expired");
      return { Authorization: "Bearer ok" };
    },
  });
  await client.blobHeads(BUNDLE); // read the capabilities while the credential is good
  deny = true;
  await assert.rejects(client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true }), (error: unknown) => error instanceof HostedBlobWriteNotSent && error.reason === "credentials_unavailable" && error.held);
  assert.deepEqual(blobRoutes(host.sent), ["blob-heads"], "nothing else left");
  const [row] = await blobJournal.listBlobIntents();
  assert.deepEqual({ state: row?.state, attempts: row?.attempts, notAppliedThrough: row?.notAppliedThrough, notDispatched: row?.notDispatched }, { state: "pending", attempts: 1, notAppliedThrough: 1, notDispatched: { code: "credentials_unavailable" } });
  const [held] = await client.heldBlobWrites();
  assert.equal(held?.resendable, true);
  assert.equal((await client.lookupBlobWrite(row!.requestId)).status, "pending", "a lookup of a write never sent asks nothing");
  deny = false;
  assert.equal((await client.settleBlobWrite(row!.requestId)).status, "committed");
  assert.deepEqual(blobRoutes(host.sent), ["blob-heads", "blob-create"]);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

test("not dispatched: a signal aborted after the claim (before or inside the carrier) rolls it back, nothing sent", async () => {
  // Aborted by the journal's claim itself: the delivery never reaches the adapter.
  {
    const host = fakeHost();
    const blobJournal = createMemoryBlobJournal();
    const controller = new AbortController();
    const update = blobJournal.updateBlobIntent.bind(blobJournal);
    blobJournal.updateBlobIntent = async (...args) => {
      const row = await update(...args);
      if (row.state === "in_flight") controller.abort();
      return row;
    };
    await assert.rejects(clientOf(host.fetch, { blobJournal }).writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true }, { signal: controller.signal }), (error: unknown) => error instanceof HostedBlobWriteNotSent && error.reason === "aborted" && error.held);
    assert.deepEqual(blobRoutes(host.sent), []);
    assert.equal((await blobJournal.listBlobIntents())[0]?.state, "pending");
  }
  // Aborted while the carrier asks for the credential: the carrier's denied, before fetch.
  {
    const host = fakeHost();
    const blobJournal = createMemoryBlobJournal();
    const controller = new AbortController();
    let calls = 0;
    const client = clientOf(host.fetch, {
      blobJournal,
      credentials: async () => {
        if (++calls === 2) controller.abort();
        return { Authorization: "Bearer ok" };
      },
    });
    await assert.rejects(client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true }, { signal: controller.signal }), (error: unknown) => error instanceof HostedBlobWriteNotSent && error.reason === "aborted");
    assert.deepEqual(blobRoutes(host.sent), []);
    const [row] = await blobJournal.listBlobIntents();
    assert.deepEqual([row?.state, row?.notDispatched?.code], ["pending", "aborted"]);
    assert.equal((await client.settleBlobWrite(row!.requestId)).status, "committed");
  }
});

test("not dispatched: a transport failure after the carrier was asked is unknown and lookup-only, never rolled back", async () => {
  const host = fakeHost();
  host.fault("blob-create", "lost-request");
  host.fault("outcome", "throw");
  host.fault("outcome", "throw");
  host.fault("outcome", "throw");
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(host.fetch, { blobJournal });
  const result = await client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true });
  assert.equal(result.status, "unknown");
  const [row] = await blobJournal.listBlobIntents();
  assert.deepEqual([row?.state, row?.attempts, row?.notAppliedThrough], ["unknown", 1, undefined]);
  host.sent.length = 0;
  assert.equal((await client.settleBlobWrite(row!.requestId)).status, "unknown", "absent never permits a resend");
  assert.deepEqual(blobRoutes(host.sent), ["outcome"]);
});

// ── held deletes ───────────────────────────────────────────────────────────────────────────

test("held delete: held; settle without acceptance sends nothing; too few is a typed refusal; enough submits it", async () => {
  const name = "blob-delete-428-held";
  const request = JSON.parse(fixture(name).request.body!) as { key: string; expectedVersion: string; expectedContentType: string };
  const requestId = idOf(name);
  const deleted = () =>
    json({ ok: true, operationId: "blobs.delete.v1", data: { key: request.key, version: request.expectedVersion, contentType: request.expectedContentType, deleted: true } }, 200, { "x-superbee-write-settled": requestId });
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], "blob-delete": [name, deleted] });
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(fetch, { blobJournal });
  const held = await client.deleteBlob(BUNDLE, { key: request.key, expected: { version: request.expectedVersion, contentType: request.expectedContentType } }, { requestId });
  assert.deepEqual(held, { requestId, key: request.key, operation: "delete", status: "held", deletions: 3, baseline: 5 });
  assert.deepEqual(JSON.parse(sent[1]!.body as string), JSON.parse(fixture(name).request.body!));
  assert.deepEqual((await client.heldBlobWrites())[0]?.hold, { deletions: 3, baseline: 5 });

  const before = sent.length;
  assert.equal((await client.settleBlobWrite(requestId)).status, "held");
  assert.equal((await client.lookupBlobWrite(requestId)).status, "held");
  await assert.rejects(client.settleBlobWrite(requestId, { acceptDeletes: 2 }), (error: unknown) => error instanceof HostedBlobDeletionsNotAccepted && error.deletions === 3 && error.accepted === 2);
  assert.equal(sent.length, before, "nothing was sent");
  const settled = await client.settleBlobWrite(requestId, { acceptDeletes: 3 });
  assert.equal(settled.status, "committed");
  assert.equal(sent.at(-1)!.headers.get("x-superbee-accept-deletes"), "3");
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

// ── serialization and identities ───────────────────────────────────────────────────────────

test("concurrency: same-key writes in one bundle, across two bundles, and across two clients sharing a journal never leak a guard conflict", async () => {
  const host = fakeHost();
  // A fixed, uneven delay pattern interleaves the calls the same way on every run.
  const delays = [3, 0, 5, 1, 4, 2];
  let request = 0;
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, delays[request++ % delays.length]));
    return host.fetch(input, init);
  }) as typeof globalThis.fetch;
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(slow, { blobJournal });
  const write = (c: ReturnType<typeof clientOf>, bundleId: string, body: string) => c.writeBlob(bundleId, { key: "same.svg", bytes: text(body), contentType: SVG, expectAbsent: true });
  const sameBundle = await Promise.all([write(client, BUNDLE, "a"), write(client, BUNDLE, "b")]);
  assert.deepEqual(sameBundle.map((r) => r.status).sort(), ["committed", "conflict"]);
  const twoBundles = await Promise.all([write(client, "notes.b", "a"), write(client, "notes.c", "b")]);
  assert.deepEqual(twoBundles.map((r) => r.status), ["committed", "committed"]);
  // Two clients share one journal but not their per-key chains: their transactions move each
  // other's guard, and the owner reads again rather than failing.
  let absorbed = 0;
  for (const verb of ["admitPreparedBlob", "updateBlobIntent", "retireBlobIntents"] as const) {
    const original = (blobJournal[verb] as (...args: unknown[]) => Promise<unknown>).bind(blobJournal);
    (blobJournal as unknown as Record<string, unknown>)[verb] = async (...args: unknown[]) => {
      try {
        return await original(...args);
      } catch (error) {
        if (error instanceof JournalGuardConflict) absorbed += 1;
        throw error;
      }
    };
  }
  // Widen the gap between each guard read and its transaction, so the other client's lands in it.
  const read = blobJournal.readBlobWithJournal.bind(blobJournal);
  let reads = 0;
  blobJournal.readBlobWithJournal = async (...args) => {
    const snapshot = await read(...args);
    await new Promise((resolve) => setTimeout(resolve, delays[reads++ % delays.length]));
    return snapshot;
  };
  const other = clientOf(slow, { blobJournal });
  const shared = await Promise.all(["notes.d", "notes.e", "notes.f", "notes.g"].map((bundleId, at) => write(at % 2 ? other : client, bundleId, bundleId)));
  assert.deepEqual(shared.map((r) => r.status), ["committed", "committed", "committed", "committed"]);
  assert.ok(absorbed > 0, "the shared journal's guard moved under a transaction at least once");
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

test("concurrency: an unknown write holds its (bundle, key); a second write there is refused unsettled_write, other bundles are not", async () => {
  const host = fakeHost();
  host.fault("blob-create", "lost-request");
  for (let i = 0; i < 3; i++) host.fault("outcome", "throw");
  const client = clientOf(host.fetch);
  assert.equal((await client.writeBlob(BUNDLE, { key: "k.svg", bytes: text("1"), contentType: SVG, expectAbsent: true })).status, "unknown");
  const blocked = await client.writeBlob(BUNDLE, { key: "k.svg", bytes: text("2"), contentType: SVG, expectAbsent: true });
  assert.equal(blocked.status === "refused" && blocked.code, "unsettled_write");
  assert.equal((await client.writeBlob("notes.b", { key: "k.svg", bytes: text("2"), contentType: SVG, expectAbsent: true })).status, "committed");
});

test("identity: a reused request id with the same input settles the held write; with other input it is refused, nothing admitted or sent", async () => {
  const host = fakeHost();
  host.fault("blob-create", "lost-answer");
  host.fault("outcome", "throw");
  host.fault("outcome", "throw");
  host.fault("outcome", "throw");
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(host.fetch, { blobJournal });
  const input = { key: "a.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true as const };
  const first = await client.writeBlob(BUNDLE, input);
  assert.equal(first.status, "unknown");
  host.sent.length = 0;
  for (const different of [
    () => client.writeBlob(BUNDLE, { ...input, bytes: text("<svg>other</svg>") }, { requestId: first.requestId }),
    () => client.writeBlob("notes.b", input, { requestId: first.requestId }),
    () => client.deleteBlob(BUNDLE, { key: "a.svg", expected: { version: digest(input.bytes), contentType: SVG } }, { requestId: first.requestId }),
  ]) {
    const refused = await different();
    assert.equal(refused.status === "refused" && refused.code, "invalid_input");
  }
  assert.deepEqual(host.sent, []);
  assert.equal((await blobJournal.listBlobIntents()).length, 1);
  const again = await client.writeBlob(BUNDLE, input, { requestId: first.requestId });
  assert.equal(again.status, "committed");
  assert.deepEqual(blobRoutes(host.sent), ["outcome"], "settled by lookup, never re-uploaded");
});

test("scope: a record of another origin is refused scope_mismatch without a request", async () => {
  const row = heldRow("blob-create-200-ok", { state: "unknown", origin: "https://other.example" });
  const { fetch, sent } = recorder(() => assert.fail("nothing is sent"));
  const client = clientOf(fetch, { blobJournal: journalWith(row) });
  const reused = await client.writeBlob(BUNDLE, { key: CAFE, bytes: FIXTURE_BYTES, contentType: SVG, expectAbsent: true }, { requestId: row.requestId });
  assert.equal(reused.status === "refused" && reused.code, "scope_mismatch", "a reused identity recorded for another target");
  for (const call of [() => client.settleBlobWrite(row.requestId), () => client.lookupBlobWrite(row.requestId)]) {
    const result = await call();
    assert.equal(result.status === "refused" && result.code, "scope_mismatch");
  }
  assert.equal((await client.forgetBlobWrite(row.requestId)).status, "refused");
  assert.deepEqual(sent, []);
  assert.equal((await client.lookupBlobWrite("4a2f9c1e-8b3d-4e6f-9a1b-0000000000ff")).status, "unrecorded");
});

// ── forget ─────────────────────────────────────────────────────────────────────────────────

test("forget: only an unknown write, only after one lookup answers absent; a found outcome settles instead", async () => {
  const absentRow = heldRow("blob-create-200-ok", { state: "unknown" });
  const pending = heldRow("blob-replace-200-noop", { state: "pending", attempts: 0 });
  const inFlight = heldRow("blob-delete-200-ok", { state: "in_flight" });
  const outcome = (name: string, row: BlobIntentRecord) => () => replay(name, (body) => body.replace(idOf(name), row.requestId));
  // Absent: forgotten, and the key is free for a new write.
  {
    const blobJournal = journalWith(absentRow, pending, inFlight);
    const { fetch, sent } = golden({ capabilities: ["capabilities-200"], outcome: [outcome("blob-outcome-200-absent", absentRow)], "blob-create": [() => json({ ok: true, operationId: "blobs.create.v1", data: { key: CAFE, version: FIXTURE_VERSION, contentType: SVG, changed: true } }, 200, { "x-superbee-write-settled": "x" })] });
    const client = clientOf(fetch, { blobJournal });
    assert.deepEqual(await client.forgetBlobWrite(pending.requestId), { requestId: pending.requestId, key: CAFE, operation: "replace", status: "kept", reason: "not_unknown", state: "pending" });
    assert.equal((await client.forgetBlobWrite(inFlight.requestId)).status, "kept");
    assert.deepEqual(sent, []);
    assert.deepEqual(await client.forgetBlobWrite(absentRow.requestId), { requestId: absentRow.requestId, key: CAFE, operation: "create", status: "forgotten" });
    assert.deepEqual(blobRoutes(sent), ["outcome"]);
    assert.equal(sent.find((s) => s.route === "outcome")!.headers.get("x-superbee-checkout"), FIXTURE_BINDING);
    assert.equal(await blobJournal.readBlobIntent(absentRow.requestId), undefined);
  }
  // Unavailable or refused lookups keep it.
  for (const answer of [() => { throw new TypeError("offline"); }, () => replay("blob-outcome-403-read-grant"), () => replay("blob-outcome-400-malformed")]) {
    const blobJournal = journalWith(absentRow);
    const { fetch } = golden({ capabilities: ["capabilities-200"], outcome: [answer] });
    const kept = await clientOf(fetch, { blobJournal }).forgetBlobWrite(absentRow.requestId);
    assert.equal(kept.status === "kept" && kept.reason, "lookup_unavailable");
    assert.equal((await blobJournal.readBlobIntent(absentRow.requestId))?.state, "unknown");
  }
  // A recorded outcome is settled and retired, never forgotten.
  {
    const blobJournal = journalWith(absentRow);
    const { fetch, sent } = golden({ capabilities: ["capabilities-200"], outcome: [outcome("blob-outcome-200-original", absentRow)] });
    assert.equal((await clientOf(fetch, { blobJournal }).forgetBlobWrite(absentRow.requestId)).status, "committed");
    assert.deepEqual(blobRoutes(sent), ["outcome"], "one lookup");
    assert.deepEqual(await blobJournal.listBlobIntents(), []);
  }
});

test("forget: writeBlob with a forgotten identity uploads it again under that identity, and the host settles it once", async () => {
  const host = fakeHost();
  host.fault("blob-create", "lost-request");
  for (let i = 0; i < 3; i++) host.fault("outcome", "throw");
  const blobJournal = createMemoryBlobJournal();
  const client = clientOf(host.fetch, { blobJournal });
  const input = { key: "f.svg", bytes: text("<svg/>"), contentType: SVG, expectAbsent: true as const };
  const first = await client.writeBlob(BUNDLE, input);
  assert.equal(first.status, "unknown");
  assert.equal((await client.forgetBlobWrite(first.requestId)).status, "forgotten");
  host.sent.length = 0;
  const again = await client.writeBlob(BUNDLE, input, { requestId: first.requestId });
  assert.equal(again.status, "committed");
  assert.deepEqual(blobRoutes(host.sent), ["blob-create"]);
  assert.equal(host.sent[0]!.headers.get("x-superbee-write-request"), first.requestId);
  assert.deepEqual(await blobJournal.listBlobIntents(), []);
});

test("forget: the journal itself refuses to forget anything but an unknown, unproven record", async () => {
  for (const row of [heldRow("blob-create-200-ok", { state: "pending", attempts: 0 }), heldRow("blob-create-200-ok", { state: "in_flight" })]) {
    const journal = journalWith(row);
    await assert.rejects(journal.forgetBlobIntent(row.requestId, { guard: (await journal.readBlobWithJournal(row.target)).guard }));
    assert.equal((await journal.listBlobIntents()).length, 1);
  }
  const unknown = heldRow("blob-create-200-ok", { state: "unknown" });
  const journal = journalWith(unknown);
  const stale = (await journal.readBlobWithJournal(unknown.target)).guard;
  await journal.admitPreparedBlob(prepareBlobIntent({ scope: scopeOf("notes.b"), intent: { operationId: "blobs.create.v1", key: unknown.target, expectedVersion: null, expectedContentType: null, version: FIXTURE_VERSION, contentType: SVG }, identity: { requestId: "4a2f9c1e-8b3d-4e6f-9a1b-0000000000aa", binding: FIXTURE_BINDING }, createdAt: "2026-10-17T03:20:00.000Z" }, FIXTURE_BYTES), { guard: stale });
  await assert.rejects(journal.forgetBlobIntent(unknown.requestId, { guard: stale }), JournalGuardConflict);
  await journal.forgetBlobIntent(unknown.requestId, { guard: (await journal.readBlobWithJournal(unknown.target)).guard });
  assert.deepEqual((await journal.listBlobIntents()).map((row) => row.requestId), ["4a2f9c1e-8b3d-4e6f-9a1b-0000000000aa"]);
});

// ── the owner, called directly (the CLI's later delegation) ─────────────────────────────────

test("owner: premises snapshot every transaction and their meta commits with it; a second unsettled intent is refused without a premise", async () => {
  const host = fakeHost();
  const journal = createMemoryBlobJournal();
  const steps: string[] = [];
  const carrier = createFetchCarrier({ baseUrl: ORIGIN, credentials: async () => ({ Authorization: "Bearer ok" }), fetch: host.fetch });
  const capabilities = decodeHostedCapabilities(JSON.parse(capabilitiesBody()));
  const premises = {
    async snapshot(key: string, step: { kind: string }) {
      steps.push(step.kind);
      const read = await journal.readBlobWithJournal(key, { meta: ["app.map"] });
      return { guard: read.guard, meta: [{ key: "app.map", value: { last: step.kind } }] };
    },
  };
  const requestId = "4a2f9c1e-8b3d-4e6f-9a1b-0000000000c1";
  const prepared = prepareBlobIntent({ scope: scopeOf(), intent: { operationId: "blobs.create.v1", key: "a.svg", expectedVersion: null, expectedContentType: null, version: digest(text("1")), contentType: SVG }, identity: { requestId, binding: FIXTURE_BINDING }, createdAt: new Date().toISOString() }, text("1"));
  const result = await driveJournaledBlob(journal, { scope: scopeOf(), carrier, capabilities: async () => capabilities, premises }, requestId, { start: "admit", prepared });
  assert.equal(result.kind, "delivered");
  assert.deepEqual(steps, ["admit", "claim", "persist", "retire"]);
  assert.deepEqual(await journal.readMeta("app.map"), { last: "retire" });
  // A held unsettled intent on the same (bundle, key) blocks a second admission.
  const unsettled = heldRow("blob-create-200-ok", { state: "unknown", key: "b.svg" });
  const blocked = journalWith(unsettled);
  const second = prepareBlobIntent({ scope: scopeOf(), intent: { operationId: "blobs.create.v1", key: "b.svg", expectedVersion: null, expectedContentType: null, version: digest(text("2")), contentType: SVG }, identity: { requestId, binding: FIXTURE_BINDING }, createdAt: new Date().toISOString() }, text("2"));
  const refused = await driveJournaledBlob(blocked, { scope: scopeOf(), carrier, capabilities: async () => capabilities }, requestId, { start: "admit", prepared: second });
  assert.deepEqual(refused, { kind: "not-admitted", reason: "unsettled", unsettled: [unsettled.requestId] });
});

// ── the Node journal holding blob writes ───────────────────────────────────────────────────

test("node journal: blob intents reopen; a checkout store is still refused; reserved metadata is refused; retired bytes are reclaimed", { timeout: 60_000 }, async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "superbee-blob-node-"));
  const directory = path.join(base, "journal");
  const lockRoot = path.join(base, "locks");
  const open = () => openHostedClientJournalWith({ directory, lock: { waitMs: 0 } }, { lockRoot });
  try {
    const host = fakeHost();
    host.fault("blob-create", "lost-request");
    for (let i = 0; i < 3; i++) host.fault("outcome", "throw");
    let journal = await open();
    const client = clientOf(host.fetch, { intentStore: journal, blobJournal: journal.blobs });
    assert.equal((await client.writeBlob(BUNDLE, { key: "held.svg", bytes: text("1"), contentType: SVG, expectAbsent: true })).status, "unknown");
    await journal.close();
    journal = await open();
    assert.equal((await journal.blobs.listBlobIntents()).length, 1, "a journal holding blob intents reopens");
    const guard = (await journal.blobs.readBlobWithJournal("x.svg", { meta: ["hosted-client.journal"] })).guard;
    await assert.rejects(journal.blobs.writeBlobMeta!("x.svg", { meta: [{ key: "hosted-client.journal", value: { schemaVersion: 2 } }] }, { guard }), TypeError);

    // A bytes-carrying retire compacts: the snapshot and log end far below the blob's size.
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    const bigClient = clientOf(host.fetch, { intentStore: journal, blobJournal: journal.blobs });
    assert.equal((await bigClient.writeBlob(BUNDLE, { key: "big.bin", bytes: big, contentType: "application/octet-stream", expectAbsent: true })).status, "committed");
    const sizes = await Promise.all([FILE_JOURNAL_LOG, FILE_JOURNAL_SNAPSHOT].map((file) => fs.stat(path.join(directory, file)).then((s) => s.size, () => 0)));
    assert.ok(sizes[0]! + sizes[1]! < 512 * 1024, `log ${sizes[0]} + snapshot ${sizes[1]} after the retire`);
    await journal.close();
    journal = await open();
    await journal.close();

    // A checkout's blob-sync state still marks a store that is not this client's.
    const checkout = path.join(base, "checkout");
    const backend = await FileJournaledBackend.open({ directory: checkout, lock: { lockRoot, waitMs: 0 } });
    await backend.writeMeta("hosted-client.journal", { schemaVersion: 1 });
    await backend.writeMeta("hosted.blob-sync.v1", { entries: [] });
    await backend.close();
    await fs.chmod(checkout, 0o700);
    await assert.rejects(openHostedClientJournalWith({ directory: checkout, lock: { waitMs: 0 } }, { lockRoot }), (error: unknown) => error instanceof HostedClientJournalError && error.code === "JOURNAL_NOT_HOSTED_CLIENT");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("journal shape: a client's default blob journal is its own, and within clients share it", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch);
  assert.equal((await client.writeBlob(BUNDLE, { key: "a.svg", bytes: text("1"), contentType: SVG, expectAbsent: true })).status, "committed");
  const head = await client.blobHead(BUNDLE, "a.svg");
  assert.deepEqual(head, { key: "a.svg", version: digest(text("1")), contentType: SVG });
  const read = await client.readBlob(BUNDLE, "a.svg", { pin: head! });
  assert.deepEqual([...read!.bytes], [...text("1")]);
  assert.deepEqual(await client.within("team").heldBlobWrites(), []);
  const typed: BlobJournaledBackend = createMemoryBlobJournal();
  assert.equal(typeof typed.forgetBlobIntent, "function");
});
