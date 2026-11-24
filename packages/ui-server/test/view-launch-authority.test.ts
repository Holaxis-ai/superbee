import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web registered Views delegate minting to the shared runtime authority", async () => {
  const webSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");

  assert.match(webSource, /mintActiveViewLaunch\(options\.bundle, runtime\.launches, registryId\)/);
  assert.doesNotMatch(webSource, /sourceKind:\s*["']registered["']/);
  assert.doesNotMatch(webSource, /remoteRegistryHeads|readPageBlob|viewLaunchIsCurrent|REMOTE_BUNDLE/);
});
