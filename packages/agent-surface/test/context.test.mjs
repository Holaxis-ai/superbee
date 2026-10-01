import test from "node:test";
import assert from "node:assert/strict";
import { createSurfaceContext, SurfaceContextError } from "../dist/index.js";

const context = () => createSurfaceContext({ route: "home", lifetimeId: "mount", validate(selection) {
  if (!selection.bundleId) throw new SurfaceContextError("invalid_target");
} });

test("admission fences late A -> B -> A results and aborts captured signals", () => {
  const c = context();
  const first = c.begin("document");
  const signal = c.signal;
  c.begin("bundle");
  const last = c.begin("document");
  assert.equal(signal.aborted, true);
  assert.equal(first({ bundleId: "A", documentId: "late" }), false);
  assert.equal(last({ bundleId: "A", documentId: "current" }), true);
  assert.equal(last({ bundleId: "A", documentId: "duplicate" }), false);
  assert.equal(c.snapshot().documentId, "current");
  assert.equal(c.snapshot().contextRevision, "mount:4");
  assert.equal(Object.isFrozen(c.snapshot()), true);
});

test("invalid admission can retry, reserved fields cannot override the revision, clear removes selection", () => {
  const c = context();
  const admit = c.begin("document");
  assert.throws(() => admit({}), /invalid_target/);
  assert.equal(admit({ bundleId: "A", route: "evil", contextRevision: "forged", version: 99 }), true);
  assert.equal(c.snapshot().route, "document");
  assert.equal(c.snapshot().contextRevision, "mount:2");
  assert.equal(c.snapshot().version, 1);
  const signal = c.signal;
  c.clear();
  assert.equal(signal.aborted, true);
  assert.equal(c.snapshot().bundleId, undefined);
});

test("revalidation cannot release data after transition or stop", async () => {
  for (const action of [c => c.clear(), c => c.stop()]) {
    const c = context();
    c.begin("bundle")({ bundleId: "A" });
    let release;
    const result = c.revalidate(async (_, signal) => {
      await new Promise(resolve => { release = resolve; });
      assert.equal(signal.aborted, true);
    });
    action(c);
    release();
    await assert.rejects(result, /context_changed/);
  }
  const c = context();
  const admit = c.begin("bundle");
  c.stop();
  assert.equal(c.signal.aborted, true);
  assert.equal(admit({ bundleId: "A" }), false);
  await assert.rejects(c.revalidate(async () => {}), /context_changed/);
});
