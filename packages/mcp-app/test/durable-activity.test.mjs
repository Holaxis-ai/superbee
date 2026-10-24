import assert from "node:assert/strict";
import { test } from "node:test";

import { createViewLaunchFence } from "@superbee/core/view-launch-contract";
import { mayForwardDurableActivity } from "../src/durable-activity.js";

test("a delayed bridge response cannot forward after its View is hidden", () => {
  const fence = createViewLaunchFence();
  const attempt = fence.begin("launch-1");
  fence.begin("launch-1");

  assert.equal(
    mayForwardDurableActivity({
      fence,
      attempt,
      visibilityState: "hidden",
      suspendedLaunchId: "launch-1",
    }),
    false,
  );
});

test("a delayed poll cannot forward or restart while suspension awaits retirement", () => {
  const fence = createViewLaunchFence();
  const attempt = fence.begin("launch-1");
  fence.begin("launch-1");

  assert.equal(
    mayForwardDurableActivity({
      fence,
      attempt,
      visibilityState: "visible",
      suspendedLaunchId: "launch-1",
    }),
    false,
  );
  assert.equal(
    mayForwardDurableActivity({
      fence,
      attempt,
      visibilityState: "visible",
      suspendedLaunchId: null,
    }),
    false,
    "clearing suspension cannot revive work from the previous epoch",
  );
});

test("only current visible unsuspended durable activity may forward", () => {
  const fence = createViewLaunchFence();
  const attempt = fence.begin("launch-1");
  assert.equal(
    mayForwardDurableActivity({
      fence,
      attempt,
      visibilityState: "visible",
      suspendedLaunchId: null,
    }),
    true,
  );
});
