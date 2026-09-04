import assert from "node:assert/strict";
import test from "node:test";

import {
  MalformedDocumentError as EngineMalformedDocumentError,
  queryHeads as queryHeadsForBackend,
  writeDocVersioned as writeDocVersionedForBackend,
} from "../src/engine.js";
import { MemoryBackend } from "../src/memory-backend.js";
import {
  MalformedDocumentError as StorageMalformedDocumentError,
  VersionConflict as PortableVersionConflict,
} from "../src/storage.js";
import { VersionConflict as LegacyVersionConflict } from "../src/versioning.js";
import { queryHeads, writeDocVersioned } from "../src/bundle.js";
import { MalformedDocumentError as LegacyMalformedDocumentError, parseMarkdown } from "../src/frontmatter.js";
import { parseLeadingFrontmatter } from "../src/portable-frontmatter.js";
import type { EdgeFilter, Link } from "../src/engine.js";
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

test("portable engine exports its edge contract and shared malformed-document error", () => {
  const filter: EdgeFilter = { from: "proof/", to: ["target"], text: "evidence" };
  const link: Link = { from: "proof/source", to: "target", text: "evidence", href: "../target.md" };
  assert.equal(filter.text, link.text);
  assert.equal(EngineMalformedDocumentError, StorageMalformedDocumentError);
  assert.equal(EngineMalformedDocumentError, LegacyMalformedDocumentError);
});

test("portable root parsing matches legacy behavior for one leading UTF-8 BOM", () => {
  const raw = "\uFEFF---\nokf_version: '0.2'\ntitle: Root\n---\n# Bundle\n";
  assert.deepEqual(parseLeadingFrontmatter(raw, "index.md"), parseMarkdown(raw, "index.md").frontmatter);
  assert.deepEqual(parseLeadingFrontmatter(`\uFEFF${raw}`, "index.md"), {});
});
