import assert from "node:assert/strict";
import test from "node:test";

import { MemoryBackend, type Bundle } from "@superbee/core";
import { SessionViewAuthorizationStore } from "@superbee/view-runtime";

import { createMcpBundleContext } from "../src/index.js";

test("fixed MCP inputs become one immutable bundle context without copying authorities", () => {
  const bundle: Bundle = {
    root: "mem://workspace-context",
    backend: new MemoryBackend(),
  };
  const viewAuthorization = new SessionViewAuthorizationStore();
  const context = createMcpBundleContext({
    bundle,
    bundleName: "Planning",
    actor: "human:mike",
    viewAuthorization,
  });

  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.bundle, bundle);
  assert.equal(context.name, "Planning");
  assert.equal(context.actor, "human:mike");
  assert.equal(context.viewAuthorization, viewAuthorization);
});

test("fixed MCP context supplies only the existing display-name default", () => {
  const bundle: Bundle = {
    root: "mem://workspace-context-default",
    backend: new MemoryBackend(),
  };

  assert.deepEqual(createMcpBundleContext({ bundle }), {
    bundle,
    name: "Superbee bundle",
  });
});
