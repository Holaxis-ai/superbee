import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRevealPolicy, SurfaceContextError, FOLLOW_MS, OFFER_MS } from "../dist/index.js";

function fixture() {
  let mode = "suggestions", quiet = true, time = 0;
  const lifetime = new AbortController();
  const screen = new AbortController();
  const timers = new Map();
  const offers = [];
  const navigations = [];
  const policy = createRevealPolicy({ lifetime: lifetime.signal,
    screenSignal: () => screen.signal,
    resolve: input => {
      if (input === "stale") throw new SurfaceContextError("context_changed");
      return { target: input, ...(input === "implicit" ? { signal: screen.signal } : {}) };
    },
    surface: { mode: () => mode, quiet: () => quiet,
      offer(target, consumed) {
        const offer = { target, consumed, disposed: 0, dispose() { this.disposed++; } };
        offers.push(offer);
        return offer;
      },
      async navigate(target) { navigations.push(target); return target !== "fail"; },
    },
    clock: { now: () => time, schedule(callback) { const key = Symbol(); timers.set(key, callback); return () => timers.delete(key); } },
  });
  return { policy, offers, navigations, screen, lifetime, timers,
    mode(value) { mode = value; }, quiet(value) { quiet = value; }, tick(ms) { time += ms; },
  };
}

test("offers block until consumption and expire with their UI; stale callbacks do not clear another offer", async () => {
  const f = fixture();
  const offered = await f.policy.execute("one");
  assert.deepEqual(offered, { ok: true, offered: true, target: "one", expiresAt: OFFER_MS });
  assert.equal((await f.policy.execute("two")).error.code, "offer_pending");
  f.offers[0].consumed();
  await f.policy.execute("two");
  f.offers[0].consumed();
  assert.equal(f.offers[1].disposed, 0);
  [...f.timers.values()][0]();
  assert.equal(f.offers[1].disposed, 1);
  assert.equal(f.timers.size, 0);
  f.policy.dispose();
});

test("screen clear and lifetime abort retire explicit offers", async () => {
  for (const name of ["screen", "lifetime"]) {
    const f = fixture();
    await f.policy.execute("explicit");
    f[name].abort();
    assert.equal(f.offers[0].disposed, 1);
    assert.equal(f.timers.size, 0);
    f.policy.dispose();
  }
});

test("invocation cancellation retires a suggestion and removes its listener and timer", async () => {
  const f = fixture();
  const invocation = new AbortController();
  assert.equal((await f.policy.execute("explicit", { signal: invocation.signal })).offered, true);
  assert.equal(getEventListeners(invocation.signal, "abort").length, 1);
  invocation.abort();
  assert.equal(f.offers[0].disposed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(invocation.signal, "abort").length, 0);
  assert.equal((await f.policy.execute("next")).offered, true);
  f.policy.dispose();
});

test("an expired offer removes its invocation cancellation listener", async () => {
  const f = fixture();
  const invocation = new AbortController();
  await f.policy.execute("explicit", { signal: invocation.signal });
  [...f.timers.values()][0]();
  assert.equal(getEventListeners(invocation.signal, "abort").length, 0);
  f.policy.dispose();
});

test("independent target invalidation retires an offer without a screen transition", async () => {
  const lifetime = new AbortController(), screen = new AbortController(), target = new AbortController();
  let disposed = 0;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: value => ({ target: value, ...(value === "one" ? { signal: target.signal } : {}) }),
    surface: { mode: () => "suggestions", offer() { return { dispose() { disposed++; } }; } },
  });
  assert.equal((await policy.execute("one")).offered, true);
  assert.equal(getEventListeners(target.signal, "abort").length, 1);
  target.abort();
  assert.equal(screen.signal.aborted, false);
  assert.equal(disposed, 1);
  assert.equal(getEventListeners(target.signal, "abort").length, 0);
  assert.equal((await policy.execute("two")).offered, true);
  policy.dispose();
});

test("the default clock observes current Date.now rather than its construction-time function", async () => {
  const original = Date.now;
  const lifetime = new AbortController(), screen = new AbortController();
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "suggestions", offer() { return { dispose() {} }; } },
  });
  try {
    Date.now = () => 123;
    assert.equal((await policy.execute("target")).expiresAt, 123 + OFFER_MS);
  } finally { Date.now = original; policy.dispose(); }
});

test("a follow host receives the optional panel commit guard only through its navigation context", async () => {
  const lifetime = new AbortController(), screen = new AbortController();
  let commits = 0;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "follow", async navigate(_, context) {
      return context.admitCommit();
    } },
  });
  assert.equal((await policy.execute("target", { admitCommit() { commits++; return true; } })).navigated, true);
  assert.equal(commits, 1);
  policy.dispose();
});

test("follow stamps failed attempts, throttles quiet screens, degrades busy screens and resets on preference changes", async () => {
  const f = fixture();
  f.mode("follow");
  assert.equal((await f.policy.execute("fail")).error.code, "unavailable");
  assert.equal((await f.policy.execute("next")).error.code, "follow_pending");
  f.quiet(false);
  assert.equal((await f.policy.execute("busy")).offered, true);
  f.mode("off");
  assert.equal((await f.policy.execute("off")).error.code, "agent_navigation_off");
  assert.equal(f.offers[0].disposed, 1);
  f.mode("follow"); f.quiet(true);
  assert.equal((await f.policy.execute("next")).navigated, true);
  f.tick(FOLLOW_MS);
  assert.equal((await f.policy.execute("later")).navigated, true);
  f.policy.dispose();
});

test("cancel during navigation fences late success while screen transitions may be intentional", async () => {
  const lifetime = new AbortController();
  const screen = new AbortController();
  let complete;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target, signal: screen.signal }),
    surface: { mode: () => "follow", navigate: async () => new Promise(resolve => { complete = resolve; }) },
  });
  const canceled = new AbortController();
  const result = policy.execute("target", { signal: canceled.signal });
  canceled.abort(); complete(true);
  assert.equal((await result).error.code, "unavailable");
  policy.dispose();
});

test("a delayed navigation host observes cancellation before committing a side effect", async () => {
  const lifetime = new AbortController();
  const invocation = new AbortController();
  const screen = new AbortController();
  let release, commits = 0;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "follow", async navigate(_, context) {
      await new Promise(resolve => { release = resolve; });
      if (context.signal.aborted) return false;
      commits++; return true;
    } },
  });
  const result = policy.execute("target", { signal: invocation.signal });
  invocation.abort(); release();
  assert.equal((await result).error.code, "unavailable");
  assert.equal(commits, 0);
  policy.dispose();
});

test("successful admitted navigation may clear its own old screen context", async () => {
  const lifetime = new AbortController();
  const screen = new AbortController();
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target, signal: screen.signal }),
    surface: { mode: () => "follow", navigate: async () => { screen.abort(); return true; } },
  });
  assert.equal((await policy.execute("target")).navigated, true);
  policy.dispose();
  assert.equal((await policy.execute("target")).error.code, "unavailable");
});

test("an offer consumed synchronously cannot leave a pending UI or timer", async () => {
  const lifetime = new AbortController();
  const screen = new AbortController();
  let disposals = 0;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "suggestions", offer(_, consumed) {
      consumed(); return { dispose() { disposals++; } };
    } },
  });
  assert.equal((await policy.execute("target")).error.code, "unavailable");
  assert.equal((await policy.execute("again")).error.code, "unavailable");
  assert.equal(disposals, 2);
  policy.dispose();
});

test("stale resolution and unsupported hosts remain explicit", async () => {
  const f = fixture();
  assert.equal((await f.policy.execute("stale")).error.code, "context_changed");
  const policy = createRevealPolicy({ lifetime: f.lifetime.signal, screenSignal: () => f.screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "suggestions" } });
  assert.equal((await policy.execute("target")).error.code, "unsupported_host");
  policy.dispose(); f.policy.dispose();
});
