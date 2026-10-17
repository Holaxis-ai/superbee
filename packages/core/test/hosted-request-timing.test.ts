/**
 * Request timing over the carrier seam: the `Server-Timing` reader against the header shapes a
 * hosted Superbee sends (five phases with call counts, and the graph cache entry), its lenient and
 * bounded handling of anything else, the observed carrier's reports for answers and failures, and
 * the hosted client's `onRequestTiming` option over the `/sync/v1` golden exchanges.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HostedCarrierError,
  observedCarrier,
  parseServerTiming,
  SERVER_TIMING_MAX_LENGTH,
  SERVER_TIMING_MAX_METRICS,
  type HostedAnswer,
  type HostedCarrier,
  type HostedRequestTiming,
  type HostedStream,
} from "../src/hosted-transport/index.js";
import { bearerCredentials, createHostedClient, parseServerTiming as clientParseServerTiming } from "../src/hosted-client/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The hosted header, exactly as its operation timing formats it: every phase, in order, with
// integer milliseconds and the call count in `desc`, then `total` without a count.
const HOSTED_HEADER = 'session;dur=41;desc="n=2", authority;dur=88;desc="n=2", membership;dur=0;desc="n=0", content;dur=95;desc="n=3", total;dur=402';

// ── parseServerTiming ──────────────────────────────────────────────────────────────────────

test("parseServerTiming: the hosted phases, their durations and call counts, in order", () => {
  assert.deepEqual(parseServerTiming(HOSTED_HEADER), [
    { name: "session", durationMs: 41, description: "n=2", count: 2 },
    { name: "authority", durationMs: 88, description: "n=2", count: 2 },
    { name: "membership", durationMs: 0, description: "n=0", count: 0 },
    { name: "content", durationMs: 95, description: "n=3", count: 3 },
    { name: "total", durationMs: 402 },
  ]);
  assert.equal(clientParseServerTiming, parseServerTiming);
});

test("parseServerTiming: the graph cache entry after total is a name and a token description", () => {
  const metrics = parseServerTiming(`${HOSTED_HEADER}, graph_cache;desc=hit`);
  assert.equal(metrics.length, 6);
  assert.deepEqual(metrics[5], { name: "graph_cache", description: "hit" });
});

test("parseServerTiming: another server's metrics on the same value read as metrics too", () => {
  // Headers.get joins repeated headers with ", ", so an edge's own entry can share the value.
  assert.deepEqual(parseServerTiming('cfL4;desc="?proto=TCP&rtt=12,min=3", total;dur=7.25'), [
    { name: "cfL4", description: "?proto=TCP&rtt=12,min=3" },
    { name: "total", durationMs: 7.25 },
  ]);
});

test("parseServerTiming: whitespace, escapes, case and repeated or unknown parameters", () => {
  assert.deepEqual(parseServerTiming(' total ; DUR = 5 ; dur=9 ; desc="a \\"quoted\\" \\\\ word" ; x=1 '), [
    { name: "total", durationMs: 5, description: 'a "quoted" \\ word' },
  ]);
  assert.deepEqual(parseServerTiming("miss"), [{ name: "miss" }]);
});

test("parseServerTiming: a malformed metric is skipped and its neighbours kept", () => {
  assert.deepEqual(parseServerTiming('bad name;dur=1, ;dur=2, , ok;dur=3, "quoted";dur=4, last;dur=5'), [
    { name: "ok", durationMs: 3 },
    { name: "last", durationMs: 5 },
  ]);
});

test("parseServerTiming: only a plain non-negative decimal is a duration", () => {
  for (const dur of ["-1", "1e3", "0x1F", "Infinity", "NaN", "", "1.", ".5", "1.2345678", "1234567890123456"]) {
    assert.deepEqual(parseServerTiming(`total;dur=${dur}`), [{ name: "total" }], dur);
  }
  assert.deepEqual(parseServerTiming('total;dur="12"'), [{ name: "total", durationMs: 12 }]);
});

test("parseServerTiming: only an exact n=<count> description is a call count", () => {
  for (const desc of ['"n=02"', '"n=3 calls"', '"n="', '"N=3"', '"n=-1"', '"n=1234567890"']) {
    const [metric] = parseServerTiming(`content;desc=${desc}`);
    assert.equal(metric?.count, undefined, desc);
  }
  assert.equal(parseServerTiming('content;desc="n=123456789"')[0]?.count, 123456789);
});

test("parseServerTiming: absent, oversized or ambiguous values yield nothing", () => {
  assert.deepEqual(parseServerTiming(null), []);
  assert.deepEqual(parseServerTiming(undefined), []);
  assert.deepEqual(parseServerTiming(""), []);
  assert.deepEqual(parseServerTiming(42 as unknown as string), []);
  assert.deepEqual(parseServerTiming('total;dur=1, open;desc="never closed, then;dur=2'), []);
  const long = `total;desc="${"x".repeat(SERVER_TIMING_MAX_LENGTH)}"`;
  assert.deepEqual(parseServerTiming(long), []);
});

test("parseServerTiming: at most the first SERVER_TIMING_MAX_METRICS metrics", () => {
  const value = Array.from({ length: SERVER_TIMING_MAX_METRICS + 8 }, (_, i) => `m${i};dur=${i}`).join(", ");
  const metrics = parseServerTiming(value);
  assert.equal(metrics.length, SERVER_TIMING_MAX_METRICS);
  assert.deepEqual(metrics.at(-1), { name: `m${SERVER_TIMING_MAX_METRICS - 1}`, durationMs: SERVER_TIMING_MAX_METRICS - 1 });
});

// ── observedCarrier ────────────────────────────────────────────────────────────────────────

/** A clock that reads `start`, then advances by each of `steps` on later reads. */
function clock(start: number, ...steps: number[]) {
  let time = start;
  let read = 0;
  return () => {
    if (read > 0) time += steps[read - 1] ?? 0;
    read += 1;
    return time;
  };
}

function answering(answer: HostedAnswer | Error, streamed?: HostedStream | Error, withBytes = true): HostedCarrier {
  const settle = <T>(value: T | Error) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  return {
    json: async () => settle(answer),
    stream: async () => settle(streamed ?? new Error("no stream")),
    ...(withBytes ? { bytes: async () => settle(answer) } : {}),
  };
}

const signal = new AbortController().signal;

test("observedCarrier: an answer is reported with its route, status, wall time and the host's phases, and returned unchanged", async () => {
  const answer: HostedAnswer = { status: 200, headers: new Headers({ "Server-Timing": HOSTED_HEADER }), body: { ok: true } };
  const seen: HostedRequestTiming[] = [];
  const carrier = observedCarrier(answering(answer), (t) => seen.push(t), clock(1000, 37.5));
  const result = await carrier.json("/sync/v1/replace", { bundleId: "notes.a" }, signal, { maximum: 1024 });
  assert.equal(result, answer);
  assert.equal(seen.length, 1);
  const [timing] = seen;
  assert.equal(timing!.route, "/sync/v1/replace");
  assert.equal(timing!.kind, "json");
  assert.equal(timing!.status, 200);
  assert.equal(timing!.failure, null);
  assert.equal(timing!.wallMs, 37.5);
  assert.deepEqual(timing!.server.map((m) => [m.name, m.durationMs, m.count]), [
    ["session", 41, 2],
    ["authority", 88, 2],
    ["membership", 0, 0],
    ["content", 95, 3],
    ["total", 402, undefined],
  ]);
});

test("observedCarrier: a refusal is an answer; an answer without the header has no server phases", async () => {
  const seen: HostedRequestTiming[] = [];
  const carrier = observedCarrier(answering({ status: 409, headers: new Headers(), body: { error: { code: "concurrent_change" } } }), (t) => seen.push(t), clock(0, 4));
  const result = await carrier.json("/sync/v1/replace", {}, signal, { maximum: 1024 });
  assert.equal(result.status, 409);
  assert.deepEqual(seen, [{ route: "/sync/v1/replace", kind: "json", status: 409, failure: null, wallMs: 4, server: [] }]);
});

test("observedCarrier: a carrier failure is reported with its code and rethrown as the same error", async () => {
  for (const [error, failure] of [
    [new HostedCarrierError("denied"), "denied"],
    [new HostedCarrierError("unavailable"), "unavailable"],
    [new TypeError("hosted route 'x' must be absolute"), "error"],
  ] as const) {
    const seen: HostedRequestTiming[] = [];
    const carrier = observedCarrier(answering(error), (t) => seen.push(t), clock(10, 3));
    await assert.rejects(carrier.json("/sync/v1/create", {}, signal, { maximum: 1024 }), (thrown) => thrown === error);
    assert.deepEqual(seen, [{ route: "/sync/v1/create", kind: "json", status: null, failure, wallMs: 3, server: [] }]);
  }
});

test("observedCarrier: an observer that throws changes neither an answer nor a failure", async () => {
  const answer: HostedAnswer = { status: 200, headers: new Headers({ "Server-Timing": "total;dur=1" }), body: {} };
  const throwing = () => {
    throw new Error("observer failed");
  };
  assert.equal(await observedCarrier(answering(answer), throwing).json("/r", {}, signal, { maximum: 1 }), answer);
  const failure = new HostedCarrierError("unavailable");
  await assert.rejects(observedCarrier(answering(failure), throwing).json("/r", {}, signal, { maximum: 1 }), (thrown) => thrown === failure);
});

test("observedCarrier: headers that cannot be read lose only the host's phases", async () => {
  const headers = { get: () => { throw new Error("unreadable"); } } as unknown as Headers;
  const answer: HostedAnswer = { status: 200, headers, body: {} };
  const seen: HostedRequestTiming[] = [];
  assert.equal(await observedCarrier(answering(answer), (t) => seen.push(t), clock(0, 1)).json("/r", {}, signal, { maximum: 1 }), answer);
  assert.deepEqual(seen, [{ route: "/r", kind: "json", status: 200, failure: null, wallMs: 1, server: [] }]);
});

test("observedCarrier: bytes and stream are timed as their kinds; a carrier without bytes stays without it", async () => {
  const answer: HostedAnswer = { status: 201, headers: new Headers({ "Server-Timing": "total;dur=9" }), body: {} };
  const streamed: HostedStream = { status: 200, headers: new Headers({ "Server-Timing": "total;dur=2" }), ok: true, body: new ReadableStream<Uint8Array>() };
  const seen: HostedRequestTiming[] = [];
  const carrier = observedCarrier(answering(answer, streamed), (t) => seen.push(t), clock(0, 5, 0, 6));
  assert.equal(await carrier.bytes!("/sync/v1/bundle-create-blob", new Uint8Array([1]), signal, { maximum: 1 }), answer);
  assert.equal(await carrier.stream("/sync/v1/export", {}, signal), streamed);
  assert.deepEqual(
    seen.map((t) => [t.route, t.kind, t.status, t.wallMs, t.server[0]?.durationMs]),
    [
      ["/sync/v1/bundle-create-blob", "bytes", 201, 5, 9],
      ["/sync/v1/export", "stream", 200, 6, 2],
    ],
  );
  assert.equal(observedCarrier(answering(answer, undefined, false), () => {}).bytes, undefined);
});

test("observedCarrier: wall time never reads negative on a clock that steps back", async () => {
  const seen: HostedRequestTiming[] = [];
  await observedCarrier(answering({ status: 200, headers: new Headers(), body: {} }), (t) => seen.push(t), clock(100, -50)).json("/r", {}, signal, { maximum: 1 });
  assert.equal(seen[0]?.wallMs, 0);
});

// ── the hosted client ──────────────────────────────────────────────────────────────────────

const ORIGIN = "https://hosted.example";

function whoamiFixture(): { status: number; headers: Record<string, string>; body: string } {
  const exchange = JSON.parse(readFileSync(path.join(HERE, "fixtures", "hosted-sync-v1", "whoami-200.json"), "utf8")) as { response: { status: number; headers: Record<string, string>; body: string } };
  return exchange.response;
}

test("createHostedClient: onRequestTiming reports each request, a within client's included, with the host's phases", async () => {
  const response = whoamiFixture();
  const paths: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    paths.push(new URL(String(input)).pathname);
    return new Response(response.body, { status: response.status, headers: { ...response.headers, "Server-Timing": HOSTED_HEADER } });
  }) as typeof globalThis.fetch;
  const seen: HostedRequestTiming[] = [];
  const client = createHostedClient({
    target: { origin: ORIGIN, syncPrefix: "/sync/v1" },
    credentials: bearerCredentials(() => "token-1"),
    fetch,
    onRequestTiming: (timing) => seen.push(timing),
  });
  await client.whoami();
  await client.within("south").whoami();
  assert.deepEqual(paths, ["/sync/v1/whoami", "/sync/v1/whoami"]);
  assert.equal(seen.length, 2);
  for (const timing of seen) {
    assert.equal(timing.route, "/sync/v1/whoami");
    assert.equal(timing.kind, "json");
    assert.equal(timing.status, 200);
    assert.equal(timing.failure, null);
    assert.ok(timing.wallMs >= 0);
    assert.deepEqual(timing.server.map((m) => m.name), ["session", "authority", "membership", "content", "total"]);
  }
});

test("createHostedClient: a request refused before sending is reported as denied, and the client still throws it", async () => {
  const seen: HostedRequestTiming[] = [];
  const client = createHostedClient({
    target: { origin: ORIGIN, syncPrefix: "/sync/v1" },
    credentials: async () => {
      throw new Error("signed out");
    },
    fetch: (async () => {
      throw new Error("never sent");
    }) as typeof globalThis.fetch,
    onRequestTiming: (timing) => seen.push(timing),
  });
  await assert.rejects(client.whoami(), (error) => error instanceof HostedCarrierError && error.code === "denied");
  assert.deepEqual(
    seen.map((t) => [t.route, t.status, t.failure]),
    [["/sync/v1/whoami", null, "denied"]],
  );
});
