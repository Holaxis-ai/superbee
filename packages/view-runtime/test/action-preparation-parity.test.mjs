import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, loadKinds, mutateDocument, prepareDocumentFieldAction, prepareDocumentMutationCandidate, readDocVersioned, writeDoc } from "@superbee/core";
import { TrustedActionService } from "../dist/index.js";

const NOW = "2026-09-09T18:30:00.000Z";
const ACTOR = "human:editor";

async function fixture(edition, required = ["title"], extra = {}) {
  const backend = new MemoryBackend();
  const bundle = { root: "mem://action-parity", backend };
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# Bundle\n`);
  await writeDoc(bundle, { id: "conventions/note", frontmatter: {
    type: "Convention", governs: "Note", fields: { required, optional: ["status", "progress_status", "stale_after", "generated", "verified", "superbee_updated_by", "tags", "sources", "extension"] },
  }, body: "" });
  await writeDoc(bundle, { id: "notes/one", frontmatter: {
    type: "Note", title: "Before", timestamp: "2026-09-01T00:00:00.000Z", ...extra,
  }, body: "Keep this body.\n" });
  let active = true;
  let now = Date.parse(NOW);
  let onResolve = async () => {};
  const service = new TrustedActionService(bundle, {
    async resolve(launchId) { await onResolve(); return active ? { launchId, capability: "bundle-propose", source: {
      kind: "registered", id: "views/editor", title: "Editor", version: "sha256:registry", contentVersion: "sha256:html",
    } } : null; },
    revoke() { active = false; },
  }, ACTOR, () => now);
  const target = await readDocVersioned(bundle, "notes/one");
  const action = (field = "title", value = "After") => ({ kind: "document.set-field", docId: "notes/one", field, value, expectedVersion: target.version });
  return { bundle, backend, service, target, action, revoke: () => { active = false; }, advance: () => { now += 1000; }, onResolve: (callback) => { onResolve = callback; } };
}

for (const [edition, required, extra] of [
  ["0.1", ["title", "timestamp", "actor"], { actor: "human:previous" }],
  ["0.2", ["title"], {}],
  ["0.2", ["title", "timestamp", "actor"], { actor: "human:previous" }],
]) {
  test(`View preview and commit agree with core at fixed context: ${edition} ${required.join(",")}`, async () => {
    const f = await fixture(edition, required, extra);
    const registry = await loadKinds(f.bundle);
    const action = { action: "set", field: "title", value: "After" };
    const context = { registry, okfVersion: edition, now: () => NOW };
    const raw = prepareDocumentFieldAction(f.target.doc, action, context);
    const preparedCore = prepareDocumentMutationCandidate(f.target.doc, raw.candidate, {
      ...context, id: "notes/one", strict: true, actor: ACTOR, persistActor: true,
    });
    const preview = await f.service.prepare("launch", f.action());
    assert.equal(preview.status, "prepared");
    assert.equal(preview.confirmation.timestamp, NOW);
    assert.equal(preview.confirmation.actor, ACTOR);
    f.advance();
    const committed = await f.service.commit(preview.approvalToken, "launch");
    assert.equal(committed.status, "committed");
    const actual = await readDocVersioned(f.bundle, "notes/one");
    assert.deepEqual({ frontmatter: actual.doc.frontmatter, body: actual.doc.body }, preparedCore.candidate);
    const direct = await fixture(edition, required, extra);
    const receipt = await mutateDocument({ bundle: direct.bundle, id: "notes/one", mode: "patch", registry: await loadKinds(direct.bundle),
      strict: true, actor: ACTOR, persistActor: true, now: () => NOW, expectedVersion: direct.target.version,
      input: { kind: "field-action", action } });
    assert.equal(actual.version, receipt.version);
    assert.equal((await f.service.commit(preview.approvalToken, "launch")).status, "expired");
  });
}

for (const field of ["generated", "verified", "superbee_updated_by", "tags", "sources"]) {
  test(`managed or collection field ${field} is refused even for an equal imported scalar`, async () => {
    const f = await fixture("0.2", ["title"], { [field]: "imported" });
    assert.equal((await f.service.prepare("launch", f.action(field, "imported"))).status, "rejected");
    assert.equal(f.service.size(), 0);
    assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), f.target);
  });
}

test("v0.1 refuses declared v0.2-only scalar before no-op", async () => {
  const f = await fixture("0.1", ["title"], { stale_after: NOW });
  assert.equal((await f.service.prepare("launch", f.action("stale_after", NOW))).status, "rejected");
});

for (const change of ["kind", "edition", "launch"]) {
  test(`prepared scalar is revoked after ${change} changes`, async () => {
    const f = await fixture("0.2");
    const preview = await f.service.prepare("launch", f.action());
    assert.equal(preview.status, "prepared");
    if (change === "kind") {
      const kind = await readDocVersioned(f.bundle, "conventions/note");
      await writeDoc(f.bundle, { ...kind.doc, body: "Changed convention.\n" });
    } else if (change === "edition") {
      await f.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n# Bundle\n");
    } else f.revoke();
    assert.equal((await f.service.commit(preview.approvalToken, "launch")).status, "revoked");
    assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), f.target);
    assert.equal((await f.service.commit(preview.approvalToken, "launch")).status, "expired");
  });
}


test("edition changing after upfront checks is refused inside the final mutation attempt", async () => {
  const f = await fixture("0.2");
  const preview = await f.service.prepare("launch", f.action());
  assert.equal(preview.status, "prepared");
  let resolutions = 0;
  f.onResolve(async () => {
    if (++resolutions === 2) {
      await f.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n# Bundle\n");
    }
  });
  const result = await f.service.commit(preview.approvalToken, "launch");
  assert.equal(resolutions, 2, "change the edition at the final authorization read");
  assert.equal(result.status, "revoked");
  assert.match(result.message, /edition changed/);
  assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), f.target);
});

for (const [field, value, extra] of [
  ["type", "Note", {}],
  ["extension", "scalar", { extension: { rows: ["old"] } }],
  ["title", ["not scalar"], {}],
  ["title", { text: "not scalar" }, {}],
]) {
  test(`trusted scalar envelope rejects ${field} with ${JSON.stringify(value)} over ${JSON.stringify(extra)}`, async () => {
    const f = await fixture("0.2", ["title"], extra);
    assert.equal((await f.service.prepare("launch", f.action(field, value))).status, "rejected");
    assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), f.target);
  });
}
