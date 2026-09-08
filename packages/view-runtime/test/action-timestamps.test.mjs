import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, readDocVersioned, writeDoc } from "@superbee/core";
import { TrustedActionService } from "../dist/index.js";

const NOW = "2026-09-08T18:30:00.000Z";

async function fixture() {
  const backend = new MemoryBackend();
  const bundle = { root: "mem://action-timestamps", backend };
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  await writeDoc(bundle, {
    id: "conventions/note",
    frontmatter: {
      type: "Convention",
      governs: "Note",
      fields: { required: ["title"], optional: ["stale_after"] },
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "notes/one",
    frontmatter: {
      type: "Note",
      title: "Imported note",
      generated: { by: "process:import", at: "2026-09-01T12:00:00" },
      verified: { by: "human:reviewer", at: "2026-09-02" },
    },
    body: "Preserve the imported verification history.\n",
  });
  let writes = 0;
  const write = backend.write.bind(backend);
  backend.write = async (...args) => {
    writes += 1;
    return write(...args);
  };
  const service = new TrustedActionService(bundle, {
    async resolve(launchId) {
      return {
        launchId,
        capability: "bundle-propose",
        source: {
          kind: "registered",
          id: "views-registry/editor",
          title: "Editor",
          version: "sha256:registry",
          contentVersion: "sha256:html",
        },
      };
    },
    revoke() {},
  }, "human:editor", () => Date.parse(NOW));
  return { bundle, service, writes: () => writes };
}

// View actions edit top-level scalar fields; nested generated/verified authoring is not exposed.
// A declared stale_after field exercises the same mutation policy used by the other timestamps.
for (const value of ["2026-09-09", "2026-09-09T12:30:00", "2026-02-30T12:30:00Z"]) {
  test(`trusted View timestamp action refuses ${value} before persistence`, async () => {
    const f = await fixture();
    const before = await readDocVersioned(f.bundle, "notes/one");
    const prepared = await f.service.prepare("launch", {
      kind: "document.set-field",
      docId: "notes/one",
      field: "stale_after",
      value,
      expectedVersion: before.version,
    });
    assert.equal(prepared.status, "prepared");
    const result = await f.service.commit(prepared.approvalToken, "launch");
    assert.equal(result.status, "failed");
    assert.equal(f.writes(), 0, "the authored mutation refuses before any backend write");
    assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), before);
    assert.equal((await f.service.commit(prepared.approvalToken, "launch")).status, "expired");
  });
}

for (const value of ["2026-09-09T12:30:00-06:00", "2026-09-09T18:30:00Z"]) {
  test(`trusted View timestamp action accepts ${value} and preserves imported history`, async () => {
    const f = await fixture();
    const before = await readDocVersioned(f.bundle, "notes/one");
    const prepared = await f.service.prepare("launch", {
      kind: "document.set-field",
      docId: "notes/one",
      field: "stale_after",
      value,
      expectedVersion: before.version,
    });
    assert.equal(prepared.status, "prepared");
    const result = await f.service.commit(prepared.approvalToken, "launch");
    assert.equal(result.status, "committed");
    assert.equal(result.changed, true);
    assert.equal(f.writes(), 1);
    const after = await readDocVersioned(f.bundle, "notes/one");
    assert.equal(after.version, result.version);
    assert.notEqual(after.version, before.version);
    assert.equal(after.doc.frontmatter.stale_after, value, "preserve the supplied offset spelling");
    assert.deepEqual(after.doc.frontmatter.verified, before.doc.frontmatter.verified);
    assert.deepEqual(after.doc.frontmatter.generated, { by: "human:editor", at: NOW });
    assert.equal(after.doc.body, before.doc.body);
  });
}
