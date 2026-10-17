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

test("a conflict whose actual is the intent's own version is the write already committed: settled as committed, by submission and by lookup", async () => {
  // The wire's post-expiry compare-and-swap: a committed write resubmitted after the authority's
  // retention window answers a conflict against the client's own committed version.
  const resubmitted = await performUncertainWrite(scripted({ submit: [{ kind: "conflict", actual: VERSION }] }), intent(), { sleep: immediate });
  assert.deepEqual(resubmitted.outcome, { kind: "committed", version: VERSION });
  assert.equal(resubmitted.intent.state, "acknowledged");
  assert.equal(resubmitted.lookups, 0);

  const recorded = await performUncertainWrite(
    scripted({ submit: [new Error("socket closed")], lookup: [{ kind: "conflict", actual: VERSION }] }),
    intent(),
    { sleep: immediate },
  );
  assert.deepEqual(recorded.outcome, { kind: "committed", version: VERSION });
  assert.equal(recorded.intent.state, "acknowledged");
  assert.equal(recorded.lookups, 1);

  // Any other head is a real conflict, and a null head (the target deleted) is too.
  const other = await performUncertainWrite(scripted({ submit: [{ kind: "conflict", actual: OTHER }] }), intent(), { sleep: immediate });
  assert.deepEqual(other.outcome, { kind: "conflict", actual: OTHER });
  assert.equal(other.intent.state, "conflict");
  const absent = await performUncertainWrite(scripted({ submit: [{ kind: "conflict", actual: null }] }), intent(), { sleep: immediate });
  assert.deepEqual(absent.outcome, { kind: "conflict", actual: null });
  assert.equal(absent.intent.state, "conflict");
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

// The explicit recorded-only path carries typed evidence without pretending a delete writes a
// document or a replacement version. Its caller owns the fresh durable claim and checkout lock.
interface DeleteClaim {
  requestId: string; kind: "blobs.delete.v1"; target: string; createdAt: string;
  attempts: number; state: "pending" | "in_flight" | "unknown";
}
type DeleteEvidence = {
  kind: "committed";
  receipt: { scope: string; head: null; removed: { version: string; contentType: string } };
};
const deleteClaim = (attempts = 1): DeleteClaim => ({ requestId: "blob-delete", kind: "blobs.delete.v1", target: "opaque.bin", createdAt: "2026-10-17T00:00:00Z", attempts, state: "in_flight" });
const deleteEvidence = (contentType = "application/original"): DeleteEvidence => ({ kind: "committed", receipt: { scope: "checkout", head: null, removed: { version: VERSION, contentType } } });

test("submit-claimed sends the counted claim once and preserves a typed delete receipt without a version", async () => {
  const original = deleteClaim(3), chosen = deleteEvidence();
  let sends = 0;
  const result = await performUncertainWrite({
    async submit(claim: DeleteClaim) {
      sends++;
      assert.deepEqual(claim, original);
      assert.equal("base" in claim || "local" in claim || "content" in claim, false);
      return chosen;
    },
    async lookup() { assert.fail("no lookup for an immediate recorded commit"); },
  }, original, { settlement: "recorded-only", start: "submit-claimed" });
  assert.equal(sends, 1);
  assert.equal(result.intent.attempts, 3);
  assert.equal(result.intent.state, "acknowledged");
  assert.equal(result.intent.kind, "blobs.delete.v1");
  assert.equal(result.outcome, chosen);
  if (result.outcome.kind !== "committed") assert.fail("typed commit expected");
  assert.equal(result.outcome.receipt.head, null);
  assert.equal(result.outcome.receipt.removed.contentType, "application/original");
  assert.equal("version" in result.outcome, false);
  assert.equal(original.state, "in_flight");
});

test("explicit starts reject unsafe counts, unclaimed submission states and conflicting modes before transport", async () => {
  let calls = 0;
  const transport = { async submit() { calls++; return deleteEvidence(); }, async lookup() { calls++; return null; } };
  for (const count of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(performUncertainWrite(transport, deleteClaim(count), { settlement: "recorded-only", start: "submit-claimed" }), /durable claim/);
  }
  for (const state of ["pending", "unknown", "acknowledged", "invalid"]) {
    await assert.rejects(performUncertainWrite(transport, { ...deleteClaim(), state } as DeleteClaim, { settlement: "recorded-only", start: "submit-claimed" }), /durable claim/);
  }
  for (const options of [{ settlement: "exact-content", start: "submit-claimed" }, { settlement: "recorded-only", start: "invalid" }, { settlement: "recorded-only", start: undefined }]) {
    await assert.rejects(performUncertainWrite(transport, deleteClaim(), options as never), /delivery start/);
  }
  await assert.rejects(performUncertainWrite(transport, deleteClaim(-1), { settlement: "recorded-only", start: "lookup" }), /durable claim/);
  assert.equal(calls, 0);
});

test("lookup starts never send after absent evidence or failed lookup, including a reopened counted claim", async () => {
  for (const attempts of [0, 1, Number.MAX_SAFE_INTEGER]) {
    for (const fails of [false, true]) {
      let sends = 0, lookups = 0;
      const result = await performUncertainWrite({
        async submit() { sends++; return deleteEvidence(); },
        async lookup(requestId: string) { assert.equal(requestId, "blob-delete"); lookups++; if (fails) throw new Error("offline"); return null; },
      }, deleteClaim(attempts), { settlement: "recorded-only", start: "lookup", maxLookups: 2, sleep: immediate });
      assert.equal(sends, 0);
      assert.equal(lookups, fails ? 2 : 1);
      assert.equal(result.intent.attempts, attempts);
      assert.deepEqual(result.outcome, { kind: "unknown" });
    }
  }
});

test("a claimed unknown submission cannot resend after absence and an aborted claim is never sent", async () => {
  let sends = 0, lookups = 0;
  const transport = {
    async submit() { sends++; return { kind: "unknown" as const }; },
    async lookup() { lookups++; return null; },
  };
  const result = await performUncertainWrite(transport, deleteClaim(), { settlement: "recorded-only", start: "submit-claimed", maxSubmissions: 20 } as never);
  assert.equal(sends, 1); assert.equal(lookups, 1);
  assert.equal(result.intent.attempts, 1);
  assert.deepEqual(result.outcome, { kind: "unknown" });
  const controller = new AbortController(); controller.abort();
  const stopped = await performUncertainWrite(transport, deleteClaim(), { settlement: "recorded-only", start: "submit-claimed", signal: controller.signal });
  assert.equal(sends, 1); assert.equal(lookups, 1);
  assert.equal(stopped.intent.attempts, 1);
  assert.deepEqual(stopped.outcome, { kind: "unknown" });
});

test("a deadline-late candidate cannot replace the selected typed lookup receipt or selected unknown", async () => {
  for (const found of [true, false]) {
    let release!: (evidence: DeleteEvidence) => void;
    const chosen = deleteEvidence("application/selected; exact=Yes");
    let sends = 0;
    const result = await performUncertainWrite({
      submit() { sends++; return new Promise<DeleteEvidence>(resolve => { release = resolve; }); },
      async lookup() { return found ? chosen : null; },
    }, deleteClaim(), { settlement: "recorded-only", start: "submit-claimed", deadlineMs: 1, sleep: immediate });
    assert.equal(sends, 1);
    assert.equal(result.intent.attempts, 1);
    if (found) assert.equal(result.outcome, chosen);
    else assert.deepEqual(result.outcome, { kind: "unknown" });
    release(deleteEvidence("application/late"));
    await Promise.resolve(); await Promise.resolve();
    if (found) {
      assert.equal(result.outcome.kind, "committed");
      if (result.outcome.kind !== "committed") assert.fail("selected receipt expected");
      assert.equal(result.outcome.receipt.removed.contentType, "application/selected; exact=Yes");
    } else assert.deepEqual(result.outcome, { kind: "unknown" });
  }
});

test("prefix-qualified explicit delivery preserves only current submission non-execution; old callers retain count3", async () => {
  const proof = { kind: "not-executed" as const, attempts: 1, details: { deletions: 3, baseline: 5 } };
  let sends = 0, lookups = 0;
  const transport = { submit: async () => { sends++; return proof; }, lookup: async () => { lookups++; return proof; } };
  const qualified = { ...deleteClaim(), notAppliedThrough: 0 };
  const result = await performUncertainWrite(transport, qualified, { settlement: "recorded-only", start: "submit-claimed" });
  assert.equal(result.outcome, proof); assert.equal(result.intent.state, "pending"); assert.equal(result.intent.attempts, 1); assert.equal(sends, 1); assert.equal(lookups, 0);
  for (const [claim, start] of [[deleteClaim(), "submit-claimed"], [qualified, "lookup"]] as const) {
    const refused = await performUncertainWrite(transport, claim, { settlement: "recorded-only", start }); assert.equal(refused.outcome.kind, "unknown");
  }
  await assert.rejects(performUncertainWrite(transport, { ...deleteClaim(2), notAppliedThrough: 0 }, { settlement: "recorded-only", start: "submit-claimed" }), /prefix/);
  for (const prefix of [-1, 2, NaN, Infinity]) await assert.rejects(performUncertainWrite(transport, { ...deleteClaim(), notAppliedThrough: prefix }, { settlement: "recorded-only", start: "lookup" }), /prefix/);
  const stale = await performUncertainWrite({ submit: async () => ({ ...proof, attempts: 2 }), lookup: async () => null }, qualified, { settlement: "recorded-only", start: "submit-claimed" }); assert.equal(stale.outcome.kind, "unknown");
  const controller = new AbortController();
  const cancelled = await performUncertainWrite({ submit: async () => { controller.abort(); return proof; }, lookup: async () => null }, qualified, { settlement: "recorded-only", start: "submit-claimed", signal: controller.signal }); assert.equal(cancelled.outcome.kind, "unknown");
});
