import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilesystemRuntime } from "@superbee/core/filesystem";
import { createRouter } from "../src/legacy-router.js";

test("legacy router retains the initialized filesystem policy outside its constructing host context", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "sb-router-policy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = createFilesystemRuntime({
    runtimeLockParent: () => dir,
    runtimeOwnerKey: () => "router",
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  });
  const bundle = await runtime.initBundle(path.join(dir, "bundle"), { okfVersion: "0.1" });
  await bundle.backend!.write("x", { id: "x", frontmatter: { type: "Note" }, body: "configured" });
  const router = createRouter(bundle);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "unsupported-test-host" });
  try {
    assert.throws(() => createRouter({ root: bundle.root }), /explicit filesystem host policy/);
    const response = await router(new Request("http://wire.local/v0/bundles/default/docs/x"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /configured/);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
