import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend } from "../src/memory-backend.js";
import { KindConformanceError, mutateDocument, prepareDocumentMutationCandidate } from "../src/document-mutation.js";
import { validateAgainstKind, type KindConvention, type KindRegistry } from "../src/kinds.js";
import type { Bundle, Frontmatter } from "../src/types.js";
const kind: KindConvention = { id: "conventions/listing", title: "Listing", governs: "Listing", fields: { required: ["title", "listing_status", "actor", "timestamp"], optional: [], values: { listing_status: ["open", "closed"] }, terminal: {}, descriptions: {} }, sections: ["Details"] };
const registry: KindRegistry = { kinds: new Map([[kind.governs, kind]]), warnings: [] };
const fixtures: Array<{ name: string; fm: Frontmatter; body: string }> = [
  { name: "raw missing metadata and domain field", fm: { type: "Listing", title: "A" }, body: "# Details\n" },
  { name: "invalid scalar", fm: { type: "Listing", title: "A", listing_status: "started" }, body: "# Details\n" },
  { name: "invalid array and heading", fm: { type: "Listing", title: "A", listing_status: ["open", "closed"] }, body: "no heading" },
  { name: "valid", fm: { type: "Listing", title: "A", listing_status: "open", actor: "human:original", timestamp: "2026-01-01T00:00:00Z" }, body: "# Details\n" },
];
for (const mode of ["patch", "overwrite"] as const) for (const fixture of fixtures) {
  test(`${mode} no-op validates raw ${fixture.name} without persistence`, async () => {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    const bundle: Bundle = { root: "/unused", backend };
    const id = "listings/a";
    await backend.write(id, { id, frontmatter: fixture.fm, body: fixture.body });
    const before = await backend.read(id);
    const debt = validateAgainstKind(before.doc, kind);
    const options = { bundle, id, mode, registry, actor: "process:updater", now: () => "2026-10-01T00:00:00Z", buildCandidate: () => ({ frontmatter: structuredClone(before.doc.frontmatter), body: before.doc.body }) };
    const advisory = await mutateDocument({ ...options, strict: false });
    assert.equal(advisory.changed, false);
    assert.equal(advisory.version, before.version);
    assert.deepEqual(advisory.doc, before.doc);
    assert.deepEqual(advisory.warnings, debt);
    if (debt.length) await assert.rejects(() => mutateDocument({ ...options, strict: true }), (error: unknown) => {
      assert.ok(error instanceof KindConformanceError); assert.deepEqual(error.violations, debt); return true;
    });
    else assert.deepEqual((await mutateDocument({ ...options, strict: true })).warnings, []);
    assert.deepEqual(await backend.read(id), before);
    assert.equal((await backend.versions(id)).length, 1);
    const prepared = prepareDocumentMutationCandidate(before.doc, options.buildCandidate(), { id, registry, strict: false, okfVersion: "0.2", actor: "process:updater" });
    assert.equal(prepared.changed, false); assert.deepEqual(prepared.warnings, debt); assert.deepEqual(prepared.candidate.frontmatter, before.doc.frontmatter);
  });
}
