import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import {
  UPDATE_CHECK_ACCEPT,
  UPDATE_CHECK_ENDPOINT,
  UPDATE_CHECK_MAX_BYTES,
  UPDATE_CHECK_SCHEMA,
  UPDATE_CHECK_TIMEOUT_MS,
  checkSupportedRelease,
  compareStrictSemver,
  fetchSupportedReleasePackument,
  parseStrictSemver,
  selectSupportedRelease,
  type ReleaseTrack,
} from "../src/update-check.js";

const CHECKED_AT = "2026-08-05T12:00:00.000Z";
const INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;

function entry(
  version: string,
  options: { deprecated?: unknown; integrity?: unknown; name?: unknown } = {},
): Record<string, unknown> {
  return {
    name: options.name ?? "superbee",
    version,
    dist: { integrity: options.integrity ?? INTEGRITY },
    ...(options.deprecated === undefined ? {} : { deprecated: options.deprecated }),
  };
}

function packument(
  selected: string,
  options: {
    track?: ReleaseTrack;
    selectedEntry?: Record<string, unknown>;
    runningVersion?: string;
    runningEntry?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const track = options.track ?? "latest";
  return {
    name: "superbee",
    "dist-tags": { [track]: selected },
    versions: {
      [selected]: options.selectedEntry ?? entry(selected),
      ...(options.runningVersion && options.runningVersion !== selected
        ? { [options.runningVersion]: options.runningEntry ?? entry(options.runningVersion) }
        : {}),
    },
  };
}

function select(
  runningVersion: string,
  selectedVersion: string,
  options: Parameters<typeof packument>[1] = {},
) {
  return selectSupportedRelease({
    packument: packument(selectedVersion, { runningVersion, ...options }),
    track: options.track ?? "latest",
    runningVersion,
    checkedAt: CHECKED_AT,
  });
}

test("strict SemVer parsing and precedence cover prereleases without numeric overflow", () => {
  for (const valid of [
    "0.0.0",
    "0.1.0-pre.2",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "999999999999999999999999.0.0",
    "1.2.3+build.7",
  ]) {
    assert.ok(parseStrictSemver(valid), valid);
  }
  for (const invalid of ["v1.2.3", "01.2.3", "1.02.3", "1.2", "1.2.3-01", "1.2.3-", "1.2.3+bad!"]) {
    assert.equal(parseStrictSemver(invalid), undefined, invalid);
  }
  assert.equal(parseStrictSemver(`1.2.3-${"a".repeat(257)}`), undefined);
  const precedence: Array<[string, string, -1 | 0 | 1]> = [
    ["0.1.0-pre.2", "0.1.0-pre.3", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["999999999999999999999998.0.0", "999999999999999999999999.0.0", -1],
    ["1.2.3+one", "1.2.3+two", 0],
  ];
  for (const [left, right, expected] of precedence) {
    assert.equal(compareStrictSemver(left, right), expected, `${left} <> ${right}`);
    assert.equal(compareStrictSemver(right, left), expected === 0 ? 0 : -expected, `${right} <> ${left}`);
  }
});

test("selection follows exact dist-tag policy for current, forward, and rollback states", () => {
  const current = select("0.1.0-pre.2", "0.1.0-pre.2");
  assert.deepEqual(current, {
    schema: UPDATE_CHECK_SCHEMA,
    track: "latest",
    status: "current",
    relation: "equal",
    checked_at: CHECKED_AT,
    running_version: "0.1.0-pre.2",
    selected_version: "0.1.0-pre.2",
    running_deprecated: null,
    selected_integrity: INTEGRITY,
    command: null,
    verify: [],
    unavailable: null,
  });

  const forward = select("0.1.0-pre.2", "0.1.0-pre.3");
  assert.equal(forward.status, "upgrade_available");
  assert.equal(forward.relation, "selected_newer");
  assert.equal(forward.command, "npm install --global superbee@0.1.0-pre.3");
  assert.deepEqual(forward.verify, [
    "superbee version --check",
    "superbee skill status --scope user",
    "superbee hook status --scope user",
  ]);

  const rollback = select("0.1.0-pre.3", "0.1.0-pre.2");
  assert.equal(rollback.status, "rollback_available");
  assert.equal(rollback.relation, "selected_older");
  assert.equal(rollback.command, "npm install --global superbee@0.1.0-pre.2");

  const preview = select("0.1.0-pre.2", "0.1.0-pre.4", { track: "next" });
  assert.equal(preview.track, "next");
  assert.equal(preview.verify[0], "superbee version --check --tag next");
});

test("deprecation precedence never recommends a deprecated selected release", () => {
  const runningDeprecated = select("0.1.0-pre.2", "0.1.0-pre.3", {
    runningEntry: entry("0.1.0-pre.2", { deprecated: "superseded" }),
  });
  assert.equal(runningDeprecated.status, "upgrade_available");
  assert.equal(runningDeprecated.running_deprecated, "superseded");
  assert.ok(runningDeprecated.command);

  const selectedDeprecated = select("0.1.0-pre.2", "0.1.0-pre.3", {
    selectedEntry: entry("0.1.0-pre.3", { deprecated: "bad candidate" }),
  });
  assert.equal(selectedDeprecated.status, "unavailable");
  assert.equal(selectedDeprecated.relation, "unknown");
  assert.equal(selectedDeprecated.unavailable?.code, "selected_deprecated");
  assert.equal(selectedDeprecated.selected_version, "0.1.0-pre.3");
  assert.equal(selectedDeprecated.selected_integrity, INTEGRITY);
  assert.equal(selectedDeprecated.command, null);
  assert.deepEqual(selectedDeprecated.verify, []);

  const equalDeprecated = select("0.1.0-pre.2", "0.1.0-pre.2", {
    selectedEntry: entry("0.1.0-pre.2", { deprecated: "registry policy needs repair" }),
  });
  assert.equal(equalDeprecated.status, "deprecated");
  assert.equal(equalDeprecated.relation, "equal");
  assert.equal(equalDeprecated.running_deprecated, "registry policy needs repair");
  assert.equal(equalDeprecated.command, null);
});

test("missing and malformed registry policy fail closed with no install command", () => {
  const base = packument("0.1.0-pre.3", { runningVersion: "0.1.0-pre.2" });
  const inheritedTags = Object.create({ latest: "0.1.0-pre.3" }) as Record<string, unknown>;
  const cases: Array<[string, unknown, "tag_missing" | "malformed"]> = [
    ["missing dist-tags", { name: "superbee", versions: base.versions }, "tag_missing"],
    ["missing requested tag", { ...base, "dist-tags": {} }, "tag_missing"],
    ["inherited requested tag", { ...base, "dist-tags": inheritedTags }, "tag_missing"],
    ["non-string tag", { ...base, "dist-tags": { latest: 3 } }, "malformed"],
    ["non-SemVer tag", { ...base, "dist-tags": { latest: "v0.1.0" } }, "malformed"],
    ["missing versions", { ...base, versions: undefined }, "malformed"],
    ["missing selected entry", { ...base, versions: {} }, "malformed"],
    [
      "mismatched entry version",
      { ...base, versions: { "0.1.0-pre.3": { ...entry("0.1.0-pre.3"), version: "0.1.0-pre.4" } } },
      "malformed",
    ],
    [
      "mismatched package",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { name: "foreign" }) } },
      "malformed",
    ],
    [
      "missing integrity",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { integrity: "" }) } },
      "malformed",
    ],
    [
      "hostile integrity",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { integrity: "sha512-x\nsecret" }) } },
      "malformed",
    ],
    [
      "non-SRI integrity",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { integrity: "not-an-integrity" }) } },
      "malformed",
    ],
    [
      "wrong-length SHA-512 integrity",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { integrity: "sha512-eA==" }) } },
      "malformed",
    ],
    ["mismatched top-level package", { ...base, name: "foreign" }, "malformed"],
    [
      "non-string deprecation",
      { ...base, versions: { "0.1.0-pre.3": entry("0.1.0-pre.3", { deprecated: { message: "x" } }) } },
      "malformed",
    ],
    [
      "SemVer-equal but exact-different build metadata",
      packument("0.1.0-pre.2+other", { runningVersion: "0.1.0-pre.2+local" }),
      "malformed",
    ],
  ];
  for (const [label, value, code] of cases) {
    const result = selectSupportedRelease({
      packument: value,
      track: "latest",
      runningVersion: label.includes("build metadata") ? "0.1.0-pre.2+local" : "0.1.0-pre.2",
      checkedAt: CHECKED_AT,
    });
    assert.equal(result.status, "unavailable", label);
    assert.equal(result.unavailable?.code, code, label);
    assert.equal(result.command, null, label);
    assert.deepEqual(result.verify, [], label);
  }
  assert.throws(
    () =>
      selectSupportedRelease({
        packument: base,
        track: "latest",
        runningVersion: "not-semver",
        checkedAt: CHECKED_AT,
      }),
    /running package version is not valid strict SemVer/,
  );
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("bounded transport sends the exact request and never follows redirects or retries", async () => {
  let requestCount = 0;
  let redirectedTargetCount = 0;
  let receivedMethod = "";
  let receivedAccept = "";
  const server = createServer((request, response) => {
    requestCount += 1;
    receivedMethod = request.method ?? "";
    receivedAccept = request.headers.accept ?? "";
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/target" });
      response.end();
      return;
    }
    if (request.url === "/target") redirectedTargetCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(packument("0.1.0-pre.3")));
  });
  const origin = await listen(server);
  try {
    const success = await fetchSupportedReleasePackument({ endpoint: `${origin}/packument` });
    assert.equal(success.ok, true);
    assert.equal(receivedMethod, "GET");
    assert.equal(receivedAccept, UPDATE_CHECK_ACCEPT);
    assert.equal(requestCount, 1);

    const redirected = await fetchSupportedReleasePackument({ endpoint: `${origin}/redirect` });
    assert.equal(redirected.ok, false);
    if (!redirected.ok) assert.equal(redirected.unavailable.code, "http");
    assert.equal(redirectedTargetCount, 0, "redirect target was never requested");
    assert.equal(requestCount, 2, "no retry was attempted");
  } finally {
    await close(server);
  }
});

test("early response rejection aborts and cancels every untrusted response stream", async () => {
  for (const [label, status, headers, code] of [
    ["redirect", 302, { location: "https://example.invalid/target" }, "http"],
    ["http", 503, {}, "http"],
    ["declared oversized", 200, { "content-length": "9" }, "too_large"],
  ] as const) {
    let cancelCalls = 0;
    let requestSignal: AbortSignal | null = null;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(0x78));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const result = await fetchSupportedReleasePackument({
      maxBytes: 8,
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return new Response(body, { status, headers });
      },
    });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.unavailable.code, code, label);
    assert.equal(requestSignal?.aborted, true, `${label}: request was aborted`);
    assert.equal(cancelCalls, 1, `${label}: response body was cancelled before return`);
  }
});

test("an early streaming HTTP failure closes the peer connection within the total bound", async () => {
  const timeoutMs = 200;
  let resolvePeerClosed: (() => void) | undefined;
  const peerClosed = new Promise<void>((resolve) => {
    resolvePeerClosed = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/octet-stream" });
    response.flushHeaders();
    const interval = setInterval(() => response.write("x"), 10);
    response.on("close", () => {
      clearInterval(interval);
      resolvePeerClosed?.();
    });
  });
  const origin = await listen(server);
  const startedAt = Date.now();
  try {
    const result = await fetchSupportedReleasePackument({ endpoint: origin, timeoutMs, maxBytes: 8 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.unavailable.code, "http");
    await Promise.race([
      peerClosed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("peer connection remained open past the total bound")), timeoutMs),
      ),
    ]);
    assert.ok(Date.now() - startedAt < timeoutMs, "peer connection closed before the total deadline");
  } finally {
    await close(server);
  }
});

test("bounded transport classifies HTTP, malformed, oversized, timeout, and offline failures", async () => {
  const json = JSON.stringify(packument("0.1.0-pre.3"));
  const server = createServer((request, response) => {
    if (request.url === "/http") {
      response.writeHead(503);
      response.end("nope");
    } else if (request.url === "/malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
    } else if (request.url === "/invalid-utf8") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0xc3, 0x28]));
    } else if (request.url === "/partial") {
      response.writeHead(206, { "content-type": "application/json" });
      response.end(json);
    } else if (request.url === "/length") {
      response.writeHead(200, { "content-length": String(UPDATE_CHECK_MAX_BYTES + 1) });
      response.end();
    } else if (request.url === "/chunked") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(json.slice(0, 8));
      response.end(json.slice(8));
    }
  });
  const origin = await listen(server);
  try {
    for (const [path, code, maxBytes] of [
      ["/http", "http", undefined],
      ["/malformed", "malformed", undefined],
      ["/invalid-utf8", "malformed", undefined],
      ["/partial", "http", undefined],
      ["/length", "too_large", undefined],
      ["/chunked", "too_large", 5],
    ] as const) {
      const result = await fetchSupportedReleasePackument({
        endpoint: `${origin}${path}`,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });
      assert.equal(result.ok, false, path);
      if (!result.ok) assert.equal(result.unavailable.code, code, path);
    }
  } finally {
    await close(server);
  }

  let attempts = 0;
  const timeout = await fetchSupportedReleasePackument({
    timeoutMs: 10,
    fetchImpl: async (_input, init) => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    },
  });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.unavailable.code, "timeout");
  assert.equal(attempts, 1);

  const offline = await fetchSupportedReleasePackument({
    fetchImpl: async () => {
      throw new TypeError("getaddrinfo ENOTFOUND secret-hostname");
    },
  });
  assert.equal(offline.ok, false);
  if (!offline.ok) {
    assert.deepEqual(offline.unavailable, {
      code: "offline",
      message: "npm registry could not be reached",
    });
  }
});

test("network constants pin the public privacy and resource boundary", () => {
  assert.equal(UPDATE_CHECK_ENDPOINT, "https://registry.npmjs.org/superbee");
  assert.equal(UPDATE_CHECK_TIMEOUT_MS, 2_000);
  assert.equal(UPDATE_CHECK_MAX_BYTES, 1_048_576);
});

test("default transport sends only the fixed read-only registry request", async () => {
  let observedInput: string | URL | Request | undefined;
  let observedInit: RequestInit | undefined;
  const response = await fetchSupportedReleasePackument({
    fetchImpl: async (input, init) => {
      observedInput = input;
      observedInit = init;
      return new Response(JSON.stringify(packument("0.1.0-pre.3")), { status: 200 });
    },
  });
  assert.equal(response.ok, true);
  assert.equal(observedInput, UPDATE_CHECK_ENDPOINT);
  assert.deepEqual(observedInit?.headers, { accept: UPDATE_CHECK_ACCEPT });
  assert.equal(observedInit?.method, "GET");
  assert.equal(observedInit?.redirect, "manual");
  assert.equal(observedInit?.body, undefined);
  assert.ok(observedInit?.signal instanceof AbortSignal);
});

test("tag movement is observed per invocation and never persisted as preference", async () => {
  let selected = "0.1.0-pre.3";
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(packument(selected, { runningVersion: "0.1.0-pre.2" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const deps = { fetchImpl, now: () => new Date(CHECKED_AT) };
  const first = await checkSupportedRelease({ runningVersion: "0.1.0-pre.2", track: "latest" }, deps);
  selected = "0.1.0-pre.1";
  const second = await checkSupportedRelease({ runningVersion: "0.1.0-pre.2", track: "latest" }, deps);
  assert.equal(first.status, "upgrade_available");
  assert.equal(first.selected_version, "0.1.0-pre.3");
  assert.equal(second.status, "rollback_available");
  assert.equal(second.selected_version, "0.1.0-pre.1");
});

test("transport failures retain the complete structured check shape", async () => {
  const checked = await checkSupportedRelease(
    { runningVersion: "0.1.0-pre.2", track: "latest" },
    {
      now: () => new Date(CHECKED_AT),
      fetchImpl: async () => {
        throw new TypeError("offline with private diagnostic details");
      },
    },
  );
  assert.deepEqual(checked, {
    schema: UPDATE_CHECK_SCHEMA,
    track: "latest",
    status: "unavailable",
    relation: "unknown",
    checked_at: CHECKED_AT,
    running_version: "0.1.0-pre.2",
    selected_version: null,
    running_deprecated: null,
    selected_integrity: null,
    command: null,
    verify: [],
    unavailable: { code: "offline", message: "npm registry could not be reached" },
  });
});
