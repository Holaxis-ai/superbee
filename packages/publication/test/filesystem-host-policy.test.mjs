import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePublicationSnapshot, PUBLICATION_SNAPSHOT_V1 } from "../dist/index.js";

test("trusted capture policy reaches raw document and reserved reads without entering snapshot data", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "sb-capture-policy-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# Root\n");
  await fs.writeFile(path.join(root, "x.md"), "---\ntype: Note\n---\nexact bytes\n");
  const options = { schema: PUBLICATION_SNAPSHOT_V1, source: { kind: "filesystem", root } };
  const baseline = await capturePublicationSnapshot(options);
  t.after(() => baseline.close());
  const transient = new Error("synthetic open generation change");
  const classified = [];
  const seen = new Set();
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const target = String(args[0]);
    if (target.endsWith(".md") && !seen.has(target)) { seen.add(target); throw transient; }
    return open(...args);
  });
  const configured = await capturePublicationSnapshot(options, {
    filesystemHostPolicy: {
      runtimeLockParent: () => tmpdir(), runtimeOwnerKey: () => "capture", enforcePrivateMode: true,
      isTransientOpenError: (error) => { classified.push(error); return error === transient; },
      isReplacementConflict: () => false, isDirectoryContentionError: () => false,
    },
  });
  t.after(() => configured.close());
  assert.equal(classified.length, 2, "both the raw reserved and raw document path use the selected policy");
  assert.deepEqual(configured.serializeManifest(), baseline.serializeManifest());
  assert.doesNotMatch(configured.serializeManifest().toString(), /filesystemHostPolicy|runtimeLockParent/);
});
