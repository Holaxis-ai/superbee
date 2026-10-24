import assert from "node:assert/strict";
import test from "node:test";
import { createViewLaunchFence } from "../src/view-launch-contract.js";

test("attempt identity is fence-local and immutable, even for the same selected View", () => {
  const fence = createViewLaunchFence(), other = createViewLaunchFence();
  assert.equal(fence.current(), null);
  const a = fence.begin("views/one");
  assert.ok(Object.isFrozen(a));
  assert.equal(fence.current(), a);
  assert.equal(fence.isCurrent({ ...a }), false);
  assert.equal(fence.isCurrent(other.begin("views/one")), false);
  assert.equal(fence.retire(other.current()!), false);
  const b = fence.begin("views/one");
  assert.equal(b.generation, a.generation + 1);
  assert.equal(fence.isCurrent(a), false);
  assert.equal(fence.retire(a), false);
  assert.equal(fence.current(), b);
  assert.equal(fence.retire(b), true);
  assert.equal(fence.retire(b), false);
  assert.equal(fence.isCurrent(b), false);
  assert.equal(fence.begin("views/two").generation, b.generation + 1);
});

test("late success, failure and retirement cannot publish into or retire a replacement", async () => {
  const fence = createViewLaunchFence(), a = fence.begin("views/old");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const published: string[] = [];
  const success = pending.then(() => { if (fence.isCurrent(a)) published.push("success"); });
  const failure = pending.then(() => { if (fence.isCurrent(a)) published.push("failure"); fence.retire(a); });
  const b = fence.begin("views/new");
  release(); await Promise.all([success, failure]);
  assert.deepEqual(published, []);
  assert.equal(fence.current(), b);
});
