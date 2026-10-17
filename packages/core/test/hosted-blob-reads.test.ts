import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHostedBlobReadAdapter, createFetchCarrier, decodeHostedCapabilities,
  HostedCarrierError, HostedReadAdapterError, isAnswerTooLarge,
  type HostedCarrier, type HostedCapabilities, type HostedBlobHead,
} from "../src/hosted-transport/index.js";
import { isMalformedAnswer, RemoteError } from "../src/remote-error.js";
import { sha256HexOfBytes, sha256HexOfUtf8 } from "../src/sha256.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/hosted-sync-v1/${name}.json`, import.meta.url), "utf8"));
const capabilities = decodeHostedCapabilities(JSON.parse(fixture("capabilities-200").response.body));
const binary = fixture("blob-read-200-binary");
const {bundleId, ...pin} = JSON.parse(binary.request.body) as {bundleId: string} & HostedBlobHead;
const bytes = new Uint8Array(Buffer.from(binary.response.bodyBase64, "base64"));
const digest = (revision: number, heads: readonly HostedBlobHead[]) => `sha256:${sha256HexOfUtf8(JSON.stringify([revision, heads.map(h => [h.key, h.version, h.contentType])]))}`;
const page = (heads: readonly HostedBlobHead[], revision = 1) => ({schemaVersion: 1, bundleId, revision, total: heads.length, digest: digest(revision, heads), heads, next: null as string | null});
const json = (body: unknown, status = 200) => ({body, status, headers: new Headers()});
const unused = async (): Promise<never> => assert.fail("unexpected carrier dispatch");
const make = (carrier: HostedCarrier, options: {signal?: AbortSignal; caps?: HostedCapabilities; prefix?: string; sleep?: (ms: number, signal: AbortSignal) => Promise<void>} = {}) =>
  createHostedBlobReadAdapter({carrier, bundleId, signal: options.signal ?? new AbortController().signal, capabilities: async () => options.caps ?? capabilities, prefix: options.prefix, sleep: options.sleep});

test("the adapter consumes hosted binary and paged-head golden answers through the existing fetch carrier", async () => {
  const first = fixture("blob-heads-200-page"), firstPage = JSON.parse(first.response.body);
  const second = {...pin, key: "second.svg"};
  const requests: {path: string; body: any}[] = [];
  const carrier = createFetchCarrier({baseUrl: "https://example.test", credentials: async () => ({Authorization: "Bearer current"}), fetch: async (input, init) => {
    const request = new Request(input, init), body = await request.json() as any;
    requests.push({path: new URL(request.url).pathname, body});
    assert.equal(request.headers.get("authorization"), "Bearer current");
    if (new URL(request.url).pathname.endsWith("blob-read")) return new Response(bytes, {status: binary.response.status, headers: binary.response.headers});
    if (!body.cursor) return new Response(first.response.body, first.response);
    assert.equal(body.cursor, firstPage.next);
    return Response.json({...firstPage, heads: [second], next: null});
  }});
  const adapter = make(carrier, {prefix: "/agents/workload/sync/v1"});
  const listing = await adapter.heads();
  assert.deepEqual(listing.heads, [...firstPage.heads, second]);
  assert.equal(listing.digest, firstPage.digest);
  assert.ok(Object.isFrozen(listing) && Object.isFrozen(listing.heads) && Object.isFrozen(listing.heads[0]));
  const read = await adapter.read(pin);
  assert.deepEqual(read.bytes, bytes);
  assert.equal(read.contentType, pin.contentType);
  assert.deepEqual(requests.at(-1), {path: "/agents/workload/sync/v1/blob-read", body: {bundleId, ...pin}});
});

test("a legal inventory can span more than 64 pages, with strictly bounded forward progress", async () => {
  const heads = Array.from({length: 100}, (_, i) => ({...pin, key: `files/${String(i).padStart(3, "0")}.bin`}));
  const full = page(heads);
  let calls = 0;
  const adapter = make({stream: unused, json: async (_route, input: any, _signal, options) => {
    assert.ok(options.maximum >= 1000 * (512 * 2 + 1024 * 2 + 200));
    const index = input.cursor === undefined ? 0 : Number(input.cursor);
    assert.equal(index, calls++);
    return json({...full, heads: [heads[index]], next: index === heads.length - 1 ? null : String(index + 1)});
  }});
  assert.deepEqual((await adapter.heads()).heads, heads);
  assert.equal(calls, 100);
  assert.deepEqual((await make({stream: unused, json: async () => json(page([]))}).heads()).heads, []);
});

test("the full 10000-head inventory admits maximally escaped legal key and MIME metadata", async () => {
  const heads = Array.from({length: 10000}, (_, i) => ({...pin, key: `${String(i).padStart(5, "0")}${'"'.repeat(503)}.bin`, contentType: '"'.repeat(1024)}));
  const full = page(heads);
  let offset = 0;
  const adapter = make({stream: unused, json: async (_route, _input, _signal, options) => {
    const nextOffset = offset + 1000;
    const response = {...full, heads: heads.slice(offset, nextOffset), next: nextOffset < heads.length ? String(nextOffset) : null};
    assert.ok(new TextEncoder().encode(JSON.stringify(response)).length <= options.maximum);
    offset = nextOffset;
    return json(response);
  }});
  assert.equal((await adapter.heads()).heads.length, 10000);
});

test("mixed, stalled, duplicate, unsafe and forged inventories are rejected without a retry", async () => {
  const heads = [{...pin, key: "a.bin"}, {...pin, key: "b.bin"}], full = page(heads);
  const variants = [
    {...full, bundleId: "other"}, {...full, revision: -1}, {...full, total: 10001},
    {...full, digest: `sha256:${"0".repeat(64)}`}, {...full, heads: [...heads].reverse()},
    {...full, heads: [heads[0], heads[0]]}, {...full, heads: []},
    {...full, heads: [{...pin, key: "../outside.bin"}]},
    {...full, heads: [{...pin, contentType: "image/非ascii"}]},
    {...full, heads: [{...pin, contentType: " image/svg+xml"}]},
    {...full, heads: [{...pin, key: "bad\ud800.bin"}]},
    {...full, next: "x".repeat(1025)}, {...full, next: undefined},
  ];
  for (const bad of variants) {
    let calls = 0;
    await assert.rejects(make({stream: unused, json: async () => {calls++; return json(bad);}}).heads(), isMalformedAnswer);
    assert.equal(calls, 1);
  }
  for (const badSecond of [
    {...full, revision: 2, heads: [heads[1]]}, {...full, total: 3, heads: [heads[1]]},
    {...full, digest: `sha256:${"0".repeat(64)}`, heads: [heads[1]]},
    {...full, heads: [], next: "another"}, {...full, heads: [heads[0]]},
    {...full, heads: [heads[1]], next: "same"},
  ]) {
    let calls = 0;
    await assert.rejects(make({stream: unused, json: async () => json(++calls === 1 ? {...full, heads: [heads[0]], next: "same"} : badSecond)}).heads(), isMalformedAnswer);
    assert.equal(calls, 2);
  }
  const three = page([...heads, {...pin, key: "c.bin"}]);
  let calls = 0;
  await assert.rejects(make({stream: unused, json: async () => json({...three, heads: [heads[calls++]], next: "same"})}).heads(), isMalformedAnswer);
  assert.equal(calls, 2, "a repeated cursor is refused before another request leaves");
});

test("only concurrent-change restarts discard all earlier pages, and abort interrupts the restart delay", async () => {
  const old = page([{...pin, key: "a.bin"}, {...pin, key: "b.bin"}]), fresh = page([{...pin, key: "new.bin"}], 2);
  const moved = fixture("blob-heads-409-moved");
  let calls = 0, sleeps = 0;
  const reader = make({stream: unused, json: async (_route, input: any) => {
    calls++;
    if (calls === 1) return json({...old, heads: [old.heads[0]], next: "old"});
    if (calls === 2) {assert.equal(input.cursor, "old"); return json(JSON.parse(moved.response.body), moved.response.status);}
    assert.equal(input.cursor, undefined);
    return json(fresh);
  }}, {sleep: async () => {sleeps++;}});
  assert.deepEqual((await reader.heads()).heads, fresh.heads);
  assert.equal(sleeps, 1); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(make({stream: unused, json: async () => {calls++; return json({error: {code: "concurrent_change"}}, 409);}}, {sleep: async () => {}}).heads(), (e: unknown) => e instanceof RemoteError && e.code === "concurrent_change");
  assert.equal(calls, 3);
  const controller = new AbortController();
  const blocked = make({stream: unused, json: async () => json({error: {code: "concurrent_change"}}, 409)}, {
    signal: controller.signal, sleep: async () => {controller.abort(); await new Promise(() => {});},
  }).heads();
  await assert.rejects(blocked, HostedCarrierError);
});

function streamReader(body: Uint8Array = bytes, headers: Record<string, string> = binary.response.headers, status = 200) {
  let cancelled = 0, pulls = 0;
  const adapter = make({json: unused, stream: async () => ({ok: true, status, headers: new Headers(headers), body: new ReadableStream<Uint8Array>({
    pull(controller) { if (pulls++ === 0) controller.enqueue(body); else controller.close(); },
    cancel() {cancelled++;},
  })})});
  return {adapter, cancelled: () => cancelled};
}

test("pinned reads refuse wrong MIME/version/status/length/hash and cancel unconsumed content", async () => {
  for (const headers of [
    {...binary.response.headers, "content-type": pin.contentType},
    {...binary.response.headers, "x-superbee-content-type": "application/octet-stream"},
    {...binary.response.headers, "x-superbee-blob-version": `sha256:${"0".repeat(64)}`},
    {...binary.response.headers, "content-length": ""}, {...binary.response.headers, "content-length": "07"},
  ]) {
    const r = streamReader(bytes, headers);
    await assert.rejects(r.adapter.read(pin), isMalformedAnswer);
    assert.equal(r.cancelled(), 1);
  }
  const badStatus = streamReader(bytes, binary.response.headers, 206);
  await assert.rejects(badStatus.adapter.read(pin), isMalformedAnswer);
  assert.equal(badStatus.cancelled(), 1);
  await assert.rejects(streamReader(bytes.slice(1)).adapter.read(pin), isMalformedAnswer);
  await assert.rejects(streamReader(new Uint8Array(bytes.length)).adapter.read(pin), isMalformedAnswer);
  await assert.rejects(streamReader(new Uint8Array(bytes.length + 1)).adapter.read(pin), isMalformedAnswer);
  const invalidPin = {...pin, key: "folder/.private"};
  await assert.rejects(make({json: unused, stream: unused}).read(invalidPin), isMalformedAnswer);
});

test("reads honor the independent advertised bound and hard cap, including overflow cancellation", async () => {
  for (const [advertised, length, maximum] of [[4, 7, 4], [32 * 1024 * 1024, 17 * 1024 * 1024, 16 * 1024 * 1024]]) {
    let cancelled = false;
    const adapter = make({json: unused, stream: async () => ({ok: true, status: 200, headers: new Headers({...binary.response.headers, "content-length": String(length)}), body: new ReadableStream({cancel() {cancelled = true;}})})}, {caps: {...capabilities, blobReadBytes: advertised}});
    await assert.rejects(adapter.read(pin), isAnswerTooLarge);
    assert.equal(cancelled, true);
    assert.ok(maximum < length);
  }
  let cancelled = false;
  const adapter = make({json: unused, stream: async () => ({ok: true, status: 200, headers: new Headers({...binary.response.headers, "content-length": "3"}), body: new ReadableStream({start(c) {c.enqueue(new Uint8Array(5));}, cancel() {cancelled = true;}})})}, {caps: {...capabilities, blobReadBytes: 4}});
  await assert.rejects(adapter.read(pin), isAnswerTooLarge);
  assert.equal(cancelled, true);
});

test("abort interrupts a hanging read and cancels its stream even when the carrier does not cooperate", {timeout: 1000}, async () => {
  const controller = new AbortController();
  let started!: () => void, cancelled = false;
  const reading = new Promise<void>(resolve => {started = resolve;});
  const body = new ReadableStream<Uint8Array>({cancel() {cancelled = true;}});
  const getReader = body.getReader.bind(body);
  body.getReader = (() => {
    const reader = getReader(), read = reader.read.bind(reader);
    reader.read = () => {started(); return read();};
    return reader;
  }) as typeof body.getReader;
  const adapter = make({json: unused, stream: async () => ({ok: true, status: 200, headers: new Headers(binary.response.headers), body})}, {signal: controller.signal});
  const pending = adapter.read(pin);
  await reading;
  controller.abort();
  await assert.rejects(pending, HostedCarrierError);
  assert.equal(cancelled, true);
  await assert.rejects(adapter.heads(), HostedCarrierError);
});

test("a stream supplied after abort is cancelled without waiting for an uncooperative carrier", {timeout: 1000}, async () => {
  const controller = new AbortController();
  let entered!: () => void, provide!: (answer: Awaited<ReturnType<HostedCarrier["stream"]>>) => void, cancelled!: () => void;
  const dispatched = new Promise<void>(resolve => {entered = resolve;}), cancellation = new Promise<void>(resolve => {cancelled = resolve;});
  const adapter = make({json: unused, stream: () => {entered(); return new Promise(resolve => {provide = resolve;});}}, {signal: controller.signal});
  const pending = adapter.read(pin);
  await dispatched;
  controller.abort();
  await assert.rejects(pending, HostedCarrierError);
  provide({ok: true, status: 200, headers: new Headers(binary.response.headers), body: new ReadableStream({cancel: cancelled})});
  await cancellation;
});

test("read capability is required before dispatch, independent of write permission, with common authority errors", async () => {
  for (const caps of [
    {...capabilities, blobReads: undefined}, {...capabilities, blobReads: "refused" as const},
    {...capabilities, blobReadBytes: null}, {...capabilities, blobReadBytes: Infinity},
  ]) {
    const adapter = make({json: unused, stream: unused}, {caps});
    await assert.rejects(adapter.heads(), HostedReadAdapterError);
    await assert.rejects(adapter.read(pin), HostedReadAdapterError);
  }
  const adapter = make({json: async () => json(page([])), stream: unused}, {caps: {...capabilities, blobWrites: "refused", blobWriteBytes: null}});
  assert.deepEqual((await adapter.heads()).heads, []);
  for (const status of [401, 403, 404, 503]) {
    const error = {error: {code: status === 404 ? "blob_not_found" : "access_denied"}};
    const reader = make({json: async () => json(error, status), stream: async () => ({ok: false, status, body: error, headers: new Headers()})});
    for (const read of [() => reader.heads(), () => reader.read(pin)]) await assert.rejects(read(), (e: unknown) => status === 503 ? e instanceof HostedCarrierError && e.code === "unavailable" : e instanceof RemoteError && e.status === status);
  }
  await assert.rejects(make({json: async () => {throw new HostedCarrierError("denied");}, stream: unused}).heads(), (e: unknown) => e instanceof RemoteError && e.status === 401);
});

test("the adapter copies caller pins before awaiting capabilities and verifies empty binary content", async () => {
  const empty = {...pin, version: `sha256:${sha256HexOfBytes(new Uint8Array())}`}, original = {...empty};
  let release!: (caps: HostedCapabilities) => void;
  const adapter = createHostedBlobReadAdapter({bundleId, signal: new AbortController().signal, capabilities: () => new Promise(resolve => {release = resolve;}), carrier: {
    json: unused, stream: async (_route, input) => {
      assert.deepEqual(input, {bundleId, ...original});
      return {ok: true, status: 200, headers: new Headers({...binary.response.headers, "content-length": "0", "x-superbee-blob-version": original.version}), body: new ReadableStream({start(c) {c.close();}})};
    },
  }});
  const pending = adapter.read(empty);
  await Promise.resolve();
  empty.key = "changed.bin";
  release(capabilities);
  assert.equal((await pending).bytes.length, 0);
});
