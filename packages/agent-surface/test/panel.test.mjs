import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountAssistantPanel, createRevealPolicy } from "../dist/index.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selection = (bindingId = "bundle-one") => ({ bundleId: bindingId, bindingId, surfaceId: "tab-one", contextRevision: "mount:1", label: "Saved workspace documents" });
function fixture(t, overrides = {}, options = {}) {
  const dom = new JSDOM("<aside></aside>");
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector("aside");
  let context = selection();
  let receive;
  const starts = [], navigations = [], receipts = [];
  const transport = {
    async start(value) { starts.push(value.bindingId); return { sessionId: value.bindingId, status: "active" }; },
    async send() { return { turnId: "turn-one" }; },
    async steer() { return { turnId: "redirected-turn" }; },
    async cancel() {},
    events(sessionId, after, signal, callback) {
      receive = callback;
      return new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    },
    async receipt(request, outcome) { receipts.push([request.toolCallId, outcome]); },
    ...overrides,
  };
  const panel = mountAssistantPanel({ root, context: () => context, transport,
    navigate: options.navigate ?? (async request => { navigations.push(request); return "navigated"; }),
    async openSource() {},
  });
  t.after(() => panel.dispose());
  return { dom, root, panel, starts, navigations, receipts,
    context: value => { context = value; },
    event(seq, type, payload) { receive({ seq, at: new Date().toISOString(), type, payload }); },
    submit(text = "Question") {
      root.querySelector("textarea").value = text;
      root.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    },
  };
}
const navigationRequest = () => ({ sessionId: "bundle-one", turnId: "turn-one", toolCallId: "nav-one", surfaceId: "tab-one", bindingId: "bundle-one", contextRevision: "mount:1", target: { kind: "document", bundleId: "bundle-one", documentId: "notes/launch" }, expiresAt: Date.now() + 60000 });
function offeredNavigation(t) {
  const lifetime = new AbortController(), screen = new AbortController();
  let visible = false, consume;
  const policy = createRevealPolicy({ lifetime: lifetime.signal, screenSignal: () => screen.signal,
    resolve: target => ({ target }), surface: { mode: () => "suggestions", offer(_, consumed) {
      visible = true; consume = consumed; return { dispose() { visible = false; } };
    } },
  });
  t.after(() => policy.dispose());
  const f = fixture(t, {}, { async navigate(request, signal, admitCommit) {
    const result = await policy.execute(request.target, { signal, admitCommit });
    return result.ok ? "offered" : "cancelled";
  } });
  return { ...f, visible: () => visible, consume: () => consume() };
}
function answer(f, start = 1) {
  f.event(start, "turn.accepted", { turnId: "turn-one", text: "What is the launch date?" });
  f.event(start + 1, "agent.text", { turnId: "turn-one", text: "October 5 <script>untrusted()</script>" });
  f.event(start + 2, "source.read", { turnId: "turn-one", toolCallId: "read-one", source: {
    sourceId: "source-one", kind: "hosted-document", bundleId: "bundle-one", documentId: "notes/launch", version: "sha256:test",
  } });
  f.event(start + 3, "turn.ended", { turnId: "turn-one", stopReason: "end_turn" });
}

test("losing or replacing the active source clears retained answers and citations", async t => {
  const f = fixture(t);
  f.panel.show(); await tick(); answer(f);
  assert.match(f.root.textContent, /October 5/);
  assert.equal(f.root.querySelectorAll("script").length, 0);
  assert.equal(f.root.querySelectorAll("[data-source-id]").length, 1);
  f.context(undefined); await f.panel.refresh();
  assert.doesNotMatch(f.root.textContent, /October 5|notes\/launch/);
  f.context(selection("bundle-two")); await f.panel.refresh();
  assert.deepEqual(f.starts, ["bundle-one", "bundle-two"]);
  assert.doesNotMatch(f.root.textContent, /October 5/);
});

test("a source changed during admission starts its own conversation immediately", async t => {
  const pending = deferred();
  const f = fixture(t, { async start(value) {
    f.starts.push(value.bindingId);
    return value.bindingId === "bundle-one" ? pending.promise : { sessionId: value.bindingId, status: "active" };
  } });
  f.panel.show(); await tick();
  f.context(selection("bundle-two")); await f.panel.refresh();
  pending.resolve({ sessionId: "bundle-one", status: "active" }); await tick(); await tick();
  assert.deepEqual(f.starts, ["bundle-one", "bundle-two"]);
  assert.equal(f.root.querySelector('[type="submit"]').disabled, false);
});

for (const middle of [selection("bundle-two"), undefined]) {
  test(`pending A -> ${middle ? "B" : "absent"} -> A admission cannot revive an obsolete start`, async t => {
    const admissions = [], streams = [];
    const f = fixture(t, {
      start(context, signal) {
        const pending = deferred();
        admissions.push({ context, signal, pending });
        return pending.promise;
      },
      events(sessionId, after, signal, callback) {
        streams.push(sessionId);
        callback({ seq: 1, at: "now", type: "agent.text", payload: { turnId: "old", text: "stale answer" } });
        return new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      },
    });
    f.panel.show(); await tick();
    f.context(middle); void f.panel.refresh(); await tick();
    assert.equal(admissions[0].signal.aborted, true);
    f.context(selection()); void f.panel.refresh(); await tick();
    assert.equal(admissions.length, middle ? 3 : 2);
    for (const admission of admissions.slice(0, -1)) {
      assert.equal(admission.signal.aborted, true);
      admission.pending.resolve({ sessionId: "obsolete", status: "active" });
    }
    await tick();
    assert.deepEqual(streams, []);
    assert.doesNotMatch(f.root.textContent, /stale answer/);
    admissions.at(-1).pending.resolve({ sessionId: "current", status: "active" });
    await tick();
    assert.deepEqual(streams, ["current"]);
    assert.equal(f.root.querySelector('[type="submit"]').disabled, false);
  });
}

test("late send receipt cannot activate a turn in a replacement source", async t => {
  const pending = deferred();
  const f = fixture(t, { send: () => pending.promise });
  f.panel.show(); await tick(); f.submit();
  f.context(selection("bundle-two")); await f.panel.refresh();
  pending.resolve({ turnId: "old-turn" }); await tick();
  assert.equal(f.root.querySelector('[type="submit"]').disabled, false);
  assert.equal(f.root.querySelector(".assistant-actions button:nth-child(2)").disabled, true);
});

test("terminal stream event preceding send response keeps the completed turn settled", async t => {
  const pending = deferred();
  const f = fixture(t, { send: () => pending.promise });
  f.panel.show(); await tick(); f.submit(); answer(f);
  pending.resolve({ turnId: "turn-one" }); await tick();
  assert.equal(f.root.querySelector('[type="submit"]').disabled, false);
  assert.match(f.root.querySelector('[role="status"]').textContent, /Ready/);
});

test("terminal event preceding a cancel response keeps Ready status", async t => {
  const pending = deferred();
  const f = fixture(t, { cancel: () => pending.promise });
  f.panel.show(); await tick();
  f.event(1, "turn.accepted", { turnId: "turn-one", text: "Question" });
  f.root.querySelector(".assistant-actions button:nth-child(2)").click();
  f.event(2, "turn.ended", { turnId: "turn-one", stopReason: "end_turn" });
  pending.resolve(); await tick();
  assert.match(f.root.querySelector('[role="status"]').textContent, /Ready/);
  assert.equal(f.root.querySelector(".assistant-actions button:nth-child(2)").disabled, true);
});

test("Stop immediately retires a same-turn offered navigation", async t => {
  const f = offeredNavigation(t); f.panel.show(); await tick();
  f.event(1, "turn.accepted", { turnId: "turn-one", text: "Question" });
  f.event(2, "navigation.requested", navigationRequest()); await tick();
  assert.equal(f.visible(), true);
  f.root.querySelector(".assistant-actions button:nth-child(2)").click();
  assert.equal(f.visible(), false);
});

test("a successful end_turn preserves its offer until the person consumes it", async t => {
  const f = offeredNavigation(t); f.panel.show(); await tick();
  f.event(1, "turn.accepted", { turnId: "turn-one", text: "Question" });
  f.event(2, "navigation.requested", navigationRequest()); await tick();
  f.event(3, "turn.ended", { turnId: "turn-one", stopReason: "end_turn" });
  assert.equal(f.visible(), true);
  f.consume(); assert.equal(f.visible(), false);
});

for (const [type, payload] of [
  ["turn.ended", { turnId: "turn-one", stopReason: "interrupted" }],
  ["tool.cancelled", { turnId: "turn-one", toolCallId: "nav-one" }],
  ["session.fenced", { reason: "revoked" }],
]) {
  test(`${type} retires the turn's outstanding navigation offer`, async t => {
    const f = offeredNavigation(t); f.panel.show(); await tick();
    f.event(1, "turn.accepted", { turnId: "turn-one", text: "Question" });
    f.event(2, "navigation.requested", navigationRequest()); await tick();
    assert.equal(f.visible(), true);
    f.event(3, type, payload);
    assert.equal(f.visible(), false);
  });
}

for (const next of [selection("bundle-two"), { ...selection(), contextRevision: "mount:2" }]) {
  test(`replacing the navigation ${next.bindingId === "bundle-one" ? "revision" : "binding"} fences a delayed host result and receipt`, async t => {
    const pending = deferred(); let signal, commit;
    const f = fixture(t, {}, { async navigate(_, capturedSignal, admitCommit) {
      signal = capturedSignal; commit = admitCommit;
      await pending.promise; return "navigated";
    } });
    f.panel.show(); await tick();
    f.event(1, "navigation.requested", navigationRequest());
    f.context(next); await f.panel.refresh();
    assert.equal(signal.aborted, true);
    assert.equal(commit(), false);
    pending.resolve(); await tick();
    assert.deepEqual(f.receipts, []);
  });
}

test("an admitted intentional SPA commit records its original navigation receipt after the revision changes", async t => {
  const f = fixture(t, {}, { async navigate(_, signal, admitCommit) {
    assert.equal(signal.aborted, false);
    assert.equal(admitCommit(), true);
    f.context({ ...selection(), contextRevision: "mount:2" });
    await f.panel.refresh();
    assert.equal(signal.aborted, true);
    return "navigated";
  } });
  f.panel.show(); await tick();
  f.event(1, "navigation.requested", navigationRequest()); await tick();
  assert.deepEqual(f.receipts, [["nav-one", "navigated"]]);
});

test("a cancel response from a replaced source cannot change the current conversation status", async t => {
  const pending = deferred();
  const f = fixture(t, { cancel: () => pending.promise });
  f.panel.show(); await tick();
  f.event(1, "turn.accepted", { turnId: "turn-one", text: "Question" });
  f.root.querySelector(".assistant-actions button:nth-child(2)").click();
  f.context(selection("bundle-two")); await f.panel.refresh();
  const status = f.root.querySelector('[role="status"]').textContent;
  pending.resolve(); await tick();
  assert.equal(f.root.querySelector('[role="status"]').textContent, status);
});

test("only the originating current surface executes each navigation request once", async t => {
  const f = fixture(t); f.panel.show(); await tick();
  const request = { sessionId: "bundle-one", turnId: "turn-one", toolCallId: "nav-one", surfaceId: "tab-one", bindingId: "bundle-one", contextRevision: "mount:1", target: { kind: "document", bundleId: "bundle-one", documentId: "notes/launch" }, expiresAt: Date.now() + 60000 };
  f.event(1, "navigation.requested", { ...request, surfaceId: "other-tab", toolCallId: "other" });
  f.event(2, "navigation.requested", { ...request, contextRevision: "previous-mount", toolCallId: "old" });
  f.event(3, "navigation.requested", request);
  f.event(3, "navigation.requested", request);
  f.event(4, "navigation.requested", request);
  await tick();
  assert.equal(f.navigations.length, 1);
  assert.deepEqual(f.receipts, [["nav-one", "navigated"]]);
  f.panel.fence("Access ended");
  assert.equal(f.root.querySelector('[type="submit"]').disabled, true);
});

test("disposing before a panel remount removes the old keyboard handler", async t => {
  const f = fixture(t); f.panel.show(); await tick();
  let closes = 0;
  f.root.addEventListener("assistant-close", () => closes++);
  f.panel.dispose();
  const next = mountAssistantPanel({ root: f.root, context: () => undefined, transport: {}, navigate: async () => "unsupported", openSource: async () => {} });
  t.after(() => next.dispose());
  f.root.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(closes, 1);
});

 test("redirect submits the active turn identity through the steer contract", async t => {
  const calls = [];
  const f = fixture(t, { async steer(sessionId, turnId, text) { calls.push({sessionId, turnId, text}); return {turnId: "turn-two"}; } });
  f.panel.show(); await tick();
  f.event(1, "turn.accepted", { turnId: "turn-one", text: "First question" });
  assert.equal(f.root.querySelector('[type="submit"]').textContent, "Redirect");
  f.submit("Use the release decision"); await tick();
  assert.deepEqual(calls, [{sessionId: "bundle-one", turnId: "turn-one", text: "Use the release decision"}]);
 });
