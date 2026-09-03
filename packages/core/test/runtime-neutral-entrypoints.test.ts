import assert from "node:assert/strict";
import test from "node:test";

import {
  queryHeads as queryHeadsForBackend,
  writeDocVersioned as writeDocVersionedForBackend,
} from "../src/engine.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { VersionConflict as PortableVersionConflict } from "../src/storage.js";
import { VersionConflict as LegacyVersionConflict } from "../src/versioning.js";
import { queryHeads, writeDocVersioned } from "../src/bundle.js";
import type { OkfDocument } from "../src/types.js";

async function v02MemoryBackend(): Promise<MemoryBackend> {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Test\n");
  return backend;
}

test("portable and legacy engine surfaces preserve one document/query behavior", async () => {
  const portableBackend = await v02MemoryBackend();
  const legacyBackend = await v02MemoryBackend();
  const input: OkfDocument = {
    id: "proof/runtime-neutral",
    frontmatter: { type: "Proof", custom: "preserved" },
    body: "portable\n",
  };

  const portable = await writeDocVersionedForBackend(portableBackend, input, { actor: "proof" });
  const legacy = await writeDocVersioned(
    { root: "unused-for-explicit-backend", backend: legacyBackend },
    input,
    { actor: "proof" },
  );

  assert.deepEqual(portable, legacy);
  assert.deepEqual(
    await queryHeadsForBackend(portableBackend, { type: "Proof" }),
    await queryHeads({ root: "unused-for-explicit-backend", backend: legacyBackend }, { type: "Proof" }),
  );
});

test("portable storage and legacy root share the VersionConflict class identity", () => {
  assert.equal(PortableVersionConflict, LegacyVersionConflict);
});
