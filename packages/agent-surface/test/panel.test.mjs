import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountAssistantPanel } from "../dist/index.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selection = (bindingId = "bundle-one") => ({ bundleId: bindingId, bindingId, surfaceId: "tab-one", contextRevision: "mount:1", label: "Saved workspace documents" });
function fixture(t, overrides = {}) {
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
    async navigate(request) { navigations.push(request); return "navigated"; },
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

test("a source changed during admission starts its own conversation after the old start settles", async t => {
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
