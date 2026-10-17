/**
 * `@superbee/core/hosted-client/node`: `downloadExport` against the `/sync/v1/export` golden
 * exchanges (`fixtures/hosted-sync-v1/`): a whole archive from a host from before paging, a paged
 * export joined, a stream stopped part way, a tampered entry and a digest mismatch, an answer past
 * what an export carries, a host without the route, the host's refusals, and abort. None of them
 * yields a verified result unless the whole export verified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bearerCredentials, createHostedClient, HostedCarrierError, isRouteNotServed, RemoteError, type HostedClientOptions } from "../src/hosted-client/index.js";
import {
  downloadExport,
  EXPORT_WINDOW_MS,
  ExportArchiveError,
  HostedExportError,
  isHostedExportError,
  MAX_EXPORT_BYTES,
} from "../src/hosted-client/node.js";
import { crc32, exportProvenance, readStoredZip, verifyExport } from "../src/portable-export.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");
const ORIGIN = "https://hosted.example";
const BUNDLE = "notes.a";

interface Exchange {
  response: { status: number; headers: Record<string, string>; body?: string; bodyBase64?: string };
}
const fixture = (name: string): Exchange => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Exchange;
const archiveOf = (name: string): Uint8Array => new Uint8Array(Buffer.from(fixture(name).response.bodyBase64!, "base64"));

/** The exchange's exact answer bytes. */
function replay(name: string): Response {
  const { response } = fixture(name);
  const body = response.bodyBase64 !== undefined ? Buffer.from(response.bodyBase64, "base64") : response.body === "" ? null : response.body!;
  return new Response(body, { status: response.status, headers: response.headers });
}

const zipAnswer = (bytes: Uint8Array) => new Response(bytes, { status: 200, headers: { "content-type": "application/zip" } });
const refused = (code: string, status: number) => Response.json({ error: { code, message: "refused", retryable: status >= 500 } }, { status });

/** A body that sends its first bytes, then fails as a cut connection does. */
function stoppedAnswer(bytes: Uint8Array): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 100));
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "content-type": "application/zip" } },
  );
}

interface Sent {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** A fetch answering the n-th export request (from 1) with `answer(n, body)`, recording each. */
function host(answer: (n: number, body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path: new URL(String(input)).pathname, body });
    return answer(sent.length, body);
  }) as typeof fetch;
  return { fetch, sent };
}

function clientOf(fetch: typeof globalThis.fetch, overrides: Partial<HostedClientOptions> = {}) {
  return createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch, deadlineMs: 5_000, ...overrides });
}

/** A paged host serving the recorded two pages of revision 2. */
const pagedHost = () => host((_, body) => replay(body.cursor === undefined ? "export-200-page-first" : "export-200-page-last"));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A stored ZIP of `entries`, every CRC correct. */
function zip(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    parts.push(local, entry.bytes); directory.push(central); offset += local.length + entry.bytes.length;
  }
  const end = Buffer.alloc(22);
  const size = directory.reduce((sum, record) => sum + record.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the download to be refused, and it returned a verified export");
}

// ── complete exports ─────────────────────────────────────────────────────────────────────────

test("a host from before paging: the paged request is refused as invalid_input and the whole archive is read once", async () => {
  const { fetch, sent } = host((n) => (n === 1 ? replay("export-400-invalid-input") : replay("export-200")));
  const verified = await downloadExport(clientOf(fetch), BUNDLE);
  assert.deepEqual(sent.map((request) => [request.path, request.body]), [
    ["/sync/v1/export", { bundleId: BUNDLE, paged: true }],
    ["/sync/v1/export", { bundleId: BUNDLE }],
  ]);
  const expected = verifyExport(archiveOf("export-200"), BUNDLE);
  assert.deepEqual(verified.source, { tenantId: "tenant:a", bundleId: BUNDLE, revision: 2, okfEdition: "0.2" });
  assert.deepEqual(verified.entries.map((entry) => [entry.path, entry.kind, sha(entry.bytes)]), expected.entries.map((entry) => [entry.path, entry.kind, sha(entry.bytes)]));
  assert.equal(verified.page, undefined);
  // The handle is the verifier's own: it carries provenance, as one verified locally does.
  assert.equal(exportProvenance(verified).inventorySha256, exportProvenance(expected).inventorySha256);
});

test("a paged export is read a page at a time by each page's cursor and joined into the whole bundle", async () => {
  const { fetch, sent } = pagedHost();
  const verified = await downloadExport(clientOf(fetch), BUNDLE);
  assert.deepEqual(sent.map((request) => request.body), [
    { bundleId: BUNDLE, paged: true },
    { bundleId: BUNDLE, paged: true, cursor: "2.1" },
  ]);
  const whole = verifyExport(archiveOf("export-200"), BUNDLE);
  assert.deepEqual(verified.entries.map((entry) => [entry.path, sha(entry.bytes)]), whole.entries.map((entry) => [entry.path, sha(entry.bytes)]));
  assert.deepEqual(verified.counts, whole.counts);
  assert.equal(verified.page, undefined);
  assert.equal(exportProvenance(verified).manifests.length, 2);
});

test("a workspace client names the bundle as <slug>/<bundle-id> and verifies the bare id the host answers", async () => {
  const { fetch, sent } = pagedHost();
  const verified = await downloadExport(clientOf(fetch).within("team"), BUNDLE);
  assert.deepEqual(sent.map((request) => request.body.bundleId), ["team/notes.a", "team/notes.a"]);
  assert.equal(verified.source.bundleId, BUNDLE);
});

test("the export window is the host's 60 s", () => {
  assert.equal(EXPORT_WINDOW_MS, 60_000);
});

// ── stopped, tampered, oversized ──────────────────────────────────────────────────────────────

test("a stream stopped part way is asked for once more, and a second stop never yields files or a result", async () => {
  const first = archiveOf("export-200-page-first");
  // Once: the same page is asked for again, and the export completes.
  const once = host((n, body) => (n === 1 ? stoppedAnswer(first) : replay(body.cursor === undefined ? "export-200-page-first" : "export-200-page-last")));
  const verified = await downloadExport(clientOf(once.fetch), BUNDLE);
  assert.equal(verified.entries.length, 2);
  assert.deepEqual(once.sent.map((request) => request.body.cursor), [undefined, undefined, "2.1"]);

  // Twice: refused as stopped, with nothing returned.
  const twice = host(() => stoppedAnswer(first));
  const error = await refusal(downloadExport(clientOf(twice.fetch), BUNDLE));
  assert.ok(isHostedExportError(error, "stopped"), String(error));
  assert.ok(error instanceof HostedExportError);
  assert.equal(error.bundleId, BUNDLE);
  assert.equal(twice.sent.length, 2);
});

test("an archive the host ended before its central directory is incomplete: asked for once more, then refused", async () => {
  const truncated = archiveOf("export-200-page-first").subarray(0, -40);
  const { fetch, sent } = host(() => zipAnswer(truncated));
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(error instanceof ExportArchiveError && error.problem === "incomplete", String(error));
  assert.equal(sent.length, 2);
});

test("a tampered entry is refused at once, never retried", async () => {
  const bytes = Buffer.from(archiveOf("export-200"));
  bytes[60] = bytes[60]! ^ 0x01;
  const { fetch, sent } = host((n) => (n === 1 ? replay("export-400-invalid-input") : zipAnswer(bytes)));
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(error instanceof ExportArchiveError && error.problem === "malformed", String(error));
  assert.equal(sent.length, 2);
});

test("an entry whose bytes do not match its manifest digest is refused, though every CRC is right", async () => {
  const entries = readStoredZip(archiveOf("export-200"));
  const forged = entries.map((entry) => (entry.name === "notes/one.md" ? { name: entry.name, bytes: Buffer.from("# forged\n") } : { name: entry.name, bytes: entry.data }));
  const { fetch } = host((n) => (n === 1 ? replay("export-400-invalid-input") : zipAnswer(zip(forged))));
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(error instanceof ExportArchiveError && error.problem === "manifest_mismatch", String(error));
  assert.match((error as Error).message, /notes\/one\.md does not match its manifest digest/);
});

test("an export of another bundle is refused as wrong_bundle", async () => {
  const { fetch } = host((n) => (n === 1 ? replay("export-400-invalid-input") : replay("export-200")));
  const error = await refusal(downloadExport(clientOf(fetch), "other.b"));
  assert.ok(error instanceof ExportArchiveError && error.problem === "wrong_bundle", String(error));
});

test("an answer larger than an export carries is refused as too_large once past the bound, not read to its end", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
        },
      }),
      { status: 200, headers: { "content-type": "application/zip" } },
    );
  const { fetch, sent } = host(() => endless());
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(isHostedExportError(error, "too_large"), String(error));
  assert.equal((error as HostedExportError).maximum, MAX_EXPORT_BYTES);
  // Deterministic: never retried, and the stream is let go just past the bound.
  assert.equal(sent.length, 1);
  assert.ok(pulled <= MAX_EXPORT_BYTES / chunk.byteLength + 3, `pulled ${pulled} chunks`);
});

// ── the host's answers ────────────────────────────────────────────────────────────────────────

test("a host without the export route is HostedRouteNotServed, typed and not retried", async () => {
  const { fetch, sent } = host(() => replay("unknown-route-404"));
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(isRouteNotServed(error), String(error));
  assert.equal((error as { route: string }).route, "/sync/v1/export");
  assert.equal((error as RemoteError).status, 404);
  assert.equal(sent.length, 1);
});

test("the host's refusals are RemoteErrors with its code and status", async () => {
  for (const [name, code, status] of [
    ["export-404-bundle-not-found", "bundle_not_found", 404],
    ["export-401-unauthenticated", "invalid_token", 401],
  ] as const) {
    const { fetch, sent } = host(() => replay(name));
    const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
    assert.ok(error instanceof RemoteError && !isRouteNotServed(error), `${name}: ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, `hosted export answered ${status}`);
    assert.equal(sent.length, 1, name);
  }
  // A host refusing a later page's input is the refusal; only the first request falls back.
  const later = host((n) => (n === 1 ? replay("export-200-page-first") : replay("export-400-invalid-cursor")));
  const error = await refusal(downloadExport(clientOf(later.fetch), BUNDLE));
  assert.ok(error instanceof RemoteError);
  assert.equal(later.sent.length, 2);
});

test("a busy host (backend_unavailable, 5xx) is asked for the same page once more", async () => {
  const once = host((n, body) => (n === 2 ? refused("backend_unavailable", 503) : replay(body.cursor === undefined ? "export-200-page-first" : "export-200-page-last")));
  assert.equal((await downloadExport(clientOf(once.fetch), BUNDLE)).entries.length, 2);
  assert.deepEqual(once.sent.map((request) => request.body.cursor), [undefined, "2.1", "2.1"]);

  const always = host(() => refused("backend_unavailable", 503));
  const error = await refusal(downloadExport(clientOf(always.fetch), BUNDLE));
  assert.ok(error instanceof RemoteError && error.code === "backend_unavailable" && error.status === 503);
  assert.equal(always.sent.length, 2);
});

test("a bundle that moves between pages is read again from its first page; one that keeps moving is source_changed", async () => {
  const once = host((n, body) => (n === 2 ? replay("export-409-concurrent-change") : replay(body.cursor === undefined ? "export-200-page-first" : "export-200-page-last")));
  assert.equal((await downloadExport(clientOf(once.fetch), BUNDLE)).entries.length, 2);
  assert.deepEqual(once.sent.map((request) => request.body.cursor), [undefined, "2.1", undefined, "2.1"]);

  const always = host((_, body) => (body.cursor === undefined ? replay("export-200-page-first") : replay("export-409-concurrent-change")));
  const error = await refusal(downloadExport(clientOf(always.fetch), BUNDLE));
  assert.ok(isHostedExportError(error, "source_changed"), String(error));
  assert.equal(always.sent.length, 6);
});

test("a transport failure is the carrier's HostedCarrierError, not retried", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof globalThis.fetch;
  const error = await refusal(downloadExport(clientOf(fetch), BUNDLE));
  assert.ok(error instanceof HostedCarrierError && error.code === "unavailable", String(error));
});

// ── abort ─────────────────────────────────────────────────────────────────────────────────────

test("abort: an aborted signal sends nothing, and the abort's reason is thrown", async () => {
  const { fetch, sent } = pagedHost();
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  assert.equal(await refusal(downloadExport(clientOf(fetch), BUNDLE, { signal: controller.signal })), reason);
  assert.equal(sent.length, 0);
  // The client's own signal stops it too.
  const clientController = new AbortController();
  clientController.abort(reason);
  assert.equal(await refusal(downloadExport(clientOf(fetch, { signal: clientController.signal }), BUNDLE)), reason);
  assert.equal(sent.length, 0);
});

test("abort while a page streams stops the read and throws the reason, never a stopped export", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const { fetch, sent } = host(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(10));
            // The body then waits for bytes that never come, until the caller aborts.
            queueMicrotask(() => controller.abort(reason));
          },
        }),
        { status: 200, headers: { "content-type": "application/zip" } },
      ),
  );
  assert.equal(await refusal(downloadExport(clientOf(fetch), BUNDLE, { signal: controller.signal })), reason);
  assert.equal(sent.length, 1);
});

test("abort during the pause before a retry ends the download at once, with no request after it", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const { fetch, sent } = host(() => {
    setTimeout(() => controller.abort(reason), 50);
    return refused("backend_unavailable", 503);
  });
  const started = performance.now();
  assert.equal(await refusal(downloadExport(clientOf(fetch), BUNDLE, { signal: controller.signal })), reason);
  // The retry pause is a second; the abort cut it short.
  assert.ok(performance.now() - started < 900, `took ${performance.now() - started} ms`);
  assert.equal(sent.length, 1);
});
