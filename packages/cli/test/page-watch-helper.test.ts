import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

import { NPM_RESOURCES } from "../src/distribution-resources.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const authorities = {
  contract: "examples/views/references/view-authoring-v0.md",
  pulse: "examples/views/pulse.html",
  roadmap: "examples/views/roadmap.html",
} as const;

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function clientFrom(relative: string): string {
  const text = source(relative);
  const match = relative.endsWith(".md")
    ? text.match(/```js\n(\(function \(\) \{[\s\S]*?\n\}\)\(\);)\n```/)
    : text.match(/<script>\s*(\(function \(\) \{[\s\S]*?\n\}\)\(\);)/);
  assert.ok(match, `could not extract literal bridge client from ${relative}`);
  return match[1]!;
}

function watchFrom(relative: string): string {
  const text = source(relative);
  const start = text.indexOf("function watch(refresh) {");
  assert.notEqual(start, -1, `missing watch implementation in ${relative}`);
  const brace = text.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unterminated watch implementation in ${relative}`);
}

type Request = { bridge: string; id?: string; type: string };

function harness(relative: string) {
  const requests: Request[] = [];
  const errors: unknown[][] = [];
  let onMessage: ((event: { source: object; data: unknown }) => void) | undefined;
  const parent = {
    postMessage(message: Request) {
      requests.push(message);
    },
  };
  const window = {
    parent,
    Bridge: undefined as unknown,
    addEventListener(type: string, listener: typeof onMessage) {
      if (type === "message") onMessage = listener;
    },
  };
  vm.runInNewContext(clientFrom(relative), {
    window,
    parent,
    Promise,
    TypeError,
    Error,
    console: { error: (...args: unknown[]) => errors.push(args) },
  });
  assert.ok(onMessage, "client did not install its message listener");
  const Bridge = window.Bridge as {
    subscribe(callback: (event: unknown) => void): Promise<unknown>;
    watch(refresh: (events: unknown[]) => unknown): Promise<unknown>;
  };
  function respond(request: Request, result: unknown = { ok: true }) {
    onMessage!({
      source: parent,
      data: { bridge: "v0", id: request.id, type: `${request.type}:result`, result },
    });
  }
  function reject(request: Request, message = "no subscription") {
    onMessage!({
      source: parent,
      data: { bridge: "v0", id: request.id, type: "error", error: { message } },
    });
  }
  function change(event: unknown) {
    onMessage!({ source: parent, data: { bridge: "v0", type: "change", event } });
  }
  return { Bridge, requests, errors, respond, reject, change };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("the contract and both examples embed one identical watch implementation", () => {
  const copies = Object.values(authorities).map(watchFrom);
  assert.equal(copies[1], copies[0]);
  assert.equal(copies[2], copies[0]);
});

test("the contract and both worked Pages remain in the shipped skill references", () => {
  const shipped = new Set(NPM_RESOURCES.map(({ src }) => src));
  for (const relative of Object.values(authorities)) assert.ok(shipped.has(relative), `${relative} is not shipped`);
});

test("first-party workflow Views prefer the logical progress_status projection", () => {
  for (const relative of [
    "examples/views/pulse.html",
    "examples/views/roadmap.html",
    "examples/recipes/review-workflow/views/review-workflow/reviews.html",
  ]) {
    assert.match(source(relative), /progress_status/, `${relative} bypasses the logical workflow field`);
  }
});

for (const [name, relative] of Object.entries(authorities)) {
  test(`${name}: subscribes before snapshot and buffers pre-ack events`, async () => {
    const h = harness(relative);
    const batches: unknown[][] = [];
    const watched = h.Bridge.watch((events) => {
      batches.push(normalized(events) as unknown[]);
      return "initial value";
    });
    assert.deepEqual(h.requests.map(({ type }) => type), ["subscribe"]);
    h.change({ changes: [{ id: "tasks/a" }], removed: [] });
    assert.equal(batches.length, 0);
    h.respond(h.requests[0]!);
    assert.equal(await watched, "initial value");
    assert.deepEqual(batches, [[{ changes: [{ id: "tasks/a" }], removed: [] }]]);
  });

  test(`${name}: serializes refreshes and batches events arriving during each run`, async () => {
    const h = harness(relative);
    const first = deferred<void>();
    const second = deferred<void>();
    const batches: unknown[][] = [];
    let active = 0;
    let maxActive = 0;
    const watched = h.Bridge.watch(async (events) => {
      batches.push(normalized(events) as unknown[]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const call = batches.length;
      if (call === 1) await first.promise;
      if (call === 2) await second.promise;
      active -= 1;
    });
    h.respond(h.requests[0]!);
    await flush();
    h.change({ n: 1 });
    h.change({ n: 2 });
    first.resolve();
    await watched;
    await flush();
    assert.deepEqual(batches, [[], [{ n: 1 }, { n: 2 }]]);
    h.change({ n: 3 });
    second.resolve();
    await flush();
    assert.deepEqual(batches, [[], [{ n: 1 }, { n: 2 }], [{ n: 3 }]]);
    assert.equal(maxActive, 1);
  });

  test(`${name}: initial failure rejects its Promise but queued work continues`, async () => {
    const h = harness(relative);
    const first = deferred<void>();
    const batches: unknown[][] = [];
    const watched = h.Bridge.watch(async (events) => {
      batches.push(normalized(events) as unknown[]);
      if (batches.length === 1) await first.promise;
    });
    h.respond(h.requests[0]!);
    await flush();
    h.change({ n: 1 });
    first.reject(new Error("initial failed"));
    await assert.rejects(watched, /initial failed/);
    await flush();
    assert.deepEqual(batches, [[], [{ n: 1 }]]);
  });

  test(`${name}: later failure is reported without dropping queued or future events`, async () => {
    const h = harness(relative);
    const later = deferred<void>();
    const batches: unknown[][] = [];
    const watched = h.Bridge.watch(async (events) => {
      batches.push(normalized(events) as unknown[]);
      if (batches.length === 2) await later.promise;
    });
    h.respond(h.requests[0]!);
    await watched;
    h.change({ n: 1 });
    await flush();
    h.change({ n: 2 });
    later.reject(new Error("later failed"));
    await flush();
    assert.deepEqual(batches, [[], [{ n: 1 }], [{ n: 2 }]]);
    assert.equal(h.errors.length, 1);
    assert.match(String(h.errors[0]![1]), /later failed/);
    h.change({ n: 3 });
    await flush();
    assert.deepEqual(batches[3], [{ n: 3 }]);
  });

  test(`${name}: failed subscription permanently deactivates only that watcher`, async () => {
    const h = harness(relative);
    const a: unknown[][] = [];
    const b: unknown[][] = [];
    const watchA = h.Bridge.watch((events) => a.push(normalized(events) as unknown[]));
    const requestA = h.requests[0]!;
    h.reject(requestA);
    await assert.rejects(watchA, /no subscription/);
    const watchB = h.Bridge.watch((events) => b.push(normalized(events) as unknown[]));
    const requestB = h.requests[1]!;
    h.respond(requestB);
    await watchB;
    h.change({ n: 1 });
    await flush();
    assert.deepEqual(a, []);
    assert.deepEqual(b, [[], [{ n: 1 }]]);
  });

  test(`${name}: raw subscribe remains unchanged`, async () => {
    const h = harness(relative);
    const events: unknown[] = [];
    const subscribed = h.Bridge.subscribe((event) => events.push(normalized(event)));
    assert.deepEqual(h.requests.map(({ type }) => type), ["subscribe"]);
    h.respond(h.requests[0]!, { ok: true });
    assert.deepEqual(await subscribed, { ok: true });
    h.change({ n: 1 });
    assert.deepEqual(events, [{ n: 1 }]);
  });

  test(`${name}: successful watchers schedule independently`, async () => {
    const h = harness(relative);
    const a: unknown[][] = [];
    const b: unknown[][] = [];
    const watchA = h.Bridge.watch((events) => a.push(normalized(events) as unknown[]));
    const watchB = h.Bridge.watch((events) => b.push(normalized(events) as unknown[]));
    h.respond(h.requests[0]!);
    h.respond(h.requests[1]!);
    await Promise.all([watchA, watchB]);
    h.change({ n: 1 });
    await flush();
    assert.deepEqual(a, [[], [{ n: 1 }]]);
    assert.deepEqual(b, [[], [{ n: 1 }]]);
  });

  test(`${name}: invalid refresh rejects before sending a request`, async () => {
    const h = harness(relative);
    await assert.rejects(h.Bridge.watch(null as unknown as (events: unknown[]) => unknown), /requires a refresh function/);
    assert.deepEqual(h.requests, []);
  });
}
