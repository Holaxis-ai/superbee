/**
 * The uncertain-write primitive over a scripted transport and a fake clock: every row is
 * deterministic. The rows pin the contract the browser-local sync component and bounded CLI
 * remote operations both rely on: a settled submission returns as is; an unknown submission is
 * resolved by lookup; resubmission happens only after a lookup returned null, and reuses the
 * same request identity; a failing lookup leaves the outcome unknown with bounded attempts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isAuthorizationRefusal,
  mintRequestId,
  performUncertainWrite,
  stateForOutcome,
  type OperationIntent,
  type OperationTransport,
  type Outcome,
  type Sleep,
} from "../src/uncertain-write.js";

const VERSION = "sha256:" + "a".repeat(64);
const OTHER = "sha256:" + "b".repeat(64);

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    requestId: "req-1",
    kind: "document.write",
    target: "notes/one",
    base: null,
    local: VERSION,
    content: "---\ntype: Note\n---\nbody\n",
    createdAt: "2026-09-10T00:00:00.000Z",
    attempts: 0,
    state: "pending",
    ...overrides,
  };
}

/** A transport whose answers are scripted per call; every call is recorded for assertions. */
function scripted(script: {
  submit?: Array<Outcome | Error | "hang">;
  lookup?: Array<Outcome | null | Error>;
}): OperationTransport & { calls: string[]; submittedIds: string[] } {
  const submits = [...(script.submit ?? [])];
  const lookups = [...(script.lookup ?? [])];
  const transport = {
    calls: [] as string[],
    submittedIds: [] as string[],
    async submit(current: OperationIntent, options?: { signal?: AbortSignal }): Promise<Outcome> {
      transport.calls.push("submit");
      transport.submittedIds.push(current.requestId);
      const next = submits.shift();
      if (next === undefined) throw new Error("unscripted submit");
      if (next === "hang") {
        return new Promise<Outcome>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (next instanceof Error) throw next;
      return next;
    },
    async lookup(): Promise<Outcome | null> {
      transport.calls.push("lookup");
      const next = lookups.shift();
      if (next === undefined) throw new Error("unscripted lookup");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return transport;
}

/** A clock that records requested waits and resolves them in order when told to. */
function fakeClock(): { sleep: Sleep; waits: number[]; release(): void } {
  const pending: Array<() => void> = [];
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        pending.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    release() {
      const next = pending.shift();
      next?.();
    },
  };
}

const immediate: Sleep = async () => {};

test("a committed submission settles as acknowledged with one attempt and no lookup", async () => {
  const transport = scripted({ submit: [{ kind: "committed", version: VERSION }] });
  const result = await performUncertainWrite(transport, intent(), { sleep: immediate });
  assert.deepEqual(result.outcome, { kind: "committed", version: VERSION });
  assert.equal(result.intent.state, "acknowledged");
  assert.equal(result.intent.attempts, 1);
  assert.equal(result.lookups, 0);
  assert.deepEqual(transport.calls, ["submit"]);
});

test("a conflict and a refusal are real results: settled without lookup, states conflict and refused", async () => {
  const conflict = await performUncertainWrite(scripted({ submit: [{ kind: "conflict", actual: OTHER }] }), intent(), { sleep: immediate });
  assert.equal(conflict.intent.state, "conflict");
  assert.deepEqual(conflict.outcome, { kind: "conflict", actual: OTHER });
  assert.equal(conflict.lookups, 0);

  const refused = await performUncertainWrite(
    scripted({ submit: [{ kind: "refused", code: "AUTH_REQUIRED", message: "token revoked" }] }),
    intent(),
    { sleep: immediate },
  );
  assert.equal(refused.intent.state, "refused");
  assert.equal(isAuthorizationRefusal(refused.outcome), true);
  assert.equal(isAuthorizationRefusal({ kind: "refused", code: "USAGE", message: "bad" }), false);
  assert.equal(stateForOutcome({ kind: "unknown" }), "unknown");
});

test("a transport error then a lookup that finds committed settles without resubmission", async () => {
  const transport = scripted({
    submit: [new Error("socket closed")],
    lookup: [{ kind: "committed", version: VERSION }],
  });
  const result = await performUncertainWrite(transport, intent(), { sleep: immediate });
  assert.deepEqual(result.outcome, { kind: "committed", version: VERSION });
  assert.equal(result.intent.state, "acknowledged");
  assert.equal(result.intent.attempts, 1);
  assert.equal(result.lookups, 1);
  assert.deepEqual(transport.calls, ["submit", "lookup"]);
});

test("a transport error then a null lookup resubmits once with the SAME requestId and succeeds", async () => {
  const transport = scripted({
    submit: [new Error("connection refused"), { kind: "committed", version: VERSION }],
    lookup: [null],
  });
  const result = await performUncertainWrite(transport, intent({ requestId: "req-stable" }), { sleep: immediate });
  assert.deepEqual(result.outcome, { kind: "committed", version: VERSION });
  assert.equal(result.intent.attempts, 2);
  assert.deepEqual(transport.calls, ["submit", "lookup", "submit"]);
  assert.deepEqual(transport.submittedIds, ["req-stable", "req-stable"]);
});

test("a transport error then lookups that keep failing leaves the outcome unknown, lookups bounded, no resubmission", async () => {
  const clock = fakeClock();
  const transport = scripted({
    submit: [new Error("timeout")],
    lookup: [new Error("offline"), new Error("offline"), new Error("offline"), new Error("offline")],
  });
  const run = performUncertainWrite(transport, intent(), { sleep: clock.sleep, maxLookups: 3, lookupDelayMs: 40 });
  // Two waits separate three lookups; releasing them drives the loop.
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    clock.release();
  }
  const result = await run;
  assert.deepEqual(result.outcome, { kind: "unknown" });
  assert.equal(result.intent.state, "unknown");
  assert.equal(result.intent.attempts, 1);
  assert.equal(result.lookups, 3);
  assert.deepEqual(clock.waits, [40, 40]);
  assert.deepEqual(transport.calls, ["submit", "lookup", "lookup", "lookup"]);
});

test("the deadline is honored with a fake clock: a hanging submission is aborted and resolved by lookup", async () => {
  const clock = fakeClock();
  const transport = scripted({ submit: ["hang"], lookup: [{ kind: "committed", version: VERSION }] });
  const run = performUncertainWrite(transport, intent(), { sleep: clock.sleep, deadlineMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clock.waits, [5000]);
  clock.release();
  const result = await run;
  assert.deepEqual(result.outcome, { kind: "committed", version: VERSION });
  assert.equal(result.intent.attempts, 1);
  assert.deepEqual(transport.calls, ["submit", "lookup"]);
});

test("a previously submitted intent (attempts > 0) starts at the lookup, never at a blind resubmission", async () => {
  const found = scripted({ lookup: [{ kind: "conflict", actual: OTHER }] });
  const settled = await performUncertainWrite(found, intent({ attempts: 1 }), { sleep: immediate });
  assert.deepEqual(found.calls, ["lookup"]);
  assert.equal(settled.intent.state, "conflict");
  assert.equal(settled.intent.attempts, 1);

  const absent = scripted({ lookup: [null], submit: [{ kind: "committed", version: VERSION }] });
  const delivered = await performUncertainWrite(absent, intent({ attempts: 1 }), { sleep: immediate });
  assert.deepEqual(absent.calls, ["lookup", "submit"]);
  assert.equal(delivered.intent.attempts, 2);
});

test("submissions are bounded: null lookups cannot drive an unbounded resubmission loop", async () => {
  const transport = scripted({
    submit: [new Error("x"), new Error("x"), new Error("x")],
    lookup: [null, null, null],
  });
  const result = await performUncertainWrite(transport, intent(), { sleep: immediate, maxSubmissions: 2 });
  assert.deepEqual(result.outcome, { kind: "unknown" });
  assert.equal(result.intent.attempts, 2);
  assert.deepEqual(transport.calls, ["submit", "lookup", "submit", "lookup"]);
});

test("mintRequestId returns distinct UUIDs", () => {
  const a = mintRequestId();
  const b = mintRequestId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});
