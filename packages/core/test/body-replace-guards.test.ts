import test from "node:test";
import assert from "node:assert/strict";
import { bodyReplaceCases } from "./body-replace-cases.js";
import { BodyReplaceError, TypedListPatchError, bodyPreviewFinding, computeDroppedLinks, attachBodyPreview, guardBodyReplace } from "../src/body-replace-guards.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";
import type { OkfDocument, WriteOptions } from "../src/types.js";
const registry: KindRegistry = { kinds: new Map(), warnings: [] };
const doc = (body: string): OkfDocument => ({ id: "a", frontmatter: { type: "Note" }, body });
for (const row of bodyReplaceCases) test(`body replacement agreement: ${row.name}`, async () => {
  for (const mode of ["overwrite", "patch", "replace-document"] as const) {
    const backend = new MemoryBackend(), bundle = { root: "/unused", backend };
    await backend.write("a", doc(row.existing));
    const before = await backend.read("a");
    const action = () => mutateDocument({ bundle, id: "a", mode, registry, strict: false, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: row.next }) });
    if (row.reason) {
      await assert.rejects(action, (e: unknown) => e instanceof BodyReplaceError && e.finding.reason === row.reason);
      assert.deepEqual(await backend.read("a"), before);
    } else await action();
  }
});
test("preview emitter agreement and independent explicit overrides", async () => {
  const existing = doc("x".repeat(1200) + "[edge](b.md)"), rec: Record<string, unknown> = {};
  attachBodyPreview(rec, existing.body, []);
  assert.equal(bodyPreviewFinding(existing, String(rec.body_preview))?.reason, "preview_marker");
  const backend = new MemoryBackend(), bundle = { root: "/unused", backend };
  assert.throws(() => guardBodyReplace(bundle, existing, "x".repeat(1000), { replaceLinks: true }), BodyReplaceError);
  assert.throws(() => guardBodyReplace(bundle, existing, "x".repeat(1000), { acceptTruncatedBody: true }), (e: unknown) => e instanceof BodyReplaceError && e.finding.reason === "dropped_links");
  await backend.write("a", existing);
  const result = await mutateDocument({ bundle, id: "a", mode: "patch", registry, strict: false, bodyReplace: { replaceLinks: true, acceptTruncatedBody: true }, input: { kind: "assign", assignments: {}, body: "x".repeat(1000) } });
  assert.equal(result.changed, true);
});
test("retry evaluates the competing fresh head and preserves its bytes", async () => {
  class RacingBackend extends MemoryBackend {
    race = false;
    override async write(id: string, value: OkfDocument, options: WriteOptions = {}) {
      if (this.race) { this.race = false; await super.write(id, doc("concurrent [edge](b.md)"), options); }
      return super.write(id, value, options);
    }
  }
  const backend = new RacingBackend();
  await backend.write("a", doc("original")); backend.race = true;
  let attempts = 0;
  await assert.rejects(() => mutateDocument({ bundle: { root: "/unused", backend }, id: "a", mode: "overwrite", registry, strict: false, buildCandidate: () => { attempts++; return { frontmatter: { type: "Note" }, body: "replacement" }; } }), BodyReplaceError);
  assert.equal(attempts, 2);
  assert.equal((await backend.read("a")).doc.body, "concurrent [edge](b.md)\n");
});
test("creates and field-only patches preserve preview-bearing content", async () => {
  const backend = new MemoryBackend(), bundle = { root: "/unused", backend };
  const body = "[superbee:body-preview-truncated] 20 more character(s) are NOT shown\n[edge](b.md)";
  await mutateDocument({ bundle, id: "a", mode: "create-only", registry, strict: false, buildCandidate: () => doc(body) });
  const before = (await backend.read("a")).doc.body;
  await mutateDocument({ bundle, id: "a", mode: "patch", registry, strict: false, input: { kind: "assign", assignments: { title: "updated" } } });
  assert.equal((await backend.read("a")).doc.body, before);
});
test("exact-edge comparison protects source/text and occurrence counts", () => {
  const link = { from: "a", to: "b", text: "one", href: "b.md" };
  assert.deepEqual(computeDroppedLinks([link], [{ ...link, text: "two" }]), []);
  assert.deepEqual(computeDroppedLinks([link], [{ ...link, text: "two" }], "exact-edge"), [link]);
  assert.deepEqual(computeDroppedLinks([link], [{ ...link, from: "c" }], "exact-edge"), [link]);
  assert.equal(computeDroppedLinks([link, link], [link], "exact-edge").length, 1);
});
test("absent typed list refuses scalar patches; explicit whole-list replacement works", async () => {
  const kind: KindConvention = { id: "conventions/note", governs: "Note", fields: { required: [], optional: ["labels"], types: { labels: "string-list" }, values: {}, descriptions: {}, terminal: {} } };
  const typedRegistry = { kinds: new Map([["Note", kind]]), warnings: [] };
  const backend = new MemoryBackend(), bundle = { root: "/unused", backend };
  await backend.write("a", doc("body"));
  const base = { bundle, id: "a", mode: "patch" as const, registry: typedRegistry, strict: false };
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "assign", assignments: { labels: "scalar" } } }), TypedListPatchError);
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "field-action", action: { action: "set", field: "labels", value: "scalar" } } }), TypedListPatchError);
  await assert.rejects(() => mutateDocument({ ...base, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, labels: "scalar" }, body: existing!.body }) }), TypedListPatchError);
  const { version } = await backend.read("a");
  const result = await mutateDocument({ ...base, expectedVersion: version, input: { kind: "field-action", action: { action: "replace-all", field: "labels", value: ["valid"] } } });
  assert.deepEqual(result.doc.frontmatter.labels, ["valid"]);
});
