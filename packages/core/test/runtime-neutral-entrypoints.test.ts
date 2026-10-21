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

test("portable and legacy parsers agree on non-exact opening classification", () => {
  const normalized = "---yaml\nokf_version: '0.2'\n---\n# Bundle\n";
  const raw = `\uFEFF${normalized}`;
  assert.deepEqual(parseLeadingFrontmatter(raw, "index.md"), {});
  assert.deepEqual(parseMarkdown(raw, "index.md"), { frontmatter: {}, body: normalized });
});

test("portable root parsing preserves its historical non-mapping validation", () => {
  for (const raw of ["---\nscalar\n---\nbody", "---\n- one\n- two\n---\nbody"]) {
    assert.throws(
      () => parseLeadingFrontmatter(raw, "index.md"),
      (error: unknown) => {
        assert.ok(error instanceof EngineMalformedDocumentError);
        assert.equal(error.context, "index.md");
        assert.equal(error.detail, "YAML frontmatter must be a mapping");
        assert.ok(error.cause instanceof TypeError);
        return true;
      },
      JSON.stringify(raw),
    );
  }
  assert.deepEqual(parseLeadingFrontmatter("---\nnull\n---\nbody", "index.md"), {});
  assert.deepEqual(parseLeadingFrontmatter("---\n---\nbody", "index.md"), {});
});


test("portable operation leaves preserve legacy identity and authoring version validation", async () => {
  const portable = await import("../src/okf-authoring.js");
  const legacy = await import("../src/index.js");
  const { InvalidInputError } = await import("../src/errors.js");
  const actor = await import("../src/okf-actor.js");
  const fields = await import("../src/document-field-actions.js");
  const { loadKinds } = await import("../src/kinds-load.js");
  assert.equal(portable.resolveOkfAuthoringVersion, legacy.resolveOkfAuthoringVersion);
  assert.equal(portable.SUPPORTED_OKF_AUTHORING_VERSIONS, legacy.SUPPORTED_OKF_AUTHORING_VERSIONS);
  assert.equal(actor.OkfActorError, legacy.OkfActorError);
  assert.equal(actor.isOkfActor, legacy.isOkfActor);
  assert.equal(fields.prepareDocumentFieldAction, legacy.prepareDocumentFieldAction);
  assert.equal(fields.FieldActionError, legacy.FieldActionError);
  assert.equal(loadKinds, legacy.loadKinds);
  assert.equal(portable.DEFAULT_OKF_AUTHORING_VERSION, "0.2");
  assert.equal(portable.resolveOkfAuthoringVersion(), "0.2");
  for (const version of ["0.1", "0.2"]) assert.equal(portable.resolveOkfAuthoringVersion(version), version);
  for (const version of ["", "0.3", " 0.2", "0.2 "]) {
    assert.throws(() => portable.resolveOkfAuthoringVersion(version), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.equal(error.message, `Unsupported OKF authoring version '${version}'. This build can author 0.1 and 0.2; bundles declaring other versions can still be read or transported.`);
      return true;
    });
  }
});
