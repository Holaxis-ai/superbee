import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, readDocVersioned, writeDoc } from "@superbee/core";
import { TrustedActionService, parseActionBridgeMessage } from "../dist/index.js";

async function fixture() {
  const backend = new MemoryBackend();
  const bundle = { root: "mem://body-actions", backend };
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  await writeDoc(bundle, { id: "conventions/note", frontmatter: { type: "Convention", governs: "Note", fields: { required: ["title"], optional: ["status"] } }, body: "" });
  await writeDoc(bundle, { id: "notes/one", frontmatter: { type: "Note", title: "Sample", status: "review", extension: { keep: ["original"] } }, body: "# Draft\nOriginal.\n\n[related](two.md)\n" });
  let active = true;
  let time = Date.parse("2026-09-22T12:00:00Z");
  const service = new TrustedActionService(bundle, {
    resolve: async launchId => active ? { launchId, capability: "bundle-propose", source: { kind: "registered", id: "views/editor", title: "Editor", version: "registry", contentVersion: "html" } } : null,
    revoke: () => { active = false; },
  }, "human:sample-editor", () => time);
  const target = await readDocVersioned(bundle, "notes/one");
  const action = { kind: "document.set-body", docId: "notes/one", field: "body", value: target.doc.body.replace("Original.", "Original.\nNew feedback."), expectedVersion: target.version };
  return { bundle, backend, service, target, action, revoke: () => { active = false; }, expire: () => { time += 120001; } };
}

test("body confirmation and commit preserve frontmatter and relationships, with one-use receipt", async () => {
  const f = await fixture();
  const p = await f.service.prepare("launch", f.action);
  assert.equal(p.status, "prepared", JSON.stringify(p));
  assert.equal(p.confirmation.before, f.target.doc.body);
  assert.equal(p.confirmation.after, f.action.value);
  const result = await f.service.commit(p.approvalToken, "launch");
  assert.equal(result.action, "document.set-body");
  assert.equal(result.status, "committed");
  const actual = await readDocVersioned(f.bundle, "notes/one");
  assert.equal(actual.version, result.version);
  assert.equal(actual.doc.body, f.action.value);
  assert.deepEqual(actual.doc.frontmatter.extension, f.target.doc.frontmatter.extension);
  assert.equal(actual.doc.frontmatter.status, "review");
  assert.equal((await f.service.commit(p.approvalToken, "launch")).status, "expired");
  assert.equal((await f.service.prepare("launch", { ...f.action, expectedVersion: actual.version })).status, "unchanged");
});

for (const scenario of ["cancel", "conflict", "kind", "edition", "launch", "expiry"]) test(`body proposal handles ${scenario} without applying stale text`, async () => {
  const f = await fixture();
  const p = await f.service.prepare("launch", f.action);
  let expected = f.target;
  if (scenario === "conflict") {
    await writeDoc(f.bundle, { ...f.target.doc, body: f.target.doc.body + "Other writer.\n" });
    expected = await readDocVersioned(f.bundle, "notes/one");
  }
  if (scenario === "kind") {
    const kind = await readDocVersioned(f.bundle, "conventions/note");
    await writeDoc(f.bundle, { ...kind.doc, body: "Changed.\n" });
  }
  if (scenario === "edition") await f.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
  if (scenario === "launch") f.revoke();
  if (scenario === "expiry") f.expire();
  const result = scenario === "cancel" ? f.service.cancel(p.approvalToken, "launch") : await f.service.commit(p.approvalToken, "launch");
  assert.equal(result.status, { cancel: "cancelled", conflict: "conflict", kind: "revoked", edition: "revoked", launch: "revoked", expiry: "expired" }[scenario]);
  assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), expected);
});

test("body shape, UTF-8 limit, and cross-link preservation fail closed", async () => {
  const f = await fixture();
  for (const bad of [{ field: "title" }, { value: true }, { value: "😀".repeat(16385) }, { expectedVersion: "" }, { extra: "field" }, { docId: "../outside" }]) {
    const action = { ...f.action, ...bad };
    assert.equal(parseActionBridgeMessage({ bridge: "v1", type: "action.propose", requestId: "one", action }).ok, false);
    assert.equal((await f.service.prepare("launch", action)).status, "rejected");
  }
  assert.equal((await f.service.prepare("launch", { ...f.action, value: "Lost links." })).status, "rejected");
  assert.deepEqual(await readDocVersioned(f.bundle, "notes/one"), f.target);
  assert.equal(parseActionBridgeMessage({ bridge: "v1", type: "action.propose", requestId: "one", action: { ...f.action, value: '"'.repeat(64000) } }).ok, true);
});
